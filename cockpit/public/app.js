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
  reconnectDelay: 1000, reconnectTimer: null, sent: [], chatFile: null, attached: [], follow: true, unseen: 0,
  lastAuthUrl: '', linkIntent: '', attn: null, capsTab: 'autos', toolsScan: null,
};
let settings = { copyOnSelect: false };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem('cockpit.settings') || '{}') }; } catch {}
function saveSettings() { try { localStorage.setItem('cockpit.settings', JSON.stringify(settings)); } catch {} }

// Theme (theme.js applied it before first paint): auto -> light -> dark.
const THEMES = ['auto', 'light', 'dark'];
function renderThemeBtn() { el('themeLabel').textContent = 'Theme: ' + (window.CockpitTheme ? window.CockpitTheme.get() : 'auto'); }
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
  const snap = JSON.stringify([state.bots.map((b) => [b.name, b.running, b.phase, b.pid, b.telegram, b.poller, b.blocked, b.down, b.reviewBoard]), state.selected]);
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

// The bot's ONE review board (harness.modules.review_board): a link when it is
// recorded, a muted "no board yet" while the module is on without one, nothing when off.
function renderBoard(b) {
  const v = window.CockpitCards.boardLink(b.reviewBoard);
  const a = el('hBoard');
  a.hidden = !v || !!v.none;
  el('hBoardNone').hidden = !v || !v.none;
  if (!v) return;
  if (v.none) { el('hBoardNone').title = v.title; return; }
  a.href = v.url;
  a.title = v.title;
  el('hBoardN').textContent = v.count;
  el('hBoardN').hidden = !v.count;
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
  renderBoard(b);
  st.title = b.running && b.blocked ? b.blocked.detail : st.title;
  // Never Start a live session: a second one means two Telegram pollers. A
  // background bot has no Stop: the daemon heals it, so Restart is the lever.
  const lc = window.CockpitCards.lifecycleButtons(b);
  el('startBtn').hidden = !lc.start;
  el('stopBtn').hidden = !lc.stop;
  el('restartBtn').hidden = !lc.restart;
  el('startBtn').classList.toggle('primary', lc.primary === 'start');
  ['startBtn', 'stopBtn', 'restartBtn'].forEach((id) => { el(id).disabled = false; });
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

// Each drawer opens with what it is for, in one line, before any data.
const DRAWER_HEAD = {
  details: ['Overview', 'Where the bot lives, how it runs, and what is switched on.'],
  pairing: ['Telegram access', 'Who may message the bot. New senders wait here for you.'],
  vault: ['Secrets', 'Keys the bot and its jobs can read. Values never leave the vault.'],
  runs: ['Activity', 'What the bot\'s scheduled jobs did, newest first.'],
  caps: ['Automations and tools', 'Jobs the bot runs on its own, and the outside tools it may call.'],
};
async function renderDrawer(which) {
  const b = current();
  const box = el('drawerBody');
  if (!b) return;
  el('drawer').className = 'drawer show';
  const [title, why] = DRAWER_HEAD[which] || [which, ''];
  el('dhead').innerHTML = `<b>${esc(title)}</b><span>${esc(why)}</span>`;
  try {
    if (which === 'details') {
      const rows = [
        ['Session', b.running ? `${b.kind === 'bg' ? 'Background' : 'Terminal (pty)'}, pid ${b.pid}${b.startedAt ? `, since ${new Date(b.startedAt).toLocaleString()}` : ''}` : (b.down || 'Not running')],
        ['Model', b.model || 'Default'],
        ['Telegram', b.telegram ? 'On' : 'Off'], ['Remote Control', b.remoteControl ? 'On' : 'Off'],
        ['Modules', Object.entries(b.modules || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'None'],
        ['Bot folder', b.home], ['Config folder', b.configDir],
      ];
      if (b.running && b.kind === 'pty') rows.push(['Terminal host', `pid ${b.hostPid}`]);
      if (b.poller) rows.push(['Telegram listener', POLLER_WHY[b.poller.state] || b.poller.state]);
      if (b.blocked) rows.push(['Waiting on you', b.blocked.detail]);
      if (b.yamlError) rows.push(['bot.yaml', 'Cannot be read: ' + b.yamlError, 'bad']);
      box.innerHTML = `<div class="kv">${rows.map(([k, v, cls]) => `<span class="k">${esc(k)}</span><span class="v${cls ? ' ' + cls : ''}">${esc(v)}</span>`).join('')}</div>`
        + `<details class="raw"><summary>Daemon state (raw)</summary><pre>${esc(b.state ? JSON.stringify(b.state, null, 2) : 'none written yet')}</pre></details>`;
    } else if (which === 'pairing') {
      box.innerHTML = '<p class="loading">Loading pairing</p>';
      const p = await api('GET', `/api/bots/${b.name}/pairing`);
      if (!p.present) { box.innerHTML = `<p class="hint">${esc(p.reason)}</p>`; return; }
      const age = (s) => s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
      let html = `<div class="kv"><span class="k">Who may write</span><span class="v">${p.dmPolicy === 'allowlist' ? 'Only the people allowed below' : p.dmPolicy === 'pairing' ? 'Anyone who pairs with a code you approve' : p.dmPolicy === 'disabled' ? 'Nobody (direct messages are off)' : esc(p.dmPolicy || 'Unknown')}</span><span class="k">Allowed</span><span class="v">${p.allowFrom.length ? esc(p.allowFrom.join(', ')) : 'Nobody yet'}</span></div>`;
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
          await operatorApi('PUT', `/api/bots/${b.name}/secrets/${encodeURIComponent(el('secKey').value.trim())}`, { value: el('secVal').value });
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
      if (r.declared.length) html += `<p class="hint">Jobs: ${r.declared.map((a) => `${esc(a.name)} (${esc(fmtTrigger(a.trigger))}${a.kind === 'prompt' ? ', prompt' : ''}${a.enabled ? '' : ', paused'})`).join(' · ')}</p>`;
      if (!r.present) html += '<p class="hint">No runs yet. Each run shows up here once the daemon has started it.</p>';
      for (const run of r.runs.slice().reverse()) {
        // a prompt automation records `result` (sent / skipped: why / failed: why); a command, its exit code
        const res = typeof run.result === 'string' ? run.result : '';
        const outcome = res ? res.split(':')[0] : `exit ${run.exit}`;
        const cls = res ? (res === 'sent' ? 'ok' : res.startsWith('skipped') ? 'warn' : 'bad') : run.exit === 0 ? 'ok' : 'bad';
        html += `<div class="row"><span class="m">${esc(run.automation || run.name || '?')}</span><span class="dim grow num" title="${esc(run.start || run.ts || '')}">${esc(fmtWhen(run.start || run.ts) || run.start || run.ts || '')}${run.duration_s != null ? ' · ' + esc(run.duration_s) + 's' : ''}</span><span class="out ${cls}">${esc(outcome)}</span></div>${run.summary ? `<div class="run-sum">${esc(run.summary)}</div>` : ''}`;
      }
      box.innerHTML = html || '<p class="hint">Nothing here.</p>';
    } else if (which === 'caps') {
      const seg = `<div class="seg capseg"><button data-caps="autos"${state.capsTab === 'autos' ? ' class="active"' : ''}>Automations</button><button data-caps="tools"${state.capsTab === 'tools' ? ' class="active"' : ''}>Tools</button></div>`;
      box.innerHTML = seg + '<div id="capsBody"><p class="loading">Loading</p></div>';
      box.querySelectorAll('[data-caps]').forEach((t) => { t.onclick = () => { state.capsTab = t.dataset.caps; renderDrawer('caps'); }; });
      const body = el('capsBody');
      if (state.capsTab === 'autos') body.innerHTML = automationsHtml(b, await api('GET', `/api/bots/${b.name}/automations`));
      else body.innerHTML = toolsHtml(await api('GET', `/api/bots/${b.name}/tools`));
      wireCaps(b, body);
    }
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}

/* ---- capabilities: a bot's automations and its tools registry ---- */
function fmtTrigger(t) {
  if (t && typeof t === 'object') {
    if (t.interval_min != null) return `every ${t.interval_min} min`;
    if (t.cron) return `cron ${t.cron}`;
    if (t.event) return `on ${t.event}`;
  }
  return typeof t === 'string' ? t : JSON.stringify(t);
}
function automationsHtml(b, r) {
  if (!r.declared.length) return '<p class="hint">No automations declared in bot.yaml.</p>';
  return r.declared.map((a) => {
    const s = r.state[a.name] || {};
    const streak = Number(s.failure_streak) || 0;
    const last = typeof s.last_result === 'string' && s.last_result ? s.last_result.split(':')[0] : s.last_exit != null ? `exit ${s.last_exit}` : '';
    const bits = [fmtTrigger(a.trigger) + (a.kind === 'prompt' ? ', prompt' : '')];
    bits.push(s.last_run ? `last run ${esc(fmtWhen(s.last_run))}${last ? ' · ' + esc(last) : ''}` : 'never run');
    if (streak) bits.push(`<span class="${streak >= 3 ? 'bad' : ''}">${streak} failed in a row</span>`);
    if (a.enabled && s.next_due) bits.push(`next ${esc(fmtWhen(s.next_due))}`);
    if (a.secrets.length) bits.push(`secrets ${esc(a.secrets.join(', '))}`);
    return `<div class="cap"><div class="grow"><div class="l1"><span class="h">${esc(a.name)}</span><span class="out ${a.enabled ? 'ok' : 'warn'}">${a.enabled ? 'enabled' : 'paused'}</span></div><div class="l2">${bits.map((x, i) => (i === 0 ? esc(x) : x)).join(' · ')}</div></div>`
      + `<div class="acts"><button class="btn" data-auto="${esc(a.name)}" data-act="run">Run now</button><button class="btn quiet" data-auto="${esc(a.name)}" data-act="${a.enabled ? 'pause' : 'resume'}">${a.enabled ? 'Pause' : 'Resume'}</button></div></div>`;
  }).join('');
}
function toolsHtml(s) {
  if (s.registry === 'off') return '<p class="hint">No registry: this bot.yaml has no <code>tools:</code> list. <code>botcorp tools &lt;bot&gt; scan --proposal &lt;file&gt;</code> drafts one.</p>';
  const missing = new Set(s.missing);
  let html = `<p class="hint">registry <b>${esc(s.registry)}</b> · <span class="num">${s.registered.length}</span> registered · <span class="num">${s.unregistered.length}</span> unregistered · <span class="num">${s.missing.length}</span> missing</p>`;
  const props = s.proposal.tools, orphans = s.proposal.orphans;
  if (props.length || orphans.length) {
    html += `<p class="caphead">Unregistered <span class="num">${s.unregistered.length}</span></p>`;
    props.forEach((p, i) => {
      html += `<div class="cap"><div class="grow"><div class="l1"><span class="p">${esc(p.path)}</span></div><div class="l2">register as ${esc(p.name)} (${esc(p.kind)})${p.purpose ? ': ' + esc(p.purpose) : ''}${p.secrets ? ' · secrets ' + esc(p.secrets.join(', ')) : ''}</div></div>`
        + `<div class="acts"><button class="btn" data-reg="${i}">Register</button>${p.path.includes('*') ? '' : `<button class="btn quiet" data-retire="${esc(p.path)}">Retire</button>`}</div></div>`;
    });
    for (const o of orphans) {
      const p = typeof o === 'string' ? o : o.path;
      html += `<div class="cap"><div class="grow"><div class="l1"><span class="p">${esc(p)}</span></div><div class="l2">nothing runs, documents or imports it${o.reads ? ' · reads ' + esc(o.reads.join(', ')) : ''}</div></div><div class="acts"><button class="btn quiet" data-retire="${esc(p)}">Retire</button></div></div>`;
    }
  }
  if (missing.size) {
    html += `<p class="caphead">Missing <span class="num">${missing.size}</span></p>`;
    for (const t of s.registered.filter((r) => missing.has(r.name))) html += `<div class="cap"><div class="grow"><div class="l1"><span class="h">${esc(t.name)}</span><span class="out bad">missing</span></div><div class="l2"><span class="p">${esc(t.path)}</span> matches no file</div></div><div class="acts"><button class="btn quiet" data-retire="${esc(t.name)}">Remove entry</button></div></div>`;
  }
  const ok = s.registered.filter((r) => !missing.has(r.name));
  html += `<p class="caphead">Registered <span class="num">${ok.length}</span></p>`;
  html += ok.length ? ok.map((t) => `<div class="cap"><div class="grow"><div class="l1"><span class="h">${esc(t.name)}</span><span class="dim">${esc(t.kind)}</span></div><div class="l2"><span class="p">${esc(t.path)}</span>${t.matches > 1 ? ` · ${t.matches} files` : ''}${t.purpose ? ' · ' + esc(t.purpose) : ''}${t.secrets.length ? ' · secrets ' + esc(t.secrets.join(', ')) : ''}</div></div></div>`).join('') : '<p class="hint">None yet.</p>';
  state.toolsScan = s;
  return html;
}
function wireCaps(b, body) {
  body.querySelectorAll('[data-auto]').forEach((btn) => {
    btn.onclick = () => operatorAct(`POST`, `/api/bots/${b.name}/automations/${encodeURIComponent(btn.dataset.auto)}/${btn.dataset.act}`, null, `${btn.dataset.act} ${btn.dataset.auto}`, () => renderDrawer('caps'));
  });
  body.querySelectorAll('[data-reg]').forEach((btn) => {
    const p = state.toolsScan.proposal.tools[Number(btn.dataset.reg)];
    btn.onclick = () => operatorAct('POST', `/api/bots/${b.name}/tools/register`, p, `registered ${p.name}`, () => renderDrawer('caps'));
  });
  body.querySelectorAll('[data-retire]').forEach((btn) => {
    btn.onclick = () => {
      if (!confirm(`Retire ${btn.dataset.retire}? Its files move to the runtime's retired folder and its entry leaves bot.yaml.`)) return;
      operatorAct('POST', `/api/bots/${b.name}/tools/retire`, { target: btn.dataset.retire }, `retired ${btn.dataset.retire}`, () => renderDrawer('caps'));
    };
  });
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
    await operatorApi('POST', `/api/bots/${bot}/pair`, { senderId });
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
  term.open(el('termScreen'));
  fit.fit();
  term.onData((d) => sendInput(d));

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

  // Paste into the terminal: files and clipboard images upload (Alt+V reads the
  // host's clipboard, never this browser's); multi-line text goes in as ONE
  // bracketed paste so each newline does not submit a separate prompt.
  const holder = el('term');
  holder.addEventListener('paste', (e) => {
    const files = clipFiles(e.clipboardData);
    if (files.length) { e.preventDefault(); e.stopPropagation(); termAttach(files); return; }
    const text = e.clipboardData?.getData('text') || '';
    if (text.includes('\n')) { e.preventDefault(); sendInput(bracketed(text)); }
  }, true);

  state.term = term; state.fit = fit;
  // Re-fit whenever the screen's box changes (a window resize, the tab shown, a
  // notice or the key rows wrapping above or below it), not only on resize.
  let fitFrame = 0;
  new ResizeObserver(() => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(() => doFit()); }).observe(el('termScreen'));
}

// The files on a paste or a drop (a copied screenshot arrives as an image/png item).
function clipFiles(dt) {
  const out = [];
  for (const it of dt?.items || []) if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
  if (!out.length) for (const f of dt?.files || []) out.push(f);
  return out;
}

function bracketed(text) { return '\x1b[200~' + text.replace(/\r\n?/g, '\n') + '\x1b[201~'; }

function sendInput(d) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ t: 'i', d }));
  else toast('not attached: start the bot first', true);
}

