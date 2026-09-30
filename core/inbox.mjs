// inbox.mjs - one queue per bot: the one way text reaches a bot's session.
// Producers (`botcorp send`, the cockpit composer, `kind: prompt` automations)
// append; one drainer per bot types the items into the session in order, as
// soon as the session is alive (core/observe.mjs), working or not: Claude Code
// queues input that arrives mid-turn, as it does a Telegram message.
//
//   <BOTCORP_HOME>/state/<bot>/inbox.jsonl          {id, text, source, ttl_s, at}
//   <BOTCORP_HOME>/state/<bot>/inbox.results.jsonl  {id, status, at, detail}
//
// An item is `queued` until a result line says otherwise (the newest wins):
//   held       the session is blocked (observe's hard block: a login, a usage
//              limit); it stays at the head of the queue and goes out once
//              that clears (back to `queued`, then typed)
//   delivered  typed (bracketed paste, then Enter) and, within CONFIRM_MS, its
//              user turn reached the transcript, or Claude Code logged it as
//              queued mid-turn (`queue-operation` enqueue / a `queued_command`
//              attachment: the shape a busy session gives typed input)
//   expired    its ttl ran out while it waited
//   failed     the session is stopped, the command is unknown, or MAX_ATTEMPTS
//              attempts went unconfirmed.
// An attempt that is not confirmed (the transport did not come up, or nothing
// of the typed text reached the transcript) is recorded `queued` with its
// `attempt` number and retried once the session is IDLE, never mid-turn, up to
// MAX_ATTEMPTS; before retyping, the transcript since the first attempt is read
// again, so a turn that landed late is marked delivered instead of typed twice.
// One result line per attempt.
//
// Both files are bounded. inbox.jsonl is trimmed to the newest KEEP_ITEMS once
// it passes KEEP_ITEMS + 100, never dropping an item that still waits; every
// write to it holds <bot>/inbox.lock, so a trim never loses a line another
// producer appended meanwhile. inbox.results.jsonl (the drainer is its only
// writer) is cut to the newest line of each item inbox.jsonl still holds once
// it passes 2 * KEEP_ITEMS lines.
//
// The transport is the bot's pty-host: a pty session's own host, or for a bg
// session an attach host (`pty-host --attach`), started here when none is up
// and shared with the cockpit terminal. Nothing here stops it: it exits on its
// own after BOTCORP_ATTACH_IDLE_MIN with no client. The drainer runs detached
// from whoever kicked it (`botcorp send`, the daemon tick), holds
// <bot>/inbox.drainer (its pid) and exits once no item waits; every item's ttl
// bounds how long that is.

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { ROOT, STATE_DIR, configDir, pidAlive, spawnDetached, sleep } from '../cli/_lib.mjs';
import { botHome } from './paths.mjs';
import { imagePastes } from './attach.mjs';
import { observeBot, ptyOf } from './observe.mjs';
import { currentTranscript } from '../cockpit/chat.mjs';

const PTY_HOST = path.join(ROOT, 'daemon', 'pty-host.mjs');
const CLI = path.join(ROOT, 'cli', 'botcorp.mjs');
export const TERMINAL = new Set(['delivered', 'expired', 'failed']);
export const SOURCES = ['cli', 'cockpit', 'automation'];
export const DEFAULT_TTL_S = 30 * 60;
export const MAX_TEXT_BYTES = 64 * 1024;
export const HOST_UP_MS = 15_000;   // a started attach host publishes its endpoint
const SETTLE_MS = 1_500;            // output quiet this long = the TUI has drawn
const READY_MS = 20_000;            // ... or give up waiting for quiet and type anyway
const HANDSHAKE_MS = 10_000;        // the pty-host answers the WebSocket upgrade by then
export const CONFIRM_MS = 30_000;   // the user turn must reach the transcript by then
export const MAX_ATTEMPTS = 2;      // the first typing, then one retry once the session is idle
const confirmMs = () => Number(process.env.BOTCORP_INBOX_CONFIRM_MS) || CONFIRM_MS;
// Claude Code reads a pasted image path in the background: an Enter before it
// has drawn "[Image #n]" submits nothing (reference host 2026-09-28). So after
// an image paste, Enter waits for IMAGE_MIN_MS, then for IMAGE_QUIET_MS of
// quiet output, at most IMAGE_MAX_MS.
const IMAGE_MIN_MS = 1_000, IMAGE_QUIET_MS = 700, IMAGE_MAX_MS = 10_000;
export const KEEP_ITEMS = 500;
const pollMs = () => Number(process.env.BOTCORP_INBOX_POLL_MS) || 10_000;

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
// Same framing as the cockpit terminal's paste.
const bracketed = (text) => '\x1b[200~' + text.replace(/\r\n?/g, '\n') + '\x1b[201~';

