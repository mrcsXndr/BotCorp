#!/usr/bin/env node
/**
 * Memory Sync Hook
 *
 * Auto-syncs the bot's `memory/` directory across machines via the bot's own
 * git repo.
 *
 * - **UserPromptSubmit**: pull-rebase from origin/main if remote is ahead.
 *   Catches up the local memory before the user's next turn.
 * - **Stop / SubagentStop**: if memory has uncommitted changes, commit + pull --rebase + push.
 *   Always pulls before pushing — never force-pushes, never overwrites remote.
 *   Retries push once if rejected (someone else pushed in between).
 *   On rebase conflict: aborts the rebase (working tree stays clean), writes
 *   `MEMORY_SYNC_CONFLICT.md` at the repo root as a flag for the next session,
 *   exits with a clear error so the bot can resolve it manually.
 *
 * **Bot-home aware**: the repo synced is process.env.BOT_HOME (falls back to
 * CLAUDE_PROJECT_DIR, then cwd) — never this script's own location, since the
 * harness is shared by every bot instance on the box. Only fires when BOT_HOME
 * is actually a git repo whose origin is the bot's own remote (never a shared
 * BotCorp/harness checkout — see the origin guard below).
 *
 * **Safe by design**:
 * - Never force-pushes
 * - Always pulls --rebase before push
 * - Conflicts leave the working tree clean (rebase --abort)
 * - Conflicts produce a flag file for human/bot resolution
 * - Single retry on push rejection
 * - All output goes to stderr to avoid polluting tool output
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function botHome() {
  return process.env.BOT_HOME || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const MEMORY_DIR_NAME = 'memory';
const REMOTE = 'origin';
const BRANCH = 'main';

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return {};
  }
}

function git(repoDir, cmd, opts = {}) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

/**
 * Try a git command. Returns { ok, output, error? }.
 * Use this when you need to know success/failure — empty stdout is NOT failure.
 */
function gitTry(repoDir, cmd) {
  try {
    return { ok: true, output: git(repoDir, cmd) };
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    return { ok: false, error: e.message, stderr };
  }
}

/**
 * Run a git command, return its stdout, or null if it threw.
 * Only use when you actually need the stdout content.
 */
function gitSilent(repoDir, cmd) {
  try {
    return git(repoDir, cmd);
  } catch {
    return null;
  }
}

function log(msg) {
  process.stderr.write(`[memory-sync] ${msg}\n`);
}

function hasMemoryChanges(repoDir) {
  const status = gitSilent(repoDir, `status --porcelain ${MEMORY_DIR_NAME}/`);
  return status && status.trim().length > 0;
}

function writeConflictFlag(repoDir, reason) {
  const ts = new Date().toISOString();
  const content = `# Memory Sync Conflict

A \`git pull --rebase\` failed at ${ts}.

**Reason**: ${reason}

## Resolve manually

\`\`\`bash
cd ${repoDir}
git fetch origin
git pull --rebase
# Resolve any conflicts in memory/ files
git add memory/
git rebase --continue
git push origin main
rm MEMORY_SYNC_CONFLICT.md
\`\`\`

## Or ask the bot to resolve

In the next Claude Code session, say something like:
"there's a memory sync conflict, please resolve it"

The bot will read both versions of the conflicting files and produce a merged
version that preserves both sides' content.
`;
  fs.writeFileSync(path.join(repoDir, 'MEMORY_SYNC_CONFLICT.md'), content);
}

/**
 * Fetch remote and rebase if remote is ahead.
 * Returns: { ok, action, error? }
 */
function safePullRebase(repoDir) {
  const conflictFlag = path.join(repoDir, 'MEMORY_SYNC_CONFLICT.md');
  // If a conflict is already pending, don't try
  if (fs.existsSync(conflictFlag)) {
    return { ok: false, action: 'conflict-pending' };
  }

  const fetchResult = gitTry(repoDir, `fetch ${REMOTE} ${BRANCH}`);
  if (!fetchResult.ok) {
    return { ok: true, action: 'fetch-failed-skip' };
  }

  const local = gitSilent(repoDir, 'rev-parse HEAD')?.trim();
  const remote = gitSilent(repoDir, `rev-parse ${REMOTE}/${BRANCH}`)?.trim();
  if (!local || !remote) {
    return { ok: true, action: 'no-refs-skip' };
  }
  if (local === remote) {
    return { ok: true, action: 'in-sync' };
  }

  // Remote is ahead — try to rebase
  try {
    git(repoDir, `pull --rebase --autostash ${REMOTE} ${BRANCH}`);
    return { ok: true, action: 'rebased' };
  } catch (e) {
    // Conflict — abort and flag it
    // `--autostash` is restored automatically by `rebase --abort`; do NOT
    // `stash pop` here — with no rebase-created autostash entry that would pop
    // an unrelated pre-existing stash and silently mutate the working tree.
    gitSilent(repoDir, 'rebase --abort');
    writeConflictFlag(repoDir, `pull --rebase failed: ${(e.stderr || e.message || '').toString().slice(0, 500)}`);
    return { ok: false, action: 'conflict', error: e.message };
  }
}

