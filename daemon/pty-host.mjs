// pty-host.mjs - one detached process per bot that OWNS the bot's ConPTY.
//
// The cockpit used to spawn the pty inside its own process, so every cockpit
// restart/update killed every bot session and the browser view simply went
// blank. Now the daemon starts ONE of these per bot; it holds the pty and a
// scrollback ring, and the cockpit (or anything else on this box) attaches
// over a loopback WebSocket, detaches, and re-attaches freely.
//
//   node daemon/pty-host.mjs --bot <name> --botcorp <BotCorp root> [--continue|--fresh]
//   node daemon/pty-host.mjs --bot <name> --botcorp <BotCorp root> --attach
//   node daemon/pty-host.mjs --stop <name>
//
// Two session kinds (bot.yaml harness.session):
//   pty  (launch)  It spawns `pwsh -NoProfile -ExecutionPolicy Bypass -File
//                  <root>/daemon/launch.ps1 -Bot <name> -Continue|-Fresh -InPty`
//                  with cwd = <root>/bots/<name> (BOT_HOME). launch.ps1 does
//                  vault -> env and runs claude itself, so NOTHING is typed into
//                  the shell (the old cockpit typed `claude\r` on a 700 ms timer
//                  and raced the prompt on a cold box).
//   bg   (--attach) The bot is a Claude Code background session under the
//                  supervisor (started by the daemon: launch.ps1 -Bg). This host
//                  is then only the cockpit's ATTACH TRANSPORT: the pty runs
//                  `claude attach <id>` (id = bg_id from <BOTCORP_HOME>/state/
//                  <bot>.json, CLAUDE_CONFIG_DIR = the bot's config home). Closing
//                  the pty detaches; the session keeps running. `--stop` on an
//                  attach host kills only the attach client, never the session
//                  (the daemon stops a bg session with `claude stop <id>`). The
//                  supervisor pipe answers only callers with the daemon's
//                  elevation: a host spawned non-elevated against a RunLevel
//                  Highest daemon shows an empty/failed attach (docs/daemon.md).
//
// Endpoint file: <BOTCORP_HOME>/state/<bot>.pty.json
//   { pid, ptyPid, port, token, startedAt, mode }
// pid = this process, ptyPid = the shell (the root of the tree to kill).
//
// WS protocol (JSON per frame), at ws://127.0.0.1:<port>/?token=<token>:
//   host -> client : {t:'hello', pid, ptyPid, startedAt, mode} then {t:'o', d:<scrollback>}
//                    {t:'o', d}  live output   {t:'exit', code}   {t:'err', m}
//   client -> host : {t:'i', d}  input (<= 1 MB per frame, else dropped + err)
//                    {t:'r', cols, rows}  resize
//
// Stop = tree-kill of ptyPid (`taskkill /T /F`): on Windows `pty.kill()` only
// killed the shell and left claude.exe + the Telegram poller as orphans holding
// the getUpdates slot, so the next start 409'd.
//
// Test seam: BOTCORP_PTY_COMMAND=<command line> replaces the launch.ps1 command
// (run through cmd.exe /c, or sh -c off Windows). Only honoured when set; it
// launches nothing that is not already on this box and never touches auth.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);

const MAX_SCROLLBACK = 200_000;       // chars kept for late attachers
const MAX_INPUT_FRAME = 1024 * 1024;  // per-frame input cap
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const BOTCORP_HOME = process.env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp');
const STATE_DIR = path.join(BOTCORP_HOME, 'state');

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { mode: 'continue' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--bot') a.bot = argv[++i];
    else if (k === '--botcorp') a.botcorp = argv[++i];
    else if (k === '--continue') a.mode = 'continue';
    else if (k === '--fresh') a.mode = 'fresh';
    else if (k === '--attach') a.mode = 'attach';
    else if (k === '--stop') a.stop = argv[++i];
    else { console.error(`pty-host: unknown arg ${k}`); process.exit(2); }
  }
  return a;
}

function ptyJsonPath(bot) { return path.join(STATE_DIR, `${bot}.pty.json`); }

function readPtyJson(bot) {
  try { return JSON.parse(fs.readFileSync(ptyJsonPath(bot), 'utf-8')); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Prefer PowerShell 7, then Windows PowerShell 5.1. Never the WindowsApps
// `pwsh.exe` execution-alias stub: it is a reparse point that ConPTY's
// CreateProcess cannot launch ("File not found"). Only a REAL exe path.
function resolveShell() {
  if (process.platform !== 'win32') return { file: process.env.SHELL || '/bin/bash', args: [] };
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell', '7', 'pwsh.exe'),
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return { file: c, args: [] }; } catch {}
  }
  return { file: process.env.ComSpec || path.join(sysRoot, 'System32', 'cmd.exe'), args: [] };
}

