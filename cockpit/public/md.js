/* Markdown for chat bubbles. Transcript text is untrusted (it carries whatever
   arrived over Telegram and whatever the model wrote), so this is safe by
   construction: every character of input leaves through esc(), and the only
   markup ever emitted is the fixed tag set below with no attributes except a
   scheme-checked href. Raw HTML in the input is shown as text, never parsed.
   Subset: headings, bold/italic, inline code, fenced code, lists (nested by
   indent), blockquote, links (http/https/mailto), tables, rules.
   Classic script on purpose: the page loads it with <script>, and the tests
   evaluate this exact file in a vm context (globalThis.CockpitMarkdown). */
'use strict';
(function (root) {
  const MAX_INPUT = 200000;
  const MAX_DEPTH = 8;

  function esc(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // http, https and mailto only. Anything else (javascript:, data:, vbscript:,
  // a relative path) renders as plain text instead of a link.
  function safeHref(url) {
    const u = String(url || '').trim();
    return /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(u) ? u : null;
  }

  function link(href, innerHtml) {
    return `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${innerHtml}</a>`;
  }

  const LINK_RE = /\[([^\]\n]{1,1000})\]\(\s*([^()\s]{1,2000})\s*\)/y;
  // Bounded: an unbounded lazy scan from every unclosed ** is quadratic.
  const BOLD_RE = /(\*\*|__)(?=\S)([^\n]{0,1000}?\S)\1/y;
  const STAR_EM_RE = /\*(?=[^\s*])([^\n*]*?[^\s*])\*/y;
  const UND_EM_RE = /_(?=[^\s_])([^\n_]*?[^\s_])_(?![A-Za-z0-9_])/y;
  const AUTOLINK_RE = /https?:\/\/[^\s<>()[\]"'`]+/y;

  function at(re, s, i) { re.lastIndex = i; return re.exec(s); }

  // Inline spans. Text accumulates raw in `buf` and is escaped on flush; every
  // matched span escapes its own content (or recurses, which escapes it).
  // noLink: inside a link's text, where a nested <a> would be invalid.
  function inline(s, depth, noLink) {
    let out = '';
    let buf = '';
    const flush = () => { out += esc(buf).replace(/\n/g, '<br>'); buf = ''; };
    const d = (depth || 0) + 1;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '`') {
        let n = 1;
        while (s[i + n] === '`') n++;
        const ticks = '`'.repeat(n);
        let j = s.indexOf(ticks, i + n);
        while (j !== -1 && s[j + n] === '`') { let k = j; while (s[k] === '`') k++; j = s.indexOf(ticks, k); }
        if (j === -1) { buf += ticks; i += n; continue; }
        let code = s.slice(i + n, j);
        if (/^ .*[^ ].* $/s.test(code)) code = code.slice(1, -1);
        flush();
        out += `<code>${esc(code)}</code>`;
        i = j + n;
        continue;
      }
      if (d <= MAX_DEPTH) {
        if (c === '[' && !noLink) {
          const m = at(LINK_RE, s, i);
          const href = m && safeHref(m[2]);
          if (href) { flush(); out += link(href, inline(m[1], d, true)); i += m[0].length; continue; }
        } else if ((c === '*' || c === '_') && s[i + 1] === c) {
          const m = at(BOLD_RE, s, i);
          if (m && (c === '*' || !/[A-Za-z0-9]/.test(s[i - 1] || ''))) { flush(); out += `<strong>${inline(m[2], d, noLink)}</strong>`; i += m[0].length; continue; }
        } else if (c === '*') {
          const m = at(STAR_EM_RE, s, i);
          if (m) { flush(); out += `<em>${inline(m[1], d, noLink)}</em>`; i += m[0].length; continue; }
        } else if (c === '_' && !/[A-Za-z0-9_]/.test(s[i - 1] || '')) {
          const m = at(UND_EM_RE, s, i);
          if (m) { flush(); out += `<em>${inline(m[1], d, noLink)}</em>`; i += m[0].length; continue; }
        } else if (c === 'h' && !noLink && !/[A-Za-z0-9]/.test(s[i - 1] || '')) {
          const m = at(AUTOLINK_RE, s, i);
          if (m) {
            const url = m[0].replace(/[.,;:!?]+$/, '');
            const href = safeHref(url);
            if (href) { flush(); out += link(href, esc(url)); i += url.length; continue; }
          }
        }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
  const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE_RE = /^ {0,3}> ?(.*)$/;
  const ITEM_RE = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function cells(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, '|'));
  }

  const isBlank = (l) => !l.trim();
  // A line that starts a block of its own ends a paragraph.
  function startsBlock(l) {
    return FENCE_RE.test(l) || HEADING_RE.test(l) || RULE_RE.test(l) || QUOTE_RE.test(l) || ITEM_RE.test(l);
  }

  function blocks(lines, depth) {
    if (depth > MAX_DEPTH) return `<p>${inline(lines.join('\n'), MAX_DEPTH)}</p>`;
    let out = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      const fence = FENCE_RE.exec(line);
      if (fence) {
        const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
        const body = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        i++;   // the closing fence (or past the end: an unclosed fence runs to the end)
        out += `<pre><code>${esc(body.join('\n'))}</code></pre>`;
        continue;
      }

      const h = HEADING_RE.exec(line);
      if (h) {
        const tag = h[1].length <= 2 ? 'h3' : h[1].length === 3 ? 'h4' : 'h5';
        out += `<${tag}>${inline(h[2], depth)}</${tag}>`;
        i++;
        continue;
      }

      if (RULE_RE.test(line)) { out += '<hr>'; i++; continue; }

      if (QUOTE_RE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) body.push(QUOTE_RE.exec(lines[i++])[1]);
        out += `<blockquote>${blocks(body, depth + 1)}</blockquote>`;
        continue;
      }

      const item = ITEM_RE.exec(line);
      if (item) {
        const indent = item[1].length;
        const ordered = /\d/.test(item[2]);
        const items = [];
        while (i < lines.length) {
          const m = ITEM_RE.exec(lines[i]);
          if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
            items.push([m[3]]);
            i++;
            continue;
          }
          // Continuation: deeper-indented lines (nested lists, wrapped text),
          // or a blank line followed by more of the same list.
          if (items.length && !isBlank(lines[i]) && (lines[i].match(/^ */)[0].length > indent)) { items[items.length - 1].push(lines[i].slice(Math.min(lines[i].match(/^ */)[0].length, indent + 4))); i++; continue; }
          if (isBlank(lines[i]) && i + 1 < lines.length) {
            const nx = ITEM_RE.exec(lines[i + 1]);
            if ((nx && nx[1].length >= indent) || (lines[i + 1].match(/^ */)[0].length > indent && !isBlank(lines[i + 1]))) { i++; continue; }
          }
          break;
        }
        const start = ordered ? parseInt(item[2], 10) : 1;
        const tag = ordered ? 'ol' : 'ul';
        out += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`;
        for (const it of items) {
          const rest = it.slice(1);
          out += `<li>${inline(it[0], depth)}${rest.length ? blocks(rest, depth + 1) : ''}</li>`;
        }
        out += `</${tag}>`;
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('|')) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
        const td = (tag, v, k) => `<${tag}${align[k] ? ` class="${align[k]}"` : ''}>${inline(v, depth)}</${tag}>`;
        out += '<div class="tbl"><table><thead><tr>' + head.map((v, k) => td('th', v, k)).join('') + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + head.map((_, k) => td('td', r[k] ?? '', k)).join('') + '</tr>').join('')
          + '</tbody></table></div>';
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) para.push(lines[i++]);
      out += `<p>${inline(para.join('\n'), depth)}</p>`;
    }
    return out;
  }

  function renderMarkdown(text) {
    let s = String(text ?? '');
    if (s.length > MAX_INPUT) s = s.slice(0, MAX_INPUT) + '\n\n[truncated]';
    return blocks(s.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), 0);
  }

  root.CockpitMarkdown = { renderMarkdown, safeHref, esc };
})(globalThis);
