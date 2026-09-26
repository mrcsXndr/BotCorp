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
import { botsDir, botHome } from '../core/paths.mjs';
import { stateView } from '../core/state.mjs';

export { botHome };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const BOTCORP_HOME = process.env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp');
export const STATE_DIR = path.join(BOTCORP_HOME, 'state');
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const SENDER_RE = /^[0-9]{1,20}$/;

export function configDir(name) { return path.join(botHome(name), `.claude-${name}`); }
export function botYamlPath(name) { return path.join(botHome(name), 'bot.yaml'); }
export function botExists(name) { return NAME_RE.test(name || '') && fs.existsSync(botYamlPath(name)); }

export function listBots() {
  let entries = [];
  try { entries = fs.readdirSync(botsDir(), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && NAME_RE.test(e.name) && fs.existsSync(botYamlPath(e.name)))
    .map((e) => e.name)
    .sort();
}

// The shipped '_' fixture folders holding a bot.yaml (bots/_example, bots/_canary):
// never supervised, only validated by doctor.
export function listFixtureBots() {
  let entries = [];
  try { entries = fs.readdirSync(botsDir(), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('_') && fs.existsSync(botYamlPath(e.name)))
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

// pid -> parent pid for every process, or null when the query failed (the
// caller then cannot tell, which is not the same as "dead").
const PARENTS_PWSH = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
function parseParents(out) {
  const parents = new Map();
  for (const line of String(out).split(/\r?\n/)) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p > 0 && Number.isInteger(pp)) parents.set(p, pp);
  }
  return parents.size ? parents : null;
}
export function processParents() {
  const r = process.platform === 'win32'
    ? runPwshCommand(PARENTS_PWSH, { timeoutMs: 60_000 })
    : run('ps', ['-e', '-o', 'pid=,ppid='], { timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  return parseParents(r.out);
}
// The same query without blocking the event loop (the cockpit server).
export function processParentsAsync({ timeoutMs = 60_000 } = {}) {
  const [file, args] = process.platform === 'win32'
    ? [resolvePwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PARENTS_PWSH]]
    : ['ps', ['-e', '-o', 'pid=,ppid=']];
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(file, args, { windowsHide: true, timeout: timeoutMs }); } catch { resolve(null); return; }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? parseParents(out) : null));
  });
}

// Is `pid` `ancestor` itself or below it in `parents` (a Map or a plain object)?
export function isDescendant(parents, pid, ancestor, maxDepth = 12) {
  if (!parents || !(pid > 0) || !(ancestor > 0)) return false;
  const get = (k) => (parents instanceof Map ? parents.get(k) : parents[k]);
  let cur = pid;
  for (let i = 0; i <= maxDepth && cur > 4; i++) {
    if (cur === ancestor) return true;
    const next = Number(get(cur));
    if (!(next > 0) || next === cur) return false;
    cur = next;
  }
  return false;
}

// The Telegram poller as `status` / `doctor` report it. The plugin writes
// channels/telegram/bot.pid (its bun server pid) only AFTER its token check,
// so OWNED needs that pid alive AND below this bot's claude (bg) or pty root.
// The launcher's own record ('OWNED') is an intent, not a measurement: a bg
// session that inherited a daemon without the token has it too. A bot that
// launched without --channels keeps FOREIGN (someone else owns the lock), a
// bot without the telegram module keeps what was recorded (NONE).
//   underClaude: true / false, or null when the process tree was unreadable
export function pollerVerdict({ alive, telegram, recorded = null, botPid = 0, botPidAlive = false, underClaude = null }) {
  if (!alive) return botPidAlive ? 'ORPHAN' : 'none';
  if (!telegram || recorded === 'FOREIGN' || recorded === 'NONE') return recorded;
  if (!(botPid > 0) || !botPidAlive) return 'DEAD';
  if (underClaude === null) return 'UNKNOWN';
  return underClaude ? 'OWNED' : 'DEAD';
}

// `status` / `doctor` / the cockpit: is the bot's session alive, and does it
// own its Telegram poller. Measured, never read back from the state file: a bg
// bot whose claude worker died leaves `poller: OWNED` behind, so the poller is
// only reported while a claude (bg) or pty process is actually alive; a live
// bun poller with no claude is an orphan. `parents` (a Map, or a function
// returning one) is only consulted when the answer depends on the process tree;
// without it that answer is UNKNOWN.
export function botLiveness({ pty = null, state = null, telegram = false, botPid = 0, parents = null }) {
  const claudeAlive = !!(state && pidAlive(Number(state.claude_pid)));
  const alive = Boolean(pty) || claudeAlive;
  const botPidAlive = pidAlive(botPid);
  let underClaude = null;
  if (alive && telegram && botPidAlive) {
    const tree = typeof parents === 'function' ? parents() : parents;
    const root = claudeAlive ? Number(state.claude_pid) : Number(pty && pty.ptyPid);
    if (tree) underClaude = isDescendant(tree, botPid, root);
  }
  const poller = pollerVerdict({ alive, telegram, recorded: (state && state.poller) ?? null, botPid, botPidAlive, underClaude });
  return { alive, claudeAlive, botPidAlive, poller };
}

