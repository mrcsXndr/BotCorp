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
//     A non-empty access.json allowed_emails also refuses any other email.
//   * A non-loopback bind without access.json refuses to start (exit 2).
//   * /healthz is the only unauthenticated route and says {ok:true} only.
//   * Strict CSP on every response (script-src 'self': no inline script).
//   * Every mutating /api call from an identified caller appends one line to
//     <BOTCORP_HOME>/state/cockpit-audit.jsonl (never a body or a secret).

import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import * as bots from './bots.mjs';
import { restrictToUser } from '../core/acl.mjs';
import * as vault from './vault.mjs';
import * as pairing from './pairing.mjs';
import * as history from './history.mjs';
import * as chat from './chat.mjs';
import * as engine from './engine.mjs';
import * as updates from './updates.mjs';
import * as chatLaunch from './chat-launch.mjs';
import * as attention from './attention.mjs';
import { runCli, cliJson } from './cli.mjs';
import * as inbox from '../core/inbox.mjs';
import { ccStatus } from '../core/cc.mjs';
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
const CSP = [
  "default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'", `frame-ancestors ${accessCfg ? accessCfg.frameAncestors : "'none'"}`,
].join('; ');

// Append-only audit of mutating API calls: who, what, which bot, the outcome.
const AUDIT_LOG = path.join(bots.BOTCORP_HOME, 'state', 'cockpit-audit.jsonl');
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function auditOnClose(req, res) {
  const p = req.path.slice(0, 200);
  const bot = /^\/api\/bots\/([^/]+)/.exec(p)?.[1] || null;
  res.on('close', () => {
    // res.locals.audit: what a route adds (a chat send: its inbox id, never its text)
    const line = JSON.stringify({ ts: new Date().toISOString(), identity: req.identity, method: req.method, path: p, bot, result: res.writableFinished ? res.statusCode : 'aborted', ...res.locals.audit });
    fsp.mkdir(path.dirname(AUDIT_LOG), { recursive: true })
      .then(() => fsp.appendFile(AUDIT_LOG, line + '\n'))
      .catch((e) => console.error(`[cockpit] audit write failed: ${e.message}`));
  });
}

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
  if (MUTATING.has(req.method) && req.path.startsWith('/api')) auditOnClose(req, res);
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
// Chat send: queued in the bot's inbox by `botcorp send` (the text on stdin,
// never argv), which types it as soon as the session is alive. The response is the
// queued item; the composer follows it through GET /inbox.
app.post('/api/bots/:name/send', withBot(async (req, res, bot) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'empty message' });
  if (Buffer.byteLength(text) > inbox.MAX_TEXT_BYTES) return res.status(413).json({ error: `message too large (${inbox.MAX_TEXT_BYTES / 1024} KB max)` });
  const r = await runCli(['send', bot.name, '--source', 'cockpit', '--json'], { stdin: text });
  let item = null;
  try { item = JSON.parse(r.out); } catch {}
  if (r.code !== 0 || !item || !item.id) return res.status(502).json({ error: (r.err || r.out || `send exited ${r.code}`).trim() });
  res.locals.audit = { inbox_id: item.id };
  res.json(item);
}));
// The last 50 messages' status, without their text.
app.get('/api/bots/:name/inbox', withBot(async (_req, res, bot) => {
  res.json(inbox.readInbox(bot.name).slice(-50).map(({ id, source, at, status, detail, status_at }) => ({ id, source, at, status, detail, status_at })));
}));
app.get('/api/bots/:name/automations', withBot(async (_req, res, bot) => {
  res.json({ declared: bot.automations, state: await bots.automationState(bot.name), ...(await bots.automationRuns(bot.name)) });
}));

