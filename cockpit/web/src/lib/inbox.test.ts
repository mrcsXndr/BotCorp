// Ported from the inbox.js cases of cockpit/tests/chat-render.test.mjs and
// cockpit/tests/attach.test.mjs, on the same DOM stub that refuses innerHTML.
import { test, expect } from 'vitest';
import { chip, sentBubble, setStatus } from './inbox';
import { assertSafe, PAYLOADS, serialize, stub, stubDoc } from '../test/safety';

test('a sent message and its status render every payload as text', () => {
  for (const p of PAYLOADS) {
    const { node, status } = sentBubble(stubDoc(), p);
    expect(stub(node).children[0].textContent, 'the text comes back exactly as typed').toBe(p);
    for (const st of ['queued', 'held', 'delivered', 'expired', 'failed']) {
      setStatus(status, { status: st, detail: `session blocked on '${p}'` });
      expect(status.title).toBe(`session blocked on '${p}'`);
      expect(() => assertSafe(serialize(stub(node))), `payload ${JSON.stringify(p)} as ${st}`).not.toThrow();
    }
  }
});

test('positive control: a renderer that uses innerHTML fails the stub DOM', () => {
  const naive = (doc: ReturnType<typeof stubDoc>, text: string) => { const n = doc.createElement('div'); n.innerHTML = `<div>${text}</div>`; return n; };
  expect(() => naive(stubDoc(), PAYLOADS[0])).toThrow(/innerHTML assigned/);
});

test('status line: the label, the why for held/expired/failed, an unknown status reads failed', () => {
  const { status } = sentBubble(stubDoc(), 'hi');
  expect(status.textContent).toBe('sending');
  expect(setStatus(status, { status: 'queued', detail: '' })).toBe('queued');
  expect(status.className).toBe('ist queued');
  setStatus(status, { status: 'delivered', detail: 'via the running attach host; user turn confirmed in the transcript' });
  expect(status.textContent).toBe('delivered');
  setStatus(status, { status: 'held', detail: "session blocked on 'login required'" });
  expect(status.textContent).toBe("held: session blocked on 'login required'");
  expect(setStatus(status, { status: '<b>x</b>', detail: 'odd' })).toBe('failed');
  expect(status.className).toBe('ist failed');
});

test('chip: a thumbnail slot for an image, name and size as text, a remove button when removable', () => {
  let removed = 0;
  const hostile = '<img src=x onerror=alert(1)>.png';
  const r = chip(stubDoc(), { name: hostile, size: '2 KB', image: true }, () => removed++);
  const node = stub(r.node);
  expect(node.className).toBe('achip img');
  expect(stub(r.thumb).tagName).toBe('img');
  expect(node.children.map((c) => c.tagName)).toEqual(['img', 'span', 'span', 'button']);
  expect(node.children[1].textContent, 'the name is text, never markup').toBe(hostile);
  expect(node.children[3].title).toBe(`Remove ${hostile}`);
  node.children[3].onclick!();
  expect(removed).toBe(1);
  const doc = chip(stubDoc(), { name: 'notes.md', size: '10 B', image: false });
  expect(doc.thumb).toBeNull();
  expect(stub(doc.node).children.map((c) => c.tagName), 'a sent chip has no remove button').toEqual(['span', 'span']);
});

test('sentBubble with files: the chips under the text; an attachment-only message has no empty body', () => {
  const files = [{ name: 'a.png', size: '1 KB', image: true }, { name: 'b.pdf', size: '2 MB', image: false }];
  const b = sentBubble(stubDoc(), 'see these', files);
  expect(stub(b.node).children.map((c) => c.className)).toEqual(['plain', 'achips', 'ist sending']);
  expect(stub(b.node).children[1].children.length).toBe(2);
  expect(b.thumbs.length).toBe(2);
  expect(stub(b.thumbs[0]).tagName).toBe('img');
  expect(b.thumbs[1]).toBeNull();
  const only = sentBubble(stubDoc(), '', files);
  expect(stub(only.node).children.map((c) => c.className)).toEqual(['achips', 'ist sending']);
});
