import { Link, useNavigate } from 'react-router';
import { Banner, Button, Dot, Menu, MenuItem } from '../ui';
import { Icon } from '../icons';
import { KitScreen, ScreenTitle } from './Kit';
import { BOTS } from './fixtures';

const STATE_TEXT = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', idle: 'text-text-3', accent: 'text-accent' } as const;

// Bot list fixture (the Bots tab): rows, not cards. The state word and its dot
// carry the state; the name is in the display face.
export function KitBots() {
  const nav = useNavigate();
  return (
    <KitScreen nav="/_kit/bots"
      header={<ScreenTitle right={<Menu label="More" onAction={() => nav('/_kit/chat')}><MenuItem id="new" icon="new">New chat</MenuItem></Menu>}>Bots</ScreenTitle>}>
      <div className="px-4 pb-2">
        <Banner tone="warn" action={<Button variant="quiet" onPress={() => nav('/_kit/inbox')}>Open</Button>}>
          <span className="num font-semibold">4</span> things need you
        </Banner>
      </div>
      <ul className="m-0 p-0 list-none py-1">
        {BOTS.map((b) => (
          <li key={b.name}>
            <Link to="/_kit/chat"
              className="flex items-stretch gap-3 min-h-[68px] px-4 py-2.5 no-underline text-text outline-none transition-colors duration-[var(--t-fast)] ease-std
                hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
              <span className="flex-1 min-w-0 flex flex-col justify-center">
                <span className="flex items-center gap-2">
                  <span className="font-display text-lg leading-tight truncate">{b.name}</span>
                  {b.tg && <Icon name="tg" size={14} label="Telegram on" className="text-text-3" />}
                </span>
                <span className="text-sm leading-ui truncate">
                  <span className={`inline-flex items-center gap-1.5 font-semibold ${STATE_TEXT[b.tone]}`}><Dot tone={b.tone} />{b.state}</span>
                  <span className="text-text-2"> · {b.detail}</span>
                </span>
              </span>
              {b.attention > 0 && (
                <span className="self-center num text-ui font-semibold text-warn" aria-label={`${b.attention} need you`}>{b.attention}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </KitScreen>
  );
}
