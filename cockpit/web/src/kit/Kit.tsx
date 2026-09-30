import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useSearchParams } from 'react-router';
import { m } from 'motion/react';
import { NavIcon, type NavIconName } from '../icons';

// The design kit (plan step 12): every primitive, the display-face
// candidates, and fixture versions of the main screens, rendered before the
// real screens are built. Fixture data only; nothing here calls the API.
//
// `?face=karrik|apfel|ortica` and `?theme=light|dark|auto` on any kit route
// set the face and theme, so a screenshot run needs no clicks.

export const FACES = [
  { id: 'karrik', name: 'Karrik', note: 'A grotesk with notched joins: technical and a little strange.' },
  { id: 'apfel', name: 'Apfel Grotezk', note: 'A soft, slightly odd grotesk: friendly without going round. The calmest of the three.' },
  { id: 'ortica', name: 'Ortica Linear', note: 'A sharp, linear serif: quiet authority, the most editorial voice.' },
] as const;
export type FaceId = (typeof FACES)[number]['id'];

const FACE_KEY = 'cockpit.kit.face';
type ThemeApi = { get(): string; set(t: string): void };
const themeApi = () => (globalThis as { CockpitTheme?: ThemeApi }).CockpitTheme;

function readFace(): FaceId {
  try { const f = localStorage.getItem(FACE_KEY); if (FACES.some((x) => x.id === f)) return f as FaceId; } catch { /* storage blocked */ }
  return 'karrik';
}

export function applyFace(face: FaceId) {
  if (face === 'karrik') delete document.documentElement.dataset.face;
  else document.documentElement.dataset.face = face;
  try { localStorage.setItem(FACE_KEY, face); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event('kit-face'));
}

export function useFace(): [FaceId, (f: FaceId) => void] {
  const [face, setFace] = useState<FaceId>(readFace);
  useEffect(() => {
    const on = () => setFace(readFace());
    window.addEventListener('kit-face', on);
    return () => window.removeEventListener('kit-face', on);
  }, []);
  return [face, applyFace];
}

export function Kit() {
  const [params] = useSearchParams();
  const qFace = params.get('face');
  const qTheme = params.get('theme');
  useEffect(() => {
    applyFace(FACES.some((x) => x.id === qFace) ? (qFace as FaceId) : readFace());
  }, [qFace]);
  useEffect(() => {
    if (qTheme === 'light' || qTheme === 'dark' || qTheme === 'auto') themeApi()?.set(qTheme);
  }, [qTheme]);
  return <Outlet />;
}

const KIT_LINKS = [
  ['', 'Primitives'], ['faces', 'Faces'], ['bots', 'Bots'], ['chat', 'Chat'], ['inbox', 'Inbox'], ['updates', 'Updates'], ['tools', 'Tools'],
] as const;

/** The kit's own header (primitives, faces): a title and a row of kit links. */
export function KitHeader({ title }: { title: string }) {
  return (
    <header className="sticky top-0 z-10 bg-bg pt-[max(12px,env(safe-area-inset-top))]">
      <div className="px-4 pb-1">
        <h1 className="m-0 font-display text-2xl leading-tight text-text">{title}</h1>
        <p className="m-0 mt-1 text-sm text-text-2">Design kit · fixture data, no API calls</p>
      </div>
      <nav aria-label="kit" className="flex flex-wrap gap-x-1 px-2 mt-1 shadow-[0_1px_0_var(--line)]">
        {KIT_LINKS.map(([to, label]) => (
          <NavLink key={to} to={`/_kit${to ? `/${to}` : ''}`} end
            className={({ isActive }) => `relative flex-none inline-flex items-center min-h-[var(--tap)] px-3 text-ui no-underline outline-none
              focus-visible:outline-2 focus-visible:outline-accent ${isActive ? 'text-text font-semibold' : 'text-text-2'}`}>
            {({ isActive }) => (
              <>
                {label}
                {isActive && <m.span layoutId="kit-link-ind" className="absolute left-2 right-2 bottom-0 h-[3px] rounded-[2px] bg-accent" />}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

const NAV: { to: string; label: string; icon: NavIconName; count?: number }[] = [
  { to: '/_kit/bots', label: 'Bots', icon: 'bots' },
  { to: '/_kit/inbox', label: 'Inbox', icon: 'inbox', count: 4 },
  { to: '/_kit', label: 'Accounts', icon: 'accounts' },
  { to: '/_kit/tools', label: 'Settings', icon: 'settings' },
];

/** The phone bottom bar as it will look (plan step 15), wired to the kit screens. */
export function KitNavBar({ current }: { current: string }) {
  return (
    <nav aria-label="cockpit"
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 bg-side pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_var(--line)]">
      {NAV.map((n) => {
        const on = n.to === current;
        return (
          <NavLink key={n.to} to={n.to} end aria-current={on ? 'page' : undefined}
            className={`relative flex flex-col items-center justify-center gap-0.5 h-[var(--nav-h)] no-underline outline-none
              transition-colors duration-[var(--t-fast)] ease-std active:bg-press focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent
              ${on ? 'text-text' : 'text-text-2'}`}>
            {on && <m.span layoutId="nav-ind" className="absolute top-0 left-1/2 -ml-5 w-10 h-[3px] rounded-b-[2px] bg-accent" />}
            <NavIcon name={n.icon} className={on ? 'text-accent' : ''} />
            <span className={`text-xs leading-none ${on ? 'font-semibold' : 'font-medium'}`}>
              {n.label}{n.count ? <span className="num text-warn font-semibold"> {n.count}</span> : null}
            </span>
          </NavLink>
        );
      })}
    </nav>
  );
}

/** A fixture screen: its header, then the scrolling body, clear of the bottom bar. */
export function KitScreen({ nav, header, children }: { nav?: string; header?: ReactNode; children: ReactNode }) {
  return (
    <div className={`min-h-dvh flex flex-col ${nav ? 'pb-[calc(var(--nav-h)+env(safe-area-inset-bottom))]' : ''}`}>
      {header}
      <main className="flex-1 min-w-0">{children}</main>
      {nav && <KitNavBar current={nav} />}
    </div>
  );
}

/** A screen title in the display face, with an optional mono count and a right-hand slot. */
export function ScreenTitle({ children, count, right }: { children: ReactNode; count?: number; right?: ReactNode }) {
  return (
    <header className="flex items-center gap-3 px-4 pt-[max(20px,env(safe-area-inset-top))] pb-3">
      <h1 className="m-0 flex-1 min-w-0 font-display text-2xl leading-tight text-text">
        {children}{count != null && <span className="num ml-2 align-[3px] text-lg text-text-3 font-normal">{count}</span>}
      </h1>
      {right}
    </header>
  );
}
