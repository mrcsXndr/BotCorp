import { useState, type ReactNode } from 'react';
import { AnimatedItems, Button, Dot, ListItem, toast } from '../ui';
import { KitScreen, ScreenTitle } from './Kit';
import { ApprovalCard } from './ApprovalCard';
import { APPROVALS, ATTENTION, DECIDED } from './fixtures';

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-1">
      <h2 className="m-0 px-4 pb-2 text-sm font-semibold text-text-2">
        {title}{count != null && <span className="num ml-1.5 font-normal text-text-3">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

// Inbox fixture: approvals first (Approve is one tap and the card leaves),
// then what else needs the operator, then what was decided.
export function KitInbox() {
  const [approvals, setApprovals] = useState(APPROVALS);
  const [attention, setAttention] = useState(ATTENTION);
  const [decided, setDecided] = useState(DECIDED);
  const decide = (id: string, out: 'approved' | 'declined') => {
    const a = approvals.find((x) => x.id === id)!;
    setApprovals((l) => l.filter((x) => x.id !== id));
    setDecided((l) => [{ id: `d-${id}`, title: a.title, bot: a.bot, out, who: 'you', when: 'now' }, ...l]);
    toast(`${out === 'approved' ? 'Approved' : 'Declined'}: ${a.title}`, 'ok');
  };
  const open = approvals.length + attention.length;
  return (
    <KitScreen nav="/_kit/inbox" header={<ScreenTitle count={open}>Inbox</ScreenTitle>}>
      {open === 0 && (
        <p className="m-0 px-4 py-8 text-body text-text-2">Nothing needs you. New approvals and questions from the bots land here.</p>
      )}
      {approvals.length > 0 && (
        <Section title="Approvals" count={approvals.length}>
          <ul className="m-0 p-0 list-none flex flex-col gap-3 px-4">
            <AnimatedItems>
              {approvals.map((a) => (
                <ListItem key={a.id}>
                  <ApprovalCard a={a} onApprove={() => decide(a.id, 'approved')} onDecline={() => decide(a.id, 'declined')} />
                </ListItem>
              ))}
            </AnimatedItems>
          </ul>
        </Section>
      )}
      {attention.length > 0 && (
        <Section title="Needs you" count={attention.length}>
          <ul className="m-0 p-0 list-none">
            <AnimatedItems>
              {attention.map((it) => (
                <ListItem key={it.id} className="flex gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`inline-flex items-center gap-1.5 font-semibold ${it.tone === 'bad' ? 'text-bad' : 'text-warn'}`}><Dot tone={it.tone} />{it.kind}</span>
                      <span className="text-text font-semibold truncate">{it.bot}</span>
                      <span className="ml-auto flex-none text-text-3">{it.when}</span>
                    </div>
                    <p className="m-0 mt-1 text-body leading-body text-text">{it.text}</p>
                    <div className="mt-2 flex gap-2">
                      <Button variant="secondary" onPress={() => toast(`${it.action}: ${it.bot}`)}>{it.action}</Button>
                      <Button variant="quiet" onPress={() => setAttention((l) => l.filter((x) => x.id !== it.id))}>Dismiss</Button>
                    </div>
                  </div>
                </ListItem>
              ))}
            </AnimatedItems>
          </ul>
        </Section>
      )}
      <Section title="Decided">
        <ul className="m-0 p-0 list-none pb-4">
          <AnimatedItems>
            {decided.map((d) => (
              <ListItem key={d.id} className="px-4 py-2.5">
                <div className="text-ui text-text">{d.title} <span className="text-text-3">· {d.bot}</span></div>
                <div className="text-sm text-text-2">
                  <span className={`font-semibold ${d.out === 'approved' ? 'text-ok' : 'text-bad'}`}>{d.out}</span> by {d.who} · {d.when}
                </div>
              </ListItem>
            ))}
          </AnimatedItems>
        </ul>
      </Section>
    </KitScreen>
  );
}
