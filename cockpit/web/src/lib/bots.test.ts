import { test, expect } from 'vitest';
import { accountLabel, attentionByBot, botStatus, hasUpdate, mostHeadroom, splitBots, stopAndArchive } from './bots';

test('accountLabel: the token\'s account, else the configured one, else nothing', () => {
  const accounts = [{ id: 'studio', label: 'Studio', masked: '****St01' }, { id: 'spare', label: 'Spare', masked: '****Sp02' }];
  expect(accountLabel({ tokenLast4: 'Sp02' }, accounts, 'studio')).toBe('Spare');
  expect(accountLabel({ na: 'no reading' }, accounts, 'studio')).toBe('Studio');
  expect(accountLabel({ tokenLast4: 'zzzz' }, accounts, null)).toBeNull();
});

test('splitBots: daemon (or unset) is Pinned by name; manual is a chat, newest first', () => {
  const { pinned, chats } = splitBots([
    { name: 'zeta', service: 'daemon' },
    { name: 'chat-0929-1010', service: 'manual', startedAt: null },
    { name: 'alpha' },
    { name: 'chat-0930-0845', service: 'manual', startedAt: null },
    { name: 'chat-0101-0000', service: 'manual', startedAt: '2026-09-30T10:00:00Z' },
  ]);
  expect(pinned.map((b) => b.name)).toEqual(['alpha', 'zeta']);
  expect(chats.map((b) => b.name)).toEqual(['chat-0101-0000', 'chat-0930-0845', 'chat-0929-1010']);
});

test('botStatus: one engine-neutral word and a tone', () => {
  expect(botStatus({ name: 'a', running: true, phase: 'working' })).toEqual({ word: 'working', tone: 'ok' });
  expect(botStatus({ name: 'a', running: true, phase: 'unknown' })).toEqual({ word: 'running', tone: 'ok' });
  expect(botStatus({ name: 'a', running: true, phase: 'idle', blocked: { needs: 'x' } })).toEqual({ word: 'waiting on you', tone: 'warn' });
  expect(botStatus({ name: 'a', running: false, phase: 'down' })).toEqual({ word: 'down', tone: 'bad' });
  expect(botStatus({ name: 'a', running: false, phase: 'starting' })).toEqual({ word: 'starting', tone: 'accent' });
  expect(botStatus({ name: 'a', running: false, phase: null })).toEqual({ word: 'stopped', tone: 'idle' });
  // a Start in flight: starting, not stopped or down; a running bot is unaffected
  expect(botStatus({ name: 'a', running: false, phase: null }, true)).toEqual({ word: 'starting', tone: 'accent' });
  expect(botStatus({ name: 'a', running: false, phase: 'down' }, true)).toEqual({ word: 'starting', tone: 'accent' });
  expect(botStatus({ name: 'a', running: true, phase: 'idle' }, true)).toEqual({ word: 'idle', tone: 'ok' });
});

test('stopAndArchive: stop then archive, in that order; a stopped chat only archives; a failed stop archives nothing', async () => {
  const seq: string[] = [];
  const io = (stopOk = true) => ({
    stop: async (n: string) => { seq.push(`stop ${n}`); return { ok: stopOk, code: stopOk ? 0 : 1, err: 'still busy' }; },
    archive: async (n: string) => { seq.push(`archive ${n}`); return { ok: true, code: 0 }; },
  });
  await stopAndArchive({ name: 'chat-1', running: true }, io());
  expect(seq).toEqual(['stop chat-1', 'archive chat-1']);
  seq.length = 0;
  await stopAndArchive({ name: 'chat-2', running: false }, io());
  expect(seq).toEqual(['archive chat-2']);
  seq.length = 0;
  await expect(stopAndArchive({ name: 'chat-3', running: true }, io(false))).rejects.toThrow('still busy');
  expect(seq).toEqual(['stop chat-3']);
});

test('attentionByBot counts per bot and skips machine-wide items', () => {
  expect(attentionByBot([{ bot: 'a' }, { bot: 'a' }, { bot: null }, { bot: 'b' }])).toEqual({ a: 2, b: 1 });
  expect(attentionByBot(undefined)).toEqual({});
});

test('hasUpdate: only a release that can be applied', () => {
  expect(hasUpdate({ available: [{ actions: ['apply', 'skip'] }] })).toBe(true);
  expect(hasUpdate({ available: [{ actions: ['cancel'] }] })).toBe(false);
  expect(hasUpdate({ available: [] })).toBe(false);
  expect(hasUpdate(undefined)).toBe(false);
});

test('mostHeadroom: the ok account with the lowest peak use', () => {
  expect(mostHeadroom([
    { id: 'busy', state: 'ok', fiveHour: { pct: 80 }, sevenDay: { pct: 20 } },
    { id: 'calm', state: 'ok', fiveHour: { pct: 10 }, sevenDay: { pct: 40 } },
    { id: 'hit', state: 'limited', fiveHour: { pct: 0 } },
  ])).toBe('calm');
  expect(mostHeadroom([{ id: 'x', state: 'no-token' }])).toBeNull();
});
