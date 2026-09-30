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
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import yaml from 'js-yaml';

import * as bots from './bots.mjs';
import { restrictToUser } from '../core/acl.mjs';
import * as vault from './vault.mjs';
import * as pairing from './pairing.mjs';
import * as operatorPair from './operator-pair.mjs';
import * as history from './history.mjs';
import * as chat from './chat.mjs';
import * as engine from './engine.mjs';
import * as updates from './updates.mjs';
import * as chatLaunch from './chat-launch.mjs';
import * as attention from './attention.mjs';
import { runCli, cliJson } from './cli.mjs';
import * as inbox from '../core/inbox.mjs';
import * as attach from '../core/attach.mjs';
import { ccStatus } from '../core/cc.mjs';
import { MODEL_TIERS } from '../daemon/botyaml.mjs';
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
  // img-src blob:: attachment thumbnails are object URLs of a local file or of a gated fetch
  "default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "connect-src 'self'", "img-src 'self' blob:",
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
// The model tiers a bot's Settings offers by name (harness/models.json); opt-in tiers are left out.
app.get('/api/models', (_req, res) => res.json(Object.entries(MODEL_TIERS).filter(([, t]) => t && !t.opt_in)
  .map(([tier, t]) => ({ tier, id: t.id, name: t.name, effort: t.effort ?? null }))));
app.get('/api/bots/:name', withBot(async (_req, res, bot) => res.json(bot)));

// Lifecycle goes through the CLI. The response is the CLI's outcome, scrubbed.
async function lifecycle(res, args) {
  const r = await runCli(args);
  res.status(r.code === 0 ? 200 : 502).json({ ok: r.code === 0, code: r.code, timedOut: r.timedOut, out: r.out, err: r.err });
}
app.post('/api/bots/:name/start', withBot((req, res, bot) => lifecycle(res, ['start', bot.name, ...(req.body?.fresh ? ['--fresh'] : [])])));
app.post('/api/bots/:name/stop', withBot((_req, res, bot) => lifecycle(res, ['stop', bot.name])));
app.post('/api/bots/:name/restart', withBot((req, res, bot) => lifecycle(res, ['restart', bot.name, ...(req.body?.fresh ? ['--fresh'] : [])])));

