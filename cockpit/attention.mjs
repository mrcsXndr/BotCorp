// @ts-check
// attention.mjs - "N things need you": every operator decision a bot can park,
// in one list (GET /api/attention), plus the usage overview (GET /api/usage)
// and the recent approval decisions (GET /api/approvals).
//
// Read-only, from what the CLI and the daemon already produce:
//   approval            `approvals --json` (every bot's queue)
//   pairing             `pair <bot> --list --json` (Telegram bots)
//   vault_locked        `status --json` vault.locked
//   blocked / down      bots.mjs liveness (the doctor's checks)
//   automation_failing  <rt>/state/<bot>/automations.json failure_streak >= 3
//   registry            `tools <bot> scan --json` (bots with a tools: list)
//   release             <rt>/state/updates.json pending AND newer than the
//                       checkout; one item, for the newest
//   cc_rejected         core/cc.mjs candidate rejected by the canary
//   usage_blocked       status.json 5 h or 7 d >= 98%
//   account             bot.yaml account: already attempted by the newest
//                       launch, but the session runs another token (a
//                       fallback or a shared daemon); a switch not yet
//                       attempted is the Usage sheet's "at next idle" line
//   account_unlinked    `accounts seed --link --dry-run --json`: a bot runs on
//                       its own token that is not an Account yet, or a label
//                       is still "bot <name>" (Link = POST /api/accounts/link)
// Each item: {bot, kind, severity: warn|bad, text, action}. The action names
// what the page offers inline; every write still goes through the CLI.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as bots from './bots.mjs';
import { cliJson } from './cli.mjs';
import { pairingState } from './pairing.mjs';
import { listUpdates, isOlder, cmpVersion } from './updates.mjs';
import { chatStatus } from './chatstatus.mjs';
import { ccStatus } from '../core/cc.mjs';

export const STREAK_BAD = 3;        // plan Q6
export const USAGE_BLOCK_PCT = 98;
// The bar names a request the way its approval card does (web/src/lib/cards.ts
// approvalView title); the raw change stays in the card.
function approvalTitle(p) {
  const why = String(p.why || '').trim();
  return why && why !== 'widening' ? why[0].toUpperCase() + why.slice(1) : `Change ${p.path}`;
}
const CACHE_MS = 10_000;            // the page polls; the CLI reads behind it are not free
const SCAN_CACHE_MS = 60_000;

const SEVERITY = { bad: 0, warn: 1 };

// Pure: the inputs gathered below -> the sorted item list (bad first, then as found).
/**
 * @param {{ bots?: any[], approvals?: any[], pairing?: Record<string, any>, status?: any[], autoState?: Record<string, any>,
 *   registry?: Record<string, any>, releases?: any[], installed?: string | null, cc?: any, usage?: Record<string, any>,
 *   accounts?: any[], unlinked?: any }} [inputs]
 */
