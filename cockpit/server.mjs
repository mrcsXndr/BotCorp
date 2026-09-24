// BotCorp cockpit - the ops surface for the bots on this machine.
//
// Lists every bot (bots/*/bot.yaml), shows its live terminal by attaching to
// the bot's pty-host over loopback, and offers the operator actions that the
// CLI implements: start / stop / restart, vault (masked), Telegram pairing.
// It has NO liveness authority and NEVER spawns a pty: the daemon starts
// pty-hosts, the CLI changes state, the cockpit reads and relays.
//
// Run:  node cockpit/server.mjs [--port 4477] [--bind 127.0.0.1]
//       (PORT / COCKPIT_PORT / COCKPIT_HOST env also honoured)
//
// AUTH MODEL (no escape hatch):
//   * Loopback bind (the default): Host allowlist + Origin check + a per-boot
//     session cookie minted on page load, required on every /api call and WS
//     upgrade. Same-box threat model (CSRF, DNS rebinding).
//   * Cloudflare Access: present <BOTCORP_HOME>/access.json {team, aud} and
//     EVERY request must carry a verified Cf-Access-Jwt-Assertion (RS256 vs the
//     team JWKS, iss, aud, exp). The cookie is minted only from a verified JWT
//     and bound to its email; Secure + HttpOnly + SameSite=Strict.
//   * A non-loopback bind without access.json refuses to start (exit 2).
//   * /healthz is the only unauthenticated route and says {ok:true} only.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import * as bots from './bots.mjs';
import * as vault from './vault.mjs';
import * as pairing from './pairing.mjs';
import * as history from './history.mjs';
import * as chat from './chat.mjs';
import * as engine from './engine.mjs';
import * as updates from './updates.mjs';
import * as chatLaunch from './chat-launch.mjs';
import { runCli } from './cli.mjs';
import { bridge } from './ptybridge.mjs';
import { loadAccessConfig, AccessVerifier, SessionCookie } from './access.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- args / bind --------------------------------------------------------------
function argOf(flag) { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; }
const PORT = Number(argOf('--port') || process.env.PORT || process.env.COCKPIT_PORT || 4477);
const HOST = argOf('--bind') || process.env.COCKPIT_HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']);
const LOOPBACK_BIND = LOOPBACK_HOSTS.has(HOST);

const ACCESS_FILE = path.join(bots.BOTCORP_HOME, 'access.json');
let accessCfg = null;
try { accessCfg = await loadAccessConfig(ACCESS_FILE); }
catch (e) { console.error(`[cockpit] ${e.message}`); process.exit(2); }
if (!LOOPBACK_BIND && !accessCfg) {
  console.error(`[cockpit] refusing to bind ${HOST}: Access required: set integrations.access {team, aud} in the machine config (${ACCESS_FILE})`);
  process.exit(2);
}
const ACCESS = accessCfg ? new AccessVerifier(accessCfg) : null;
const cookie = new SessionCookie({ secure: !!ACCESS });
const CSP = `frame-ancestors ${accessCfg ? accessCfg.frameAncestors : "'none'"}`;

// ---- gates ------------------------------------------------------------------
// Loopback: exact Host allowlist (kills DNS rebinding) + exact Origin allowlist.
// Access: the edge owns the hostname; Origin, when present, must be same-origin.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

function gateOk(req) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  if (ACCESS) {
    if (!host) return false;
    if (origin) {
      let oh;
      try { oh = new URL(origin).host; } catch { return false; }
      if (oh !== host) return false;
    }
    return true;
  }
  if (!ALLOWED_HOSTS.has(host)) return false;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  return true;
}

// Resolve the caller's identity. Access mode: a verified JWT or nothing.
// Loopback: the fixed 'local' identity (the gate above is the check).
async function identityOf(req) {
  if (!ACCESS) return 'local';
  const jwt = req.headers['cf-access-jwt-assertion'];
  if (typeof jwt !== 'string' || !jwt) return null;
  try { return (await ACCESS.verify(jwt)).email; } catch { return null; }
}

const app = express();
app.disable('x-powered-by');

// Liveness for the daemon tick. Before every gate on purpose: it reveals
// nothing and must answer even when the Host header is not ours.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(async (req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cache-Control', 'no-store');
  if (!gateOk(req)) return res.status(403).json({ error: 'forbidden (host/origin not allowed)' });
  const identity = await identityOf(req);
  if (!identity) return res.status(401).json({ error: 'unauthorized (Access identity required)' });   // no Set-Cookie
  req.identity = identity;
  const hasCookie = cookie.check(req, identity);
  if (req.path.startsWith('/api')) {
    if (!hasCookie) return res.status(403).json({ error: 'forbidden (no session: load the cockpit first)' });
  } else if (!hasCookie) {
    // Page-level loads from a verified identity mint (or re-bind) the cookie.
    res.setHeader('Set-Cookie', cookie.header(identity));
  }
  next();
});