// New bot / New chat (`botcorp new --yes --no-launch`): always on a registered
// account, never with a typed token. A chat is service: manual, named
// chat-MMDD-HHMM when unnamed. A Telegram token follows through PUT
// /secrets/telegram, then POST /start: creating never launches.
const PERSONA_RE = /^[^\r\n\0]{1,300}$/;
function chatName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `chat-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
app.post('/api/bots', wrap(async (req, res) => {
  const { name, persona, account, telegram, service } = req.body || {};
  if (!['daemon', 'manual'].includes(service)) return res.status(400).json({ error: 'service: daemon (keep running) or manual (a chat)' });
  if (typeof account !== 'string' || !bots.NAME_RE.test(account)) return res.status(400).json({ error: 'account: a registered account id' });
  if (!(name === undefined || name === null || name === '' || (typeof name === 'string' && bots.NAME_RE.test(name)))) return res.status(400).json({ error: 'name: lowercase letters, digits and hyphens, at most 32' });
  if (!(persona === undefined || persona === null || persona === '' || (typeof persona === 'string' && PERSONA_RE.test(persona)))) return res.status(400).json({ error: 'persona: one line, at most 300 characters' });
  if (!(telegram === undefined || typeof telegram === 'boolean')) return res.status(400).json({ error: 'telegram: true or false' });
  if (!operatorGate(req, res)) return;
  let bot = name || (service === 'manual' ? chatName() : '');
  if (bot && !name) {
    const taken = new Set((await bots.listBots()).map((b) => b.name));
    for (let n = 2; taken.has(bot); n++) bot = `${chatName()}-${n}`;
  }
  const args = ['new', '--yes', '--no-launch', '--service', service, '--account', account];
  if (bot) args.push('--name', bot);
  if (persona) args.push('--persona', persona);
  if (telegram) args.push('--telegram');
  res.locals.audit = { action: 'new', account, service, ...(bot ? { new_bot: bot } : {}) };
  const r = await runCli(args, { timeoutMs: 600_000 });
  attention.invalidate();
  const made = /^created .*[\\/]([a-z0-9][a-z0-9-]{0,31})[\\/]bot\.yaml$/m.exec(r.out);
  // exit 2: the account is unknown, has no token or failed its token check
  res.status(r.code === 0 ? 200 : r.code === 2 ? 409 : 502).json({ ok: r.code === 0, name: made ? made[1] : bot || null, code: r.code, out: r.out, err: r.err });
}));
// Archive a chat (`botcorp archive`): its folder moves to <rt>/archive; a pinned bot is refused (409).
app.post('/api/bots/:name/archive', withBot(async (req, res, bot) => {
  if (!operatorGate(req, res)) return;
  res.locals.audit = { action: 'archive' };
  const r = await runCli(['archive', bot.name], { timeoutMs: 120_000 });
  attention.invalidate();
  res.status(r.code === 0 ? 200 : r.code === 2 ? 409 : 502).json({ ok: r.code === 0, code: r.code, out: r.out, err: r.err });
}));

app.get('/api/bots/:name/sessions', withBot(async (_req, res, bot) => res.json(await history.listSessions(bot.configDir, bot.home))));
app.get('/api/bots/:name/chat', withBot(async (req, res, bot) => {
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  res.json(await chat.chatState(bot, after));
}));
// Chat send: queued in the bot's inbox by `botcorp send` (the text on stdin,
// never argv), which types it as soon as the session is alive. The response is the
// queued item; the composer follows it through GET /inbox.
// `attachments`: ids from POST /uploads, named on a line each after the text.
app.post('/api/bots/:name/send', withBot(async (req, res, bot) => {
  const ids = req.body?.attachments ?? [];
  if (!Array.isArray(ids) || ids.length > 10) return res.status(400).json({ error: 'attachments: a list of at most 10 uploads' });
  const files = [];
  for (const id of ids) {
    const abs = attach.resolveUpload(bot.home, id);
    if (!abs) return res.status(400).json({ error: `no such upload: ${String(id).slice(0, 80)}` });
    files.push({ path: abs, bytes: (await fsp.stat(abs)).size });
  }
  const typed = req.body?.text ?? '';
  if (typeof typed !== 'string' || (!typed.trim() && !files.length)) return res.status(400).json({ error: 'empty message' });
  const text = files.length ? attach.withAttachments(typed, files) : typed;
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
// token this server prints to the terminal that started it, or the operator
// cookie of a browser paired with `botcorp cockpit pair` (operator-pair.mjs).
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
// A browser paired once (operator-pair.mjs) carries the operator cookie instead of the token.
function operatorGate(req, res) {
  if (!APPROVE_TOKEN) return true;
  if (operatorPair.deviceOf(bots.STATE_DIR, req.headers.cookie)) return true;
  const got = String(req.headers['x-approve-token'] || '');
  if (got.length === APPROVE_TOKEN.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(APPROVE_TOKEN))) return true;
  res.status(403).json({ error: 'needs the operator: pair this browser once (`botcorp cockpit pair` in your terminal, then enter the code), or the approval token this cockpit printed at start, also in <BOTCORP_HOME>/state/cockpit-approve-token (or Cloudflare Access, or `botcorp approve` in your terminal)', need: 'approve-token' });
  return false;
}

// ---- browser pairing (loopback only: behind Access the verified identity is the operator)
const PAIR_CODE_RE = /^[A-Za-z0-9 -]{4,20}$/;
const DEVICE_ID_RE = /^[0-9a-f]{16}$/;
app.post('/api/pair/claim', wrap(async (req, res) => {
  if (ACCESS) return res.status(404).json({ error: 'not used behind Cloudflare Access: the verified identity already decides' });
  const code = req.body?.code;
  if (typeof code !== 'string' || !PAIR_CODE_RE.test(code)) return res.status(400).json({ error: 'code: the 8 characters `botcorp cockpit pair` printed' });
  const r = operatorPair.claim(bots.STATE_DIR, code, { label: String(req.headers['user-agent'] || '') });
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.locals.audit = { pair: 'claim', device: r.device.id };
  res.setHeader('Set-Cookie', operatorPair.setCookieHeader(r.value));
  res.json({ ok: true, device: r.device });
}));
app.get('/api/pair/devices', wrap(async (req, res) => {
  if (ACCESS) return res.json({ exposure: 'access', devices: [] });
  const cur = operatorPair.deviceOf(bots.STATE_DIR, req.headers.cookie);
  res.json({ exposure: 'loopback', devices: operatorPair.listDevices(bots.STATE_DIR).map((d) => ({ ...d, current: !!cur && cur.id === d.id })) });
}));
// :id = one device, or `all`
app.delete('/api/pair/devices/:id', wrap(async (req, res) => {
  const { id } = req.params;
  if (id !== 'all' && !DEVICE_ID_RE.test(id)) return res.status(400).json({ error: 'a device id, or all' });
  if (!operatorGate(req, res)) return;
  res.locals.audit = { pair: 'revoke', device: id };
  const n = operatorPair.revoke(bots.STATE_DIR, id);
  if (!n) return res.status(404).json({ error: 'no such device' });
  res.json({ ok: true, removed: n });
}));
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
  res.json({ pending, recent: await attention.recentDecisions(20), admin: await attention.adminActions(20) });
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
app.get('/api/bots/:name/inventory', withBot(async (_req, res, bot) => {
  const inv = await cliJson(['tools', bot.name, 'inventory', '--json'], null);
  if (!inv) return res.status(502).json({ error: 'tools inventory failed' });
  res.json(inv);
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

// A bot's account chain in one go (the Accounts sheet): the primary
// (`accounts use`) and the ordered backups (`accounts backups`), each through
// the CLI with the identity as --by. A new primary that is now a backup, or an
// old primary that becomes one, would fail bot.yaml validation half way, so
// the backups are cleared first then; a later step failing puts them back.
app.post('/api/bots/:name/accounts', withBot(async (req, res, bot) => {
  const { primary, backups } = req.body || {};
  if (typeof primary !== 'string' || (primary !== 'none' && !bots.NAME_RE.test(primary))) return res.status(400).json({ error: 'primary: a registered account id, or none (the bot\'s own token)' });
  if (!Array.isArray(backups) || backups.length > 5 || !backups.every((x) => typeof x === 'string' && bots.NAME_RE.test(x))) return res.status(400).json({ error: 'backups: a list of at most 5 account ids' });
  if (new Set(backups).size !== backups.length || backups.includes(primary)) return res.status(400).json({ error: 'backups: each account once, and not the primary' });
  if (!operatorGate(req, res)) return;
  res.locals.audit = { account: primary, backups: backups.join(',') };
  const cur = { primary: bot.account || 'none', backups: bot.backups || [] };
  const primaryChanges = primary !== cur.primary;
  const backupsChange = JSON.stringify(backups) !== JSON.stringify(cur.backups);
  const clearFirst = primaryChanges && cur.backups.length > 0 && (cur.backups.includes(primary) || backups.includes(cur.primary));
  const steps = [];
  const run = async (args) => { const r = await runCli([...args, '--by', req.identity]); steps.push({ args: args.slice(0, 2).join(' '), code: r.code, out: r.out, err: r.err }); return r.code === 0; };
  let ok = true, usedPrimary = false;
  if (clearFirst) ok = await run(['accounts', 'backups', bot.name, 'none']);
  if (ok && primaryChanges) usedPrimary = ok = await run(['accounts', 'use', bot.name, primary]);
  if (ok && (backupsChange || clearFirst) && backups.length) ok = await run(['accounts', 'backups', bot.name, backups.join(',')]);
  else if (ok && backupsChange && !clearFirst) ok = await run(['accounts', 'backups', bot.name, 'none']);
  if (!ok) {   // put the old chain back: the primary first (the backups are cleared or unchanged then), then the backups
    if (usedPrimary) await run(['accounts', 'use', bot.name, cur.primary]);
    if (clearFirst) await run(['accounts', 'backups', bot.name, cur.backups.join(',')]);
  }
  attention.invalidate();
  const last = steps.find((s) => s.code !== 0) || steps[steps.length - 1] || { code: 0, out: 'nothing to change', err: '' };
  res.status(ok ? 200 : last.code === 2 ? 409 : 502).json({ ok, steps: steps.map((s) => ({ step: s.args, code: s.code })), out: last.out, err: last.err });
}));

// The Settings sheet: every bot.yaml value as the CLI sees it (defaults
// merged), which of them the file sets itself, and one value at a time
// through `config set`. A widening change queues like a bot's would; the
// sheet shows the queued entry to decide on the spot.
const CONFIG_PATH_RE = /^[a-z_][a-z0-9_]*(\.[a-z0-9_-]+){0,4}$/;
const LIST_PATHS = new Set(['harness.hooks_disable', 'harness.disable']);
const LIST_ITEM_RE = /^[a-z0-9][a-z0-9_-]{0,63}(:[a-z0-9][a-z0-9_-]{0,63})?$/;
function leafPaths(obj, pre = '') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return pre ? [pre] : [];
  return Object.keys(obj).flatMap((k) => leafPaths(obj[k], pre ? `${pre}.${k}` : k));
}
app.get('/api/bots/:name/config', withBot(async (_req, res, bot) => {
  const config = await cliJson(['config', 'get', bot.name, '--json'], null);
  if (!config) return res.status(502).json({ error: `config get ${bot.name} failed${bot.yamlError ? `: ${bot.yamlError}` : ''}` });
  let raw = {};
  try { raw = yaml.load(await fsp.readFile(path.join(bot.home, 'bot.yaml'), 'utf-8')) || {}; } catch {}
  res.json({ config, set: leafPaths(raw) });
}));
app.post('/api/bots/:name/config', withBot(async (req, res, bot) => {
  const { path: p, value } = req.body || {};
  if (typeof p !== 'string' || p.length > 100 || !CONFIG_PATH_RE.test(p)) return res.status(400).json({ error: 'path: a dotted bot.yaml key, like harness.modules.debrief' });
  const scalar = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 2000);
  // the Tools tab's switches: the two name lists, each item a plain name (config set reads [a,b])
  const list = LIST_PATHS.has(p) && Array.isArray(value) && value.length <= 50 && value.every((x) => typeof x === 'string' && LIST_ITEM_RE.test(x));
  if (!scalar && !list) return res.status(400).json({ error: `value: one scalar (text up to 2000 characters, a number, true / false or null), or a list of names for ${[...LIST_PATHS].join(' / ')}; other lists are edited in the terminal` });
  if (!operatorGate(req, res)) return;
  res.locals.audit = { config: p };
  const text = list ? `[${value.join(',')}]` : value === null ? 'null' : String(value);
  const r = await runCli(['config', 'set', bot.name, p, text, '--requested-by', req.identity]);
  attention.invalidate();
  const q = /queued for operator approval: botcorp approve \S+ ([0-9a-f]+)/.exec(r.out);
  const dup = /already queued for operator approval/.test(r.out);
  // a refusal (unknown path, invalid value) is the CLI's exit >0 with its reason; <0 = it did not run
  res.status(r.code === 0 ? 200 : r.code > 0 ? 400 : 502).json({ ok: r.code === 0, applied: r.code === 0 && !q, queued: q ? q[1] : null, duplicate: dup, code: r.code, out: r.out, err: r.err });
}));
// The Settings sheet's host section: what runs this cockpit.
app.get('/api/cockpit', wrap(async (_req, res) => {
  const cc = ccStatus();
  res.json({
    ...(await engine.engineVersion()),
    exposure: ACCESS ? 'access' : 'loopback',
    cc: { pinned: cc.pinned ? cc.pinned.version : null, candidate: cc.candidate ? { version: cc.candidate.version, status: cc.candidate.status } : null },
  });
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
// apply | skip | rollback (a release older than the installed one) | cancel (a request)
app.post('/api/updates/:tag/:action', wrap((req, res) => {
  const { tag, action } = req.params;
  if (!RELEASE_TAG_RE.test(tag) || tag.startsWith('-')) return res.status(400).json({ error: 'bad tag' });
  if (!['apply', 'skip', 'rollback', 'cancel'].includes(action)) return res.status(404).json({ error: 'no such action' });
  if (!operatorGate(req, res)) return;
  res.locals.audit = { release: tag, action };
  return lifecycle(res, ['update', `--${action}`, tag, '--by', req.identity]);
}));

// New-chat launcher: an interactive `claude` in a Windows Terminal tab under
// a chosen account. `chat --account`/`--generic`/`--cwd` opens the tab on the
// HOST's desktop, not in this response, so over an Access-exposed cockpit the
// operator only sees the CLI's launch outcome here, not the tab itself.
// The Accounts sheet (and the New-chat picker): every registered account with
// its state, usage and bots (attention.accountsOverview).
app.get('/api/accounts', wrap(async (_req, res) => res.json(await attention.accountsOverview())));
// Add a Claude account. The setup token travels in the JSON body and reaches
// `accounts add` on stdin: never argv, never a log (auditOnClose records the
// path, the method and the id only; the CLI's reply carries the last 4).
const ACCOUNT_TEXT_RE = /^[^\r\n\0]{0,64}$/;
// `plan` in the body is ignored: the CLI detects the plan (accounts add --plan stays a CLI-only override).
app.post('/api/accounts', wrap(async (req, res) => {
  const { id, label, token } = req.body || {};
  if (!bots.NAME_RE.test(id || '')) return res.status(400).json({ error: 'id: lowercase letters, digits and hyphens, at most 32' });
  if (!(label === undefined || label === null || (typeof label === 'string' && ACCOUNT_TEXT_RE.test(label)))) return res.status(400).json({ error: 'label: one line, at most 64 characters' });
  if (typeof token !== 'string' || token.length < 20 || token.length > 400 || /\s/.test(token)) return res.status(400).json({ error: 'token: the whole string `claude setup-token` printed (20 to 400 characters, no spaces)' });
  if (!operatorGate(req, res)) return;
  const args = ['accounts', 'add', id, '--by', req.identity];
  if (label) args.push('--label', label);
  res.locals.audit = { account: id, action: 'add' };
  const r = await runCli(args, { stdin: token + '\n' });
  attention.invalidate();
  res.status(r.code === 0 ? 200 : 502).json({ ok: r.code === 0, code: r.code, out: r.out, err: r.err });
}));
app.delete('/api/accounts/:id', wrap(async (req, res) => {
  const { id } = req.params;
  if (!bots.NAME_RE.test(id)) return res.status(400).json({ error: 'bad account id' });
  if (!operatorGate(req, res)) return;
  res.locals.audit = { account: id, action: 'remove' };
  const r = await runCli(['accounts', 'remove', id, '--by', req.identity]);
  attention.invalidate();
  // exit 2 = a bot's bot.yaml still names it (the CLI's message says which)
  if (r.code === 2) return res.status(409).json({ ok: false, code: r.code, error: (r.err || r.out).trim() });
  res.status(r.code === 0 ? 200 : 502).json({ ok: r.code === 0, code: r.code, out: r.out, err: r.err });
}));
// Rename an account: the label only (`accounts rename`).
app.patch('/api/accounts/:id', wrap(async (req, res) => {
  const { id } = req.params;
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  if (!bots.NAME_RE.test(id)) return res.status(400).json({ error: 'bad account id' });
  if (!label || !ACCOUNT_TEXT_RE.test(label)) return res.status(400).json({ error: 'label: one line, 1 to 64 characters' });
  if (!operatorGate(req, res)) return;
  res.locals.audit = { account: id, action: 'rename' };
  const r = await runCli(['accounts', 'rename', id, '--label', label, '--by', req.identity]);
  attention.invalidate();
  if (r.code === 2) return res.status(404).json({ ok: false, code: r.code, error: 'no such account' });
  res.status(r.code === 0 ? 200 : 502).json({ ok: r.code === 0, code: r.code, out: r.out, err: r.err });
}));
// The account_unlinked item's Link: every bot's own token becomes an account and the bot is set to it (`accounts seed --link`).
app.post('/api/accounts/link', wrap(async (req, res) => {
  if (!operatorGate(req, res)) return;
  res.locals.audit = { action: 'link' };
  const r = await runCli(['accounts', 'seed', '--link', '--json', '--by', req.identity], { timeoutMs: 180_000 });
  attention.invalidate();
  let result = null;
  try { result = JSON.parse(r.out); } catch {}
  if (r.code !== 0 || !result) return res.status(502).json({ ok: false, code: r.code, err: r.err || r.out });
  res.json({ ok: true, ...result });
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

// Attachments (composer, terminal paste/drop, +file): one file per request, the
// raw bytes as the body, its name in X-File-Name. Operator-gated (a bot must not
// fill its own folder through here); an allow-listed type, at most 20 MB, kept
// under the bot's own <bot>/.botcorp/uploads (core/attach.mjs). 10/min per session.
const uploadHits = new Map();   // cookie -> [ts]
function uploadAllowed(req) {
  const key = cookie.read(req) || req.identity;
  const now = Date.now();
  const hits = (uploadHits.get(key) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 10) { uploadHits.set(key, hits); return false; }
  hits.push(now); uploadHits.set(key, hits);
  return true;
}
const rawBody = express.raw({ type: () => true, limit: attach.UPLOAD_MAX });
const gated = (req, res, next) => { if (operatorGate(req, res)) next(); };
app.post('/api/bots/:name/uploads', gated, (req, res, next) => rawBody(req, res, (e) => {
  if (!e) return next();
  res.status(e.status || 400).json({ error: e.type === 'entity.too.large' ? `file too large (${attach.UPLOAD_MAX / 1024 / 1024} MB max)` : e.message });
}), withBot(async (req, res, bot) => {
  if (!uploadAllowed(req)) return res.status(429).json({ error: 'too many uploads (10 per minute)' });
  let name = '';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { throw new Error('bad file name'); }
  const stored = attach.storedName(name);   // throws on a refused type
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('empty file');
  const dir = attach.uploadsDir(bot.home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
  let file = path.join(dir, stored);
  for (let n = 2; ; n++) {
    try { await fsp.writeFile(file, req.body, { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST' || n > 50) throw e;
      file = path.join(dir, stored.replace(/(\.[a-z0-9]+)$/, `-${n}$1`));
    }
  }
  res.locals.audit = { upload: path.basename(file), bytes: req.body.length };
  res.json({ id: path.basename(file), path: file, type: attach.extOf(file), bytes: req.body.length, image: attach.isImage(file) });
}));
// An uploaded image, for the thumbnails (fetched with the approval token, shown as a blob: URL).
app.get('/api/bots/:name/uploads/:file', gated, withBot(async (req, res, bot) => {
  const abs = attach.resolveUpload(bot.home, req.params.file);
  if (!abs || !attach.isImage(abs)) return res.status(404).json({ error: 'no such image' });
  res.setHeader('Content-Type', attach.IMAGE_MIME[attach.extOf(abs)]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(await fsp.readFile(abs));
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
