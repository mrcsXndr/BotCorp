// core/failover.mjs: the limit classifier and the account selection. Pure; no
// files, no pwsh. Run: node --test core/tests/failover.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMIT_RE, classifyBlock, resetFromText, selectAccount, chainOf, decide, launchToId, effectiveOf } from '../failover.mjs';

// A live block recorded on 2026-09-29: the job record went blocked at
// 11:47:47Z with this text; status.json said five_hour 101 %, resets_at
// 1790692200 (14:30Z = 16:30 CEST); the box clock is CEST too.
const LIVE = 'rate limited — wait and retry · You\'ve hit your session limit · resets 4:30pm (Europe/Stockholm)';
const SINCE = '2026-09-29T11:47:47.394Z';
const NOW = Date.parse('2026-09-29T12:13:03Z');
const RL = { five_hour: { used_percentage: 101, resets_at: 1790692200 }, seven_day: { used_percentage: 42, resets_at: 1791151200 } };
const RESET = '2026-09-29T14:30:00.000Z';

test('LIMIT_RE: the live text, a weekly text, a plain usage-limit text; not a login or a model question', () => {
  for (const t of [LIVE, "You've hit your weekly limit · resets Oct 2, 9am", 'usage limit reached', 'Rate limit exceeded. Resets 7:10pm']) assert.ok(LIMIT_RE.test(t), t);
  for (const t of ['/login to continue', 'confirm tg_send.py executed the send', 'trust this folder?', 'send a prompt to start']) assert.ok(!LIMIT_RE.test(t), t);
});

test('classifyBlock: the reset comes from status.json when a window is at 100 % (the absolute instant wins)', () => {
  const c = classifyBlock({ needs: LIVE, rateLimits: RL, since: SINCE, now: NOW });
  assert.deepEqual(c, { limited: true, window: '5h', resetAt: RESET, source: 'status.json' });
});

test('classifyBlock: from the text alone the named zone is honoured and the clock rolls forward from the block time, not from now', () => {
  const c = classifyBlock({ needs: LIVE, rateLimits: null, since: SINCE, now: NOW });
  assert.deepEqual(c, { limited: true, window: '5h', resetAt: RESET, source: 'text' });
  // long after the reset the same text still names TODAY's 16:30 (the block was before it), so recover can fire
  const later = classifyBlock({ needs: LIVE, rateLimits: null, since: SINCE, now: Date.parse('2026-09-29T15:00:00Z') });
  assert.equal(later.resetAt, RESET);
  // a clock already past at block time is tomorrow's
  const wrapped = classifyBlock({ needs: 'resets 9:00am (Europe/Stockholm)', since: SINCE, now: NOW });
  assert.equal(wrapped.resetAt, '2026-09-30T07:00:00.000Z');
});

test('classifyBlock: a stale rate_limits window (its reset before the block) is ignored; both at 100 % -> the later one', () => {
  const stale = { five_hour: { used_percentage: 100, resets_at: 1790600000 } };   // 2026-09-28: before the block
  assert.equal(classifyBlock({ needs: LIVE, rateLimits: stale, since: SINCE, now: NOW }).source, 'text');
  const both = { five_hour: { used_percentage: 100, resets_at: 1790692200 }, seven_day: { used_percentage: 100, resets_at: 1791151200 } };
  const c = classifyBlock({ needs: 'usage limit reached', rateLimits: both, since: SINCE, now: NOW });
  assert.equal(c.window, '7d');
  assert.equal(c.resetAt, new Date(1791151200 * 1000).toISOString());
});

test('classifyBlock: a weekly text, a text without a clock (since + 5 h), and a non-limit block', () => {
  const w = classifyBlock({ needs: "You've hit your weekly limit · resets Oct 2, 9am", since: SINCE, now: NOW });
  assert.equal(w.limited, true);
  assert.equal(w.window, '7d');
  const d = classifyBlock({ needs: 'rate limited — wait and retry', since: SINCE, now: NOW });
  assert.deepEqual(d, { limited: true, window: 'unknown', resetAt: '2026-09-29T16:47:47.394Z', source: 'default' });
  assert.deepEqual(classifyBlock({ needs: 'confirm tg_send.py executed the send', since: SINCE, now: NOW }), { limited: false, window: null, resetAt: null, source: null });
  assert.equal(classifyBlock({ needs: 'usage limit', now: NOW }).resetAt, new Date(NOW + 5 * 3600_000).toISOString());   // no since: from now
});

