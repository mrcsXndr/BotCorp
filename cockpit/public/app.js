/* BotCorp cockpit frontend: bot list, live terminal (attached via the server
   to the bot's pty-host), chat view over the same socket, operator actions. */
'use strict';

// The Mode key. Claude Code cycles modes on Shift+Tab (ESC [ Z). If that does
// not reach it through ConPTY without VT input mode, switch this ONE constant
// to '\x1bm' (Alt+M, the documented Windows fallback).
const MODE_KEY_SEQ = '\x1b[Z';

// Login / Remote Control links printed in the TUI. The pty stream carries the
// URL unbroken even when the grid soft-wraps it.
const AUTH_URL_RE = /https:\/\/(?:claude\.(?:ai|com)|console\.anthropic\.com|accounts\.google\.com)[^\s\x1b"')\]]*/;

const unwrap = (g, key) => (g && g[key]) || g;
const FitAddonCtor = unwrap(window.FitAddon, 'FitAddon');
const WebLinksAddonCtor = unwrap(window.WebLinksAddon, 'WebLinksAddon');

const el = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  bots: [], selected: null, term: null, fit: null, ws: null, wsGen: 0,
  view: window.innerWidth <= 700 ? 'chat' : 'chat', drawer: null,
  reconnectDelay: 1000, reconnectTimer: null, sent: [], chatFile: null,
  lastAuthUrl: '', linkIntent: '',
};
let settings = { copyOnSelect: false };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem('cockpit.settings') || '{}') }; } catch {}
function saveSettings() { try { localStorage.setItem('cockpit.settings', JSON.stringify(settings)); } catch {} }

// Theme (theme.js applied it before first paint): auto -> light -> dark.
const THEMES = ['auto', 'light', 'dark'];
function renderThemeBtn() { el('themeBtn').textContent = 'theme: ' + (window.CockpitTheme ? window.CockpitTheme.get() : 'auto'); }
el('themeBtn').onclick = () => {
  if (!window.CockpitTheme) return;
  window.CockpitTheme.set(THEMES[(THEMES.indexOf(window.CockpitTheme.get()) + 1) % THEMES.length]);
  renderThemeBtn();
};
renderThemeBtn();

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

/* ---- bot list (single 5 s poll; everything per-bot arrives over the socket) ---- */
let lastSnapshot = '';
async function refresh() {
  try { state.bots = await api('GET', '/api/bots'); } catch (e) {
    // keep a list that already rendered; only the first load shows the failure
    if (!lastSnapshot) el('list').innerHTML = `<p class="errbox">Could not load the bots: ${esc(e.message)}. Retrying.</p>`;
    return;
  }
  // a '_' fixture (bots/_canary) is never listed: the page opens it by name (#_canary)
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  const fixture = hash.startsWith('_');
  if (fixture) {
    const b = await api('GET', `/api/bots/${encodeURIComponent(hash)}`).catch(() => null);
    if (b) state.bots.push(b);
  }
  const snap = JSON.stringify([state.bots.map((b) => [b.name, b.running, b.phase, b.pid, b.telegram, b.poller, b.blocked, b.down]), state.selected]);
  if (snap !== lastSnapshot) { lastSnapshot = snap; renderList(); if (state.selected) renderHeader(); }
  if (!state.selected && state.bots.length) {
    // a fixture that did not load never falls back to the only real bot
    const pick = state.bots.find((b) => b.name === hash) || (state.bots.length === 1 && !fixture ? state.bots[0] : null);
    if (pick) select(pick.name);
  }
}

function renderList() {
  const list = el('list');
  list.innerHTML = '';
  if (!state.bots.length) {
    list.innerHTML = '<div class="none">No bots yet. Create one with <code>botcorp new</code>.</div>';
    return;
  }
  for (const b of state.bots) {
    const btn = document.createElement('button');
    const s = botState(b);
    btn.className = 'bot ' + s.cls + (state.selected === b.name ? ' active' : '');
    btn.innerHTML = `<span class="n">${esc(b.name)}</span><span class="s">${esc(s.short)}</span>`;
    btn.onclick = () => select(b.name);
    list.appendChild(btn);
  }
}

function current() { return state.bots.find((b) => b.name === state.selected); }

// running = a pty-host OR a live claude --bg session (the server measures it the
// way `botcorp doctor` does); blocked = that session waits on a person; phase =
// the one phase every reader shows (core/state.mjs: idle, working, starting, down, ...).
function botState(b) {
  if (b.running && b.blocked) return { cls: 'on blocked', short: 'waiting on you', long: 'waiting on you' };
  if (b.running) {
    const how = b.kind === 'bg' ? `background session${b.bgId ? ' ' + b.bgId : ''}` : `pid ${b.pid}${b.mode ? ' · ' + b.mode : ''}`;
    return { cls: 'on', short: b.kind === 'bg' ? `${b.phase} · background` : `${b.phase} · pid ${b.pid}`, long: `${b.phase} · ${how}` };
  }
  const ph = b.phase || 'stopped';
  return { cls: b.down ? 'down' : '', short: ph, long: ph };
}

