// The Accounts page's decisions, free of the DOM: how an account's token, state
// and 5 h / 7 d windows read, and the id a new account gets. The plan is only
// ever read (detected server-side), never typed.
import { COPY, t } from './copy';

export interface WindowReading { pct?: number; resetsAt?: number | null; na?: string }

// `****PgAA` from the server -> `····PgAA`: the last four, never more.
export const maskedText = (masked: string | null | undefined): string => (masked ? `····${String(masked).slice(-4)}` : '');

const clock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function stateView(a: { state: string; blocked_until?: string | null }): { word: string; tone: 'ok' | 'warn' | 'bad' | 'idle' } {
  switch (a.state) {
    case 'ok': return { word: COPY.status.accOk, tone: 'ok' };
    case 'limited': {
      const d = a.blocked_until ? new Date(a.blocked_until) : null;
      return { word: t(COPY.status.accLimited, { time: d && !Number.isNaN(d.getTime()) ? clock(d) : '' }).trim(), tone: 'warn' };
    }
    case 'failed': return { word: COPY.status.accFailed, tone: 'bad' };
    default: return { word: COPY.status.accNoToken, tone: 'idle' };
  }
}

/** A window with a real reading. An account with none in either window shows
 *  one "No usage yet" line instead of its two meters. */
export const hasReading = (w: WindowReading | null | undefined): boolean => !!w && !w.na && Number.isFinite(w.pct);

// One meter's props: always a value (a window with no reading, beside one that
// has one, shows an empty meter reading "n/a"), and "resets 14:20" when the
// window says when.
export function windowView(w: WindowReading | null | undefined): { value: number; text: string; detail: string } {
  if (!w || w.na || !Number.isFinite(w.pct)) return { value: 0, text: COPY.row.noReading, detail: '' };
  const pct = Math.max(0, Math.min(100, Math.round(w.pct!)));
  const at = w.resetsAt ? new Date(w.resetsAt * 1000) : null;
  return { value: pct, text: `${pct}%`, detail: at && !Number.isNaN(at.getTime()) ? t(COPY.row.resets, { time: clock(at) }) : '' };
}

export const roleText = (u: { role: string; order: number }): string => (u.role === 'primary' ? COPY.row.primary : t(COPY.row.backupN, { n: u.order }));

// A new account's id: the label as a slug, else `acct-<last 4 of the token>`;
// a taken id gets -2, -3 ... (the server allows [a-z0-9-], at most 32).
export function newAccountId(label: string, token: string, taken: readonly string[]): string {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  const base = slug || `acct-${token.replace(/[^A-Za-z0-9]/g, '').slice(-4).toLowerCase() || 'new'}`;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}
