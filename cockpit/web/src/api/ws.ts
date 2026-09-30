// The /term/:bot socket (cockpit/ptybridge.mjs): one per open bot.
//   down: hello / o (pty output) / exit / err from the pty-host, plus the
//         cockpit's own pushes: chat (transcript turns), status (header
//         chips), stopped (no pty-host up), detached (the pty-host went away)
//   up:   i (input) / r (resize) / chat-reset
// termReducer is the whole client state of that socket, pure so every message
// type is tested (ws.test.ts). Pty output itself goes straight to the
// terminal (onOutput); the reducer only looks at it for a sign-in link.
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { authUrl } from '../lib/cards';
import { askNeed } from './http';

export interface ChatMedia { kind: string; label: string; detail: string }
export interface ChatTurn {
  role: 'user' | 'assistant' | 'transcript' | 'task' | 'tg_out';
  text?: string; ts?: string; tools?: string[]; replyTo?: string | null;
  meta?: { source: string; channel: string; user?: string; ts?: string; media: ChatMedia[] };
  task?: { summary: string; status: string; durationMs: number | null; tokens: number | null; toolUses: number | null; result: string };
}
// chatstatus.mjs summarizeStatus: every reading is a value or {na}.
export type StatusPush = Record<string, unknown> & { ts?: number | null };

export type Down =
  | { t: 'hello'; [k: string]: unknown }
  | { t: 'o'; d: string }
  | { t: 'exit'; code: number | null }
  | { t: 'err'; m: string }
  | { t: 'chat'; available?: boolean; reason?: string; rotated?: boolean; initial?: boolean; hasSession: boolean; turns: ChatTurn[]; cursor: number; file: string | null }
  | ({ t: 'status' } & StatusPush)
  | { t: 'stopped' }
  | { t: 'detached' }
  | { t: 'need'; need: string; m?: string };
// What the socket itself reports, and what the UI dispatches.
export type Local = { t: '@connecting' } | { t: '@open' } | { t: '@closed' } | { t: '@reset' } | { t: '@dismiss-auth' };
export type TermEvent = Down | Local;

export interface TermState {
  conn: 'idle' | 'connecting' | 'open' | 'closed';
  session: 'unknown' | 'attached' | 'stopped' | 'exited' | 'detached';
  exitCode: number | null;
  chat: {
    loaded: boolean;            // false until the first push, and again right after a rotation
    available: boolean; reason: string;
    hasSession: boolean; turns: ChatTurn[]; file: string | null; cursor: number;
    epoch: number;              // +1 per new transcript: the composer drops its sent-bubble matching
  };
  status: StatusPush | null;
  errors: string[];             // the last 20 `err` pushes
  auth: { url: string | null; shown: boolean };   // the login bar; a dismissed URL does not come back
}

export const initialTermState: TermState = {
  conn: 'idle', session: 'unknown', exitCode: null,
  chat: { loaded: false, available: true, reason: '', hasSession: false, turns: [], file: null, cursor: 0, epoch: 0 },
  status: null, errors: [], auth: { url: null, shown: false },
};

export function termReducer(s: TermState, e: TermEvent): TermState {
  switch (e.t) {
    case '@reset': return { ...initialTermState, conn: 'connecting' };
    case '@connecting': return { ...s, conn: 'connecting' };
    case '@open': return { ...s, conn: 'open' };
    case '@closed': return { ...s, conn: 'closed' };
    case '@dismiss-auth': return s.auth.shown ? { ...s, auth: { ...s.auth, shown: false } } : s;
    case 'hello': return { ...s, session: 'attached', exitCode: null };
    case 'o': {
      // the same length floor as the classic scan: a truncated URL is not a link
      const url = authUrl(e.d);
      return url && url.length >= 30 && url !== s.auth.url ? { ...s, auth: { url, shown: true } } : s;
    }
    case 'exit': return { ...s, session: 'exited', exitCode: typeof e.code === 'number' ? e.code : null };
    case 'err': return { ...s, errors: [...s.errors, String(e.m)].slice(-20) };
    case 'stopped': return { ...s, session: 'stopped' };
    case 'detached': return { ...s, session: 'detached' };
    case 'status': { const { t: _t, ...st } = e; return { ...s, status: st }; }
    case 'chat': {
      const c = s.chat;
      if (e.available === false) return { ...s, chat: { ...c, loaded: true, available: false, reason: String(e.reason || ''), turns: [] } };
      if (e.rotated) return { ...s, chat: { ...c, loaded: false, available: true, reason: '', hasSession: e.hasSession, turns: [], file: e.file, cursor: 0, epoch: c.epoch + 1 } };
      const turns = e.initial ? e.turns : e.hasSession ? [...c.turns, ...e.turns] : c.turns;
      return { ...s, chat: { ...c, loaded: true, available: true, reason: '', hasSession: e.hasSession, turns, file: e.file, cursor: e.cursor } };
    }
    default: return s;
  }
}