// Resolve the command the Telegram plugin's .mcp.json runs (a bare `bun`) the
// way launch.ps1 does (Resolve-BunExe): for bun, harness.bun_path (when it is
// a file) > PATH > <userProfile>/.bun/bin; any other bare name, PATH only; an
// absolute path, itself. -> { path, source } (path '' = does not resolve).
export function resolvePluginCommand({ command, override = '', pathEnv = '', userProfile = '', platform = process.platform, exists = (p) => fs.existsSync(p) }) {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const join = (a, b) => (win ? path.win32.join(a, b) : path.posix.join(a, b));
  if (!command) return { path: '', source: '' };
  if (/[\\/]/.test(command)) return exists(command) ? { path: command, source: 'absolute' } : { path: '', source: '' };
  const isBun = command.toLowerCase().replace(/\.(exe|cmd)$/, '') === 'bun';
  if (isBun && override && exists(override)) return { path: override, source: 'harness.bun_path' };
  const names = win && !/\.(exe|cmd|bat)$/i.test(command) ? [`${command}.exe`, `${command}.cmd`] : [command];
  for (const d of String(pathEnv).split(sep).map((s) => s.replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const n of names) { const p = join(d, n); if (exists(p)) return { path: p, source: 'PATH' }; }
  }
  if (isBun && userProfile) { const p = join(userProfile, win ? '.bun\\bin\\bun.exe' : '.bun/bin/bun'); if (exists(p)) return { path: p, source: '~/.bun/bin' }; }
  return { path: '', source: '' };
}

// What a daemon launch resolves bun to: the launcher's own Resolve-BunExe
// (daemon/_common.ps1), run with an EMPTY PATH, because this shell's PATH is
// not the one a daemon / session-0 launch has. -> { path, source } or
// { path: '', source: '', error } when pwsh could not run it.
export function launcherBunResolve({ override = '', userProfile = '' } = {}) {
  const common = path.join(ROOT, 'daemon', '_common.ps1').replace(/'/g, "''");
  const r = runPwshCommand(`. '${common}'; $r = Resolve-BunExe -Override $env:BOTCORP_BUN_OVERRIDE -PathEnv '' -UserProfile $env:BOTCORP_BUN_PROFILE; [pscustomobject]$r | ConvertTo-Json -Compress`,
    { timeoutMs: 60_000, env: { BOTCORP_BUN_OVERRIDE: override, BOTCORP_BUN_PROFILE: userProfile } });
  const last = r.out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const j = JSON.parse(last);
    return { path: String(j.Path || ''), source: String(j.Source || '') };
  } catch {
    return { path: '', source: '', error: (r.err || r.out || `exit ${r.code}`).trim().split(/\r?\n/).pop().slice(0, 160) };
  }
}

// doctor `<bot>: bun resolvable for telegram plugin`.
//   resolved  the command resolved with THIS shell's PATH (resolvePluginCommand)
//   launch    for bun: launcherBunResolve(), the launcher's order WITHOUT this
//             shell's PATH (harness.bun_path > <profile>/.bun/bin); null for
//             any other command
// The launch result decides: found there = PASS naming its source; found only
// on this shell's PATH = WARN (a daemon launch may not have it: the reference
// host's failure); nowhere = FAIL.
export function pluginCommandVerdict(command, resolved, launch = null) {
  if (!command) return { level: 'WARN', detail: "the telegram plugin's .mcp.json names no command" };
  const where = '(harness.bun_path, PATH, %USERPROFILE%\\.bun\\bin)';
  const fix = 'Fix: install bun (https://bun.sh), or botcorp config set <bot> harness.bun_path <path to bun.exe>';
  if (launch) {
    if (launch.path) return { level: 'PASS', detail: `"${command}" -> ${launch.path} (${launch.source}), what a daemon launch resolves without this shell's PATH; the launcher puts its folder first on the session's PATH` };
    if (launch.error) return { level: 'WARN', detail: `could not run the launcher's Resolve-BunExe (${launch.error}); this shell resolves "${command}" to ${resolved.path || 'nothing'}` };
    if (resolved.path) return { level: 'WARN', detail: `"${command}" -> ${resolved.path}, found only on this shell's PATH; a daemon launch (harness.bun_path, %USERPROFILE%\\.bun\\bin) does not find it (pin it: harness.bun_path)` };
    return { level: 'FAIL', detail: `the telegram plugin's .mcp.json runs "${command}", which resolves nowhere ${where}: its MCP server dies with "'${command}' is not recognized". ${fix}` };
  }
  if (!resolved.path) return { level: 'FAIL', detail: `the telegram plugin's .mcp.json runs "${command}", which resolves nowhere ${where}: its MCP server dies with "'${command}' is not recognized". ${fix}` };
  if (resolved.source === 'PATH') return { level: 'WARN', detail: `"${command}" -> ${resolved.path}, found only on this shell's PATH; a daemon launch may not have it (pin it: harness.bun_path)` };
  return { level: 'PASS', detail: `"${command}" -> ${resolved.path} (${resolved.source}); the launcher puts its folder first on the session's PATH` };
}

