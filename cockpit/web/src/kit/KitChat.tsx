import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Label, TextArea, TextField as RACTextField } from 'react-aria-components';
import { AnimatedItems, Disclosure, IconButton, ListItem, Menu, MenuItem, MenuSeparator, Segment, Segmented, Dot, toast } from '../ui';
import { Icon } from '../icons';
import { ApprovalCard } from './ApprovalCard';
import { APPROVALS } from './fixtures';

type Msg =
  | { id: string; kind: 'you'; text: string; meta: string; tg?: boolean }
  | { id: string; kind: 'bot'; body: ReactNode }
  | { id: string; kind: 'task'; status: string; who: string; summary: string; meta: string; result: string }
  | { id: string; kind: 'sent'; text: string; meta: string };

const MESSAGES: Msg[] = [
  { id: 'm1', kind: 'you', text: 'Ship the tools panel tonight?', meta: 'you · 22:41' },
  { id: 'm2', kind: 'you', tg: true, text: 'and make it readable on the phone', meta: 'Telegram · 22:43' },
  {
    id: 'm3', kind: 'bot', body: (
      <>
        <p className="m-0">On it. The order:</p>
        <ol className="m-0 mt-2 pl-5 list-decimal marker:text-text-2 flex flex-col gap-1">
          <li>tokens and primitives</li>
          <li>the kit at <code className="num px-1 py-px rounded-xs bg-field text-sm">#/_kit</code></li>
          <li>screenshots in light and dark</li>
        </ol>
      </>
    ),
  },
  { id: 'm4', kind: 'task', status: 'done', who: 'coder', summary: 'Port cards.js to TypeScript', meta: '4m 12s · 18 tests passed', result: 'src/lib/cards.ts: 209 lines, logic unchanged; vitest 18/18.' },
  { id: 'm5', kind: 'sent', text: 'The kit is up. Screenshots in ten minutes.', meta: 'Sent on Telegram · 22:47' },
];

function Bubble({ m }: { m: Msg }) {
  if (m.kind === 'you') {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] px-3.5 py-2.5 rounded-card rounded-br-xs bg-accent-soft text-body leading-body text-text">{m.text}</div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-text-2">
          {m.tg && <Icon name="tg" size={13} />}{m.meta}
        </div>
      </div>
    );
  }
  if (m.kind === 'bot') {
    return <div className="max-w-[92%] px-3.5 py-3 rounded-card rounded-bl-xs bg-surface shadow-1 text-body leading-body text-text">{m.body}</div>;
  }
  if (m.kind === 'task') {
    return (
      <div className="max-w-[92%] px-3.5 py-3 rounded-card bg-task">
        <div className="text-sm"><span className="font-semibold text-ok">{m.status}</span><span className="text-text-2"> · {m.who}</span></div>
        <div className="mt-0.5 text-body text-text">{m.summary}</div>
        <div className="num mt-0.5 text-xs text-text-3">{m.meta}</div>
        <Disclosure title="Result" className="mt-1"><span className="num text-sm">{m.result}</span></Disclosure>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start">
      <div className="max-w-[85%] px-3.5 py-2.5 rounded-card rounded-bl-xs bg-sent shadow-[inset_0_0_0_1px_var(--sent-line)] text-body leading-body text-text">{m.text}</div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-text-2"><Icon name="tg" size={13} />{m.meta}</div>
    </div>
  );
}

const KEYS = ['Esc', '^C', '^L', 'Tab', '↑', '↓', 'Enter'];

