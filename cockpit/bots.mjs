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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BOTCORP_ROOT = path.resolve(__dirname, '..');
export const BOTS_DIR = path.join(BOTCORP_ROOT, 'bots');
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

export async function getBot(name) {
  if (!NAME_RE.test(name || '')) return null;
  const home = botHome(name);
  let raw;
  try { raw = await fsp.readFile(path.join(home, 'bot.yaml'), 'utf-8'); } catch { return null; }
  let cfg = {};
  let yamlError = null;
  try { cfg = yaml.load(raw) || {}; } catch (e) { yamlError = e.message; }
  const [state, pty] = await Promise.all([readJson(path.join(STATE_DIR, `${name}.json`)), ptyEndpoint(name)]);
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
    automations: Array.isArray(cfg.automations) ? cfg.automations.map((a) => ({ name: a?.name, trigger: a?.trigger, enabled: a?.enabled !== false })) : [],
    home,
    configDir: configDir(name),
    yamlError,
    state,                                 // daemon-written, passed through
    running: !!pty,
    pid: pty?.ptyPid ?? null,
    hostPid: pty?.pid ?? null,
    startedAt: pty?.startedAt ?? null,
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
