import { useState } from 'react';
import { NavLink } from 'react-router';
import { useLaunching, type Bot } from '../api/queries';
import { Button, Dot } from '../ui';
import { Icon } from '../icons';
import { botStatus } from '../lib/bots';
import { COPY, t } from '../lib/copy';

const TONE_TEXT = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', idle: 'text-text-3', accent: 'text-accent' } as const;

// One bot: the name is in the display face; the state is one coloured word
// with its dot; Telegram is a bare mark; the Inbox count is mono.
export function BotRow({ bot, attention = 0, dense = false }: { bot: Bot; attention?: number; dense?: boolean }) {
  const s = botStatus(bot, useLaunching().has(bot.name));
  return (
    <NavLink to={`/bots/${encodeURIComponent(bot.name)}`} data-bot={bot.name}
      className={({ isActive }) => `flex items-stretch gap-3 ${dense ? 'min-h-[52px] px-3 py-2 rounded-btn' : 'min-h-16 px-4 py-2.5'}
        no-underline text-text outline-none transition-colors duration-[var(--t-fast)] ease-std
        hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent
        ${isActive ? 'bg-accent-soft' : ''}`}>
      <span className="flex-1 min-w-0 flex flex-col justify-center">
        <span className="flex items-center gap-2 min-w-0">
          <span className={`font-display ${dense ? 'text-ui' : 'text-lg'} leading-tight truncate`}>{bot.name}</span>
          {bot.telegram && <Icon name="tg" size={13} label={COPY.row.telegramOn} className="flex-none text-text-3" />}
        </span>
        <span className={`inline-flex items-center gap-1.5 text-sm leading-ui font-semibold ${TONE_TEXT[s.tone]}`}><Dot tone={s.tone} />{s.word}</span>
      </span>
      {attention > 0 && (
        <span role="img" className="self-center inline-flex items-center gap-1 text-warn" aria-label={t(COPY.row.waiting, { n: attention })}>
          <Icon name="tray" size={14} /><span className="num text-ui font-semibold">{attention}</span>
        </span>
      )}
    </NavLink>
  );
}

// Pinned or Chats: a quiet heading with a mono count, then rows. `limit`
// shows the first N and a "Show all" under them.
export function BotSection({ id, title, bots, attention, limit, dense = false, empty }:
  { id: 'pinned' | 'chats'; title: string; bots: Bot[]; attention: Record<string, number>; limit?: number; dense?: boolean; empty: string }) {
  const [all, setAll] = useState(false);
  const shown = limit && !all ? bots.slice(0, limit) : bots;
  const head = `${id}-head`;
  return (
    <section data-section={id} aria-labelledby={head} className="flex flex-col">
      <h2 id={head} className={`m-0 flex items-baseline gap-2 ${dense ? 'px-3' : 'px-4'} pt-2 pb-1 text-sm font-semibold text-text-2`}>
        {title}{bots.length > 0 && <span className="num font-normal text-text-3">{bots.length}</span>}
      </h2>
      {bots.length ? (
        <ul className="m-0 p-0 list-none flex flex-col">
          {shown.map((b) => <li key={b.name}><BotRow bot={b} attention={attention[b.name] || 0} dense={dense} /></li>)}
        </ul>
      ) : (
        <p className={`m-0 ${dense ? 'px-3' : 'px-4'} py-2 text-sm text-text-3`}>{empty}</p>
      )}
      {limit != null && bots.length > limit && (
        <Button variant="quiet" className={`self-start ${dense ? 'ml-1' : 'ml-2'}`} onPress={() => setAll((v) => !v)}>
          {all ? COPY.button.showFewer : t(COPY.button.showAll, { n: bots.length })}
        </Button>
      )}
    </section>
  );
}