export function attentionItems({ bots: list = [], approvals = [], pairing = {}, status = [], autoState = {}, registry = {}, releases = [], installed = null, cc = null, usage = {}, accounts = [], unlinked = null } = {}) {
  const items = [];
  const push = (bot, kind, severity, text, action) => items.push({ bot, kind, severity, text, action });
  for (const a of approvals) push(a.bot, 'approval', 'warn', `${a.bot} asks: ${approvalTitle(a)}`, { type: 'approve', bot: a.bot, id: a.id });
  for (const [bot, p] of Object.entries(pairing)) {
    for (const q of (p && p.pending) || []) push(bot, 'pairing', 'warn', `${bot}: Telegram user ${q.senderId} asks to pair`, { type: 'pair', bot, senderId: q.senderId });
  }
  for (const s of status) {
    if (s && s.vault && s.vault.locked) push(s.name, 'vault_locked', 'bad', `${s.name}: vault locked, the bot cannot start until you unlock it`, { type: 'unlock', bot: s.name });
  }
  for (const b of list) {
    if (b.running && b.blocked) push(b.name, 'blocked', 'warn', `${b.name} is waiting on you: ${b.blocked.needs}`, { type: 'open', bot: b.name });
    else if (b.phase === 'down' || b.down) push(b.name, 'down', 'bad', `${b.name} is down${b.down ? `: ${b.down}` : ''}`, { type: 'open', bot: b.name });
    const st = autoState[b.name] || {};
    for (const a of b.automations || []) {
      const e = st[a.name];
      if (a.enabled && e && Number(e.failure_streak) >= STREAK_BAD) {
        push(b.name, 'automation_failing', 'warn', `${b.name}: ${a.name} failed ${e.failure_streak} runs in a row`, { type: 'run', bot: b.name, automation: a.name });
      }
    }
    const r = registry[b.name];
    if (r && (r.unregistered.length || r.missing.length)) {
      const bits = [r.unregistered.length && `${r.unregistered.length} unregistered`, r.missing.length && `${r.missing.length} missing`].filter(Boolean);
      push(b.name, 'registry', r.missing.length || r.registry === 'enforce' ? 'bad' : 'warn', `${b.name}: tools registry has ${bits.join(', ')}`, { type: 'tools', bot: b.name });
    }
    const u = usage[b.name];
    const hot = u ? [['5 h', u.fiveHour], ['7 d', u.sevenDay]].filter(([, w]) => w && !w.na && w.pct >= USAGE_BLOCK_PCT) : [];
    if (hot.length) push(b.name, 'usage_blocked', 'bad', `${b.name}: ${hot.map(([k, w]) => `${k} limit at ${Math.round(w.pct)}%`).join(', ')}`, { type: 'usage' });
    if (b.running && b.account && u && u.accountAttempted === b.account) {
      const acc = accounts.find((a) => a && a.id === b.account);
      const want = acc && acc.masked ? String(acc.masked).slice(-4) : null;
      if (want && (u.account && u.account.tokenLast4) !== want) {
        push(b.name, 'account', 'warn', `${b.name}: switch to ${b.account} did not land (fallback or shared daemon): botcorp doctor`, { type: 'usage' });
      }
    }
  }
  const newer = releases.filter((r) => r.status === 'pending' && !isOlder(r.tag, installed)).sort((a, b) => cmpVersion(b.tag, a.tag));
  if (newer.length) push(null, 'release', 'warn', `Release ${newer[0].tag} is ready to apply${newer.length > 1 ? ` (${newer.length} newer releases)` : ''}`, { type: 'release', tag: newer[0].tag });
  if (cc && cc.candidate && cc.candidate.status === 'rejected') push(null, 'cc_rejected', 'warn', `Claude Code ${cc.candidate.version} failed its canary and was not rolled out`, { type: 'release' });
  if (unlinked && ((unlinked.linked || []).length || (unlinked.relabeled || []).length)) {
    const bots = unlinked.linked || [];
    push(null, 'account_unlinked', 'warn', bots.length ? `${bots.join(', ')}: own token not linked as an account` : 'Accounts still named after bots', { type: 'link', bots });
  }
  return items.map((it, i) => [it, i]).sort((a, b) => SEVERITY[a[0].severity] - SEVERITY[b[0].severity] || a[1] - b[1]).map(([it]) => it);
}

const scans = new Map();   // bot -> {at, value}
async function registryScan(name) {
  const hit = scans.get(name);
  if (hit && Date.now() - hit.at < SCAN_CACHE_MS) return hit.value;
  const value = await cliJson(['tools', name, 'scan', '--json'], null);
  scans.set(name, { at: Date.now(), value });
  return value;
}

/** @type {{ at: number, promise: Promise<{ at: string, count: number, items: any[] }> | null }} */
let cache = { at: 0, promise: null };
export function invalidate() { cache = { at: 0, promise: null }; scans.clear(); }

async function gather() {
  const list = await bots.listBots();
  const [approvals, status, updates, pairs, autos, regs, usage, accounts] = await Promise.all([
    cliJson(['approvals', '--json'], []),
    cliJson(['status', '--json'], []),
    listUpdates(),
    Promise.all(list.filter((b) => b.telegram).map(async (b) => [b.name, await pairingState(b.name)])),
    Promise.all(list.map(async (b) => [b.name, await bots.automationState(b.name)])),
    Promise.all(list.filter((b) => b.tools !== null).map(async (b) => [b.name, await registryScan(b.name)])),
    Promise.all(list.map(async (b) => [b.name, await chatStatus(b)])),
    list.some((b) => b.account) ? cliJson(['accounts', 'list', '--json'], []) : [],
  ]);
  /** @type {ReturnType<typeof ccStatus> | null} */
  let cc = null;
  try { cc = ccStatus(); } catch {}
  // read-only (fingerprints, no decrypt); only when a bot has no account or a label is still "bot <name>"
  const unlinked = list.some((b) => !b.account && !b.name.startsWith('_')) || (Array.isArray(accounts) && accounts.some((a) => /^bot /.test(String(a.label || ''))))
    ? await cliJson(['accounts', 'seed', '--link', '--dry-run', '--json'], null) : null;
  const items = attentionItems({
    bots: list, approvals, status: Array.isArray(status) ? status : [status], releases: updates.releases, installed: updates.installed, cc,
    pairing: Object.fromEntries(pairs), autoState: Object.fromEntries(autos),
    registry: Object.fromEntries(regs.filter(([, r]) => r)), usage: Object.fromEntries(usage), accounts: Array.isArray(accounts) ? accounts : [], unlinked,
  });
  return { at: new Date().toISOString(), count: items.length, items };
}