// doctor `<bot>: session alive`: a bot whose state says it runs (or whose last
// launch failed) with no live claude process is down, not "not running".
export function sessionAliveVerdict({ running, state = null, paused = false }) {
  if (running) return { level: 'PASS', detail: `claude pid ${state && state.claude_pid ? state.claude_pid : '?'} alive${state && state.session_id ? ` (session ${state.session_id})` : ''}` };
  if (paused) return { level: 'INFO', detail: 'paused (botcorp start un-pauses it)' };
  if (!state) return { level: 'INFO', detail: 'never started' };
  const { desired, launch } = stateView(state);
  const stopped = desired && desired.state === 'stopped';
  if (!stopped && ['up', 'starting'].includes(launch.phase)) return { level: 'FAIL', detail: `the last launch came ${launch.phase} (session ${state.session_id || '?'}, bg_id ${state.bg_id || '?'}) but no live claude process runs it` };
  if (launch.phase === 'exited' && Number(launch.exit_code)) return { level: 'FAIL', detail: `the last launch failed (exit ${launch.exit_code}; launches.log says why)` };
  return { level: 'INFO', detail: `not running (${stopped ? 'stopped' : launch.phase || 'stopped'})` };
}

// doctor `<bot>: bg session pinned`. Claude Code's supervisor retires an
// unpinned idle background session 60 min after its last activity (the
// reference host's "dies every ~63 min"); the pin set is <config>/jobs/pins.json
// (daemon/_common.ps1 Set-BgPin), which the launcher and every tick maintain.
// `pinsError` = the file exists but is not a JSON array of short ids: BotCorp's
// pin is written into Claude Code's internal format, so a changed format FAILs
// loudly instead of reading as "not pinned yet".
export function bgPinVerdict({ running, bgId = '', pins = null, pinsError = '' }) {
  if (!running) return { level: 'INFO', detail: 'not running' };
  if (!bgId) return { level: 'WARN', detail: 'no bg_id recorded, so the pin cannot be checked' };
  if (pinsError) return { level: 'FAIL', detail: `.claude-<bot>/jobs/pins.json ${pinsError} - Claude Code may have changed its pin format, so BotCorp cannot pin session ${bgId} and it will be retired after 60 min idle. BotCorp leaves the file alone; report it upstream` };
  if (pins === null) return { level: 'FAIL', detail: `session ${bgId} is not pinned (no readable jobs/pins.json): Claude Code retires it after 60 min idle. The daemon tick pins it within one tick; or botcorp start <bot>` };
  if (pins.includes(bgId)) return { level: 'PASS', detail: `session ${bgId} in .claude-<bot>/jobs/pins.json (not retired for idleness)` };
  return { level: 'FAIL', detail: `session ${bgId} is not pinned: Claude Code retires it after 60 min idle. The daemon tick pins it within one tick; or botcorp start <bot>` };
}

