// The cockpit's card decisions (public/cards.js, evaluated verbatim): the
// lifecycle buttons per bot kind, how a pending approval reads, the context
// bar, the account name. Run: node --test cockpit/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', 'cards.js'), 'utf-8'), sandbox);
const { lifecycleButtons, approvalView, contextBar, accountName, toolsLine } = sandbox.CockpitCards;
const plain = (o) => JSON.parse(JSON.stringify(o));   // across the vm realm

test('tools line: MCP tools read as plain words, repeats collapse', () => {
  assert.equal(toolsLine(['mcp__plugin_telegram_telegram__reply']), 'Telegram reply');
  assert.equal(toolsLine(['Bash', 'Bash']), 'Bash ×2');
  assert.equal(toolsLine(['Bash', 'mcp__github__create_issue', 'Read', 'Bash', 'mcp__plugin_telegram_telegram__download_attachment']),
    'Bash ×2, Github create issue, Read, Telegram download attachment');
  assert.equal(toolsLine([]), '');
});

test('lifecycle: a background bot never gets Stop; Start only while it is stopped', () => {
  for (const phase of ['idle', 'working', 'starting', 'down', 'stopped', null]) {
    for (const running of [true, false]) {
      const b = lifecycleButtons({ kind: 'bg', running, phase });
      assert.equal(b.stop, false, `bg ${phase} running=${running}`);
      assert.equal(b.restart, true);
      assert.equal(b.start, !running && (phase === 'stopped' || phase === null));
    }
  }
  // a crashed background bot (down) recovers through Restart, not Start
  assert.deepEqual(plain(lifecycleButtons({ kind: 'bg', running: false, phase: 'down' })), { start: false, stop: false, restart: true, primary: null });
  assert.equal(lifecycleButtons({ kind: 'bg', running: false, phase: 'stopped' }).primary, 'start');
});

test('lifecycle: a pty bot gets Stop and Restart while it runs, Start when it does not', () => {
  assert.deepEqual(plain(lifecycleButtons({ kind: 'pty', running: true, phase: 'idle' })), { start: false, stop: true, restart: true, primary: null });
  assert.deepEqual(plain(lifecycleButtons({ kind: 'pty', running: false, phase: 'stopped' })), { start: true, stop: false, restart: false, primary: 'start' });
  // no kind reported reads as a pty bot, never as one that cannot be stopped
  assert.equal(lifecycleButtons({ running: true }).stop, true);
});

const row = (path, why, extra = {}) => ({ id: 'a1b2c3', bot: 'demo', requested_by: 'bot:demo', at: '2026-09-27T10:00:00Z', op: 'set', path, value: 'x', diff: `${path}: a -> b`, why, ...extra });

test('approval: every widening path the CLI queues names what it widens', () => {
  const cases = [
    ['secrets', 'declares a new vault secret', 'secrets'],
    ['automations.nightly.secrets', 'injects a vault secret into an automation', 'secrets'],
    ['integrations.telegram.allow_from', 'adds a Telegram sender', 'senders'],
    ['integrations.telegram.dm_policy', 'loosens dm_policy allowlist -> pairing', 'senders'],
    ['account', 'switches the Claude account', 'account'],
    ['permissions', 'switches permissions to bypass', 'exposure'],
    ['harness.modules.remote_control', 'enables Remote Control', 'exposure'],
    ['harness.tools_registry', 'relaxes the tools registry enforce -> warn', 'exposure'],
    ['tools', 'registers an integration or secret-bearing tool (gh)', 'tools'],
    ['automations', 'adds an automation', 'jobs'],
    ['automations.nightly.enabled', 'enables automation nightly', 'jobs'],
    ['model', 'widening', 'other'],
  ];
  for (const [p, why, key] of cases) {
    const v = approvalView(row(p, why));
    assert.equal(v.widens, key, p);
    assert.ok(v.widensLabel && v.widensText, p);
  }
  const v = approvalView(row('harness.modules.remote_control', 'enables Remote Control'));
  assert.equal(v.title, 'Enables Remote Control');
  assert.equal(v.change, 'harness.modules.remote_control: a -> b');
  assert.equal(v.asker, 'Asked by demo');
  // the bare fallback reason is not a title; an operator-queued entry says so
  assert.equal(approvalView(row('model', 'widening', { requested_by: 'operator:someone' })).title, 'Change model');
  assert.equal(approvalView(row('model', '', { requested_by: 'operator:someone' })).asker, 'Queued by someone');
});

test('context bar: used over the compaction ceiling, clamped, levelled; nothing invented', () => {
  assert.deepEqual(plain(contextBar({ used: 180000, window: 400000, pct: 45, source: 'x' })), { pct: 45, level: '', label: '180k / 400k' });
  assert.equal(contextBar({ used: 320000, window: 400000, pct: 80 }).level, 'warn');
  assert.equal(contextBar({ used: 390000, window: 400000, pct: 97.6 }).level, 'bad');
  assert.equal(contextBar({ used: 500000, window: 400000, pct: 125 }).pct, 100);
  assert.equal(contextBar({ used: 1000, window: 4000 }).pct, 25);
  assert.deepEqual(plain(contextBar({ na: 'no transcript yet' })), { na: 'no transcript yet' });
  assert.ok(contextBar({ used: 5, window: 0 }).na);
});

