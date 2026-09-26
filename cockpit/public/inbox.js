/* The chat composer's sent messages: a user bubble plus a status line that
   follows the message through the bot's inbox (core/inbox.mjs). Everything
   here is built with createElement + textContent, never innerHTML: the text
   is whatever the operator pasted, and a status detail can quote the session
   (a blocked session's `needs`). Loaded before app.js; tested in node with a
   DOM that refuses innerHTML (cockpit/tests/chat-render.test.mjs). */
'use strict';
(function (root) {
  const STATUSES = ['sending', 'queued', 'held', 'delivered', 'expired', 'failed'];
  const TERMINAL = ['delivered', 'expired', 'failed'];
  const LABEL = { sending: 'sending', queued: 'queued', held: 'held', delivered: 'delivered', expired: 'expired', failed: 'not delivered' };
  const SAY_WHY = ['held', 'expired', 'failed'];   // the detail is shown, not only on hover (phones have none)

  // -> { node, status } ; `doc` is the document (a stub in the tests).
  function sentBubble(doc, text) {
    const node = doc.createElement('div');
    node.className = 'bubble user sent';
    const body = doc.createElement('div');
    body.className = 'plain';
    body.textContent = String(text);
    const status = doc.createElement('div');
    status.className = 'ist sending';
    status.textContent = LABEL.sending;
    node.appendChild(body);
    node.appendChild(status);
    return { node, status };
  }

  // item: {status, detail} from POST /send or GET /inbox. Returns the status shown.
  function setStatus(el, item) {
    const st = STATUSES.includes(item && item.status) ? item.status : 'failed';
    const detail = String((item && item.detail) || '');
    el.className = 'ist ' + st;
    el.textContent = SAY_WHY.includes(st) && detail ? `${LABEL[st]}: ${detail}` : LABEL[st];
    el.title = detail;
    return st;
  }

  root.CockpitInbox = { sentBubble, setStatus, TERMINAL, STATUSES };
})(typeof window !== 'undefined' ? window : globalThis);
