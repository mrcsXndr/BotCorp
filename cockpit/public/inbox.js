/* The chat composer's sent messages: a user bubble (with its attachment chips)
   plus a status line that follows the message through the bot's inbox
   (core/inbox.mjs). Everything
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

  // One attachment: a thumbnail for an image (its src set by the caller; the
  // name and size show instead while it has none), else the name and size;
  // with onRemove, a remove button (the composer's chips). v: {name, size, image}.
  function chip(doc, v, onRemove) {
    const c = doc.createElement('div');
    c.className = 'achip' + (v.image ? ' img' : '');
    c.title = `${v.name} (${v.size})`;
    let thumb = null;
    if (v.image) {
      thumb = doc.createElement('img');
      thumb.alt = '';
      c.appendChild(thumb);
    }
    const n = doc.createElement('span');
    n.className = 'an';
    n.textContent = String(v.name);
    const s = doc.createElement('span');
    s.className = 'as';
    s.textContent = String(v.size);
    c.appendChild(n);
    c.appendChild(s);
    if (onRemove) {
      const x = doc.createElement('button');
      x.className = 'ax';
      x.type = 'button';
      x.title = `Remove ${v.name}`;
      x.textContent = '×';
      x.onclick = onRemove;
      c.appendChild(x);
    }
    return { node: c, thumb };
  }

  // -> { node, status, thumbs } ; `doc` is the document (a stub in the tests).
  // files: [{name, size, image}] shown as chips under the text; thumbs[i] is
  // the <img> of files[i] (null for a non-image).
  function sentBubble(doc, text, files) {
    const node = doc.createElement('div');
    node.className = 'bubble user sent';
    if (String(text)) {
      const body = doc.createElement('div');
      body.className = 'plain';
      body.textContent = String(text);
      node.appendChild(body);
    }
    const thumbs = [];
    if (files && files.length) {
      const row = doc.createElement('div');
      row.className = 'achips';
      for (const f of files) { const c = chip(doc, f); row.appendChild(c.node); thumbs.push(c.thumb); }
      node.appendChild(row);
    }
    const status = doc.createElement('div');
    status.className = 'ist sending';
    status.textContent = LABEL.sending;
    node.appendChild(status);
    return { node, status, thumbs };
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

  root.CockpitInbox = { sentBubble, setStatus, chip, TERMINAL, STATUSES };
})(typeof window !== 'undefined' ? window : globalThis);
