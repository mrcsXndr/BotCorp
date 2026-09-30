import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useAttention, useBots } from '../api/queries';
import { Banner, Button, EmptyState, SkeletonRow } from '../ui';
import { attentionByBot, splitBots } from '../lib/bots';
import { COPY, t } from '../lib/copy';
import { NewSheetContext, useWide, type NewKind } from './layout';
import { VersionCard } from './VersionCard';
import { MainActions } from './MainActions';
import { BotSection } from './BotSection';
import { NavBar, Places } from './Nav';
import { NewSheets } from './NewSheets';
import { PairHost } from './PairSheet';

/** Pinned, then Chats (the first 10), from /api/bots and the Inbox counts. */
export function BotLists({ dense = false }: { dense?: boolean }) {
  const bots = useBots();
  const attention = attentionByBot(useAttention().data?.items as { bot?: unknown }[] | undefined);
  if (!bots.data) {
    if (bots.error) return <div className="px-3"><Banner tone="bad">{bots.error.message}</Banner></div>;
    return <div className="flex flex-col"><SkeletonRow /><SkeletonRow /></div>;
  }
  const { pinned, chats } = splitBots(bots.data);
  if (!pinned.length && !chats.length) {
    return <EmptyState action={<Link to="/help" className="text-ui font-semibold text-accent no-underline outline-none hover:underline focus-visible:outline-2 focus-visible:outline-accent">{COPY.title.help}</Link>}>{COPY.empty.noBots}</EmptyState>;
  }
  return (
    <>
      <BotSection id="pinned" title={COPY.row.pinned} bots={pinned} attention={attention} dense={dense} empty={COPY.empty.noBots} />
      <BotSection id="chats" title={COPY.row.chats} bots={chats} attention={attention} dense={dense} limit={10} empty={COPY.empty.noChats} />
    </>
  );
}

/** The one-line "N things need you" banner; Open goes to the Inbox. Nothing when it is empty. */
export function AttentionBanner({ className = '' }: { className?: string }) {
  const n = useAttention().data?.count ?? 0;
  const nav = useNavigate();
  if (!n) return null;
  return (
    <Banner tone="warn" className={className} action={<Button variant="quiet" onPress={() => nav('/inbox')}>{COPY.button.open}</Button>}>
      {n === 1 ? COPY.inbox.bannerOne : t(COPY.inbox.banner, { n })}
    </Banner>
  );
}

function Sidebar() {
  return (
    <aside className="relative h-dvh overflow-y-auto overscroll-contain bg-side flex flex-col gap-3 px-2 pt-3 pb-3">
      <VersionCard />
      <div className="px-1"><MainActions stacked /></div>
      <div className="flex flex-col gap-2">
        <BotLists dense />
      </div>
      <div className="mt-auto pt-2"><Places /></div>
    </aside>
  );
}

// Desktop (900px and up): the sidebar and the page. Phone: the page and the
// bottom bar, which gives way to a bot's composer on a bot screen.
export function Shell() {
  const wide = useWide();
  const { pathname } = useLocation();
  const onBot = /^\/bots\/[^/]+$/.test(pathname);
  const [sheet, setSheet] = useState<NewKind | null>(null);
  // the display face picked at the design gate (the kit may have switched it)
  useEffect(() => { document.documentElement.dataset.face = 'apfel'; }, []);
  // the shell owns the one scroll container; the page itself never scrolls
  useEffect(() => {
    document.documentElement.dataset.shell = 'app';
    return () => { delete document.documentElement.dataset.shell; };
  }, []);
  return (
    <NewSheetContext.Provider value={setSheet}>
      {wide ? (
        <div className="h-dvh grid grid-cols-[256px_minmax(0,1fr)]">
          <Sidebar />
          <main className="relative min-w-0 h-dvh overflow-y-auto overscroll-contain"><Outlet /></main>
        </div>
      ) : (
        <div className="h-dvh">
          <main className={`relative min-w-0 h-full overflow-y-auto overscroll-contain ${onBot ? '' : 'pb-[calc(var(--nav-h)+env(safe-area-inset-bottom))]'}`}><Outlet /></main>
          {!onBot && <NavBar />}
        </div>
      )}
      <NewSheets kind={sheet} onClose={() => setSheet(null)} />
      <PairHost />
    </NewSheetContext.Provider>
  );
}
