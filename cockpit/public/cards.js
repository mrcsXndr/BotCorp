/* The decisions behind the cockpit's cards, kept free of the DOM so node can
   test them (cockpit/tests/cards.test.mjs): which lifecycle buttons a bot
   gets, how a pending approval reads to a person, the context bar, and the
   account name, the tools line, attachments. app.js renders what these return (and
   attention.mjs reuses approvalView for its line). Loaded before app.js. */
'use strict';
(function (root) {
  const fmtTok = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

  // A background bot (Telegram, long-running) is never stopped from here: it
  // gets Restart, plus Start while it is stopped so it can be brought back. A
  // pty bot gets Stop and Restart while it runs, Start when it does not.
  function lifecycleButtons(b) {
    const stopped = !b.running && (!b.phase || b.phase === 'stopped');
    if (b.kind === 'bg') return { start: stopped, stop: false, restart: true, primary: stopped ? 'start' : null };
    return { start: !b.running, stop: !!b.running, restart: !!b.running, primary: b.running ? null : 'start' };
  }

  // What a change widens, from its bot.yaml path (cli isWidening names the same paths).
  const WIDENS = {
    secrets: ['Secrets', 'A vault secret becomes readable by the bot or its jobs.'],
    senders: ['Who can message it', 'More people can reach the bot on Telegram.'],
    account: ['Claude account', 'The bot runs on another account, with that account\'s limits.'],
    exposure: ['Exposure', 'The bot can act with fewer checks, or be reached from outside.'],
    tools: ['Tools', 'A tool that talks to an outside service or carries a secret.'],
    jobs: ['Scheduled jobs', 'Something the bot runs on its own, on a timer or an event.'],
    other: ['Settings', 'A setting outside the usual list. Read the exact change.'],
  };
  function widensOf(path) {
    const p = String(path || '');
    if (p === 'secrets' || /^automations\.[^.]+\.secrets$/.test(p)) return 'secrets';
    if (/^integrations\.telegram\.(allow_from|dm_policy)$/.test(p)) return 'senders';
    if (p === 'account') return 'account';
    if (p === 'permissions' || p === 'harness.modules.remote_control' || p === 'harness.tools_registry' || p === 'harness.hooks_disable') return 'exposure';
    if (p === 'tools' || /^tools\.[^.]+\.enabled$/.test(p)) return 'tools';
    if (p === 'automations' || /^automations\.[^.]+\.enabled$/.test(p)) return 'jobs';
    return 'other';
  }
  // p: one row of GET /api/approvals. Every string stays text: the caller escapes.
  function approvalView(p) {
    const key = widensOf(p.path);
    const why = String(p.why || '').trim();
    const who = /^bot:(.+)$/.exec(String(p.requested_by || ''));
    return {
      title: why && why !== 'widening' ? why[0].toUpperCase() + why.slice(1) : `Change ${p.path}`,
      widens: key, widensLabel: WIDENS[key][0], widensText: WIDENS[key][1],
      change: String(p.diff || `${p.path}: ${p.value}`),
      asker: who ? `Asked by ${who[1]}` : p.requested_by ? `Queued by ${String(p.requested_by).replace(/^operator:/, '')}` : 'Asker unknown',
    };
  }

  // c: the status push's context {used, window, pct, source} or {na}.
  function contextBar(c) {
    if (!c || c.na || !Number.isFinite(c.used) || !Number.isFinite(c.window) || c.window <= 0) return { na: (c && c.na) || 'no reading' };
    const pct = Math.max(0, Math.min(100, Math.round(Number.isFinite(c.pct) ? c.pct : (c.used / c.window) * 100)));
    return { pct, level: pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '', label: `${fmtTok(c.used)} / ${fmtTok(c.window)}` };
  }

  // a: the status push's account {email} | {tokenLast4, source} | {na};
  // accounts: GET /api/accounts; configured: the bot.yaml account id. The name
  // is the registered account's label; the token's last 4 only go in the title.
  // reason: why the launch took that account (chat status accountReason):
  // failover marks the name as a backup; failback / recover only go in the title.
  const REASON_TEXT = { failover: 'on a backup account after a usage limit', failback: 'back on its primary account after a failover', recover: 'restarted on the same account after the limit reset' };
  function accountName(a, accounts, configured, reason) {
    if (!a || a.na) return { name: 'n/a', title: (a && a.na) || 'no reading' };
    const list = Array.isArray(accounts) ? accounts : [];
    const last4 = a.tokenLast4 ? String(a.tokenLast4) : '';
    const email = a.email ? String(a.email).toLowerCase() : '';
    const hit = (last4 && list.find((x) => x.masked && String(x.masked).endsWith(last4)))
      || (email && list.find((x) => String(x.label || '').toLowerCase() === email))
      || (!last4 && !email && configured && list.find((x) => x.id === configured));
    const tok = last4 ? `token ****${last4}` : '';
    const why = REASON_TEXT[reason] || '';
    const tag = (r) => (reason === 'failover' ? { name: `${r.name} (backup)`, title: [why, r.title].filter(Boolean).join(' · ') } : why ? { name: r.name, title: [why, r.title].filter(Boolean).join(' · ') } : r);
    if (hit) return tag({ name: String(hit.label || hit.id), title: [tok || (hit.masked ? `token ${hit.masked}` : ''), a.source].filter(Boolean).join(' · ') });
    if (email) return tag({ name: String(a.email), title: String(a.source || '') });
    return tag({ name: 'Own token', title: [tok, a.source].filter(Boolean).join(' · ') });
  }

  // ---- Settings: how the sheet edits one bot.yaml value (GET /api/bots/:name/config) ----
  // enum: a select over the values validate() accepts (plus the current one if
  // it is something else); readonly: a list, or a value another page owns.
  const CONFIG_ENUMS = {
    permissions: ['bypass', 'default'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    role: [null, 'admin'],
    'harness.channel': ['stable', 'pinned'],
    'harness.service': ['daemon', 'manual'],
    'harness.session': ['bg', 'pty'],
    'harness.tools_registry': ['warn', 'enforce'],
    'harness.modules.janitor': [true, false, 'report'],
    'integrations.telegram.dm_policy': ['pairing', 'allowlist', 'disabled'],
    'integrations.board.type': ['user', 'org'],
    'vault.lock': [null, 'none', 'operator'],
  };
  const CONFIG_ELSEWHERE = {
    account: 'the Accounts page', backup_accounts: 'the Accounts page', automations: 'the Automations and tools tab',
    tools: 'the Automations and tools tab', secrets: 'the Secrets tab', 'integrations.telegram.allow_from': 'the Telegram access tab',
  };
  function configField(p, value) {
    const where = CONFIG_ELSEWHERE[p] || CONFIG_ELSEWHERE[String(p).split('.')[0]];
    if (where) return { kind: 'readonly', note: `changed on ${where}` };
    if (p === 'name') return { kind: 'readonly', note: 'the bot folder name' };
    if (Object.hasOwn(CONFIG_ENUMS, p)) { const o = CONFIG_ENUMS[p]; return { kind: 'enum', options: o.includes(value) ? o : [...o, value] }; }
    if (Array.isArray(value) || (value && typeof value === 'object')) return { kind: 'readonly', note: 'a list: botcorp config set in the terminal' };
    if (typeof value === 'boolean') return { kind: 'bool' };
    if (typeof value === 'number') return { kind: 'number' };
    return { kind: 'text' };
  }
  // Every leaf of the effective config as {path, value}; a list is one leaf.
  function configRows(cfg, pre = '') {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return pre ? [{ path: pre, value: cfg === undefined ? null : cfg }] : [];
    return Object.keys(cfg).flatMap((k) => configRows(cfg[k], pre ? `${pre}.${k}` : k));
  }
  // How a value reads when it is not being edited.
  function configText(v) {
    if (v === null || v === undefined || v === '') return 'none';
    if (Array.isArray(v)) return !v.length ? 'none' : v.every((x) => typeof x !== 'object') ? v.join(', ') : `${v.length} ${v.length === 1 ? 'entry' : 'entries'}`;
    return String(v);
  }

  // The Usage sheet's chain line for one bot row (attention.mjs usageOverview):
  // '' without backups, else the chain in order and, after a failover, which
  // account it is on now.
  function chainLine(r) {
    const backups = r && Array.isArray(r.backups) ? r.backups.map(String) : [];
    if (!backups.length) return '';
    const chain = [r.account_wanted ? String(r.account_wanted) : 'own token', ...backups].join(' → ');
    const on = r.account_reason === 'failover' && r.account_attempted ? `, now on ${r.account_attempted} after a limit` : '';
    return `chain: ${chain}${on}`;
  }

  // The "used:" line under a bot message: an MCP tool (mcp__<server>__<tool>)
  // reads as "<Server> <tool words>", repeats collapse to "Bash ×2".
  function toolName(t) {
    const m = /^mcp__(.+?)__(.+)$/.exec(String(t));
    if (!m) return String(t);
    const words = m[1].replace(/^plugin_/, '').split(/[_-]+/).filter((w, i, a) => w && w !== a[i - 1]);
    const server = words.join(' ');
    return `${server.charAt(0).toUpperCase()}${server.slice(1)} ${m[2].replace(/[_-]+/g, ' ')}`.trim();
  }
  function toolsLine(tools) {
    const counts = new Map();
    for (const t of tools || []) { const n = toolName(t); counts.set(n, (counts.get(n) || 0) + 1); }
    return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
  }

  // Attachments. core/attach.mjs holds the same types and cap and has the last
  // word; this only refuses early, before anything is uploaded.
  const ATTACH_IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const ATTACH_EXT = [...ATTACH_IMAGE, 'pdf', 'txt', 'md', 'csv', 'json', 'log',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'sql', 'html', 'css', 'scss', 'xml', 'yaml', 'yml', 'toml', 'ini', 'diff', 'patch'];
  const ATTACH_MAX = 20 * 1024 * 1024, ATTACH_COUNT = 10;
  const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
  function fmtBytes(b) {
    const n = Number(b) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
  }
  // f: a File ({name, size}); count: how many are already on the message.
  // -> {name, size, image, why}: why is the refusal, '' when the file is taken.
  function attachView(f, count) {
    const name = String((f && f.name) || 'pasted');
    const ext = extOf(name);
    let why = '';
    if ((count || 0) >= ATTACH_COUNT) why = `At most ${ATTACH_COUNT} files per message.`;
    else if (!ATTACH_EXT.includes(ext)) why = `${name}: ${ext ? `.${ext} files are` : 'a file without an extension is'} not accepted. Images, PDF, text and code files are.`;
    else if (f.size > ATTACH_MAX) why = `${name} is over ${ATTACH_MAX / 1024 / 1024} MB.`;
    else if (!f.size) why = `${name} is empty.`;
    return { name, size: fmtBytes(f && f.size), image: ATTACH_IMAGE.includes(ext), why };
  }
  // A user turn as the session recorded it: the typed text, then one
  // "[attached: <path> (<type>, <size>)]" line per file, where Claude Code
  // appends "[Image #n]" after an image it attached. -> {body, files}.
  const ATT_LINE = /^\[attached: (.+) \(([a-z0-9]{1,8}), ([0-9.]+ [KM]?B)\)\]$/;
  function splitAttached(text) {
    const files = [], body = [];
    for (const line of String(text || '').split('\n')) {
      const m = ATT_LINE.exec(line.replace(/\s*\[Image #\d+\]/g, '').trim());
      if (!m) { body.push(line); continue; }
      const id = m[1].split(/[\\/]/).pop();
      files.push({ id, name: id.replace(/^\d{8}-\d{6}-/, ''), size: m[3], image: ATTACH_IMAGE.includes(m[2]) });
    }
    return { body: body.join('\n').replace(/\s+$/, ''), files };
  }

  // The header's review-board link. rb: getBot's reviewBoard (null = module off).
  // -> null (show nothing) | {none} (on, nothing recorded yet) | {url, count, title}.
  // The server already refused a non-artifact URL; this refuses it again before it becomes an href.
  const BOARD_URL_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9][A-Za-z0-9-]{7,}\/?$/;
  function boardLink(rb) {
    if (!rb || typeof rb !== 'object') return null;
    if (typeof rb.url !== 'string' || !BOARD_URL_RE.test(rb.url)) {
      return { none: true, title: 'The review board is on for this bot. It appears here once the bot publishes it.' };
    }
    const n = Number.isInteger(rb.open) && rb.open >= 0 ? rb.open : null;
    const answered = Number.isInteger(rb.answered) && rb.answered >= 0 ? `, ${rb.answered} answered` : '';
    return {
      url: rb.url,
      count: n === null ? '' : `${n} open`,
      title: `The bot's review board, in a new tab${n === null ? '' : ` (${n} open${answered})`}`,
    };
  }

  // The login bar: a sign-in link printed in the terminal. Only an oauth,
  // authorize or login path on claude.ai, claude.com or console.anthropic.com,
  // or an accounts.google.com URL; an artifact, chat or share link never is.
  // chunk: raw pty output (it carries the URL unbroken even when the grid
  // soft-wraps it). -> the first sign-in URL in it, or null.
  const LINK_RE = /https:\/\/(claude\.(?:ai|com)|console\.anthropic\.com|accounts\.google\.com)(?![\w.-])(\/[^\s\x1b"')\]]*)?/g;
  const AUTH_PATH_RE = /^\/(?:[^/?#]+\/)*(?:oauth|authorize|login)(?:[/?#]|$)/i;
  const NOT_AUTH_RE = /^\/(?:(?:code\/)?artifact|chat|share)\//i;
  function authUrl(chunk) {
    for (const m of String(chunk || '').matchAll(LINK_RE)) {
      const p = m[2] || '/';
      if (m[1] === 'accounts.google.com' || (!NOT_AUTH_RE.test(p) && AUTH_PATH_RE.test(p))) return m[0];
    }
    return null;
  }

  root.CockpitCards = { fmtTok, lifecycleButtons, approvalView, widensOf, contextBar, accountName, chainLine, configField, configRows, configText, toolName, toolsLine, WIDENS,
    fmtBytes, attachView, splitAttached, ATTACH_EXT, ATTACH_MAX, boardLink, authUrl };
})(typeof window !== 'undefined' ? window : globalThis);
