// Cockpit chat rendering: the markdown renderer the page ships (public/md.js,
// evaluated verbatim), channel-message parsing end to end through chatState,
// and the status chips (chatstatus.mjs). Run: node --test cockpit/tests/
//
// The XSS checks are proven load-bearing: every payload must also FAIL the
// same safety check when fed through naive renderers (no escaping; escaping
// but no scheme check; escaping without quotes), so a check that cannot fail
// cannot pass for the real renderer either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COCKPIT = path.resolve(HERE, '..');
const ROOT = path.resolve(COCKPIT, '..');

// Runtime dir for modules that read BOTCORP_HOME at import time: never ~/.botcorp.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-chat-test-'));
process.env.BOTCORP_HOME = path.join(TMP, 'rt');
const { parseChannelText, parseTaskNotifications, chatState } = await import('../chat.mjs');
const { summarizeStatus, chatStatus } = await import('../chatstatus.mjs');
const { ccProjectSlug } = await import('../bots.mjs');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(COCKPIT, 'public', 'md.js'), 'utf-8'), sandbox);
const { renderMarkdown } = sandbox.CockpitMarkdown;

// ---- the safety property ------------------------------------------------------
// Escaped text never contains a raw '<', so every '<' in the output is markup
// and must be exactly one whitelisted tag with whitelisted, double-quoted
// attributes; an href must be http(s) or mailto.
const TAGS = new Set(['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'h5', 'hr', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ATTRS = { a: ['href', 'rel', 'target'], ol: ['start'], div: ['class'], th: ['class'], td: ['class'] };
const TAG_RE = /<(\/?)([a-z0-9]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>/y;
function assertSafe(html) {
  for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i + 1)) {
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(html);
    if (!m) throw new Error(`malformed markup at ${i}: ${html.slice(i, i + 60)}`);
    const tag = m[2];
    if (!TAGS.has(tag)) throw new Error(`tag <${tag}> not allowed`);
    for (const a of m[3].matchAll(/([a-z-]+)="([^"]*)"/g)) {
      if (!(ATTRS[tag] || []).includes(a[1])) throw new Error(`attribute ${a[1]} not allowed on <${tag}>`);
      if (a[1] === 'href' && !/^(https?:\/\/|mailto:)/i.test(a[2])) throw new Error(`href ${a[2]} not allowed`);
      if (a[1] === 'rel' && a[2] !== 'noopener noreferrer') throw new Error('rel must be noopener noreferrer');
      if (a[1] === 'target' && a[2] !== '_blank') throw new Error('target must be _blank');
    }
    if (tag === 'a' && !m[1] && !/\srel="noopener noreferrer"/.test(m[3])) throw new Error('<a> without rel');
  }
}

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<a href="javascript:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[x](javascript:alert`1`)',
  '[x](JaVaScRiPt:alert`1`)',
  '[x]( javascript:alert`1` )',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x](https://a.example/"onmouseover="alert(1))',
  '[x](https://a.example/"onmouseover="alert`1`)',
  '[x"><img src=x onerror=alert(1)>](https://a.example)',
  '`<img src=x onerror=alert(1)>`',
  '`` `<img src=x onerror=alert(1)>` ``',
  '```\n</code></pre><img src=x onerror=alert(1)>\n```',
  '**<img src=x onerror=alert(1)>**',
  '*<svg onload=alert(1)>*',
  '# <iframe src=javascript:alert(1)>',
  '> <img src=x onerror=alert(1)>',
  '- <img src=x onerror=alert(1)>',
  '| a | b |\n|---|---|\n| <svg onload=alert(1)> | [y](javascript:alert(1)) |',
  'https://a.example/<img/src=x/onerror=alert(1)>',
];

