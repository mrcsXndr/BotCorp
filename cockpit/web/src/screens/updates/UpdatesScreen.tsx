import type { ReactNode } from 'react';
import { useCockpit, useUpdateAction, useUpdates } from '../../api/queries';
import { Button, Disclosure, EmptyState, SkeletonRow, toast, useConfirm } from '../../ui';
import { ScreenHeader } from '../../app/ScreenHeader';
import { newestFirst, primaryTag, releaseStatus, scrub, type Release } from '../../lib/updates';
import { ago } from '../../lib/settings';
import { COPY, t } from '../../lib/copy';

type Action = 'apply' | 'skip' | 'rollback' | 'cancel';
const TONE = { warn: 'text-warn', bad: 'text-bad', idle: 'text-text-3' } as const;

function Notes({ r, open }: { r: Release; open?: boolean }) {
  const notes = (r.notes || []).filter((n) => scrub(n.title) || scrub(n.text));
  if (!notes.length) return null;
  return (
    <Disclosure title={COPY.row.releaseNotes} defaultExpanded={open} className="mt-1">
      <dl className="m-0 flex flex-col gap-2">
        {notes.map((n) => (
          <div key={n.title}>
            <dt className="text-ui font-semibold text-text">{scrub(n.title)}</dt>
            <dd className="m-0 text-ui text-text-2 break-words">{scrub(n.text)}</dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}

// One release: the installed one and every newer one share this card shell
// (`card`); History rows sit flat inside their fold.
function Block({ r, primary, expanded, card = false, installed = false, children, onAction }:
  { r: Release; primary?: boolean; expanded?: boolean; card?: boolean; installed?: boolean; children?: ReactNode; onAction: (r: Release, a: Action) => void }) {
  const st = installed ? { text: COPY.row.installed, tone: 'idle' as const } : releaseStatus(r);
  const acts = r.actions || [];
  const shell = card ? 'mx-4 mb-3 px-4 py-3.5 rounded-card bg-surface shadow-1' : 'px-4 py-3';
  return (
    <article {...(installed ? { 'data-installed': '' } : { 'data-release': r.tag })} className={shell}>
      <div className="flex items-baseline gap-2">
        <h3 className="m-0 num text-lg font-semibold text-text">{r.tag}</h3>
        {r.date && <span className="text-sm text-text-3">{ago(r.date)}</span>}
        {st && <span className={`ml-auto text-sm font-semibold ${TONE[st.tone]}`}>{st.text}</span>}
      </div>
      {scrub(r.summary) && <p className="m-0 mt-1 text-body leading-body text-text-2">{scrub(r.summary)}</p>}
      <Notes r={r} open={expanded} />
      {children}
      {acts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {acts.includes('apply') && <Button variant={primary ? 'primary' : 'secondary'} icon="upd" onPress={() => onAction(r, 'apply')}>{t(COPY.button.apply, { tag: r.tag })}</Button>}
          {acts.includes('rollback') && <Button variant="secondary" icon="restart" onPress={() => onAction(r, 'rollback')}>{COPY.button.rollback}</Button>}
          {acts.includes('skip') && <Button variant="quiet" onPress={() => onAction(r, 'skip')}>{COPY.button.skip}</Button>}
          {acts.includes('cancel') && <Button variant="quiet" onPress={() => onAction(r, 'cancel')}>{COPY.button.cancelRequest}</Button>}
        </div>
      )}
    </article>
  );
}

// `#/updates`, opened from the version card. Installed (its notes open), Newer
// (the first release that can be applied carries the page's one primary), and
// History, folded: the only home of Roll back. Never a build id.
export function UpdatesScreen() {
  const q = useUpdates();
  const host = useCockpit().data;
  const act = useUpdateAction();
  const [confirmSheet, ask] = useConfirm();
  const view = q.data as unknown as { installed: string | null; current: Release | null; available: Release[]; history: Release[] } | undefined;
  if (!view) return <div className="pt-6"><SkeletonRow /><SkeletonRow /></div>;
  const engine = host?.cc?.pinned;

  const onAction = async (r: Release, a: Action) => {
    const c = a === 'apply' ? COPY.confirm.apply : a === 'rollback' ? COPY.confirm.rollback : null;
    if (c && !(await ask({ title: t(c.title, { tag: r.tag }), body: c.body, verb: t(c.verb, { tag: r.tag }), cancel: COPY.button.cancel }))) return;
    try {
      const res = await act.mutateAsync({ tag: r.tag, action: a });
      if (!res.ok) throw new Error(String(res.err || res.out || `exit ${res.code}`).trim());
      toast(t(a === 'apply' ? COPY.toast.applying : a === 'rollback' ? COPY.toast.rollingBack : a === 'skip' ? COPY.toast.skippedTag : COPY.toast.requestCancelled, { tag: r.tag }), 'ok');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const cur = view.current;
  const available = newestFirst(view.available);
  const history = newestFirst(view.history);
  const primary = primaryTag(available);
  // one list, newest at the top: Newer, then the installed release, then History
  return (
    <div className="mx-auto w-full max-w-[720px] pb-8">
      <ScreenHeader>{COPY.title.updates}</ScreenHeader>
      <section data-newer aria-label={COPY.row.newer}>
        <h2 className="m-0 px-4 pb-1 text-sm font-semibold text-text-2">{COPY.row.newer}<span className="num ml-1.5 font-normal text-text-3">{available.length}</span></h2>
        {available.length ? available.map((r, i) => <Block key={r.tag} card r={r} primary={r.tag === primary} expanded={i === 0} onAction={onAction} />)
          : <EmptyState inline>{COPY.status.upToDate}</EmptyState>}
      </section>
      <div className="mt-5">
        <Block card installed expanded onAction={onAction}
          r={cur ?? { tag: view.installed ? `v${String(view.installed).replace(/^v/, '')}` : '' } as Release}>
          {engine && (
            <p data-engine className="m-0 mt-2 text-sm text-text-2">
              {COPY.row.engine} · <span className="num">{COPY.row.engineName} {engine}</span>
            </p>
          )}
        </Block>
      </div>
      {history.length > 0 && (
        <section data-history className="mt-4 px-4">
          <Disclosure title={COPY.row.history} meta={<span className="num">{history.length}</span>}>
            <div className="-ml-6">{history.map((r) => <Block key={r.tag} r={r} onAction={onAction} />)}</div>
          </Disclosure>
        </section>
      )}
      {confirmSheet}
    </div>
  );
}
