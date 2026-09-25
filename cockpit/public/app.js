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
  reconnectDelay: 1000, reconnectTimer: null, pendingUser: null, chatFile: null,
  lastAuthUrl: '', linkIntent: '',
};
let settings = { copyOnSelect: false };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem('cockpit.settings') || '{}') }; } catch {}
function saveSettings() { try { localStorage.setItem('cockpit.settings', JSON.stringify(settings)); } catch {} }

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
  try { state.bots = await api('GET', '/api/bots'); } catch (e) { return; }
  const snap = JSON.stringify([state.bots.map((b) => [b.name, b.running, b.pid, b.telegram]), state.selected]);
  if (snap !== lastSnapshot) { lastSnapshot = snap; renderList(); if (state.selected) renderHeader(); }
  if (!state.selected && state.bots.length) {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    const pick = state.bots.find((b) => b.name === hash) || (state.bots.length === 1 ? state.bots[0] : null);
    if (pick) select(pick.name);
  }
}

function renderList() {
  const list = el('list');
  list.innerHTML = '';
  if (!state.bots.length) {
    list.innerHTML = '<div class="none">No bots yet. Create one: <code>botcorp new</code></div>';
    return;
  }
  for (const b of state.bots) {
    const btn = document.createElement('button');
    btn.className = 'bot' + (b.running ? ' on' : '') + (state.selected === b.name ? ' active' : '');
    btn.innerHTML = `<span class="n">${esc(b.name)}</span><span class="s">${b.running ? 'running · pid ' + esc(b.pid) : 'stopped'}</span>`;
    btn.onclick = () => select(b.name);
    list.appendChild(btn);
  }
}

function current() { return state.bots.find((b) => b.name === state.selected); }

