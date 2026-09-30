import { NavLink, useLocation } from 'react-router';
import { m } from 'motion/react';
import { NavIcon, type NavIconName } from '../icons';
import { useAttention } from '../api/queries';
import { COPY } from '../lib/copy';

type Place = { to: string; label: string; icon: NavIconName; count?: boolean };
const PLACES: Place[] = [
  { to: '/inbox', label: COPY.nav.inbox, icon: 'inbox', count: true },
  { to: '/accounts', label: COPY.nav.accounts, icon: 'accounts' },
  { to: '/settings', label: COPY.nav.settings, icon: 'settings' },
];
const TABS: Place[] = [{ to: '/', label: COPY.nav.bots, icon: 'bots' }, ...PLACES];

// Bots is the current tab on the list and on any bot; every other tab on its own path.
const isOn = (to: string, path: string) => (to === '/' ? path === '/' || path.startsWith('/bots/') : path === to || path.startsWith(`${to}/`));

/** The phone's bottom bar: four tabs, the Inbox with its mono count. */
export function NavBar() {
  const { pathname } = useLocation();
  const n = useAttention().data?.count ?? 0;
  return (
    <nav aria-label={COPY.row.cockpitNav}
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 bg-side pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_var(--line)]">
      {TABS.map((p) => {
        const on = isOn(p.to, pathname);
        return (
          <NavLink key={p.to} to={p.to} aria-current={on ? 'page' : undefined}
            className={`relative flex flex-col items-center justify-center gap-0.5 h-[var(--nav-h)] no-underline outline-none
              transition-colors duration-[var(--t-fast)] ease-std active:bg-press focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent
              ${on ? 'text-text' : 'text-text-2'}`}>
            {on && <m.span layoutId="nav-ind" className="absolute top-0 left-1/2 -ml-5 w-10 h-[3px] rounded-b-[2px] bg-accent" />}
            <NavIcon name={p.icon} className={on ? 'text-accent' : ''} />
            <span className={`text-xs leading-none ${on ? 'font-semibold' : 'font-medium'}`}>
              {p.label}{p.count && n > 0 ? <span className="num text-warn font-semibold"> {n}</span> : null}
            </span>
          </NavLink>
        );
      })}
    </nav>
  );
}

/** The sidebar's places (Inbox, Accounts, Settings): the Bots list is the sidebar itself. */
export function Places() {
  const { pathname } = useLocation();
  const n = useAttention().data?.count ?? 0;
  return (
    <nav aria-label={COPY.row.cockpitNav} className="flex flex-col">
      {PLACES.map((p) => {
        const on = isOn(p.to, pathname);
        return (
          <NavLink key={p.to} to={p.to} aria-current={on ? 'page' : undefined}
            className={`flex items-center gap-3 min-h-[var(--tap)] px-3 rounded-btn no-underline outline-none
              transition-colors duration-[var(--t-fast)] ease-std hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:outline-accent
              ${on ? 'bg-hover text-text font-semibold' : 'text-text-2'}`}>
            <NavIcon name={p.icon} size={20} className={on ? 'text-accent' : ''} />
            <span className="flex-1 text-ui">{p.label}</span>
            {p.count && n > 0 && <span className="num text-ui font-semibold text-warn">{n}</span>}
          </NavLink>
        );
      })}
    </nav>
  );
}