// Best-effort "0600": strip inheritance and grant only the current user. On
// Windows `mode: 0o600` is a no-op, so the ACL is the only real protection.
function restrictToUser(file) {
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch {} return; }
  const user = process.env.USERNAME;
  if (!user) return;
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const icacls = path.join(sysRoot, 'System32', 'icacls.exe');
  try {
    execFileSync(icacls, [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  } catch { /* best effort */ }
}

function treeKill(pid) {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const taskkill = path.join(sysRoot, 'System32', 'taskkill.exe');
    const r = spawnSync(taskkill, ['/T', '/F', '/PID', String(pid)], { stdio: 'pipe', windowsHide: true, timeout: 15_000 });
    return r.status === 0;
  }
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } }
}

// ---- --stop -----------------------------------------------------------------
async function stop(bot) {
  if (!NAME_RE.test(bot || '')) { console.error('pty-host: bad bot name'); process.exit(2); }
  const rec = readPtyJson(bot);
  if (!rec) { console.log(`pty-host: ${bot} not running (no pty.json)`); return 0; }
  const killedTree = treeKill(rec.ptyPid);
  console.log(`pty-host: taskkill /T ptyPid=${rec.ptyPid} -> ${killedTree ? 'ok' : 'no such process'}`);
  // The host sees the pty exit, removes its own file and exits ~2 s later;
  // give it that chance, then force the leftovers so `stop` is final.
  for (let i = 0; i < 25 && pidAlive(rec.pid); i++) await new Promise((r) => setTimeout(r, 200));
  if (pidAlive(rec.pid) && rec.pid !== process.pid) { treeKill(rec.pid); console.log(`pty-host: killed host pid=${rec.pid}`); }
  try { fs.unlinkSync(ptyJsonPath(bot)); } catch {}
  console.log(`pty-host: ${bot} stopped`);
  return 0;
}

// ---- host -------------------------------------------------------------------
// Same order as daemon/_common.ps1 Resolve-ClaudeExe: the native installer
// first (a stale npm shim can shadow it), then PATH.
function resolveClaude() {
  const native = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(native)) return native;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) { try { if (fs.statSync(path.join(dir, n)).isFile()) return path.join(dir, n); } catch {} }
  }
  return native;
}

