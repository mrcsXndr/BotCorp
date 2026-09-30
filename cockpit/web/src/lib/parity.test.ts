// The 1:1 check: the classic cockpit/public/{cards,md,inbox}.js (still served at
// /classic until v0.9.1) and their src/lib ports give the same output for the
// same input. Delete this file together with cockpit/public in v0.9.1.
import { describe, test, expect } from 'vitest';
import cardsSrc from '../../../public/cards.js?raw';
import mdSrc from '../../../public/md.js?raw';
import inboxSrc from '../../../public/inbox.js?raw';
import * as cards from './cards';
import * as md from './md';
import * as inbox from './inbox';
import { PAYLOADS, serialize, stub, stubDoc } from '../test/safety';

// Each classic file is an IIFE that hangs its API on `window` (or globalThis).
type Api = Record<string, (...a: unknown[]) => unknown>;
function classic(src: string, name: string): Api {
  const box: Record<string, unknown> = {};
  new Function('window', 'globalThis', src)(box, box);
  return box[name] as Api;
}
const C = classic(cardsSrc, 'CockpitCards');
const M = classic(mdSrc, 'CockpitMarkdown');
const I = classic(inboxSrc, 'CockpitInbox');
const same = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));

describe('the port exports everything the classic file does', () => {
  test.each([['cards', C, cards], ['md', M, md], ['inbox', I, inbox]] as const)('%s', (_n, old, port) => {
    expect(Object.keys(port)).toEqual(expect.arrayContaining(Object.keys(old)));
  });
});

describe('cards', () => {
  const P = cards as unknown as Api;
  const cases: Record<string, unknown[][]> = {
    fmtTok: [[0], [999], [1000], [180000], [1e6], [1.5e6], [2e6]],
    lifecycleButtons: ['bg', 'pty', undefined].flatMap((kind) => [true, false].flatMap((running) => ['idle', 'down', 'stopped', null, undefined].map((phase) => [{ kind, running, phase }]))),
    widensOf: [['secrets'], ['automations.x.secrets'], ['integrations.telegram.allow_from'], ['account'], ['harness.hooks_disable'], ['tools.gh.enabled'], ['automations.x.enabled'], ['model'], [null], [undefined]],
    approvalView: [[{ path: 'tools', why: 'adds gh', requested_by: 'bot:demo', diff: 'tools: a -> b' }], [{ path: 'model', why: 'widening', requested_by: 'operator:x' }], [{ path: 'model', value: 3 }]],
    contextBar: [[{ used: 180000, window: 400000, pct: 45 }], [{ used: 1000, window: 4000 }], [{ used: 5, window: 0 }], [{ na: 'x' }], [null], [{ used: 500000, window: 400000, pct: 125 }]],
    accountName: [
      [{ tokenLast4: '9f3c', source: 's' }, [{ id: 'main', label: 'Main', masked: 'sk...9f3c' }], 'main'],
      [{ tokenLast4: '9f3c', source: 's' }, [{ id: 'main', label: 'Main', masked: 'sk...9f3c' }], 'main', 'failover'],
      [{ email: 'A@b.c', source: 's' }, [{ id: 'x', label: 'a@b.c' }], null, 'failback'],
      [{ source: 's' }, [{ id: 'main', label: 'Main' }], 'main', 'recover'],
      [{ tokenLast4: '0000' }, 'not a list'], [{ na: 'none' }, []], [null, []],
    ],
    configField: [['permissions', 'default'], ['effort', 'turbo'], ['role', null], ['account', 'a'], ['tools.gh', {}], ['name', 'x'], ['x.y', [1]], ['x', true], ['x', 3], ['x', 's'], ['constructor', 1]],
    configRows: [[{ a: 1, b: { c: [1, 2], d: { e: null, f: undefined } } }], [null], [[1]], [3, 'p']],
    configText: [[null], [undefined], [''], [[]], [['a', 1]], [[{}]], [[{}, {}]], [false], [0]],
    chainLine: [[null], [{ backups: [] }], [{ account_wanted: 'main', backups: ['a', 'b'] }], [{ backups: ['a'], account_reason: 'failover', account_attempted: 'a' }]],
    toolName: [['Bash'], ['mcp__plugin_telegram_telegram__reply'], ['mcp__github__create_issue'], [null]],
    toolsLine: [[['Bash', 'Bash', 'mcp__a_b__c-d']], [[]], [null]],
    fmtBytes: [[0], [1023], [1024], [1536], [1048576], [3.5 * 1048576], ['x']],
    attachView: [[{ name: 'a.PNG', size: 2048 }, 0], [{ name: 'x.exe', size: 1 }, 0], [{ name: 'Makefile', size: 1 }], [{ name: 'b.pdf', size: 21e6 }, 1], [{ name: 'e.txt', size: 0 }, 2], [{ name: 'a.md', size: 5 }, 10], [{ size: 5 }, 0]],
    splitAttached: [['hi\n[attached: C:\\u\\20260928-090507-a.png (png, 2 KB)] [Image #1]\n[attached: /u/b.pdf (pdf, 1.5 MB)]'], ['[attached: x] no'], [null]],
    authUrl: [['https://claude.ai/oauth/authorize?code=true&client_id=1'], ['https://claude.ai/code/artifact/0a1b2c3d-4e5f'], ['x https://accounts.google.com/o/oauth2/auth?a=1\x1b[0m'], ['https://claude.ai/share/x/login'], [null]],
    boardLink: [[null], ['x'], [{ url: null }], [{ url: 'https://claude.ai/artifact/0a1b2c3d-4e5f', open: 2, answered: 1 }], [{ url: 'https://claude.ai/code/artifact/0a1b2c3d-4e5f', open: '2' }], [{ url: 'javascript:alert(1)' }]],
  };
  test.each(Object.keys(cases))('%s', (fn) => {
    for (const args of cases[fn]) same(P[fn](...args), C[fn](...args));
  });
  test('constants', () => {
    same(cards.WIDENS, C.WIDENS);
    same(cards.ATTACH_EXT, C.ATTACH_EXT);
    same(cards.ATTACH_MAX, C.ATTACH_MAX);
  });
});