function renderHeader() {
  const b = current();
  if (!b) return;
  el('header').style.display = 'flex';
  el('tabs').style.display = 'flex';
  el('empty').style.display = 'none';
  el('hName').textContent = b.displayName && b.displayName !== b.name ? `${b.displayName} (${b.name})` : b.name;
  const bg = b.service === 'bg' && b.bgId;
  const st = el('hState');
  st.textContent = b.running ? (bg ? `background session ${b.bgId} (attach)` : `running · pid ${b.pid}${b.mode ? ' · ' + b.mode : ''}`) : 'stopped';
  st.className = 'st' + (b.running ? ' on' : '');
  el('startBtn').disabled = b.running;
  el('startBtn').textContent = bg ? 'Attach' : 'Start';
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
        ['pty host', b.running ? `pid ${b.hostPid}, since ${new Date(b.startedAt).toLocaleString()}` : 'not running'],
      ];
      if (b.yamlError) rows.push(['bot.yaml', 'PARSE ERROR: ' + b.yamlError]);
      box.innerHTML = `<div class="kv">${rows.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join('')}</div>`;
    } else if (which === 'pairing') {
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
      html += '<div class="field"><input id="pairId" placeholder="or a Telegram user id (@userinfobot tells you yours)" inputmode="numeric" style="flex:1" /><button class="btn" id="pairManual">Approve id</button></div><div class="err" id="pairErr"></div>';
      box.innerHTML = html;
      box.querySelectorAll('[data-pair]').forEach((btn) => { btn.onclick = () => approve(b.name, btn.dataset.pair); });
      box.querySelectorAll('[data-deny]').forEach((btn) => { btn.onclick = () => deny(b.name, btn.dataset.deny); });
      el('pairManual').onclick = () => approve(b.name, el('pairId').value.trim());
    } else if (which === 'vault') {
      box.innerHTML = '<p class="hint">loading</p>';
      const list = await api('GET', `/api/bots/${b.name}/secrets`);
      let lock = null;
      try { lock = await api('GET', `/api/bots/${b.name}/secrets/lock`); } catch {}
      let html = '<p class="hint">Values are encrypted at rest and never shown. Set a key to replace its value.</p>';
      if (lock) {
        html += `<div class="row"><span class="grow" style="font-weight:600">Vault lock</span><span class="dim">${esc(lock.mode)} v${esc(lock.version)}</span><span class="m" style="color:${lock.locked ? 'var(--bad)' : 'var(--ok)'}">${lock.locked ? 'LOCKED' : 'unlocked'}</span></div>`;
        html += `<p class="hint">${esc(lock.detail)}</p>`;
        if (lock.locked) html += '<div class="field"><input id="unlockPass" type="password" placeholder="operator passphrase" style="flex:1" autocomplete="off" /><button class="btn" id="unlockBtn">Unlock until reboot</button></div><div class="err" id="unlockErr"></div>';
      }
      html += list.length ? list.map((s) => `<div class="row"><span class="m grow">${esc(s.key)}</span><span class="dim">${esc(s.masked)}</span></div>`).join('') : '<p class="hint">No secrets yet.</p>';
      html += '<div class="field"><input id="secKey" placeholder="key (oauth_token, telegram_token, ...)" /><input id="secVal" type="password" placeholder="value" style="flex:1" autocomplete="off" /><button class="btn" id="secSave">Set</button></div><div class="err" id="secErr"></div>';
      html += '<div class="row" style="margin-top:10px"><span class="grow" style="font-weight:600">Secret access</span><button class="btn quiet" id="auditRefresh">Refresh</button></div>';
      html += '<div id="auditRows"><p class="hint">loading</p></div>';
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
      const r = await api('GET', `/api/bots/${b.name}/automations`);
      let html = '';
      if (r.declared.length) html += `<p class="hint">declared: ${r.declared.map((a) => `${esc(a.name)} (${esc(typeof a.trigger === 'object' ? JSON.stringify(a.trigger) : a.trigger)}${a.kind === 'prompt' ? ', prompt' : ''}${a.enabled ? '' : ', paused'})`).join(' · ')}</p>`;
      if (!r.present) html += '<p class="hint">No runs recorded yet (the daemon writes them).</p>';
      for (const run of r.runs.slice().reverse()) {
        // A prompt automation's record carries `result`: sent | failed: ... | skipped: <reason>.
        const res = typeof run.result === 'string' ? run.result : null;
        const outcome = res ? res.split(':')[0] : `exit ${run.exit}`;
        const color = res ? (res === 'sent' ? 'var(--ok)' : res.startsWith('skipped') ? 'var(--warn)' : 'var(--bad)') : (run.exit === 0 ? 'var(--ok)' : 'var(--bad)');
        html += `<div class="row"><span class="m">${esc(run.automation || run.name || '?')}</span><span class="dim grow">${esc(run.start || run.ts || '')}${run.duration_s != null ? ' · ' + esc(run.duration_s) + 's' : ''}</span><span class="m" style="color:${color}">${esc(outcome)}</span></div>${run.summary ? `<div class="dim" style="padding:0 0 6px">${esc(run.summary)}</div>` : ''}`;
      }
      box.innerHTML = html || '<p class="hint">Nothing here.</p>';
    }
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function loadAudit(bot) {
  const box = el('auditRows');
  if (!box) return;
  try {
    const rows = await api('GET', `/api/bots/${bot}/secrets/audit?limit=100`);
    if (!rows.length) { box.innerHTML = '<p class="hint">No secret access recorded yet.</p>'; return; }
    box.innerHTML = rows.map((r) => `<div class="row"><span class="m">${esc(r.ts || '')}</span><span class="m grow">${esc(r.key || '')}</span><span class="dim">${esc(r.reason || '')}</span><span class="dim">pid ${esc(r.pid ?? '?')}</span><span class="m" style="color:${r.ok === false ? 'var(--bad)' : 'var(--ok)'}">${r.ok === false ? 'FAILED' : 'ok'}</span></div>`).join('');
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
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
  const term = new window.Terminal({
    fontFamily: '"Cascadia Code", Consolas, ui-monospace, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000,
    theme: { background: '#0d100e', foreground: '#d8ded3', cursor: '#9fbb94', selectionBackground: '#2f4a3a' },
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
    else if (msg.t === 'stopped') { state.term.writeln('\x1b[90mstopped. Start launches it through the daemon.\x1b[0m'); }
    else if (msg.t === 'exit') { showExit(msg.code); refresh(); }
    else if (msg.t === 'detached') { state.term.writeln('\r\n\x1b[90mdetached\x1b[0m'); }
    else if (msg.t === 'chat') { onChatPush(msg); }
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
  state.pendingUser = null; state.chatFile = null;
  el('msgs').innerHTML = '<div class="cempty">loading</div>';
}

function bubble(turn) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (turn.role === 'user' ? 'user' : 'assistant');
  d.textContent = turn.text;   // transcript text is untrusted: never innerHTML
  if (turn.tools?.length) {
    const t = document.createElement('span');
    t.className = 'tools';
    t.textContent = 'used: ' + turn.tools.join(', ');
    d.appendChild(t);
  }
  return d;
}

function onChatPush(msg) {
  const box = el('msgs');
  if (msg.available === false) { box.innerHTML = `<div class="cempty">Chat view unavailable: ${esc(msg.reason || '')}<br>The terminal still works.</div>`; return; }
  if (msg.rotated) { box.innerHTML = '<div class="cempty">new session, reloading</div>'; state.pendingUser = null; return; }
  if (!msg.hasSession) { if (msg.initial) box.innerHTML = '<div class="cempty">No conversation yet. Say hello below.</div>'; return; }
  if (msg.initial) box.innerHTML = '';
  const ph = box.querySelector('.cempty');
  if (ph && msg.turns.length) ph.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  for (const turn of msg.turns) {
    if (turn.role === 'user' && state.pendingUser && turn.text.trim() === state.pendingUser) { state.pendingUser = null; continue; }
    box.appendChild(bubble(turn));
  }
  if (atBottom || msg.initial) box.scrollTop = box.scrollHeight;
}

function sendChat() {
  const ta = el('chatInput');
  const text = ta.value.replace(/\s+$/, '');
  if (!text) return;
  if (!state.ws || state.ws.readyState !== 1) { toast('not attached: start the bot first', true); return; }
  const box = el('msgs');
  box.querySelector('.cempty')?.remove();
  state.pendingUser = text.trim();
  box.appendChild(bubble({ role: 'user', text }));
  box.scrollTop = box.scrollHeight;
  sendInput(bracketed(text));
  sendInput('\r');
  ta.value = '';
  ta.style.height = 'auto';
}
el('chatSend').onclick = sendChat;
el('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
el('chatInput').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(160, this.scrollHeight) + 'px'; });

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
  const statusCls = r.status === 'applied' ? 'applied' : r.status === 'failed' ? 'failed' : '';
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
  box.innerHTML = '<p class="hint">loading</p>';
  try {
    const { releases } = await api('GET', '/api/updates');
    box.innerHTML = releases.length ? releases.map(relCard).join('') : '<p class="hint">No releases recorded yet.</p>';
    box.querySelectorAll('[data-apply]').forEach((btn) => { btn.onclick = () => updateAction(btn.dataset.apply, 'apply'); });
    box.querySelectorAll('[data-skip]').forEach((btn) => { btn.onclick = () => updateAction(btn.dataset.skip, 'skip'); });
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
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
  sel.innerHTML = '<option>loading...</option>';
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
  box.innerHTML = '<p class="hint">loading</p>';
  el('historyBg').classList.add('show');
  try {
    const sessions = await api('GET', `/api/bots/${state.selected}/sessions`);
    box.innerHTML = sessions.length ? '' : '<p class="hint">No sessions yet.</p>';
    for (const s of sessions) {
      const d = new Date(s.mtime);
      box.insertAdjacentHTML('beforeend', `<div class="hrow"><div class="top"><span>${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${s.own ? '<span class="own">bot home</span>' : ''}<span class="sz">${(s.size / 1024).toFixed(0)} KB</span></div><div class="prev">${esc(s.preview) || '(no preview)'}</div>${s.own ? '' : `<div class="proj">${esc(s.project)}</div>`}</div>`);
    }
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
};
el('histClose').onclick = () => el('historyBg').classList.remove('show');
el('historyBg').onclick = (e) => { if (e.target === el('historyBg')) el('historyBg').classList.remove('show'); };

/* ---- boot ---- */
api('GET', '/api/engine/version').then((v) => { el('ver').textContent = [v.version, v.commit, v.exposure === 'access' ? 'via Access' : 'loopback only'].filter(Boolean).join(' · '); }).catch(() => {});
refresh();
setInterval(refresh, 5000);
