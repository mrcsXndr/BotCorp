// Ported from cockpit/tests/cards.test.mjs, the boardLink cases of
// review-board.test.mjs (fed the reviewBoard shapes getBot returns there) and
// the attachView / splitAttached cases of attach.test.mjs.
import { test, expect } from 'vitest';
import { lifecycleButtons, approvalView, contextBar, accountName, toolsLine, configField, configRows, configText, chainLine, boardLink, attachView, splitAttached, authUrl, ATTACH_MAX, type ApprovalRow } from './cards';

test('tools line: MCP tools read as plain words, repeats collapse', () => {
  expect(toolsLine(['mcp__plugin_telegram_telegram__reply'])).toBe('Telegram reply');
  expect(toolsLine(['Bash', 'Bash'])).toBe('Bash ×2');
  expect(toolsLine(['Bash', 'mcp__github__create_issue', 'Read', 'Bash', 'mcp__plugin_telegram_telegram__download_attachment'])).toBe(
    'Bash ×2, Github create issue, Read, Telegram download attachment');
  expect(toolsLine([])).toBe('');
});

test('lifecycle: a background bot never gets Stop; Start only while it is stopped', () => {
  for (const phase of ['idle', 'working', 'starting', 'down', 'stopped', null]) {
    for (const running of [true, false]) {
      const b = lifecycleButtons({ kind: 'bg', running, phase });
      expect(b.stop, `bg ${phase} running=${running}`).toBe(false);
      expect(b.restart).toBe(true);
      expect(b.start).toBe(!running && (phase === 'stopped' || phase === null));
    }
  }
  // a crashed background bot (down) recovers through Restart, not Start
  expect(lifecycleButtons({ kind: 'bg', running: false, phase: 'down' })).toEqual({ start: false, stop: false, restart: true, primary: null });
  expect(lifecycleButtons({ kind: 'bg', running: false, phase: 'stopped' }).primary).toBe('start');
});

test('lifecycle: a pty bot gets Stop and Restart while it runs, Start when it does not', () => {
  expect(lifecycleButtons({ kind: 'pty', running: true, phase: 'idle' })).toEqual({ start: false, stop: true, restart: true, primary: null });
  expect(lifecycleButtons({ kind: 'pty', running: false, phase: 'stopped' })).toEqual({ start: true, stop: false, restart: false, primary: 'start' });
  // no kind reported reads as a pty bot, never as one that cannot be stopped
  expect(lifecycleButtons({ running: true }).stop).toBe(true);
});

const row = (path: string, why: string, extra: Partial<ApprovalRow> = {}): ApprovalRow => ({ path, why, requested_by: 'bot:demo', value: 'x', diff: `${path}: a -> b`, ...extra });

test('approval: every widening path the CLI queues names what it widens', () => {
  const cases: [string, string, string][] = [
    ['secrets', 'declares a new vault secret', 'secrets'],
    ['automations.nightly.secrets', 'injects a vault secret into an automation', 'secrets'],
    ['integrations.telegram.allow_from', 'adds a Telegram sender', 'senders'],
    ['integrations.telegram.dm_policy', 'loosens dm_policy allowlist -> pairing', 'senders'],
    ['account', 'switches the Claude account', 'account'],
    ['permissions', 'switches permissions to bypass', 'exposure'],
    ['harness.hooks_disable', 'switches off guard hook config-guard', 'exposure'],
    ['harness.tools_registry', 'relaxes the tools registry enforce -> warn', 'exposure'],
    ['tools', 'registers an integration or secret-bearing tool (gh)', 'tools'],
    ['automations', 'adds an automation', 'jobs'],
    ['automations.nightly.enabled', 'enables automation nightly', 'jobs'],
    ['model', 'widening', 'other'],
  ];
  for (const [p, why, key] of cases) {
    const v = approvalView(row(p, why));
    expect(v.widens, p).toBe(key);
    expect(v.widensLabel && v.widensText, p).toBeTruthy();
  }
  const v = approvalView(row('harness.hooks_disable', 'switches off guard hook config-guard'));
  expect(v.title).toBe('Switches off guard hook config-guard');
  expect(v.change).toBe('harness.hooks_disable: a -> b');
  expect(v.asker).toBe('Asked by demo');
  // the bare fallback reason is not a title; an operator-queued entry says so
  expect(approvalView(row('model', 'widening', { requested_by: 'operator:someone' })).title).toBe('Change model');
  expect(approvalView(row('model', '', { requested_by: 'operator:someone' })).asker).toBe('Queued by someone');
});

