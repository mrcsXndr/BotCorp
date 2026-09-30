import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useArchive, useBots, useInbox, useLifecycle, useSend, useUpload, type Bot } from '../../api/queries';
import { useTermSocket } from '../../api/ws';
import { Banner, Button, EmptyState, IconButton, SkeletonRow, toast, useConfirm } from '../../ui';
import { fmtBytes } from '../../lib/cards';
import { stopAndArchive } from '../../lib/bots';
import { STATUSES, type InboxStatus } from '../../lib/inbox';
import { COPY, t } from '../../lib/copy';
import { BotHeader, type BotAction, type View } from './BotHeader';
import { ChatView, isOpen, type Sent } from './ChatView';
import { Composer } from './Composer';
import { TerminalView, type TermHandle } from './TerminalView';
import { SessionHistorySheet } from './SessionHistorySheet';

const statusOf = (v: unknown): InboxStatus => ((STATUSES as readonly unknown[]).includes(v) ? (v as InboxStatus) : 'failed');
const bracketed = (text: string) => `\x1b[200~${text.replace(/\r\n?/g, '\n')}\x1b[201~`;
let seq = 0;

/** `#/bots/:name`: the bot's header, then its chat or its terminal. */
export function BotScreen() {
  const { name = '' } = useParams();
  const bots = useBots();
  const bot = bots.data?.find((b) => b.name === name);
  if (!bots.data) return <div className="pt-6"><SkeletonRow /><SkeletonRow /></div>;
  if (!bot) return <EmptyState className="min-h-[60dvh]">{COPY.empty.noBot}</EmptyState>;
  return <BotBody key={bot.name} bot={bot} />;
}

