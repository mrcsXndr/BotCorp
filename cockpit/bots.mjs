// bots.mjs - the cockpit's read-only view of which bots exist and how they are.
//
// The registry IS the filesystem: every `bots/<name>/bot.yaml` under the
// BotCorp checkout is a bot (no instances.json, no accounts). Liveness comes
// from what the daemon and the pty-host write under BOTCORP_HOME/state/:
//   state/<bot>.json      daemon-written liveness (shape owned by the daemon)
//   state/<bot>.pty.json  pty-host endpoint {pid, ptyPid, port, token, ...}
// The cockpit never decides whether a bot is alive; it reports what it reads.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { botLiveness, processParentsAsync, sessionAliveVerdict, bgJobFile, bgBlockVerdict, firstInt } from '../cli/_lib.mjs';
import { botsDir } from '../core/paths.mjs';
import { activityOf, breakpointFresh, transcriptQuietMs } from '../core/observe.mjs';
import { phase } from '../core/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BOTCORP_ROOT = path.resolve(__dirname, '..');
export const BOTS_DIR = botsDir(BOTCORP_ROOT);
export const BOTCORP_HOME = process.env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp');
export const STATE_DIR = path.join(BOTCORP_HOME, 'state');

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function botHome(name) { return path.join(BOTS_DIR, name); }
export function configDir(name) { return path.join(BOTS_DIR, name, `.claude-${name}`); }

// Claude Code names a project dir by replacing every non-alphanumeric char of
// the absolute cwd with '-' (no drive-letter special case).
export function ccProjectSlug(absPath) { return String(absPath).replace(/[^A-Za-z0-9]/g, '-'); }

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf-8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// pty.json is only meaningful while its host process is alive; a stale file
// (host crashed without cleanup) must read as "not running", never as running.
export async function ptyEndpoint(name) {
  const rec = await readJson(path.join(STATE_DIR, `${name}.pty.json`));
  if (!rec || !Number.isInteger(rec.port) || typeof rec.token !== 'string') return null;
  if (!pidAlive(rec.pid)) return null;
  return rec;
}

// The process tree (is the Telegram poller below this bot's claude?) costs a
// pwsh spawn, so it is fetched only when an answer depends on it, off the event
// loop, and shared for TREE_TTL_MS across bots and clients.
const TREE_TTL_MS = 30_000;
let tree = { at: 0, promise: null };
function processTree() {
  if (!tree.promise || Date.now() - tree.at > TREE_TTL_MS) tree = { at: Date.now(), promise: processParentsAsync() };
  return tree.promise;
}

// Whether the bot's session is alive and how, by the same checks as `botcorp
// status` / `doctor` (cli/_lib.mjs): a pty-host OR a live claude --bg session
// counts, and the Telegram poller is OWNED only while its bot.pid runs under
// that claude.
export async function liveness(name, cfg, state, pty, cfgDir = configDir(name)) {
  const telegram = !!cfg?.harness?.modules?.telegram;
  let botPid = 0;
  try { botPid = firstInt(await fsp.readFile(path.join(cfgDir, 'channels', 'telegram', 'bot.pid'), 'utf-8')); } catch {}
  let live = botLiveness({ pty, state, telegram, botPid });
  if (live.poller === 'UNKNOWN') live = botLiveness({ pty, state, telegram, botPid, parents: await processTree() });
  let paused = false;
  try { await fsp.access(path.join(STATE_DIR, `${name}.paused`)); paused = true; } catch {}
  const session = sessionAliveVerdict({ running: live.alive, state, paused });
  const bgId = state && state.bg_id != null ? String(state.bg_id) : '';
  const jobFile = live.claudeAlive ? bgJobFile(cfgDir, bgId) : null;
  const job = jobFile ? await readJson(jobFile) : null;
  const block = bgBlockVerdict({ running: live.alive, bgId, job });
  const blocked = block.level === 'FAIL' || block.level === 'WARN';
  // core/observe.mjs's activity from this measurement, and the one phase every reader shows (core/state.mjs);
  // only a hard block (FAIL) is activity `blocked`, a WARN session still takes its next prompt
  const activity = activityOf({ alive: live.alive, blocked: block.level === 'FAIL', breakpoint: live.alive && breakpointFresh(name), quietMs: live.alive ? transcriptQuietMs(name) : null });
  return {
    running: live.alive,
    activity,
    phase: phase(state, { alive: live.alive, activity }),
    pid: pty?.ptyPid ?? (live.claudeAlive ? Number(state.claude_pid) : null),
    // doctor `session alive`: FAIL = the state says it runs but nothing does
    down: session.level === 'FAIL' ? session.detail : null,
    // doctor `session not blocked`: FAIL (login, limit) or WARN (its last turn asked something) = it waits on a person
    blocked: blocked ? { needs: String(job.needs).trim(), detail: block.detail } : null,
    // doctor `telegram channel running`
    poller: telegram ? { state: live.poller, up: live.poller === 'OWNED' } : null,
  };
}