export function collectAttention() {
  if (!cache.promise || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), promise: gather().catch((e) => { cache.at = 0; throw e; }) };
  }
  return cache.promise;
}

// The account a bot's session runs on, as a label and a key to group by.
function accountKey(a) {
  if (!a || a.na) return { key: 'unknown', label: 'account not recorded' };
  if (a.email) return { key: `email:${a.email.toLowerCase()}`, label: a.email, email: a.email.toLowerCase() };
  return { key: `token:${a.tokenLast4}`, label: `token ****${a.tokenLast4}`, last4: a.tokenLast4 };
}

// GET /api/usage: every bot's 5 h / 7 d reading, grouped under the account it
// runs on. A registered account (`botcorp accounts`) is matched by its masked
// token's last 4 or its email; a bot on anything else gets its own group.
export async function usageOverview() {
  const list = await bots.listBots();
  const rows = await Promise.all(list.map(async (b) => {
    const s = await chatStatus(b);
    // account_pending: bot.yaml account: differs from what the newest launch attempted (the tick rolls it at the next idle turn
    // boundary); a launch the failover engine put on one of the bot's backup_accounts is not a pending switch
    const att = s.accountAttempted || '';
    const onBackup = (b.backups || []).includes(att) && ['failover', 'failback', 'recover'].includes(s.accountReason);
    return { bot: b.name, running: b.running, account: s.account || { na: s.error || 'unreadable' }, account_wanted: b.account,
      backups: b.backups || [], account_attempted: s.accountAttempted ?? null, account_reason: s.accountReason || null,
      account_pending: (b.account || '') !== att && !onBackup, fiveHour: s.fiveHour || { na: s.error }, sevenDay: s.sevenDay || { na: s.error }, model: s.model || null, effort: s.effort || null };
  }));
  const accounts = await cliJson(['accounts', 'list', '--json'], []);
  const groups = (Array.isArray(accounts) ? accounts : []).map((acc) => ({ id: String(acc.id || ''), label: String(acc.label || acc.id || ''), masked: acc.masked ? String(acc.masked) : null, registered: true, bots: /** @type {string[]} */ ([]) }));
  for (const r of rows) {
    const k = accountKey(r.account);
    const g = groups.find((x) => x.registered && ((k.last4 && x.masked && x.masked.endsWith(k.last4)) || (k.email && x.label.toLowerCase() === k.email)))
      || groups.find((x) => !x.registered && x.id === k.key);
    if (g) g.bots.push(r.bot);
    else groups.push({ id: k.key, label: k.label, masked: null, registered: false, bots: [r.bot] });
  }
  return { at: new Date().toISOString(), bots: rows, accounts: groups };
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf-8')); } catch { return null; }
}