// `status` secrets line / doctor `<bot>: session secrets env`: the env var
// NAMES (never values) of the vault keys in the running session's env, from the
// launch it came from (launch-env.json `secret_env`). `declaredEnv` = the names
// bot.yaml secrets: maps to; one missing from the session is a WARN (a stale
// daemon env, or the key has no vault entry).
// doctor `<bot>: context window`: the auto-compact window bot.yaml resolves to
// (botyaml.mjs resolveContextWindow), where it reaches the session (the launch
// env, which Claude Code ranks above any autoCompactWindow setting), and the
// two places it can disagree: the config home's settings.json (a session not
// started by BotCorp reads that) and the running session's own launch.
export function contextWindowVerdict({ resolved, settingsValue, machineEnv = '', running = false, launch = null }) {
  if (resolved.error) return { level: 'FAIL', detail: `harness.context_window: ${resolved.error}` };
  const machine = machineEnv ? String(machineEnv).trim() : '';
  if (!resolved.tokens) return { level: 'INFO', detail: `auto: Claude Code picks the window${machine ? `; launches drop the machine-wide CLAUDE_CODE_AUTO_COMPACT_WINDOW=${machine} for this bot` : ''}` };
  const shape = `${resolved.tokens} tokens (${resolved.source}), set as CLAUDE_CODE_AUTO_COMPACT_WINDOW by every launch${machine && machine !== String(resolved.tokens) ? `; overrides the machine-wide ${machine}` : ''}`;
  if (settingsValue !== resolved.tokens) return { level: 'WARN', detail: `${shape}; .claude-<bot>/settings.json autoCompactWindow is ${settingsValue ?? 'unset'} (a session not started by BotCorp reads that): botcorp sync <bot>` };
  if (running && launch && Object.prototype.hasOwnProperty.call(launch, 'auto_compact_window') && launch.auto_compact_window !== resolved.tokens) {
    return { level: 'WARN', detail: `${shape}; the running session started with ${launch.auto_compact_window ?? 'auto'} - it applies at the next session start` };
  }
  return { level: 'PASS', detail: shape };
}

// doctor `<bot>: unpushed commits`: with backup.git_remote set, the auto-commit
// hook pushes the bot folder's own repo to origin on every Stop (a failed push is
// retried on the next one), so commits that are not on any origin ref are work
// that lives on this machine only. `ahead` / `oldest` come from the local
// remote-tracking refs (no fetch), `lastPush` is the newest push.log line.
export function unpushedVerdict({ remote, hasGit, origin = '', branch = '', ahead = null, oldest = '', lastPush = '', autoCommit = true, now = Date.now() }) {
  if (!remote) return null;
  const norm = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  if (!hasGit) return { level: 'WARN', detail: `backup.git_remote is set but bots/<bot> is not a git repo yet, so nothing is pushed: botcorp backup <bot>` };
  if (!origin) return { level: 'WARN', detail: `no origin remote, so the auto-commit hook has nowhere to push: botcorp backup <bot> adds ${remote}` };
  const mismatch = norm(origin) !== norm(remote) ? `; origin is ${origin}, not backup.git_remote ${remote} (the hook pushes to origin)` : '';
  if (!branch) return { level: 'WARN', detail: `HEAD is detached, so the hook does not push${mismatch}` };
  if (ahead === null) return { level: 'WARN', detail: `could not count unpushed commits on ${branch}${mismatch}` };
  const last = lastPush ? `; last push: ${lastPush}` : '; no push recorded yet';
  const how = autoCommit ? 'the auto-commit hook pushes on the next Stop' : 'auto_commit is off, so only botcorp backup <bot> pushes';
  if (ahead === 0) return { level: mismatch ? 'WARN' : 'PASS', detail: `0 on ${branch} (origin has everything)${mismatch}${last}` };
  const t = Date.parse(oldest);
  const ageMs = Number.isFinite(t) ? now - t : NaN;
  const age = Number.isFinite(ageMs) ? `, oldest ${humanAge(ageMs)} old` : '';
  const level = Number.isFinite(ageMs) && ageMs >= 24 * 3600_000 ? 'FAIL' : 'WARN';
  return { level, detail: `${ahead} commit(s) on ${branch} exist only on this machine${age} (${how})${mismatch}${last}` };
}

// doctor `<bot>: foreign telegram owner-lock`: owner-locks a launcher OUTSIDE
// BotCorp keeps in the bot folder (a standalone host mode's host/.run/, a
// pre-BotCorp bot's .claude/). BotCorp's own lock lives in the config home and
// never sees these, so a live one means a second launcher can start a second
// poller for the same token.
export const FOREIGN_TG_LOCKS = ['host/.run/tg_owner.lock', '.claude/.tg_owner.lock'];
export function foreignTgLockVerdict(locks = []) {
  const live = locks.filter((l) => l.alive);
  if (live.length) return { level: 'FAIL', detail: `${live.map((l) => `${l.rel} names live pid ${l.pid}`).join('; ')}: a launcher outside BotCorp owns this bot's poller. Stop it and its scheduled task before botcorp start <bot>, or two pollers fight over one getUpdates slot` };
  if (locks.length) return { level: 'WARN', detail: `${locks.map((l) => `${l.rel} (pid ${l.pid || '?'} dead)`).join('; ')}: stale; delete it once that launcher is retired, or it may come back` };
  return { level: 'PASS', detail: `none (${FOREIGN_TG_LOCKS.join(', ')})` };
}

