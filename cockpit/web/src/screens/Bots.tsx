import { EmptyState } from '../ui';
import { COPY } from '../lib/copy';
import { useWide } from '../app/layout';
import { VersionCard } from '../app/VersionCard';
import { MainActions } from '../app/MainActions';
import { AttentionBanner, BotLists } from '../app/Shell';

// `#/`. Phone: the Bots screen (the version card as its header, the two main
// actions, the attention line, Pinned, Chats). Desktop: the sidebar already
// holds all of that, so the page asks for a bot.
export function BotsScreen() {
  const wide = useWide();
  if (wide) {
    return (
      <div className="min-h-full flex flex-col">
        <AttentionBanner className="mx-6 mt-6" />
        <EmptyState className="flex-1">{COPY.empty.pickBot}</EmptyState>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 pb-4">
      <header className="px-2 pt-[max(8px,env(safe-area-inset-top))]"><VersionCard /></header>
      <div className="px-4"><MainActions /></div>
      <AttentionBanner className="mx-4" />
      <BotLists />
    </div>
  );
}
