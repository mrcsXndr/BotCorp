// observe.mjs - what a bot's session is doing right now, measured from the
// processes and Claude Code's own files, never read back from a status field.
// `botcorp observe` prints it; the daemon tick persists it as `observed` in
// state/<bot>.json; every reader derives its phase from it (core/state.mjs).
//
// One record per bot: { bot, alive, activity, phase, poller, bg_id, blocked,
// awaiting_prompt, at, kind, claude_pid, session_id, quiet_s } (`phase`:
// core/state.mjs, from this measurement and the state file). `activity` is one of ACTIVITIES:
//   down     no live claude (bg) or pty-host process
//   blocked  the session waits on something nothing unattended answers
//            (bgBlockVerdict FAIL: a login, a usage limit, trust). A WARN (its
//            last turn ended asking something) is still carried in `blocked`
//            for display, but the activity comes from the transcript: the
//            session takes its next prompt.
//   working  the transcript moved within QUIET_MIN and no fresh breakpoint
//   idle     a fresh breakpoint (<BotHome>/.claude/.botcorp_breakpoint), or
//            the transcript quiet >= QUIET_MIN
//   unknown  alive, but nothing tells (no transcript, no roster row); a gate
//            treats it as busy
// These are daemon/_common.ps1 Test-SessionBusy's semantics: working and
// unknown are busy, idle is idle.
// `awaiting_prompt` (bg only) is the job record saying the session waits for
// its next prompt right now: tempo 'blocked' on "send a prompt to start", its
// last turn done with nothing in flight (turnEnded), or a bgBlockVerdict WARN;
// never a FAIL. The inbox delivers on it at once; it does
// not touch activity, so the restart and update gates keep the quiet rule.
//
// Read-only. The roster (`claude agents --json`) is opt-in ({ roster: true },
// `--roster`): the call writes the config home's .claude.json, and only a
// caller holding the launch's token (the daemon task) sees the rows. It fills
// in what the files cannot: a worker the supervisor restarted under a new pid,
// and the session's state when there is no transcript.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, configDir, readJson, pidAlive, firstInt, botLiveness, processParents, bgJobFile, bgBlockVerdict, runClaude } from '../cli/_lib.mjs';
import { botHome } from './paths.mjs';
import { phase } from './state.mjs';
import { loadBotYaml } from '../daemon/botyaml.mjs';

export const ACTIVITIES = ['idle', 'working', 'blocked', 'down', 'unknown'];
export const QUIET_MIN = 5;

// Claude Code names a project dir by replacing every non-alphanumeric char of
// the absolute cwd with '-' (no drive-letter special case).
function projectSlug(absPath) { return String(absPath).replace(/[^A-Za-z0-9]/g, '-'); }

// ms since the newest *.jsonl under the bot's project dir, RECURSIVE (subagents
// write <session>/subagents/**/agent-*.jsonl while the main transcript is quiet);
// null = no transcript.
export function transcriptQuietMs(name, now = Date.now()) {
  const dir = path.join(configDir(name), 'projects', projectSlug(botHome(name)));
  let newest = 0;
  let files = [];
  try { files = fs.readdirSync(dir, { recursive: true }); } catch { return null; }
  for (const f of files) {
    if (!String(f).endsWith('.jsonl')) continue;
    try { const m = fs.statSync(path.join(dir, String(f))).mtimeMs; if (m > newest) newest = m; } catch {}
  }
  return newest ? Math.max(0, now - newest) : null;
}

export function breakpointFresh(name, now = Date.now()) {
  const ttl = Number(process.env.BOT_BREAKPOINT_TTL_MIN) || 30;
  try { return now - fs.statSync(path.join(botHome(name), '.claude', '.botcorp_breakpoint')).mtimeMs < ttl * 60_000; } catch { return false; }
}

// The roster rows for this bot's config home, or null when the query failed.
export function bgRoster(name) {
  const r = runClaude(['agents', '--json'], { timeoutMs: 30_000, env: { CLAUDE_CONFIG_DIR: configDir(name) }, cwd: botHome(name) });
  if (r.code !== 0) return null;
  const i = r.out.indexOf('['); const j = r.out.lastIndexOf(']');
  if (i < 0 || j < i) return [];
  try { const rows = JSON.parse(r.out.slice(i, j + 1)); return Array.isArray(rows) ? rows.filter(Boolean) : null; } catch { return null; }
}

// daemon/_common.ps1 Find-BgAgent: by short id, then session id, then a background row whose cwd is the bot folder.
export function findBgRow(rows, { bgId = '', sessionId = '', home = '' }) {
  if (!Array.isArray(rows)) return null;
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  return rows.find((r) => bgId && String(r.id) === bgId)
    || rows.find((r) => sessionId && String(r.sessionId) === sessionId)
    || rows.find((r) => home && r.kind === 'background' && norm(r.cwd) === norm(home))
    || null;
}

