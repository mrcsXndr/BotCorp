// Auto-commit uncommitted changes on session stop, and push them when the bot
// has a backup remote.
//
// Node, not bash (v0.9.13): on Windows every Git Bash start and every fork is
// seconds on a loaded box, and the bash version spent its 30 s budget on them
// (p95 28 s on a live bot) while the git work itself takes ~0.2 s.
//
// Module-gated (`auto_commit`). Only runs when the session is inside the bot's
// own home: BOT_HOME/BOT_NAME as the LAUNCHER set them (a `bots/<name>` folder),
// the session cwd is inside that folder, and the folder is itself the root of a
// git work tree whose origin is NOT the shared BotCorp checkout. A bot must never
// auto-commit into the harness repo everyone shares, and a `--plugin-dir` smoke
// run from some other repo must never commit there either (it did: the Stop hook
// landed checkpoint commits in whatever repo the session happened to sit in).
// Never skips hooks: the bot repo's own pre-commit secret scan (if any) must run
// like any other commit.
//
// Push: only with the `backup` module (bot.yaml backup.git_remote set, which puts
// `backup` in BOT_MODULES), only from the bot folder's OWN repo (a .git in
// BOT_HOME, never a checkout above it) and only to an origin that already exists
// (`botcorp backup <bot>` adds it). Detached + non-interactive + 60 s bound, so a
// credential prompt (session 0 has no credential UI) can never hang the Stop
// hook. It runs on a clean tree too, so a failed push is retried on the next
// stop. One line per attempt in <BOTCORP_HOME>/state/<bot>/push.log.
//
//   node auto-commit.mjs            the Stop hook (run.mjs runs it without bash)
//   node auto-commit.mjs --push <home> <branch> <ahead> <log>   internal: the detached push

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const env = process.env;
const git = (cwd, args, extra = {}) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', windowsHide: true, timeout: 20_000, ...extra });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : null);

function push([home, branch, ahead, log]) {
  const r = git(home, ['-c', 'credential.interactive=never', 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`],
    { stdio: 'ignore', timeout: 60_000, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  const rc = r.error && r.error.code === 'ETIMEDOUT' ? 124 : (r.status ?? 1);
  try {
    fs.appendFileSync(log, `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} push ${branch} ahead=${ahead} rc=${rc}\n`);
    const lines = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > 1000) fs.writeFileSync(log, `${lines.slice(-500).join('\n')}\n`);
  } catch {}
}

function main() {
  // The opt-out gates run.mjs applies, again here for a direct run (as _guard.sh did).
  if (`,${env.BOT_DISABLED_HOOKS || ''},`.includes(',auto-commit,')) return;
  if (env.BOT_MODULES !== undefined && !`,${env.BOT_MODULES},`.includes(',auto_commit,') && !`,${env.BOT_MODULES},`.includes(',*,')) return;

  const sessionCwd = env.CLAUDE_PROJECT_DIR || process.cwd();
  const home = env.BOT_HOME || '';
  const name = env.BOT_NAME || '';
  if (!home || !name) return;
  if (!home.replace(/\\/g, '/').replace(/\/+$/, '').endsWith(`/bots/${name}`)) return;

  // Both must resolve to the same git work tree, and that tree's root must be the
  // bot home itself (--show-prefix empty), not a parent repo the folder sits in.
  const homeTop = out(git(home, ['rev-parse', '--show-toplevel']));
  const cwdTop = out(git(sessionCwd, ['rev-parse', '--show-toplevel']));
  const homePrefix = out(git(home, ['rev-parse', '--show-prefix']));
  if (!homeTop || homeTop !== cwdTop || homePrefix !== '') return;

  const origin = out(git(home, ['remote', 'get-url', 'origin'])) || '';
  if (/\/BotCorp(\.git)?$/.test(origin)) return;

  // At most one checkpoint per BOT_AUTO_COMMIT_EVERY_MIN, never for memory/metrics/
  // churn alone (harness/tools/infra/commit_gate.cjs, v0.8.6 R13).
  const gate = createRequire(import.meta.url)('../tools/infra/commit_gate.cjs');
  const marker = 'chore(auto): session checkpoint';
  if (gate.decide({ paths: gate.changedPaths(home), sinceMin: gate.minutesSince(home, marker), everyMin: gate.everyMin(env) }).commit) {
    git(home, ['add', '-A'], { timeout: 60_000 });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    git(home, ['commit', '-m', `${marker} ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`], { stdio: 'ignore', timeout: 60_000 });
  }

  if (!`,${env.BOT_MODULES || ''},`.includes(',backup,')) return;
  if (!fs.existsSync(path.join(home, '.git'))) return;
  if (!origin) return;
  const branch = out(git(home, ['symbolic-ref', '-q', '--short', 'HEAD']));
  if (!branch) return;
  const ahead = Number(out(git(home, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])) || 0);
  if (!(ahead > 0)) return;

  const dir = path.join(env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp'), 'state', name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const child = spawn(process.execPath, [HERE, '--push', home, branch, String(ahead), path.join(dir, 'push.log')],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd: home });
  child.unref();
}

try {
  if (process.argv[2] === '--push') push(process.argv.slice(3));
  else main();
} catch {}
process.exit(0);