export const inboxFile = (bot) => path.join(STATE_DIR, bot, 'inbox.jsonl');
export const resultsFile = (bot) => path.join(STATE_DIR, bot, 'inbox.results.jsonl');
const lockFile = (bot) => path.join(STATE_DIR, bot, 'inbox.drainer');

function readLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const rows = [];
  for (const ln of text.split('\n')) { if (ln.trim()) try { rows.push(JSON.parse(ln)); } catch {} }
  return rows;
}

function append(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function rewrite(file, rows) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  fs.renameSync(tmp, file);
}

// Held for the few ms a write to inbox.jsonl takes; older than 10 s = a crashed holder's.
function withInboxLock(bot, fn) {
  const f = path.join(STATE_DIR, bot, 'inbox.lock');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (const end = Date.now() + 10_000; ;) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(f).mtimeMs > 10_000) fs.unlinkSync(f); } catch {}
      if (Date.now() > end) throw new Error(`inbox: ${f} is held`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(f); } catch {} }
}

// '30m' | '90s' | '2h' | '45' (minutes) -> seconds (max 24 h); null when unparsable.
export function parseTtl(s) {
  const m = /^(\d+)([smh]?)$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]) * { s: 1, m: 60, h: 3600, '': 60 }[m[2]];
  return n > 0 && n <= 86_400 ? n : null;
}

export function enqueue(bot, { text, source = 'cli', ttlS = DEFAULT_TTL_S }) {
  const item = { id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, text, source, ttl_s: ttlS, at: new Date().toISOString() };
  withInboxLock(bot, () => {
    append(inboxFile(bot), item);
    const rows = readLines(inboxFile(bot));
    if (rows.length <= KEEP_ITEMS + 100) return;
    const done = new Set(readInbox(bot).filter((i) => TERMINAL.has(i.status)).map((i) => i.id));
    const cut = rows.length - KEEP_ITEMS;
    try { rewrite(inboxFile(bot), rows.filter((r, n) => n >= cut || (r && r.id && !done.has(r.id)))); } catch {}
  });
  return item;
}

// Every item, oldest first, with its status: the newest result line, else queued.
// `attempt` / `file` / `offset`: from the newest line that carries an attempt
// (a later held/queued line does not reset them).
export function readInbox(bot) {
  const last = new Map();
  const tried = new Map();
  for (const r of readLines(resultsFile(bot))) {
    if (!r || !r.id) continue;
    last.set(r.id, r);
    if (r.attempt) tried.set(r.id, r);
  }
  return readLines(inboxFile(bot)).filter((i) => i && i.id).map((i) => {
    const r = last.get(i.id);
    const a = tried.get(i.id);
    return { ...i, status: r ? r.status : 'queued', detail: r ? r.detail || '' : '', status_at: r ? r.at : i.at,
      attempt: a ? a.attempt : 0, file: a ? a.file || null : null, offset: a ? a.offset || 0 : 0 };
  });
}

export function itemOf(bot, id) { return readInbox(bot).find((i) => i.id === id) || null; }
const waiting = (bot) => readInbox(bot).filter((i) => !TERMINAL.has(i.status));
function record(bot, id, status, detail = '', extra = {}) {
  append(resultsFile(bot), { id, status, at: new Date().toISOString(), detail, ...extra });
  const rows = readLines(resultsFile(bot));
  if (rows.length <= 2 * KEEP_ITEMS) return;
  // a result dropped for an item inbox.jsonl still holds would read `queued` and be retyped
  const ids = withInboxLock(bot, () => new Set(readLines(inboxFile(bot)).map((i) => i && i.id)));
  if (!ids.has(id)) return;
  const newest = new Map();
  for (const r of rows) if (r && ids.has(r.id)) newest.set(r.id, r);
  try { rewrite(resultsFile(bot), [...newest.values()]); } catch {}
}