// Bot chat fixture: the header (name in the display face, state as coloured
// text, readouts in mono), Chat / Terminal, the transcript with a pending
// approval last, and the composer. The bottom bar gives way to the composer.
export function KitChat() {
  const [view, setView] = useState<'chat' | 'term'>('chat');
  const [text, setText] = useState('');
  const [sent, setSent] = useState<Msg[]>([]);
  const [pending, setPending] = useState(true);
  // the chat follows the newest turn (the pending approval is always last)
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { const l = listRef.current; if (l) l.scrollTop = l.scrollHeight; }, [sent.length, view]);
  const send = () => {
    if (!text.trim()) return;
    setSent((l) => [...l, { id: `s${l.length}`, kind: 'you', text: text.trim(), meta: 'you · now' }]);
    setText('');
  };
  return (
    <div className="h-dvh flex flex-col">
      <header className="flex-none bg-bg pt-[max(8px,env(safe-area-inset-top))] shadow-[0_1px_0_var(--line)]">
        <div className="flex items-center gap-1 pl-1 pr-1">
          <Link to="/_kit/bots" aria-label="Back to bots"
            className="grid place-items-center size-[var(--tap)] rounded-btn text-text-2 outline-none hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:outline-accent">
            <Icon name="chev" size={18} className="rotate-90" />
          </Link>
          <h1 className="m-0 ml-1 flex-1 min-w-0 truncate font-display text-xl leading-tight text-text">atlas</h1>
          <Menu label="Bot actions" onAction={(k) => toast(`${String(k)}: atlas (fixture)`)}>
            <MenuItem id="Restart" icon="restart">Restart</MenuItem>
            <MenuItem id="Restart fresh">Restart fresh</MenuItem>
            <MenuItem id="Session history" icon="board">Session history</MenuItem>
            <MenuSeparator />
            <MenuItem id="Stop" tone="bad">Stop</MenuItem>
          </Menu>
        </div>
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap px-4 pb-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-semibold text-ok"><Dot tone="ok" />running</span>
          <span className="inline-flex items-center gap-1 text-text-2"><Icon name="tg" size={13} />Telegram</span>
          <span className="text-text-2">context <span className="num text-text">42%</span></span>
          <span className="text-text-2">5 h <span className="num text-warn">81%</span></span>
        </div>
        <div className="px-4 pb-3">
          <Segmented aria-label="View" value={view} onChange={(k) => setView(k as 'chat' | 'term')} className="w-full">
            <Segment id="chat" icon="chat">Chat</Segment>
            <Segment id="term" icon="term">Terminal</Segment>
          </Segmented>
        </div>
      </header>

      {view === 'chat' ? (
        <>
          <ul ref={listRef} aria-label="Transcript" className="m-0 list-none flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-3 px-4 py-4">
            <AnimatedItems>
              {[...MESSAGES, ...sent].map((m) => <ListItem key={m.id}><Bubble m={m} /></ListItem>)}
              {pending && (
                <ListItem key="approval">
                  <ApprovalCard a={APPROVALS[0]} inChat
                    onApprove={() => { setPending(false); toast('Approved: Enable the browser tool', 'ok'); }}
                    onDecline={() => { setPending(false); toast('Declined: Enable the browser tool'); }} />
                </ListItem>
              )}
            </AnimatedItems>
          </ul>
          <form className="flex-none flex items-end gap-1.5 px-2 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] bg-bg shadow-[0_-1px_0_var(--line)]"
            onSubmit={(e) => { e.preventDefault(); send(); }}>
            <IconButton icon="clip" label="Attach a file" onPress={() => toast('Attach: fixture')} />
            <RACTextField aria-label="Message atlas" value={text} onChange={setText} className="flex-1 min-w-0">
              <Label className="sr-only">Message atlas</Label>
              <TextArea rows={1} placeholder="Message atlas"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                className="block w-full min-h-[var(--tap)] max-h-[calc(8*1.55em+20px)] px-3 py-[10px] rounded-btn bg-field border border-line-strong
                  text-body leading-body text-text outline-none resize-none [field-sizing:content] placeholder:text-text-3
                  data-[focused]:border-accent data-[focused]:shadow-[0_0_0_1px_var(--accent)]" />
            </RACTextField>
            <IconButton icon="send" label="Send" tone="accent" type="submit" isDisabled={!text.trim()} />
          </form>
        </>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col bg-term-bg">
          <pre className="num m-0 flex-1 min-h-0 overflow-auto p-3 text-sm leading-ui text-term-fg">{`> /status
  model   opus-5.5 (high)
  context 42% of 1M
  queue   0 waiting

> _`}</pre>
          <div className="grid grid-cols-7 gap-1 p-2 pb-[max(8px,env(safe-area-inset-bottom))] bg-bg">
            {KEYS.map((k) => (
              <button key={k} type="button" onClick={() => toast(`key ${k}: fixture`)}
                className="num min-h-[var(--tap)] rounded-btn bg-surface border border-line-strong text-sm text-text active:bg-task">{k}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
