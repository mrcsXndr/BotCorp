import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatTurn, TermState } from '../../api/ws';
import { Disclosure, EmptyState, Skeleton } from '../../ui';
import { Icon } from '../../icons';
import { fmtTok, splitAttached, toolsLine } from '../../lib/cards';
import { renderMarkdown } from '../../lib/md';
import { LABEL, TERMINAL, type InboxStatus } from '../../lib/inbox';
import { fmtDuration, fmtWhen } from '../../lib/format';
import { COPY, t as tt } from '../../lib/copy';

// A message sent from the composer, until the transcript takes it.
export interface Sent {
  key: string; text: string; files: { name: string; size: string }[];
  id: string | null; status: InboxStatus | 'uploading'; detail: string; epoch: number;
}

// md.ts escapes every input character and emits only its own fixed tag set,
// so its output is the one string that may be set as HTML.
function Md({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function Chips({ files }: { files: { name: string; size: string }[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {files.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-xs bg-surface text-sm text-text" title={`${f.name} (${f.size})`}>
          <Icon name="clip" size={13} className="flex-none text-text-2" />
          <span className="truncate">{f.name}</span><span className="num text-xs text-text-3 flex-none">{f.size}</span>
        </span>
      ))}
    </div>
  );
}

function Meta({ children, tg }: { children: ReactNode; tg?: boolean }) {
  return <div className="mt-1 flex items-center gap-1.5 text-xs text-text-2">{tg && <Icon name="tg" size={13} />}{children}</div>;
}

const TASK_TONE: Record<string, string> = { completed: 'text-ok', done: 'text-ok', failed: 'text-bad', killed: 'text-bad', running: 'text-accent', stopped: 'text-text-3' };

function Turn({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'task') {
    const t = turn.task || { summary: '', status: '', durationMs: null, tokens: null, toolUses: null, result: '' };
    const bits = [fmtWhen(turn.ts), Number.isFinite(t.durationMs) ? fmtDuration(t.durationMs!) : '', Number.isFinite(t.tokens) ? tt(COPY.row.tokens, { n: fmtTok(t.tokens!) }) : '',
      Number.isFinite(t.toolUses) ? tt(COPY.row.toolUses, { n: t.toolUses! }) : ''].filter(Boolean);
    return (
      <div className="max-w-[92%] px-3.5 py-3 rounded-card bg-task">
        <div className="text-sm font-semibold"><span className={TASK_TONE[t.status] || 'text-text-2'}>{t.status || COPY.row.task}</span></div>
        <div className="mt-0.5 text-body text-text">{t.summary}</div>
        {bits.length > 0 && <div className="num mt-0.5 text-xs text-text-3">{bits.join(' · ')}</div>}
        {t.result && <Disclosure title={COPY.button.result} className="mt-1"><Md text={String(t.result)} /></Disclosure>}
      </div>
    );
  }
  if (turn.role === 'tg_out') {
    return (
      <div className="flex flex-col items-start">
        <div className="max-w-[85%] px-3.5 py-2.5 rounded-card rounded-bl-xs bg-sent shadow-[inset_0_0_0_1px_var(--sent-line)] text-body leading-body text-text"><Md text={turn.text || ''} /></div>
        <Meta tg>{[COPY.row.sentOnTelegram, fmtWhen(turn.ts)].filter(Boolean).join(' · ')}</Meta>
      </div>
    );
  }
  if (turn.role === 'transcript') {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] px-3.5 py-2.5 rounded-card rounded-br-xs bg-accent-soft text-body leading-body text-text">
          <div className="text-xs font-semibold text-text-2">{COPY.row.transcript}</div>
          <div className="whitespace-pre-wrap">{turn.text}</div>
        </div>
      </div>
    );
  }
  if (turn.role === 'user') {
    const tg = turn.meta?.channel === 'telegram';
    const att = !turn.meta ? splitAttached(turn.text) : null;
    const text = att && att.files.length ? att.body : turn.text || '';
    const meta = turn.meta ? [tg ? turn.meta.user || '' : turn.meta.source, fmtWhen(turn.meta.ts || turn.ts)].filter(Boolean).join(' · ') : fmtWhen(turn.ts);
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] min-w-0 px-3.5 py-2.5 rounded-card rounded-br-xs bg-accent-soft text-body leading-body text-text">
          {(turn.meta?.media || []).map((m, i) => (
            <div key={i} className="text-sm"><span className="font-semibold">{m.label || COPY.row.file}</span>{m.detail && <span className="text-text-2"> {m.detail}</span>}</div>
          ))}
          {text && <Md text={text} />}
          {att && <Chips files={att.files} />}
        </div>
        {meta && <Meta tg={tg}>{meta}</Meta>}
      </div>
    );
  }
  const tools = turn.tools?.length ? toolsLine(turn.tools) : '';
  return (
    <div className="flex flex-col items-start">
      <div className="max-w-[92%] min-w-0 px-3.5 py-3 rounded-card rounded-bl-xs bg-surface shadow-1 text-body leading-body text-text">
        {turn.text && <Md text={turn.text} />}
        {tools && <div className="mt-1.5 flex items-center gap-1.5 text-xs text-text-3"><Icon name="tool" size={13} className="flex-none" /><span className="truncate">{tools}</span></div>}
      </div>
    </div>
  );
}