// The live drainer's pid, or 0.
export function drainerPid(bot) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(lockFile(bot), 'utf-8').trim()) || 0; } catch {}
  return pidAlive(pid) ? pid : 0;
}

function takeLock(bot) {
  fs.mkdirSync(path.dirname(lockFile(bot)), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(lockFile(bot), String(process.pid), { flag: 'wx' }); return true; }
    catch (e) { if (e.code !== 'EEXIST' || drainerPid(bot)) return false; try { fs.unlinkSync(lockFile(bot)); } catch {} }
  }
  return false;
}

function dropLock(bot) {
  try { if (Number(fs.readFileSync(lockFile(bot), 'utf-8').trim()) === process.pid) fs.unlinkSync(lockFile(bot)); } catch {}
}

// A detached drainer when an item waits and none runs -> its pid, or 0.
export function kick(bot) {
  if (!waiting(bot).length || drainerPid(bot)) return 0;
  return spawnDetached(process.execPath, [CLI, 'inbox', bot, 'drain']);
}

// The drainer loop -> how many items it delivered. Returns at once when
// another drainer holds the lock; re-checks after letting go, so an item
// queued while it was finishing is not left behind.
export async function drain(bot) {
  let delivered = 0;
  while (waiting(bot).length && takeLock(bot)) {
    try {
      for (;;) {
        const now = Date.now();
        for (const i of waiting(bot)) if (now - Date.parse(i.at) > i.ttl_s * 1000) record(bot, i.id, 'expired', `waited past its ttl (${i.ttl_s}s)`);
        const item = waiting(bot)[0];
        if (!item) break;
        const o = observeBot(bot);
        if (o.phase === 'stopped') { record(bot, item.id, 'failed', `session stopped (botcorp start ${bot})`); continue; }
        if (o.phase === 'blocked') {
          if (item.status !== 'held') record(bot, item.id, 'held', `session blocked on '${o.blocked ? o.blocked.needs : '?'}'`);
          await sleep(pollMs());
          continue;
        }
        if (item.status === 'held') record(bot, item.id, 'queued', 'block cleared');
        // down (the daemon restarts it) or starting: no session to type into
        // yet. Alive (idle, working, unknown): type now; Claude Code queues
        // input that arrives mid-turn itself, as it does a Telegram message.
        if (o.phase === 'down' || o.phase === 'starting') { await sleep(pollMs()); continue; }
        if (item.attempt) {
          // an earlier attempt went unconfirmed: it may still land (read the
          // transcript again), else it is retyped only into an idle session
          if (item.file && await landed({ configDir: configDir(bot), home: botHome(bot) }, { file: item.file, offset: item.offset }, item.text)) {
            record(bot, item.id, 'delivered', `attempt ${item.attempt} landed late (confirmed in the transcript)`);
            delivered++;
            continue;
          }
          if (o.phase !== 'idle') { await sleep(pollMs()); continue; }
        }
        const n = (item.attempt || 0) + 1;
        const r = await deliver(bot, o.kind, item.text);
        if (r.ok) { record(bot, item.id, 'delivered', n > 1 ? `attempt ${n}/${MAX_ATTEMPTS} ${r.detail}` : r.detail); delivered++; }
        else if (r.retry && n < MAX_ATTEMPTS) {
          // the first typed attempt's transcript position is the one a late turn is looked for from
          const at = item.file ? { file: item.file, offset: item.offset } : { file: r.file || null, offset: r.offset || 0 };
          record(bot, item.id, 'queued', `attempt ${n}/${MAX_ATTEMPTS}: ${r.detail}; retried once the session is idle`, { attempt: n, ...at });
        } else record(bot, item.id, 'failed', n > 1 ? `attempt ${n}/${MAX_ATTEMPTS}: ${r.detail}` : r.detail);
      }
    } finally { dropLock(bot); }
  }
  return delivered;
}