test('context bar: used over the compaction ceiling, clamped, levelled; nothing invented', () => {
  expect(contextBar({ used: 180000, window: 400000, pct: 45, source: 'x' })).toEqual({ pct: 45, level: '', label: '180k / 400k' });
  expect(contextBar({ used: 320000, window: 400000, pct: 80 })).toMatchObject({ level: 'warn' });
  expect(contextBar({ used: 390000, window: 400000, pct: 97.6 })).toMatchObject({ level: 'bad' });
  expect(contextBar({ used: 500000, window: 400000, pct: 125 })).toMatchObject({ pct: 100 });
  expect(contextBar({ used: 1000, window: 4000 })).toMatchObject({ pct: 25 });
  expect(contextBar({ na: 'no transcript yet' })).toEqual({ na: 'no transcript yet' });
  expect(contextBar({ used: 5, window: 0 })).toHaveProperty('na');
});

test('account: the registered nickname shows; the token last 4 only in the title', () => {
  const accounts = [{ id: 'main', label: 'Main seat', masked: 'sk-a...9f3c' }, { id: 'spare', label: 'ops@example.com', masked: null }];
  const tok = accountName({ tokenLast4: '9f3c', source: 'injected token' }, accounts, 'spare');
  expect(tok.name).toBe('Main seat');
  expect(tok.title).toMatch(/\*\*\*\*9f3c/);
  expect(tok.name).not.toMatch(/9f3c/);
  expect(accountName({ email: 'OPS@example.com', source: '.claude.json' }, accounts).name).toBe('ops@example.com');
  const own = accountName({ tokenLast4: '0000', source: 'injected token' }, accounts, 'main');
  expect(own.name, 'a measured token that matches no account is not named after the configured one').toBe('Own token');
  expect(own.title).toMatch(/0000/);
  expect(accountName({ email: 'x@example.com', source: 's' }, []).name).toBe('x@example.com');
  expect(accountName({ na: 'no status yet' }, accounts).name).toBe('n/a');
});

test('account: a failover marks the name as a backup; failback and recover only the title', () => {
  const accounts = [{ id: 'spare', label: 'Spare seat', masked: 'sk-a...1b2c' }];
  const fo = accountName({ tokenLast4: '1b2c', source: 'injected token' }, accounts, 'main', 'failover');
  expect(fo.name).toBe('Spare seat (backup)');
  expect(fo.title).toMatch(/backup account after a usage limit/);
  const fb = accountName({ tokenLast4: '1b2c', source: 'injected token' }, accounts, 'spare', 'failback');
  expect(fb.name).toBe('Spare seat');
  expect(fb.title).toMatch(/back on its primary/);
  expect(accountName({ tokenLast4: '1b2c', source: 's' }, accounts, 'spare', 'primary').title).toBe('token ****1b2c · s');
  expect(accountName({ na: 'no status yet' }, accounts, null, 'failover').name).toBe('n/a');
});

