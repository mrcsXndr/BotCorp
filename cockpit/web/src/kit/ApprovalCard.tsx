import { useState } from 'react';
import { Button, TextField } from '../ui';
import { Icon } from '../icons';
import type { Approval } from './fixtures';

// The one approval card (Inbox, chat, Settings): the stamp and the request,
// what it widens in one sentence, the exact change in mono, who asked. Approve
// is one tap, no confirm. Decline opens an optional reason in place.
export function ApprovalCard({ a, inChat, onApprove, onDecline }: {
  a: Approval; inChat?: boolean; onApprove: () => void; onDecline: (reason: string) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <article aria-label={`Approval: ${a.title}`}
      className={`rounded-card p-4 ${inChat ? 'bg-warn-soft shadow-[inset_0_0_0_1px_var(--warn-line)]' : 'bg-task'}`}>
      <div className="flex items-start gap-3">
        <Icon name="apr" size={18} className="mt-0.5 text-text-2" />
        <div className="flex-1 min-w-0">
          <h3 className="m-0 text-body font-semibold leading-ui text-text">{a.title}</h3>
          <p className="m-0 mt-0.5 text-sm text-text-2">{a.bot} asked · {a.asked}</p>
        </div>
      </div>
      <p className="m-0 mt-3 text-ui leading-body text-text-2">
        Widens <span className="num text-text">{a.widens}</span>. {a.why}
      </p>
      <div className="num mt-3 px-3 py-2.5 rounded-btn bg-field text-sm text-text overflow-x-auto whitespace-nowrap">{a.change}</div>
      {declining ? (
        <div className="mt-3 flex flex-col gap-2">
          <TextField label="Reason (optional)" value={reason} onChange={setReason} placeholder="Tell the bot why" autoFocus />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="danger" onPress={() => onDecline(reason)}>Decline</Button>
            <Button variant="quiet" onPress={() => setDeclining(false)}>Keep it open</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="tonal" icon="check" onPress={onApprove}>Approve</Button>
          <Button variant="quiet" onPress={() => setDeclining(true)}>Decline</Button>
        </div>
      )}
    </article>
  );
}