// ---- operator decisions: approvals, automations, the tools registry ------------
// Every write is a CLI verb (runCli) and one audit line. A change that WIDENS
// what a bot may do (approve, enable/resume a job, register a tool, switch an
// account, pair a sender, set a secret, apply/skip a release) is the one
// decision a bot must never make for itself: behind Access the verified
// identity is the check; on loopback any local process can mint a session
// cookie (a bot's curl too), so those routes also need the per-boot approval
// token this server prints to the terminal that started it.
const APPROVE_TOKEN = ACCESS ? null : crypto.randomBytes(16).toString('hex');
// A cockpit the daemon started has no terminal to print to, so the token also
// goes to an owner-only file (the ACL is set before the rename makes it visible).
const APPROVE_TOKEN_FILE = path.join(bots.STATE_DIR, 'cockpit-approve-token');
if (APPROVE_TOKEN) {
  try {
    await fsp.mkdir(bots.STATE_DIR, { recursive: true });
    const tmp = `${APPROVE_TOKEN_FILE}.tmp`;
    await fsp.writeFile(tmp, `${APPROVE_TOKEN}\n`, { encoding: 'utf-8', mode: 0o600 });
    restrictToUser(tmp);
    await fsp.rename(tmp, APPROVE_TOKEN_FILE);
  } catch (e) { console.log(`[cockpit] could not write ${APPROVE_TOKEN_FILE}: ${e.message}`); }
}
function operatorGate(req, res) {
  if (!APPROVE_TOKEN) return true;
  const got = String(req.headers['x-approve-token'] || '');
  if (got.length === APPROVE_TOKEN.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(APPROVE_TOKEN))) return true;
  res.status(403).json({ error: 'needs the approval token this cockpit printed at start, also in <BOTCORP_HOME>/state/cockpit-approve-token (or Cloudflare Access, or `botcorp approve` in your terminal)', need: 'approve-token' });
  return false;
}
async function decided(res, args, audit) {
  res.locals.audit = audit;
  const r = await runCli(args);
  attention.invalidate();
  res.status(r.code === 0 ? 200 : 502).json({ ok: r.code === 0, code: r.code, timedOut: r.timedOut, out: r.out, err: r.err });
}
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const AUTO_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

app.get('/api/attention', wrap(async (_req, res) => res.json(await attention.collectAttention())));
app.get('/api/usage', wrap(async (_req, res) => res.json(await attention.usageOverview())));
app.get('/api/approvals', wrap(async (_req, res) => {
  const pending = await cliJson(['approvals', '--json'], null);
  if (!Array.isArray(pending)) return res.status(502).json({ error: 'approvals --json failed' });
  res.json({ pending, recent: await attention.recentDecisions(20) });
}));
app.post('/api/bots/:name/approvals/:id/:decision', withBot(async (req, res, bot) => {
  const { id, decision } = req.params;
  if (!APPROVAL_ID_RE.test(id) || !['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'bad approval id or decision' });
  if (!operatorGate(req, res)) return;
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? ['--reason', req.body.reason.trim().slice(0, 200)] : [];
  return decided(res, [decision, bot.name, id, '--by', req.identity, '--source', 'cockpit', ...(decision === 'reject' ? reason : [])], { approval: id, decision });
}));

app.post('/api/bots/:name/automations/:auto/:action', withBot(async (req, res, bot) => {
  const { auto, action } = req.params;
  if (!AUTO_NAME_RE.test(auto) || !['run', 'pause', 'resume', 'enable', 'disable'].includes(action)) return res.status(400).json({ error: 'bad automation or action' });
  if (!bot.automations.some((a) => a.name === auto)) return res.status(404).json({ error: 'no such automation' });
  if ((action === 'resume' || action === 'enable') && !operatorGate(req, res)) return;
  return decided(res, ['automations', bot.name, action, auto], { automation: auto, action });
}));

app.get('/api/bots/:name/tools', withBot(async (_req, res, bot) => {
  const scan = await cliJson(['tools', bot.name, 'scan', '--json'], null);
  if (!scan) return res.status(502).json({ error: 'tools scan failed' });
  res.json(scan);
}));
const TOOL_KINDS = ['cli', 'monitor', 'integration', 'lib'];
app.post('/api/bots/:name/tools/register', withBot(async (req, res, bot) => {
  const { name, path: p, kind, purpose, secrets } = req.body || {};
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name || '') || typeof p !== 'string' || !p || p.length > 256 || /[\r\n\0]/.test(p) || !TOOL_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'register needs name (slug), path and kind (cli|monitor|integration|lib)' });
  }
  if (!operatorGate(req, res)) return;
  const args = ['tools', bot.name, 'register', '--name', name, '--path', p, '--kind', kind];
  if (typeof purpose === 'string' && purpose.trim()) args.push('--purpose', purpose.trim().slice(0, 200));
  if (Array.isArray(secrets) && secrets.length) args.push('--secrets', secrets.map(String).filter((s) => /^[a-z][a-z0-9_]*$/.test(s)).join(','));
  return decided(res, args, { tool: name, action: 'register' });
}));
app.post('/api/bots/:name/tools/retire', withBot(async (req, res, bot) => {
  const target = req.body?.target;
  if (typeof target !== 'string' || !target || target.length > 256 || /[\r\n\0]/.test(target) || target.startsWith('-')) return res.status(400).json({ error: 'retire needs a tool name or path' });
  return decided(res, ['tools', bot.name, 'retire', target, '--by', req.identity], { tool: target, action: 'retire' });
}));

