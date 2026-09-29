// failover.mjs - the account failover engine: is a session usage-limited, until
// when, and which account of the bot's chain should it run on now. Pure: the
// CLI (`botcorp accounts failover`), the daemon tick and the launcher all call
// it over the same inputs, so they cannot disagree, and `node --test
// core/tests/failover.test.mjs` drives it with no files.
//
// A bot's chain is [primary, ...backup_accounts] (bot.yaml `account` and
// `backup_accounts`); the bot's own vault token is the pseudo-id `own:<bot>`,
// so `account: null` needs no migration. Limits per account come from
// <rt>/state/accounts.json (written by the tick) plus the live reading of the
// active account: Claude Code's job record (`needs`, the text) and the
// statusline's status.json `rate_limits` (an absolute reset instant).

// What a usage-limited session's job record says (the `needs` text):
//   "rate limited — wait and retry · You've hit your session limit · resets 4:30pm (Europe/Stockholm)"
export const LIMIT_RE = /rate.?limit|hit your \w+ limit|usage limit|resets? \d/i;
const CLOCK_RE = /(?:resets?|reset at|will reset at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_+-]+)\))?/i;
const HOUR_MS = 3600_000;
export const DEFAULT_BLOCK_H = 5;

const ms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();

// A named zone's UTC offset in minutes at `at` (Node's Intl has the tz data);
// null when the zone is unknown.
export function zoneOffsetMin(tz, at) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value || '';
    if (name === 'GMT' || name === 'UTC') return 0;
    const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : null;
  } catch { return null; }
}

// The clock in a limit text ("resets 4:30pm (Europe/Stockholm)") as an
// instant: the next occurrence of that wall-clock time after `ref` (when the
// block was hit), in the named zone when one is given, else this box's zone.
export function resetFromText(text, ref) {
  const m = CLOCK_RE.exec(String(text || ''));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && hour !== 12) hour += 12;
  else if (ap === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const off = (m[4] && zoneOffsetMin(m[4], ref)) ?? -new Date(ref).getTimezoneOffset();
  const shifted = new Date(ref + off * 60_000);   // the wall clock in that zone, read as UTC fields
  let cand = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute) - off * 60_000;
  if (cand <= ref) cand += 24 * HOUR_MS;
  return cand;
}

function windowFromText(text) {
  if (/week|7.?day/i.test(text)) return '7d';
  if (/session|5.?hour|five.?hour/i.test(text)) return '5h';
  return 'unknown';
}

// Is this block a usage limit, and until when?
//   needs       the job record's text
//   rateLimits  status.json rate_limits {five_hour, seven_day: {used_percentage, resets_at (epoch s)}}
//   since       when the record went blocked (job updatedAt); the text clock rolls forward from it
// -> { limited, window: '5h'|'7d'|'unknown'|null, resetAt: ISO|null, source: 'status.json'|'text'|'default'|null }
// The reset instant: a rate_limits window at >= 100 % whose reset is after the
// block (both -> the later), else the text's clock, else `since` + 5 h.
export function classifyBlock({ needs = '', rateLimits = null, since = null, now = Date.now() } = {}) {
  const text = String(needs || '').trim();
  if (!LIMIT_RE.test(text)) return { limited: false, window: null, resetAt: null, source: null };
  const ref = ms(since) ?? now;
  const hit = [['5h', 'five_hour'], ['7d', 'seven_day']]
    .map(([window, key]) => { const w = rateLimits && rateLimits[key]; return w && Number(w.used_percentage) >= 100 ? { window, at: ms(Number(w.resets_at) * 1000) } : null; })
    .filter((w) => w && w.at !== null && w.at > ref)
    .sort((a, b) => b.at - a.at);
  if (hit.length) return { limited: true, window: hit[0].window, resetAt: iso(hit[0].at), source: 'status.json' };
  const t = resetFromText(text, ref);
  if (t !== null) return { limited: true, window: windowFromText(text), resetAt: iso(t), source: 'text' };
  return { limited: true, window: windowFromText(text), resetAt: iso(ref + DEFAULT_BLOCK_H * HOUR_MS), source: 'default' };
}