/**
 * Commit and push memory changes. Always pulls first to avoid overwrite.
 * Returns: { ok, action, error? }
 */
function commitAndPush(repoDir, message) {
  if (!hasMemoryChanges(repoDir)) {
    return { ok: true, action: 'no-changes' };
  }

  // Stage memory changes
  const addResult = gitTry(repoDir, `add ${MEMORY_DIR_NAME}/`);
  if (!addResult.ok) {
    return { ok: false, action: 'stage-failed', error: addResult.error };
  }

  // If nothing to commit (e.g. only ignored or whitespace), bail
  const cached = gitSilent(repoDir, 'diff --cached --name-only');
  if (!cached || !cached.trim()) {
    return { ok: true, action: 'no-staged-changes' };
  }

  // Commit — a generic bot identity, not tied to any real git user
  try {
    git(
      repoDir,
      `-c user.email="bot@localhost" -c user.name="bot" commit -m "${message.replace(/"/g, '\\"')}"`
    );
  } catch (e) {
    return { ok: false, action: 'commit-failed', error: e.message };
  }

  // Pull --rebase (always, before push)
  const pullResult = safePullRebase(repoDir);
  if (!pullResult.ok) {
    return pullResult;
  }

  // Push
  try {
    git(repoDir, `push ${REMOTE} ${BRANCH}`);
    return { ok: true, action: 'pushed' };
  } catch (e) {
    // Push rejected — pull again and retry once
    const pull2 = safePullRebase(repoDir);
    if (!pull2.ok) return pull2;
    try {
      git(repoDir, `push ${REMOTE} ${BRANCH}`);
      return { ok: true, action: 'pushed-retry' };
    } catch (e2) {
      return { ok: false, action: 'push-failed', error: e2.message };
    }
  }
}

// A shared BotCorp/harness checkout must never be pushed to as if it were a
// bot's own memory repo — that would mix every bot's memory into one remote.
// Refuse (log-only, fail-open) unless BOT_HOME's origin looks like the bot's
// own repo, i.e. it does NOT point at the BotCorp template itself.
function originIsForeignBotCorp(repoDir) {
  const url = gitSilent(repoDir, 'remote get-url origin');
  if (!url) return false;
  return /\/BotCorp(\.git)?$/i.test(url.trim());
}

// === Main ===

const input = readInput();
const REPO_DIR = botHome();

if (!fs.existsSync(REPO_DIR) || !fs.existsSync(path.join(REPO_DIR, '.git'))) {
  // Not a git repo — nothing to sync, silently exit.
  process.exit(0);
}

if (originIsForeignBotCorp(REPO_DIR)) {
  log(`refusing to sync memory into the BotCorp template remote (BOT_HOME=${REPO_DIR})`);
  process.exit(0);
}

const event = input.hook_event_name || '';

try {
  if (event === 'UserPromptSubmit' || event === 'SessionStart') {
    const result = safePullRebase(REPO_DIR);
    log(`pull: ${result.action}${result.error ? ' — ' + result.error.slice(0, 200) : ''}`);
  } else if (event === 'Stop' || event === 'SubagentStop') {
    const sessionShort = (input.session_id || '').slice(0, 8) || 'unknown';
    const result = commitAndPush(REPO_DIR, `auto: memory sync from session ${sessionShort}`);
    log(`push: ${result.action}${result.error ? ' — ' + result.error.slice(0, 200) : ''}`);
  } else {
    // Unknown event — no-op
  }
} catch (e) {
  log(`unexpected error: ${e.message}`);
}

// Always exit 0 — never block the user even on sync failure
process.exit(0);
