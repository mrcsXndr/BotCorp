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
//   usage_blocked       status.json 5 h or 7 d >= 95%
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
export const USAGE_BLOCK_PCT = 95;
const CACHE_MS = 10_000;            // the page polls; the CLI reads behind it are not free
const SCAN_CACHE_MS = 60_000;

const SEVERITY = { bad: 0, warn: 1 };

// Pure: the inputs gathered below -> the sorted item list (bad first, then as found).
export function attentionItems({ bots: list = [], approvals = [], pairing = {}, status = [], autoState = {}, registry = {}, releases = [], installed = null, cc = null, usage = {} } = {}) {
  const items = [];
  const push = (bot, kind, severity, text, action) => items.push({ bot, kind, severity, text, action });
  for (const a of approvals) push(a.bot, 'approval', 'warn', `${a.bot} asks: ${a.diff}`, { type: 'approve', bot: a.bot, id: a.id });
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
      push(b.name, 'registry', r.missing.length ? 'bad' : 'warn', `${b.name}: tools registry has ${bits.join(', ')}`, { type: 'tools', bot: b.name });
    }
    const u = usage[b.name];
    const hot = u ? [['5 h', u.fiveHour], ['7 d', u.sevenDay]].filter(([, w]) => w && !w.na && w.pct >= USAGE_BLOCK_PCT) : [];
    if (hot.length) push(b.name, 'usage_blocked', 'bad', `${b.name}: ${hot.map(([k, w]) => `${k} limit at ${Math.round(w.pct)}%`).join(', ')}`, { type: 'usage' });
  }
  const newer = releases.filter((r) => r.status === 'pending' && !isOlder(r.tag, installed)).sort((a, b) => cmpVersion(b.tag, a.tag));
  if (newer.length) push(null, 'release', 'warn', `Release ${newer[0].tag} is ready to apply${newer.length > 1 ? ` (${newer.length} newer releases)` : ''}`, { type: 'release', tag: newer[0].tag });
  if (cc && cc.candidate && cc.candidate.status === 'rejected') push(null, 'cc_rejected', 'warn', `Claude Code ${cc.candidate.version} failed its canary and was not rolled out`, { type: 'release' });
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

let cache = { at: 0, promise: null };
export function invalidate() { cache = { at: 0, promise: null }; scans.clear(); }

async function gather() {
  const list = await bots.listBots();
  const [approvals, status, updates, pairs, autos, regs, usage] = await Promise.all([
    cliJson(['approvals', '--json'], []),
    cliJson(['status', '--json'], []),
    listUpdates(),
    Promise.all(list.filter((b) => b.telegram).map(async (b) => [b.name, await pairingState(b.name)])),
    Promise.all(list.map(async (b) => [b.name, await bots.automationState(b.name)])),
    Promise.all(list.filter((b) => b.tools !== null).map(async (b) => [b.name, await registryScan(b.name)])),
    Promise.all(list.map(async (b) => [b.name, await chatStatus(b)])),
  ]);
  let cc = null;
  try { cc = ccStatus(); } catch {}
  const items = attentionItems({
    bots: list, approvals, status: Array.isArray(status) ? status : [status], releases: updates.releases, installed: updates.installed, cc,
    pairing: Object.fromEntries(pairs), autoState: Object.fromEntries(autos),
    registry: Object.fromEntries(regs.filter(([, r]) => r)), usage: Object.fromEntries(usage),
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
    return { bot: b.name, running: b.running, account: s.account || { na: s.error || 'unreadable' }, fiveHour: s.fiveHour || { na: s.error }, sevenDay: s.sevenDay || { na: s.error }, model: s.model || null, effort: s.effort || null };
  }));
  const accounts = await cliJson(['accounts', 'list', '--json'], []);
  const groups = (Array.isArray(accounts) ? accounts : []).map((acc) => ({ id: String(acc.id || ''), label: String(acc.label || acc.id || ''), masked: acc.masked ? String(acc.masked) : null, registered: true, bots: [] }));
  for (const r of rows) {
    const k = accountKey(r.account);
    const g = groups.find((x) => x.registered && ((k.last4 && x.masked && x.masked.endsWith(k.last4)) || (k.email && x.label.toLowerCase() === k.email)))
      || groups.find((x) => !x.registered && x.id === k.key);
    if (g) g.bots.push(r.bot);
    else groups.push({ id: k.key, label: k.label, masked: null, registered: false, bots: [r.bot] });
  }
  return { at: new Date().toISOString(), bots: rows, accounts: groups };
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