test('account: the registered nickname shows; the token last 4 only in the title', () => {
  const accounts = [{ id: 'main', label: 'Main seat', masked: 'sk-a...9f3c' }, { id: 'spare', label: 'ops@example.com', masked: null }];
  const tok = accountName({ tokenLast4: '9f3c', source: 'injected token' }, accounts, 'spare');
  assert.equal(tok.name, 'Main seat');
  assert.match(tok.title, /\*\*\*\*9f3c/);
  assert.doesNotMatch(tok.name, /9f3c/);
  assert.equal(accountName({ email: 'OPS@example.com', source: '.claude.json' }, accounts).name, 'ops@example.com');
  const own = accountName({ tokenLast4: '0000', source: 'injected token' }, accounts, 'main');
  assert.equal(own.name, 'Own token', 'a measured token that matches no account is not named after the configured one');
  assert.match(own.title, /0000/);
  assert.equal(accountName({ email: 'x@example.com', source: 's' }, []).name, 'x@example.com');
  assert.equal(accountName({ na: 'no status yet' }, accounts).name, 'n/a');
});

test('account: a failover marks the name as a backup; failback and recover only the title', () => {
  const accounts = [{ id: 'spare', label: 'Spare seat', masked: 'sk-a...1b2c' }];
  const fo = accountName({ tokenLast4: '1b2c', source: 'injected token' }, accounts, 'main', 'failover');
  assert.equal(fo.name, 'Spare seat (backup)');
  assert.match(fo.title, /backup account after a usage limit/);
  const fb = accountName({ tokenLast4: '1b2c', source: 'injected token' }, accounts, 'spare', 'failback');
  assert.equal(fb.name, 'Spare seat');
  assert.match(fb.title, /back on its primary/);
  assert.equal(accountName({ tokenLast4: '1b2c', source: 's' }, accounts, 'spare', 'primary').title, 'token ****1b2c · s');
  assert.equal(accountName({ na: 'no status yet' }, accounts, null, 'failover').name, 'n/a');
});

test('config field: enums, booleans, numbers, text; lists and other pages read-only', () => {
  const { configField, configRows, configText } = sandbox.CockpitCards;
  assert.deepEqual(plain(configField('permissions', 'default')), { kind: 'enum', options: ['bypass', 'default'] });
  assert.deepEqual(plain(configField('effort', 'turbo')).options.slice(-1), ['turbo'], 'an unknown current value stays selectable');
  assert.deepEqual(plain(configField('role', null)).options, [null, 'admin']);
  assert.equal(configField('harness.modules.debrief', false).kind, 'bool');
  assert.equal(configField('harness.modules.janitor', 'report').kind, 'enum');
  assert.equal(configField('integrations.hub.interval_s', 300).kind, 'number');
  assert.equal(configField('persona', 'x').kind, 'text');
  assert.equal(configField('harness.pin', null).kind, 'text');
  assert.equal(configField('harness.hooks_disable', []).kind, 'readonly');
  assert.match(configField('account', 'acc1').note, /Accounts page/);
  assert.match(configField('backup_accounts', []).note, /Accounts page/);
  assert.match(configField('automations', []).note, /Automations and tools/);
  assert.match(configField('integrations.telegram.allow_from', ['1']).note, /Telegram access/);
  assert.equal(configField('name', 't').kind, 'readonly');
  assert.deepEqual(plain(configRows({ a: 1, b: { c: [1, 2], d: { e: null } } })), [{ path: 'a', value: 1 }, { path: 'b.c', value: [1, 2] }, { path: 'b.d.e', value: null }]);
  assert.equal(configText(null), 'none');
  assert.equal(configText([]), 'none');
  assert.equal(configText(['a', 'b']), 'a, b');
  assert.equal(configText([{ name: 'x' }]), '1 entry');
  assert.equal(configText(false), 'false');
});

test('auth url: only a sign-in link raises the login bar; an artifact, chat or share link never does', () => {
  const { authUrl } = sandbox.CockpitCards;
  const login = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=abc';
  const google = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1&scope=email';
  assert.equal(authUrl('Published: https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789'), null, 'an artifact link: no bar');
  assert.equal(authUrl(`Browser didn't open? Use the url below to sign in:\r\n\r\n${login}\r\n`), login);
  assert.equal(authUrl(`open ${google}`), google);
  // the other sign-in hosts and paths
  for (const u of ['https://claude.com/cai/oauth/authorize?code=true&client_id=1', 'https://console.anthropic.com/oauth/authorize?x=1', 'https://claude.ai/login?returnTo=%2F']) assert.equal(authUrl(u), u, u);
  // never: artifacts, chats, shares, a Remote Control session, a lookalike host
  for (const u of ['https://claude.ai/artifact/0a1b2c3d-4e5f', 'https://claude.ai/chat/0a1b2c3d?login=1', 'https://claude.ai/share/0a1b2c3d/login',
    'https://claude.ai/code/session_01AbCdEf', 'https://claude.ai', 'https://claude.ai.evil.example/oauth/authorize', 'https://accounts.google.com.evil.example/x']) assert.equal(authUrl(u), null, u);
  // an artifact link earlier in the same chunk does not hide a later sign-in link
  assert.equal(authUrl(`https://claude.ai/code/artifact/0a1b2c3d-4e5f\x1b[0m then ${login}\x1b[0m`), login);
  assert.equal(authUrl(''), null);
});

test('chain line: empty without backups; the chain in order, and where it is after a failover', () => {
  const { chainLine } = sandbox.CockpitCards;
  assert.equal(chainLine({ backups: [] }), '');
  assert.equal(chainLine(null), '');
  assert.equal(chainLine({ account_wanted: 'main', backups: ['acc1', 'acc2'] }), 'chain: main → acc1 → acc2');
  assert.equal(chainLine({ account_wanted: null, backups: ['acc1'], account_reason: 'failover', account_attempted: 'acc1' }), 'chain: own token → acc1, now on acc1 after a limit');
  assert.equal(chainLine({ account_wanted: 'main', backups: ['acc1'], account_reason: 'failback', account_attempted: 'main' }), 'chain: main → acc1');
});
