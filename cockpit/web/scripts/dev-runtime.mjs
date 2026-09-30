// The v0.9 dev loop's cockpit: a throwaway BOTCORP_HOME and bots dir seeded
// with fixtures, and cockpit/server.mjs on it. Never a live bot, never
// ~/.botcorp. Pair it with `npm run dev` (vite build --watch): the server
// serves web/dist as it is rebuilt. No Vite proxy on purpose: the cockpit's
// Host/Origin/cookie gates would refuse it.
//
//   node scripts/dev-runtime.mjs [--port 4478] [--keep]   seed, serve, clean up on Ctrl+C
//   node scripts/dev-runtime.mjs --seed-only              seed, print the env, exit (the dir stays)
//   node scripts/dev-runtime.mjs --unlinked               also seed a "bot scratch" account (an Inbox Link item)
//
// Fixtures: the checkout's bots/_example copied in as `example` (the bot list
// and `approvals` skip a folder that starts with `_`, so it keeps the name its
// bot.yaml gives it), state/updates.json (two older releases, the installed
// one, one newer), one pending approval and one decided, and a status.json so
// the header and Usage readings have numbers. Two registered accounts (fake
// setup tokens, their token check cached as passed), `example` pinned
// (harness.service daemon, the default) on the first, and one chat
// (service: manual) on it too.
//
// Every CLI call here and in the served cockpit runs with a stand-in Claude
// Code (BOTCORP_CLAUDE_EXE) and no plan probe: a Start or a Restart in the dev
// cockpit fails fast instead of launching a real session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (f) => process.argv.includes(f);
const PORT = Number(arg('--port') || 4478);
const BOT = 'example';
const CHAT = 'chat-0930-0845';
const ACCOUNTS = [
  { id: 'studio', label: 'Studio', token: `sk-ant-oat01-${'DEVFIXTURE'.repeat(4)}-St01`, plan: 'Max 20×' },
  { id: 'spare', label: 'Spare', token: `sk-ant-oat01-${'DEVFIXTURE'.repeat(4)}-Sp02`, plan: null },
];

