// engine.mjs - read-only version of the BotCorp checkout the cockpit serves.
// Updating is the daemon's job (it applies tags, runs migrations, rolls
// sessions at breakpoints); the cockpit only reports what is checked out.

import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { BOTCORP_ROOT } from './bots.mjs';

// git.exe is frequently NOT on the PATH inherited by a hidden node launched
// from a task; resolve a real git.exe once, else fall back to PATH.
const GIT_EXE = (() => {
  if (process.platform !== 'win32') return 'git';
  const cands = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Git', 'cmd', 'git.exe'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'git';
})();

function git(args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (code) => { if (!done) { done = true; resolve({ code, out: out.trim() }); } };
    let child;
    try { child = spawn(GIT_EXE, args, { cwd: BOTCORP_ROOT, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
    catch { return resolve({ code: -1, out: '' }); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(-2); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code ?? 0); });
  });
}

let cached = null;
export async function engineVersion() {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let version = null;
  try { version = JSON.parse(await fsp.readFile(path.join(BOTCORP_ROOT, 'botcorp.json'), 'utf-8')).version ?? null; } catch {}
  const sha = await git(['rev-parse', '--short', 'HEAD']);
  const value = { version, commit: sha.code === 0 ? sha.out : null };
  cached = { at: Date.now(), value };
  return value;
}
