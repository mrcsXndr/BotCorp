// The house icon set, ported from the <symbol>s in cockpit/public/index.html.
// 16px grid, 1.5 stroke in currentColor, round caps and joins, and where a mark
// has a body, exactly one solid part (a pivot, a base, a half) as its detail.
// The 24px nav marks are drawn the same way on a 24 grid. No icon pack.
import type { ReactNode, SVGProps } from 'react';

const S = 'solid';

const ICONS16 = {
  apr: <><path d="M6.4 2.5h3.2v3l1.6 2.3H4.8l1.6-2.3z" /><path className={S} d="M2.5 9.3h11v2.6h-11z" /><path d="M4 14h8" /></>,
  use: <><path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" /><path d="M8 11.5l2.7-3.6" /><circle className={S} cx="8" cy="11.5" r="1.4" /></>,
  acct: <><path d="M2.5 3.8h11v8.4h-11z" /><circle className={S} cx="5.9" cy="7.4" r="1.5" /><path d="M4.1 10.3h3.6M9.4 6.7h2.6M9.4 9.3h2.6" /></>,
  upd: <><path d="M8 2.5v6.8" /><path d="M5.2 6.6L8 9.4l2.8-2.8" /><path className={S} d="M2.5 11h11v2.5h-11z" /></>,
  new: <><path d="M2.5 3h11v7.3H8.2L5 12.8v-2.5H2.5z" /><path d="M8 4.9v3.5M6.25 6.65h3.5" /></>,
  guide: <><path d="M8 4.3C6.6 3.3 4.6 2.9 2.5 2.9v8.8c2.1 0 4.1.4 5.5 1.4 1.4-1 3.4-1.4 5.5-1.4V2.9c-2.1 0-4.1.4-5.5 1.4z" /><path className={S} d="M7.3 4.3h1.4v8.8H7.3z" /></>,
  theme: <><circle cx="8" cy="8" r="5.5" /><path className={S} d="M8 2.5a5.5 5.5 0 0 1 0 11z" /></>,
  down: <><path d="M8 2.8v9.4" /><path d="M3.9 8.3L8 12.4l4.1-4.1" /></>,
  clip: <path d="M10.6 5.2v5.6a2.6 2.6 0 0 1-5.2 0V4.3a1.7 1.7 0 0 1 3.4 0v6.3a.8.8 0 0 1-1.6 0V5.4" />,
  board: <><path d="M3 2.5h10v11H3z" /><path className={S} d="M5 5h2.4v2.4H5z" /><path d="M9.2 6.2h1.8M5 10.6h6" /></>,
  set: <><path d="M2.5 4.5h11M2.5 11.5h11" /><path className={S} d="M9 3h2.4v3H9zM4.6 10h2.4v3H4.6z" /></>,
  tg: <><path d="M13.8 2.4L2 7.1l4 1.5 1.5 4.5 2.2-2.8 3.3 2.4z" /><path className={S} d="M6 8.6l7.8-6.2-5.1 7.3z" /></>,
  // added for the web UI, same construction
  x: <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />,
  chev: <path d="M4.3 6.2L8 9.9l3.7-3.7" />,
  check: <path d="M3.4 8.4l3 3 6.2-6.4" />,
  lock: <><path d="M5.3 7.3V5.4a2.7 2.7 0 0 1 5.4 0v1.9" /><path className={S} d="M3.5 7.3h9v6.2h-9z" /></>,
  warn: <><path d="M8 2.6l5.8 10.4H2.2z" /><path d="M8 6.4v2.8" /><path className={S} d="M7.25 10.4h1.5v1.5h-1.5z" /></>,
  more: <path className={S} d="M2.6 7h2.1v2.1H2.6zM6.95 7h2.1v2.1h-2.1zM11.3 7h2.1v2.1h-2.1z" />,
  send: <><path d="M8 13.2V3.4" /><path d="M4 7.4l4-4 4 4" /></>,
  search: <><circle cx="7" cy="7" r="4.3" /><path d="M10.3 10.3l3.2 3.2" /></>,
  chat: <><path d="M2.5 3h11v7.6H7.4L4.6 13v-2.4H2.5z" /><path className={S} d="M5 5.9h6v1.5H5z" /></>,
  term: <><path d="M2.5 3.2h11v9.6h-11z" /><path d="M5 6.4l2 1.6-2 1.6" /><path className={S} d="M8.4 9.1h2.8v1.4H8.4z" /></>,
  restart: <><path d="M12.9 8a4.9 4.9 0 1 1-1.5-3.5" /><path className={S} d="M13.3 2.4v3.9H9.4z" /></>,
  // the bot screen and the main actions (v0.9.0 steps 15-16)
  cog: <><path d="M12.52 6.7L14.17 6.75L14.17 9.25L12.52 9.3L12.11 10.28L13.25 11.48L11.48 13.25L10.28 12.11L9.3 12.52L9.25 14.17L6.75 14.17L6.7 12.52L5.72 12.11L4.52 13.25L2.75 11.48L3.89 10.28L3.48 9.3L1.83 9.25L1.83 6.75L3.48 6.7L3.89 5.72L2.75 4.52L4.52 2.75L5.72 3.89L6.7 3.48L6.75 1.83L9.25 1.83L9.3 3.48L10.28 3.89L11.48 2.75L13.25 4.52L12.11 5.72z" /><circle className={S} cx="8" cy="8" r="1.9" /></>,
  play: <path className={S} d="M5 3.4l7.2 4.6L5 12.6z" />,
  stop: <path className={S} d="M4.4 4.4h7.2v7.2H4.4z" />,
  archive: <><path className={S} d="M2.5 3h11v3h-11z" /><path d="M3.5 6v7h9V6M6.4 8.8h3.2" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 4.9V8l2.2 1.5" /><circle className={S} cx="8" cy="8" r=".9" /></>,
  tool: <path d="M10.8 2.8a2.9 2.9 0 0 0-3.4 3.9l-4.5 4.5 1.9 1.9 4.5-4.5a2.9 2.9 0 0 0 3.9-3.4l-1.8 1.8-1.7-.4-.4-1.7z" />,
  plus: <path d="M8 3.4v9.2M3.4 8h9.2" />,
  tray: <><path d="M2.5 8.6l1.7-5.1h7.6l1.7 5.1" /><path className={S} d="M2.5 8.6h3.4l.8 1.6h2.6l.8-1.6h3.4v4.4h-11z" /></>,
  newbot: <><path className={S} d="M2.6 3.2l2.5.5v8.6l-2.5.5z" /><path d="M11 4.6v6.8M7.6 8h6.8" /></>,
  // v0.9.9: knowledge docs, inline edits, subagents
  doc: <><path d="M3.8 2.5h5.4l3 3v8h-8.4z" /><path className={S} d="M9.2 2.5l3 3h-3z" /><path d="M6 8.4h4M6 11h4" /></>,
  pen: <><path d="M10.6 2.9l2.5 2.5-6.6 6.6-2.5-2.5z" /><path className={S} d="M4 9.5l2.5 2.5-3.3.8z" /></>,
  agent: <><path d="M3 2.5h3.4v3.4H3z" /><path d="M4.7 5.9v4.3h3.6" /><path className={S} d="M8.3 8.2h5v4h-5z" /></>,
} satisfies Record<string, ReactNode>;

