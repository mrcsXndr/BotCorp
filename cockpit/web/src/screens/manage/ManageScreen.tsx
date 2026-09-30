import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useBots } from '../../api/queries';
import { EmptyState, SkeletonRow, Tab, TabList, TabPanel, Tabs } from '../../ui';
import { Icon } from '../../icons';
import { COPY } from '../../lib/copy';
import { useWide } from '../../app/layout';
import { SettingsTab } from './SettingsTab';
import { TelegramTab } from './TelegramTab';
import { SecretsTab } from './SecretsTab';
import { AutomationsTab } from './AutomationsTab';
import { ToolsTab } from './ToolsTab';
import { KnowledgeTab } from './KnowledgeTab';

export const MANAGE_TABS = ['settings', 'telegram', 'secrets', 'automations', 'tools', 'knowledge'] as const;
type ManageTab = (typeof MANAGE_TABS)[number];

// `#/bots/:name/manage/:tab`: one bot's Settings, Telegram, Secrets,
// Automations, Tools and Knowledge. Its own tabs, so a link lands on the right
// one and the address says which. Wider on a desktop (the docs editor).
export function ManageScreen() {
  const { name = '', tab = 'settings' } = useParams();
  const nav = useNavigate();
  const wide = useWide();
  const bots = useBots();
  const bot = bots.data?.find((b) => b.name === name);
  if (!(MANAGE_TABS as readonly string[]).includes(tab)) return <Navigate to={`/bots/${encodeURIComponent(name)}/manage/settings`} replace />;
  if (!bots.data) return <div className="pt-6"><SkeletonRow /><SkeletonRow /></div>;
  if (!bot) return <EmptyState className="min-h-[60dvh]">{COPY.empty.noBot}</EmptyState>;
  return (
    <div className={`mx-auto w-full ${wide ? 'max-w-[960px]' : 'max-w-[720px]'} px-4 pb-6`}>
      <header className="flex items-center gap-1 pt-[max(8px,env(safe-area-inset-top))] -mx-3">
        <Link to={`/bots/${encodeURIComponent(bot.name)}`} aria-label={COPY.button.back}
          className="grid place-items-center size-[var(--tap)] flex-none rounded-btn text-text-2 outline-none hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:outline-accent">
          <Icon name="chev" size={18} className="rotate-90" />
        </Link>
        <h1 className="m-0 flex-1 min-w-0 truncate font-display text-xl leading-tight text-text">{bot.name}</h1>
      </header>
      <Tabs selectedKey={tab} onSelectionChange={(k) => nav(`/bots/${encodeURIComponent(bot.name)}/manage/${String(k)}`, { replace: true })}>
        <TabList aria-label={`${COPY.row.bot} ${bot.name}`} className={wide ? '-mx-3' : '-mx-4 px-2'}>
          {MANAGE_TABS.map((k: ManageTab) => <Tab key={k} id={k}>{COPY.tab[k]}</Tab>)}
        </TabList>
        <TabPanel id="settings"><SettingsTab bot={bot} /></TabPanel>
        <TabPanel id="telegram"><TelegramTab bot={bot} /></TabPanel>
        <TabPanel id="secrets"><SecretsTab bot={bot} /></TabPanel>
        <TabPanel id="automations"><AutomationsTab bot={bot} /></TabPanel>
        <TabPanel id="tools"><ToolsTab bot={bot} /></TabPanel>
        <TabPanel id="knowledge"><KnowledgeTab bot={bot} /></TabPanel>
      </Tabs>
    </div>
  );
}
