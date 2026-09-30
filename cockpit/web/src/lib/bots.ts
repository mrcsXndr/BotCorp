// The bot list's decisions, free of React: which section a bot sits in, the one
// state word and tone its row shows, how many things it has in the Inbox, and
// which account a new chat starts on. Engine-neutral: no pid, no session kind.
import type { DotTone } from '../ui/Dot';

export interface BotLike {
  name: string; service?: string; running?: boolean; phase?: string | null;
  blocked?: unknown; down?: string | null; startedAt?: string | null;
}

// Pinned = the daemon keeps it running (harness.service: daemon, the default
// when bot.yaml says nothing); a chat is service: manual.
export const isPinned = (b: BotLike): boolean => b.service !== 'manual';

const when = (b: BotLike): number => { const t = Date.parse(String(b.startedAt || '')); return Number.isFinite(t) ? t : 0; };

// Pinned by name; chats newest first (last start, then the name: a chat's
// name is its creation stamp, chat-MMDD-HHMM).
export function splitBots<T extends BotLike>(bots: readonly T[]): { pinned: T[]; chats: T[] } {
  const pinned = bots.filter(isPinned).sort((a, b) => a.name.localeCompare(b.name));
  const chats = bots.filter((b) => !isPinned(b)).sort((a, b) => when(b) - when(a) || b.name.localeCompare(a.name));
  return { pinned, chats };
}

// The one state word (at most 4 words, lower case) and the dot's tone, from
// the phase every reader shows (core/state.mjs PHASES).
// `launching`: a Start is in flight from this cockpit, so it reads "starting"
// even before the daemon has written the phase.
export function botStatus(b: BotLike, launching = false): { word: string; tone: DotTone } {
  if (b.running && (b.blocked || b.phase === 'blocked')) return { word: 'waiting on you', tone: 'warn' };
  if (b.running) return { word: b.phase === 'idle' || b.phase === 'working' ? b.phase : 'running', tone: 'ok' };
  if (launching) return { word: 'starting', tone: 'accent' };
  if (b.down || b.phase === 'down') return { word: 'down', tone: 'bad' };
  if (b.phase === 'starting') return { word: 'starting', tone: 'accent' };
  return { word: 'stopped', tone: 'idle' };
}

// /api/attention items per bot (an item with no bot is machine-wide).
export function attentionByBot(items: readonly { bot?: unknown }[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items || []) if (typeof it.bot === 'string' && it.bot) out[it.bot] = (out[it.bot] || 0) + 1;
  return out;
}

// GET /api/updates: is a newer release there to apply?
export function hasUpdate(u: { available?: { actions?: string[] }[] } | undefined): boolean {
  return !!u && Array.isArray(u.available) && u.available.some((r) => Array.isArray(r.actions) && r.actions.includes('apply'));
}

// The header's account name: the registered account the session's token
// belongs to, else the one bot.yaml names; null when neither is an Account
// (no "own token" wording: every chain entry is an Account, IA §3).
export function accountLabel(reading: { tokenLast4?: string; na?: string } | null | undefined,
  accounts: readonly { id: string; label?: string; masked?: string | null }[] | undefined, configured: string | null | undefined): string | null {
  const list = accounts || [];
  const last4 = reading && !reading.na && reading.tokenLast4 ? String(reading.tokenLast4) : '';
  const hit = (last4 && list.find((a) => a.masked && String(a.masked).endsWith(last4))) || (configured && list.find((a) => a.id === configured));
  return hit ? String(hit.label || hit.id) : null;
}

// The account a new chat starts on: an account in state ok with the most
// headroom (the lower of its 5 h / 7 d readings; no reading counts as full
// headroom). Null when none is usable.
export interface AccountLike { id: string; state?: string; fiveHour?: { pct?: number } | null; sevenDay?: { pct?: number } | null }
export function mostHeadroom(accounts: readonly AccountLike[] | undefined): string | null {
  const used = (a: AccountLike) => Math.max(Number(a.fiveHour?.pct) || 0, Number(a.sevenDay?.pct) || 0);
  const ok = (accounts || []).filter((a) => a.state === 'ok');
  if (!ok.length) return null;
  return ok.reduce((best, a) => (used(a) < used(best) ? a : best)).id;
}
