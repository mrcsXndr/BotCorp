// Shared by the src/lib tests; ported from cockpit/tests/chat-render.test.mjs.
//
// The safety property: escaped text never contains a raw '<', so every '<' in
// the output is markup and must be exactly one whitelisted tag with
// whitelisted, double-quoted attributes; an href must be http(s) or mailto.
// The payloads are proven load-bearing against NAIVE renderers (positive control).
import type { DocLike } from '../lib/inbox';

const TAGS = new Set(['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'h5', 'hr', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ATTRS: Record<string, string[]> = { a: ['href', 'rel', 'target'], ol: ['start'], div: ['class'], th: ['class'], td: ['class'] };
const TAG_RE = /<(\/?)([a-z0-9]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>/y;
export function assertSafe(html: string): void {
  for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i + 1)) {
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(html);
    if (!m) throw new Error(`malformed markup at ${i}: ${html.slice(i, i + 60)}`);
    const tag = m[2];
    if (!TAGS.has(tag)) throw new Error(`tag <${tag}> not allowed`);
    for (const a of m[3].matchAll(/([a-z-]+)="([^"]*)"/g)) {
      if (!(ATTRS[tag] || []).includes(a[1])) throw new Error(`attribute ${a[1]} not allowed on <${tag}>`);
      if (a[1] === 'href' && !/^(https?:\/\/|mailto:)/i.test(a[2])) throw new Error(`href ${a[2]} not allowed`);
      if (a[1] === 'rel' && a[2] !== 'noopener noreferrer') throw new Error('rel must be noopener noreferrer');
      if (a[1] === 'target' && a[2] !== '_blank') throw new Error('target must be _blank');
    }
    if (tag === 'a' && !m[1] && !/\srel="noopener noreferrer"/.test(m[3])) throw new Error('<a> without rel');
  }
}

export const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<a href="javascript:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[x](javascript:alert`1`)',
  '[x](JaVaScRiPt:alert`1`)',
  '[x]( javascript:alert`1` )',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x](https://a.example/"onmouseover="alert(1))',
  '[x](https://a.example/"onmouseover="alert`1`)',
  '[x"><img src=x onerror=alert(1)>](https://a.example)',
  '`<img src=x onerror=alert(1)>`',
  '`` `<img src=x onerror=alert(1)>` ``',
  '```\n</code></pre><img src=x onerror=alert(1)>\n```',
  '**<img src=x onerror=alert(1)>**',
  '*<svg onload=alert(1)>*',
  '# <iframe src=javascript:alert(1)>',
  '> <img src=x onerror=alert(1)>',
  '- <img src=x onerror=alert(1)>',
  '| a | b |\n|---|---|\n| <svg onload=alert(1)> | [y](javascript:alert(1)) |',
  'https://a.example/<img/src=x/onerror=alert(1)>',
];

// Naive renderers the guard must reject. One per defect class.
export const NAIVE: Record<string, (s: string) => string> = {
  'no escaping': (s) => s
    .replace(/```\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`+([^`]+)`+/g, '<code>$1</code>')
    .replace(/^#+ (.*)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>'),
  'escaped, no scheme check': (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>'),
  'escaped except quotes': (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>'),
};

// A DOM that refuses innerHTML: a renderer that parses markup at all fails here.
export interface StubNode {
  tagName: string; className: string; title: string; text: string; textContent: string;
  children: StubNode[]; appendChild(c: StubNode): StubNode; onclick?: () => void; innerHTML: string;
}
export function stubDoc(): DocLike {
  const make = (tag: string) => {
    const n = { tagName: tag, className: '', title: '', children: [] as StubNode[], text: '' } as StubNode;
    n.appendChild = (c) => { n.children.push(c); return c; };
    Object.defineProperty(n, 'textContent', { get: () => n.text + n.children.map((c) => c.textContent).join(''), set: (v) => { n.text = String(v); n.children = []; } });
    Object.defineProperty(n, 'innerHTML', { get: () => { throw new Error('innerHTML read'); }, set: () => { throw new Error('innerHTML assigned'); } });
    return n;
  };
  return { createElement: make } as unknown as DocLike;
}
export const stub = (x: unknown) => x as StubNode;
// What the browser would serialize the stub tree to.
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const serialize = (n: StubNode): string => `<${n.tagName}${n.className ? ` class="${escHtml(n.className)}"` : ''}>${escHtml(n.text)}${n.children.map(serialize).join('')}</${n.tagName}>`;
