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

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
function bash() {
  if (process.platform !== 'win32') return 'bash';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  for (const c of [process.env.CLAUDE_CODE_GIT_BASH_PATH, path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(pf, 'Git', 'usr', 'bin', 'bash.exe')]) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'bash.exe';
}

const r = spawnSync(bash(), [path.resolve(HOOKS_DIR, script), ...args], { stdio: 'inherit', env, windowsHide: true });
process.exit(r.status ?? 1);