// The bot's pty-host endpoint; for a bg session an attach host is started when
// none is up (the cockpit terminal shares it) -> {ep, started} or {err}.
export async function attachHost(bot, kind) {
  let ep = ptyOf(bot);
  if (ep) return { ep, started: false };
  if (kind !== 'bg') return { err: 'no pty-host endpoint (the session is down)' };
  spawnDetached(process.execPath, [PTY_HOST, '--bot', bot, '--botcorp', ROOT, '--attach']);
  for (const end = Date.now() + HOST_UP_MS; !ep && Date.now() < end;) { await sleep(250); ep = ptyOf(bot); }
  return ep ? { ep, started: true } : { err: `the attach host did not come up within ${HOST_UP_MS / 1000}s` };
}

// -> {ok, detail}; a failure that may be retried (nothing typed, or typed but
// nothing of it reached the transcript) also carries retry: true and the
// transcript position the attempt started from.
async function deliver(bot, kind, text) {
  const { ep, started, err: hostErr } = await attachHost(bot, kind);
  if (hostErr) return { ok: false, detail: hostErr, retry: true };
  const t = { configDir: configDir(bot), home: botHome(bot) };
  const file = await currentTranscript(t);
  let offset = 0;
  if (file) try { offset = fs.statSync(file).size; } catch {}
  const { ws, err } = await typeInto(ep, text, imagePastes(text, botHome(bot)));
  try {
    if (err) return { ok: false, detail: err, retry: true, file, offset };
    const c = await confirm(t, { file, offset }, text);
    if (c === TURN || c === QUEUED) {
      const via = ep.mode === 'attach' ? `${started ? 'a new' : 'the running'} attach host` : `the running pty-host (${ep.mode})`;
      return { ok: true, detail: `via ${via}; ${c === TURN ? 'user turn' : 'queued by Claude Code mid-turn,'} confirmed in the transcript` };
    }
    if (c) return { ok: false, detail: c };
    return { ok: false, detail: `typed, but no matching user turn reached the transcript within ${confirmMs() / 1000}s`, retry: true, file, offset };
  } finally { try { ws.close(); } catch {} }
}

