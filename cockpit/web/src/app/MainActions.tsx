import { Button } from '../ui';
import { COPY } from '../lib/copy';
import { useOpenNew } from './layout';

// The two main actions. New chat is the primary; New bot is the tonal one
// beside or under it (never the fill-and-outline pair).
export function MainActions({ stacked = false }: { stacked?: boolean }) {
  const open = useOpenNew();
  return (
    <div className={stacked ? 'flex flex-col gap-2' : 'flex gap-2'}>
      <Button data-main-action="chat" variant="primary" icon="new" className="flex-1" onPress={() => open('chat')}>{COPY.button.newChat}</Button>
      <Button data-main-action="bot" variant="tonal" icon="newbot" className="flex-1" onPress={() => open('bot')}>{COPY.button.newBot}</Button>
    </div>
  );
}
