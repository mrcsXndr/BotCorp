// ccprobe.mjs - what the pinned Claude Code offers, asked of the binary itself
// (`botcorp cc models`, the cockpit's model picker).
//
// The pinned claude.exe runs headless in stream-json mode with a scratch config
// home, no token and no settings (`--setting-sources ""`), so nothing reaches the
// API and no bot's files are read. Over its control protocol:
//   initialize            -> models[]: value, resolvedModel, displayName,
//                            description (with the price), supportedEffortLevels
//   set_model + get_settings, per model
//                         -> applied.ultracodeAvailable and the model's own effort
// set_model takes an alias (opus, sonnet, haiku, fable, default); a full id is
// refused without credentials, so a model whose value is an id is asked by the
// alias its display name gives. Anything unanswered stays null (unknown).
//
// Cached at <BOTCORP_HOME>/cc/<version>/models.json, keyed by the pin's sha256:
// a re-pinned binary is probed again. The probe fails closed: { models: [],
// error } and never a guessed list.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TOKEN_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'BOT_NAME', 'BOTCORP_LAUNCH_ID'];
export const PROBE_ARGS = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', ''];

function runtimeHome() { return process.env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp'); }

// "... · $4/$20 per Mtok" -> { input: 4, output: 20 }, else null.
export function priceOf(description) {
  const m = /\$(\d+(?:\.\d+)?)\s*\/\s*\$(\d+(?:\.\d+)?)\s*per\s*Mtok/i.exec(String(description || ''));
  return m ? { input: Number(m[1]), output: Number(m[2]) } : null;
}

// The `initialize` reply's models, normalised. Anything that is not a list of
// objects with a string `value` is dropped.
export function parseModels(init) {
  const list = init && Array.isArray(init.models) ? init.models : [];
  return list.filter((m) => m && typeof m === 'object' && typeof m.value === 'string' && m.value).map((m) => ({
    value: m.value,
    resolvedModel: typeof m.resolvedModel === 'string' ? m.resolvedModel : m.value,
    displayName: typeof m.displayName === 'string' ? m.displayName : m.value,
    description: typeof m.description === 'string' ? m.description : '',
    price: priceOf(m.description),
    supportsEffort: m.supportsEffort === true,
    supportedEffortLevels: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((x) => typeof x === 'string') : [],
    ultracodeAvailable: null,
    defaultEffort: null,
  }));
}

// The alias set_model accepts for a model: its value when that is no full id,
// else its display name lowercased (Fable -> fable).
export function aliasOf(m) {
  if (!/^claude-/.test(m.value)) return m.value;
  const a = String(m.displayName || '').trim().toLowerCase();
  return /^[a-z]+$/.test(a) ? a : null;
}

// One stream-json stdout line -> { id, ok, response | error } for a control
// response, else null (every other message of the stream).
export function parseControlLine(line) {
  let j; try { j = JSON.parse(line); } catch { return null; }
  const r = j && j.type === 'control_response' && j.response && typeof j.response === 'object' ? j.response : null;
  if (!r || typeof r.request_id !== 'string') return null;
  return r.subtype === 'success' ? { id: r.request_id, ok: true, response: r.response || {} } : { id: r.request_id, ok: false, error: String(r.error || 'error') };
}

// One headless claude with a control channel: request(subtype, fields) -> the
// response object, or throws with the CLI's error. close() kills it.
export function controlSession({ exe, configDir, cwd, timeoutMs = 20_000 }) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  for (const k of TOKEN_ENV) delete env[k];
  const child = spawn(exe, PROBE_ARGS, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map();
  let buf = '', n = 0, dead = null;
  const failAll = (e) => { dead = e; for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(e); } pending.clear(); };
  child.on('error', (e) => failAll(e));
  child.on('exit', (code) => failAll(new Error(`claude exited (${code}) before answering`)));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const r = parseControlLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const p = r && pending.get(r.id);
      if (!p) continue;
      pending.delete(r.id); clearTimeout(p.timer);
      if (r.ok) p.resolve(r.response); else p.reject(new Error(r.error));
    }
  });
  return {
    request(subtype, fields = {}) {
      if (dead) return Promise.reject(dead);
      const id = `botcorp-${++n}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no answer to ${subtype} in ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype, ...fields } }) + '\n'); }
        catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
      });
    },
    close() { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} },
  };
}

// -> { cc_version, models, probed_at, error? }
export async function probeModels({ exe, version, workDir, timeoutMs = 20_000 }) {
  const s = controlSession({ exe, configDir: path.join(workDir, 'config'), cwd: path.join(workDir, 'cwd'), timeoutMs });
  try {
    const models = parseModels(await s.request('initialize'));
    for (const m of models) {
      const alias = aliasOf(m);
      if (!alias) continue;
      try {
        await s.request('set_model', { model: alias });
        const applied = (await s.request('get_settings')).applied || {};
        if (typeof applied.ultracodeAvailable === 'boolean') m.ultracodeAvailable = applied.ultracodeAvailable;
        if (typeof applied.effort === 'string') m.defaultEffort = applied.effort;
      } catch {}
    }
    return { cc_version: version, models, probed_at: new Date().toISOString() };
  } catch (e) {
    return { cc_version: version, models: [], probed_at: new Date().toISOString(), error: String(e.message || e) };
  } finally { s.close(); }
}

// The pinned Claude Code's models, cached per pin. `pin` = state/cc.json's
// pinned record ({version, exe, sha256}); none -> an error, no probe.
export async function ccModels({ pin, refresh = false, probe = probeModels }) {
  if (!pin || !pin.exe || !pin.version) return { cc_version: null, models: [], error: 'no Claude Code pin yet (botcorp cc status)' };
  if (!fs.existsSync(pin.exe)) return { cc_version: pin.version, models: [], error: `the pinned claude is missing: ${pin.exe}` };
  const dir = path.join(runtimeHome(), 'cc', String(pin.version));
  const cache = path.join(dir, 'models.json');
  if (!refresh) {
    try {
      const c = JSON.parse(fs.readFileSync(cache, 'utf-8'));
      if (c && c.pin_sha256 === (pin.sha256 || null) && Array.isArray(c.models) && c.models.length) return { cc_version: c.cc_version, models: c.models, probed_at: c.probed_at, cached: true };
    } catch {}
  }
  const r = await probe({ exe: pin.exe, version: pin.version, workDir: path.join(dir, 'probe') });
  if (r.models.length) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cache, JSON.stringify({ pin_sha256: pin.sha256 || null, ...r }, null, 2) + '\n'); } catch {}
  }
  return { ...r, cached: false };
}
