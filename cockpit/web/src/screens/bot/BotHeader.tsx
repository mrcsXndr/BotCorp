import { Link } from 'react-router';
import type { Key } from 'react-aria-components';
import type { Bot, StatusPush } from '../../api/queries';
import { useAccounts, useLaunching } from '../../api/queries';
import { Button, Hint, IconButton, Menu, MenuItem, MenuSeparator, Segment, Segmented, Dot } from '../../ui';
import { Icon } from '../../icons';
import { contextBar, lifecycleButtons, type ContextReading } from '../../lib/cards';
import { accountLabel, botStatus, isPinned } from '../../lib/bots';
import { COPY } from '../../lib/copy';
import { useWide } from '../../app/layout';

const TONE_TEXT = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', idle: 'text-text-3', accent: 'text-accent' } as const;
const LEVEL_TEXT = { '': 'text-text', warn: 'text-warn', bad: 'text-bad' } as const;

export type BotAction = 'settings' | 'telegram' | 'secrets' | 'automations' | 'tools' | 'history' | 'restart' | 'fresh' | 'stop' | 'archive';
export type View = 'chat' | 'term';

// The bot header (IA §7): the name, the state word, Chat | Terminal and the
// cog. Start is the one lifecycle button in the open, and only while the bot
// is stopped; everything else is in the cog menu. Readouts: Context and the
// account name, nothing engine-specific.
export function BotHeader({ bot, status, view, onView, onAction, onStart, starting }: {
  bot: Bot; status: StatusPush | null; view: View; onView: (v: View) => void;
  onAction: (a: BotAction) => void; onStart: () => void; starting: boolean;
}) {
  const wide = useWide();
  const launching = useLaunching().has(bot.name);
  const s = botStatus(bot, launching);
  const lc = lifecycleButtons(bot);
  const accounts = useAccounts().data?.accounts;
  const ctx = contextBar(status?.context as ContextReading | undefined);
  const account = accountLabel(status?.account as { tokenLast4?: string; na?: string } | undefined, accounts, bot.account);
  const chat = !isPinned(bot);
  return (
    <header className="flex-none bg-bg pt-[max(8px,env(safe-area-inset-top))] shadow-[0_1px_0_var(--line)]">
     <div className="w-full">
      <div className={`flex items-center gap-1 ${wide ? 'pl-4 pr-2 pt-2' : 'pl-1 pr-1'}`}>
        {!wide && (
          <Link to="/" aria-label={COPY.button.back}
            className="grid place-items-center size-[var(--tap)] flex-none rounded-btn text-text-2 outline-none hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:outline-accent">
            <Icon name="chev" size={18} className="rotate-90" />
          </Link>
        )}
        <h1 className={`m-0 ${wide ? '' : 'ml-1'} flex-1 min-w-0 truncate font-display text-xl leading-tight text-text`}>{bot.name}</h1>
        {lc.start && (
          <Button variant="primary" icon="play" onPress={onStart} isDisabled={starting || launching} className="mr-1">{COPY.button.start}</Button>
        )}
        <Menu label={COPY.button.botMenu} trigger={<IconButton icon="cog" size={20} label={COPY.button.botMenu} />} onAction={(k: Key) => onAction(k as BotAction)}>
          <MenuItem id="settings" icon="set">{COPY.tab.settings}</MenuItem>
          <MenuSeparator />
          <MenuItem id="history" icon="board">{COPY.button.history}</MenuItem>
          <MenuSeparator />
          <MenuItem id="restart" icon="restart" tone="bad">{COPY.button.restart}</MenuItem>
          <MenuItem id="fresh" icon="restart" tone="bad">{COPY.button.restartFresh}</MenuItem>
          {lc.stop && <MenuItem id="stop" icon="stop" tone="bad">{COPY.button.stop}</MenuItem>}
          {chat && <MenuItem id="archive" icon="archive" tone="bad">{COPY.button.archive}</MenuItem>}
        </Menu>
      </div>
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap px-4 pb-2 text-sm">
        <span className={`inline-flex items-center gap-1.5 font-semibold ${TONE_TEXT[s.tone]}`}><Dot tone={s.tone} />{s.word}</span>
        {bot.telegram && <Icon name="tg" size={13} label={COPY.row.telegramOn} className="text-text-2" />}
        {'pct' in ctx && (
          <span className="inline-flex items-center gap-1 text-text-2">
            {COPY.row.context} <span className={`tabular-nums ${LEVEL_TEXT[ctx.level]}`}>{ctx.pct}%</span>
            <Hint label={COPY.row.contextHint}>{COPY.tooltip.context}</Hint>
          </span>
        )}
        {account && <span className="text-text-2 truncate" aria-label={`${COPY.row.account}: ${account}`}>{account}</span>}
      </div>
      <div className="px-4 pb-3">
        <Segmented aria-label={COPY.row.view} value={view} onChange={(k) => onView(k as View)} className={wide ? 'w-72' : 'w-full'}>
          <Segment id="chat" icon="chat">{COPY.tab.chat}</Segment>
          <Segment id="term" icon="term">{COPY.tab.terminal}</Segment>
        </Segmented>
      </div>
     </div>
    </header>
  );
}
