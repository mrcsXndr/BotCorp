import { useNavigate } from 'react-router';
import { useAccountLink, useApprovals, useAttention, useTgDeny, useTgPair, type ApprovalEntry } from '../../api/queries';
import { AnimatedItems, Button, Disclosure, EmptyState, ListItem, SkeletonRow, toast, useConfirm } from '../../ui';
import { ScreenHeader } from '../../app/ScreenHeader';
import { Icon } from '../../icons';
import { itemText, kindLabel, targetOf, type AttentionItem } from '../../lib/attention';
import { ago } from '../../lib/settings';
import { COPY, t } from '../../lib/copy';
import { ApprovalCard } from './ApprovalCard';

interface Decided { bot: string; id: string; decision: 'approved' | 'rejected'; by: string; at: string | null; path: string; value: string }
interface AdminAct { at: string; by: string; verb: string; target: string | null; refused: string | null }
// Who decided: "operator:x" is x, "bot:x" an admin bot acting for the operator.
const deciderOf = (by: unknown) => {
  const m = /^bot:(.+)$/.exec(String(by ?? ''));
  return m ? t(COPY.inbox.adminBot, { bot: m[1] }) : String(by ?? '').replace(/^operator:/, '');
};

// The one place a bot's ask lands (IA §2): pending approvals as cards, every
// other thing that needs the operator as a row with its one button, then
// Decided and Done-by-an-admin-bot folded away at the bottom.
export function InboxScreen() {
  const attention = useAttention();
  const approvals = useApprovals();
  const nav = useNavigate();
  const link = useAccountLink();
  const pair = useTgPair();
  const deny = useTgDeny();
  const items = (attention.data?.items || []) as unknown as AttentionItem[];
  const pending = new Map((approvals.data?.pending || []).map((p) => [`${p.bot}/${p.id}`, p as ApprovalEntry]));
  const cards: ApprovalEntry[] = [];
  const rows: AttentionItem[] = [];
  for (const it of items) {
    const p = it.kind === 'approval' ? pending.get(`${it.bot}/${String(it.action?.id)}`) : undefined;
    if (p) cards.push(p); else rows.push(it);
  }
  const decided = (approvals.data?.recent || []) as unknown as Decided[];
  const admin = (approvals.data?.admin || []) as unknown as AdminAct[];
  const fail = (e: unknown) => toast((e as Error).message, 'bad');

  const [confirmSheet, ask] = useConfirm();
  const doLink = async () => {
    const c = COPY.confirm.link;
    if (!(await ask({ title: c.title, body: c.body, verb: c.verb, cancel: COPY.button.cancel, safe: true }))) return;
    link.mutateAsync(undefined).then(() => toast(COPY.toast.linked, 'ok'), fail);
  };

  const button = (it: AttentionItem) => {
    const a = it.action || {};
    if (a.type === 'link') {
      return <Button variant="tonal" isDisabled={link.isPending} onPress={doLink}>{COPY.button.link}</Button>;
    }
    if (a.type === 'pair' && it.bot) {
      const senderId = String(a.senderId);
      return (
        <>
          <Button variant="tonal" icon="check" isDisabled={pair.isPending} onPress={() => pair.mutateAsync({ name: it.bot!, senderId }).then(() => toast(COPY.toast.paired, 'ok'), fail)}>{COPY.button.pair}</Button>
          <Button variant="quiet" isDisabled={deny.isPending} onPress={() => deny.mutateAsync({ name: it.bot!, senderId }).then(() => toast(COPY.toast.denied, 'ok'), fail)}>{COPY.button.deny}</Button>
        </>
      );
    }
    return <Button variant="secondary" onPress={() => nav(targetOf(it))}>{COPY.button.open}</Button>;
  };

  const total = cards.length + rows.length;
  return (
    <div className="mx-auto w-full max-w-[720px] pb-6">
      <ScreenHeader count={total || undefined}>{COPY.title.inbox}</ScreenHeader>
      {!attention.data || !approvals.data ? (
        <><SkeletonRow /><SkeletonRow /></>
      ) : total === 0 ? (
        <EmptyState className="py-12">{COPY.inbox.nothing}</EmptyState>
      ) : null}
      {cards.length > 0 && (
        <ul className="m-0 mb-2 px-4 py-0 list-none flex flex-col gap-3" data-approvals>
          <AnimatedItems>
            {cards.map((a) => <ListItem key={`${a.bot}/${a.id}`}><ApprovalCard a={a} /></ListItem>)}
          </AnimatedItems>
        </ul>
      )}
      {rows.length > 0 && (
        <ul className="m-0 mb-2 px-4 py-0 list-none flex flex-col gap-3" data-attention>
          <AnimatedItems>
            {rows.map((it, i) => {
              const text = it.kind === 'account_unlinked' ? COPY.inbox.linkLine : itemText(it);
              return (
                <ListItem key={`${it.kind}/${it.bot}/${i}`}>
                  <article aria-label={kindLabel(it.kind)} data-kind={it.kind} className="rounded-card p-4 bg-task">
                    <div className="flex items-start gap-3">
                      <Icon name="warn" size={18} className={`mt-0.5 ${it.severity === 'bad' ? 'text-bad' : 'text-warn'}`} />
                      <div className="flex-1 min-w-0">
                        <h3 className="m-0 text-body font-semibold leading-ui text-text">{kindLabel(it.kind)}</h3>
                        {(it.bot || text) && (
                          <p className="m-0 mt-0.5 text-sm text-text-2">{it.bot ? `${it.bot}${text ? ' · ' : ''}` : ''}{text}</p>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">{button(it)}</div>
                  </article>
                </ListItem>
              );
            })}
          </AnimatedItems>
        </ul>
      )}
      {(decided.length > 0 || admin.length > 0) && (
        <div className="mt-4 px-4 flex flex-col">
          {decided.length > 0 && (
            <Disclosure title={COPY.inbox.decided} meta={<span className="num">{decided.length}</span>}>
              <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
                {decided.map((d) => (
                  <li key={`${d.bot}/${d.id}`} className="flex flex-col">
                    <span className="text-ui text-text break-words">{d.path} <span className="text-text-3">· {d.bot}</span></span>
                    <span className="text-sm text-text-2">
                      <span className={`font-semibold ${d.decision === 'approved' ? 'text-ok' : 'text-bad'}`}>
                        {t(d.decision === 'approved' ? COPY.inbox.approved : COPY.inbox.rejected, { who: deciderOf(d.by) })}
                      </span>{d.at ? ` · ${ago(d.at)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          {admin.length > 0 && (
            <Disclosure title={COPY.inbox.adminDone} meta={<span className="num">{admin.length}</span>}>
              <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
                {admin.map((x, i) => (
                  <li key={`${x.at}/${i}`} className="flex flex-col">
                    <span className="text-ui text-text break-words">{x.verb}{x.target ? ` ${x.target}` : ''}</span>
                    <span className="text-sm text-text-2">
                      {x.refused ? <span className="font-semibold text-bad">{COPY.inbox.refused}</span> : null}{x.refused ? ' · ' : ''}{x.by} · {ago(x.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
      {confirmSheet}
    </div>
  );
}
