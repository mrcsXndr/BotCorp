// ptybridge.mjs - bridge one browser WebSocket to a bot's pty-host.
//
// The cockpit never spawns a session. For each browser attach it dials the
// bot's pty-host (endpoint from state/<bot>.pty.json; for a live bg session
// the attach host core/inbox.mjs shares, started when none is up) and pipes
// frames both ways:
//   pty-host -> browser : hello / o (scrollback then live) / exit / err, as-is
//   browser  -> pty-host: i (input, 1 MB cap re-checked here) / r (resize)
// plus cockpit-side pushes on the same socket, so the client needs no polling
// while it holds a socket:
//   {t:'chat', ...chatState}   new transcript turns (tailed server-side)
//   {t:'status', ...chatStatus} header chips, sent when they change
//   {t:'stopped'}              no pty-host is up for this bot

import WebSocket from 'ws';
import { ptyEndpoint } from './bots.mjs';
import { chatState } from './chat.mjs';
import { chatStatus } from './chatstatus.mjs';
import { attachHost } from '../core/inbox.mjs';

const MAX_INPUT_FRAME = 1024 * 1024;
const CHAT_TICK_MS = 1500;
const STATUS_TICK_MS = 5000;

function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }

export async function bridge(bot, browser, { chat = true } = {}) {
  let upstream = null;
  let closed = false;
  let chatTimer = null;
  let chatCursor = 0;
  let chatFile = null;
  let chatBusy = false;
  let statusTimer = null;
  let lastStatus = '';
  const early = [];   // input/resize frames sent before the pty-host socket is open

  const closeAll = () => {
    closed = true;
    if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    try { upstream?.close(); } catch {}
    try { browser.close(); } catch {}
  };
  const toUpstream = (frame) => {
    if (upstream && upstream.readyState === 1) upstream.send(frame);
    else if (!closed && early.length < 64) early.push(frame);
  };

  // Listeners before the first await: ws emits 'error' (a frame over maxPayload,
  // a bad opcode) on a socket with no listener as an uncaught exception, which
  // killed the cockpit; frames in that window were dropped.
  browser.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i') {
      if (typeof msg.d !== 'string') return;
      if (msg.d.length > MAX_INPUT_FRAME) { send(browser, { t: 'err', m: 'input frame over 1 MB dropped' }); return; }
      toUpstream(JSON.stringify({ t: 'i', d: msg.d }));
    } else if (msg.t === 'r') {
      toUpstream(JSON.stringify({ t: 'r', cols: msg.cols, rows: msg.rows }));
    } else if (msg.t === 'chat-reset') {
      chatCursor = 0; chatFile = null;
    }
  });
  browser.on('close', closeAll);
  browser.on('error', closeAll);

  let ep = await ptyEndpoint(bot.name);
  // a live bg session has no pty-host of its own: start the attach host the
  // inbox shares (it exits on its own once no client is left)
  if (!closed && !ep && bot.kind === 'bg' && bot.running) {
    const r = await attachHost(bot.name, 'bg');
    if (r.err) send(browser, { t: 'err', m: r.err });
    ep = r.ep || null;
  }
  if (closed) return;

  if (!ep) {
    send(browser, { t: 'stopped' });
  } else {
    upstream = new WebSocket(`ws://127.0.0.1:${ep.port}/?token=${encodeURIComponent(ep.token)}`, { maxPayload: 2 * MAX_INPUT_FRAME });
    upstream.on('open', () => { for (const f of early.splice(0)) upstream.send(f); });
    upstream.on('message', (raw) => { try { if (browser.readyState === 1) browser.send(raw.toString()); } catch {} });
    upstream.on('close', () => { send(browser, { t: 'detached' }); closeAll(); });
    upstream.on('error', (e) => { send(browser, { t: 'err', m: `pty-host: ${e.message}` }); });
  }

  if (chat) {
    const tick = async () => {
      if (chatBusy || browser.readyState !== 1) return;
      chatBusy = true;
      try {
        const st = await chatState(bot, chatCursor);
        if (!st.available) { send(browser, { t: 'chat', ...st }); clearInterval(chatTimer); chatTimer = null; return; }
        const rotated = chatFile !== null && st.file !== chatFile;
        if (rotated) { chatCursor = 0; chatFile = st.file; send(browser, { t: 'chat', rotated: true, hasSession: st.hasSession, turns: [], cursor: 0, file: st.file }); return; }
        if (chatFile === null) chatFile = st.file;
        if (st.turns.length || chatCursor === 0) send(browser, { t: 'chat', ...st, initial: chatCursor === 0 });
        chatCursor = st.cursor;
      } catch {} finally { chatBusy = false; }
    };
    await tick();
    chatTimer = setInterval(tick, CHAT_TICK_MS);

    const statusTick = async () => {
      if (browser.readyState !== 1) return;
      const st = JSON.stringify(await chatStatus(bot));
      if (st !== lastStatus) { lastStatus = st; send(browser, { t: 'status', ...JSON.parse(st) }); }
    };
    await statusTick();
    if (browser.readyState === 1) statusTimer = setInterval(statusTick, STATUS_TICK_MS);
  }
}
