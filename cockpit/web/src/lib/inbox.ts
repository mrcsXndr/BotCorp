// The chat composer's sent messages: a user bubble (with its attachment chips)
// plus a status line that follows the message through the bot's inbox
// (core/inbox.mjs). Everything here is built with createElement +
// textContent, never innerHTML: the text is whatever the operator pasted, and
// a status detail can quote the session (a blocked session's `needs`).
// cockpit/tests/*.test.mjs import this file as is (Node strips the types).

export const STATUSES = ['sending', 'queued', 'held', 'delivered', 'expired', 'failed'] as const;
export type InboxStatus = (typeof STATUSES)[number];
export const TERMINAL: readonly InboxStatus[] = ['delivered', 'expired', 'failed'];
export const LABEL: Record<InboxStatus, string> = { sending: 'sending', queued: 'queued', held: 'held', delivered: 'delivered', expired: 'expired', failed: 'not delivered' };
const SAY_WHY: readonly InboxStatus[] = ['held', 'expired', 'failed'];   // the detail is shown, not only on hover (phones have none)

export type DocLike = Pick<Document, 'createElement'>;
export interface ChipView { name: string; size: string; image?: boolean }

// One attachment: a thumbnail for an image (its src set by the caller; the
// name and size show instead while it has none), else the name and size;
// with onRemove, a remove button (the composer's chips). v: {name, size, image}.
export function chip(doc: DocLike, v: ChipView, onRemove?: () => void): { node: HTMLDivElement; thumb: HTMLImageElement | null } {
  const c = doc.createElement('div');
  c.className = 'achip' + (v.image ? ' img' : '');
  c.title = `${v.name} (${v.size})`;
  let thumb: HTMLImageElement | null = null;
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
export function sentBubble(doc: DocLike, text: unknown, files?: readonly ChipView[] | null): { node: HTMLDivElement; status: HTMLDivElement; thumbs: (HTMLImageElement | null)[] } {
  const node = doc.createElement('div');
  node.className = 'bubble user sent';
  if (String(text)) {
    const body = doc.createElement('div');
    body.className = 'plain';
    body.textContent = String(text);
    node.appendChild(body);
  }
  const thumbs: (HTMLImageElement | null)[] = [];
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
export function setStatus(el: HTMLElement, item?: { status?: unknown; detail?: unknown } | null): InboxStatus {
  const st: InboxStatus = (STATUSES as readonly unknown[]).includes(item && item.status) ? (item!.status as InboxStatus) : 'failed';
  const detail = String((item && item.detail) || '');
  el.className = 'ist ' + st;
  el.textContent = SAY_WHY.includes(st) && detail ? `${LABEL[st]}: ${detail}` : LABEL[st];
  el.title = detail;
  return st;
}
