import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Tabs as RACTabs, TabList as RACTabList, Tab as RACTab, TabPanel as RACTabPanel, SelectionIndicator,
  type TabsProps, type TabListProps, type TabProps, type TabPanelProps,
} from 'react-aria-components';

// A tab row whose selected tab carries a short accent bar (round caps) that
// slides to the next tab. Tighter on a phone, so five one-word tabs fit at
// 390px; a longer row scrolls sideways, never wraps.
export function Tabs({ className = '', ...rest }: Omit<TabsProps, 'className'> & { className?: string }) {
  return <RACTabs {...rest} className={`flex flex-col ${className}`} />;
}

// A row wider than the screen fades out over 40px on the side that has more,
// so the last tab reads as "scroll for more", never as sliced by the edge.
// A side with nothing past it has no fade.
const FADE = '40px';
export function TabList<T extends object>({ className = '', ...rest }: Omit<TabListProps<T>, 'className'> & { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setEdge({ start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', read); ro?.disconnect(); };
  }, []);
  return (
    <RACTabList {...rest} ref={ref}
      style={{ '--fade-s': edge.start ? FADE : '0px', '--fade-e': edge.end ? FADE : '0px' } as CSSProperties}
      className={`relative flex sm:gap-1 overflow-x-auto [scrollbar-width:none] border-b border-line
        [mask-image:linear-gradient(to_right,transparent,black_var(--fade-s),black_calc(100%-var(--fade-e)),transparent)] ${className}`} />
  );
}

// The row scrolls sideways, so the selected tab is scrolled into view: a
// deep link to the sixth tab must not open with its tab off-screen.
function KeepInView({ isSelected }: { isSelected: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // only the row scrolls, sideways: scrollIntoView would also scroll the page to the tabs
    const tab = ref.current?.closest<HTMLElement>('[role=tab]');
    const row = tab?.parentElement;
    if (!isSelected || !tab || !row) return;
    const left = tab.offsetLeft;   // the row is position: relative, so this is row-relative
    if (left < row.scrollLeft) row.scrollLeft = left - 8;
    else if (left + tab.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left + tab.offsetWidth - row.clientWidth + 8;
  }, [isSelected]);
  return <span ref={ref} hidden />;
}

export function Tab({ className = '', children, ...rest }: Omit<TabProps, 'className'> & { className?: string }) {
  return (
    <RACTab {...rest}
      className={`group relative flex-none inline-flex items-center gap-2 min-h-[var(--tap)] px-2 sm:px-3 text-ui text-text-2 cursor-default outline-none
        transition-colors duration-[var(--t-fast)] ease-std data-[hovered]:text-text data-[selected]:text-text data-[selected]:font-semibold
        data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent data-[focus-visible]:-outline-offset-2 ${className}`}>
      {(rp) => (
        <>
          {typeof children === 'function' ? children(rp) : children}
          <KeepInView isSelected={rp.isSelected} />
          <SelectionIndicator className="sel-ind absolute left-2 right-2 -bottom-px h-[3px] rounded-[2px] bg-accent" />
        </>
      )}
    </RACTab>
  );
}

export function TabPanel({ className = '', ...rest }: Omit<TabPanelProps, 'className'> & { className?: string }) {
  return <RACTabPanel {...rest} className={`pt-4 outline-none ${className}`} />;
}