test('config field: enums, booleans, numbers, text; lists and other pages read-only', () => {
  expect(configField('permissions', 'default')).toEqual({ kind: 'enum', options: ['bypass', 'default'] });
  const effort = configField('effort', 'turbo');
  expect(effort.kind === 'enum' && effort.options.slice(-1), 'an unknown current value stays selectable').toEqual(['turbo']);
  expect(configField('role', null)).toEqual({ kind: 'enum', options: [null, 'admin'] });
  expect(configField('harness.modules.debrief', false).kind).toBe('bool');
  expect(configField('harness.modules.janitor', 'report').kind).toBe('enum');
  expect(configField('integrations.hub.interval_s', 300).kind).toBe('number');
  expect(configField('persona', 'x').kind).toBe('text');
  expect(configField('harness.pin', null).kind).toBe('text');
  expect(configField('harness.hooks_disable', []).kind).toBe('readonly');
  expect(configField('account', 'acc1')).toMatchObject({ note: expect.stringMatching(/Accounts page/) });
  expect(configField('backup_accounts', [])).toMatchObject({ note: expect.stringMatching(/Accounts page/) });
  expect(configField('automations', [])).toMatchObject({ note: expect.stringMatching(/Automations and tools/) });
  expect(configField('integrations.telegram.allow_from', ['1'])).toMatchObject({ note: expect.stringMatching(/Telegram access/) });
  expect(configField('name', 't').kind).toBe('readonly');
  expect(configRows({ a: 1, b: { c: [1, 2], d: { e: null } } })).toEqual([{ path: 'a', value: 1 }, { path: 'b.c', value: [1, 2] }, { path: 'b.d.e', value: null }]);
  expect(configText(null)).toBe('none');
  expect(configText([])).toBe('none');
  expect(configText(['a', 'b'])).toBe('a, b');
  expect(configText([{ name: 'x' }])).toBe('1 entry');
  expect(configText(false)).toBe('false');
});

test('auth url: only a sign-in link raises the login bar; an artifact, chat or share link never does', () => {
  const login = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=abc';
  const google = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1&scope=email';
  expect(authUrl('Published: https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789'), 'an artifact link: no bar').toBeNull();
  expect(authUrl(`Browser didn't open? Use the url below to sign in:\r\n\r\n${login}\r\n`)).toBe(login);
  expect(authUrl(`open ${google}`)).toBe(google);
  // the other sign-in hosts and paths
  for (const u of ['https://claude.com/cai/oauth/authorize?code=true&client_id=1', 'https://console.anthropic.com/oauth/authorize?x=1', 'https://claude.ai/login?returnTo=%2F']) expect(authUrl(u), u).toBe(u);
  // never: artifacts, chats, shares, a Remote Control session, a lookalike host
  for (const u of ['https://claude.ai/artifact/0a1b2c3d-4e5f', 'https://claude.ai/chat/0a1b2c3d?login=1', 'https://claude.ai/share/0a1b2c3d/login',
    'https://claude.ai/code/session_01AbCdEf', 'https://claude.ai', 'https://claude.ai.evil.example/oauth/authorize', 'https://accounts.google.com.evil.example/x']) expect(authUrl(u), u).toBeNull();
  // an artifact link earlier in the same chunk does not hide a later sign-in link
  expect(authUrl(`https://claude.ai/code/artifact/0a1b2c3d-4e5f\x1b[0m then ${login}\x1b[0m`)).toBe(login);
  expect(authUrl('')).toBeNull();
});

test('chain line: empty without backups; the chain in order, and where it is after a failover', () => {
  expect(chainLine({ backups: [] })).toBe('');
  expect(chainLine(null)).toBe('');
  expect(chainLine({ account_wanted: 'main', backups: ['acc1', 'acc2'] })).toBe('chain: main → acc1 → acc2');
  expect(chainLine({ account_wanted: null, backups: ['acc1'], account_reason: 'failover', account_attempted: 'acc1' })).toBe('chain: own token → acc1, now on acc1 after a limit');
  expect(chainLine({ account_wanted: 'main', backups: ['acc1'], account_reason: 'failback', account_attempted: 'main' })).toBe('chain: main → acc1');
});

