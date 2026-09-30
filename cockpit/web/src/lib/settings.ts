// A bot's manage tabs, free of the DOM: the curated Settings table (IA §4),
// the GitHub project link, the account chain, the Automations status line and
// how a Tools switch becomes one `config set`. Nothing here renders "every leaf".

import type { COPY } from './copy';

export type ConfigValue = string | number | boolean | null | string[];
export interface Write { path: string; value: ConfigValue }

// ---- dotted reads ------------------------------------------------------------------
export function cfgGet(cfg: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), cfg);
}

// ---- the curated table -------------------------------------------------------------
// Each row is one control on a bot's Settings tab. `text` saves on blur or
// Enter; `switch` writes `on` / `off`; `also` are the writes that follow a
// change (a hub URL turns the hub module on). A chain and the diagnostics are
// their own components and are listed only to fix the order.
export type SettingKind = 'text' | 'switch' | 'model' | 'project' | 'chain' | 'diagnostics';
export interface SettingDef {
  id: string;
  section: 'main' | 'advanced';
  kind: SettingKind;
  label: keyof typeof COPY.row;
  path?: string;
  on?: ConfigValue;
  off?: ConfigValue;
  /** a COPY.tooltip key: the ? beside the label (only the complex things) */
  hint?: 'admin' | 'backups' | 'autoFix' | 'debrief';
  /** a background helper: its facts (GET /helpers) under the switch */
  detail?: 'autoFix' | 'debrief';
  /** shown only when this returns true (given the effective config and the bot) */
  when?: (cfg: unknown, bot: { telegram: boolean }) => boolean;
  also?: (value: string) => Write[];
}

export const SETTINGS: SettingDef[] = [
  { id: 'persona', section: 'main', kind: 'text', label: 'persona', path: 'persona' },
  { id: 'model', section: 'main', kind: 'model', label: 'model', path: 'model' },
  { id: 'keep', section: 'main', kind: 'switch', label: 'keepRunning', path: 'harness.service', on: 'daemon', off: 'manual' },
  { id: 'chain', section: 'main', kind: 'chain', label: 'chain' },
  { id: 'taskBoard', section: 'main', kind: 'project', label: 'taskBoard' },
  { id: 'reviewBoard', section: 'main', kind: 'switch', label: 'reviewBoard', path: 'harness.modules.review_board', on: true, off: false },
  { id: 'admin', section: 'advanced', kind: 'switch', label: 'adminBot', path: 'role', on: 'admin', off: null, hint: 'admin' },
  { id: 'adminNotify', section: 'advanced', kind: 'switch', label: 'tellMe', path: 'harness.admin_notify', on: true, off: false, when: (c) => cfgGet(c, 'role') === 'admin' },
  { id: 'autoFix', section: 'advanced', kind: 'switch', label: 'autoFix', path: 'harness.modules.alert_triage', on: true, off: false, hint: 'autoFix', detail: 'autoFix' },
  { id: 'debrief', section: 'advanced', kind: 'switch', label: 'debrief', path: 'harness.modules.debrief', on: true, off: false, hint: 'debrief', detail: 'debrief' },
  { id: 'hub', section: 'advanced', kind: 'text', label: 'hubUrl', path: 'integrations.hub.url',
    also: (v) => [{ path: 'harness.modules.hub', value: !!v }] },
  { id: 'backupRepo', section: 'advanced', kind: 'text', label: 'backupRepo', path: 'backup.git_remote' },
  { id: 'sound', section: 'advanced', kind: 'switch', label: 'sound', path: 'harness.modules.sound', on: true, off: false },
  { id: 'diagnostics', section: 'advanced', kind: 'diagnostics', label: 'diagnostics' },
];