function SentBubble({ s }: { s: Sent }) {
  const tone = s.status === 'failed' || s.status === 'expired' ? 'text-bad' : s.status === 'held' ? 'text-warn' : 'text-text-3';
  const label = s.status === 'uploading' ? COPY.status.uploading : LABEL[s.status];
  const say = (s.status === 'held' || s.status === 'expired' || s.status === 'failed') && s.detail ? `${label}: ${s.detail}` : label;
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[85%] min-w-0 px-3.5 py-2.5 rounded-card rounded-br-xs bg-accent-soft text-body leading-body text-text">
        {s.text && <div className="whitespace-pre-wrap break-words">{s.text}</div>}
        <Chips files={s.files} />
      </div>
      <div className={`mt-1 text-xs ${tone}`} title={s.detail}>{say}</div>
    </div>
  );
}

// The transcript, pushed over the bot's socket: it follows the newest turn
// until the operator scrolls up; then new turns count on the jump button.
export function ChatView({ chat, sent }: { chat: TermState['chat']; sent: Sent[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const count = chat.turns.length + sent.length;
  const last = useRef(count);
  useLayoutEffect(() => {
    const added = count - last.current;
    last.current = count;
    const el = box.current;
    if (!el) return;
    if (follow) el.scrollTop = el.scrollHeight;
    else if (added > 0) setUnseen((n) => n + added);
  }, [count, follow]);
  useEffect(() => { setFollow(true); setUnseen(0); }, [chat.epoch]);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (at !== follow) { setFollow(at); if (at) setUnseen(0); }
  };
  const toLatest = () => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; setFollow(true); setUnseen(0); };

  let body: ReactNode;
  if (!chat.loaded) body = <div className="px-4 py-6"><Skeleton lines={4} /></div>;
  else if (!chat.available) body = <EmptyState>{COPY.status.unavailable}</EmptyState>;
  else if (!chat.turns.length && !sent.length) body = <EmptyState>{chat.hasSession ? COPY.status.newSession : COPY.empty.noConversation}</EmptyState>;
  else {
    body = (
      <ul aria-label={COPY.row.conversation} className="m-0 p-0 list-none flex flex-col gap-3">
        {chat.turns.map((t, i) => <li key={`${chat.epoch}:${i}`}><Turn turn={t} /></li>)}
        {sent.map((s) => <li key={s.key}><SentBubble s={s} /></li>)}
      </ul>
    );
  }
  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={box} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4">
        <div className="mx-auto w-full max-w-[688px]">{body}</div>
      </div>
      {!follow && (
        <button type="button" onClick={toLatest} aria-label={unseen ? `${COPY.button.jumpLatest}, ${unseen}` : COPY.button.jumpLatest}
          className="absolute right-4 bottom-3 inline-flex items-center gap-1.5 min-h-[var(--tap)] px-3 rounded-btn bg-surface shadow-2 text-sm text-text outline-none
            transition-colors duration-[var(--t-fast)] ease-std hover:bg-task focus-visible:outline-2 focus-visible:outline-accent">
          <Icon name="down" />{unseen > 0 && <span className="num font-semibold text-accent">{unseen > 99 ? '99+' : unseen}</span>}
        </button>
      )}
    </div>
  );
}

// Is a sent message still moving through the inbox?
export const isOpen = (s: Sent) => s.status === 'uploading' || !TERMINAL.includes(s.status as InboxStatus);
