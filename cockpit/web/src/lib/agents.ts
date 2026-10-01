// A bot's subagents in the sidebar and on the agent screen, free of the DOM:
// which mark an agent type gets, a model id as a short chip, the elapsed time.
import type { IconName } from '../icons';

export function agentIcon(type: string): IconName {
  const t = String(type || '').toLowerCase();
  if (t.includes('plan')) return 'board';
  if (t.includes('critic') || t.includes('review')) return 'check';
  if (t.includes('explore') || t.includes('one-shot') || t.includes('search')) return 'search';
  if (t.includes('coder') || t.includes('code')) return 'term';
  return 'agent';
}

// claude-opus-5-5 -> opus 5.5; claude-haiku-4-5-20251001 -> haiku 4.5; anything else as is.
export function shortModel(id: string | null | undefined): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(String(id || ''));
  if (!m) return String(id || '');
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// 42s, 7m, 1h 5m: since `start`, at `now`.
export function elapsed(start: string | null | undefined, now = Date.now()): string {
  const t = Date.parse(String(start || ''));
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