export function seed(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcorp-dev-'))) {
  const home = path.join(dir, 'home');
  const botsDir = path.join(dir, 'bots');
  const state = path.join(home, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.cpSync(path.join(ROOT, 'bots', '_example'), path.join(botsDir, BOT), { recursive: true });
  const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const standIn = path.join(dir, 'claude-stand-in.exe');   // never a real Claude Code
  write(standIn, 'not a program');
  const env = { BOTCORP_HOME: home, BOTCORP_BOTS_DIR: botsDir, BOT_TG_MUTE: '1', BOTCORP_OAUTH_PROFILE_URL: 'off', BOTCORP_CLAUDE_EXE: standIn };

  // The accounts, through the CLI (the registry is accounts.ps1's). The CLI acts
  // for the operator on this throwaway home, as the cockpit's own CLI calls do.
  const cliEnv = { ...process.env, ...env };
  delete cliEnv.BOT_NAME;
  delete cliEnv.CLAUDECODE;
  delete cliEnv.BOTCORP_LAUNCH_ID;
  const cli = (input, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'botcorp.mjs'), ...args], { env: cliEnv, encoding: 'utf-8', timeout: 120_000, input });
  // --unlinked: a third account still named after a bot, so the Inbox has an account_unlinked item to Link
  const unlinked = has('--unlinked') ? [{ id: 'scratch', label: 'bot scratch', token: `sk-ant-oat01-${'DEVFIXTURE'.repeat(4)}-Sc03` }] : [];
  for (const a of [...ACCOUNTS, ...unlinked]) {
    const r = cli(a.token + '\n', 'accounts', 'add', a.id, '--label', a.label);
    if (r.status !== 0) throw new Error(`accounts add ${a.id}: ${r.stdout}${r.stderr}`);
  }
  const rows = JSON.parse(cli(null, 'accounts', 'list', '--json').stdout);
  // the 24 h token check as passed (no live check from a fixture), and one detected plan
  write(path.join(state, 'account-checks.json'), Object.fromEntries(rows.map((row) => {
    const a = ACCOUNTS.find((x) => x.id === row.id);
    return [row.fp, { ok: true, at: iso(60e3), detail: 'fixture', ...(a && a.plan ? { plan: a.plan, plan_source: 'credentials' } : {}) }];
  })));

  // example (pinned: service daemon) and the chat run on the first account.
  const exampleYaml = path.join(botsDir, BOT, 'bot.yaml');
  fs.appendFileSync(exampleYaml, `account: ${ACCOUNTS[0].id}\n`);
  write(path.join(botsDir, CHAT, 'bot.yaml'), [
    `name: ${CHAT}`,
    'persona: "A plain chat."',
    `account: ${ACCOUNTS[0].id}`,
    'harness:',
    '  service: manual',
    '  modules:',
    '    telegram: false',
    '',
  ].join('\n'));

  // Releases around the checked-out version, so the view has history, the installed one and one to apply.
  const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'botcorp.json'), 'utf-8')).version;
  const [maj, min, pat] = installed.split('.').map(Number);
  const older = [pat - 2, pat - 1].filter((p) => p >= 0).map((p) => `v${maj}.${min}.${p}`);
  const newer = `v${maj}.${min + 1}.0`;
  const rel = (tag, status, daysAgo, summary) => ({ tag, sha: `${tag.replace(/\D/g, '')}0f00d`.slice(0, 12), date: iso(daysAgo * 864e5), status, summary,
    notes: [{ title: 'What changed', text: `Fixture notes for ${tag}.` }, { title: 'Why', text: 'So the Updates screen has something to render.' }] });
  write(path.join(state, 'updates.json'), {
    checked_at: iso(60e3),
    releases: [
      ...older.map((t, i) => rel(t, 'installed', 20 - i * 7, 'Chat replies render faster.')),
      rel(`v${installed}`, 'installed', 3, 'A new cockpit: Bots, Inbox, Accounts and Settings.'),
      rel(newer, 'available', 0.5, 'Quieter Inbox and clearer account limits.'),
    ],
  });

  // One pending approval (the Inbox), one decided (the history).
  write(path.join(state, `${BOT}.approvals.json`), [
    { id: 'a1b2c3', ts: iso(10 * 60e3), op: 'set', path: 'effort', value: 'max', requested_by: `bot:${BOT}`, reason: 'raises effort to max' },
  ]);
  write(path.join(state, `${BOT}.approvals.history.jsonl`), JSON.stringify({ id: 'd4e5f6', ts: iso(2 * 36e5), op: 'set', path: 'effort', value: 'high',
    requested_by: `bot:${BOT}`, reason: 'raises effort', approved_by: 'operator:dev', approved_at: iso(36e5) }) + '\n');

  // The login the session runs on (`.claude.json`); its email is the first account's label, which is what
  // ties the status.json readings below to that account's meters on the Accounts page.
  write(path.join(botsDir, BOT, `.claude-${BOT}`, '.claude.json'), { oauthAccount: { emailAddress: ACCOUNTS[0].label } });

  // The status line's record (harness statusline.js writes it in a live session).
  const nowS = Math.floor(now / 1000);
  write(path.join(botsDir, BOT, `.claude-${BOT}`, 'botcorp', 'status.json'), {
    ts: nowS - 30,
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    effort: { level: 'high' },
    context_window: { context_window_size: 1000000, used_percentage: 31, current_usage: { input_tokens: 2, output_tokens: 400, cache_creation_input_tokens: 1200, cache_read_input_tokens: 308000 } },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: nowS + 7200 }, seven_day: { used_percentage: 78, resets_at: nowS + 300000 } },
  });
  return { dir, env };
}

function main() {
  const { dir, env } = seed();
  if (has('--seed-only')) {
    for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
    return;
  }
  console.log(`[dev-runtime] fixtures in ${dir}${has('--keep') ? ' (kept)' : ' (removed on exit)'}`);
  const child = spawn(process.execPath, [path.join(ROOT, 'cockpit', 'server.mjs'), '--port', String(PORT)], { env: { ...process.env, ...env }, stdio: 'inherit' });
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try { child.kill(); } catch { /* gone */ }
    if (!has('--keep')) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error(`[dev-runtime] could not remove ${dir}: ${e.message}`); }
  };
  child.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { cleanup(); process.exit(0); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