// doctor `telegram channel running`: OWNED = a poller runs under this bot's claude.
const POLLER_WHY = {
  OWNED: 'the Telegram poller runs under this bot\'s session',
  DEAD: 'no live Telegram poller under this bot\'s session',
  FOREIGN: 'another process holds this bot\'s Telegram token',
  NONE: 'the session started without its Telegram channel',
  ORPHAN: 'a Telegram poller is left over with no session',
  UNKNOWN: 'cannot tell (the process list was unavailable)',
  none: 'the session is not running',
};
function renderTelegram(b) {
  const chip = el('hTg');
  if (!b.poller) { chip.style.display = 'none'; return; }
  const up = b.poller.up;
  chip.style.display = '';
  chip.className = 'chip ' + (up ? 'ok' : b.running ? 'bad' : '');
  chip.textContent = up ? 'Telegram on' : b.poller.state === 'UNKNOWN' ? 'Telegram ?' : 'Telegram off';
  chip.title = POLLER_WHY[b.poller.state] || String(b.poller.state || '');
}

function renderHeader() {
  const b = current();
  if (!b) return;
  el('header').style.display = 'flex';
  el('tabs').style.display = 'flex';
  el('empty').style.display = 'none';
  el('hName').textContent = b.displayName && b.displayName !== b.name ? `${b.displayName} (${b.name})` : b.name;
  const s = botState(b);
  const st = el('hState');
  st.textContent = s.long;
  st.className = 'st ' + s.cls;
  st.title = b.down || '';
  renderTelegram(b);
  el('waitbar').classList.toggle('show', !!(b.running && b.blocked));
  el('waitbarText').textContent = b.running && b.blocked ? `Waiting on you: ${b.blocked.needs}` : '';
  el('waitbarText').title = b.running && b.blocked ? b.blocked.detail : '';
  // Never Start a live session: a second one means two Telegram pollers.
  el('startBtn').disabled = b.running;
  el('stopBtn').disabled = !b.running;
  el('restartBtn').disabled = !b.running;
  el('tabPairing').style.display = b.telegram ? '' : 'none';
  location.hash = b.name;
  if (state.drawer) renderDrawer(state.drawer);
}

function select(name) {
  if (state.selected === name) return;
  state.selected = name;
  state.drawer = null;
  el('drawer').className = 'drawer';
  el('exitbar').classList.remove('show');
  el('linkbar').classList.remove('show');
  document.querySelectorAll('.tabs button').forEach((t) => t.classList.remove('active'));
  renderList();
  renderHeader();
  resetChat();
  openTerminal(name);
  setView(state.view);
}

/* ---- drawers: details / pairing / vault / runs ---- */
document.querySelectorAll('.tabs button').forEach((t) => {
  t.onclick = () => {
    const which = t.dataset.drawer;
    if (state.drawer === which) { state.drawer = null; el('drawer').className = 'drawer'; t.classList.remove('active'); return; }
    state.drawer = which;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === t));
    renderDrawer(which);
  };
});

