import { expect, test } from 'vitest';
import {
  SETTINGS, autoStatus, boardWrites, chainBody, chainOf, moveItem, parseProjectLink, projectLinkOf, tierKey, toolWrite, triggerText, type ToolItem,
} from './settings';

test('a pasted project link becomes owner, number and type', () => {
  expect(parseProjectLink('https://github.com/users/acme/projects/7')).toEqual({ owner: 'acme', number: 7, type: 'user' });
  expect(parseProjectLink(' https://github.com/orgs/Acme-Co/projects/12/views/1?x=1 ')).toEqual({ owner: 'Acme-Co', number: 12, type: 'org' });
  for (const bad of ['', 'acme', 'https://github.com/acme/repo', 'https://github.com/users/acme/projects/x', 'https://evil.example/users/acme/projects/7', 'javascript:alert(1)']) {
    expect(parseProjectLink(bad), bad).toBeNull();
  }
});

test('the board writes: three fields and the module; an empty link turns it off', () => {
  expect(boardWrites({ owner: 'acme', number: 7, type: 'user' })).toEqual([
    { path: 'integrations.board.owner', value: 'acme' }, { path: 'integrations.board.number', value: 7 },
    { path: 'integrations.board.type', value: 'user' }, { path: 'harness.modules.board', value: true },
  ]);
  expect(boardWrites(null)).toEqual([{ path: 'harness.modules.board', value: false }]);
  const cfg = { integrations: { board: { owner: 'acme', number: 7, type: 'org' } } };
  expect(projectLinkOf(cfg)).toBe('https://github.com/orgs/acme/projects/7');
  expect(projectLinkOf({})).toBe('');
});

test('the curated table has no raw counts and no free-text model', () => {
  expect(SETTINGS.find((d) => d.id === 'model')!.kind).toBe('model');
  expect(SETTINGS.some((d) => d.path === 'automations' || d.path === 'secrets')).toBe(false);
  expect(SETTINGS.filter((d) => d.section === 'main').map((d) => d.id)).toEqual(['persona', 'model', 'keep', 'chain', 'taskBoard', 'reviewBoard']);
});

test('a model is a tier by name or by its id', () => {
  const tiers = [{ tier: 'top', id: 'claude-opus-5-5' }, { tier: 'workhorse', id: 'claude-sonnet-5-5' }];
  expect(tierKey('top', tiers)).toBe('top');
  expect(tierKey('claude-sonnet-5-5', tiers)).toBe('workhorse');
  expect(tierKey('claude-something-else', tiers)).toBeNull();
});

test('the chain is the primary then the backups, capped at 6, and one POST body', () => {
  expect(chainOf({ account: 'a', backups: ['b', 'c'] })).toEqual(['a', 'b', 'c']);
  expect(chainOf({ account: null, backups: ['b'] })).toEqual(['b']);
  expect(chainOf({ account: 'a', backups: ['1', '2', '3', '4', '5', '6', '7'] })).toHaveLength(6);
  expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  expect(chainBody(['a', 'b', 'c'])).toEqual({ primary: 'a', backups: ['b', 'c'] });
});

test('every automation status starts with Next, Last, Never or Failing', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const first = (s: string) => /^(Next|Last|Never|Failing)/.test(s);
  const cases = [
    autoStatus(undefined, true, now), autoStatus({ next_due: '2026-09-30T12:20:00Z' }, true, now),
    autoStatus({ last_end: '2026-09-30T10:00:00Z', last_exit: 0 }, false, now), autoStatus({ last_end: '2026-09-30T11:00:00Z', last_exit: 1 }, true, now),
    autoStatus({ failure_streak: 4, next_due: '2026-09-30T12:20:00Z' }, true, now),
  ];
  expect(cases.map((c) => c.text)).toEqual(['Never run', 'Next in 20 min', 'Last ok 2 h ago', 'Last failed 1 h ago', 'Failing, 4 runs in a row']);
  expect(cases.every((c) => first(c.text))).toBe(true);
  expect(triggerText({ interval_min: 30 })).toBe('Every 30 min');
});

test('a tool switch is one config write; a list switch adds or drops the item', () => {
  const base = { id: 'x', source: 'harness', kind: 'skill', name: 'x', on: true, locked: null } as const;
  const mod: ToolItem = { ...base, toggle: { path: 'harness.modules.sound', on: true, off: false } };
  expect(toolWrite(mod, false, {})).toEqual({ path: 'harness.modules.sound', value: false });
  const skill: ToolItem = { ...base, toggle: { list: 'harness.disable', item: 'skill:standup' } };
  const cfg = { harness: { disable: ['agent:critic'] } };
  expect(toolWrite(skill, false, cfg)).toEqual({ path: 'harness.disable', value: ['agent:critic', 'skill:standup'] });
  expect(toolWrite(skill, true, { harness: { disable: ['skill:standup', 'agent:critic'] } })).toEqual({ path: 'harness.disable', value: ['agent:critic'] });
  expect(toolWrite({ ...base, toggle: null, locked: 'x' }, true, cfg)).toBeNull();
});