export async function getBot(name) {
  if (!NAME_RE.test(name || '')) return null;
  const home = botHome(name);
  let raw;
  try { raw = await fsp.readFile(path.join(home, 'bot.yaml'), 'utf-8'); } catch { return null; }
  let cfg = {};
  let yamlError = null;
  try { cfg = yaml.load(raw) || {}; } catch (e) { yamlError = e.message; }
  const [state, pty] = await Promise.all([readJson(path.join(STATE_DIR, `${name}.json`)), ptyEndpoint(name)]);
  const live = await liveness(name, cfg, state, pty);
  const modules = cfg?.harness?.modules || {};
  return {
    name,
    displayName: typeof cfg.name === 'string' && cfg.name ? cfg.name : name,
    persona: typeof cfg.persona === 'string' ? cfg.persona.slice(0, 200) : '',
    model: cfg.model || null,
    telegram: !!modules.telegram,
    remoteControl: !!modules.remote_control,
    modules,
    capabilities: cfg.capabilities || null,
    automations: Array.isArray(cfg.automations) ? cfg.automations.map((a) => ({ name: a?.name, kind: a?.kind === 'prompt' ? 'prompt' : 'command', trigger: a?.trigger, enabled: a?.enabled !== false })) : [],
    home,
    configDir: configDir(name),
    yamlError,
    state,                                 // daemon-written, passed through
    // A pty-host OR a live claude --bg session (was the pty record alone: a bg
    // bot always read "stopped", so Start stayed enabled on a live bot).
    running: live.running,
    activity: live.activity,
    phase: live.phase,
    kind: cfg?.harness?.session === 'pty' ? 'pty' : 'bg',
    poller: live.poller,
    blocked: live.blocked,
    down: live.down,
    pid: live.pid,
    hostPid: pty?.pid ?? null,
    startedAt: pty?.startedAt ?? (live.running && state?.started_at ? state.started_at : null),
    mode: pty?.mode ?? null,
    // Background-session attach mode: read both fields defensively, since
    // either can be absent on an older bot.yaml or a state file the daemon
    // hasn't written yet.
    service: typeof cfg?.harness?.service === 'string' ? cfg.harness.service : 'bg',
    bgId: state && typeof state === 'object' && state.bg_id != null ? String(state.bg_id) : null,
  };
}

export async function listBots() {
  let entries;
  try { entries = await fsp.readdir(BOTS_DIR, { withFileTypes: true }); } catch { return []; }
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && NAME_RE.test(e.name))
    .map((e) => e.name);
  const bots = await Promise.all(names.map(getBot));
  return bots.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

// Read-only tail of the daemon's run records for a bot.
export async function automationRuns(name, limit = 50) {
  const file = path.join(STATE_DIR, name, 'runs.jsonl');
  let text;
  try {
    const st = await fsp.stat(file);
    const fh = await fsp.open(file, 'r');
    try {
      const len = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      text = buf.toString('utf-8');
    } finally { await fh.close(); }
  } catch { return { present: false, runs: [] }; }
  const lines = text.split('\n').filter(Boolean);
  const runs = [];
  for (const line of lines.slice(-limit)) {
    try { runs.push(JSON.parse(line)); } catch {}
  }
  return { present: true, runs };
}
