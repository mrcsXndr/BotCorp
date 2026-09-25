// inject.mjs - type ONE prompt into a bot's live session, the way the cockpit
// chat does it: a bracketed paste then Enter, as {t:'i'} frames to the bot's
// pty-host (endpoint state/<bot>.pty.json). Run by a `kind: prompt` automation
// (daemon/automations.ps1, docs/automations.md); the scheduler has already
// checked that the session is up, not blocked on a dialog and not busy.
//
//   BOT_PROMPT=<text> node daemon/inject.mjs --bot <name> --session bg|pty
//
// The prompt comes in the environment, never on a command line.
//   pty  the pty-host IS the session; no endpoint = nothing to type into.
//   bg   the pty-host is only the attach transport. With none up, this starts
//        one (`pty-host --attach`), types, and stops it again: a stop on an
//        attach host kills only the `claude attach` client, the session runs on.
// Sent = the prompt (or, for `/name ...`, its <command-name> wrapper) shows up
// as a user entry in the session transcript (located as cockpit/chat.mjs does)
// within CONFIRM_MS. One `SUMMARY:` line; exit 0 = sent.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { NAME_RE, BOTCORP_ROOT, ptyEndpoint, botHome, configDir } from '../cockpit/bots.mjs';
import { currentTranscript } from '../cockpit/chat.mjs';

const PTY_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-host.mjs');
const HOST_UP_MS = 15_000;   // a started attach host publishes its endpoint
const SETTLE_MS = 1_500;     // output quiet this long = the TUI has drawn
const READY_MS = 20_000;     // ... or give up waiting for quiet and type anyway
const CONFIRM_MS = 30_000;   // the user turn must reach the transcript by then

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
// Same framing as the cockpit compose box (cockpit/public/app.js bracketed()).
const bracketed = (text) => '\x1b[200~' + text.replace(/\r\n?/g, '\n') + '\x1b[201~';

function done(code, summary) {
  console.log(`SUMMARY: ${summary}`);
  process.exit(code);
}

// A host of ours that never published (or lost) its endpoint: kill its whole
// tree, `claude attach` included, as pty-host --stop would.
function killTree(pid) {
  if (process.platform !== 'win32') { try { process.kill(pid, 'SIGKILL'); } catch {} return; }
  spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bot') a.bot = argv[++i];
    else if (argv[i] === '--session') a.session = argv[++i];
  }
  return a;
}

async function waitEndpoint(bot, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const ep = await ptyEndpoint(bot);
    if (ep) return ep;
  }
  return null;
}

// Dial, wait for the screen to settle, type, keep the socket for the caller to close.
function typeInto(ep, prompt) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ep.port}/?token=${encodeURIComponent(ep.token)}`, { maxPayload: 2 * 1024 * 1024 });
    let last = 0, sent = false, timer = null;
    const finish = (err) => { if (timer) clearInterval(timer); resolve({ ws, err }); };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'o') last = Date.now();
      else if (m.t === 'exit' && !sent) finish(`the session client exited (code ${m.code}) before the prompt was typed`);
      else if (m.t === 'err') console.log(`pty-host: ${m.m}`);
    });
    ws.on('error', (e) => { if (!sent) finish(`pty-host: ${e.message}`); });
    ws.on('open', () => {
      const deadline = Date.now() + READY_MS;
      timer = setInterval(() => {
        if (!(last && Date.now() - last >= SETTLE_MS) && Date.now() < deadline) return;
        sent = true;
        ws.send(JSON.stringify({ t: 'i', d: bracketed(prompt) }));
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
// <command-name> wrapper that the chat view filters out as meta.
async function confirm(bot, start, prompt) {
  const head = norm(prompt).slice(0, 60);
  const cmd = /^\/([\w:.-]+)/.exec(prompt.trim());
  const needle = cmd ? `<command-name>/${cmd[1]}</command-name>` : null;
  let { file, offset } = start;
  for (const end = Date.now() + CONFIRM_MS; Date.now() < end; await sleep(500)) {
    const cur = await currentTranscript(bot);
    if (cur !== file) { file = cur; offset = 0; }
    if (!file) continue;
    let text = '';
    try { text = await readFrom(file, offset); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = userText(line);
      if (t !== null && ((needle && t.includes(needle)) || norm(t).includes(head))) return true;
    }
  }
  return false;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!NAME_RE.test(a.bot || '') || !['bg', 'pty'].includes(a.session)) done(2, 'failed: usage: inject.mjs --bot <name> --session bg|pty');
  const prompt = process.env.BOT_PROMPT || '';
  if (!prompt.trim()) done(2, 'failed: BOT_PROMPT is empty');
  const bot = { name: a.bot, home: botHome(a.bot), configDir: configDir(a.bot) };

  let ep = await ptyEndpoint(a.bot);
  let host = null;
  if (!ep) {
    if (a.session !== 'bg') done(1, 'failed: no pty-host endpoint (the session is down)');
    host = spawn(process.execPath, [PTY_HOST, '--bot', a.bot, '--botcorp', BOTCORP_ROOT, '--attach'], { stdio: 'ignore', windowsHide: true });
    ep = await waitEndpoint(a.bot, HOST_UP_MS);
    if (!ep || ep.pid !== host.pid) { if (host.exitCode === null) killTree(host.pid); done(1, `failed: the attach host did not come up within ${HOST_UP_MS / 1000}s`); }
  }

  let ok = false, why = '';
  try {
    const file = await currentTranscript(bot);
    let offset = 0;
    if (file) { try { offset = (await fsp.stat(file)).size; } catch {} }
    const { ws, err } = await typeInto(ep, prompt);
    if (err) why = err;
    else {
      ok = await confirm(bot, { file, offset }, prompt);
      if (!ok) why = `typed, but no matching user turn reached the transcript within ${CONFIRM_MS / 1000}s`;
    }
    try { ws.close(); } catch {}
  } finally {
    // Only a host this run started is stopped, and only while it is still ours.
    if (host) {
      const rec = await ptyEndpoint(a.bot);
      if (rec && rec.pid === host.pid) spawnSync(process.execPath, [PTY_HOST, '--stop', a.bot], { stdio: 'ignore', windowsHide: true, timeout: 45_000 });
      else if (host.exitCode === null) killTree(host.pid);
    }
  }
  const via = host ? 'a transient attach host' : `the running pty-host (${ep.mode})`;
  if (ok) done(0, `sent via ${via}; user turn confirmed in the transcript`);
  done(1, `failed: ${why}`);
}

main().catch((e) => done(1, `failed: ${e.message}`));
