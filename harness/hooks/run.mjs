// run.mjs - how hooks.json starts every bash hook (v0.8.6 R5):
//
//   node run.mjs <hook-name> <module|-> <script.sh> [args...]
//
// Claude Code runs a shell-form hook as `bash -c '<command>'`, so `bash x.sh`
// cost two Git Bash starts, and a hook switched off in bot.yaml still paid both
// before _guard.sh let it exit. Here (exec form, no shell) the opt-out gates
// run first, in node: a hook named in BOT_DISABLED_HOOKS, or gated on a module
// missing from BOT_MODULES (unset = every module; `*` = every module), exits 0
// without spawning anything. Otherwise ONE bash runs the script with this
// process's stdin/stdout/stderr and its exit code is passed through. The
// script still sources _guard.sh (the same gates again, the paths, PY).
//
// BOT_HOOK_TRACE=1: the trace line is written here, before the gates, and not
// again by _guard.sh.
//
// Every run that spawns is timed into state/<bot>/hooks-timing.jsonl
// (_timing.mjs). The script gets this hook's hooks.json timeout less 1 s, so a
// run about to be cancelled by Claude Code is killed here first and recorded
// as timed_out (exit 1: Claude Code ignores the output of a failed hook, as it
// does a cancelled one's).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordTiming } from './_timing.mjs';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const [name = '', mod = '-', script = '', ...args] = process.argv.slice(2);
const env = { ...process.env };

if (env.BOT_HOOK_TRACE === '1') {
  try {
    const dir = path.join(env.BOT_HOME || env.CLAUDE_PROJECT_DIR || process.cwd(), 'memory', 'metrics');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-trace.log'), `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} ${name}\n`);
  } catch {}
  delete env.BOT_HOOK_TRACE;
}
if (`,${env.BOT_DISABLED_HOOKS || ''},`.includes(`,${name},`)) process.exit(0);
if (mod !== '-' && env.BOT_MODULES !== undefined) {
  const on = `,${env.BOT_MODULES},`;
  if (!on.includes(`,${mod},`) && !on.includes(',*,')) process.exit(0);
}

// Git for Windows' bash, as Claude Code finds it (System32\bash.exe is WSL).
// Preferred: Git's real <Git>\usr\bin\bash.exe with --noprofile --norc and the
// environment Git's bin\bash.exe launcher would set up (MSYSTEM, mingw64\bin and
// usr\bin first on PATH, so the scripts still find git and the coreutils). That
// skips the launcher process and any profile. Fallback: the launcher itself.
function bash() {
  if (process.platform !== 'win32') return ['bash', []];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const override = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const m = override && /^(.*?)[\\/](?:usr[\\/])?bin[\\/]bash\.exe$/i.exec(override);
  const root = m ? m[1] : path.join(pf, 'Git');
  const real = path.join(root, 'usr', 'bin', 'bash.exe');
  if ((!override || m) && fs.existsSync(real)) {
    const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pk] = [path.join(root, 'mingw64', 'bin'), path.join(root, 'usr', 'bin'), env[pk]].filter(Boolean).join(';');
    env.MSYSTEM = env.MSYSTEM || 'MINGW64';
    return [real, ['--noprofile', '--norc']];
  }
  for (const c of [override, path.join(pf, 'Git', 'bin', 'bash.exe')]) {
    if (c && fs.existsSync(c)) return [c, []];
  }
  return ['bash.exe', []];
}

// this hook's timeout in hooks.json (seconds), 0 = not found
function hookTimeout() {
  try {
    for (const groups of Object.values(JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf-8')).hooks)) {
      for (const g of groups) for (const h of g.hooks) if (Array.isArray(h.args) && h.args[1] === name && h.args[3] === script) return Number(h.timeout) || 0;
    }
  } catch {}
  return 0;
}

const [exe, pre] = bash();
const t = hookTimeout();
const budget = t > 0 ? Math.max(1000, Math.floor(t * 1000 - 1000 - performance.now())) : undefined;
const r = spawnSync(exe, [...pre, path.resolve(HOOKS_DIR, script), ...args], { stdio: 'inherit', env, windowsHide: true, timeout: budget });
const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
recordTiming(name, performance.now(), r.status, timedOut);
process.exit(r.status ?? 1);
