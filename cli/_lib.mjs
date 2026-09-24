// _lib.mjs - shared plumbing for cli/botcorp.mjs: paths, bounded spawns,
// hidden prompts, pty-host state, bot.yaml round-trips.
//
// Rules every helper follows: `windowsHide: true` on every spawn, a timeout on
// every spawn, a secret only ever travels on STDIN (never argv), and anything
// a child printed is scrubbed of token shapes before it is echoed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const BOTCORP_HOME = process.env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp');
export const STATE_DIR = path.join(BOTCORP_HOME, 'state');
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const SENDER_RE = /^[0-9]{1,20}$/;

export function botHome(name) { return path.join(ROOT, 'bots', name); }
export function configDir(name) { return path.join(botHome(name), `.claude-${name}`); }
export function botYamlPath(name) { return path.join(botHome(name), 'bot.yaml'); }
export function botExists(name) { return NAME_RE.test(name || '') && fs.existsSync(botYamlPath(name)); }

export function listBots() {
  let entries = [];
  try { entries = fs.readdirSync(path.join(ROOT, 'bots'), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && NAME_RE.test(e.name) && fs.existsSync(botYamlPath(e.name)))
    .map((e) => e.name)
    .sort();
}

export class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
export function fail(message, code = 1) { throw new CliError(message, code); }
export function usage(message) { throw new CliError(message, 2); }

// ---- files ---------------------------------------------------------------------
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---- processes -----------------------------------------------------------------
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function firstInt(text) {
  const m = String(text || '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}

// Same token shapes the cockpit scrubs (cockpit/cli.mjs): belt and braces on
// top of the children's own masking.
const TOKEN_SHAPES = [
  /\b[0-9]{8,12}:AA[A-Za-z0-9_-]{33,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?!ant-)[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
];
export function scrub(text) {
  let t = String(text || '');
  for (const re of TOKEN_SHAPES) t = t.replace(re, '****');
  return t;
}

// Bounded synchronous spawn. Never throws; `{code, out, err, timedOut}`.
export function run(file, args, { stdin = null, timeoutMs = 60_000, env = null, cwd = ROOT } = {}) {
  const r = spawnSync(file, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input: stdin === null ? undefined : stdin,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const spawnErr = r.error && !timedOut ? String(r.error.message || r.error) : '';
  return {
    code: r.status === null || r.status === undefined ? -1 : r.status,
    out: scrub(r.stdout || ''),
    err: scrub((r.stderr || '') + (spawnErr ? `\n${spawnErr}` : '')),
    timedOut,
  };
}

let _pwsh = null;
// `pwsh` on PATH, else the WindowsApps alias, else Windows PowerShell 5.1.
export function resolvePwsh() {
  if (_pwsh) return _pwsh;
  if (process.platform !== 'win32') { _pwsh = 'pwsh'; return _pwsh; }
  const exeNames = ['pwsh.exe', 'pwsh'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of exeNames) {
      try { if (fs.statSync(path.join(dir, n)).isFile()) { _pwsh = path.join(dir, n); return _pwsh; } } catch {}
    }
  }
  const alias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe');
  if (process.env.LOCALAPPDATA && fs.existsSync(alias)) { _pwsh = alias; return _pwsh; }
  _pwsh = 'powershell';
  return _pwsh;
}

export function runPwshFile(script, args, opts = {}) {
  return run(resolvePwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], opts);
}

export function runPwshCommand(command, opts = {}) {
  return run(resolvePwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], opts);
}

// Same order as daemon/_common.ps1 Resolve-ClaudeExe: the native installer first (a stale
// npm shim can shadow it), then whatever `claude` is on PATH.
export function resolveClaude() {
  const native = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(native)) return native;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      try { if (fs.statSync(path.join(dir, n)).isFile()) return path.join(dir, n); } catch {}
    }
  }
  return native;
}

// A .cmd shim needs a shell; an .exe does not. Never `shell: true` with
// user-controlled args - the argv here is always ours.
export function runClaude(args, opts = {}) {
  const exe = resolveClaude();
  if (/\.cmd$/i.test(exe)) return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${exe}" ${args.join(' ')}`], opts);
  return run(exe, args, opts);
}

export function resolvePython() {
  for (const [file, pre] of [['python', []], ['python3', []], ['py', ['-3']]]) {
    const r = run(file, [...pre, '--version'], { timeoutMs: 15_000 });
    if (r.code === 0 && /Python 3/.test(r.out + r.err)) return { file, pre, version: (r.out + r.err).trim() };
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stdin / prompts ------------------------------------------------------------
export function stdinIsPiped() { return !process.stdin.isTTY; }

export function readStdinAll() {
  try { return fs.readFileSync(0, 'utf-8'); } catch { return ''; }
}

// Hidden prompt: echo is muted after the label is written. Returns '' on a
// closed/non-interactive stdin instead of hanging.
export function promptHidden(label) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(label);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(String(answer || '').trim()); });
  });
}

// Visible prompt (ids, checklist numbers - never a secret). '' when stdin is
// not a terminal, so a piped run never blocks.
export function promptVisible(label) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(label, (answer) => { rl.close(); resolve(String(answer || '').trim()); });
  });
}

// ---- pty-host state -----------------------------------------------------------
export function ptyJsonPath(bot) { return path.join(STATE_DIR, `${bot}.pty.json`); }

// The record is only meaningful while its host pid is alive.
export function ptyLive(bot) {
  const rec = readJson(ptyJsonPath(bot));
  if (!rec || !pidAlive(rec.pid)) return null;
  return rec;
}

export function ptyPublic(rec) {
  if (!rec) return null;
  const { token, ...rest } = rec;   // never print the attach token
  return rest;
}

// ---- bot.yaml round-trip ---------------------------------------------------------
export function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function loadRawYaml(bot) {
  const raw = yaml.load(fs.readFileSync(botYamlPath(bot), 'utf-8')) || {};
  if (!isObj(raw)) fail(`${botYamlPath(bot)}: top level must be a mapping`);
  return raw;
}

export function parseYaml(text) {
  const v = yaml.load(text) || {};
  if (!isObj(v)) fail('bot.yaml: top level must be a mapping');
  return v;
}

export function dumpYaml(obj) {
  return yaml.dump(obj, { lineWidth: 120, noRefs: true, sortKeys: false });
}

// Comments are lost on a round-trip (js-yaml keeps no comments); the docs say so.
export function writeRawYaml(bot, obj) {
  writeTextAtomic(botYamlPath(bot), dumpYaml(obj));
}

export function harnessVersion() {
  const pj = readJson(path.join(ROOT, 'harness', '.claude-plugin', 'plugin.json'));
  return pj && pj.version ? String(pj.version) : null;
}

export function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Detached, fire-and-forget child (the pty-host). Nothing is captured: the
// host writes its own state file, which is what the caller waits for.
export function spawnDetached(file, args, { cwd = ROOT, env = null } = {}) {
  const child = spawn(file, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}