// [primary, ...backups], deduplicated; the bot's own token is `own:<bot>`.
export function chainOf(cfg, bot) {
  const primary = cfg && typeof cfg.account === 'string' && cfg.account ? cfg.account : `own:${bot}`;
  const backups = cfg && Array.isArray(cfg.backup_accounts) ? cfg.backup_accounts.map(String) : [];
  return [...new Set([primary, ...backups])];
}

export function isOwn(id) { return String(id || '').startsWith('own:'); }
// The account id `launch.ps1` records ('' = the bot's own token) as a chain id.
export function launchToId(account, bot) { return account ? String(account) : `own:${bot}`; }

// HH:MM in this box's zone, for log lines and the doctor.
export function hhmm(at) {
  const t = ms(at);
  return t === null ? '?' : new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// The decision. Rules, in order:
//   1. the active account is limited (blocked_until in the future): the first
//      chain entry that is neither limited nor failed -> failover (at once: a
//      limited session has no live work to protect); none -> wait until the
//      earliest blocked_until
//   2. the active account's blocked_until has passed and its session is still
//      blocked -> recover (restart on the same account)
//   3. active != chain[0], chain[0] clear, >= dwellMin since the last switch -> failback
//   4. >= holdMax switches in the last holdWindowH hours -> hold (no switch)
// A `failed` active account (the daemon saw its launch fail to log in) is left
// like a limited one; failed accounts are never picked.
export function selectAccount({ chain, limits = {}, failed = {}, active, now = Date.now(), dwellMin = 30, switchAt = null, switches = [], holdMax = 4, holdWindowH = 6 } = {}) {
  const until = (id) => ms(limits[id] && limits[id].blocked_until);
  const isLimited = (id) => { const u = until(id); return u !== null && u > now; };
  const isFailed = (id) => !!failed[id];
  const recent = (switches || []).map(ms).filter((t) => t !== null && now - t < holdWindowH * HOUR_MS).length;
  const hold = (to, why) => ({ action: 'hold', to, from: active, why: `${why}; ${recent} switches in the last ${holdWindowH} h (cap ${holdMax}): holding` });
  const activeUntil = until(active);
  // the active account failed (its launch could not log in): leave it like a limited one
  if (isFailed(active) && !(activeUntil !== null && activeUntil > now)) {
    const to = chain.find((id) => id !== active && !isLimited(id) && !isFailed(id));
    const why = `${active} failed (${(failed[active] && failed[active].why) || 'login'})`;
    if (to) return recent >= holdMax ? hold(to, why) : { action: 'failover', to, from: active, why };
    const waits = chain.map(until).filter((u) => u !== null && u > now);
    return { action: 'wait', to: null, from: active, why: `${why}; no other usable account in the chain`, waitUntil: waits.length ? iso(Math.min(...waits)) : null };
  }
  if (activeUntil !== null) {
    if (activeUntil > now) {
      const to = chain.find((id) => id !== active && !isLimited(id) && !isFailed(id));
      const why = `${active} limited until ${hhmm(activeUntil)}${limits[active].window ? ` (${limits[active].window})` : ''}`;
      if (to) return recent >= holdMax ? hold(to, why) : { action: 'failover', to, from: active, why };
      const waits = chain.map(until).filter((u) => u !== null && u > now);
      const waitUntil = Math.min(...waits);
      return { action: 'wait', to: null, from: active, why: `${why}; ${chain.length > 1 ? 'every account in the chain is limited or failed' : 'no backup account'}`, waitUntil: iso(waitUntil) };
    }
    return { action: 'recover', to: active, from: active, why: `${active} reset at ${hhmm(activeUntil)} has passed; the session is still blocked` };
  }
  if (active !== chain[0] && !isLimited(chain[0]) && !isFailed(chain[0])) {
    const dwell = ms(switchAt) === null ? Infinity : (now - ms(switchAt)) / 60_000;
    if (dwell < dwellMin) return { action: 'none', to: chain[0], from: active, why: `failback deferred: dwell ${Math.round(dwell)} min < ${dwellMin} min`, deferred: 'dwell' };
    return recent >= holdMax ? hold(chain[0], `primary ${chain[0]} clear`) : { action: 'failback', to: chain[0], from: active, why: `primary ${chain[0]} clear; ${Math.round(dwell) === Infinity ? 'no switch recorded' : `${Math.round(dwell)} min on ${active}`}` };
  }
  return { action: 'none', to: null, from: active, why: '' };
}

// The whole picture for one bot from already-read inputs (the CLI reads the
// files, `readFailoverInputs` in cli/botcorp.mjs):
//   cfg            the effective bot.yaml
//   state          state/<bot>.json (observed, account_active, account_switch_at, account_switches)
//   observed       a fresher observe record than the state file's, or null
//   status         <config>/botcorp/status.json, or null
//   accountsState  <rt>/state/accounts.json, or null
//   failedIds      account ids whose cached token check FAILed (doctor / accounts use)
//   launchAccount  the `account` of the session's launch record ('' = own), null = no record
// -> { bot, chain: [{id, own, active, limited, blocked_until, window, failed, bots}], active, limited, resetAt, window, source, decision }
export function decide({ bot, cfg, state = null, observed = null, status = null, accountsState = null, failedIds = [], launchAccount = null, now = Date.now(), dwellMin = 30 } = {}) {
  const chain = chainOf(cfg, bot);
  const st = state && typeof state === 'object' ? state : {};
  const o = observed || st.observed || null;
  const active = (st.account_active && st.account_active.id) || (launchAccount !== null && launchAccount !== undefined ? launchToId(launchAccount, bot) : chain[0]);
  const live = o && o.alive && o.blocked
    ? classifyBlock({ needs: o.blocked.needs, rateLimits: status && status.rate_limits, since: o.blocked.since, now })
    : { limited: false, window: null, resetAt: null, source: null };
  const known = accountsState && accountsState.accounts && typeof accountsState.accounts === 'object' ? accountsState.accounts : (accountsState && typeof accountsState === 'object' && !accountsState.accounts ? accountsState : {});
  const limits = {};
  const failed = {};
  for (const [id, e] of Object.entries(known || {})) {
    if (!e || typeof e !== 'object') continue;
    if (e.blocked_until) limits[id] = { blocked_until: e.blocked_until, window: e.window || null, source: e.source || 'accounts.json' };
    if (e.failed) failed[id] = e.failed;
  }
  for (const id of failedIds || []) failed[id] = failed[id] || { why: 'token check failed (account-checks.json)' };
  // the live session is the authority on the account it runs on
  if (o && o.alive) {
    if (live.limited) limits[active] = { blocked_until: live.resetAt, window: live.window, source: live.source };
    else delete limits[active];
  }
  const decision = selectAccount({ chain, limits, failed, active, now, dwellMin, switchAt: st.account_switch_at || null, switches: Array.isArray(st.account_switches) ? st.account_switches : [] });
  const rows = chain.map((id) => {
    const u = ms(limits[id] && limits[id].blocked_until);
    return { id, own: isOwn(id), active: id === active, limited: u !== null && u > now, blocked_until: u === null ? null : iso(u), window: (limits[id] && limits[id].window) || null,
      failed: failed[id] || null, bots: known && known[id] && Array.isArray(known[id].bots) ? known[id].bots.map(String) : [] };
  });
  return { bot, chain: rows, active, limited: live.limited, resetAt: live.resetAt, window: live.window, source: live.source, decision, effective: effectiveOf(chain, active, decision) };
}

// The account a launch should use now, and why (launch.ps1 records both; the
// footer and the cockpit show them): a switch the decision calls for; else the
// active account while it is still in the chain; else the primary (the
// operator changed the chain under it).
//   reason: primary | failover (on a backup) | failback | recover
export function effectiveOf(chain, active, decision) {
  if (['failover', 'failback', 'recover'].includes(decision.action)) return { id: decision.to, reason: decision.action };
  if (chain.includes(active)) return { id: active, reason: active === chain[0] ? 'primary' : 'failover' };
  return { id: chain[0], reason: 'primary' };
}
