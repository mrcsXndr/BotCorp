// The Updates page's decisions: what a release's status reads as, and the one
// rule that no build id ever reaches the screen (a hex run of 7 to 40
// characters, which is what a commit looks like).
import { COPY, t } from './copy';

export interface Release {
  tag: string; date?: string | null; summary?: string; notes?: { title: string; text: string }[]; tail?: string;
  status?: string; view?: string; actions?: string[]; included_in?: string | null; fail_reason?: string | null;
}

const SHA_LIKE = /\b[0-9a-f]{7,40}\b/gi;
export const scrub = (s: unknown): string => String(s ?? '').replace(SHA_LIKE, '').replace(/[ \t]{2,}/g, ' ').trim();

// Newest first by version (a date breaks a tie), whatever order the server sent:
// Newer and History both read top-down from the latest release.
const semver = (tag: string): number[] => (/(\d+)\.(\d+)\.(\d+)/.exec(tag) || [, 0, 0, 0]).slice(1).map(Number);
export function newestFirst<T extends { tag: string; date?: string | null }>(list: readonly T[]): T[] {
  const when = (r: T) => { const v = Date.parse(String(r.date ?? '')); return Number.isFinite(v) ? v : 0; };
  return [...list].sort((a, b) => {
    const x = semver(a.tag), y = semver(b.tag);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return when(b) - when(a);
  });
}

// One status word or two (never the reason a release failed: it can quote a build).
export function releaseStatus(r: Release): { text: string; tone: 'warn' | 'bad' | 'idle' } | null {
  switch (r.view) {
    case 'requested': case 'rollback_requested': return { text: COPY.status.appliesAtPause, tone: 'warn' };
    case 'will_be_included': case 'comes_with': return r.included_in ? { text: t(COPY.status.comesWith, { tag: r.included_in }), tone: 'idle' } : null;
    case 'failed': return { text: COPY.status.failed, tone: 'bad' };
    case 'skipped': return { text: COPY.status.skipped, tone: 'idle' };
    default: return null;
  }
}

// The one primary on the page: the first release in Newer that can be applied.
export const primaryTag = (available: readonly Release[]): string | null => available.find((r) => r.actions?.includes('apply'))?.tag ?? null;