function BotBody({ bot }: { bot: Bot }) {
  const nav = useNavigate();
  const term = useRef<TermHandle>(null);
  const [state, sock] = useTermSocket(bot.name, (d) => term.current?.write(d));
  const [view, setView] = useState<View>('chat');
  const [sent, setSent] = useState<Sent[]>([]);
  const [after, setAfter] = useState<Record<string, number>>({});   // turns already there when each was sent
  const [history, setHistory] = useState(false);
  const lifecycle = useLifecycle();
  const archive = useArchive();
  const send = useSend();
  const upload = useUpload();
  const inbox = useInbox(bot.name, sent.some((s) => s.id && isOpen(s)));

  // a sent message the transcript took leaves the pending list; a new transcript drops the rest
  const { turns, epoch } = state.chat;
  useEffect(() => {
    setSent((list) => {
      const next = list.filter((s) => {
        if (s.epoch !== epoch) return false;
        if (s.status === 'uploading') return true;
        const mine = (text: string) => (s.text.trim() ? text.trim().startsWith(s.text.trim()) : text.includes('[attached: '));
        return !turns.slice(after[s.key] ?? 0).some((tu) => tu.role === 'user' && mine(String(tu.text || '')));
      });
      return next.length === list.length ? list : next;
    });
  }, [turns, epoch, after]);

  // the inbox status line of every message still moving
  useEffect(() => {
    const rows = inbox.data;
    if (!rows) return;
    setSent((list) => list.map((s) => { const r = s.id ? rows.find((x) => x.id === s.id) : null; return r ? { ...s, status: statusOf(r.status), detail: String(r.detail || '') } : s; }));
  }, [inbox.data]);

  // a (re)connected socket hears the terminal's size; an `err` push is shown in the terminal
  useEffect(() => { if (state.conn === 'open') term.current?.fit(true); }, [state.conn]);
  // no pty-host behind the socket: say so in the terminal instead of leaving it blank
  useEffect(() => {
    if (state.session === 'stopped') term.current?.line(bot.running ? COPY.status.noTerminal : COPY.status.notRunning);
  }, [state.session]);   // the running flag at that moment is enough
  const errs = state.errors.length;
  const lastErr = errs ? state.errors[errs - 1] : '';
  useEffect(() => { if (lastErr) term.current?.line(lastErr); }, [errs, lastErr]);

  const update = (key: string, patch: Partial<Sent>) => setSent((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const onSend = async (text: string, files: File[]) => {
    const key = `s${++seq}`;
    setAfter((m) => ({ ...m, [key]: turns.length }));
    setSent((list) => [...list, { key, text, files: files.map((f) => ({ name: f.name || 'pasted', size: fmtBytes(f.size) })), id: null, status: files.length ? 'uploading' : 'sending', detail: '', epoch }]);
    try {
      const ids: string[] = [];
      for (const file of files) ids.push((await upload.mutateAsync({ name: bot.name, file })).id);
      const it = await send.mutateAsync({ name: bot.name, text, attachments: ids });
      update(key, { id: it.id, status: statusOf(it.status), detail: String(it.detail || '') });
    } catch (e) { update(key, { status: 'failed', detail: (e as Error).message }); }
  };
  const onTermFiles = async (files: File[]) => {
    try {
      for (const file of files) { const up = await upload.mutateAsync({ name: bot.name, file }); sock.input(`${bracketed(up.path)} `); }
      toast(COPY.toast.attached);
    } catch (e) { toast((e as Error).message, 'bad'); }
  };

  const run = async (action: 'start' | 'stop' | 'restart', fresh = false) => {
    toast(t(action === 'start' ? COPY.toast.starting : action === 'stop' ? COPY.toast.stopping : COPY.toast.restarting, { bot: bot.name }));
    try {
      const r = await lifecycle.mutateAsync({ name: bot.name, action, fresh });
      if (!r.ok) toast(String(r.err || r.out || `exit ${r.code}`).trim(), 'bad');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  // every destructive item waits for its ConfirmSheet (IA §7); Start never does
  const [confirmSheet, ask] = useConfirm();
  const confirmed = (c: { title: string; body: string; verb: string }) =>
    ask({ title: t(c.title, { bot: bot.name }), body: c.body, verb: t(c.verb, { bot: bot.name }), cancel: COPY.button.cancel });
  const onAction = async (a: BotAction) => {
    if (a === 'history') return setHistory(true);
    if (a === 'restart') return (await confirmed(COPY.confirm.restart)) && run('restart');
    if (a === 'fresh') return (await confirmed(COPY.confirm.fresh)) && run('restart', true);
    if (a === 'stop') return (await confirmed(COPY.confirm.stop)) && run('stop');
    if (a === 'stopArchive') {
      if (!(await confirmed(COPY.confirm.stopArchive))) return;
      try {
        await stopAndArchive(bot, {
          stop: (n) => lifecycle.mutateAsync({ name: n, action: 'stop' }),
          archive: (n) => archive.mutateAsync({ name: n }),
        });
        toast(t(COPY.toast.archived, { bot: bot.name }), 'ok'); nav('/');
      } catch (e) { toast((e as Error).message, 'bad'); }
      return;
    }
    nav(`/bots/${encodeURIComponent(bot.name)}/manage/${a}`);
  };

  return (
    <div className="h-full flex flex-col">
      <BotHeader bot={bot} status={state.status} view={view} onView={setView} onAction={onAction} onStart={() => run('start')} starting={lifecycle.isPending} />
      {(state.auth.shown || state.session === 'exited') && (
        <div className="flex-none flex flex-col gap-2 px-4 pt-2">
          {state.auth.shown && state.auth.url && (
            <Banner tone="info" action={<>
              <Button variant="quiet" onPress={() => window.open(state.auth.url!, '_blank', 'noopener')}>{COPY.button.open}</Button>
              <IconButton icon="x" label={COPY.button.dismiss} onPress={sock.dismissAuth} />
            </>}>{COPY.status.signIn}</Banner>
          )}
          {state.session === 'exited' && (
            <Banner tone="bad" action={<Button variant="quiet" onPress={() => run('start')}>{COPY.button.startAgain}</Button>}>{COPY.status.ended}</Banner>
          )}
        </div>
      )}
      {view === 'chat' && (
        <>
          <ChatView chat={state.chat} sent={sent} />
          <Composer bot={bot.name} onSend={onSend} />
        </>
      )}
      <TerminalView ref={term} visible={view === 'term'} onInput={sock.input} onResize={sock.resize} onFiles={onTermFiles} />
      <SessionHistorySheet bot={bot.name} isOpen={history} onClose={() => setHistory(false)} />
      {confirmSheet}
    </div>
  );
}
