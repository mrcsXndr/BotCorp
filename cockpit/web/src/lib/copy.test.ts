// The copy lint (IA §6, §8): every string in COPY within its group's word cap,
// no engine- or transport-specific term, no build id. A `{slot}` counts as one word.
import { test, expect } from 'vitest';
import { COPY, t } from './copy';

const CAPS: Record<string, number> = {
  nav: 1, tab: 1, title: 2, button: 3, row: 3, status: 4, kind: 4, empty: 4, toast: 6, inbox: 12, module: 10, tooltip: 20,
  'confirm.title': 5, 'confirm.body': 10, 'confirm.verb': 3,
};

// [path, group cap key, text] for every string in COPY
function strings(): [string, string, string][] {
  const out: [string, string, string][] = [];
  const walk = (v: unknown, path: string[]) => {
    if (typeof v === 'string') {
      const cap = path[0] === 'confirm' ? `confirm.${path[path.length - 1]}` : path[0];
      out.push([path.join('.'), cap, v]);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(COPY, []);
  return out;
}
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const BANNED: [RegExp, string][] = [
  [/remote.?control/i, 'Remote Control is engine-specific'],
  [/\/login/i, 'an engine command'],
  [/via\s*access/i, 'transport jargon'],
  [/loopback/i, 'transport jargon'],
  [/\b[0-9a-f]{7,8}\b/i, 'a build id'],
  [/\bpid\b/i, 'a process id'],
  [/\bpty\b/i, 'a session kind'],
  [/—/, 'an em dash'],
];

test('every COPY string has a known cap', () => {
  const list = strings();
  expect(list.length).toBeGreaterThan(10);
  for (const [p, cap] of list) expect(CAPS[cap], `${p}: no cap for group ${cap}`).toBeDefined();
});

test('every COPY string is within its word cap', () => {
  const over = strings().filter(([, cap, s]) => words(s) > CAPS[cap]).map(([p, cap, s]) => `${p} (${words(s)} > ${CAPS[cap]}): ${s}`);
  expect(over).toEqual([]);
});

test('no banned term; setup-token only inside a tooltip', () => {
  const hits = strings().flatMap(([p, cap, s]) => [
    ...BANNED.filter(([re]) => re.test(s)).map(([, why]) => `${p}: ${why}: ${s}`),
    ...(cap !== 'tooltip' && /setup-token/i.test(s) ? [`${p}: setup-token outside a tooltip: ${s}`] : []),
  ]);
  expect(hits).toEqual([]);
});

test('the ? tooltips are the complex things only (v0.9.9: the two background helpers joined)', () => {
  const keys = Object.keys(COPY.tooltip).sort();
  expect(keys.every((k) => ['admin', 'autoFix', 'backups', 'context', 'debrief', 'lock', 'setupToken'].includes(k))).toBe(true);
});

test('t fills slots and leaves an unknown one visible', () => {
  expect(t('Show all {n}', { n: 12 })).toBe('Show all 12');
  expect(t('Restart {bot}', {})).toBe('Restart {bot}');
});
