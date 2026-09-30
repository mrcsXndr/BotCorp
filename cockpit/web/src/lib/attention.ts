// How one /api/attention item reads in the Inbox: its kind label and the one
// button it offers, from the server's `action.type` (attention.mjs).
import { COPY } from './copy';

export interface AttentionItem { bot?: string | null; kind: string; severity: 'warn' | 'bad'; text: string; action?: { type?: string; [k: string]: unknown } }

export const kindLabel = (kind: string): string => (COPY.kind as Record<string, string>)[kind] ?? kind.replace(/_/g, ' ');

// Where a non-inline item goes: a route in the SPA.
export function targetOf(it: AttentionItem): string {
  const bot = it.bot ? encodeURIComponent(it.bot) : '';
  switch (it.action?.type) {
    case 'unlock': return `/bots/${bot}/manage/secrets`;
    case 'tools': return `/bots/${bot}/manage/tools`;
    case 'run': return `/bots/${bot}/manage/automations`;
    case 'usage': return '/accounts';
    case 'release': return '/updates';
    case 'pair': return `/bots/${bot}/manage/telegram`;
    default: return bot ? `/bots/${bot}` : '/';
  }
}

// The item's text: the server's, except where it names an engine (the kind label says it all).
export const itemText = (it: AttentionItem): string => (it.kind === 'cc_rejected' ? '' : it.text);