// doctor `<bot>: telegram slot`: Telegram answers getUpdates with 409 while
// another getUpdates holds the bot's slot. Probed only when this bot's own
// poller is NOT the holder (a 409 then says nothing, and the probe would
// interrupt a long-poll the plugin would have to retry): not running, or
// running with a DEAD / FOREIGN / UNKNOWN poller.
export function tgSlotVerdict({ ownPoller = null, codes = null, skipped = '' }) {
  if (ownPoller === 'OWNED') return { level: 'INFO', detail: 'not probed: this bot\'s own poller holds the slot' };
  if (skipped) return { level: 'INFO', detail: `not probed: ${skipped}` };
  const c = Array.isArray(codes) ? codes : [];
  const state = ownPoller ? `this bot's poller is ${ownPoller}` : 'this bot is not running';
  const n409 = c.filter((x) => x === 409).length;
  if (n409) return { level: 'FAIL', detail: `getUpdates answered 409 on ${n409} of ${c.length} probe(s) while ${state}: another process polls this token (a standalone launcher, another host, a stray claude --channels). Stop it before botcorp start <bot>` };
  if (c.includes(401) || c.includes(404)) return { level: 'FAIL', detail: `Telegram rejected the token (${c.find((x) => x === 401 || x === 404)}): botcorp secrets set <bot> telegram` };
  if (c.length && c.every((x) => x === 200)) return { level: 'PASS', detail: `free: ${c.length} probe(s), no 409 (${state})` };
  return { level: 'WARN', detail: `could not tell (${c.length ? `answers ${c.map((x) => x || 'network error').join(', ')}` : 'no probe ran'})` };
}
// (the probe itself is `secrets.ps1 -Action tg-probe`: the token never leaves the vault)

// daemon/_common.ps1 Get-SecretEnvName, the same rule.
export function secretEnvName(key) {
  return key === 'oauth_token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : key === 'telegram_token' ? 'TELEGRAM_BOT_TOKEN' : String(key).toUpperCase();
}

export function sessionSecretEnvVerdict({ running, launch, declaredEnv = [] }) {
  if (!running) return { level: 'INFO', detail: 'not running' };
  if (!launch) return { level: 'INFO', detail: 'unknown: no launch record for this session (started before v0.1.13, or outside BotCorp)' };
  if (!Array.isArray(launch.secret_env)) return { level: 'INFO', detail: `unknown: launch ${launch.launcher_pid} predates the record` };
  const names = launch.secret_env.map(String);
  const shape = `${names.length}${names.length ? `: ${names.join(', ')}` : ''} (from launch ${launch.launcher_pid}, the env this session runs on)`;
  const missing = declaredEnv.filter((n) => !names.includes(n));
  if (missing.length) return { level: 'WARN', detail: `${shape}; declared in secrets: but not in the session env: ${missing.join(', ')} (no vault entry, or the session predates the key: botcorp stop <bot>; botcorp start <bot>)` };
  return { level: 'PASS', detail: shape };
}

// doctor `<bot>: session not blocked`: Claude Code's own job record
// (<config>/jobs/<short>/state.json) says the session waits on something no
// unattended launch answers (daemon/_common.ps1 Get-BgBlock: tempo blocked,
// `needs` other than "send a prompt to start").
// `needs` is often the model's own summary of how its last turn ended ("confirm
// tg_send.py executed ..."): the session is idle and takes its next prompt, so
// that is a WARN (the cockpit still shows it as waiting on you). Only a
// mechanical blocker that stops every next turn too (login, usage limit, the
// folder-trust dialog) FAILs.
const HARD_BLOCK_RE = /\/login|\blog ?in\b|authenticat|oauth|usage limit|rate limit|\btrust\b/i;
export function bgJobFile(cfgDir, bgId) {
  return /^[0-9a-f]{6,12}$/.test(String(bgId || '')) ? path.join(cfgDir, 'jobs', String(bgId), 'state.json') : null;
}
export function bgBlockVerdict({ running, bgId = '', job = null }) {
  if (!running) return { level: 'INFO', detail: 'not running' };
  if (!job) return { level: 'INFO', detail: `no job record for ${bgId || 'the session'} (cannot tell)` };
  const needs = String(job.needs || '').trim();
  if (job.tempo === 'blocked' && needs && !needs.includes('send a prompt to start')) {
    if (HARD_BLOCK_RE.test(needs)) return { level: 'FAIL', detail: `session ${bgId} waits on "${needs}" - nothing unattended answers that. Fix: claude attach ${bgId} (or the cockpit) and answer it` };
    return { level: 'WARN', detail: `session ${bgId} waits on "${needs}" (its last turn ended asking this; it still takes its next prompt). If it needs an answer: claude attach ${bgId} (or the cockpit)` };
  }
  return { level: 'PASS', detail: `session ${bgId} ${job.tempo === 'blocked' ? 'idle, waiting for its next prompt' : `is ${job.tempo || job.state || 'running'}`}` };
}

