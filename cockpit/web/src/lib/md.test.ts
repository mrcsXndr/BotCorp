// Ported from the md.js cases of cockpit/tests/chat-render.test.mjs.
import { test, expect } from 'vitest';
import { renderMarkdown } from './md';
import { assertSafe, PAYLOADS, NAIVE } from '../test/safety';

test('every XSS payload renders safe', () => {
  for (const p of PAYLOADS) expect(() => assertSafe(renderMarkdown(p)), `payload ${JSON.stringify(p)} -> ${renderMarkdown(p)}`).not.toThrow();
});

test('positive control: the naive renderers fail the same check', () => {
  const caught = new Set<string>();
  for (const p of PAYLOADS) {
    const failing = Object.entries(NAIVE).filter(([, fn]) => { try { assertSafe(fn(p)); return false; } catch { return true; } }).map(([k]) => k);
    expect(failing.length, `payload ${JSON.stringify(p)} does not trip any naive renderer, so it proves nothing`).toBeGreaterThan(0);
    failing.forEach((k) => caught.add(k));
  }
  // each defect class is caught by at least one payload
  expect([...caught].sort()).toEqual(Object.keys(NAIVE).sort());
});

test('raw HTML is shown as text, not parsed', () => {
  expect(renderMarkdown('<b>hi</b> & "q"')).toBe('<p>&lt;b&gt;hi&lt;/b&gt; &amp; &quot;q&quot;</p>');
});

test('javascript:, data: and relative links stay text; the quote cannot break out', () => {
  expect(renderMarkdown('[x](javascript:alert(1))')).not.toMatch(/<a/);
  expect(renderMarkdown('[x](data:text/html,hi)')).not.toMatch(/<a/);
  expect(renderMarkdown('[x](/etc/passwd)')).not.toMatch(/<a/);
  const h = renderMarkdown('[x](https://a.example/"onmouseover="alert`1`)');
  expect(h).toMatch(/href="https:\/\/a\.example\/&quot;onmouseover=&quot;alert`1`"/);
});

test('links: http, https, mailto with rel and target', () => {
  expect(renderMarkdown('[a](https://x.example/p?q=1&r=2)')).toBe('<p><a href="https://x.example/p?q=1&amp;r=2" rel="noopener noreferrer" target="_blank">a</a></p>');
  expect(renderMarkdown('[m](mailto:a@b.example)')).toMatch(/<a href="mailto:a@b\.example" rel="noopener noreferrer" target="_blank">m<\/a>/);
  expect(renderMarkdown('see https://x.example/a.')).toMatch(/<a href="https:\/\/x\.example\/a" [^>]*>https:\/\/x\.example\/a<\/a>\.<\/p>$/);
  // no link nested inside a link's text
  expect((renderMarkdown('[see https://a.example](https://b.example)').match(/<a /g) || []).length).toBe(1);
});

test('inline: bold, italic, code; snake_case and 2 * 3 * 4 stay plain', () => {
  expect(renderMarkdown('**b** *i* _j_ `c`')).toBe('<p><strong>b</strong> <em>i</em> <em>j</em> <code>c</code></p>');
  expect(renderMarkdown('file_name_here and 2 * 3 * 4')).toBe('<p>file_name_here and 2 * 3 * 4</p>');
  expect(renderMarkdown('`` a ` b ``')).toBe('<p><code>a ` b</code></p>');
  expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  expect(renderMarkdown('line one\nline two')).toBe('<p>line one<br>line two</p>');
});

test('blocks: headings, fences, quotes, rules', () => {
  expect(renderMarkdown('# A\n### B\n###### C')).toBe('<h3>A</h3><h4>B</h4><h5>C</h5>');
  expect(renderMarkdown('# Using C#')).toBe('<h3>Using C#</h3>');
  expect(renderMarkdown('```js\nconst a = 1 < 2;\n\n**x**\n```\nafter')).toBe('<pre><code>const a = 1 &lt; 2;\n\n**x**</code></pre><p>after</p>');
  expect(renderMarkdown('```\nunclosed <b>')).toBe('<pre><code>unclosed &lt;b&gt;</code></pre>');
  expect(renderMarkdown('> q **b**\n> two')).toBe('<blockquote><p>q <strong>b</strong><br>two</p></blockquote>');
  expect(renderMarkdown('a\n\n---\n\nb')).toBe('<p>a</p><hr><p>b</p>');
});

test('lists: bullets, numbers, nesting by indent, start number', () => {
  expect(renderMarkdown('- a\n- b\n  - c\n- d')).toBe('<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>');
  expect(renderMarkdown('3. x\n4. y')).toBe('<ol start="3"><li>x</li><li>y</li></ol>');
  expect(renderMarkdown('1. x\n   - y')).toBe('<ol><li>x<ul><li>y</li></ul></li></ol>');
});

test('tables: header, alignment, escaped cells, pipe without a separator is text', () => {
  expect(renderMarkdown('| a | b |\n|:-:|--:|\n| 1 | `2` |')).toBe(
    '<div class="tbl"><table><thead><tr><th class="c">a</th><th class="r">b</th></tr></thead><tbody><tr><td class="c">1</td><td class="r"><code>2</code></td></tr></tbody></table></div>');
  expect(renderMarkdown('a | b\nc')).toBe('<p>a | b<br>c</p>');
});

test('pathological input stays linear', () => {
  // "x " first so no block rule swallows the line and the inline scanner runs.
  // 200k chars of unclosed ** took ~7 s when BOLD_RE was an unbounded lazy scan.
  for (const unit of ['**a ', ' __a', '*a ', '[a](b ', '`*_[h', 'http://a']) {
    const s = 'x ' + unit.repeat(Math.floor(200000 / unit.length));
    const t0 = Date.now();
    const out = renderMarkdown(s);
    expect(out.length, `${JSON.stringify(unit)} lost content`).toBeGreaterThanOrEqual(s.length - 10);
    expect(Date.now() - t0, `${JSON.stringify(unit)} took ${Date.now() - t0} ms`).toBeLessThan(1500);
  }
});

// The task card's result body (chat.mjs parseTaskNotifications passes it through as text).
test('task card result: renders through md and stays safe', () => {
  for (const p of PAYLOADS) assertSafe(renderMarkdown(`${p}\n\n**ok** [x](javascript:alert(1))`));
});
