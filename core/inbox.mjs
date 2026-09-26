// inbox.mjs - one queue per bot: the one way text reaches a bot's session.
// Producers (`botcorp send`, the cockpit composer, `kind: prompt` automations)
// append; one drainer per bot types the items into the session in order, each
// only while observe (core/observe.mjs) says the phase is idle or the session
// awaits its next prompt.
//
//   <BOTCORP_HOME>/state/<bot>/inbox.jsonl          {id, text, source, ttl_s, at}
//   <BOTCORP_HOME>/state/<bot>/inbox.results.jsonl  {id, status, at, detail}
//
// An item is `queued` until a result line says otherwise (the newest wins):
//   held       the session is blocked (observe's hard block: a login, a usage
//              limit); it stays at the head of the queue and goes out once
//              that clears (back to `queued` until the session is idle)
//   delivered  typed (bracketed paste, then Enter) and its user turn reached
//              the transcript within CONFIRM_MS
//   expired    its ttl ran out while it waited
//   failed     the session is stopped, the transport did not come up, or the
//              typed turn never reached the transcript. Never retyped: a retry
//              could land twice.
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
export const CONFIRM_MS = 30_000;   // the user turn must reach the transcript by then
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

// '30m' | '90s' | '2h' | '45' (minutes) -> seconds (max 24 h); null when unparsable.
export function parseTtl(s) {
  const m = /^(\d+)([smh]?)$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]) * { s: 1, m: 60, h: 3600, '': 60 }[m[2]];
  return n > 0 && n <= 86_400 ? n : null;
}

export function enqueue(bot, { text, source = 'cli', ttlS = DEFAULT_TTL_S }) {
  const item = { id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, text, source, ttl_s: ttlS, at: new Date().toISOString() };
  append(inboxFile(bot), item);
  return item;
}

// Every item, oldest first, with its status: the newest result line, else queued.
export function readInbox(bot) {
  const last = new Map();
  for (const r of readLines(resultsFile(bot))) if (r && r.id) last.set(r.id, r);
  return readLines(inboxFile(bot)).filter((i) => i && i.id).map((i) => {
    const r = last.get(i.id);
    return { ...i, status: r ? r.status : 'queued', detail: r ? r.detail || '' : '', status_at: r ? r.at : i.at };
  });
}

export function itemOf(bot, id) { return readInbox(bot).find((i) => i.id === id) || null; }
const waiting = (bot) => readInbox(bot).filter((i) => !TERMINAL.has(i.status));
const record = (bot, id, status, detail = '') => append(resultsFile(bot), { id, status, at: new Date().toISOString(), detail });

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
        // down (the daemon restarts it), starting, working, unknown: wait for
        // idle, or for the job record to say it waits for its next prompt
        if (o.phase !== 'idle' && !o.awaiting_prompt) { await sleep(pollMs()); continue; }
        const r = await deliver(bot, o.kind, item.text);
        record(bot, item.id, r.ok ? 'delivered' : 'failed', r.detail);
        if (r.ok) delivered++;
      }
    } finally { dropLock(bot); }
  }
  return delivered;
}

async function deliver(bot, kind, text) {
  let ep = ptyOf(bot);
  const started = !ep;
  if (!ep) {
    if (kind !== 'bg') return { ok: false, detail: 'no pty-host endpoint (the session is down)' };
    spawnDetached(process.execPath, [PTY_HOST, '--bot', bot, '--botcorp', ROOT, '--attach']);
    for (const end = Date.now() + HOST_UP_MS; !ep && Date.now() < end;) { await sleep(250); ep = ptyOf(bot); }
    if (!ep) return { ok: false, detail: `the attach host did not come up within ${HOST_UP_MS / 1000}s` };
  }
  const t = { configDir: configDir(bot), home: botHome(bot) };
  const file = await currentTranscript(t);
  let offset = 0;
  if (file) try { offset = fs.statSync(file).size; } catch {}
  const { ws, err } = await typeInto(ep, text);
  try {
    if (err) return { ok: false, detail: err };
    if (await confirm(t, { file, offset }, text)) {
      const via = ep.mode === 'attach' ? `${started ? 'a new' : 'the running'} attach host` : `the running pty-host (${ep.mode})`;
      return { ok: true, detail: `via ${via}; user turn confirmed in the transcript` };
    }
    return { ok: false, detail: `typed, but no matching user turn reached the transcript within ${CONFIRM_MS / 1000}s` };
  } finally { try { ws.close(); } catch {} }
}

// Dial, wait for the screen to settle, type, keep the socket for the caller to close.
function typeInto(ep, text) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ep.port}/?token=${encodeURIComponent(ep.token)}`, { maxPayload: 2 * 1024 * 1024 });
    let last = 0, sent = false, timer = null, done = false;
    const finish = (err) => { if (done) return; done = true; if (timer) clearInterval(timer); resolve({ ws, err }); };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'o') last = Date.now();
      else if (m.t === 'exit' && !sent) finish(`the session client exited (code ${m.code}) before the text was typed`);
    });
    ws.on('error', (e) => { if (!sent) finish(`pty-host: ${e.message}`); });
    ws.on('open', () => {
      const deadline = Date.now() + READY_MS;
      timer = setInterval(() => {
        if (!(last && Date.now() - last >= SETTLE_MS) && Date.now() < deadline) return;
        sent = true;
        ws.send(JSON.stringify({ t: 'i', d: bracketed(text) }));
        ws.send(JSON.stringify({ t: 'i', d: '\r' }));
        finish(null);
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

// Raw lines, not chat.mjs's turns: a typed `/name` is recorded as a
// <command-name> wrapper that the chat view filters out as meta. A plugin
// skill is recorded under its namespaced name: typed `/standup` lands as
// `<command-name>/botcorp:standup</command-name>` (reference host 2026-09-26).
async function confirm(t, start, text) {
  const head = norm(text).slice(0, 60);
  const cmd = /^\/([\w:.-]+)/.exec(text.trim());
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needle = cmd ? new RegExp(`<command-name>/${cmd[1].includes(':') ? '' : '(?:[\\w.-]+:)?'}${esc(cmd[1])}</command-name>`) : null;
  let { file, offset } = start;
  for (const end = Date.now() + CONFIRM_MS; Date.now() < end; await sleep(500)) {
    const cur = await currentTranscript(t);
    if (cur !== file) { file = cur; offset = 0; }
    if (!file) continue;
    let chunk = '';
    try { chunk = await readFrom(file, offset); } catch { continue; }
    for (const line of chunk.split('\n')) {
      const u = userText(line);
      if (u !== null && ((needle && needle.test(u)) || norm(u).includes(head))) return true;
    }
  }
  return false;
}
