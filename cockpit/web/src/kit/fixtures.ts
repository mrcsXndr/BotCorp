// Fixture data for the design kit. Shapes follow the real API responses
// (bots, attention, approvals, releaseView, toolInventory) closely enough to
// judge the layout; the screens bind the real ones in later steps. Names are
// made up: this is a public template.
import type { DotTone } from '../ui';

export const BOTS: { name: string; state: string; tone: DotTone; detail: string; tg: boolean; attention: number }[] = [
  { name: 'atlas', state: 'running', tone: 'ok', detail: 'Opus 5.5 · context 42%', tg: true, attention: 1 },
  { name: 'wren', state: 'waiting on you', tone: 'warn', detail: 'asked a question 2 min ago', tg: true, attention: 2 },
  { name: 'quill', state: 'running', tone: 'ok', detail: 'Sonnet 5.5 · context 18%', tg: true, attention: 0 },
  { name: 'harbor', state: 'down', tone: 'bad', detail: 'exited 1 at 22:14 · restart failed twice', tg: false, attention: 0 },
  { name: '_example', state: 'stopped', tone: 'idle', detail: 'stopped by the operator', tg: false, attention: 0 },
];

export type Approval = { id: string; bot: string; title: string; widens: string; why: string; change: string; asked: string };
export const APPROVALS: Approval[] = [
  { id: 'a1', bot: 'atlas', title: 'Enable the browser tool', widens: 'tools.browser.enabled', why: 'The bot could drive an isolated headless Chrome.', change: 'tools.browser.enabled: false → true', asked: '4 min ago' },
  { id: 'a2', bot: 'wren', title: 'Add a Telegram sender', widens: 'telegram.allow', why: 'A second person could message this bot.', change: 'telegram.allow += 5550142', asked: '12 min ago' },
];

export type Attention = { id: string; bot: string; kind: string; tone: 'warn' | 'bad'; text: string; action: string; when: string };
export const ATTENTION: Attention[] = [
  { id: 'q1', bot: 'wren', kind: 'Waiting on you', tone: 'warn', text: 'Which chat should get the nightly digest: the ops group or your DM?', action: 'Open chat', when: '2 min' },
  { id: 'd1', bot: 'harbor', kind: 'Down', tone: 'bad', text: 'Exited 1 at 22:14. Two restarts failed with the same error.', action: 'Restart', when: '31 min' },
];

export const DECIDED = [
  { id: 'x1', title: 'Turn on sound', bot: 'atlas', out: 'approved' as const, who: 'operator@example.com', when: '21:58' },
  { id: 'x2', title: 'Disable vault-guard', bot: 'quill', out: 'declined' as const, who: 'operator@example.com', when: 'yesterday' },
];

export type Release = {
  tag: string; date: string; summary: string; notes: { title: string; body: string }[];
  actions: ('apply' | 'skip' | 'rollback')[];
};
export const RELEASES: { installed: Release & { pin: string }; available: Release[]; history: Release[] } = {
  installed: {
    tag: 'v0.8.4', date: '2 days ago', pin: 'Claude Code 2.3.1 · pinned, canary passed',
    summary: 'Names an MCP server from a Windows path the same on every host.', notes: [], actions: [],
  },
  available: [
    {
      tag: 'v0.9.0', date: 'today', actions: ['apply', 'skip'],
      summary: 'A new cockpit: readable on the phone, one-tap approvals, a Tools tab per bot.',
      notes: [
        { title: 'New cockpit', body: 'A bottom bar with Bots, Inbox, Accounts and Settings.' },
        { title: 'Approvals in one tap', body: 'Approve fires at once under Cloudflare Access; loopback installs pair a browser once.' },
        { title: 'Tools tab', body: 'Every harness, own and third-party tool per bot, with a switch, or the reason when it is locked.' },
      ],
    },
    {
      tag: 'v0.8.5', date: 'yesterday', actions: ['apply'],
      summary: 'Doctor warns when a bot is blocked on a dialog.', notes: [{ title: 'Doctor', body: 'A blocked bot is a warning, not a pass.' }],
    },
  ],
  history: [
    { tag: 'v0.8.3', date: '5 days ago', summary: 'Releases, changelog and rollback; browser pairing.', notes: [], actions: ['rollback'] },
    { tag: 'v0.8.2', date: '9 days ago', summary: 'Cockpit chat polish.', notes: [], actions: ['rollback'] },
  ],
};

export type Tool = {
  name: string; kind: 'skill' | 'agent' | 'hook' | 'tool' | 'mcp'; purpose: string; enabled: boolean;
  lock?: string; missing?: boolean; approval?: boolean;
};
export const TOOL_GROUPS: { id: 'harness' | 'own' | 'third'; title: string; license: string; tools: Tool[] }[] = [
  {
    id: 'harness', title: 'BotCorp harness', license: 'MIT', tools: [
      { name: 'standup', kind: 'skill', purpose: 'Reads the standing board, sweeps what the bot owns, updates the board.', enabled: true },
      { name: 'review-artifact', kind: 'skill', purpose: 'Builds a Yes / No / Don\'t know review page with an answer export.', enabled: true },
      { name: 'vault-guard', kind: 'hook', purpose: 'Blocks any read of the vault and its keys.', enabled: true, lock: 'Security guard: always on' },
      { name: 'operator-guard', kind: 'hook', purpose: 'Stops a bot from running operator-only verbs.', enabled: true, lock: 'Security guard: always on' },
      { name: 'critic', kind: 'agent', purpose: 'Scores a subagent\'s claims against its brief.', enabled: false },
    ],
  },
  {
    id: 'own', title: "This bot's own", license: 'private', tools: [
      { name: 'tg_send.py', kind: 'tool', purpose: 'Sends Telegram messages with the status footer.', enabled: true },
      { name: 'digest.py', kind: 'tool', purpose: 'The hourly worklist, sent only when it changes.', enabled: true },
      { name: 'build-state', kind: 'hook', purpose: 'Tracks a game build between sessions.', enabled: true, missing: true },
    ],
  },
  {
    id: 'third', title: 'Third-party', license: 'provider', tools: [
      { name: 'browser', kind: 'tool', purpose: 'agent-browser: an isolated Chrome for Testing.', enabled: false, approval: true },
      { name: 'cad-bridge', kind: 'mcp', purpose: 'A CAD app over MCP on 127.0.0.1:27182.', enabled: false, approval: true },
    ],
  },
];