// The pty hears the size when it changed, or on `force` (a new socket).
function doFit(force) {
  if (!state.fit) return;
  try {
    state.fit.fit();
    const size = `${state.term.cols}x${state.term.rows}`;
    if (!force && size === state.sentSize) return;
    if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify({ t: 'r', cols: state.term.cols, rows: state.term.rows })); state.sentSize = size; }
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
  ws.onopen = () => { state.reconnectDelay = 1000; setTimeout(() => doFit(true), 60); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'o') { state.term.write(msg.d); scanForAuthUrl(msg.d); }
    else if (msg.t === 'hello') { el('exitbar').classList.remove('show'); }
    else if (msg.t === 'stopped') {
      // no pty-host: the session is down, or its attach host did not come up
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
el('fileInput').onchange = () => { termAttach([...(el('fileInput').files || [])]); el('fileInput').value = ''; };

/* drop files anywhere on the main area: onto the message in the chat view, into the session in the terminal */
const mainEl = el('main');
mainEl.addEventListener('dragover', (e) => { e.preventDefault(); mainEl.classList.add('drop'); });
mainEl.addEventListener('dragleave', () => mainEl.classList.remove('drop'));
mainEl.addEventListener('drop', (e) => {
  e.preventDefault();
  mainEl.classList.remove('drop');
  const files = clipFiles(e.dataTransfer);
  if (!files.length || !state.selected) return;
  if (state.view === 'term') termAttach(files); else addPending(files);
});

// One file to the bot's uploads folder (POST /uploads, the operator's approval
// token like every widening write) -> {id, path, type, bytes, image}.
async function uploadFile(name, file) {
  const headers = { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'pasted.png') };
  const tok = approveToken();
  if (tok) headers['X-Approve-Token'] = tok;
  const res = await fetch(`/api/bots/${encodeURIComponent(name)}/uploads`, { method: 'POST', headers, body: file });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.need === 'approve-token') {
    await askToken(tok ? 'That token was not accepted: the cockpit prints a new one each time it starts.' : 'Attaching a file needs the approval token.');
    return uploadFile(name, file);
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// Terminal: upload, then paste each path into the prompt (no Enter). Claude
// Code turns a pasted image path into an image attachment; any other file
// stays a path it reads.
async function termAttach(files) {
  const name = state.selected;
  if (!name || !files.length) return;
  for (const [i, f] of files.entries()) {
    const v = window.CockpitCards.attachView(f, i);
    if (v.why) { toast(v.why, true); return; }
  }
  try {
    toast(files.length > 1 ? `uploading ${files.length} files` : 'uploading');
    for (const f of files) {
      const up = await uploadFile(name, f);
      if (name !== state.selected) return;
      sendInput(bracketed(up.path) + ' ');
    }
    toast('attached. Add your message and press Enter');
  } catch (e) { toast('upload failed: ' + e.message, true); }
}

/* ---- chat view (turns pushed by the server over the terminal socket) ---- */
function setView(view) {
  state.view = view;
  el('vtChat').classList.toggle('active', view === 'chat');
  el('vtTerm').classList.toggle('active', view === 'term');
  el('chatwrap').classList.toggle('show', view === 'chat');
  el('termwrap').classList.toggle('show', view === 'term');
  if (view === 'term') setTimeout(doFit, 30);
  if (view === 'chat' && state.follow) el('msgs').scrollTop = el('msgs').scrollHeight;
}
el('vtChat').onclick = () => setView('chat');
el('vtTerm').onclick = () => setView('term');

function resetChat() {
  state.sent = []; state.chatFile = null; state.status = null;
  for (const p of state.attached) if (p.url) URL.revokeObjectURL(p.url);
  state.attached = [];
  renderPending();
  el('msgs').innerHTML = '<div class="cempty">Loading the conversation</div>';
  toLatest();
  renderStats();
}

// The chat follows the newest turn until the operator scrolls up; from then
// new turns are counted on the jump button instead. The button, or scrolling
// back to the bottom by hand, resumes following. Only a real scroll changes
// the mode: content growing under a following view does not.
function toLatest() {
  const box = el('msgs');
  state.follow = true; state.unseen = 0;
  box.scrollTop = box.scrollHeight;
  renderJump();
}
function renderJump() {
  const b = el('jumpLatest');
  b.classList.toggle('show', !state.follow);
  el('jumpCount').textContent = state.unseen ? (state.unseen > 99 ? '99+' : String(state.unseen)) : '';
  b.setAttribute('aria-label', state.unseen ? `Jump to latest, ${state.unseen} new` : 'Jump to latest');
}
el('msgs').addEventListener('scroll', () => {
  const box = el('msgs');
  const at = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (at === state.follow) return;
  state.follow = at;
  if (at) state.unseen = 0;
  renderJump();
});
// An image that loads after its turn was placed grows the list under a following view.
el('msgs').addEventListener('load', () => { if (state.follow) el('msgs').scrollTop = el('msgs').scrollHeight; }, true);
el('jumpLatest').onclick = toLatest;

function fmtWhen(ts) {
  const d = new Date(ts);
  if (!ts || isNaN(d)) return '';
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}

function bubble(turn) {
  const d = document.createElement('div');
  const tg = turn.meta?.channel === 'telegram';
  d.className = 'bubble ' + (turn.role === 'tg_out' ? 'tgout' : turn.role === 'user' ? 'user' + (tg ? ' tg' : '') : 'assistant');
  // A reply the bot sent on Telegram: what the person on the phone read.
  if (turn.role === 'tg_out') {
    const m = document.createElement('div');
    m.className = 'meta';
    m.append(icon('i-tg'), document.createTextNode(['Sent on Telegram', fmtWhen(turn.ts)].filter(Boolean).join(' · ')));
    d.appendChild(m);
  }
  // Channel messages (Telegram, ...): "user · 16:34" under the channel's icon,
  // then one labelled line per attachment ("Voice note 0:12", "File report.pdf").
  // The server sends labels, never a path or a file id.
  if (turn.meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    if (tg) {
      const who = document.createElement('b');
      who.textContent = String(turn.meta.user || 'Telegram');
      m.append(icon('i-tg'), who, document.createTextNode([turn.meta.user ? 'on Telegram' : '', fmtWhen(turn.meta.ts)].filter(Boolean).map((s) => ' · ' + s).join('')));
    } else m.textContent = [turn.meta.source, turn.meta.user, fmtWhen(turn.meta.ts)].filter(Boolean).join(' · ');
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
  // A message sent with attachments: its "[attached: ...]" lines become chips.
  const att = turn.role === 'user' && !turn.meta ? window.CockpitCards.splitAttached(turn.text) : null;
  const text = att && att.files.length ? att.body : turn.text;
  if (text) {
    const body = document.createElement('div');
    body.className = 'md';
    // Transcript text is untrusted. md.js escapes every input character and emits
    // only its own fixed tag set, so its output is the one thing that may go
    // through innerHTML here; without it, plain text.
    if (window.CockpitMarkdown) body.innerHTML = window.CockpitMarkdown.renderMarkdown(text);
    else body.textContent = text;
    d.appendChild(body);
  }
  if (att && att.files.length) {
    const row = document.createElement('div');
    row.className = 'achips';
    for (const f of att.files) {
      const c = window.CockpitInbox.chip(document, f);
      if (c.thumb) loadThumb(c.thumb, state.selected, f.id);
      row.appendChild(c.node);
    }
    d.appendChild(row);
  }
  if (turn.tools?.length) {
    const t = document.createElement('span');
    t.className = 'tools';
    t.textContent = 'used: ' + window.CockpitCards.toolsLine(turn.tools);
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
  if (!msg.hasSession) { if (msg.initial) box.innerHTML = '<div class="cempty">No conversation yet. Say hello below.</div>'; renderChatApprovals(); return; }
  if (msg.initial) { box.innerHTML = ''; state.follow = true; }
  const ph = box.querySelector('.cempty');
  if (ph && msg.turns.length) ph.remove();
  let added = 0;
  for (const turn of msg.turns) {
    // A message sent from here reaching the transcript: its bubble moves to
    // where the session took it instead of rendering twice.
    const sp = turn.role === 'user' ? window.CockpitCards.splitAttached(turn.text) : null;
    const mine = sp && state.sent.find((s) => !s.seen && s.text === sp.body.trim() && s.ids.join('\n') === sp.files.map((f) => f.id).join('\n'));
    if (mine) { mine.seen = true; box.appendChild(mine.node); continue; }
    added++;
    if (turn.role === 'transcript') { addTranscript(box, turn); continue; }
    box.appendChild(turn.role === 'task' ? taskCard(turn) : bubble(turn));
  }
  renderChatApprovals();
  if (state.follow) toLatest();
  else { state.unseen += added; renderJump(); }
}

// Chat send goes through the bot's inbox (POST /send -> `botcorp send`): it is
// typed into the session as soon as it is alive, and its status line follows
// it (queued, held, delivered, expired, not delivered).
// With attachments, each file is uploaded first, then the message names them.
async function sendChat() {
  const ta = el('chatInput');
  const text = ta.value.replace(/\s+$/, '');
  const name = state.selected;
  const pending = state.attached;
  if ((!text && !pending.length) || !name) return;
  const box = el('msgs');
  box.querySelector('.cempty')?.remove();
  const s = { text: text.trim(), ids: [], id: null, st: 'sending', seen: false, ...window.CockpitInbox.sentBubble(document, text, pending.map((p) => p.view)) };
  pending.forEach((p, i) => { if (s.thumbs[i]) showThumb(s.thumbs[i], p.url); });
  state.sent.push(s);
  box.appendChild(s.node);
  toLatest();
  ta.value = '';
  growInput();
  state.attached = [];
  renderPending();
  try {
    if (pending.length) s.status.textContent = 'uploading';
    for (const p of pending) s.ids.push((await uploadFile(name, p.file)).id);
    const it = await api('POST', `/api/bots/${encodeURIComponent(name)}/send`, { text, attachments: s.ids });
    s.id = it.id;
    s.st = window.CockpitInbox.setStatus(s.status, it);
    pollInbox();
  } catch (e) { s.st = window.CockpitInbox.setStatus(s.status, { status: 'failed', detail: e.message }); }
}

// The composer's attachments before send (state.attached): {file, view, url}
// each, a chip above the input.
function addPending(files) {
  for (const f of files) {
    const view = window.CockpitCards.attachView(f, state.attached.length);
    if (view.why) { toast(view.why, true); continue; }
    state.attached.push({ file: f, view, url: view.image ? URL.createObjectURL(f) : '' });
  }
  renderPending();
}
function renderPending() {
  const row = el('pending');
  row.replaceChildren();
  state.attached.forEach((p, i) => {
    const c = window.CockpitInbox.chip(document, p.view, () => {
      if (p.url) URL.revokeObjectURL(p.url);
      state.attached.splice(i, 1);
      renderPending();
      el('chatInput').focus();
    });
    if (c.thumb) showThumb(c.thumb, p.url);
    row.appendChild(c.node);
  });
  row.classList.toggle('show', state.attached.length > 0);
}
function showThumb(img, url) {
  if (!url) return;
  img.onload = () => img.parentElement?.classList.add('has');
  img.src = url;
}

// A sent image's thumbnail, fetched with the approval token (an <img> cannot
// send it) and shown as a blob: URL. Without a token the chip keeps its name.
const thumbs = new Map();   // "<bot>/<id>" -> Promise<blob url>
function loadThumb(img, bot, id) {
  const key = `${bot}/${id}`;
  const tok = approveToken();
  if (!thumbs.has(key)) {
    if (!tok) return;
    thumbs.set(key, fetch(`/api/bots/${encodeURIComponent(bot)}/uploads/${encodeURIComponent(id)}`, { headers: { 'X-Approve-Token': tok } })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : '')).catch(() => ''));
  }
  thumbs.get(key).then((u) => { if (u) showThumb(img, u); else thumbs.delete(key); });
}

el('clipBtn').onclick = () => el('chatFiles').click();
el('chatFiles').onchange = () => { addPending([...(el('chatFiles').files || [])]); el('chatFiles').value = ''; };
el('chatInput').addEventListener('paste', (e) => {
  const files = clipFiles(e.clipboardData);
  if (files.length) { e.preventDefault(); addPending(files); }
});

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
// 1 line up to 8, then it scrolls: no scrollbar before the text needs one.
function growInput() {
  const ta = el('chatInput');
  const cs = getComputedStyle(ta);
  const line = parseFloat(cs.lineHeight) || 22;
  const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const max = Math.round(line * 8 + chrome);
  ta.style.height = 'auto';
  const want = ta.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  ta.style.height = Math.min(max, Math.ceil(want)) + 'px';
  ta.style.overflowY = want > max ? 'auto' : 'hidden';
}
el('chatInput').addEventListener('input', growInput);

/* ---- status chips: pushed by the server (cockpit/chatstatus.mjs) over the same
   socket when they change; ages and reset countdowns are computed here. A value
   the server could not read arrives as {na: why} and shows as n/a. ---- */
const { fmtTok } = window.CockpitCards;
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
  // Context as a bar toward the compaction ceiling: the one number that says
  // how close the session is to losing detail.
  const c = s.context, cb = window.CockpitCards.contextBar(c);
  out.push(cb.na ? statHtml('Context', 'n/a', '', cb.na)
    : `<button class="stat ctx" title="${esc(tip(`${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens before compaction`, `window: ${c.source}`, read))}"><span class="k">Context</span><span class="bar"><span class="fill${cb.level ? ' ' + cb.level : ''}" style="width:${cb.pct}%"></span></span><span class="v${level(cb.pct)}">${cb.pct}%</span><span class="r">${esc(cb.label)}</span></button>`);
  for (const [k, name, w] of [['5 h', '5-hour', s.fiveHour], ['7 d', '7-day', s.sevenDay]]) {
    out.push(w.na ? statHtml(k, 'n/a', '', w.na)
      : statHtml(k, `${Math.round(w.pct)}%`, w.resetsAt ? `↻ ${fmtIn(w.resetsAt - now)}` : '', tip(`${w.pct}% of the ${name} limit used`, w.resetsAt ? `resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : 'reset time not reported', read), level(w.pct)));
  }
  const acct = window.CockpitCards.accountName(s.account, state.accounts, current()?.account, s.accountReason);
  out.push(statHtml('Account', acct.name, '', acct.title));
  const m = s.model, e = s.effort;
  out.push(statHtml('Model', m.na ? 'n/a' : m.name, e.na ? '' : e.level,
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
  // a pending tag at or below the checkout is stale bookkeeping, not an action
  const older = r.status === 'pending' && r.older;
  const statusCls = older ? '' : ['applied', 'failed', 'pending'].includes(r.status) ? r.status : '';
  const actions = r.status === 'pending' && !older ? `<div class="actions"><button class="btn primary" data-apply="${esc(r.tag)}">Apply</button><button class="btn" data-skip="${esc(r.tag)}">Skip</button></div>` : '';
  return `<div class="rel${older ? ' older' : ''}">
    <div class="relhead"><span class="tag">${esc(r.tag)}</span><span class="date">${esc(r.date || '')}</span><span class="status ${statusCls}">${esc(older ? 'older than installed' : r.status)}</span></div>
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
    // newest first (the server sorts); everything below the installed version folds away
    const shown = releases.filter((r) => !r.older || r.current), folded = releases.filter((r) => r.older && !r.current);
    box.innerHTML = releases.length
      ? shown.map(relCard).join('') + (folded.length ? `<button class="btn quiet relmore" id="relMore">Show ${folded.length} older</button><div id="relOlder" hidden>${folded.map(relCard).join('')}</div>` : '')
      : '<p class="hint">No releases recorded yet.</p>';
    const more = el('relMore');
    if (more) more.onclick = () => { el('relOlder').hidden = false; more.remove(); };
    box.querySelectorAll('[data-apply]').forEach((btn) => { btn.onclick = () => updateAction(btn.dataset.apply, 'apply'); });
    box.querySelectorAll('[data-skip]').forEach((btn) => { btn.onclick = () => updateAction(btn.dataset.skip, 'skip'); });
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
  try { box.insertAdjacentHTML('afterbegin', `<p class="hint">${esc(ccLine(await api('GET', '/api/cc')))}</p>`); } catch { /* the releases stand alone */ }
}
// "Claude Code 2.1.283 pinned · candidate 2.1.284 failed" (botcorp cc status for the rest)
function ccLine(c) {
  if (!c.pinned) return 'Claude Code: not pinned yet';
  const k = c.candidate;
  const failed = k && (k.checks || []).find((x) => x.result === 'FAIL');
  const cand = !k ? '' : k.status === 'rejected' && failed ? ` · candidate ${k.version} rejected: check ${failed.n}` : ` · candidate ${k.version} ${k.status}`;
  return `Claude Code ${c.pinned.version} pinned${cand}`;
}
async function updateAction(tag, action) {
  try {
    const r = await operatorApi('POST', `/api/updates/${encodeURIComponent(tag)}/${action}`);
    toast(r.ok ? `${action} ok` : `${action} failed (${r.code}): ${r.err || r.out}`, !r.ok);
  } catch (e) { toast(e.message, true); }
  loadUpdates();
}
function openUpdates() { el('updatesBg').classList.add('show'); loadUpdates(); }
el('updatesLink').onclick = (e) => { e.preventDefault(); openUpdates(); };
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

/* ---- operator decisions: approve / reject, resume, register, run. On loopback the
   server wants its per-boot approval token for a widening change; it is asked for
   once and kept for this tab (sessionStorage, or memory where storage is blocked). ---- */
let tokenMem = '';
function approveToken() { try { return sessionStorage.getItem('cockpit.approveToken') || tokenMem; } catch { return tokenMem; } }
function keepApproveToken(t) { tokenMem = t; try { sessionStorage.setItem('cockpit.approveToken', t); } catch {} }

let tokenWait = null;
function askToken(msg) {
  if (tokenWait) tokenWait.reject(new Error('superseded'));
  el('tokenErr').textContent = msg || '';
  el('tokenInput').value = '';
  el('tokenBg').classList.add('show');
  setTimeout(() => el('tokenInput').focus(), 30);
  return new Promise((resolve, reject) => { tokenWait = { resolve, reject }; });
}
function closeToken(ok) {
  el('tokenBg').classList.remove('show');
  const w = tokenWait;
  tokenWait = null;
  if (w) { if (ok) w.resolve(); else w.reject(new Error('no approval token given')); }
}
el('tokenSave').onclick = () => {
  const t = el('tokenInput').value.trim();
  if (!t) { el('tokenErr').textContent = 'paste the token first'; return; }
  keepApproveToken(t);
  closeToken(true);
};
el('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('tokenSave').click(); });
el('tokenCancel').onclick = () => closeToken(false);
el('tokenBg').onclick = (e) => { if (e.target === el('tokenBg')) closeToken(false); };

async function operatorApi(method, url, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const tok = approveToken();
  if (tok) headers['X-Approve-Token'] = tok;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.need === 'approve-token') {
    await askToken(tok ? 'That token was not accepted: the cockpit prints a new one each time it starts.' : '');
    return operatorApi(method, url, body);
  }
  if (!res.ok) throw new Error(data.error || String(data.err || data.out || '').trim() || `${res.status} ${res.statusText}`);
  return data;
}
async function operatorAct(method, url, body, okMsg, after) {
  try { await operatorApi(method, url, body); toast(okMsg); } catch (e) { toast(e.message, true); }
  refreshAttention();
  if (after) after();
}

function openSheet(id) { el(id).classList.add('show'); }
function closeSheet(id) { el(id).classList.remove('show'); }
for (const id of ['attnBg', 'approvalsBg', 'usageBg', 'accountsBg', 'settingsBg']) el(id).onclick = (e) => { if (e.target === el(id)) closeSheet(id); };

// Select a bot and open one of its drawers (from an attention item).
function openBot(name, drawer, capsTab) {
  select(name);
  if (capsTab) state.capsTab = capsTab;
  if (!drawer) return;
  state.drawer = drawer;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.drawer === drawer));
  renderDrawer(drawer);
}

/* ---- the attention bar + sheet (GET /api/attention, polled with the bot list) ---- */
const KIND_LABEL = {
  approval: 'approval', pairing: 'pairing request', vault_locked: 'vault locked', blocked: 'waiting on you', down: 'down',
  automation_failing: 'automation failing', registry: 'tools registry', usage_blocked: 'usage limit', release: 'release', cc_rejected: 'Claude Code canary',
  account: 'account switch',
};
let attnSnap = '';
async function refreshAttention() {
  let a;
  try { a = await api('GET', '/api/attention'); } catch { return; }
  const snap = JSON.stringify(a.items);
  if (snap === attnSnap) return;
  attnSnap = snap;
  state.attn = a;
  renderAttention();
}
function renderAttention() {
  const items = state.attn ? state.attn.items : [];
  el('attnbar').classList.toggle('show', items.length > 0);
  el('attnbar').classList.toggle('bad', items.some((i) => i.severity === 'bad'));
  el('attnCount').textContent = items.length === 1 ? '1 thing needs you' : `${items.length} things need you`;
  el('attnTop').textContent = items.length ? items[0].text : '';
  if (el('attnBg').classList.contains('show')) renderAttnList();
  if (el('approvalsBg').classList.contains('show')) loadApprovals();
  if (el('settingsBg').classList.contains('show') && setBot) loadApprovals(el('setApprovals'), { bot: setBot });
  loadPending();
}
function attnActs(a) {
  const b = (label, k, quiet) => `<button class="btn${quiet ? ' quiet' : ''}" data-k="${k}">${label}</button>`;
  switch (a && a.type) {
    case 'approve': return b('Approve', 'approve') + b('Decline', 'reject', true);
    case 'pair': return b('Pair', 'pair') + b('Deny', 'deny', true);
    case 'unlock': return b('Open vault', 'vault');
    case 'open': return b('Open', 'open');
    case 'run': return b('Run now', 'run') + b('Details', 'caps', true);
    case 'tools': return b('Review tools', 'tools');
    case 'usage': return b('Usage', 'usage');
    case 'release': return b('Releases', 'release');
    default: return '';
  }
}
function attnDo(a, k) {
  const bot = encodeURIComponent(a.bot || '');
  if (k === 'approve' || k === 'reject') return operatorAct('POST', `/api/bots/${bot}/approvals/${encodeURIComponent(a.id)}/${k}`, null, `${k === 'approve' ? 'approved' : 'rejected'} ${a.id}`);
  if (k === 'pair' || k === 'deny') return operatorAct('POST', `/api/bots/${bot}/pair${k === 'deny' ? '/deny' : ''}`, { senderId: a.senderId }, `${k === 'pair' ? 'paired' : 'denied'} ${a.senderId}`);
  if (k === 'run') return operatorAct('POST', `/api/bots/${bot}/automations/${encodeURIComponent(a.automation)}/run`, null, `${a.automation} queued`);
  closeSheet('attnBg');
  if (k === 'vault') return openBot(a.bot, 'vault');
  if (k === 'open') return openBot(a.bot);
  if (k === 'caps') return openBot(a.bot, 'caps', 'autos');
  if (k === 'tools') return openBot(a.bot, 'caps', 'tools');
  if (k === 'usage') return openUsage();
  if (k === 'release') return openUpdates();
}
function renderAttnList() {
  const items = state.attn ? state.attn.items : [];
  const box = el('attnList');
  box.innerHTML = items.length ? items.map((it, i) => `<div class="aitem ${it.severity === 'bad' ? 'bad' : 'warn'}" data-i="${i}"><div class="grow"><span class="who">${esc(KIND_LABEL[it.kind] || it.kind)}</span>${esc(it.text)}</div><div class="acts">${attnActs(it.action)}</div></div>`).join('')
    : '<p class="hint">Nothing needs you right now.</p>';
  box.querySelectorAll('[data-k]').forEach((btn) => {
    btn.onclick = () => attnDo(items[Number(btn.closest('.aitem').dataset.i)].action, btn.dataset.k);
  });
}
el('attnbar').onclick = () => { renderAttnList(); openSheet('attnBg'); };
el('attnClose').onclick = () => closeSheet('attnBg');

/* ---- approvals: one card, in the bot's chat and in the sheet. What is asked,
   what it widens, the exact change, who asked; Approve or Decline. ---- */
function aprBody(p, withBot) {
  const v = window.CockpitCards.approvalView(p);
  // a bulk entry (`tools: + 3 (a, b, c)`) shows its count, the names on demand
  const bulk = /^(.*?): \+ (\d+) \((.*)\)$/.exec(v.change);
  const diff = bulk
    ? `<div class="diff">${esc(bulk[1])}: + ${esc(bulk[2])}</div><details><summary>show all ${esc(bulk[2])}</summary>${esc(bulk[3])}</details>`
    : `<div class="diff">${esc(v.change)}</div>`;
  const d = `data-bot="${esc(p.bot)}" data-id="${esc(p.id)}"`;
  const meta = [withBot && p.requested_by !== `bot:${p.bot}` ? `For ${p.bot}` : '', v.asker, fmtWhen(p.at)].filter(Boolean).join(' · ');
  return `<div class="apr-h"><svg class="ic"><use href="#i-apr"/></svg><span class="apr-t">${esc(v.title)}</span></div>`
    + `<p class="apr-w"><b>Widens: ${esc(v.widensLabel)}.</b> ${esc(v.widensText)}</p>`
    + `<div class="apr-x">The exact change${diff}</div>`
    + `<div class="apr-m">${esc(meta)} · <span class="num" title="approval id">${esc(p.id)}</span></div>`
    + `<div class="acts"><button class="btn primary" data-dec="approve" ${d}>Approve</button><button class="btn quiet" data-dec="reject" ${d}>Decline</button></div>`;
}
function wireDecisions(box) {
  box.querySelectorAll('[data-dec]').forEach((btn) => {
    const { bot, id, dec } = btn.dataset;
    btn.onclick = () => {
      btn.disabled = true;
      operatorAct('POST', `/api/bots/${encodeURIComponent(bot)}/approvals/${encodeURIComponent(id)}/${dec}`, null, `${dec === 'approve' ? 'Approved' : 'Declined'}. ${bot} has been told.`, () => {
        loadPending();
        if (el('approvalsBg').classList.contains('show')) loadApprovals();
        if (el('settingsBg').classList.contains('show')) loadSettings();
      });
    };
  });
}
// The selected bot's pending requests sit at the end of its chat, below the
// message that led to them; the sidebar counts every bot's.
async function loadPending() {
  try { state.pending = (await api('GET', '/api/approvals')).pending; } catch { return; }
  const n = state.pending.length;
  el('aprCount').textContent = n ? String(n) : '';
  el('approvalsLink').classList.toggle('due', n > 0);
  renderChatApprovals();
}
function renderChatApprovals() {
  const box = el('msgs');
  box.querySelectorAll('.bubble.apr-chat').forEach((n) => n.remove());
  const mine = (state.pending || []).filter((p) => p.bot === state.selected);
  if (!mine.length || box.querySelector('.cempty.err')) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  for (const p of mine) {
    const d = document.createElement('div');
    d.className = 'bubble apr-chat';
    d.innerHTML = aprBody(p, false);   // every value escaped in aprBody
    wireDecisions(d);
    box.appendChild(d);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function aprCard(p) { return `<div class="apr">${aprBody(p, true)}</div>`; }
function decRow(r) {
  return `<div class="dec"><span class="out ${r.decision === 'approved' ? 'ok' : 'bad'}">${esc(r.decision)}</span><span>by <b>${esc(r.by || 'unknown')}</b></span><span class="dim">${esc(r.bot)} · ${esc(fmtWhen(r.at) || '')}</span>`
    + `<span class="d">${esc(r.path)}: ${esc(r.value)}${r.reason ? ` (${esc(r.reason)})` : ''}</span></div>`;
}
// state/admin-audit.jsonl: an operator-only verb an admin bot ran, or was refused
function adminRow(r) {
  return `<div class="dec"><span class="out ${r.refused ? 'bad' : 'ok'}">${r.refused ? 'refused' : 'done'}</span><span>by <b>${esc(r.by)}</b></span><span class="dim">${esc(fmtWhen(r.at) || '')}</span>`
    + `<span class="d">${esc(r.verb)}${r.target ? ` ${esc(r.target)}` : ''}${r.refused ? ` (${esc(r.refused)})` : ''}</span></div>`;
}
// The Approvals sheet, or (bot given) one bot's pending entries embedded in
// the Settings sheet: nothing at all there when none wait.
async function loadApprovals(box = el('approvalsList'), { bot = null } = {}) {
  if (!bot && !box.children.length) box.innerHTML = '<p class="loading">Loading approvals</p>';
  try {
    const { pending, recent, admin = [] } = await api('GET', '/api/approvals');
    if (bot) {
      const mine = pending.filter((p) => p.bot === bot);
      box.innerHTML = mine.length ? '<p class="sub">Waiting for your decision</p>' + mine.map(aprCard).join('') : '';
    } else {
      box.innerHTML = (pending.length ? pending.map(aprCard).join('') : '<p class="hint">Nothing waiting. A bot that asks for a wider permission shows up here.</p>')
        + '<p class="sub">Decided</p>' + (recent.length ? recent.map(decRow).join('') : '<p class="hint">No decisions recorded yet.</p>')
        + (admin.length ? '<p class="sub">Done by an admin bot</p>' + admin.map(adminRow).join('') : '');
    }
    wireDecisions(box);
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}
function openApprovals() { el('approvalsList').innerHTML = ''; openSheet('approvalsBg'); loadApprovals(); }
el('approvalsLink').onclick = (e) => { e.preventDefault(); openApprovals(); };
el('approvalsClose').onclick = () => closeSheet('approvalsBg');

/* ---- usage sheet: every bot's 5 h / 7 d reading under the account it runs on ---- */
function meter(k, w) {
  if (!w || w.na) return `<div class="meter" title="${esc((w && w.na) || 'no reading')}"><span class="mk">${k}</span><span class="track"></span><span class="mv na">n/a</span></div>`;
  const p = Math.max(0, Math.min(100, Math.round(w.pct)));
  const resets = w.resetsAt ? `resets in ${fmtIn(w.resetsAt - Date.now() / 1000)}` : '';
  return `<div class="meter" title="${esc(`${p}% used${resets ? ', ' + resets : ''}`)}"><span class="mk">${k}</span><span class="track"><span class="fill${level(p)}" style="width:${p}%"></span></span><span class="mv num">${p}%</span>${resets ? `<span class="mr">${esc(resets)}</span>` : ''}</div>`;
}
// Switch account (bot.yaml account:) is done on the Accounts sheet; here a
// pending switch is a --warn line and the quiet button opens that sheet.
let usageData = null;
function acctLine(r) {
  const to = r.account_wanted || 'its own token';
  const sw = r.account_pending ? `<span class="sw">${r.running ? `switching to ${esc(to)} at next idle` : `switches to ${esc(to)} at next start`}</span>` : '';
  const chain = window.CockpitCards.chainLine(r);
  return `<div class="ua">${sw}${chain ? `<span class="chn">${esc(chain)}</span>` : ''}<button class="btn quiet" data-accounts="${esc(r.bot)}">Switch account</button></div>`;
}
function renderUsage() {
  const { bots, accounts } = usageData;
  const byBot = Object.fromEntries(bots.map((r) => [r.bot, r]));
  const row = (r) => `<div class="urow"><span class="ub">${esc(r.bot)}${r.running ? '' : ' <span class="dim">stopped</span>'}</span>${meter('5 h', r.fiveHour)}${meter('7 d', r.sevenDay)}`
    + acctLine(r) + '</div>';
  el('usageList').innerHTML = accounts.length ? accounts.map((g) => `<div class="acct"><div class="acct-h"><span class="h">${esc(g.label)}</span>${g.masked ? `<span class="m">${esc(g.masked)}</span>` : ''}<span class="dim">${g.registered ? 'registered account' : 'not in botcorp accounts'}</span></div>`
    + (g.bots.length ? g.bots.map((n) => row(byBot[n])).join('') : '<p class="hint">No bot runs on it.</p>') + '</div>').join('')
    : '<p class="hint">No bots yet.</p>';
}
async function loadUsage() {
  const box = el('usageList');
  if (!usageData) box.innerHTML = '<p class="loading">Loading usage</p>';
  try {
    usageData = await api('GET', '/api/usage');
    renderUsage();
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}
function openUsage() { usageData = null; openSheet('usageBg'); loadUsage(); }
el('usageLink').onclick = (e) => { e.preventDefault(); openUsage(); };
el('usageClose').onclick = () => closeSheet('usageBg');
el('usageList').onclick = (e) => {
  const go = e.target.closest('[data-accounts]');
  if (go) { closeSheet('usageBg'); return openAccounts(go.dataset.accounts); }
  // Tooltips do not exist on a phone: a tap on a meter shows its reading as a toast.
  const m = e.target.closest('.meter');
  if (m && m.title) toast(m.title);
};

/* ---- accounts sheet: the registered Claude accounts (state, meters, the bots on each),
   add one (the token goes to the server body and on to `accounts add` on stdin), remove
   one, and per bot the account it runs on. Every confirmation is an inline row. ---- */
let acctData = null;
let acctConfirm = null;   // the one open inline confirmation: {kind: 'remove', id} | {kind: 'use', bot, id, name}
let acctFocus = null;     // a bot to open the sheet on (from the Usage sheet's Switch account)
const ACCT_STATE = { ok: ['ok', 'ok'], limited: ['limited', 'warn'], failed: ['failed', 'bad'], 'no-token': ['no token', 'bad'] };
function acctStateText(a) {
  if (a.state === 'limited' && a.blocked_until) return `limited until ${new Date(a.blocked_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${a.window ? ` (${a.window})` : ''}`;
  return (ACCT_STATE[a.state] || [a.state])[0];
}
function acctRow(a) {
  const cls = (ACCT_STATE[a.state] || ['', ''])[1];
  const on = a.bots.length ? `on it: ${a.bots.map((b) => `${b.bot}${b.running ? '' : ' (stopped)'}`).join(', ')}` : 'no bot on it';
  const why = a.failed && a.failed.why ? ` · ${a.failed.why}` : a.check ? ` · token check ${a.check.ok ? 'passed' : 'failed'}${fmtWhen(a.check.at) ? ' ' + fmtWhen(a.check.at) : ''}` : '';
  const inUse = a.wanted_by.length ? `<span class="dim">set for ${esc(a.wanted_by.join(', '))}; move ${a.wanted_by.length > 1 ? 'them' : 'it'} before removing</span>` : `<button class="btn quiet" data-remove="${esc(a.id)}">Remove</button>`;
  const confirm = acctConfirm && acctConfirm.kind === 'remove' && acctConfirm.id === a.id
    ? `<div class="confirm"><span class="grow">Remove <b>${esc(a.label)}</b>? Its token leaves the vault; its chat history folder stays.</span><button class="btn" data-remove-yes="${esc(a.id)}">Remove</button><button class="btn quiet" data-confirm-no>Keep</button></div>`
    : `<div class="acts">${inUse}</div>`;
  return `<div class="arow"><div class="l1"><span class="h">${esc(a.label)}</span><span class="p">${esc(a.id)}</span>${a.masked ? `<span class="p">${esc(a.masked)}</span>` : ''}${a.plan ? `<span class="dim">${esc(a.plan)}</span>` : ''}<span class="out ${cls}">${esc(acctStateText(a))}</span></div>`
    + `<div class="meters">${meter('5 h', a.fiveHour)}${meter('7 d', a.sevenDay)}</div>`
    + `<div class="l2">${esc(on)}${esc(why)}</div>${confirm}</div>`;
}
function botRow(b, accounts) {
  // an open confirmation keeps the choice it asks about in the select
  const cur = acctConfirm && acctConfirm.kind === 'use' && acctConfirm.bot === b.bot ? acctConfirm.id : (b.account_wanted || 'none');
  const opts = [{ id: 'none', name: 'Its own token' }, ...accounts.map((a) => ({ id: a.id, name: a.label }))];
  const sel = `<select data-bot="${esc(b.bot)}" aria-label="account for ${esc(b.bot)}">${opts.map((o) => `<option value="${esc(o.id)}"${o.id === cur ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
  const sw = b.account_pending ? `<span class="sw">${b.running ? `switching to ${esc(b.account_wanted || 'its own token')} at next idle` : 'switches at next start'}</span>` : '';
  const confirm = acctConfirm && acctConfirm.kind === 'use' && acctConfirm.bot === b.bot
    ? `<div class="confirm"><span class="grow">Switch <b>${esc(b.bot)}</b> to <b>${acctConfirm.id === 'none' ? 'its own token' : esc(acctConfirm.name)}</b>? Applies between turns; the conversation is kept.${(b.backups || []).includes(acctConfirm.id) ? ' It leaves the backups.' : ''}</span><button class="btn primary" data-use-yes="${esc(b.bot)}" data-id="${esc(acctConfirm.id)}">Switch</button><button class="btn quiet" data-confirm-no>Keep</button></div>` : '';
  // "runs on": what the newest launch recorded; a bot never launched has nothing to say
  const why = ['failover', 'failback', 'recover'].includes(b.account_reason) ? ` (${b.account_reason === 'failover' ? 'backup, after a limit' : b.account_reason})` : '';
  const on = b.on_registered ? `runs on ${b.on}${why}` : b.running ? `runs on ${b.on || 'an unrecorded token'}${why}` : '';
  return `<div class="brow"><span class="ub">${esc(b.bot)}${b.running ? '' : ' <span class="dim">stopped</span>'}</span><span class="on">${esc(on)}</span>${sw}${sel}<button class="btn" data-use="${esc(b.bot)}">Use</button>${confirm}${chainRow(b, accounts)}</div>`;
}
// A bot's backups: the accounts the daemon moves it to, in order, when the one it
// runs on hits a usage limit. Edited as a draft; Save sends primary + backups.
const MAX_BACKUPS = 5;
let acctDraft = {};   // bot -> [ids] while being edited
// drawn, not glyphs: a font fallback can colour the arrow characters
const ICO = (d) => `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const ICO_UP = ICO('M7 11.5V2.5M3 6.5l4-4 4 4'), ICO_DOWN = ICO('M7 2.5v9M3 7.5l4 4 4-4'), ICO_X = ICO('M3.5 3.5l7 7M10.5 3.5l-7 7');
function chainRow(b, accounts) {
  const saved = b.backups || [];
  const list = acctDraft[b.bot] || saved;
  const primary = b.account_wanted || 'none';
  const name = (id) => (accounts.find((a) => a.id === id) || { label: id }).label;
  const items = list.map((id, i) => `<span class="bk"><span class="n">${i + 1}</span>${esc(name(id))}`
    + `<button type="button" data-bk-up="${i}" data-bot="${esc(b.bot)}" aria-label="move ${esc(id)} up"${i === 0 ? ' disabled' : ''}>${ICO_UP}</button>`
    + `<button type="button" data-bk-down="${i}" data-bot="${esc(b.bot)}" aria-label="move ${esc(id)} down"${i === list.length - 1 ? ' disabled' : ''}>${ICO_DOWN}</button>`
    + `<button type="button" data-bk-rm="${i}" data-bot="${esc(b.bot)}" aria-label="remove ${esc(id)} from the backups">${ICO_X}</button></span>`).join('');
  const free = accounts.filter((a) => a.id !== primary && !list.includes(a.id));
  const add = list.length < MAX_BACKUPS && free.length
    ? `<select data-bk-add="${esc(b.bot)}" aria-label="add a backup account for ${esc(b.bot)}"><option value="">${list.length ? 'Add another' : 'Add a backup'}</option>${free.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}</select>` : '';
  const changed = JSON.stringify(list) !== JSON.stringify(saved);
  const save = changed ? `<button class="btn" data-bk-save="${esc(b.bot)}">Save backups</button><button class="btn quiet" data-bk-reset="${esc(b.bot)}">Undo</button>` : '';
  if (!list.length && !add) return '';
  const confirm = acctConfirm && acctConfirm.kind === 'backups' && acctConfirm.bot === b.bot
    ? `<div class="confirm"><span class="grow">${list.length ? `When <b>${esc(b.bot)}</b> hits a usage limit, move it to <b>${list.map((id) => esc(name(id))).join('</b>, then <b>')}</b>, and back once its own account is clear?` : `Remove every backup from <b>${esc(b.bot)}</b>? A limit then waits for the reset.`} The conversation is kept.</span><button class="btn primary" data-bk-yes="${esc(b.bot)}">Save</button><button class="btn quiet" data-confirm-no>Keep editing</button></div>` : '';
  return `<div class="chain"><span class="lbl">${list.length ? 'Backups' : 'No backups'}</span>${items}${add}${save}</div>${confirm}`;
}
function renderAccounts() {
  const { accounts, bots } = acctData;
  el('accountsList').innerHTML = (accounts.length ? accounts.map(acctRow).join('') : '<p class="hint">No accounts registered yet. Add one below; <code>botcorp accounts seed</code> registers each bot\'s own token instead.</p>')
    + '<p class="sub">Bots</p>' + (bots.length ? bots.map((b) => botRow(b, accounts)).join('') : '<p class="hint">No bots yet.</p>');
  if (acctFocus) {
    const sel = el('accountsList').querySelector(`select[data-bot="${acctFocus}"]`);
    acctFocus = null;
    if (sel) sel.focus();
  }
}
async function loadAccounts() {
  const box = el('accountsList');
  if (!acctData) box.innerHTML = '<p class="loading">Loading accounts</p>';
  try {
    acctData = await api('GET', '/api/accounts');
    state.accounts = acctData.accounts;   // the header's account name reads the same list
    renderAccounts();
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}
function openAccounts(focusBot) { acctData = null; acctConfirm = null; acctDraft = {}; acctFocus = focusBot || null; el('acctErr').textContent = ''; openSheet('accountsBg'); loadAccounts(); }
el('accountsLink').onclick = (e) => { e.preventDefault(); openAccounts(); };
el('accountsClose').onclick = () => closeSheet('accountsBg');
el('accountsList').onclick = (e) => {
  const at = (sel) => e.target.closest(sel);
  let b;
  if ((b = at('[data-confirm-no]'))) { acctConfirm = null; return renderAccounts(); }
  if ((b = at('[data-remove]'))) { acctConfirm = { kind: 'remove', id: b.dataset.remove }; return renderAccounts(); }
  if ((b = at('[data-remove-yes]'))) {
    b.disabled = true;
    return operatorAct('DELETE', `/api/accounts/${encodeURIComponent(b.dataset.removeYes)}`, null, `removed ${b.dataset.removeYes}`, () => { acctConfirm = null; loadAccounts(); });
  }
  if ((b = at('[data-use]'))) {
    const bot = b.dataset.use;
    const sel = el('accountsList').querySelector(`select[data-bot="${bot}"]`);
    const row = acctData.bots.find((x) => x.bot === bot);
    if (row && sel.value === (row.account_wanted || 'none')) { toast(`${bot} is already set to ${sel.options[sel.selectedIndex].text}`); return; }
    acctConfirm = { kind: 'use', bot, id: sel.value, name: sel.options[sel.selectedIndex].text };
    return renderAccounts();
  }
  if ((b = at('[data-use-yes]'))) {
    b.disabled = true;
    const { useYes: bot, id } = b.dataset;
    const said = id === 'none' ? `${bot} goes back to its own token at its next idle turn` : `${bot} switches to ${id} at its next idle turn`;
    // through the chain route: a new primary that was a backup leaves the backups in the same step
    const row = acctData.bots.find((x) => x.bot === bot);
    const backups = (row && row.backups || []).filter((x) => x !== id);
    return operatorAct('POST', `/api/bots/${encodeURIComponent(bot)}/accounts`, { primary: id, backups }, said, () => { acctConfirm = null; delete acctDraft[bot]; usageData = null; loadAccounts(); });
  }
  const draftOf = (bot) => (acctDraft[bot] = acctDraft[bot] || [...((acctData.bots.find((x) => x.bot === bot) || {}).backups || [])]);
  if ((b = at('[data-bk-up]')) || (b = at('[data-bk-down]'))) {
    const d = draftOf(b.dataset.bot), i = Number(b.dataset.bkUp ?? b.dataset.bkDown), j = b.dataset.bkUp != null ? i - 1 : i + 1;
    if (j >= 0 && j < d.length) [d[i], d[j]] = [d[j], d[i]];
    return renderAccounts();
  }
  if ((b = at('[data-bk-rm]'))) { draftOf(b.dataset.bot).splice(Number(b.dataset.bkRm), 1); return renderAccounts(); }
  if ((b = at('[data-bk-reset]'))) { delete acctDraft[b.dataset.bkReset]; acctConfirm = null; return renderAccounts(); }
  if ((b = at('[data-bk-save]'))) { acctConfirm = { kind: 'backups', bot: b.dataset.bkSave }; return renderAccounts(); }
  if ((b = at('[data-bk-yes]'))) {
    b.disabled = true;
    const bot = b.dataset.bkYes;
    const row = acctData.bots.find((x) => x.bot === bot);
    const backups = draftOf(bot);
    const said = backups.length ? `${bot} backups: ${backups.join(', ')}` : `${bot} has no backups`;
    return operatorAct('POST', `/api/bots/${encodeURIComponent(bot)}/accounts`, { primary: (row && row.account_wanted) || 'none', backups }, said, () => { acctConfirm = null; delete acctDraft[bot]; usageData = null; loadAccounts(); });
  }
  const m = at('.meter');
  if (m && m.title) toast(m.title);
};
el('accountsList').onchange = (e) => {
  const s = e.target.closest('[data-bk-add]');
  if (!s || !s.value) return;
  const bot = s.dataset.bkAdd;
  acctDraft[bot] = acctDraft[bot] || [...((acctData.bots.find((x) => x.bot === bot) || {}).backups || [])];
  if (acctDraft[bot].length < MAX_BACKUPS && !acctDraft[bot].includes(s.value)) acctDraft[bot].push(s.value);
  renderAccounts();
};
el('acctAdd').onsubmit = async (e) => {
  e.preventDefault();
  const id = el('acctId').value.trim(), label = el('acctLabel').value.trim(), plan = el('acctPlan').value.trim(), token = el('acctToken').value.trim();
  const err = el('acctErr');
  err.textContent = '';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) { err.textContent = 'id: lowercase letters, digits and hyphens, at most 32'; el('acctId').focus(); return; }
  if (token.length < 20 || /\s/.test(token)) { err.textContent = 'paste the whole token claude setup-token printed'; el('acctToken').focus(); return; }
  el('acctAddBtn').disabled = true;
  try {
    const r = await operatorApi('POST', '/api/accounts', { id, label, plan, token });
    if (r.ok) { el('acctId').value = ''; el('acctLabel').value = ''; el('acctPlan').value = ''; toast((r.out || `added ${id}`).trim().split('\n')[0]); }
    else err.textContent = (r.err || r.out || `add failed (${r.code})`).trim();
  } catch (ex) { err.textContent = ex.message; }
  finally { el('acctToken').value = ''; el('acctAddBtn').disabled = false; }   // the token never stays in the page
  loadAccounts();
};

/* ---- settings sheet: one bot's bot.yaml (defaults merged) with `config set` behind
   each value, its pending approvals to decide in place, and this machine. ---- */
let setBot = null;
let setData = null;   // {config, set}
const SET_GROUP = { '': 'Bot', harness: 'Harness', 'harness.modules': 'Modules' };
function setGroupName(prefix) {
  if (Object.hasOwn(SET_GROUP, prefix)) return SET_GROUP[prefix];
  const last = prefix.split('.').pop();
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, ' ');
}
function setControl(p, v, f) {
  const d = `data-path="${esc(p)}" aria-label="${esc(p)}"`;
  if (f.kind === 'bool') return `<input type="checkbox" ${d}${v ? ' checked' : ''} />`;
  if (f.kind === 'enum') return `<select ${d}>${f.options.map((o) => `<option value="${esc(JSON.stringify(o))}"${o === v ? ' selected' : ''}>${esc(o === null ? (f.options.includes('none') ? 'host default' : 'none') : String(o))}</option>`).join('')}</select>`;
  if (f.kind === 'number') return `<input type="number" ${d} value="${esc(String(v))}" />`;
  return `<input type="text" ${d} value="${esc(v === null ? '' : String(v))}" placeholder="none" autocomplete="off" spellcheck="false" />`;
}
function setRow({ path: p, value: v }, set) {
  const C = window.CockpitCards;
  const f = C.configField(p, v);
  const key = `<span class="k" title="${esc(p)}">${esc(p.split('.').pop().replace(/_/g, ' '))}${set.has(p) ? '' : '<span class="d">default</span>'}</span>`;
  if (f.kind === 'readonly') return `<div class="srow">${key}<span class="v">${esc(C.configText(v))}<span class="note">${esc(f.note)}</span></span><span></span></div>`;
  return `<div class="srow">${key}${setControl(p, v, f)}<span class="sv" data-save-slot="${esc(p)}"></span></div>`;
}
function renderSettings() {
  const { config, set } = setData;
  const rows = window.CockpitCards.configRows(config);
  const groups = new Map();
  for (const r of rows) {
    const prefix = r.path.includes('.') ? r.path.slice(0, r.path.lastIndexOf('.')) : '';
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(r);
  }
  const have = new Set(set);
  el('setList').innerHTML = [...groups].map(([prefix, rs]) => `<p class="sub">${esc(setGroupName(prefix))}</p>${rs.map((r) => setRow(r, have)).join('')}`).join('');
}
function setValueOf(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.tagName === 'SELECT') return JSON.parse(input.value);
  if (input.type === 'number') return input.value.trim() === '' ? null : Number(input.value);
  return input.value.trim() === '' ? null : input.value;
}
async function loadSettings() {
  const pick = el('setBot');
  if (!setBot) { el('setList').innerHTML = '<p class="hint">No bots yet.</p>'; return; }
  pick.innerHTML = state.bots.map((b) => `<option value="${esc(b.name)}"${b.name === setBot ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  loadApprovals(el('setApprovals'), { bot: setBot });
  try {
    setData = await api('GET', `/api/bots/${encodeURIComponent(setBot)}/config`);
    renderSettings();
  } catch (e) { el('setList').innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}
async function loadHost() {
  const box = el('setHost');
  try {
    const h = await api('GET', '/api/cockpit');
    const row = (k, v) => `<div class="hostrow"><span class="hk">${esc(k)}</span><span>${esc(v)}</span></div>`;
    box.innerHTML = row('BotCorp', [h.version, h.commit].filter(Boolean).join(' · ') || 'unknown')
      + row('Claude Code', h.cc.pinned ? `${h.cc.pinned} pinned${h.cc.candidate ? ` · candidate ${h.cc.candidate.version} ${h.cc.candidate.status}` : ''}` : 'not pinned yet')
      + row('This cockpit', h.exposure === 'access' ? 'reachable through Cloudflare Access' : 'this machine only (loopback)');
  } catch (e) { box.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; }
}
function openSettings() {
  setBot = state.selected || (state.bots[0] && state.bots[0].name) || null;
  setData = null;
  el('setApprovals').innerHTML = '';
  el('setList').innerHTML = '<p class="loading">Loading settings</p>';
  openSheet('settingsBg');
  loadSettings();
  loadHost();
}
el('settingsLink').onclick = (e) => { e.preventDefault(); openSettings(); };
el('settingsClose').onclick = () => closeSheet('settingsBg');
el('setBot').onchange = () => { setBot = el('setBot').value; el('setApprovals').innerHTML = ''; loadSettings(); };
// A changed value gets its own Save; putting it back takes the button away.
el('setList').addEventListener('input', (e) => {
  const input = e.target.closest('[data-path]');
  if (!input || !setData) return;
  const p = input.dataset.path;
  const slot = el('setList').querySelector(`[data-save-slot="${CSS.escape(p)}"]`);
  const was = window.CockpitCards.configRows(setData.config).find((r) => r.path === p);
  let now;
  try { now = setValueOf(input); } catch { now = undefined; }
  slot.innerHTML = was && JSON.stringify(now) !== JSON.stringify(was.value) ? `<button class="btn" data-save="${esc(p)}">Save</button>` : '';
});
el('setList').onclick = async (e) => {
  const b = e.target.closest('[data-save]');
  if (!b) return;
  const p = b.dataset.save;
  const input = el('setList').querySelector(`[data-path="${CSS.escape(p)}"]`);
  b.disabled = true;
  try {
    const r = await operatorApi('POST', `/api/bots/${encodeURIComponent(setBot)}/config`, { path: p, value: setValueOf(input) });
    toast(r.queued ? `${p}: waits for your approval below` : r.duplicate ? `${p}: already waiting for approval` : `${p} saved; applies at the next session roll`);
  } catch (ex) { toast(ex.message, true); }
  refreshAttention();
  loadSettings();
};

/* ---- boot ---- */
api('GET', '/api/engine/version').then((v) => { el('ver').textContent = [v.version, v.commit, v.exposure === 'access' ? 'via\xa0Access' : 'loopback\xa0only'].filter(Boolean).join('\xa0· '); }).catch(() => {});
// registered accounts, so the header names the account instead of its token
api('GET', '/api/accounts').then((r) => { state.accounts = r.accounts || []; renderStats(); }).catch(() => {});
refresh();
setInterval(refresh, 5000);
loadPending();
refreshAttention();
setInterval(refreshAttention, 5000);
