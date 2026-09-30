// termReducer: one case per down-message type ptybridge.mjs and the pty-host
// send, plus the socket's reconnect and frame routing on a fake WebSocket.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { initialTermState, openTermSocket, termReducer, type ChatTurn, type TermEvent, type TermState } from './ws';

const run = (events: TermEvent[], from: TermState = initialTermState) => events.reduce(termReducer, from);
const turn = (text: string, role: ChatTurn['role'] = 'assistant'): ChatTurn => ({ role, text, ts: '2026-09-30T10:00:00.000Z' });
const chat = (x: Partial<Extract<TermEvent, { t: 'chat' }>>): TermEvent => ({ t: 'chat', hasSession: true, turns: [], cursor: 0, file: 's1', available: true, ...x });

describe('chat', () => {
  test('initial: replaces the turns and marks the view loaded', () => {
    const s = run([chat({ initial: true, turns: [turn('old')], cursor: 10 }), chat({ initial: true, turns: [turn('a'), turn('b')], cursor: 40 })]);
    expect(s.chat.turns.map((t) => t.text)).toEqual(['a', 'b']);
    expect(s.chat).toMatchObject({ loaded: true, hasSession: true, file: 's1', cursor: 40, epoch: 0 });
  });

  test('turns: a later push appends', () => {
    const s = run([chat({ initial: true, turns: [turn('a')], cursor: 10 }), chat({ turns: [turn('b', 'user'), turn('c')], cursor: 30 })]);
    expect(s.chat.turns.map((t) => t.text)).toEqual(['a', 'b', 'c']);
    expect(s.chat.cursor).toBe(30);
  });

  test('rotated: a new transcript clears the turns, bumps the epoch, and waits for the next initial', () => {
    const s = run([chat({ initial: true, turns: [turn('a')], cursor: 10 }), chat({ rotated: true, turns: [], cursor: 0, file: 's2' })]);
    expect(s.chat).toMatchObject({ loaded: false, turns: [], file: 's2', cursor: 0, epoch: 1 });
    const next = run([chat({ initial: true, turns: [turn('fresh')], cursor: 5, file: 's2' })], s);
    expect(next.chat).toMatchObject({ loaded: true, file: 's2', epoch: 1 });
    expect(next.chat.turns.map((t) => t.text)).toEqual(['fresh']);
  });

  test('no session yet: nothing to show, and a non-initial push keeps what is there', () => {
    const s = run([chat({ initial: true, hasSession: false, turns: [], file: null })]);
    expect(s.chat).toMatchObject({ loaded: true, hasSession: false, turns: [] });
  });

  test('unavailable: the reason, no turns; the terminal state is untouched', () => {
    const s = run([{ t: 'hello' }, chat({ initial: true, turns: [turn('a')] }), chat({ available: false, reason: 'transcript unreadable', hasSession: false, file: null })]);
    expect(s.chat).toMatchObject({ available: false, reason: 'transcript unreadable', turns: [] });
    expect(s.session).toBe('attached');
  });
});

test('status: the push minus its type replaces the last one', () => {
  const s = run([{ t: 'status', ts: 1, context: { used: 5, window: 10, pct: 50 } }, { t: 'status', ts: 2, context: { na: 'no status.json' } }]);
  expect(s.status).toEqual({ ts: 2, context: { na: 'no status.json' } });
});

test('err: kept as text, the last 20 only', () => {
  const s = run(Array.from({ length: 25 }, (_, i) => ({ t: 'err', m: `e${i}` }) as TermEvent));
  expect(s.errors).toHaveLength(20);
  expect(s.errors[0]).toBe('e5');
  expect(s.errors.at(-1)).toBe('e24');
});

test('stopped: no pty-host is up', () => {
  expect(run([{ t: 'stopped' }]).session).toBe('stopped');
});

test('detached: the pty-host went away', () => {
  expect(run([{ t: 'hello' }, { t: 'detached' }]).session).toBe('detached');
});

test('hello and exit: attached, then exited with its code; hello again clears the code', () => {
  const exited = run([{ t: 'hello' }, { t: 'exit', code: 3 }]);
  expect([exited.session, exited.exitCode]).toEqual(['exited', 3]);
  const back = run([{ t: 'hello' }], exited);
  expect([back.session, back.exitCode]).toEqual(['attached', null]);
});