async function renderDrawer(which) {
  const b = current();
  const box = el('drawer');
  if (!b) return;
  box.className = 'drawer show';
  try {
    if (which === 'details') {
      const rows = [
        ['bot home', b.home], ['config home', b.configDir], ['model', b.model || 'default'],
        ['telegram', b.telegram ? 'enabled' : 'off'], ['remote control', b.remoteControl ? 'enabled' : 'off'],
        ['modules', Object.entries(b.modules || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'],
        ['daemon state', b.state ? JSON.stringify(b.state) : 'none written yet'],
        ['session', b.running ? `${b.kind === 'bg' ? 'background' : 'pty'}, pid ${b.pid}${b.startedAt ? `, since ${new Date(b.startedAt).toLocaleString()}` : ''}` : (b.down || 'not running')],
      ];
      if (b.running && b.kind === 'pty') rows.push(['pty host', `pid ${b.hostPid}`]);
      if (b.poller) rows.push(['telegram poller', `${b.poller.state}: ${POLLER_WHY[b.poller.state] || ''}`]);
      if (b.blocked) rows.push(['blocked', b.blocked.detail]);
      if (b.yamlError) rows.push(['bot.yaml', 'PARSE ERROR: ' + b.yamlError, 'bad']);
      box.innerHTML = `<div class="kv">${rows.map(([k, v, cls]) => `<span class="k">${esc(k)}</span><span class="v${cls ? ' ' + cls : ''}">${esc(v)}</span>`).join('')}</div>`;
    } else if (which === 'pairing') {
      box.innerHTML = '<p class="loading">Loading pairing</p>';
      const p = await api('GET', `/api/bots/${b.name}/pairing`);
      if (!p.present) { box.innerHTML = `<p class="hint">${esc(p.reason)}</p>`; return; }
      const age = (s) => s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
      let html = `<p class="hint">policy ${esc(p.dmPolicy || '?')} · allowed: ${p.allowFrom.length ? esc(p.allowFrom.join(', ')) : 'nobody yet'}</p>`;
      html += '<p class="hint">Approvals happen only here or in the terminal, never from a chat message.</p>';
      if (!p.pending.length) html += '<p class="hint">No pending senders. Whoever messages the bot gets a pairing code and shows up here.</p>';
      for (const q of p.pending) {
        const expired = q.expiresInS != null && q.expiresInS <= 0;
        html += `<div class="row"><span class="m">${esc(q.senderId)}</span><span class="dim grow">code ${esc(q.code)} · ${age(q.ageS)}${expired ? ' · expired' : ''}</span><button class="btn" data-pair="${esc(q.senderId)}">Approve</button><button class="btn quiet" data-deny="${esc(q.senderId)}">Deny</button></div>`;
      }
      html += '<div class="field"><input id="pairId" class="grow" placeholder="or a Telegram user id (@userinfobot tells you yours)" inputmode="numeric" /><button class="btn" id="pairManual">Approve id</button></div><div class="err" id="pairErr"></div>';
      box.innerHTML = html;
      box.querySelectorAll('[data-pair]').forEach((btn) => { btn.onclick = () => approve(b.name, btn.dataset.pair); });
      box.querySelectorAll('[data-deny]').forEach((btn) => { btn.onclick = () => deny(b.name, btn.dataset.deny); });
      el('pairManual').onclick = () => approve(b.name, el('pairId').value.trim());
    } else if (which === 'vault') {
      box.innerHTML = '<p class="loading">Loading the vault</p>';
      const list = await api('GET', `/api/bots/${b.name}/secrets`);
      let lock = null;
      try { lock = await api('GET', `/api/bots/${b.name}/secrets/lock`); } catch {}
      let html = '<p class="hint">Values are encrypted at rest and never shown. Set a key to replace its value.</p>';
      if (lock) {
        html += `<div class="row"><span class="grow h">Vault lock</span><span class="dim num">${esc(lock.mode)} v${esc(lock.version)}</span><span class="out ${lock.locked ? 'bad' : 'ok'}">${lock.locked ? 'LOCKED' : 'unlocked'}</span></div>`;
        html += `<p class="hint">${esc(lock.detail)}</p>`;
        if (lock.locked) html += '<div class="field"><input id="unlockPass" class="grow" type="password" placeholder="operator passphrase" autocomplete="off" /><button class="btn" id="unlockBtn">Unlock until reboot</button></div><div class="err" id="unlockErr"></div>';
      }
      html += list.length ? list.map((s) => `<div class="row"><span class="m grow">${esc(s.key)}</span><span class="dim num">${esc(s.masked)}</span></div>`).join('') : '<p class="hint">No secrets yet.</p>';
      html += '<div class="field"><input id="secKey" class="key" placeholder="key, e.g. oauth_token" /><input id="secVal" class="grow" type="password" placeholder="value" autocomplete="off" /><button class="btn" id="secSave">Set</button></div><div class="err" id="secErr"></div>';
      html += '<div class="row sec"><span class="grow h">Secret access</span><button class="btn quiet" id="auditRefresh">Refresh</button></div>';
      html += '<div id="auditRows"><p class="loading">Loading access records</p></div>';
      box.innerHTML = html;
      el('secSave').onclick = async () => {
        el('secErr').textContent = '';
        try {
          await api('PUT', `/api/bots/${b.name}/secrets/${encodeURIComponent(el('secKey').value.trim())}`, { value: el('secVal').value });
          el('secVal').value = '';
          toast('secret stored');
          renderDrawer('vault');
        } catch (e) { el('secErr').textContent = e.message; }
      };
      el('auditRefresh').onclick = () => loadAudit(b.name);
      const unlockBtn = el('unlockBtn');
      if (unlockBtn) unlockBtn.onclick = async () => {
        el('unlockErr').textContent = '';
        try {
          await api('POST', `/api/bots/${b.name}/unlock`, { passphrase: el('unlockPass').value });
          el('unlockPass').value = '';
          toast('vault unlocked until reboot');
          renderDrawer('vault');
        } catch (e) { el('unlockErr').textContent = e.message; }
      };
      loadAudit(b.name);
    } else if (which === 'runs') {
      box.innerHTML = '<p class="loading">Loading runs</p>';
      const r = await api('GET', `/api/bots/${b.name}/automations`);
      let html = '';
      if (r.declared.length) html += `<p class="hint">declared: ${r.declared.map((a) => `${esc(a.name)} (${esc(typeof a.trigger === 'object' ? JSON.stringify(a.trigger) : a.trigger)}${a.kind === 'prompt' ? ', prompt' : ''}${a.enabled ? '' : ', paused'})`).join(' · ')}</p>`;
      if (!r.present) html += '<p class="hint">No runs recorded yet (the daemon writes them).</p>';
      for (const run of r.runs.slice().reverse()) {
        // a prompt automation records `result` (sent / skipped: why / failed: why); a command, its exit code
        const res = typeof run.result === 'string' ? run.result : '';
        const outcome = res ? res.split(':')[0] : `exit ${run.exit}`;
        const cls = res ? (res === 'sent' ? 'ok' : res.startsWith('skipped') ? 'warn' : 'bad') : run.exit === 0 ? 'ok' : 'bad';
        html += `<div class="row"><span class="m">${esc(run.automation || run.name || '?')}</span><span class="dim grow num" title="${esc(run.start || run.ts || '')}">${esc(fmtWhen(run.start || run.ts) || run.start || run.ts || '')}${run.duration_s != null ? ' · ' + esc(run.duration_s) + 's' : ''}</span><span class="out ${cls}">${esc(outcome)}</span></div>${run.summary ? `<div class="run-sum">${esc(run.summary)}</div>` : ''}`;
      }
      box.innerHTML = html || '<p class="hint">Nothing here.</p>';
    }
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}

async function loadAudit(bot) {
  const box = el('auditRows');
  if (!box) return;
  try {
    const rows = await api('GET', `/api/bots/${bot}/secrets/audit?limit=100`);
    if (!rows.length) { box.innerHTML = '<p class="hint">No secret access recorded yet.</p>'; return; }
    box.innerHTML = rows.map((r) => `<div class="row"><span class="dim num" title="${esc(r.ts || '')}">${esc(fmtWhen(r.ts) || r.ts || '')}</span><span class="m grow">${esc(r.key || '')}</span><span class="dim">${esc(r.reason || '')}</span><span class="dim num">pid ${esc(r.pid ?? '?')}</span><span class="out ${r.ok === false ? 'bad' : 'ok'}">${r.ok === false ? 'FAILED' : 'ok'}</span></div>`).join('');
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}

async function approve(bot, senderId) {
  const errBox = el('pairErr');
  if (errBox) errBox.textContent = '';
  try {
    await api('POST', `/api/bots/${bot}/pair`, { senderId });
    toast(`approved ${senderId}`);
    renderDrawer('pairing');
  } catch (e) { if (errBox) errBox.textContent = e.message; else toast(e.message, true); }
}

async function deny(bot, senderId) {
  const errBox = el('pairErr');
  if (errBox) errBox.textContent = '';
  try {
    await api('POST', `/api/bots/${bot}/pair/deny`, { senderId });
    toast(`denied ${senderId}`);
    renderDrawer('pairing');
  } catch (e) { if (errBox) errBox.textContent = e.message; else toast(e.message, true); }
}

/* ---- terminal ---- */
function ensureTerm() {
  if (state.term) return;
  // The terminal's colours are the --term-* tokens (tokens.css), the same in both themes.
  const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const term = new window.Terminal({
    fontFamily: tok('--font-mono'), fontSize: 13, cursorBlink: true, scrollback: 5000,
    theme: { background: tok('--term-bg'), foreground: tok('--term-fg'), cursor: tok('--term-cursor'), selectionBackground: tok('--term-selection') },
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);
  if (WebLinksAddonCtor) term.loadAddon(new WebLinksAddonCtor((_e, uri) => window.open(uri, '_blank', 'noopener')));
  term.open(el('term'));
  fit.fit();
  term.onData((d) => sendInput(d));
  window.addEventListener('resize', () => doFit());

  // Copy on select is a SETTING: it fights long-press selection on phones.
  term.onSelectionChange(() => {
    if (!settings.copyOnSelect) return;
    const sel = term.getSelection();
    if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
      return false;
    }
    return true;
  });

  // Paste into the terminal: files upload; multi-line text goes in as ONE
  // bracketed paste so each newline does not submit a separate prompt.
  const holder = el('term');
  holder.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.kind === 'file') { e.preventDefault(); const f = it.getAsFile(); if (f) uploadFile(f); return; }
    }
    const text = e.clipboardData?.getData('text') || '';
    if (text.includes('\n')) { e.preventDefault(); sendInput(bracketed(text)); }
  }, true);

  state.term = term; state.fit = fit;
}

