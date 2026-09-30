import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { IconButton } from '../../ui';
import { COPY } from '../../lib/copy';
import { clipFiles } from './Composer';

export interface TermHandle {
  write(d: string): void;
  line(text: string): void;
  reset(): void;
  /** fit to the box; tell the session the size when it changed, or always with force */
  fit(force?: boolean): void;
}

// The key bar's keys and what each sends. ⇧Tab is the literal key (the
// engine's mode switch today), not a name for what it does.
const KEYS: [string, string, string][] = [
  ['Esc', '\x1b', 'Escape'], ['^C', '\x03', 'Control C'], ['^L', '\x0c', 'Control L'], ['⇧Tab', '\x1b[Z', 'Shift Tab'], ['Tab', '\t', 'Tab'], ['Enter', '\r', 'Enter'],
  ['←', '\x1b[D', 'Left'], ['↑', '\x1b[A', 'Up'], ['↓', '\x1b[B', 'Down'], ['→', '\x1b[C', 'Right'],
];

const bracketed = (text: string) => `\x1b[200~${text.replace(/\r\n?/g, '\n')}\x1b[201~`;
function copyOnSelect(): boolean {
  try { return !!JSON.parse(localStorage.getItem('cockpit.settings') || '{}').copyOnSelect; } catch { return false; }
}

// The live terminal (xterm, dark in both themes) and the key bar under it.
// It stays mounted while the chat view is shown, so no output is lost.
export const TerminalView = forwardRef<TermHandle, {
  visible: boolean; onInput: (d: string) => void; onResize: (cols: number, rows: number) => void; onFiles: (files: File[]) => void;
}>(function TerminalView({ visible, onInput, onResize, onFiles }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  const sent = useRef('');
  const cb = useRef({ onInput, onResize, onFiles });
  useEffect(() => { cb.current = { onInput, onResize, onFiles }; });

  const fit = (force = false) => {
    const t = term.current, f = fitter.current, el = host.current;
    if (!t || !f || !el || !el.offsetWidth || !el.offsetHeight) return;
    try { f.fit(); } catch { return; }
    const size = `${t.cols}x${t.rows}`;
    if (!force && size === sent.current) return;
    sent.current = size;
    cb.current.onResize(t.cols, t.rows);
  };

  useEffect(() => {
    const el = host.current!;
    const tok = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const t = new Terminal({
      fontFamily: tok('--face-mono'), fontSize: 13, cursorBlink: true, scrollback: 5000,
      theme: { background: tok('--term-bg'), foreground: tok('--term-fg'), cursor: tok('--term-cursor'), selectionBackground: tok('--term-selection') },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    t.open(el);
    term.current = t; fitter.current = f;
    t.onData((d) => cb.current.onInput(d));
    t.onSelectionChange(() => { const s = t.getSelection(); if (s && copyOnSelect()) navigator.clipboard?.writeText(s).catch(() => {}); });
    // files upload and paste as paths; multi-line text goes in as one bracketed paste
    const onPaste = (e: ClipboardEvent) => {
      const files = clipFiles(e.clipboardData);
      if (files.length) { e.preventDefault(); e.stopPropagation(); cb.current.onFiles(files); return; }
      const text = e.clipboardData?.getData('text') || '';
      if (text.includes('\n')) { e.preventDefault(); e.stopPropagation(); cb.current.onInput(bracketed(text)); }
    };
    el.addEventListener('paste', onPaste, true);
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fit()); });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); el.removeEventListener('paste', onPaste, true); t.dispose(); term.current = null; fitter.current = null; };
  }, []);

  useImperativeHandle(ref, () => ({
    write: (d) => term.current?.write(d),
    line: (text) => term.current?.writeln(`\x1b[90m${text}\x1b[0m`),
    reset: () => { term.current?.reset(); sent.current = ''; },
    fit,
  }), []);

  useEffect(() => { if (visible) requestAnimationFrame(() => { fit(); term.current?.focus(); }); }, [visible]);

  const files = useRef<HTMLInputElement>(null);
  const press = (seq: string) => { cb.current.onInput(seq); term.current?.focus(); };
  return (
    <div className={`flex-1 min-h-0 flex-col bg-term-bg ${visible ? 'flex' : 'hidden'}`}>
      <div ref={host} className="flex-1 min-h-0 overflow-hidden pl-2 pt-2" />
      <div role="toolbar" aria-label={COPY.row.keys}
        className="flex-none grid grid-cols-6 min-[900px]:grid-cols-11 gap-1 p-2 pb-[max(8px,env(safe-area-inset-bottom))] bg-bg">
        {KEYS.map(([k, seq, name]) => (
          <button key={k} type="button" aria-label={name} onClick={() => press(seq)}
            className="num min-h-[var(--tap)] rounded-btn bg-surface shadow-[inset_0_0_0_1px_var(--line-strong)] text-sm text-text outline-none
              transition-colors duration-[var(--t-fast)] ease-std hover:bg-task active:bg-press focus-visible:outline-2 focus-visible:outline-accent">{k}</button>
        ))}
        <IconButton icon="clip" label={COPY.button.attach} className="!w-full bg-surface shadow-[inset_0_0_0_1px_var(--line-strong)]" onPress={() => files.current?.click()} />
        <input ref={files} type="file" multiple hidden onChange={(e) => { cb.current.onFiles([...(e.target.files || [])]); e.target.value = ''; }} />
      </div>
    </div>
  );
});