describe('md', () => {
  const corpus = [...PAYLOADS, '# A\n### B\n###### C', '- a\n- b\n  - c\n\n- d', '3. x\n4. y', '1. x\n   - y', '| a | b |\n|:-:|--:|\n| 1 | `2` |', 'a | b\nc',
    '```js\nconst a = 1 < 2;\n\n**x**\n```\nafter', '> q **b**\n> two', 'a\n\n---\n\nb', '**b** *i* _j_ `c` file_name 2 * 3 * 4', 'see https://x.example/a. and [m](mailto:a@b.example)',
    '\t- tab\r\n- crlf', '>'.repeat(20) + ' deep', 'x '.repeat(50) + '**'.repeat(30), null, undefined, 42];
  test('renderMarkdown', () => { for (const s of corpus) expect(md.renderMarkdown(s)).toBe(M.renderMarkdown(s)); });
  test('safeHref and esc', () => {
    for (const s of ['https://a', ' http://b ', 'mailto:x@y', 'javascript:x', '/rel', '', null, 'https://a b']) expect(md.safeHref(s)).toBe(M.safeHref(s));
    for (const s of ['<&>"\'', 'plain', 5]) expect(md.esc(s)).toBe(M.esc(s));
  });
});

describe('inbox', () => {
  const tree = (x: unknown) => serialize(stub(x));
  test('sentBubble + setStatus', () => {
    const files = [{ name: '<b>.png', size: '1 KB', image: true }, { name: 'b.pdf', size: '2 MB', image: false }];
    for (const [text, f] of [['hi', null], ['', files], [PAYLOADS[0], files]] as const) {
      const a = inbox.sentBubble(stubDoc(), text, f);
      const b = I.sentBubble(stubDoc(), text, f) as typeof a;
      expect(tree(a.node)).toBe(tree(b.node));
      expect(a.thumbs.map((t) => !!t)).toEqual(b.thumbs.map((t) => !!t));
      for (const item of [{ status: 'queued', detail: '' }, { status: 'held', detail: 'why' }, { status: 'failed', detail: '<x>' }, { status: 'nope' }, null]) {
        expect(inbox.setStatus(a.status, item)).toBe(I.setStatus(b.status, item));
        expect([a.status.className, a.status.textContent, a.status.title]).toEqual([b.status.className, b.status.textContent, b.status.title]);
      }
    }
  });
  test('chip and the status lists', () => {
    for (const v of [{ name: 'a.png', size: '1 KB', image: true }, { name: 'n.md', size: '1 B' }]) {
      expect(tree(inbox.chip(stubDoc(), v, () => {}).node)).toBe(tree((I.chip(stubDoc(), v, () => {}) as { node: unknown }).node));
    }
    same(inbox.STATUSES, I.STATUSES);
    same(inbox.TERMINAL, I.TERMINAL);
  });
});