// Dial, wait for the screen to settle, type, keep the socket for the caller to close.
// `images`: paths pasted after the text, one bracketed paste each (core/attach.mjs).
// Always settles: a host that stalls the upgrade (handshakeMs), closes early, or
// never lets the text go out (an overall deadline) is an error, never a promise
// left pending that wedges the drainer and its lock.
export function typeInto(ep, text, images = [], { handshakeMs = HANDSHAKE_MS } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ep.port}/?token=${encodeURIComponent(ep.token)}`, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: handshakeMs });
    let last = 0, sent = false, timer = null, done = false;
    const guard = setTimeout(() => finish(`pty-host: nothing typed within ${(handshakeMs + READY_MS + IMAGE_MAX_MS) / 1000 + 5}s`), handshakeMs + READY_MS + IMAGE_MAX_MS + 5_000);
    const finish = (err) => { if (done) return; done = true; clearTimeout(guard); if (timer) clearInterval(timer); resolve({ ws, err }); };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'o') last = Date.now();
      else if (m.t === 'exit' && !sent) finish(`the session client exited (code ${m.code}) before the text was typed`);
    });
    ws.on('error', (e) => { if (!sent) finish(`pty-host: ${e.message}`); });
    ws.on('close', (code) => finish(`pty-host closed the connection (code ${code}) before the text was typed`));
    ws.on('open', () => {
      const deadline = Date.now() + READY_MS;
      timer = setInterval(() => {
        if (!(last && Date.now() - last >= SETTLE_MS) && Date.now() < deadline) return;
        sent = true;
        ws.send(JSON.stringify({ t: 'i', d: bracketed(text) + images.map((p) => ' ' + bracketed(p)).join('') }));
        if (!images.length) { ws.send(JSON.stringify({ t: 'i', d: '\r' })); finish(null); return; }
        clearInterval(timer);
        const pasted = Date.now();
        timer = setInterval(() => {
          const now = Date.now();
          if (now - pasted < IMAGE_MIN_MS || (now - last < IMAGE_QUIET_MS && now - pasted < IMAGE_MAX_MS)) return;
          ws.send(JSON.stringify({ t: 'i', d: '\r' }));
          finish(null);
        }, 100);
      }, 100);
    });
  });
}

// The text of a transcript line when it is a user entry, else null.
function userText(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o?.type !== 'user') return null;
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n') : null;
}

async function readFrom(file, offset) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= offset) return '';
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    return buf.toString('utf-8');
  } finally { await fh.close(); }
}

// A `/name` Claude Code does not know is no user turn but a system line.
function unknownCommand(line, name) {
  let o;
  try { o = JSON.parse(line); } catch { return false; }
  return o?.type === 'system' && typeof o.content === 'string' && o.content.trim() === `Unknown command: /${name}`;
}

// Input typed into a BUSY session is no user entry: Claude Code logs
// `{type: 'queue-operation', operation: 'enqueue', content}` at once and, when
// the running turn absorbs it, a `queued_command` attachment carrying the text
// as `prompt` (reference host 2026-09-29: both "failed" approval notices had
// reached the bot this way). The text of such a line, else null.
function queuedText(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o?.type === 'queue-operation' && o.operation === 'enqueue' && typeof o.content === 'string') return o.content;
  if (o?.type === 'attachment' && o.attachment?.type === 'queued_command' && typeof o.attachment.prompt === 'string') return o.attachment.prompt;
  return null;
}

const TURN = 'turn', QUEUED = 'queued';

// Raw lines, not chat.mjs's turns: a typed `/name` is recorded as a
// <command-name> wrapper that the chat view filters out as meta. A plugin
// skill is recorded under its namespaced name: typed `/standup` lands as
// `<command-name>/botcorp:standup</command-name>` (reference host 2026-09-26).
// A plugin COMMAND is not: bare `/critic` is "Unknown command: /critic", and
// only `/botcorp:critic` runs it. -> TURN | QUEUED | {failed: why} | null.
function matcher(text) {
  const head = norm(text).slice(0, 60);
  const cmd = /^\/([\w:.-]+)/.exec(text.trim());
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needle = cmd ? new RegExp(`<command-name>/${cmd[1].includes(':') ? '' : '(?:[\\w.-]+:)?'}${esc(cmd[1])}</command-name>`) : null;
  return (line) => {
    const u = userText(line);
    if (u !== null && ((needle && needle.test(u)) || norm(u).includes(head))) return TURN;
    const q = queuedText(line);
    if (q !== null && norm(q).includes(head)) return QUEUED;
    if (cmd && unknownCommand(line, cmd[1])) {
      return { failed: `typed, but Claude Code has no /${cmd[1]}${cmd[1].includes(':') ? '' : ' (a plugin command needs its prefix, such as /botcorp:<name>)'}` };
    }
    return null;
  };
}

// TURN / QUEUED = confirmed, a string = why it failed, false = nothing within the window.
async function confirm(t, start, text) {
  const match = matcher(text);
  let { file, offset } = start;
  for (const end = Date.now() + confirmMs(); Date.now() < end; await sleep(500)) {
    const cur = await currentTranscript(t);
    if (cur !== file) { file = cur; offset = 0; }
    if (!file) continue;
    let chunk = '';
    try { chunk = await readFrom(file, offset); } catch { continue; }
    for (const line of chunk.split('\n')) {
      const m = match(line);
      if (m === TURN || m === QUEUED) return m;
      if (m) return m.failed;
    }
  }
  return false;
}

// Did an earlier, unconfirmed attempt land after all? One read of the transcript
// from where that attempt started (the whole current one when it has rotated).
async function landed(t, start, text) {
  const match = matcher(text);
  const cur = await currentTranscript(t);
  if (!cur) return false;
  let chunk = '';
  try { chunk = await readFrom(cur, cur === start.file ? start.offset : 0); } catch { return false; }
  return chunk.split('\n').some((line) => { const m = match(line); return m === TURN || m === QUEUED; });
}