// ---- review board (the reviewBoard shapes getBot returns in review-board.test.mjs) ----
const BOARD = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789';

test('board: module off (reviewBoard null) shows nothing', () => {
  expect(boardLink(null)).toBeNull();
});

test('board: positive control: a record gives the link and the open count', () => {
  const v = boardLink({ url: BOARD, open: 4, answered: 1, sentAt: '2026-09-28T12:52:00Z' });
  expect(v).toMatchObject({ url: BOARD, count: '4 open', title: expect.stringMatching(/4 open, 1 answered/) });
});

test('board: module on, nothing recorded yet: the muted "no board yet"', () => {
  expect(boardLink({ url: null, open: null, answered: null, sentAt: null })).toMatchObject({ none: true });
});

test('board: a hostile record never becomes a link or a count', () => {
  expect(boardLink({ url: null, open: null, answered: null, sentAt: null })).toMatchObject({ none: true });
  expect(boardLink({ url: BOARD, open: null, answered: null, sentAt: null })).toMatchObject({ count: '' });
  expect(boardLink({ url: BOARD, open: '5', answered: -1 })).toMatchObject({ count: '' });
  // the client refuses a bad URL on its own too
  for (const url of ['javascript:alert(1)', 'https://claude.ai.evil.example/artifact/0a1b2c3d-4e5f', 'http://claude.ai/artifact/0a1b2c3d-4e5f', 'https://claude.ai/public/artifacts/0a1b2c3d-4e5f']) {
    expect(boardLink({ url, open: 1 }), url).toMatchObject({ none: true });
  }
});

// ---- attachments (attach.test.mjs) ----
test('attachView: what the composer refuses before uploading', () => {
  expect(attachView({ name: 'shot.PNG', size: 2048 }, 0)).toEqual({ name: 'shot.PNG', size: '2 KB', image: true, why: '' });
  expect(attachView({ name: 'notes.md', size: 10 }, 3)).toEqual({ name: 'notes.md', size: '10 B', image: false, why: '' });
  expect(attachView({ name: 'setup.exe', size: 10 }, 0).why).toMatch(/^setup\.exe: \.exe files are not accepted\./);
  expect(attachView({ name: 'Makefile', size: 10 }, 0).why).toMatch(/without an extension/);
  expect(attachView({ name: 'big.pdf', size: ATTACH_MAX + 1 }, 0).why).toMatch(/over 20 MB/);
  expect(attachView({ name: 'e.txt', size: 0 }, 0).why).toMatch(/empty/);
  expect(attachView({ name: 'a.png', size: 1 }, 10).why).toMatch(/At most 10 files/);
  expect(Object.values(attachView({ name: 'setup.exe', size: 1 }, 0)).join(' '), 'no em dash in UI text').not.toMatch(/—/);
});

test('splitAttached: the sent turn back into its text and chips, [Image #n] included', () => {
  // core/attach.mjs withAttachments: the text, then one line per file (both path separators)
  const img = '/home/demo/.botcorp/uploads/20260928-090507-shot.png';
  const pdf = 'C:\\bots\\demo\\.botcorp\\uploads\\20260928-090507-doc.pdf';
  const sent = `look\n\nat this\n[attached: ${img} (png, 2 KB)]\n[attached: ${pdf} (pdf, 5 B)]`;
  // what Claude Code records once it attached the image
  const recorded = sent.replace('(png, 2 KB)]', '(png, 2 KB)] [Image #1]');
  for (const t of [sent, recorded]) {
    expect(splitAttached(t)).toEqual({ body: 'look\n\nat this', files: [
      { id: '20260928-090507-shot.png', name: 'shot.png', size: '2 KB', image: true },
      { id: '20260928-090507-doc.pdf', name: 'doc.pdf', size: '5 B', image: false },
    ] });
  }
  expect(splitAttached('no files [attached: here] mid-line')).toEqual({ body: 'no files [attached: here] mid-line', files: [] });
});