describe('o (pty output)', () => {
  const login = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&state=x';
  test('a sign-in link raises the login bar once; dismissed, the same link does not come back', () => {
    const s = run([{ t: 'o', d: `\x1b[0mPaste this: ${login}\r\n` }]);
    expect(s.auth).toEqual({ url: login, shown: true });
    const dismissed = run([{ t: '@dismiss-auth' }, { t: 'o', d: login }], s);
    expect(dismissed.auth).toEqual({ url: login, shown: false });
    expect(run([{ t: 'o', d: login.replace('state=x', 'state=y') }], dismissed).auth.shown).toBe(true);
  });
  test('an artifact link is not a sign-in link, and plain output leaves the state object as it was', () => {
    const s = run([{ t: 'o', d: 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789' }]);
    expect(s.auth).toEqual({ url: null, shown: false });
    expect(termReducer(initialTermState, { t: 'o', d: 'hello world' })).toBe(initialTermState);
  });
});

test('socket lifecycle events and reset', () => {
  const s = run([{ t: '@connecting' }, { t: '@open' }, { t: 'stopped' }]);
  expect([s.conn, s.session]).toEqual(['open', 'stopped']);
  expect(run([{ t: '@closed' }], s).conn).toBe('closed');
  expect(run([{ t: '@reset' }], s)).toEqual({ ...initialTermState, conn: 'connecting' });
  expect(termReducer(s, { t: 'nope' } as unknown as TermEvent)).toBe(s);
});

// ---- openTermSocket on a fake WebSocket -------------------------------------------------
class FakeWS {
  static all: FakeWS[] = [];
  url: string; readyState = 0; sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeWS.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  push(obj: unknown) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
}
afterEach(() => { vi.useRealTimers(); FakeWS.all = []; });

test('socket: routes frames, sends input/resize/chat-reset, reconnects with backoff, stops on close()', () => {
  vi.useFakeTimers();
  const events: TermEvent[] = [];
  const output: string[] = [];
  const sock = openTermSocket('_example', { event: (e) => events.push(e), output: (d) => output.push(d) },
    { WebSocket: FakeWS as unknown as typeof WebSocket, location: { protocol: 'https:', host: 'cockpit.example' } });
  const a = FakeWS.all[0];
  expect(a.url).toBe('wss://cockpit.example/term/_example');
  sock.input('x');                                   // not open yet: dropped
  a.open();
  sock.input('hi\r'); sock.resize(80, 24); sock.chatReset();
  expect(a.sent.map((d) => JSON.parse(d))).toEqual([{ t: 'i', d: 'hi\r' }, { t: 'r', cols: 80, rows: 24 }, { t: 'chat-reset' }]);
  a.push({ t: 'o', d: 'abc' }); a.push('not json'); a.push({ t: 'stopped' });
  expect(output).toEqual(['abc']);
  expect(events.map((e) => e.t)).toEqual(['@connecting', '@open', 'o', 'stopped']);

  a.close();                                         // dropped by the server: retry after 1 s, then 2 s
  expect(events.at(-1)).toEqual({ t: '@closed' });
  vi.advanceTimersByTime(999); expect(FakeWS.all).toHaveLength(1);
  vi.advanceTimersByTime(1); expect(FakeWS.all).toHaveLength(2);
  FakeWS.all[1].close();
  vi.advanceTimersByTime(1999); expect(FakeWS.all).toHaveLength(2);
  vi.advanceTimersByTime(1); expect(FakeWS.all).toHaveLength(3);
  FakeWS.all[2].open();                              // a good open resets the backoff
  sock.close();
  vi.advanceTimersByTime(60000);
  expect(FakeWS.all).toHaveLength(3);
});

test('socket: a 4403 refusal asks for the operator once (no retry loop); paired, it reconnects; declined, it stops with the reason', async () => {
  vi.useFakeTimers();
  const events: TermEvent[] = [];
  const refuse = (ws: FakeWS) => { ws.open(); ws.push({ t: 'need', need: 'approve-token', m: 'needs the operator: pair' }); (ws.onclose as unknown as (e: { code: number }) => void)({ code: 4403 }); };
  let answer = true;
  const askNeed = vi.fn(async () => answer);
  const deps = { WebSocket: FakeWS as unknown as typeof WebSocket, location: { protocol: 'http:', host: 'x' }, askNeed };
  openTermSocket('_example', { event: (e) => events.push(e) }, deps);
  refuse(FakeWS.all[0]);
  expect(askNeed).toHaveBeenCalledWith('approve-token', 'needs the operator: pair');
  await vi.advanceTimersByTimeAsync(0);
  expect(FakeWS.all).toHaveLength(2);                 // paired: straight back, no backoff wait

  answer = false;
  refuse(FakeWS.all[1]);
  await vi.advanceTimersByTimeAsync(60000);
  expect(FakeWS.all).toHaveLength(2);                 // declined: no retry at all
  expect(events.at(-1)).toEqual({ t: 'err', m: 'needs the operator: pair' });
  expect(askNeed).toHaveBeenCalledTimes(2);
});