// ---- the task board: one pasted project link -----------------------------------------
export interface ProjectLink { owner: string; number: number; type: 'user' | 'org' }
const PROJECT_RE = /^https?:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/projects\/(\d{1,6})(?:[/?#].*)?$/;
export function parseProjectLink(text: string): ProjectLink | null {
  const m = PROJECT_RE.exec(String(text || '').trim());
  return m ? { owner: m[2], number: Number(m[3]), type: m[1] === 'orgs' ? 'org' : 'user' } : null;
}
// The link back from a saved board, for the field's value.
export function projectLinkOf(cfg: unknown): string {
  const owner = cfgGet(cfg, 'integrations.board.owner');
  const number = cfgGet(cfg, 'integrations.board.number');
  const type = cfgGet(cfg, 'integrations.board.type');
  return owner && number ? `https://github.com/${type === 'org' ? 'orgs' : 'users'}/${owner}/projects/${number}` : '';
}
// A link sets the three board fields and turns the module on; an empty field turns it off.
export function boardWrites(link: ProjectLink | null): Write[] {
  return link
    ? [{ path: 'integrations.board.owner', value: link.owner }, { path: 'integrations.board.number', value: link.number },
      { path: 'integrations.board.type', value: link.type }, { path: 'harness.modules.board', value: true }]
    : [{ path: 'harness.modules.board', value: false }];
}

// ---- the model: a tier by name, never a typed id ---------------------------------------
export function tierKey(model: unknown, tiers: readonly { tier: string; id: string }[]): string | null {
  return tiers.find((t) => t.tier === model || t.id === model)?.tier ?? null;
}

// ---- the live list (what the pinned Claude Code offers) -------------------------------
// A tier is picked by its name; a live model by `live:<value>` and saved as its
// resolved id. CC's own "default" entry is left out: it is one of the others.
export interface LiveModelLike { value: string; resolvedModel: string; supportedEffortLevels: string[]; ultracodeAvailable: boolean | null }
export const liveOptions = <T extends LiveModelLike>(models: readonly T[]): T[] => models.filter((m) => m.value !== 'default');
export function modelKey(model: unknown, tiers: readonly { tier: string; id: string }[], live: readonly LiveModelLike[]): string | null {
  const tier = tierKey(model, tiers);
  if (tier) return tier;
  const m = liveOptions(live).find((x) => x.value === model || x.resolvedModel === model);
  return m ? `live:${m.value}` : null;
}
// The model id a configured value runs as: a tier's id, a live alias's resolved id, else itself.
export function resolvedId(model: unknown, tiers: readonly { tier: string; id: string }[], live: readonly LiveModelLike[]): string | null {
  if (model == null || model === '') return null;
  const t = tiers.find((x) => x.tier === model || x.id === model);
  if (t) return t.id;
  const m = live.find((x) => x.value === model || x.resolvedModel === model);
  return m ? m.resolvedModel : String(model);
}
// The live entry for a configured value, for its effort levels and ultracode.
export function liveModelOf<T extends LiveModelLike>(model: unknown, tiers: readonly { tier: string; id: string }[], live: readonly T[]): T | null {
  const id = resolvedId(model, tiers, live);
  return id ? liveOptions(live).find((m) => m.resolvedModel === id || m.value === id) ?? null : null;
}
// The effort choices: "" (the tier default) first, then the model's own levels;
// a saved level the model does not list stays so it can be seen and changed.
export function effortChoices(levels: readonly string[], current: unknown): string[] {
  const cur = typeof current === 'string' && current ? [current] : [];
  return ['', ...new Set([...levels, ...cur])];
}
// "Restart to apply": the session's own reading differs from the saved value.
// Only a reading from the session counts; `[1m]`-style suffixes are ignored.
export function needsRestart(live: { model?: { id?: string | null; source?: string } | null; effort?: { level?: string; source?: string } | null } | null | undefined,
  want: { model: string | null; effort: string | null }): boolean {
  const fromSession = (s?: string) => typeof s === 'string' && s.startsWith('the session');
  const bare = (id: string) => id.replace(/\[[^\]]*\]$/, '');
  if (live?.model?.id && fromSession(live.model.source) && want.model && bare(live.model.id) !== bare(want.model)) return true;
  if (live?.effort?.level && fromSession(live.effort.source) && want.effort && live.effort.level !== want.effort) return true;
  return false;
}
export const priceText = (p: { input: number; output: number } | null): string => (p ? `$${p.input}/$${p.output}` : '');

// ---- the account chain: [primary, ...backups], at most 6 -----------------------------
export const CHAIN_MAX = 6;
export const chainOf = (bot: { account: string | null; backups: string[] }): string[] => [...(bot.account ? [bot.account] : []), ...bot.backups].slice(0, CHAIN_MAX);
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}
// One POST body for /api/bots/:name/accounts.
export const chainBody = (chain: readonly string[]): { primary: string; backups: string[] } => ({ primary: chain[0], backups: chain.slice(1) });
export const sameChain = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- Automations: one status line, first word Next | Last | Never | Failing ---------------
export interface AutoState { next_due?: string; last_end?: string; last_ok?: string; last_exit?: number | null; last_result?: string; failure_streak?: number }
export function ago(iso: string | undefined, now = Date.now()): string {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
export function inFuture(iso: string | undefined, now = Date.now()): string {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  const s = Math.round((t - now) / 1000);
  if (s <= 60) return 'soon';
  return s < 3600 ? `in ${Math.round(s / 60)} min` : s < 86400 ? `in ${Math.round(s / 3600)} h` : `in ${Math.round(s / 86400)} d`;
}
export function autoStatus(s: AutoState | undefined, enabled: boolean, now = Date.now()): { text: string; tone: 'bad' | 'ok' | 'idle' | 'warn' } {
  const st = s || {};
  const streak = Number(st.failure_streak) || 0;
  if (streak >= 3) return { text: `Failing, ${streak} runs in a row`, tone: 'bad' };
  if (enabled && st.next_due) return { text: `Next ${inFuture(st.next_due, now)}`, tone: 'ok' };
  if (st.last_end) {
    const failed = st.last_exit != null && Number(st.last_exit) !== 0 && !String(st.last_result || '').startsWith('skipped');
    return { text: `Last ${failed ? 'failed' : 'ok'} ${ago(st.last_end, now)}`, tone: failed ? 'warn' : 'idle' };
  }
  return { text: 'Never run', tone: 'idle' };
}
export function triggerText(t: unknown): string {
  if (t && typeof t === 'object') {
    const o = t as { interval_min?: number; cron?: string; event?: string };
    if (o.interval_min != null) return `Every ${o.interval_min} min`;
    if (o.cron) return `Cron ${o.cron}`;
    if (o.event) return `On ${o.event}`;
  }
  return typeof t === 'string' ? t : '';
}

// ---- Tools: an inventory item's switch as one config write ------------------------------
export interface ToolItem {
  id: string; source: string; kind: string; name: string; description?: string; on: boolean; note?: string;
  locked: string | null; missing?: boolean; provider?: string;
  toggle: { path: string; on: ConfigValue; off: ConfigValue } | { list: string; item: string } | null;
}
export function toolWrite(item: ToolItem, checked: boolean, cfg: unknown): Write | null {
  const t = item.toggle;
  if (!t) return null;
  if ('path' in t) return { path: t.path, value: checked ? t.on : t.off };
  const cur = cfgGet(cfg, t.list);
  const list = Array.isArray(cur) ? cur.map(String) : [];
  // membership of the list turns it OFF
  return { path: t.list, value: checked ? list.filter((x) => x !== t.item) : [...new Set([...list, t.item])] };
}
// Modules the Tools tab never lists: plumbing nobody switches off from a phone (IA §4, §8).
export const HIDDEN_TOOLS = new Set(['cost_meter', 'usage_resume', 'lessons', 'telemetry', 'janitor'].map((m) => `module:${m}`));

export const TOOL_KIND: Record<string, string> = {
  skill: 'Skill', agent: 'Agent', hook: 'Guard', mcp: 'Connector', plugin: 'Plugin', module: 'Module', command: 'Command', rule: 'Rule', tool: 'Tool',
};
export type ToolFilter = 'all' | 'harness' | 'bot' | 'third';
export function itemPath(item: ToolItem): string | null {
  const t = item.toggle;
  return t ? ('path' in t ? t.path : t.list) : null;
}