// GET /api/accounts: every registered account (`accounts list --json`) with
// its state and the bots on it. state: no-token | failed (a cached FAIL of the
// token check, or the daemon marked it failed in state/accounts.json) |
// limited (state/accounts.json blocked_until in the future) | ok. The 5 h /
// 7 d reading is the freshest bot's on that account (a limit is per account).
// `bots` lists every bot with the account it runs on and the one bot.yaml wants.
export async function accountsOverview() {
  const [rows, usage, limits, checks] = await Promise.all([
    cliJson(['accounts', 'list', '--json'], []),
    usageOverview(),
    readJson(path.join(bots.STATE_DIR, 'accounts.json')),
    readJson(path.join(bots.STATE_DIR, 'account-checks.json')),
  ]);
  const now = Date.now();
  const known = limits && limits.accounts && typeof limits.accounts === 'object' ? limits.accounts : {};
  const byBot = Object.fromEntries(usage.bots.map((r) => [r.bot, r]));
  const groupOf = (bot) => usage.accounts.find((g) => g.bots.includes(bot)) || null;
  const accounts = (Array.isArray(rows) ? rows : []).map((a) => {
    const id = String(a.id || '');
    const group = usage.accounts.find((g) => g.registered && g.id === id);
    const onIt = (group ? group.bots : []).map((n) => byBot[n]).filter(Boolean)
      .map((r) => ({ bot: r.bot, running: r.running, fiveHour: r.fiveHour, sevenDay: r.sevenDay, wanted: r.account_wanted, pending: r.account_pending }));
    const e = known[id] && typeof known[id] === 'object' ? known[id] : null;
    const until = e && e.blocked_until ? Date.parse(e.blocked_until) : NaN;
    // an entry with only the plan fields (detectPlan) is not a token check
    const c = a.fp && checks && checks[a.fp] && typeof checks[a.fp].ok === 'boolean' ? checks[a.fp] : null;
    const check = c ? { ok: !!c.ok, at: c.at || null, detail: String(c.detail || '') } : null;
    const failed = (e && e.failed) || (check && !check.ok ? { why: check.detail } : null);
    const state = !a.masked ? 'no-token' : failed ? 'failed' : Number.isFinite(until) && until > now ? 'limited' : 'ok';
    const pick = (k) => onIt.map((r) => r[k]).find((w) => w && !w.na) || (onIt[0] ? onIt[0][k] : null);
    // used_by: every bot whose chain names it; order is 1 for the primary, 1..5 for the backups
    const usedBy = usage.bots.flatMap((r) => (r.account_wanted === id ? [{ bot: r.bot, role: 'primary', order: 1 }]
      : (r.backups || []).includes(id) ? [{ bot: r.bot, role: 'backup', order: r.backups.indexOf(id) + 1 }] : []));
    return {
      id, label: String(a.label || id), plan: String(a.plan || ''), plan_source: a.plan_source || null, masked: a.masked ? String(a.masked) : null,
      state, blocked_until: Number.isFinite(until) ? new Date(until).toISOString() : null, window: (e && e.window) || null, failed, check,
      used_by: usedBy,
      wanted_by: usage.bots.filter((r) => r.account_wanted === id).map((r) => r.bot),
      bots: onIt, fiveHour: pick('fiveHour'), sevenDay: pick('sevenDay'),
    };
  });
  const botList = usage.bots.map((r) => {
    const g = groupOf(r.bot);
    return { bot: r.bot, running: r.running, account_wanted: r.account_wanted, account_pending: r.account_pending, on: g ? g.label : null, on_registered: !!(g && g.registered),
      backups: r.backups, account_attempted: r.account_attempted, account_reason: r.account_reason };
  });
  return { at: new Date().toISOString(), accounts, bots: botList };
}

// The last `limit` operator-only verbs an admin bot ran or was refused
// (state/admin-audit.jsonl, written by the CLI), newest first.
export async function adminActions(limit = 20) {
  let text = '';
  try { text = await fsp.readFile(path.join(bots.STATE_DIR, 'admin-audit.jsonl'), 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n').filter(Boolean).slice(-limit)) {
    try {
      const e = JSON.parse(line);
      out.push({ at: String(e.at || ''), by: String(e.by || ''), verb: String(e.verb || ''), target: e.target ? String(e.target) : null, refused: e.refused ? String(e.refused) : null });
    } catch {}
  }
  return out.reverse();
}

// The last `limit` decided approvals across bots (state/<bot>.approvals.history.jsonl,
// written by `botcorp approve|reject`), newest first: who decided, when, what.
export async function recentDecisions(limit = 20) {
  const list = await bots.listBots();
  const out = [];
  for (const b of list) {
    let text = '';
    try { text = await fsp.readFile(path.join(bots.STATE_DIR, `${b.name}.approvals.history.jsonl`), 'utf-8'); } catch { continue; }
    for (const line of text.split('\n').filter(Boolean).slice(-limit)) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const decision = e.approved_by ? 'approved' : e.rejected_by ? 'rejected' : null;
      if (!decision) continue;
      const v = JSON.stringify(e.value === undefined ? null : e.value);
      out.push({ bot: b.name, id: e.id, decision, by: e[`${decision}_by`], at: e[`${decision}_at`] || null, op: e.op || 'set', path: e.path,
        value: v.length > 80 ? v.slice(0, 77) + '...' : v, requested_by: e.requested_by || null, reason: e.rejected_reason || null });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}