app.use(express.json({ limit: '8mb' }));

// ---- static ------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
const nm = path.join(bots.BOTCORP_ROOT, 'node_modules', '@xterm');
app.use('/vendor/xterm', express.static(path.join(nm, 'xterm', 'lib')));
app.use('/vendor/xterm-css', express.static(path.join(nm, 'xterm', 'css')));
app.use('/vendor/xterm-fit', express.static(path.join(nm, 'addon-fit', 'lib')));
app.use('/vendor/xterm-links', express.static(path.join(nm, 'addon-web-links', 'lib')));

// ---- API ---------------------------------------------------------------------
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const withBot = (fn) => wrap(async (req, res) => {
  const bot = await bots.getBot(req.params.name);
  if (!bot) return res.status(404).json({ error: 'no such bot' });
  return fn(req, res, bot);
});

app.get('/api/access/selftest', (req, res) => res.json({ verified: true, email: req.identity, access: !!ACCESS }));
app.get('/api/engine/version', wrap(async (_req, res) => res.json({ ...(await engine.engineVersion()), exposure: ACCESS ? 'access' : 'loopback' })));

app.get('/api/bots', wrap(async (_req, res) => res.json(await bots.listBots())));
app.get('/api/bots/:name', withBot(async (_req, res, bot) => res.json(bot)));

// Lifecycle goes through the CLI. The response is the CLI's outcome, scrubbed.
async function lifecycle(res, args) {
  const r = await runCli(args);
  res.status(r.code === 0 ? 200 : 502).json({ ok: r.code === 0, code: r.code, timedOut: r.timedOut, out: r.out, err: r.err });
}
app.post('/api/bots/:name/start', withBot((req, res, bot) => lifecycle(res, ['start', bot.name, ...(req.body?.fresh ? ['--fresh'] : [])])));
app.post('/api/bots/:name/stop', withBot((_req, res, bot) => lifecycle(res, ['stop', bot.name])));
app.post('/api/bots/:name/restart', withBot((req, res, bot) => lifecycle(res, ['restart', bot.name, ...(req.body?.fresh ? ['--fresh'] : [])])));

app.get('/api/bots/:name/sessions', withBot(async (_req, res, bot) => res.json(await history.listSessions(bot.configDir, bot.home))));
app.get('/api/bots/:name/chat', withBot(async (req, res, bot) => {
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  res.json(await chat.chatState(bot, after));
}));
app.get('/api/bots/:name/automations', withBot(async (_req, res, bot) => {
  res.json({ declared: bot.automations, ...(await bots.automationRuns(bot.name)) });
}));

app.get('/api/bots/:name/pairing', withBot(async (_req, res, bot) => res.json(await pairing.pairingState(bot.name))));
app.post('/api/bots/:name/pair', withBot(async (req, res, bot) => res.json(await pairing.approve(bot.name, req.body?.senderId))));
app.post('/api/bots/:name/pair/deny', withBot(async (req, res, bot) => res.json(await pairing.deny(bot.name, req.body?.senderId))));

app.get('/api/bots/:name/secrets', withBot(async (_req, res, bot) => res.json(await vault.listSecrets(bot.name))));
app.put('/api/bots/:name/secrets/:key', withBot(async (req, res, bot) => res.json(await vault.setSecret(bot.name, req.params.key, req.body?.value))));

// Machine-wide Releases panel: read-only list here, Apply/Skip go through the
// CLI same as every other write path (lifecycle() above is already generic).
const RELEASE_TAG_RE = /^[A-Za-z0-9._-]{1,40}$/;
app.get('/api/updates', wrap(async (_req, res) => res.json(await updates.listUpdates())));
app.post('/api/updates/:tag/apply', wrap((req, res) => {
  if (!RELEASE_TAG_RE.test(req.params.tag)) return res.status(400).json({ error: 'bad tag' });
  return lifecycle(res, ['update', '--apply', req.params.tag]);
}));
app.post('/api/updates/:tag/skip', wrap((req, res) => {
  if (!RELEASE_TAG_RE.test(req.params.tag)) return res.status(400).json({ error: 'bad tag' });
  return lifecycle(res, ['update', '--skip', req.params.tag]);
}));