// Naive renderers the guard must reject. One per defect class.
const NAIVE = {
  'no escaping': (s) => s
    .replace(/```\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`+([^`]+)`+/g, '<code>$1</code>')
    .replace(/^#+ (.*)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>'),
  'escaped, no scheme check': (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>'),
  'escaped except quotes': (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>'),
};

test('every XSS payload renders safe', () => {
  for (const p of PAYLOADS) assert.doesNotThrow(() => assertSafe(renderMarkdown(p)), `payload ${JSON.stringify(p)} -> ${renderMarkdown(p)}`);
});

test('positive control: the naive renderers fail the same check', () => {
  const caught = new Set();
  for (const p of PAYLOADS) {
    const failing = Object.entries(NAIVE).filter(([, fn]) => { try { assertSafe(fn(p)); return false; } catch { return true; } }).map(([k]) => k);
    assert.ok(failing.length, `payload ${JSON.stringify(p)} does not trip any naive renderer, so it proves nothing`);
    failing.forEach((k) => caught.add(k));
  }
  // each defect class is caught by at least one payload
  assert.deepEqual([...caught].sort(), Object.keys(NAIVE).sort());
});

test('raw HTML is shown as text, not parsed', () => {
  assert.equal(renderMarkdown('<b>hi</b> & "q"'), '<p>&lt;b&gt;hi&lt;/b&gt; &amp; &quot;q&quot;</p>');
});

test('javascript:, data: and relative links stay text; the quote cannot break out', () => {
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1))'), /<a/);
  assert.doesNotMatch(renderMarkdown('[x](data:text/html,hi)'), /<a/);
  assert.doesNotMatch(renderMarkdown('[x](/etc/passwd)'), /<a/);
  const h = renderMarkdown('[x](https://a.example/"onmouseover="alert`1`)');
  assert.match(h, /href="https:\/\/a\.example\/&quot;onmouseover=&quot;alert`1`"/);
});

test('links: http, https, mailto with rel and target', () => {
  assert.equal(renderMarkdown('[a](https://x.example/p?q=1&r=2)'), '<p><a href="https://x.example/p?q=1&amp;r=2" rel="noopener noreferrer" target="_blank">a</a></p>');
  assert.match(renderMarkdown('[m](mailto:a@b.example)'), /<a href="mailto:a@b\.example" rel="noopener noreferrer" target="_blank">m<\/a>/);
  assert.match(renderMarkdown('see https://x.example/a.'), /<a href="https:\/\/x\.example\/a" [^>]*>https:\/\/x\.example\/a<\/a>\.<\/p>$/);
  // no link nested inside a link's text
  assert.equal((renderMarkdown('[see https://a.example](https://b.example)').match(/<a /g) || []).length, 1);
});

test('inline: bold, italic, code; snake_case and 2 * 3 * 4 stay plain', () => {
  assert.equal(renderMarkdown('**b** *i* _j_ `c`'), '<p><strong>b</strong> <em>i</em> <em>j</em> <code>c</code></p>');
  assert.equal(renderMarkdown('file_name_here and 2 * 3 * 4'), '<p>file_name_here and 2 * 3 * 4</p>');
  assert.equal(renderMarkdown('`` a ` b ``'), '<p><code>a ` b</code></p>');
  assert.equal(renderMarkdown('`**not bold**`'), '<p><code>**not bold**</code></p>');
  assert.equal(renderMarkdown('line one\nline two'), '<p>line one<br>line two</p>');
});

test('blocks: headings, fences, quotes, rules', () => {
  assert.equal(renderMarkdown('# A\n### B\n###### C'), '<h3>A</h3><h4>B</h4><h5>C</h5>');
  assert.equal(renderMarkdown('# Using C#'), '<h3>Using C#</h3>');
  assert.equal(renderMarkdown('```js\nconst a = 1 < 2;\n\n**x**\n```\nafter'), '<pre><code>const a = 1 &lt; 2;\n\n**x**</code></pre><p>after</p>');
  assert.equal(renderMarkdown('```\nunclosed <b>'), '<pre><code>unclosed &lt;b&gt;</code></pre>');
  assert.equal(renderMarkdown('> q **b**\n> two'), '<blockquote><p>q <strong>b</strong><br>two</p></blockquote>');
  assert.equal(renderMarkdown('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
});

test('lists: bullets, numbers, nesting by indent, start number', () => {
  assert.equal(renderMarkdown('- a\n- b\n  - c\n- d'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>');
  assert.equal(renderMarkdown('3. x\n4. y'), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(renderMarkdown('1. x\n   - y'), '<ol><li>x<ul><li>y</li></ul></li></ol>');
});

test('tables: header, alignment, escaped cells, pipe without a separator is text', () => {
  assert.equal(renderMarkdown('| a | b |\n|:-:|--:|\n| 1 | `2` |'),
    '<div class="tbl"><table><thead><tr><th class="c">a</th><th class="r">b</th></tr></thead><tbody><tr><td class="c">1</td><td class="r"><code>2</code></td></tr></tbody></table></div>');
  assert.equal(renderMarkdown('a | b\nc'), '<p>a | b<br>c</p>');
});

test('pathological input stays linear', () => {
  // "x " first so no block rule swallows the line and the inline scanner runs.
  // 200k chars of unclosed ** took ~7 s when BOLD_RE was an unbounded lazy scan.
  for (const unit of ['**a ', ' __a', '*a ', '[a](b ', '`*_[h', 'http://a']) {
    const s = 'x ' + unit.repeat(Math.floor(200000 / unit.length));
    const t0 = Date.now();
    const out = renderMarkdown(s);
    assert.ok(out.length >= s.length - 10, `${JSON.stringify(unit)} lost content`);
    assert.ok(Date.now() - t0 < 1500, `${JSON.stringify(unit)} took ${Date.now() - t0} ms`);
  }
});

// ---- channel messages, end to end through chatState ------------------------------
function transcriptBot(lines) {
  const dir = fs.mkdtempSync(path.join(TMP, 'bot-'));
  const home = path.join(dir, 'home');
  const configDir = path.join(dir, 'config');
  const proj = path.join(configDir, 'projects', ccProjectSlug(home));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { name: 'demo', home, configDir };
}
const userLine = (content, extra = {}) => ({ type: 'user', timestamp: '2026-09-25T14:00:00.000Z', message: { role: 'user', content }, ...extra });

test('parseChannelText: body + meta, media as markers, never paths', () => {
  const r = parseChannelText('<channel source="plugin:telegram:telegram" chat_id="1" message_id="9" user="operator" user_id="1" ts="2026-09-25T14:34:00.000Z" image_path="D:\\bot\\inbox\\photo.jpg">look at this</channel>');
  assert.equal(r.text, 'look at this');
  assert.deepEqual(r.meta, { source: 'Telegram', user: 'operator', ts: '2026-09-25T14:34:00.000Z', media: ['image'] });
  assert.doesNotMatch(JSON.stringify(r), /inbox|photo/);
  const f = parseChannelText('<channel source="plugin:telegram:telegram" attachment_file_id="abc" attachment_name="C:\\tmp\\secret\\report.pdf" user="m"></channel>');
  assert.deepEqual(f.meta.media, ['report.pdf']);
  assert.doesNotMatch(JSON.stringify(f), /tmp|secret/);
  assert.equal(parseChannelText('no wrapper here'), null);
});

// The shape Claude Code writes (a background agent finishing), path included.
const TASK_AGENT = '<task-notification>\n<task-id>a4d687b213db068bb</task-id>\n<tool-use-id>toolu_01Tu</tool-use-id>\n<output-file>D:\\bot\\tmp\\tasks\\a4d687b213db068bb.output</output-file>\n<status>completed</status>\n<summary>Agent "cockpit audit" finished</summary>\n<note>A task-notification fires each time this agent stops.</note>\n<result>**Short answer:** it works.\n\n| a | b |\n|---|---|\n| 1 | 2 |</result>\n<usage><subagent_tokens>128115</subagent_tokens><tool_uses>55</tool_uses><duration_ms>294606</duration_ms></usage>\n</task-notification>';

test('parseTaskNotifications: summary, status, usage, result; never the path or ids', () => {
  const [c] = parseTaskNotifications(TASK_AGENT);
  assert.deepEqual(c, { summary: 'Agent "cockpit audit" finished', status: 'completed', durationMs: 294606, tokens: 128115, toolUses: 55, result: '**Short answer:** it works.\n\n| a | b |\n|---|---|\n| 1 | 2 |' });
  assert.doesNotMatch(JSON.stringify(c), /bot\\\\tmp|output|a4d687b2|toolu_|fires each time/);
  // a background command: no result, no usage
  const [cmd] = parseTaskNotifications('<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n<summary>Background command "poll" failed (exit code 1)</summary>\n</task-notification>');
  assert.deepEqual(cmd, { summary: 'Background command "poll" failed (exit code 1)', status: 'failed', durationMs: null, tokens: null, toolUses: null, result: '' });
  // `key: value` usage (older Claude Code), two blocks in one entry
  const two = parseTaskNotifications('<task-notification><status>completed</status><summary>one</summary><usage>total_tokens: 900\ntool_uses: 3\nduration_ms: 61000</usage></task-notification>\n<task-notification><status>running</status><summary>two</summary></task-notification>');
  assert.deepEqual(two.map((x) => [x.summary, x.status, x.tokens, x.toolUses, x.durationMs]), [['one', 'completed', 900, 3, 61000], ['two', 'running', null, null, null]]);
  // a status is a word or it is "unknown"; a result may quote the closing tag
  const [odd] = parseTaskNotifications('<task-notification><status>done" onclick="x</status><result>the tag is </result> literally</result></task-notification>');
  assert.equal(odd.status, 'unknown');
  assert.equal(odd.summary, 'Background task');
  assert.equal(odd.result, 'the tag is </result> literally');
  assert.equal(parseTaskNotifications('no notification'), null);
});

test('task card result: renders through md.js and stays safe', () => {
  for (const p of PAYLOADS) {
    const [c] = parseTaskNotifications(`<task-notification><status>completed</status><summary>${p}</summary><result>${p}\n\n**ok** [x](javascript:alert(1))</result></task-notification>`);
    assertSafe(renderMarkdown(c.result));
    assert.equal(typeof c.summary, 'string');
  }
  const big = parseTaskNotifications(`<task-notification><result>${'x'.repeat(50000)}</result></task-notification>`)[0];
  assert.ok(big.result.length < 20100 && big.result.endsWith('(truncated)'));
});

test('chatState: Telegram turn renders as a user turn; a task-notification as a card; injected wrappers not at all', async () => {
  const bot = transcriptBot([
    userLine('<channel source="plugin:telegram:telegram" chat_id="1" message_id="5" user="operator" user_id="1" ts="2026-09-25T14:34:00.000Z">**hi** from the phone</channel>', { isMeta: true }),
    userLine(TASK_AGENT, { origin: { kind: 'task-notification' } }),
    userLine('<system-reminder>be nice</system-reminder>'),
    userLine('skill body injected', { isMeta: true }),
    userLine([{ type: 'text', text: 'typed at the box' }]),
    { type: 'assistant', timestamp: '2026-09-25T14:35:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '## Done\n- one' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
  ]);
  const st = await chatState(bot, 0);
  assert.equal(st.hasSession, true);
  assert.deepEqual(st.turns.map((t) => [t.role, t.text ?? t.task.summary]), [
    ['user', '**hi** from the phone'],
    ['task', 'Agent "cockpit audit" finished'],
    ['user', 'typed at the box'],
    ['assistant', '## Done\n- one'],
  ]);
  assert.deepEqual(st.turns[0].meta, { source: 'Telegram', user: 'operator', ts: '2026-09-25T14:34:00.000Z', media: [] });
  assert.equal(st.turns[1].ts, '2026-09-25T14:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(st.turns), /<channel|chat_id|task-notification|system-reminder|output-file/);
  assert.deepEqual(st.turns[3].tools, ['Bash']);
});

// ---- status chips ----------------------------------------------------------------------
const NOW = Date.parse('2026-09-25T15:00:00Z');
const nowS = NOW / 1000;
const STATUS = {
  ts: nowS - 30,
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'high' },
  context_window: { context_window_size: 1000000, used_percentage: 25, current_usage: { input_tokens: 2, output_tokens: 368, cache_creation_input_tokens: 242, cache_read_input_tokens: 245788 } },
  rate_limits: { five_hour: { used_percentage: 13, resets_at: nowS + 7800 }, seven_day: { used_percentage: 81, resets_at: nowS + 300000 } },
};
const CFG = { model: 'claude-opus-5-5', effort: 'medium', harness: { context_window: '70%' } };
const SESS = { a: { session_id: 'S1', at: '2026-09-25T10:00:05Z', launcher_pid: 42, oauth_last4: '' } };
const LAUNCH = { 42: { launcher_pid: 42, at: '2026-09-25T10:00:00Z', oauth_last4: 'UwAA', oauth_source: 'vault' } };
const STATE = { session_id: 'S1', started_at: '2026-09-25T10:00:00Z' };

test('status: context against the bot window, limits, model + effort from the session', () => {
  const s = summarizeStatus({ status: STATUS, cfg: CFG, sessions: SESS, launches: LAUNCH, state: STATE, now: NOW });
  assert.deepEqual(s.context, { used: 246032, window: 700000, pct: 35, source: 'bot.yaml harness.context_window: 70% of 1000000 for claude-opus-5-5' });
  assert.deepEqual(s.fiveHour, { pct: 13, resetsAt: nowS + 7800 });
  assert.deepEqual(s.sevenDay, { pct: 81, resetsAt: nowS + 300000 });
  assert.equal(s.model.name, 'Opus 5.5');
  assert.equal(s.effort.level, 'high');
  assert.match(s.effort.source, /session/);
  assert.equal(s.ts, nowS - 30);
});

test('status: an injected token wins over the config-home email; only last 4 leave', () => {
  const s = summarizeStatus({ status: STATUS, cfg: CFG, claudeJson: { oauthAccount: { emailAddress: 'someone@example.com' } }, sessions: SESS, launches: LAUNCH, state: STATE, now: NOW });
  assert.equal(s.account.tokenLast4, 'UwAA');
  assert.equal(s.account.email, undefined);
  const own = summarizeStatus({ status: STATUS, cfg: CFG, claudeJson: { oauthAccount: { emailAddress: 'someone@example.com' } }, sessions: SESS, launches: { 42: { ...LAUNCH[42], oauth_source: 'none', oauth_last4: '' } }, state: STATE, now: NOW });
  assert.equal(own.account.email, 'someone@example.com');
  const none = summarizeStatus({ status: STATUS, cfg: CFG, now: NOW });
  assert.match(none.account.na, /no session-env record/);
});

test('status: nothing is invented when a value is missing', () => {
  const s = summarizeStatus({ cfg: CFG, now: NOW });
  for (const k of ['context', 'fiveHour', 'sevenDay']) assert.match(s[k].na, /no status\.json/);
  assert.match(s.model.source, /bot\.yaml/);
  assert.match(s.effort.source, /bot\.yaml/);
  assert.equal(s.effort.level, 'medium');
  assert.equal(s.ts, null);
  const passed = summarizeStatus({ status: { ...STATUS, rate_limits: { five_hour: { used_percentage: 99, resets_at: nowS - 60 } } }, cfg: CFG, now: NOW });
  assert.match(passed.fiveHour.na, /reset at 2026-09-25T14:59:00Z; no reading since/);
  assert.match(passed.sevenDay.na, /no 7-day reading/);
  const apiKey = summarizeStatus({ status: { ...STATUS, rate_limits: undefined, effort: undefined, context_window: { context_window_size: 1000000, current_usage: null } }, cfg: { ...CFG, harness: { context_window: 'auto' } }, now: NOW });
  assert.match(apiKey.fiveHour.na, /no rate_limits/);
  assert.match(apiKey.context.na, /no context reading/);
  assert.match(apiKey.effort.source, /configured/);
});

test('chatStatus reads the files BotCorp writes (real paths, not a stub)', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'statusbot-'));
  const home = path.join(dir, 'home');
  const configDir = path.join(home, '.claude-demo');
  fs.mkdirSync(path.join(configDir, 'botcorp'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bot.yaml'), 'name: demo\nmodel: claude-opus-5-5\neffort: high\nharness:\n  context_window: 50%\n');
  fs.writeFileSync(path.join(configDir, 'botcorp', 'status.json'), JSON.stringify(STATUS));
  fs.writeFileSync(path.join(configDir, 'botcorp', 'session-env.json'), JSON.stringify({ sessions: SESS }));
  fs.writeFileSync(path.join(configDir, 'botcorp', 'launch-env.json'), JSON.stringify({ launches: LAUNCH }));
  fs.mkdirSync(path.join(process.env.BOTCORP_HOME, 'state'), { recursive: true });
  fs.writeFileSync(path.join(process.env.BOTCORP_HOME, 'state', 'demo.json'), JSON.stringify(STATE));
  const s = await chatStatus({ name: 'demo', home, configDir });
  assert.equal(s.context.window, 500000);
  assert.equal(s.account.tokenLast4, 'UwAA');
  assert.equal(s.model.name, 'Opus 5.5');
  const empty = await chatStatus({ name: 'nobot', home: path.join(dir, 'nope'), configDir: path.join(dir, 'nope', 'c') });
  assert.match(empty.context.na, /no status\.json/);
});

test('statusline.js records the session effort in status.json', () => {
  const cfgHome = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  const payload = { session_id: 'x', version: '2.1.281', effort: { level: 'xhigh' }, model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' }, context_window: STATUS.context_window, rate_limits: STATUS.rate_limits, workspace: { current_dir: cfgHome } };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'harness', 'tools', 'infra', 'statusline.js')], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_CONFIG_DIR: cfgHome, BOT_HAS_TG: '0' }, encoding: 'utf-8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(fs.readFileSync(path.join(cfgHome, 'botcorp', 'status.json'), 'utf-8'));
  assert.deepEqual(st.effort, { level: 'xhigh' });
});
