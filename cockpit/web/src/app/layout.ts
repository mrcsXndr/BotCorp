import { createContext, useContext, useSyncExternalStore } from 'react';

// The desktop layout (a 256px sidebar) starts at 900px; below it the phone
// layout (a bottom bar). Rendered by JS, not hidden by CSS, so each control
// exists once in the page.
const WIDE = '(min-width: 900px)';
const subscribe = (fn: () => void) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
};
export const useWide = () => useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false);

// The two main actions open their sheet from anywhere (the sidebar, the phone Bots screen).
export type NewKind = 'chat' | 'bot';
export const NewSheetContext = createContext<(kind: NewKind) => void>(() => {});
export const useOpenNew = () => useContext(NewSheetContext);
