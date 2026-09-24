// ptybridge.mjs - bridge one browser WebSocket to a bot's pty-host.
//
// The cockpit never spawns a pty. For each browser attach it dials the bot's
// pty-host (endpoint from state/<bot>.pty.json) and pipes frames both ways:
//   pty-host -> browser : hello / o (scrollback then live) / exit / err, as-is
//   browser  -> pty-host: i (input, 1 MB cap re-checked here) / r (resize)
// plus cockpit-side pushes on the same socket, so the client needs no polling
// while it holds a socket:
//   {t:'chat', ...chatState}   new transcript turns (tailed server-side)
//   {t:'stopped'}              no pty-host is up for this bot

import WebSocket from 'ws';
import { ptyEndpoint } from './bots.mjs';
import { chatState } from './chat.mjs';

const MAX_INPUT_FRAME = 1024 * 1024;
const CHAT_TICK_MS = 1500;

function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }

export async function bridge(bot, browser, { chat = true } = {}) {
  const ep = await ptyEndpoint(bot.name);
  let upstream = null;
  let chatTimer = null;
  let chatCursor = 0;
  let chatFile = null;
  let chatBusy = false;

  const closeAll = () => {
    if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
    try { upstream?.close(); } catch {}
    try { browser.close(); } catch {}
  };

  if (!ep) {
    send(browser, { t: 'stopped' });
  } else {
    upstream = new WebSocket(`ws://127.0.0.1:${ep.port}/?token=${encodeURIComponent(ep.token)}`, { maxPayload: 2 * MAX_INPUT_FRAME });
    upstream.on('message', (raw) => { try { if (browser.readyState === 1) browser.send(raw.toString()); } catch {} });
    upstream.on('close', () => { send(browser, { t: 'detached' }); closeAll(); });
    upstream.on('error', (e) => { send(browser, { t: 'err', m: `pty-host: ${e.message}` }); });
  }

  browser.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i') {
      if (typeof msg.d !== 'string') return;
      if (msg.d.length > MAX_INPUT_FRAME) { send(browser, { t: 'err', m: 'input frame over 1 MB dropped' }); return; }
      if (upstream && upstream.readyState === 1) upstream.send(JSON.stringify({ t: 'i', d: msg.d }));
    } else if (msg.t === 'r') {
      if (upstream && upstream.readyState === 1) upstream.send(JSON.stringify({ t: 'r', cols: msg.cols, rows: msg.rows }));
    } else if (msg.t === 'chat-reset') {
      chatCursor = 0; chatFile = null;
    }
  });
  browser.on('close', closeAll);
  browser.on('error', closeAll);

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
  }
}