// ---- the socket ----------------------------------------------------------------------
export interface TermSocket { input(d: string): void; resize(cols: number, rows: number): void; chatReset(): void; close(): void }
export interface TermSocketDeps { WebSocket: typeof WebSocket; location: Pick<Location, 'protocol' | 'host'>; askNeed?: typeof askNeed }

// Reconnects with backoff (1 s doubling to 15 s) until close(). A close with
// 4403 is the server refusing a browser that is not the operator's: no retry
// loop, the need handler (pairing) runs once, and a yes reconnects.
export function openTermSocket(bot: string, on: { event(e: TermEvent): void; output?(d: string): void }, deps: TermSocketDeps = { WebSocket, location }): TermSocket {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  let closed = false;
  let need: { need: string; m: string } | null = null;
  const connect = () => {
    on.event({ t: '@connecting' });
    const proto = deps.location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new deps.WebSocket(`${proto}://${deps.location.host}/term/${encodeURIComponent(bot)}`);
    ws = sock;
    sock.onopen = () => { delay = 1000; on.event({ t: '@open' }); };
    sock.onmessage = (ev: MessageEvent) => {
      let msg: Down;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'o' && typeof msg.d === 'string') on.output?.(msg.d);
      if (msg.t === 'need') need = { need: String(msg.need), m: String(msg.m || 'needs the operator') };
      on.event(msg);
    };
    sock.onclose = (ev?: CloseEvent) => {
      if (ws !== sock) return;
      ws = null;
      on.event({ t: '@closed' });
      if (closed) return;
      if (ev?.code === 4403) {
        const n = need ?? { need: 'approve-token', m: 'needs the operator' };
        need = null;
        void (deps.askNeed ?? askNeed)(n.need, n.m).then((ok) => {
          if (closed) return;
          if (ok) connect();
          else on.event({ t: 'err', m: n.m });
        });
        return;
      }
      timer = setTimeout(connect, delay);
      delay = Math.min(15000, delay * 2);
    };
  };
  const send = (obj: unknown) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  connect();
  return {
    input: (d) => send({ t: 'i', d }),
    resize: (cols, rows) => send({ t: 'r', cols, rows }),
    chatReset: () => send({ t: 'chat-reset' }),
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      const s = ws;
      ws = null;
      try { s?.close(); } catch { /* already closed */ }
    },
  };
}

// The socket for the open bot, as React state. onOutput receives the raw pty
// frames (the terminal writes them); it may change between renders.
export function useTermSocket(bot: string | null, onOutput?: (d: string) => void) {
  const [state, dispatch] = useReducer(termReducer, initialTermState);
  const out = useRef(onOutput);
  useEffect(() => { out.current = onOutput; });
  const sock = useRef<TermSocket | null>(null);
  useEffect(() => {
    if (!bot) return;
    dispatch({ t: '@reset' });
    const s = openTermSocket(bot, { event: dispatch, output: (d) => out.current?.(d) });
    sock.current = s;
    return () => { s.close(); if (sock.current === s) sock.current = null; };
  }, [bot]);
  const actions = useMemo(() => ({
    input: (d: string) => sock.current?.input(d),
    resize: (cols: number, rows: number) => sock.current?.resize(cols, rows),
    chatReset: () => sock.current?.chatReset(),
    dismissAuth: () => dispatch({ t: '@dismiss-auth' }),
  }), []);
  return [state, actions] as const;
}