function bracketed(text) { return '\x1b[200~' + text.replace(/\r\n?/g, '\n') + '\x1b[201~'; }

function sendInput(d) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ t: 'i', d }));
  else toast('not attached: start the bot first', true);
}

function doFit() {
  if (!state.fit) return;
  try {
    state.fit.fit();
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ t: 'r', cols: state.term.cols, rows: state.term.rows }));
  } catch {}
}

// Attach = one WebSocket per selected bot; the server bridges it to the
// pty-host and pushes chat turns on the same socket. Reconnect with backoff
// whenever it drops while the bot stays selected.
function openTerminal(name) {
  ensureTerm();
  clearTimeout(state.reconnectTimer);
  const gen = ++state.wsGen;
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  state.term.reset();
  state.term.writeln(`\x1b[90mattaching to ${name}\x1b[0m`);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/term/${name}`);
  state.ws = ws;
  ws.onopen = () => { state.reconnectDelay = 1000; setTimeout(doFit, 60); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'o') { state.term.write(msg.d); scanForAuthUrl(msg.d); }
    else if (msg.t === 'hello') { el('exitbar').classList.remove('show'); }
    else if (msg.t === 'stopped') {
      // no pty-host; a live bg session has none by design
      const b = current();
      state.term.writeln(b && b.running
        ? `\x1b[90mbackground session, no terminal attached here (on the host: claude attach ${String(b.bgId || '<bg id>').replace(/[^\w<> -]/g, '')}). The chat view follows it.\x1b[0m`
        : '\x1b[90mstopped. Start launches it through the daemon.\x1b[0m');
    }
    else if (msg.t === 'exit') { showExit(msg.code); refresh(); }
    else if (msg.t === 'detached') { state.term.writeln('\r\n\x1b[90mdetached\x1b[0m'); }
    else if (msg.t === 'chat') { onChatPush(msg); }
    else if (msg.t === 'status') { state.status = msg; renderStats(); }
    else if (msg.t === 'err') { state.term.writeln(`\r\n\x1b[31m${msg.m}\x1b[0m`); }
  };
  ws.onclose = () => {
    if (gen !== state.wsGen || state.selected !== name) return;
    state.reconnectTimer = setTimeout(() => { if (state.selected === name && gen === state.wsGen) openTerminal(name); }, state.reconnectDelay);
    state.reconnectDelay = Math.min(15000, state.reconnectDelay * 2);
  };
}

function showExit(code) {
  el('exitbarText').textContent = `Session exited with code ${code}. Restart it?`;
  el('exitbar').classList.add('show');
}
el('exitbarClose').onclick = () => el('exitbar').classList.remove('show');
el('exitRestartBtn').onclick = () => lifecycle('start');

function scanForAuthUrl(chunk) {
  const m = AUTH_URL_RE.exec(chunk);
  if (!m || m[0] === state.lastAuthUrl || m[0].length < 30) return;
  state.lastAuthUrl = m[0];
  const isRc = /claude\.ai\/code|remote/i.test(m[0]);
  el('linkbarText').textContent = `${state.linkIntent || (isRc ? 'Remote Control link' : 'Login link')}: ${m[0]}`;
  el('linkbarBtn').onclick = () => { window.open(state.lastAuthUrl, '_blank', 'noopener'); };
  el('linkbar').classList.add('show');
}
el('linkbarClose').onclick = () => { el('linkbar').classList.remove('show'); state.linkIntent = ''; };

/* ---- key toolbar ---- */
el('keys').querySelectorAll('button[data-seq]').forEach((btn) => {
  const raw = btn.dataset.seq;
  const seq = raw === 'mode' ? MODE_KEY_SEQ : raw.replace(/\\x([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\t/g, '\t').replace(/\\r/g, '\r');
  btn.addEventListener('click', (e) => { e.preventDefault(); sendInput(seq); state.term?.focus(); });
});
el('attachBtn').onclick = () => el('fileInput').click();
el('fileInput').onchange = () => { const f = el('fileInput').files?.[0]; if (f) uploadFile(f); el('fileInput').value = ''; };

/* drop a file anywhere on the main area */
const mainEl = el('main');
mainEl.addEventListener('dragover', (e) => { e.preventDefault(); mainEl.classList.add('drop'); });
mainEl.addEventListener('dragleave', () => mainEl.classList.remove('drop'));
mainEl.addEventListener('drop', (e) => { e.preventDefault(); mainEl.classList.remove('drop'); const f = e.dataTransfer?.files?.[0]; if (f) uploadFile(f); });

// Upload, then type `@<forward-slash path> ` (no Enter) so the model reads it.
function uploadFile(file) {
  if (!state.selected) return;
  if (file.size > 8 * 1024 * 1024) { toast('file over 8 MB', true); return; }
  const name = state.selected;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      toast('uploading');
      const { path } = await api('POST', `/api/bots/${name}/paste`, { dataUrl: reader.result, name: file.name });
      sendInput(`@${path} `);
      toast('attached. Add your message and press Enter');
    } catch (e) { toast('upload failed: ' + e.message, true); }
  };
  reader.readAsDataURL(file);
}

/* ---- chat view (turns pushed by the server over the terminal socket) ---- */
function setView(view) {
  state.view = view;
  el('vtChat').classList.toggle('active', view === 'chat');
  el('vtTerm').classList.toggle('active', view === 'term');
  el('chatwrap').classList.toggle('show', view === 'chat');
  el('termwrap').classList.toggle('show', view === 'term');
  if (view === 'term') setTimeout(doFit, 30);
}
el('vtChat').onclick = () => setView('chat');
el('vtTerm').onclick = () => setView('term');

function resetChat() {
  state.sent = []; state.chatFile = null; state.status = null;
  el('msgs').innerHTML = '<div class="cempty">Loading the conversation</div>';
  renderStats();
}

function fmtWhen(ts) {
  const d = new Date(ts);
  if (!ts || isNaN(d)) return '';
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

function bubble(turn) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (turn.role === 'user' ? 'user' : 'assistant');
  // Channel messages (Telegram, ...): "Telegram · user · 16:34", then one
  // labelled line per attachment ("Voice note 0:12", "File report.pdf"). The
  // server sends labels, never a path or a file id.
  if (turn.meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = [turn.meta.source, turn.meta.user, fmtWhen(turn.meta.ts)].filter(Boolean).join(' · ');
    d.appendChild(m);
    for (const it of turn.meta.media || []) {
      const item = typeof it === 'string' ? { label: it } : it;
      const line = document.createElement('div');
      line.className = 'att';
      const k = document.createElement('span');
      k.className = 'att-k';
      k.textContent = String(item.label || 'Attachment');
      line.appendChild(k);
      if (item.detail) {
        const dd = document.createElement('span');
        dd.className = 'att-d';
        dd.textContent = String(item.detail);
        line.appendChild(dd);
      }
      d.appendChild(line);
      if (item.kind === 'voice') d.classList.add('voice');
    }
  }
  if (turn.text) {
    const body = document.createElement('div');
    body.className = 'md';
    // Transcript text is untrusted. md.js escapes every input character and emits
    // only its own fixed tag set, so its output is the one thing that may go
    // through innerHTML here; without it, plain text.
    if (window.CockpitMarkdown) body.innerHTML = window.CockpitMarkdown.renderMarkdown(turn.text);
    else body.textContent = turn.text;
    d.appendChild(body);
  }
  if (turn.tools?.length) {
    const t = document.createElement('span');
    t.className = 'tools';
    t.textContent = 'used: ' + turn.tools.join(', ');
    d.appendChild(t);
  }
  return d;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

// A background agent/command reporting back (<task-notification>, parsed on the
// server): a system event in the assistant lane, not a user turn. Every field
// is untrusted: textContent, except the result, which goes through md.js.
const TASK_STATES = ['completed', 'failed', 'running', 'killed', 'stopped'];
function taskCard(turn) {
  const t = turn.task || {};
  const d = document.createElement('div');
  d.className = 'bubble assistant task';
  const head = document.createElement('div');
  head.className = 'task-head';
  const st = document.createElement('span');
  st.className = 'task-st ' + (TASK_STATES.includes(t.status) ? t.status : 'other');
  st.textContent = String(t.status || 'unknown');
  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = String(t.summary || 'Background task');
  head.append(st, title);
  d.appendChild(head);
  const bits = [fmtWhen(turn.ts)];
  if (Number.isFinite(t.durationMs)) bits.push(fmtDuration(t.durationMs));
  if (Number.isFinite(t.tokens)) bits.push(`${fmtTok(t.tokens)} tokens`);
  if (Number.isFinite(t.toolUses)) bits.push(`${t.toolUses} tool uses`);
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.textContent = bits.filter(Boolean).join(' · ');
  d.appendChild(meta);
  if (t.result) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = 'Result';
    const body = document.createElement('div');
    body.className = 'md';
    if (window.CockpitMarkdown) body.innerHTML = window.CockpitMarkdown.renderMarkdown(String(t.result));
    else body.textContent = String(t.result);
    det.append(sum, body);
    d.appendChild(det);
  }
  return d;
}

// A voice-note transcript (the bot ran the transcriber; the server passes its
// output on as a `transcript` turn) goes under the voice note it belongs to:
// the oldest one still without a transcript that came after the last one that
// has one. With no such note it stands alone in the operator lane.
function addTranscript(box, turn) {
  const notes = [...box.querySelectorAll('.bubble.voice')];
  let lastDone = -1;
  notes.forEach((n, i) => { if (n.querySelector('.att-t')) lastDone = i; });
  let host = notes.slice(lastDone + 1).find((n) => !n.querySelector('.att-t'));
  if (!host) {
    host = document.createElement('div');
    host.className = 'bubble user';
    box.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'att-t';
  const label = document.createElement('span');
  label.className = 'att-tl';
  label.textContent = 'Transcript';
  const body = document.createElement('div');
  body.textContent = String(turn.text || '');
  t.append(label, body);
  host.appendChild(t);
}

function onChatPush(msg) {
  const box = el('msgs');
  if (msg.available === false) { box.innerHTML = `<div class="cempty err">Chat view unavailable: ${esc(msg.reason || '')}<br>The terminal still works.</div>`; return; }
  if (msg.rotated) { box.innerHTML = '<div class="cempty">New session, reloading</div>'; state.sent = []; return; }
  if (!msg.hasSession) { if (msg.initial) box.innerHTML = '<div class="cempty">No conversation yet. Say hello below.</div>'; return; }
  if (msg.initial) box.innerHTML = '';
  const ph = box.querySelector('.cempty');
  if (ph && msg.turns.length) ph.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  for (const turn of msg.turns) {
    // A message sent from here reaching the transcript: its bubble moves to
    // where the session took it instead of rendering twice.
    const mine = turn.role === 'user' && state.sent.find((s) => !s.seen && s.text === turn.text.trim());
    if (mine) { mine.seen = true; box.appendChild(mine.node); continue; }
    if (turn.role === 'transcript') { addTranscript(box, turn); continue; }
    box.appendChild(turn.role === 'task' ? taskCard(turn) : bubble(turn));
  }
  if (atBottom || msg.initial) box.scrollTop = box.scrollHeight;
}

// Chat send goes through the bot's inbox (POST /send -> `botcorp send`): it is
// typed into the session once the session is idle, and its status line follows
// it (queued, held, delivered, expired, not delivered).
async function sendChat() {
  const ta = el('chatInput');
  const text = ta.value.replace(/\s+$/, '');
  const name = state.selected;
  if (!text || !name) return;
  const box = el('msgs');
  box.querySelector('.cempty')?.remove();
  const s = { text: text.trim(), id: null, st: 'sending', seen: false, ...window.CockpitInbox.sentBubble(document, text) };
  state.sent.push(s);
  box.appendChild(s.node);
  box.scrollTop = box.scrollHeight;
  ta.value = '';
  ta.style.height = 'auto';
  try {
    const it = await api('POST', `/api/bots/${encodeURIComponent(name)}/send`, { text });
    s.id = it.id;
    s.st = window.CockpitInbox.setStatus(s.status, it);
    pollInbox();
  } catch (e) { s.st = window.CockpitInbox.setStatus(s.status, { status: 'failed', detail: e.message }); }
}

// Refreshes the status line of every sent message still open, while one is.
let inboxTimer = null;
function pollInbox() {
  clearTimeout(inboxTimer);
  const name = state.selected;
  if (!name || !state.sent.some((s) => s.id && !window.CockpitInbox.TERMINAL.includes(s.st))) return;
  inboxTimer = setTimeout(async () => {
    try {
      const rows = await api('GET', `/api/bots/${encodeURIComponent(name)}/inbox`);
      if (name !== state.selected) return;
      for (const s of state.sent) {
        const r = rows.find((x) => x.id === s.id);
        if (r) s.st = window.CockpitInbox.setStatus(s.status, r);
      }
    } catch {}
    pollInbox();
  }, 2000);
}
el('chatSend').onclick = sendChat;
el('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
el('chatInput').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(160, this.scrollHeight) + 'px'; });

/* ---- status chips: pushed by the server (cockpit/chatstatus.mjs) over the same
   socket when they change; ages and reset countdowns are computed here. A value
   the server could not read arrives as {na: why} and shows as n/a. ---- */
const fmtTok = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
function fmtIn(s) {
  if (s <= 0) return 'now';
  if (s < 60) return '<1m';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const fmtAgo = (s) => (s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`);
const level = (p) => (p >= 90 ? ' bad' : p >= 75 ? ' warn' : '');
const tip = (...lines) => lines.filter(Boolean).join('\n');
const statHtml = (k, v, r, title, cls = '') => `<button class="stat" title="${esc(title)}"><span class="k">${esc(k)}</span><span class="v${cls}">${esc(v)}</span>${r ? `<span class="r">${esc(r)}</span>` : ''}</button>`;

function renderStats() {
  const box = el('stats');
  const s = state.status;
  if (!s) { box.innerHTML = ''; return; }
  if (s.error) { box.innerHTML = statHtml('status', 'n/a', '', s.error); return; }
  const now = Date.now() / 1000;
  const age = s.ts ? now - s.ts : null;
  const read = age === null ? '' : `status.json written ${fmtAgo(age)}`;
  const out = [];
  const c = s.context;
  out.push(c.na ? statHtml('context', 'n/a', '', c.na)
    : statHtml('context', `${c.pct}%`, `${fmtTok(c.used)} / ${fmtTok(c.window)}`, tip(`${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens`, `window: ${c.source}`, read), level(c.pct)));
  for (const [k, name, w] of [['5h', '5-hour', s.fiveHour], ['7d', '7-day', s.sevenDay]]) {
    out.push(w.na ? statHtml(k, 'n/a', '', w.na)
      : statHtml(k, `${Math.round(w.pct)}%`, w.resetsAt ? `↻ ${fmtIn(w.resetsAt - now)}` : '', tip(`${w.pct}% of the ${name} limit used`, w.resetsAt ? `resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : 'reset time not reported', read), level(w.pct)));
  }
  const a = s.account;
  out.push(a.na ? statHtml('account', 'n/a', '', a.na) : statHtml('account', a.email || `token ****${a.tokenLast4}`, '', a.source));
  const m = s.model, e = s.effort;
  out.push(statHtml('model', m.na ? 'n/a' : m.name, e.na ? '' : e.level,
    tip(m.na ? `model: ${m.na}` : `model ${m.id || m.name}, from ${m.source}`, e.na ? `effort: ${e.na}` : `effort ${e.level}, from ${e.source}`)));
  box.innerHTML = out.join('');
  box.classList.toggle('stale', age !== null && age > 900);
}
// Tooltips do not exist on a phone: a tap shows the same text as a toast.
el('stats').onclick = (e) => { const b = e.target.closest('.stat'); if (b) toast(b.title); };
setInterval(renderStats, 30000);

/* ---- lifecycle (through the server, through the CLI) ---- */
async function lifecycle(action, fresh = false) {
  const name = state.selected;
  if (!name) return;
  el('more').open = false;
  ['startBtn', 'stopBtn', 'restartBtn'].forEach((id) => { el(id).disabled = true; });
  toast(`${action}${fresh ? ' (fresh)' : ''} ${name}`);
  try {
    const r = await api('POST', `/api/bots/${name}/${action}`, fresh ? { fresh: true } : undefined);
    toast(r.ok ? `${action} ok` : `${action} failed (${r.code}): ${r.err || r.out}`, !r.ok);
    el('exitbar').classList.remove('show');
  } catch (e) { toast(e.message, true); }
  await refresh();
  renderHeader();
  setTimeout(() => { if (state.selected === name) openTerminal(name); }, 600);
}
el('startBtn').onclick = () => lifecycle('start');
el('stopBtn').onclick = () => lifecycle('stop');
el('restartBtn').onclick = () => lifecycle('restart');
el('freshBtn').onclick = () => lifecycle('restart', true);

// Remote Control: /login (interactive, prints a claude.com link) enables it for
// this config home; /remote-control then prints the claude.ai/code link.
el('rcLoginBtn').onclick = () => { el('more').open = false; state.linkIntent = 'Log in to enable Remote Control'; state.lastAuthUrl = ''; sendInput('/login\r'); setView('term'); };
el('rcStartBtn').onclick = () => { el('more').open = false; state.linkIntent = 'Remote Control'; state.lastAuthUrl = ''; sendInput('/remote-control\r'); setView('term'); };

el('copySel').checked = !!settings.copyOnSelect;
el('copySel').onchange = () => { settings.copyOnSelect = el('copySel').checked; saveSettings(); };
document.addEventListener('click', (e) => { const m = el('more'); if (m.open && !m.contains(e.target)) m.open = false; });

/* ---- releases (machine-wide, not per-bot) ---- */
function relCard(r) {
  const statusCls = ['applied', 'failed', 'pending'].includes(r.status) ? r.status : '';
  const actions = r.status === 'pending' ? `<div class="actions"><button class="btn primary" data-apply="${esc(r.tag)}">Apply</button><button class="btn" data-skip="${esc(r.tag)}">Skip</button></div>` : '';
  return `<div class="rel">
    <div class="relhead"><span class="tag">${esc(r.tag)}</span><span class="date">${esc(r.date || '')}</span><span class="status ${statusCls}">${esc(r.status)}</span></div>
    <dl>
      <dt>what</dt><dd>${esc(r.what || '(none given)')}</dd>
      <dt>why</dt><dd>${esc(r.why || '(none given)')}</dd>
      <dt>value to you</dt><dd>${esc(r.value || '(none given)')}</dd>
    </dl>
    ${actions}
  </div>`;
}
async function loadUpdates() {
  const box = el('updatesList');
  box.innerHTML = '<p class="loading">Loading releases</p>';
  try {
    const { releases } = await api('GET', '/api/updates');
    box.innerHTML = releases.length ? releases.map(relCard).join('') : '<p class="hint">No releases recorded yet.</p>';
    box.querySelectorAll('[data-apply]').forEach((btn) => { btn.onclick = () => updateAction(btn.dataset.apply, 'apply'); });
    box.querySelectorAll('[data-skip]').forEach((btn) => { btn.onclick = () => updateAction(btn.dataset.skip, 'skip'); });
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}
async function updateAction(tag, action) {
  try {
    const r = await api('POST', `/api/updates/${encodeURIComponent(tag)}/${action}`);
    toast(r.ok ? `${action} ok` : `${action} failed (${r.code}): ${r.err || r.out}`, !r.ok);
  } catch (e) { toast(e.message, true); }
  loadUpdates();
}
el('updatesLink').onclick = (e) => { e.preventDefault(); el('updatesBg').classList.add('show'); loadUpdates(); };
el('updatesClose').onclick = () => el('updatesBg').classList.remove('show');
el('updatesBg').onclick = (e) => { if (e.target === el('updatesBg')) el('updatesBg').classList.remove('show'); };

/* ---- new chat modal ---- */
async function loadChatAccounts() {
  const sel = el('chatAccount');
  sel.innerHTML = '<option>Loading accounts</option>';
  try {
    const { accounts, error } = await api('GET', '/api/accounts');
    if (!accounts.length) {
      sel.innerHTML = '<option value="">no accounts: botcorp accounts add &lt;id&gt;</option>';
      sel.disabled = true;
    } else {
      sel.disabled = false;
      sel.innerHTML = accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.label || a.id)}${a.masked ? ' (' + esc(a.masked) + ')' : ''}</option>`).join('');
    }
    if (error) toast(error, true);
  } catch (e) {
    sel.innerHTML = '<option value="">no accounts: botcorp accounts add &lt;id&gt;</option>';
    sel.disabled = true;
  }
}
async function loadChatRecent() {
  const sel = el('chatRecent');
  sel.innerHTML = '<option value="">(none)</option>';
  try {
    const { recent } = await api('GET', '/api/chat/recent');
    if (recent.length) sel.innerHTML += recent.map((r) => `<option value="${esc(r.cwd)}">${esc(r.cwd)}</option>`).join('');
  } catch {}
}
function updateChatModeUI() { el('chatCwdBox').style.display = el('chatModeCodebase').checked ? '' : 'none'; }
el('chatModeGeneric').onchange = updateChatModeUI;
el('chatModeCodebase').onchange = updateChatModeUI;
el('chatRecent').onchange = () => { el('chatCwdInput').value = el('chatRecent').value; };
el('chatLink').onclick = (e) => {
  e.preventDefault();
  el('chatErr').textContent = '';
  el('chatOut').style.display = 'none';
  el('chatBg').classList.add('show');
  loadChatAccounts();
  loadChatRecent();
};
el('chatClose').onclick = () => el('chatBg').classList.remove('show');
el('chatBg').onclick = (e) => { if (e.target === el('chatBg')) el('chatBg').classList.remove('show'); };
el('chatLaunchBtn').onclick = async () => {
  el('chatErr').textContent = '';
  const account = el('chatAccount').value;
  if (!account) { el('chatErr').textContent = 'pick an account'; return; }
  const generic = el('chatModeGeneric').checked;
  const cwd = el('chatCwdInput').value.trim();
  if (!generic && !cwd) { el('chatErr').textContent = 'enter or pick a folder'; return; }
  el('chatLaunchBtn').disabled = true;
  try {
    const r = await api('POST', '/api/chat/launch', generic ? { account, generic: true } : { account, cwd });
    el('chatOut').style.display = 'block';
    el('chatOut').textContent = (r.out || '') + (r.err ? '\n' + r.err : '');
    toast(r.ok ? 'chat launched' : `launch failed (${r.code})`, !r.ok);
  } catch (e) { el('chatErr').textContent = e.message; }
  el('chatLaunchBtn').disabled = false;
};

/* ---- history modal ---- */
el('historyBtn').onclick = async () => {
  el('more').open = false;
  if (!state.selected) return;
  el('histTitle').textContent = `Sessions: ${state.selected}`;
  const box = el('histList');
  box.innerHTML = '<p class="loading">Loading sessions</p>';
  el('historyBg').classList.add('show');
  try {
    const sessions = await api('GET', `/api/bots/${state.selected}/sessions`);
    box.innerHTML = sessions.length ? '' : '<p class="hint">No sessions yet.</p>';
    for (const s of sessions) {
      const d = new Date(s.mtime);
      box.insertAdjacentHTML('beforeend', `<div class="hrow"><div class="top"><span class="num">${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${s.own ? '<span class="own">bot home</span>' : ''}<span class="sz">${(s.size / 1024).toFixed(0)} KB</span></div><div class="prev">${esc(s.preview) || '(no preview)'}</div>${s.own ? '' : `<div class="proj">${esc(s.project)}</div>`}</div>`);
    }
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
};
el('histClose').onclick = () => el('historyBg').classList.remove('show');
el('historyBg').onclick = (e) => { if (e.target === el('historyBg')) el('historyBg').classList.remove('show'); };

/* ---- boot ---- */
api('GET', '/api/engine/version').then((v) => { el('ver').textContent = [v.version, v.commit, v.exposure === 'access' ? 'via\xa0Access' : 'loopback\xa0only'].filter(Boolean).join('\xa0· '); }).catch(() => {});
refresh();
setInterval(refresh, 5000);