// activity from what was measured (pure, the tests drive it directly)
export function activityOf({ alive, blocked = null, breakpoint = false, quietMs = null, rosterState = '' }) {
  if (!alive) return 'down';
  if (blocked) return 'blocked';
  if (breakpoint) return 'idle';
  if (quietMs !== null) return quietMs < QUIET_MIN * 60_000 ? 'working' : 'idle';
  if (rosterState === 'working') return 'working';
  if (rosterState === 'idle') return 'idle';
  return 'unknown';
}

// The job record says the last turn is over and nothing runs on (no background
// task, nothing queued), and the transcript has not moved since it said so (a
// turn a monitor or cron started lands in the transcript before the record).
export const TURN_SETTLE_MS = 5_000;
export function turnEnded(job, quietMs, now = Date.now()) {
  if (!job || job.state !== 'done' || job.tempo !== 'idle') return false;
  const f = job.inFlight || {};
  if (Number(f.tasks) || Number(f.queued)) return false;
  const at = Date.parse(job.updatedAt);
  if (!Number.isFinite(at)) return false;
  return quietMs === null || now - quietMs <= at + TURN_SETTLE_MS;
}

export function ptyOf(name) {
  const rec = readJson(path.join(STATE_DIR, `${name}.pty.json`));
  if (!rec || !Number.isInteger(rec.port) || typeof rec.token !== 'string' || !pidAlive(rec.pid)) return null;
  return rec;
}

export function observeBot(name, { roster = false, parents = processParents } = {}) {
  let cfg = null;
  try { cfg = loadBotYaml(path.join(botHome(name), 'bot.yaml')); } catch {}
  const kind = cfg && cfg.harness && cfg.harness.session === 'pty' ? 'pty' : 'bg';
  const telegram = !!(cfg && cfg.harness && cfg.harness.modules && cfg.harness.modules.telegram);
  const state = readJson(path.join(STATE_DIR, `${name}.json`));
  const pty = ptyOf(name);
  const cfgDir = configDir(name);
  let botPid = 0;
  try { botPid = firstInt(fs.readFileSync(path.join(cfgDir, 'channels', 'telegram', 'bot.pid'), 'utf-8')); } catch {}

  let bgId = state && state.bg_id != null ? String(state.bg_id) : '';
  let sessionId = state && state.session_id ? String(state.session_id) : '';
  let claudePid = state ? Number(state.claude_pid) || 0 : 0;
  let rosterState = '';
  if (roster && kind === 'bg') {
    const row = findBgRow(bgRoster(name), { bgId, sessionId, home: botHome(name) });
    if (row) {
      rosterState = String(row.state || '');
      // a worker the supervisor restarted under a new pid: the roster knows it before the state file does
      if (!pidAlive(claudePid) && pidAlive(Number(row.pid))) {
        claudePid = Number(row.pid);
        if (row.id) bgId = String(row.id);
        if (row.sessionId) sessionId = String(row.sessionId);
      }
    }
  }

  const measured = { ...(state || {}), claude_pid: claudePid };
  const live = botLiveness({ pty, state: measured, telegram, botPid, parents });
  const alive = live.alive;
  const now = Date.now();
  const quietMs = alive ? transcriptQuietMs(name, now) : null;
  let blocked = null;
  let awaitingPrompt = false;
  if (alive && kind === 'bg') {
    const jobFile = bgJobFile(cfgDir, bgId);
    const job = jobFile ? readJson(jobFile) : null;
    const v = bgBlockVerdict({ running: true, bgId, job });
    if (v.level === 'FAIL' || v.level === 'WARN') blocked = { level: v.level, needs: String(job.needs).trim() };
    awaitingPrompt = v.level === 'WARN' || (v.level === 'PASS' && (
      (job.tempo === 'blocked' && String(job.needs || '').includes('send a prompt to start')) || turnEnded(job, quietMs, now)));
  }
  const activity = activityOf({ alive, blocked: !!blocked && blocked.level === 'FAIL', breakpoint: alive && breakpointFresh(name, now), quietMs, rosterState });
  return {
    bot: name,
    alive,
    activity,
    phase: phase(state, { alive, activity }, now),
    poller: live.poller,
    bg_id: kind === 'bg' && bgId ? bgId : null,
    blocked,
    awaiting_prompt: awaitingPrompt,
    at: new Date(now).toISOString(),
    kind,
    claude_pid: live.claudeAlive ? claudePid : null,
    session_id: sessionId || null,
    quiet_s: quietMs === null ? null : Math.round(quietMs / 1000),
  };
}

// One process-tree query shared by every bot of an --all run.
export function observeAll(names, { roster = false } = {}) {
  let tree;
  const parents = () => (tree === undefined ? (tree = processParents()) : tree);
  return names.map((n) => observeBot(n, { roster, parents }));
}