// The file half of both tools checks: every harness tool has a shim or the
// bot's own copy in the bot folder, and no shim is left for a removed tool.
// `<bot>: harness tools reachable` is this alone; `shape` is the summary.
export function toolShimsVerdictOf({ rows, outdated = [] }) {
  const fix = 'botcorp sync <bot>';
  const bad = rows.filter((r) => r.kind === 'missing' || r.kind === 'stale');
  const own = rows.filter((r) => r.kind === 'own').length;
  const shape = `${rows.length} tools (${rows.length - own} shims${own ? `, ${own} bot-owned` : ''})`;
  if (bad.length) {
    const list = bad.slice(0, 6).map((r) => `${r.rel} ${r.kind === 'stale' ? 'is a shim for a tool the harness no longer has' : 'missing'}`).join(', ');
    return { level: 'FAIL', shape, detail: `${list}${bad.length > 6 ? ` (+${bad.length - 6} more)` : ''}: a relative \`tools/...\` call from the bot folder fails. Fix: ${fix}` };
  }
  if (outdated.length) return { level: 'WARN', shape, detail: `${shape}; ${outdated.length} shim(s) from another checkout (${fix} rewrites them)` };
  return { level: 'PASS', shape, detail: `${shape}, all resolve from the bot folder` };
}

// `<bot>: tg tools reachable` from what doctor measured:
//   rows      toolShimState(): { rel, kind: own|shim|missing|stale }
//   outdated  rels of shims whose text is not what sync writes for this checkout
//   probe     run() of `python tools/tg/tg_send.py --check` in the bot folder, null: no python
// '<bot>' in the detail is the caller's to fill in.
export function tgToolsVerdictOf({ rows, outdated = [], probe }) {
  const fix = 'botcorp sync <bot>';
  if (!rows.length) return { level: 'FAIL', detail: 'the harness ships no tools/tg/*.py (a broken checkout?)' };
  const files = toolShimsVerdictOf({ rows });
  if (files.level === 'FAIL') return files;
  const shape = files.shape;
  if (!probe) return { level: 'WARN', detail: `${shape}; python not found, so tg_send.py --check was not run` };
  const line = (k) => { const m = (probe.out || '').match(new RegExp(`^${k}: (.*)$`, 'm')); return m ? m[1].trim() : null; };
  const ran = line('harness');
  if (probe.code !== 0 || !ran) {
    const why = ((probe.err || '') + (probe.out || '')).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exit ${probe.code}`;
    return { level: 'FAIL', detail: `${shape}, but \`python tools/tg/tg_send.py --check\` in the bot folder failed: ${why.slice(0, 200)}. Fix: ${fix}` };
  }
  const chat = line('chat') || 'none';
  const stale = outdated.length ? `; ${outdated.length} shim(s) from another checkout (${fix} rewrites them)` : '';
  const noChat = chat.startsWith('none');
  return { level: noChat || outdated.length ? 'WARN' : 'PASS', detail: `${shape}; tools/tg/tg_send.py runs ${ran}; default chat ${chat}${stale}` };
}

// The session-env row (<config>/botcorp/session-env.json `sessions`) of the
// bot's current session: of the rows written since the launch, the one of
// sessionId, else the newest (a `--resume` that started a copy has an id the
// launcher never saw). null when there is none.
export function pickSessionEnvRecord(sessions, sessionId, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) - 2000 : -Infinity;
  const rows = Object.values(sessions || {}).filter((r) => r && Date.parse(r.at) >= since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return rows.find((r) => sessionId && r.session_id === sessionId) || rows[0] || null;
}

