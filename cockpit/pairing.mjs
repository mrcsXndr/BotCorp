// pairing.mjs - Telegram pairing panel data.
//
// State and mutations both go through the CLI (`botcorp pair <bot> ...`), so
// there is exactly one implementation of the policy/allowlist/pending shape
// and of what "approve"/"deny" mean (writing allowFrom + approved/<senderId>
// + bot.yaml, exactly as the plugin's own skill does). The cockpit never
// reads or writes <config home>/channels/telegram/access.json itself, and
// never runs its own getUpdates to look up a username (that would 409 the
// live poller) — the panel shows id + age instead.

import { runCli } from './cli.mjs';

const SENDER_RE = /^[0-9]{1,20}$/;

export async function pairingState(bot) {
  const r = await runCli(['pair', bot, '--list', '--json']);
  if (r.code !== 0) return { present: false, reason: r.err || r.out || `pair --list failed (${r.code})`, pending: [], allowFrom: [] };
  let data;
  try { data = JSON.parse(r.out); } catch { return { present: false, reason: 'pair --list returned non-JSON', pending: [], allowFrom: [] }; }
  const pending = (Array.isArray(data.pending) ? data.pending : []).map((p) => ({
    code: String(p?.code ?? '').slice(0, 12),
    senderId: String(p?.senderId ?? ''),
    chatId: String(p?.chatId ?? ''),
    ageS: Number(p?.age_s) || 0,
    expiresInS: Number.isFinite(Number(p?.expires_in_s)) ? Number(p.expires_in_s) : null,
  })).filter((p) => SENDER_RE.test(p.senderId));
  return {
    present: true,
    dmPolicy: typeof data.policy === 'string' ? data.policy : null,
    allowFrom: (Array.isArray(data.allowFrom) ? data.allowFrom : []).map(String),
    pending,
  };
}

export async function approve(bot, senderId) {
  if (!SENDER_RE.test(String(senderId || ''))) throw new Error('senderId must be a numeric Telegram id');
  const r = await runCli(['pair', bot, String(senderId)]);
  if (r.code !== 0) throw new Error(`pair failed (${r.code}): ${r.err || r.out}`);
  return { ok: true, out: r.out };
}

export async function deny(bot, senderId) {
  if (!SENDER_RE.test(String(senderId || ''))) throw new Error('senderId must be a numeric Telegram id');
  const r = await runCli(['pair', bot, '--deny', String(senderId)]);
  if (r.code !== 0) throw new Error(`pair --deny failed (${r.code}): ${r.err || r.out}`);
  return { ok: true, out: r.out };
}
