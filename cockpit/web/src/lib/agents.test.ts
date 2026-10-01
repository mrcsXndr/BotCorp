import { expect, test } from 'vitest';
import { agentIcon, elapsed, shortModel } from './agents';

test('an agent type picks its mark; anything else is the plain agent mark', () => {
  expect(agentIcon('planner')).toBe('board');
  expect(agentIcon('senior-coder')).toBe('term');
  expect(agentIcon('critic')).toBe('check');
  expect(agentIcon('Explore')).toBe('search');
  expect(agentIcon('general-purpose')).toBe('agent');
});

test('a model id reads short; an unknown one as is', () => {
  expect(shortModel('claude-opus-5-5')).toBe('opus 5.5');
  expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
  expect(shortModel('claude-opus-5-5[1m]')).toBe('opus 5.5');
  expect(shortModel('gpt-x')).toBe('gpt-x');
  expect(shortModel(null)).toBe('');
});

test('elapsed: seconds, minutes, hours', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  expect(elapsed('2026-10-01T11:59:18Z', now)).toBe('42s');
  expect(elapsed('2026-10-01T11:53:00Z', now)).toBe('7m');
  expect(elapsed('2026-10-01T10:55:00Z', now)).toBe('1h 5m');
  expect(elapsed(null, now)).toBe('');
});