// Which Claude account the bot runs on (bot.yaml account:). `accounts use`
// checks the account's token first; the switch lands at the bot's next idle
// turn boundary, with the conversation kept.
app.post('/api/bots/:name/account', withBot(async (req, res, bot) => {
  const id = req.body?.id;
  if (typeof id !== 'string' || (id !== 'none' && !bots.NAME_RE.test(id))) return res.status(400).json({ error: 'account needs an id (a registered account) or none' });
  if (!operatorGate(req, res)) return;
  return decided(res, ['accounts', 'use', bot.name, id, '--by', req.identity], { account: id });
}));

app.get('/api/bots/:name/pairing', withBot(async (_req, res, bot) => res.json(await pairing.pairingState(bot.name))));
app.post('/api/bots/:name/pair', withBot(async (req, res, bot) => {
  if (!operatorGate(req, res)) return;
  res.json(await pairing.approve(bot.name, req.body?.senderId));
}));
app.post('/api/bots/:name/pair/deny', withBot(async (req, res, bot) => res.json(await pairing.deny(bot.name, req.body?.senderId))));

app.get('/api/bots/:name/secrets', withBot(async (_req, res, bot) => res.json(await vault.listSecrets(bot.name))));
app.put('/api/bots/:name/secrets/:key', withBot(async (req, res, bot) => {
  if (!operatorGate(req, res)) return;
  res.json(await vault.setSecret(bot.name, req.params.key, req.body?.value));
}));
// Operator lock: state is read through the CLI; unlock pipes the passphrase
// to `secrets unlock` on stdin. Only here (behind Access when exposed) or in
// the terminal - never from a chat message.
app.get('/api/bots/:name/secrets/lock', withBot(async (_req, res, bot) => res.json(await vault.lockState(bot.name))));
app.post('/api/bots/:name/unlock', withBot(async (req, res, bot) => res.json(await vault.unlock(bot.name, req.body?.passphrase))));

app.get('/api/secrets/audit', wrap(async (req, res) => {
  const bot = typeof req.query.bot === 'string' ? req.query.bot : '';
  res.json(await vault.auditTail(bot || null, parseInt(req.query.limit, 10) || 100));
}));
app.get('/api/bots/:name/secrets/audit', withBot(async (req, res, bot) => res.json(await vault.auditTail(bot.name, parseInt(req.query.limit, 10) || 100))));

// Machine-wide Releases panel: read-only list here, Apply/Skip go through the
// CLI same as every other write path (lifecycle() above is already generic).
const RELEASE_TAG_RE = /^[A-Za-z0-9._-]{1,40}$/;
app.get('/api/updates', wrap(async (_req, res) => res.json(await updates.listUpdates())));
// The Claude Code pin (botcorp cc status --json), each bot as of its last tick. Read-only.
app.get('/api/cc', wrap(async (_req, res) => res.json(ccStatus())));
app.post('/api/updates/:tag/apply', wrap((req, res) => {
  if (!RELEASE_TAG_RE.test(req.params.tag)) return res.status(400).json({ error: 'bad tag' });
  if (!operatorGate(req, res)) return;
  return lifecycle(res, ['update', '--apply', req.params.tag]);
}));
app.post('/api/updates/:tag/skip', wrap((req, res) => {
  if (!RELEASE_TAG_RE.test(req.params.tag)) return res.status(400).json({ error: 'bad tag' });
  if (!operatorGate(req, res)) return;
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
  const m = /^\/term\/(_?[a-z0-9-]{1,32})(?:\?.*)?$/.exec(req.url || '');
  if (!m) return reject(404, 'Not Found');
  const bot = await bots.getBot(m[1]).catch(() => null);
  if (!bot) return reject(404, 'Not Found');
  wss.handleUpgrade(req, socket, head, (ws) => { bridge(bot, ws).catch(() => { try { ws.close(); } catch {} }); });
});

server.listen(PORT, HOST, () => {
  console.log(`[cockpit] http://${HOST}:${PORT}  bots=${bots.BOTS_DIR}  runtime=${bots.BOTCORP_HOME}`);
  console.log(`[cockpit] auth: ${ACCESS ? `Cloudflare Access (team ${accessCfg.team}, jwks ${ACCESS.jwksFile ? 'file' : 'fetch'})` : 'loopback session cookie'}`);
  if (APPROVE_TOKEN) console.log(`[cockpit] approval token (this boot): ${APPROVE_TOKEN}`);
  if (APPROVE_TOKEN) console.log(`[cockpit] the same token, owner-only: ${APPROVE_TOKEN_FILE}`);
});
