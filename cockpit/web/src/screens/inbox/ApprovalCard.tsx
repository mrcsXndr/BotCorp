import { useState } from 'react';
import { useDecide, type ApprovalEntry } from '../../api/queries';
import { Button, TextField, toast } from '../../ui';
import { Icon } from '../../icons';
import { approvalView, type ApprovalRow } from '../../lib/cards';
import { COPY } from '../../lib/copy';

// The one approval card: what is asked, what it widens in a sentence, the exact
// change in mono, who asked. Approve is one tap with no confirm; Decline opens
// an optional reason in place.
export function ApprovalCard({ a, inChat = false }: { a: ApprovalEntry; inChat?: boolean }) {
  const decide = useDecide();
  const v = approvalView(a as ApprovalRow);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const go = async (decision: 'approve' | 'reject') => {
    try {
      await decide.mutateAsync({ name: a.bot, id: a.id, decision, reason: decision === 'reject' ? reason.trim() || undefined : undefined });
      toast(decision === 'approve' ? COPY.toast.approved : COPY.toast.declined, 'ok');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <article aria-label={v.title} data-approval={a.id}
      className={`rounded-card p-4 ${inChat ? 'bg-warn-soft shadow-[inset_0_0_0_1px_var(--warn-line)]' : 'bg-task'}`}>
      <div className="flex items-start gap-3">
        <Icon name="apr" size={18} className="mt-0.5 text-text-2" />
        <div className="flex-1 min-w-0">
          <h3 className="m-0 text-body font-semibold leading-ui text-text">{v.title}</h3>
          <p className="m-0 mt-0.5 text-sm text-text-2">{v.asker === `Asked by ${a.bot}` ? `${a.bot} asked` : `${a.bot} · ${v.asker}`}</p>
        </div>
      </div>
      {v.widens !== 'other' && <p className="m-0 mt-3 text-ui leading-body text-text-2">{v.widensText}</p>}
      <div className="num mt-3 px-3 py-2.5 rounded-btn bg-field text-sm text-text overflow-x-auto whitespace-nowrap">{v.change}</div>
      {declining ? (
        <div className="mt-3 flex flex-col gap-2">
          <TextField label={COPY.inbox.declineReason} placeholder={COPY.inbox.tellWhy} value={reason} onChange={setReason} autoFocus />
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button variant="danger" isDisabled={decide.isPending} onPress={() => go('reject')}>{COPY.button.decline}</Button>
            <Button variant="quiet" onPress={() => setDeclining(false)}>{COPY.inbox.keepOpen}</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
          <Button variant="tonal" icon="check" isDisabled={decide.isPending} onPress={() => go('approve')}>{COPY.button.approve}</Button>
          <Button variant="quiet" onPress={() => setDeclining(true)}>{COPY.button.decline}</Button>
        </div>
      )}
    </article>
  );
}
