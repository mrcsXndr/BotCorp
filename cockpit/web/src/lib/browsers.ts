// A paired browser as a person names it: "Chrome on Windows", from the
// user-agent the pairing recorded. Never the raw string.
import { COPY } from './copy';

export function deviceName(ua: unknown): string {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\/|CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux|X11/.test(s) ? 'Linux' : '';
  return browser && os ? `${browser} on ${os}` : browser || os || COPY.row.unknownBrowser;
}

// The copy-on-select preference lives in this browser only (the terminal reads the same key).
const KEY = 'cockpit.settings';
export function readCopyOnSelect(): boolean {
  try { return !!JSON.parse(localStorage.getItem(KEY) || '{}').copyOnSelect; } catch { return false; }
}
export function writeCopyOnSelect(on: boolean): void {
  try {
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...(cur && typeof cur === 'object' ? cur : {}), copyOnSelect: on }));
  } catch { /* storage may be unavailable: the switch just does not stick */ }
}
