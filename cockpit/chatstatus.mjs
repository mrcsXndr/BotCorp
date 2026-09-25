// chatstatus.mjs - the chat header's status chips for one bot: context used,
// Claude account, 5 h / 7 d limits, model and effort.
//
// Read-only, from files BotCorp already writes; nothing is derived twice:
//   <config>/botcorp/status.json      statusline.js, every render: context_window,
//                                     rate_limits, model, effort, ts
//   bot.yaml                          harness.context_window (daemon/botyaml.mjs
//                                     resolveContextWindow), model, effort
//   <config>/botcorp/session-env.json the session's launcher pid (session-env hook)
//   <config>/botcorp/launch-env.json  what that launch injected: oauth last 4 + source
//   <config>/.claude.json             oauthAccount.emailAddress (config-home login)
//   <rt>/state/<bot>.json             daemon: session_id, started_at
// A value that is not there comes back as { na: '<why>' }; nothing is invented.
// Only a token's last 4 ever leaves here, never a token.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { loadBotYaml, resolveContextWindow } from '../daemon/botyaml.mjs';
import { pickSessionEnvRecord } from '../cli/_lib.mjs';
import { STATE_DIR } from './bots.mjs';

const NO_STATUS = 'no status.json yet (the statusline writes it once a session renders)';

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf-8')); } catch { return null; }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

// resets_at is a unix epoch in seconds (docs/cc-compat.md); accept an ISO string too.
function epochS(v) {
  if (num(v) !== null) return v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

function contextChip(status, cfg) {
  if (!status) return { na: NO_STATUS };
  const cw = status.context_window || {};
  const size = num(cw.context_window_size);
  const cu = cw.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : null;
  const parts = cu ? ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((k) => num(cu[k])).filter((v) => v !== null) : [];
  let used = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  if (used === null && num(cw.used_percentage) !== null && size) used = Math.round(cw.used_percentage * size / 100);
  if (used === null) return { na: 'status.json has no context reading yet (none until the first reply, or right after /compact)' };
  const resolved = cfg ? resolveContextWindow(cfg) : { tokens: null };
  const window = resolved.tokens || size;
  if (!window) return { na: `${used} tokens used, but neither bot.yaml nor status.json gives a context window` };
  const source = resolved.tokens ? `bot.yaml harness.context_window: ${resolved.source}` : `the model's window (context_window is auto)`;
  return { used, window, pct: Math.round(used / window * 100), source };
}

function limitChip(status, key, label, nowS) {
  if (!status) return { na: NO_STATUS };
  if (!status.rate_limits || typeof status.rate_limits !== 'object') return { na: 'status.json has no rate_limits (absent for API-key sessions and before the first reply)' };
  const w = status.rate_limits[key];
  if (!w || num(w.used_percentage) === null) return { na: `status.json has no ${label} reading` };
  const resetsAt = epochS(w.resets_at);
  if (resetsAt !== null && resetsAt <= nowS) return { na: `the ${label} window reset at ${iso(resetsAt)}; no reading since` };
  return { pct: w.used_percentage, resetsAt };
}

// Which account the session runs on. An injected CLAUDE_CODE_OAUTH_TOKEN wins
// over the config home's own login, so the launch record is checked first and
// the .claude.json email is only claimed when no token was injected.
function accountChip({ claudeJson, sessions, launches, state }) {
  const rec = pickSessionEnvRecord(sessions, state && state.session_id, state && state.started_at);
  const launch = rec && rec.launcher_pid ? (launches || {})[String(rec.launcher_pid)] || null : null;
  const email = claudeJson && claudeJson.oauthAccount && typeof claudeJson.oauthAccount.emailAddress === 'string' ? claudeJson.oauthAccount.emailAddress : null;
  if (launch && launch.oauth_source !== 'none' && typeof launch.oauth_last4 === 'string' && launch.oauth_last4) {
    return { tokenLast4: launch.oauth_last4.slice(-4), source: `OAuth token injected at launch (${launch.oauth_source || 'unknown source'}, ${launch.at || 'time unknown'}); a token carries no email` };
  }
  if (email) return { email, source: `the config home's own login (.claude.json)${launch ? '' : '; no launch record for this session, so an injected token cannot be ruled out'}` };
  if (!rec) return { na: 'no session-env record for this session (session-env hook not run yet, or the bot has never started)' };
  if (!rec.launcher_pid) return { na: 'this session was not started by a BotCorp launch, so its account is not recorded' };
  if (!launch) return { na: `launch-env.json does not list launch ${rec.launcher_pid} (a launcher older than v0.1.7)` };
  return { na: 'the session uses the config home login, and .claude.json has no oauthAccount email' };
}

export function summarizeStatus({ status = null, cfg = null, claudeJson = null, sessions = null, launches = null, state = null, now = Date.now() } = {}) {
  const nowS = now / 1000;
  const model = status && status.model && (status.model.display_name || status.model.id)
    ? { name: String(status.model.display_name || status.model.id), id: status.model.id || null, source: 'the session (status.json)' }
    : cfg && cfg.model ? { name: String(cfg.model), id: String(cfg.model), source: 'bot.yaml (no session reading yet)' } : { na: NO_STATUS };
  const effort = status && status.effort && typeof status.effort.level === 'string'
    ? { level: status.effort.level, source: 'the session (status.json)' }
    : cfg && cfg.effort ? { level: String(cfg.effort), source: "bot.yaml (configured; this session's live effort is not recorded)" } : { na: 'no effort in status.json or bot.yaml' };
  // ts, not an age: the bridge pushes only when this object changes, and the
  // client ages it (and greys the chips past 15 min) itself.
  return {
    ts: status ? num(status.ts) : null,
    context: contextChip(status, cfg),
    account: accountChip({ claudeJson, sessions, launches, state }),
    fiveHour: limitChip(status, 'five_hour', '5-hour', nowS),
    sevenDay: limitChip(status, 'seven_day', '7-day', nowS),
    model,
    effort,
  };
}

// The one entry point. Never throws.
export async function chatStatus(bot) {
  try {
    const dir = path.join(bot.configDir, 'botcorp');
    const [status, claudeJson, sessionEnv, launchEnv, state] = await Promise.all([
      readJson(path.join(dir, 'status.json')),
      readJson(path.join(bot.configDir, '.claude.json')),
      readJson(path.join(dir, 'session-env.json')),
      readJson(path.join(dir, 'launch-env.json')),
      readJson(path.join(STATE_DIR, `${bot.name}.json`)),
    ]);
    let cfg = null;
    try { cfg = loadBotYaml(path.join(bot.home, 'bot.yaml')); } catch {}
    return summarizeStatus({ status, cfg, claudeJson, sessions: sessionEnv && sessionEnv.sessions, launches: launchEnv && launchEnv.launches, state });
  } catch {
    return { error: 'status unreadable' };
  }
}