// New-chat launcher: an interactive `claude` in a Windows Terminal tab under
// a chosen account. `chat --account`/`--generic`/`--cwd` opens the tab on the
// HOST's desktop, not in this response, so over an Access-exposed cockpit the
// operator only sees the CLI's launch outcome here, not the tab itself.
app.get('/api/accounts', wrap(async (_req, res) => {
  const r = await runCli(['accounts', 'list', '--json']);
  if (r.code !== 0) return res.json({ accounts: [], error: r.err || r.out || `accounts list exited ${r.code}` });
  try { return res.json({ accounts: JSON.parse(r.out) }); }
  catch { return res.json({ accounts: [], error: 'bad output from accounts list' }); }
}));
app.get('/api/chat/recent', wrap(async (_req, res) => res.json(await chatLaunch.listRecent())));
app.post('/api/chat/launch', wrap((req, res) => {
  const { account, generic, cwd } = req.body || {};
  if (!bots.NAME_RE.test(account || '')) return res.status(400).json({ error: 'bad account id' });
  const args = ['chat', '--account', account];
  if (generic) {
    args.push('--generic');
  } else {
    if (typeof cwd !== 'string' || !cwd || cwd.length > 512 || cwd.includes('\0') || /[\r\n]/.test(cwd)) {
      return res.status(400).json({ error: 'bad cwd' });
    }
    args.push('--cwd', cwd);
  }
  return lifecycle(res, args);
}));

// Paste / drop bridge: the browser cannot put a file into the pty, so it
// uploads here; we write it under the OS temp dir and the client types
// `@<path> ` so Claude Code reads it. 8 MB decoded cap, 10/min per session.
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json', 'text/csv': 'csv' };
const PASTE_MAX = 8 * 1024 * 1024;
const pasteHits = new Map();   // cookie -> [ts]
function pasteAllowed(req) {
  const key = cookie.read(req) || req.identity;
  const now = Date.now();
  const hits = (pasteHits.get(key) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 10) { pasteHits.set(key, hits); return false; }
  hits.push(now); pasteHits.set(key, hits);
  return true;
}
app.post('/api/bots/:name/paste', withBot(async (req, res, bot) => {
  if (!pasteAllowed(req)) return res.status(429).json({ error: 'too many uploads (10 per minute)' });
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(req.body?.dataUrl || '');
  if (!m) throw new Error('expected a base64 dataUrl');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > PASTE_MAX) return res.status(413).json({ error: 'file too large (8 MB max)' });
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(String(req.body?.name || ''));
  const ext = (fromName ? fromName[1] : EXT_BY_MIME[m[1].toLowerCase()] || 'bin').toLowerCase();
  const dir = path.join(os.tmpdir(), 'botcorp-paste', bot.name);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `paste-${Date.now()}.${ext}`);
  await fsp.writeFile(file, buf);
  res.json({ path: file.replace(/\\/g, '/'), bytes: buf.length });
}));

// Body-parser errors (413 over the JSON cap, 400 bad JSON) as JSON, not HTML.
app.use((err, _req, res, _next) => {
  res.status(err.status || err.statusCode || 500).json({ error: err.type || err.message || 'error' });
});

// ---- server + WS ---------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on('upgrade', async (req, socket, head) => {
  // Same gates as HTTP: WebSockets are not covered by the same-origin policy.
  const reject = (code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch {} socket.destroy(); };
  if (!gateOk(req)) return reject(403, 'Forbidden');
  const identity = await identityOf(req);
  if (!identity) return reject(401, 'Unauthorized');
  if (!cookie.check(req, identity)) return reject(403, 'Forbidden');
  const m = /^\/term\/([a-z0-9-]{1,32})(?:\?.*)?$/.exec(req.url || '');
  if (!m) return reject(404, 'Not Found');
  const bot = await bots.getBot(m[1]).catch(() => null);
  if (!bot) return reject(404, 'Not Found');
  wss.handleUpgrade(req, socket, head, (ws) => { bridge(bot, ws).catch(() => { try { ws.close(); } catch {} }); });
});

server.listen(PORT, HOST, () => {
  console.log(`[cockpit] http://${HOST}:${PORT}  bots=${bots.BOTS_DIR}  runtime=${bots.BOTCORP_HOME}`);
  console.log(`[cockpit] auth: ${ACCESS ? `Cloudflare Access (team ${accessCfg.team}, jwks ${ACCESS.jwksFile ? 'file' : 'fetch'})` : 'loopback session cookie'}`);
});
