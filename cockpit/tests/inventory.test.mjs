// The Tools tab's data: `botcorp tools <bot> inventory --json` (cli/tools.mjs
// toolInventory) and GET /api/bots/:name/inventory. Three groups (BotCorp
// harness, the bot's own, third-party); each item says whether it is on and how
// the engine switches it (a bot.yaml value, a list membership, or not at all).
// A fixture bot in a throwaway BOTCORP_HOME / BOTCORP_BOTS_DIR; a real server on
// a free loopback port. Run: node --test cockpit/tests/inventory.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-inventory-test-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
process.env.BOTCORP_HOME = RT;
process.env.BOTCORP_BOTS_DIR = BOTS;
process.env.BOT_TG_MUTE = '1';
const { toolInventory, frontmatter, mcpProvider } = await import('../../cli/tools.mjs');
const { loadBotYaml } = await import('../../daemon/botyaml.mjs');

const HOME = path.join(BOTS, 't');
const put = (rel, text) => { const f = path.join(HOME, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('bot.yaml', [
  'name: t', 'secrets: [oauth_token, gh_token]', 'harness:', '  service: manual',
  '  disable: [skill:weekly, agent:fable]', '  hooks_disable: [play-sound]',
  '  modules: { janitor: report }',
  'tools:',
  '  - {name: gh, path: tools/gh.py, kind: integration, purpose: GitHub, secrets: [gh_token], enabled: false}',
  '  - {name: rep, path: tools/rep.py, kind: cli, purpose: A report}',
  '',
].join('\n'));
put('tools/rep.py', "print('x')\n");
put('CLAUDE.md', '@../../harness/rules/coding.md\n');
put('.claude/skills/mine/SKILL.md', '---\nname: mine\ndescription: >\n  My own skill,\n  folded.\n---\n');
put('.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'telegram@claude-plugins-official': true } }));
put('.mcp.json', JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', '@acme/fs-mcp@1.2.3'] }, web: { type: 'http', url: 'https://mcp.example.com/x' } } }));

const inv = toolInventory({ botHome: HOME, cfg: loadBotYaml(path.join(HOME, 'bot.yaml')), botcorpRoot: ROOT, scan: { missing: ['gh'], registry: 'warn', unregistered: [] } });
const section = (source, kind) => inv.groups.find((g) => g.source === source).sections.find((s) => s.kind === kind);
const itemOf = (source, kind, name) => section(source, kind).items.find((i) => i.name === name);

test('three groups, in order, each with its licence', () => {
  assert.deepEqual(inv.groups.map((g) => g.source), ['harness', 'bot', 'third']);
  assert.equal(inv.bot, 't');
  assert.match(inv.groups[0].license, /MIT/);
});

test('harness items: harness.disable and hooks_disable read as off, with the list toggle', () => {
  const weekly = itemOf('harness', 'skill', 'weekly');
  assert.equal(weekly.on, false);
  assert.deepEqual(weekly.toggle, { list: 'harness.disable', item: 'skill:weekly' });
  assert.equal(itemOf('harness', 'skill', 'standup').on, true);
  assert.equal(itemOf('harness', 'agent', 'fable').on, false);
  assert.equal(itemOf('harness', 'agent', 'coder').on, true);
  const sound = itemOf('harness', 'hook', 'play-sound');
  assert.equal(sound.on, false);
  assert.deepEqual(sound.toggle, { list: 'harness.hooks_disable', item: 'play-sound' });
  const janitor = itemOf('harness', 'module', 'janitor');
  assert.equal(janitor.on, true);
  assert.equal(janitor.note, 'report only');
  assert.deepEqual(janitor.toggle, { path: 'harness.modules.janitor', on: true, off: false });
  assert.equal(itemOf('harness', 'rule', 'coding').on, true);
  assert.equal(itemOf('harness', 'rule', 'security').on, false);
});

test('the harness group reads "All bots"; an operator description wins over the shipped text', () => {
  assert.equal(inv.groups[0].label, 'All bots');
  const d = toolInventory({ botHome: HOME, cfg: loadBotYaml(path.join(HOME, 'bot.yaml')), botcorpRoot: ROOT, descriptions: { 'skill:weekly': 'The Friday review' } });
  const weekly = d.groups[0].sections.find((s) => s.kind === 'skill').items.find((i) => i.name === 'weekly');
  assert.equal(weekly.description, 'The Friday review');
  assert.equal(weekly.described, true);
  assert.notEqual(itemOf('harness', 'skill', 'weekly').description, 'The Friday review');
});

test('vault-guard and operator-guard have no switch, and say why', () => {
  for (const h of ['vault-guard', 'operator-guard']) {
    const it = itemOf('harness', 'hook', h);
    assert.equal(it.toggle, null, h);
    assert.match(it.locked, /^always on/, h);
    assert.equal(it.on, true, h);
  }
});

test("the bot's own: registry entries with enabled and missing, its own skills", () => {
  const gh = itemOf('bot', 'tool', 'gh');
  assert.equal(gh.on, false);
  assert.equal(gh.missing, true);
  assert.deepEqual(gh.secrets, ['gh_token']);
  assert.deepEqual(gh.toggle, { path: 'tools.gh.enabled', on: true, off: false });
  assert.equal(itemOf('bot', 'tool', 'rep').on, true);
  assert.equal(itemOf('bot', 'tool', 'rep').missing, false);
  assert.equal(itemOf('bot', 'skill', 'mine').description, 'My own skill, folded.');
  assert.equal(section('bot', 'tool').registry, 'warn');
});

test('third-party: plugins with their provider, MCP servers with theirs', () => {
  const tg = itemOf('third', 'plugin', 'telegram');
  assert.equal(tg.on, true);
  assert.match(tg.provider, /Anthropic/);
  assert.equal(itemOf('third', 'mcp', 'fs').provider, '@acme/fs-mcp');
  assert.equal(itemOf('third', 'mcp', 'web').provider, 'mcp.example.com');
  for (const g of inv.groups) for (const s of g.sections) for (const i of s.items) if (g.source === 'third') assert.equal(i.toggle, null);
});

test('frontmatter and mcpProvider edge cases', () => {
  assert.deepEqual(frontmatter('no block'), {});
  assert.deepEqual(frontmatter("---\nname: 'x'\n---\nbody"), { name: 'x' });
  assert.equal(mcpProvider(null), 'unknown');
  assert.equal(mcpProvider({ command: 'C:\\tools\\srv.exe' }), 'srv.exe');
});

// ---- the route, on a real server -------------------------------------------------
const children = [];
after(() => { for (const c of children) c.kill(); });
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('GET /api/bots/:name/inventory returns the CLI verb\'s JSON; 404 for no such bot; no session 403', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'cockpit', 'server.mjs'), '--port', String(port)], {
    env: { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(up, `cockpit did not start: ${log}`);
  assert.equal((await fetch(`${base}/api/bots/t/inventory`)).status, 403);
  const cookie = (await fetch(`${base}/`)).headers.get('set-cookie').split(';')[0];
  const r = await fetch(`${base}/api/bots/t/inventory`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.groups.map((g) => g.source), ['harness', 'bot', 'third']);
  const gh = j.groups[1].sections[0].items.find((i) => i.name === 'gh');
  assert.equal(gh.on, false);
  assert.equal(gh.missing, true, 'the route passes the registry scan');
  assert.equal((await fetch(`${base}/api/bots/nope/inventory`, { headers: { cookie } })).status, 404);
  // read-only: no registry day recorded (that is `tools scan`'s job)
  assert.equal(fs.existsSync(path.join(RT, 'state', 't.registry-days.json')), false);
});