function readBotState(bot) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${bot}.json`), 'utf-8')); } catch { return null; }
}

function buildCommand(a, botHome) {
  const override = process.env.BOTCORP_PTY_COMMAND;
  if (override) {
    console.error('pty-host: BOTCORP_PTY_COMMAND set - running the override instead of launch.ps1 (test seam)');
    // On Windows the line goes to cmd.exe VERBATIM (node-pty accepts a raw
    // command-line string as `args`): argv-style escaping would turn the
    // inner quotes into \" which cmd.exe does not understand.
    return process.platform === 'win32'
      ? { file: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: `/d /s /c "${override}"` }
      : { file: '/bin/sh', args: ['-c', override] };
  }
  if (a.mode === 'attach') {
    const st = readBotState(a.bot);
    const id = st && typeof st.bg_id === 'string' && /^[0-9a-f]{4,16}$/.test(st.bg_id) ? st.bg_id : null;
    if (!id) { console.error(`pty-host: ${a.bot} has no bg_id in ${path.join(STATE_DIR, `${a.bot}.json`)} (not running as a background session; the daemon starts it)`); process.exit(1); }
    const exe = resolveClaude();
    if (!fs.existsSync(exe)) { console.error(`pty-host: claude not found (${exe})`); process.exit(1); }
    // A .cmd shim needs a shell; the native exe does not. The id is ours
    // (hex, validated above), never user text.
    if (/\.cmd$/i.test(exe)) {
      return { file: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: `/d /s /c ""${exe}" attach ${id}"` };
    }
    return { file: exe, args: ['attach', id] };
  }
  const shell = resolveShell();
  const script = path.join(a.botcorp, 'daemon', 'launch.ps1');
  if (!fs.existsSync(script)) { console.error(`pty-host: ${script} not found`); process.exit(1); }
  if (!/pwsh\.exe$|powershell\.exe$/i.test(shell.file)) { console.error('pty-host: no PowerShell found to run launch.ps1'); process.exit(1); }
  return {
    file: shell.file,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Bot', a.bot, a.mode === 'fresh' ? '-Fresh' : '-Continue', '-InPty'],
  };
}

function host(a) {
  if (!NAME_RE.test(a.bot || '')) { console.error('pty-host: --bot <name> required (lowercase, digits, hyphens)'); process.exit(2); }
  if (!a.botcorp) { console.error('pty-host: --botcorp <BotCorp root> required'); process.exit(2); }
  a.botcorp = path.resolve(a.botcorp);
  const botHome = path.join(a.botcorp, 'bots', a.bot);
  if (!fs.existsSync(path.join(botHome, 'bot.yaml'))) { console.error(`pty-host: ${botHome}/bot.yaml not found`); process.exit(1); }

  const existing = readPtyJson(a.bot);
  if (existing && pidAlive(existing.pid)) {
    console.error(`pty-host: ${a.bot} already hosted by pid ${existing.pid} (port ${existing.port})`);
    process.exit(3);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const pty = require('node-pty');
  const cmd = buildCommand(a, botHome);
  const env = {
    ...process.env,
    BOT_NAME: a.bot,
    BOT_HOME: botHome,
    BOTCORP_HOME,
    BOTCORP_ROOT: a.botcorp,
  };
  // The supervisor is per config home: an attach must look where the daemon
  // launched (bots/<name>/.claude-<name>), never at the user's own ~/.claude.
  if (a.mode === 'attach') env.CLAUDE_CONFIG_DIR = path.join(botHome, `.claude-${a.bot}`);
  // A host started from inside a Claude Code session inherits its child-session
  // markers; the bot then runs with "Transcript saving is off" (CC 2.1.281),
  // which kills the transcript-mtime idle signal. See docs/cc-compat.md.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  const p = pty.spawn(cmd.file, cmd.args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: botHome, env });

  let buf = '';
  const clients = new Set();
  const startedAt = new Date().toISOString();
  const send = (ws, obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };

  p.onData((d) => {
    buf += d;
    if (buf.length > MAX_SCROLLBACK) {
      // Slice on a line boundary: cutting mid-line can split an ANSI sequence
      // or a multibyte char, and the first replayed frame was garbage until
      // the next full redraw.
      const cut = buf.length - MAX_SCROLLBACK;
      const nl = buf.indexOf('\n', cut);
      buf = nl >= 0 ? buf.slice(nl + 1) : buf.slice(cut);
    }
    for (const ws of clients) send(ws, { t: 'o', d });
  });

  const token = crypto.randomBytes(24).toString('hex');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 2 * MAX_INPUT_FRAME });

  wss.on('connection', (ws, req) => {
    let ok = false;
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const t = u.searchParams.get('token') || '';
      ok = t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
    } catch {}
    if (!ok) { try { ws.close(4401, 'bad token'); } catch {} return; }
    clients.add(ws);
    send(ws, { t: 'hello', pid: process.pid, ptyPid: p.pid, startedAt, mode: a.mode });
    if (buf) send(ws, { t: 'o', d: buf });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'i' && typeof msg.d === 'string') {
        if (msg.d.length > MAX_INPUT_FRAME) { send(ws, { t: 'err', m: 'input frame over 1 MB dropped' }); return; }
        try { p.write(msg.d); } catch {}
      } else if (msg.t === 'r' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols > 0 && msg.rows > 0 && msg.cols < 1000 && msg.rows < 1000) {
        try { p.resize(msg.cols, msg.rows); } catch {}
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  const file = ptyJsonPath(a.bot);
  const cleanup = () => { try { fs.unlinkSync(file); } catch {} };

  wss.on('listening', () => {
    const { port } = wss.address();
    const rec = { pid: process.pid, ptyPid: p.pid, port, token, startedAt, mode: a.mode };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    restrictToUser(file);
    console.log(`pty-host: ${a.bot} pid=${process.pid} ptyPid=${p.pid} ws=127.0.0.1:${port} mode=${a.mode}`);
  });

  p.onExit(({ exitCode }) => {
    console.log(`pty-host: ${a.bot} pty exited code=${exitCode}`);
    for (const ws of clients) send(ws, { t: 'exit', code: exitCode });
    cleanup();
    setTimeout(() => {
      for (const ws of clients) { try { ws.close(1000, 'pty exited'); } catch {} }
      try { wss.close(); } catch {}
      process.exit(0);
    }, 2000);
  });

  const onSignal = () => { cleanup(); treeKill(p.pid); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', cleanup);
}

const args = parseArgs(process.argv.slice(2));
if (args.stop) { stop(args.stop).then((c) => process.exit(c)); }
else host(args);