test('resetFromText: box-local when no zone is named', () => {
  const ref = Date.parse('2026-09-29T11:47:47Z');
  const t = resetFromText('resets 4:30pm', ref);
  const d = new Date(t);
  assert.equal(d.getHours(), 16);
  assert.equal(d.getMinutes(), 30);
  assert.ok(t > ref);
  assert.equal(resetFromText('nothing here', ref), null);
});

// --- selection ----------------------------------------------------------------------------
const T = (h, m = 0) => Date.parse(`2026-09-29T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const now = T(13);
const lim = (h) => ({ blocked_until: new Date(T(h)).toISOString(), window: '5h' });

test('select: chain order; failover from a limited primary to the first clear, unfailed backup', () => {
  assert.deepEqual(chainOf({ account: null, backup_accounts: ['b', 'c', 'b'] }, 'alpha'), ['own:alpha', 'b', 'c']);
  assert.deepEqual(chainOf({ account: 'a', backup_accounts: [] }, 'alpha'), ['a']);
  assert.deepEqual(chainOf({}, 'alpha'), ['own:alpha']);
  assert.equal(launchToId('', 'alpha'), 'own:alpha');
  assert.equal(launchToId('spare', 'alpha'), 'spare');
  const s = selectAccount({ chain: ['a', 'b', 'c'], limits: { a: lim(16), b: lim(15) }, active: 'a', now });
  assert.equal(s.action, 'failover');
  assert.equal(s.to, 'c');
  assert.equal(s.from, 'a');
  assert.match(s.why, /a limited until/);
  // a failed account is skipped
  assert.equal(selectAccount({ chain: ['a', 'b', 'c'], limits: { a: lim(16) }, failed: { b: { why: '401' } }, active: 'a', now }).to, 'c');
  // the switch is immediate: no dwell applies to leaving a limited account
  assert.equal(selectAccount({ chain: ['a', 'b'], limits: { a: lim(16) }, active: 'a', now, switchAt: new Date(now - 60_000).toISOString() }).action, 'failover');
});

test('select: a failed active account is left for the next usable one; nothing usable -> wait', () => {
  const s = selectAccount({ chain: ['a', 'b', 'c'], limits: { a: lim(16) }, failed: { b: { why: 'login after failover' } }, active: 'b', now });
  assert.equal(s.action, 'failover');
  assert.equal(s.to, 'c');
  assert.match(s.why, /b failed \(login after failover\)/);
  const none = selectAccount({ chain: ['a', 'b'], limits: { a: lim(16) }, failed: { b: { why: 'x' } }, active: 'b', now });
  assert.equal(none.action, 'wait');
  assert.equal(none.waitUntil, new Date(T(16)).toISOString());
});

test('select: nothing limited, on the primary -> none', () => {
  assert.equal(selectAccount({ chain: ['a', 'b'], limits: {}, active: 'a', now }).action, 'none');
  assert.equal(selectAccount({ chain: ['a'], limits: {}, active: 'a', now }).action, 'none');
});

test('select: recover once the active account reset has passed and the session is still blocked', () => {
  const s = selectAccount({ chain: ['a', 'b'], limits: { a: lim(12) }, active: 'a', now });
  assert.equal(s.action, 'recover');
  assert.equal(s.to, 'a');
  assert.match(s.why, /reset at .* has passed/);
});

test('select: failback to the primary after its reset, only after the dwell', () => {
  const early = selectAccount({ chain: ['a', 'b'], limits: {}, active: 'b', now, switchAt: new Date(now - 10 * 60_000).toISOString() });
  assert.equal(early.action, 'none');
  assert.equal(early.deferred, 'dwell');
  const due = selectAccount({ chain: ['a', 'b'], limits: {}, active: 'b', now, switchAt: new Date(now - 45 * 60_000).toISOString() });
  assert.equal(due.action, 'failback');
  assert.equal(due.to, 'a');
  // the primary still limited: stay
  assert.equal(selectAccount({ chain: ['a', 'b'], limits: { a: lim(16) }, active: 'b', now, switchAt: new Date(now - 45 * 60_000).toISOString() }).action, 'none');
  // BOT_FAILOVER_DWELL_MIN-style override
  assert.equal(selectAccount({ chain: ['a', 'b'], limits: {}, active: 'b', now, switchAt: new Date(now - 10 * 60_000).toISOString(), dwellMin: 5 }).action, 'failback');
});

test('select: every account limited -> wait until the earliest reset', () => {
  const s = selectAccount({ chain: ['a', 'b', 'c'], limits: { a: lim(16), b: lim(15), c: lim(17) }, active: 'a', now });
  assert.equal(s.action, 'wait');
  assert.equal(s.waitUntil, new Date(T(15)).toISOString());
  const alone = selectAccount({ chain: ['a'], limits: { a: lim(16) }, active: 'a', now });
  assert.equal(alone.action, 'wait');
  assert.match(alone.why, /no backup account/);
});

test('select: flapping -> hold at the 4th switch inside 6 h; recover is never held', () => {
  const sw = [1, 2, 3, 4].map((h) => new Date(now - h * 3600_000).toISOString());
  const h = selectAccount({ chain: ['a', 'b'], limits: { a: lim(16) }, active: 'a', now, switches: sw });
  assert.equal(h.action, 'hold');
  assert.match(h.why, /4 switches/);
  assert.equal(selectAccount({ chain: ['a', 'b'], limits: { a: lim(16) }, active: 'a', now, switches: sw.slice(1) }).action, 'failover');
  const old = [7, 8, 9, 10].map((h2) => new Date(now - h2 * 3600_000).toISOString());
  assert.equal(selectAccount({ chain: ['a', 'b'], limits: { a: lim(16) }, active: 'a', now, switches: old }).action, 'failover');
  assert.equal(selectAccount({ chain: ['a', 'b'], limits: {}, active: 'b', now, switches: sw, switchAt: new Date(now - 45 * 60_000).toISOString() }).action, 'hold');
  assert.equal(selectAccount({ chain: ['a', 'b'], limits: { a: lim(12) }, active: 'a', now, switches: sw }).action, 'recover');
});

// --- decide: the picture from the files -----------------------------------------------------
const observedBlocked = { alive: true, phase: 'blocked', blocked: { level: 'FAIL', kind: 'limit', needs: LIVE, since: SINCE }, at: '2026-09-29T12:13:03Z', quiet_s: 1516 };

test('decide: the live picture: own token, limited until 16:30, no backup -> wait; after the reset -> recover', () => {
  const d = decide({ bot: 'alpha', cfg: { account: null, backup_accounts: [] }, state: { observed: observedBlocked }, status: { rate_limits: RL }, launchAccount: '', now: NOW });
  assert.equal(d.active, 'own:alpha');
  assert.equal(d.limited, true);
  assert.equal(d.resetAt, RESET);
  assert.deepEqual(d.chain.map((r) => [r.id, r.own, r.active, r.limited, r.blocked_until]), [['own:alpha', true, true, true, RESET]]);
  assert.equal(d.decision.action, 'wait');
  const after = decide({ bot: 'alpha', cfg: { account: null }, state: { observed: observedBlocked }, status: { rate_limits: RL }, launchAccount: '', now: Date.parse('2026-09-29T14:33:00Z') });
  assert.equal(after.decision.action, 'recover');
  assert.equal(after.decision.to, 'own:alpha');
});

test('decide: with a backup the live limit fails over; the live session clears a stale accounts.json entry for its own account', () => {
  const d = decide({ bot: 'alpha', cfg: { account: null, backup_accounts: ['spare'] }, state: { observed: observedBlocked }, status: { rate_limits: RL }, launchAccount: '', now: NOW });
  assert.equal(d.decision.action, 'failover');
  assert.equal(d.decision.to, 'spare');
  const idle = { alive: true, phase: 'idle', blocked: null, at: '2026-09-29T12:13:03Z', quiet_s: 10 };
  const clear = decide({ bot: 'alpha', cfg: { account: null, backup_accounts: ['spare'] }, state: { observed: idle }, accountsState: { accounts: { 'own:alpha': { blocked_until: RESET, bots: ['alpha'] } } }, launchAccount: '', now: NOW });
  assert.equal(clear.decision.action, 'none');
  assert.equal(clear.chain[0].limited, false);
  // a cached FAIL on the backup skips it
  const failedBackup = decide({ bot: 'alpha', cfg: { account: null, backup_accounts: ['spare'] }, state: { observed: observedBlocked }, status: { rate_limits: RL }, failedIds: ['spare'], launchAccount: '', now: NOW });
  assert.equal(failedBackup.decision.action, 'wait');
  assert.equal(failedBackup.chain[1].failed.why, 'token check failed (account-checks.json)');
});

test('decide: the active account comes from state.account_active, else the launch record, else the primary', () => {
  const st = { account_active: { id: 'spare', reason: 'failover' }, account_switch_at: new Date(NOW - 45 * 60_000).toISOString(), observed: { alive: true, phase: 'idle', blocked: null } };
  const d = decide({ bot: 'alpha', cfg: { account: null, backup_accounts: ['spare'] }, state: st, launchAccount: 'spare', now: NOW });
  assert.equal(d.active, 'spare');
  assert.equal(d.decision.action, 'failback');
  assert.equal(decide({ bot: 'alpha', cfg: { account: 'a' }, state: null, launchAccount: null, now: NOW }).active, 'a');
  assert.equal(decide({ bot: 'alpha', cfg: { account: 'a' }, state: {}, launchAccount: '', now: NOW }).active, 'own:alpha');
  // a fresher observation beats the state file's
  const fresh = decide({ bot: 'alpha', cfg: {}, state: { observed: { alive: true, phase: 'idle', blocked: null } }, observed: observedBlocked, status: { rate_limits: RL }, launchAccount: '', now: NOW });
  assert.equal(fresh.limited, true);
});

test('effective: the switch the decision calls for, else the active account while in the chain, else the primary', () => {
  assert.deepEqual(effectiveOf(['a', 'b'], 'a', { action: 'failover', to: 'b' }), { id: 'b', reason: 'failover' });
  assert.deepEqual(effectiveOf(['a', 'b'], 'b', { action: 'failback', to: 'a' }), { id: 'a', reason: 'failback' });
  assert.deepEqual(effectiveOf(['a', 'b'], 'a', { action: 'recover', to: 'a' }), { id: 'a', reason: 'recover' });
  assert.deepEqual(effectiveOf(['a', 'b'], 'b', { action: 'none', deferred: 'dwell' }), { id: 'b', reason: 'failover' });
  assert.deepEqual(effectiveOf(['a', 'b'], 'a', { action: 'wait' }), { id: 'a', reason: 'primary' });
  // the operator took the active account out of the chain (or switched the primary): the primary
  assert.deepEqual(effectiveOf(['c'], 'b', { action: 'none' }), { id: 'c', reason: 'primary' });
  // decide carries it: on the backup inside the dwell -> stays there
  const st = { account_active: { id: 'spare', reason: 'failover' }, account_switch_at: new Date(NOW - 5 * 60_000).toISOString(), observed: { alive: true, phase: 'idle', blocked: null } };
  assert.deepEqual(decide({ bot: 'alpha', cfg: { backup_accounts: ['spare'] }, state: st, launchAccount: 'spare', now: NOW }).effective, { id: 'spare', reason: 'failover' });
});