// The five nav marks. "bots" is the bot list itself: three rows, the top one
// carrying the solid part.
const ICONS24 = {
  bots: <><path className={S} d="M3.5 4.6l2.6.5v3.8l-2.6.5z" /><path d="M3.5 10.1l2.6.5v2.8l-2.6.5zM3.5 15.1l2.6.5v2.8l-2.6.5z" /><path d="M9.5 7h11M9.5 12h11M9.5 17h7.5" /></>,
  inbox: <><path d="M3.5 13.5l2.4-8h12.2l2.4 8" /><path d="M3.5 13.5h5.2l1.4 2.4h3.8l1.4-2.4h5.2" /><path className={S} d="M3.5 16.6h17v3h-17z" /></>,
  usage: <><path d="M3.8 16.8a8.2 8.2 0 1 1 16.4 0" /><path d="M12 16.8l4.2-5.4" /><circle className={S} cx="12" cy="16.8" r="2.1" /></>,
  updates: <><path d="M12 3.5v10.2" /><path d="M7.8 9.6l4.2 4.2 4.2-4.2" /><path className={S} d="M3.8 16.6h16.4v3.4H3.8z" /></>,
  settings: <><path d="M3.5 7h17M3.5 17h17" /><path className={S} d="M13.6 4.8h3.6v4.4h-3.6zM6.8 14.8h3.6v4.4H6.8z" /></>,
  accounts: <><path d="M3.5 5.5h17v13h-17z" /><circle className={S} cx="8.6" cy="10.4" r="2.2" /><path d="M5.8 15.4h5.6M13.6 10h4.4M13.6 13.4h4.4" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS16;
export type NavIconName = keyof typeof ICONS24;
export const ICON_NAMES = Object.keys(ICONS16) as IconName[];
export const NAV_ICON_NAMES = Object.keys(ICONS24) as NavIconName[];

type Props = Omit<SVGProps<SVGSVGElement>, 'name'> & { size?: number; label?: string };

/** A 16px house icon. Decorative unless `label` is given. */
export function Icon({ name, size = 16, label, className = '', ...rest }: Props & { name: IconName }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={`ic ${className}`}
      aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} {...rest}>
      {ICONS16[name]}
    </svg>
  );
}

/** A 24px nav mark (the bottom bar and the rail). Always decorative: the tab carries the label. */
export function NavIcon({ name, size = 24, className = '', ...rest }: Props & { name: NavIconName }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`ic ${className}`} aria-hidden {...rest}>
      {ICONS24[name]}
    </svg>
  );
}
