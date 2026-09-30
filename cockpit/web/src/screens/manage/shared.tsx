import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApprovals, useConfigSet } from '../../api/queries';
import { IconButton, TextField, toast } from '../../ui';
import { Icon, type IconName } from '../../icons';
import { COPY, t } from '../../lib/copy';
import type { ConfigValue, Write } from '../../lib/settings';

/** A group on a manage tab: a quiet heading, then its rows. */
export function Group({ title, extra, children, className = '' }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-3 ${className}`}>
      {title != null && (
        <h2 className="m-0 flex items-center gap-2 text-sm font-semibold text-text-2">{title}{extra}</h2>
      )}
      {children}
    </section>
  );
}

/** "Waiting · Approve": a change that widens the bot is queued; the Inbox decides it. */
export function QueuedMark() {
  return (
    <Link to="/inbox" data-queued className="text-sm font-semibold text-warn no-underline outline-none hover:underline focus-visible:outline-2 focus-visible:outline-accent">
      {COPY.status.waiting}
    </Link>
  );
}

/** A quiet fact chip: an icon and a few words (cadence, model, a file, a time). */
export function Chip({ icon, tone = 'plain', mono, children }: { icon?: IconName; tone?: 'plain' | 'warn'; mono?: boolean; children: ReactNode }) {
  return (
    <span data-chip className={`inline-flex items-center gap-1.5 max-w-full px-2 py-0.5 rounded-xs text-sm ${tone === 'warn' ? 'bg-task text-warn font-semibold' : 'bg-task text-text-2'}`}>
      {icon && <Icon name={icon} size={14} className="flex-none" />}
      <span className={`truncate ${mono ? 'num' : ''}`}>{children}</span>
    </span>
  );
}

/**
 * A one-line description, edited in place. Blur or Enter ends it with the text
 * (onDone(text)); Escape ends it with null (nothing changes). Once only.
 */
export function DescriptionField({ name, value, onDone }: { name: string; value: string; onDone: (text: string | null) => void }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const end = (text: string | null) => { if (done.current) return; done.current = true; onDone(text); };
  return (
    <TextField aria-label={COPY.row.description} name={`${name}-description`} value={draft} onChange={setDraft} autoFocus maxLength={200} autoComplete="off"
      onBlur={() => end(draft.trim())} onKeyDown={(e) => {
        if (e.key === 'Enter') end(draft.trim());
        if (e.key === 'Escape') end(null);
      }} />
  );
}

/** Save one description (`automations.<n>.description`, `tools.<n>.purpose`): text only, never widening, "Saved". */
export function useDescribe(bot: string) {
  const { mutateAsync } = useConfigSet();
  return useCallback(async (path: string, text: string) => {
    try { await mutateAsync({ name: bot, path, value: text }); toast(COPY.toast.saved, 'ok'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  }, [bot, mutateAsync]);
}

/** A row's description with its pencil: the text, or the field while editing; saves only a change. */
export function Described({ name, value, onSave, children }: { name: string; value: string; onSave: (text: string) => void; children?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-1.5" data-described={name}>
      <div className="flex items-center gap-1">
        <div className="flex-1 min-w-0">{children}</div>
        {!editing && <IconButton icon="pen" size={16} label={t(COPY.button.editDescription, { name })} onPress={() => setEditing(true)} />}
      </div>
      {editing && <DescriptionField name={name} value={value} onDone={(text) => { setEditing(false); if (text !== null && text !== value.trim()) onSave(text); }} />}
    </div>
  );
}

export function FormError({ children }: { children?: string }) {
  return <p role="alert" data-form-error className="m-0 min-h-5 text-sm text-bad leading-ui break-words">{children}</p>;
}

/** The paths of this bot's approvals that are still pending (a queued change shows "Waiting"). */
export function usePendingPaths(bot: string): Set<string> {
  const a = useApprovals().data;
  return new Set((a?.pending || []).filter((p) => p.bot === bot).map((p) => String(p.path)));
}

/**
 * One `config set` at a time through POST /api/bots/:name/config. Applied:
 * "Applies on restart". Queued (it widens): the row shows Waiting, and a toast
 * says so once. A refusal is a toast in --bad. Resolves true when it landed.
 */
export function useSetter(bot: string) {
  const { mutateAsync } = useConfigSet();
  return useCallback(async (...writes: Write[]): Promise<boolean> => {
    try {
      let queued = false;
      for (const w of writes) {
        const r = await mutateAsync({ name: bot, path: w.path, value: w.value as ConfigValue });
        if (r.queued) queued = true;
      }
      toast(queued ? COPY.toast.waitingApproval : COPY.toast.appliesOnRestart, 'ok');
      return true;
    } catch (e) { toast((e as Error).message, 'bad'); return false; }
  }, [bot, mutateAsync]);
}