// Which env the running session actually got. Claude Code strips
// CLAUDE_CODE_OAUTH_TOKEN from its hooks' env, so the session reports its
// BOT_LAUNCHER_PID and Telegram token (hooks/session-env.sh) and every launch
// records what it injected (<config>/botcorp/launch-env.json):
// launch-env[session.launcher_pid] is the OAuth token the session runs on.
//   rec     the session's session-env row (null: none yet)
//   launch  the launch-env row of rec.launcher_pid (null: not listed)
//   lastLauncherPid  the bot's latest launch (state env_launcher_pid)
//   vault   { oauth, telegram } last 4 now ('' no entry; undefined not read)
//   machineOauth  the machine-wide (HKCU) token's last 4, if read
//   expectTg      the launch passed --channels (so it injected the token)
// -> { level: PASS|WARN|FAIL|INFO, env: OK|MISMATCH|FOREIGN|UNKNOWN|null, oauth, detail }
export function sessionEnvVerdict({ running, rec = null, launch = null, lastLauncherPid = null, vault = {}, machineOauth = '', expectTg = false }) {
  if (!running) return { level: 'INFO', env: null, oauth: null, detail: 'bot not running' };
  if (!rec) return { level: 'WARN', env: 'UNKNOWN', oauth: null, detail: 'no session-env record for this session (the session-env hook has not run, is disabled, or the harness predates v0.1.7)' };
  const m = (v) => (v ? `****${v}` : 'none');
  const tg = `telegram ${m(rec.telegram_last4)}`;
  if (!rec.launcher_pid) return { level: 'FAIL', env: 'FOREIGN', oauth: null, detail: `the session's env is not from a BotCorp launch (no BOT_LAUNCHER_PID: the config home's daemon was started by another claude client), ${tg}; its OAuth account is not known${machineOauth ? `, likely the machine-wide ****${machineOauth}` : ''}` };
  if (!launch) return { level: 'WARN', env: 'UNKNOWN', oauth: null, detail: `the session carries launch ${rec.launcher_pid}'s env, which launch-env.json does not list (a launcher older than v0.1.7), ${tg}` };
  const oauth = launch.oauth_last4 || null;
  const from = rec.launcher_pid === lastLauncherPid ? 'the latest launch' : `an earlier launch (pid ${rec.launcher_pid} at ${launch.at}, which started the daemon)`;
  const bad = [];
  if (launch.oauth_source === 'inherited') bad.push(`oauth ${m(oauth)} came from the environment (a machine-wide token is another bot's account), not the vault`);
  else if (vault.oauth && oauth !== vault.oauth) bad.push(`oauth ${m(oauth)} is not the vault's ****${vault.oauth}`);
  if (expectTg && !rec.telegram_last4) bad.push('no telegram token');
  else if (expectTg && vault.telegram && rec.telegram_last4 !== vault.telegram) bad.push(`telegram ${m(rec.telegram_last4)} is not the vault's ****${vault.telegram}`);
  const detail = `env of ${from}: oauth ${launch.oauth_source === 'none' ? "none (the config home's own login)" : `${m(oauth)} (${launch.oauth_source})`}, ${tg}`;
  if (bad.length) return { level: 'FAIL', env: 'MISMATCH', oauth, detail: `${bad.join('; ')} - ${detail}` };
  return { level: 'PASS', env: 'OK', oauth, detail };
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

// ---- system binaries ----------------------------------------------------------
// Always absolute: from a Scheduled Task / session-0 shell PATH is unreliable and
// a bare `powershell` / `python` / `curl.exe` spawned ENOENT on the reference host.
const WIN = process.platform === 'win32';
export const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
export function sysExe(name) { return WIN ? path.join(SYSTEM32, name) : name.replace(/\.exe$/i, ''); }
export const POWERSHELL_EXE = WIN ? path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';

export function findOnPath(names, { skip = null } = {}) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir || (skip && skip.test(dir))) continue;
    for (const n of names) {
      try { if (fs.statSync(path.join(dir, n)).isFile()) return path.join(dir, n); } catch {}
    }
  }
  return null;
}
function firstExisting(cands) { for (const c of cands) if (c && fs.existsSync(c)) return c; return null; }
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';

