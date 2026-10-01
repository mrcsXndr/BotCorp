// commit_gate.cjs - when a Stop hook may commit the bot folder (v0.8.6 R13).
//
// The two committers (harness/hooks/auto-commit.mjs "chore(auto): session checkpoint",
// harness/tools/infra/memory-sync-hook.cjs "auto: memory sync") ran on every Stop: 373
// commits in 4 days on one bot, most of them runtime state. Now each commits
//   - only when something OTHER than churn changed: memory/metrics/ is runtime
//     state machine-written on every turn (sessions.csv, usage and hub state,
//     the unanswered counter, alerts.log); it rides along with the next real
//     commit and never causes one on its own;
//   - at most once per BOT_AUTO_COMMIT_EVERY_MIN minutes (default 60), measured
//     from that committer's own last commit in `git log`. A change made inside
//     the window waits in the work tree for the first Stop after it.
// Nothing is dropped: the work tree keeps every change until it is committed.

const { spawnSync } = require('child_process');

const CHURN = ['memory/metrics/'];
const DEFAULT_EVERY_MIN = 60;

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
}

// Changed paths (repo-relative, forward slashes) from `git status --porcelain -z`;
// a rename or copy also lists its source. null when git failed. Every untracked
// file is listed, never a collapsed `memory/` that would hide churn inside it.
function changedPaths(repo, pathspec = []) {
  const r = git(repo, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...pathspec]);
  if (r.status !== 0) return null;
  const f = r.stdout.split('\0');
  const out = [];
  for (let i = 0; i < f.length; i++) {
    const e = f[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2)) && f[i + 1]) out.push(f[++i]);
  }
  return out;
}

const isChurn = (p) => CHURN.some((c) => p === c.slice(0, -1) || p.startsWith(c));
const realChanges = (paths) => (paths || []).filter((p) => !isChurn(p));

function everyMin(env = process.env) {
  const raw = String(env.BOT_AUTO_COMMIT_EVERY_MIN ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_EVERY_MIN;
}

// Minutes since the newest commit whose message contains `marker`; Infinity when none.
function minutesSince(repo, marker, now = Date.now()) {
  const r = git(repo, ['log', '-1', '--format=%ct', '--fixed-strings', `--grep=${marker}`]);
  const t = Number((r.stdout || '').trim());
  return r.status === 0 && t > 0 ? (now / 1000 - t) / 60 : Infinity;
}

// {commit, why}: the one decision both committers make.
function decide({ paths, sinceMin, everyMin: every }) {
  if (paths === null) return { commit: false, why: 'git status failed' };
  const real = realChanges(paths);
  if (!paths.length) return { commit: false, why: 'clean' };
  if (!real.length) return { commit: false, why: `only churn changed (${paths.length} path(s) under ${CHURN.join(', ')})` };
  if (sinceMin < every) return { commit: false, why: `last auto commit ${Math.floor(sinceMin)} min ago (< ${every}); ${real.length} change(s) wait` };
  return { commit: true, why: `${real.length} change(s)` };
}

module.exports = { CHURN, DEFAULT_EVERY_MIN, changedPaths, realChanges, everyMin, minutesSince, decide };

// CLI (auto-commit.mjs requires the module instead): `node commit_gate.cjs <repo> <marker>` prints
// the reason; exit 0 = commit now, 1 = not now.
if (require.main === module) {
  const [repo, marker] = process.argv.slice(2);
  const d = decide({ paths: changedPaths(repo), sinceMin: minutesSince(repo, marker), everyMin: everyMin() });
  process.stdout.write(`${d.why}\n`);
  process.exit(d.commit ? 0 : 1);
}