let _pwsh = null;
// Known install path, then PATH, then the WindowsApps alias, then Windows
// PowerShell 5.1 by its absolute path. Never a versioned WindowsApps path
// (breaks on every PowerShell update), never a bare name.
export function resolvePwsh() {
  if (_pwsh) return _pwsh;
  if (!WIN) { _pwsh = findOnPath(['pwsh']) || 'pwsh'; return _pwsh; }
  _pwsh = firstExisting([path.join(PROGRAM_FILES, 'PowerShell', '7', 'pwsh.exe')])
    || findOnPath(['pwsh.exe'])
    || firstExisting([process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')])
    || POWERSHELL_EXE;
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

export const PYTHON_LOOKED_IN = 'BOT_PYTHON, the py launcher (%SystemRoot%\\py.exe, %LOCALAPPDATA%\\Programs\\Python\\Launcher), HKCU/HKLM Software\\Python\\PythonCore, %LOCALAPPDATA%\\Programs\\Python\\Python3*, PATH (not the WindowsApps alias)';

let _python;
// `{file, pre, version, via}` or null (doctor turns null into a FAIL naming
// PYTHON_LOOKED_IN). BOT_PYTHON, the py launcher, the PythonCore registry, the
// per-user install dir, then PATH minus the WindowsApps store alias.
export function resolvePython() {
  if (_python !== undefined) return _python;
  const probe = (file, via) => {
    if (!file) return null;
    const r = run(file, ['--version'], { timeoutMs: 15_000 });
    const m = (r.out + r.err).match(/Python 3\.\d+\.\d+/);
    return r.code === 0 && m ? { file, pre: [], version: m[0], via } : null;
  };
  const found = () => {
    if (process.env.BOT_PYTHON) { const p = probe(process.env.BOT_PYTHON, 'BOT_PYTHON'); if (p) return p; }
    if (!WIN) return probe(findOnPath(['python3']), 'PATH') || probe(findOnPath(['python']), 'PATH');
    const lad = process.env.LOCALAPPDATA || '';
    const py = firstExisting([path.join(SYSTEM32, '..', 'py.exe'), lad && path.join(lad, 'Programs', 'Python', 'Launcher', 'py.exe')]) || findOnPath(['py.exe']);
    if (py) {
      const r = run(py, ['-3', '-c', 'import sys; print(sys.executable)'], { timeoutMs: 15_000 });
      const exe = r.out.trim();
      if (r.code === 0 && exe && fs.existsSync(exe)) { const p = probe(exe, 'py launcher'); if (p) return p; }
    }
    for (const hive of ['HKCU\\Software\\Python\\PythonCore', 'HKLM\\SOFTWARE\\Python\\PythonCore']) {
      const r = run(sysExe('reg.exe'), ['query', hive, '/s', '/v', 'ExecutablePath'], { timeoutMs: 15_000 });
      const rows = []; let ver = '';
      for (const line of r.out.split(/\r?\n/)) {
        const k = line.match(/PythonCore\\([0-9][0-9.]*)/i); if (k) { ver = k[1]; continue; }
        const e = line.match(/ExecutablePath\s+REG_SZ\s+(.+?)\s*$/i); if (e && fs.existsSync(e[1])) rows.push({ ver, exe: e[1] });
      }
      rows.sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }));
      for (const row of rows) { const p = probe(row.exe, `registry PythonCore ${row.ver}`); if (p) return p; }
    }
    if (lad) {
      let dirs = [];
      try { dirs = fs.readdirSync(path.join(lad, 'Programs', 'Python')).filter((d) => /^Python3\d+$/i.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch {}
      for (const d of dirs) { const p = probe(path.join(lad, 'Programs', 'Python', d, 'python.exe'), 'per-user install'); if (p) return p; }
    }
    return probe(findOnPath(['python.exe', 'python3.exe'], { skip: /WindowsApps/i }), 'PATH');
  };
  _python = found();
  return _python;
}

let _git;
// PATH first, then the Git for Windows install dirs. null when absent (doctor FAILs).
export function resolveGit() {
  if (_git !== undefined) return _git;
  _git = findOnPath(WIN ? ['git.exe'] : ['git']) || (WIN ? firstExisting([
    path.join(PROGRAM_FILES, 'Git', 'cmd', 'git.exe'),
    path.join(PROGRAM_FILES, 'Git', 'bin', 'git.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
  ]) : null);
  return _git;
}
export function gitExe() { return resolveGit() || 'git'; }

// Task-name allowlist matching (`*` wildcard; task names are case-insensitive).
export function matchesAnyGlob(name, patterns) {
  return (patterns || []).some((p) => new RegExp('^' + String(p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(name));
}

export function ipv4ToInt(s) {
  const p = String(s).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}
const MESH_LO = ipv4ToInt('100.96.0.0'), MESH_HI = ipv4ToInt('100.111.255.255');
// Does one firewall RemoteAddress token cover the whole mesh range? Accepts
// `Any`, CIDR, the dotted-mask form Get-NetFirewallAddressFilter prints
// (`100.96.0.0/255.240.0.0`) and `a-b` ranges.
export function coversMesh(addr) {
  const a = String(addr).trim();
  if (/^any$/i.test(a)) return true;
  let m;
  if ((m = a.match(/^([\d.]+)\/([\d.]+)$/))) {
    const base = ipv4ToInt(m[1]);
    let mask;
    if (m[2].includes('.')) mask = ipv4ToInt(m[2]);
    else { const bits = Number(m[2]); if (bits > 32) return false; mask = bits === 0 ? 0 : ((~0 << (32 - bits)) >>> 0); }
    if (base === null || mask === null) return false;
    const s = (base & mask) >>> 0, e = (s | (~mask >>> 0)) >>> 0;
    return s <= MESH_LO && e >= MESH_HI;
  }
  if ((m = a.match(/^([\d.]+)-([\d.]+)$/))) { const s = ipv4ToInt(m[1]), e = ipv4ToInt(m[2]); return s !== null && e !== null && s <= MESH_LO && e >= MESH_HI; }
  return false;
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
