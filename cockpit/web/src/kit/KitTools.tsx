import { useMemo, useState } from 'react';
import { AnimatedItems, ListItem, Segment, Segmented, Select, SelectItem, Switch, Tab, TabList, TabPanel, Tabs, TextField, toast } from '../ui';
import { Icon } from '../icons';
import { KitScreen, ScreenTitle } from './Kit';
import { BOTS, TOOL_GROUPS, type Tool } from './fixtures';

type Filter = 'all' | 'harness' | 'own' | 'third';

function ToolRow({ t, onToggle, queued }: { t: Tool; onToggle: (on: boolean) => void; queued: boolean }) {
  const body = (
    <span className="block">
      <span className="flex items-baseline gap-2">
        <span className="text-ui font-semibold text-text">{t.name}</span>
        <span className="text-sm text-text-3">{t.kind}</span>
      </span>
      <span className="block text-sm leading-ui text-text-2">{t.purpose}</span>
      {t.lock && <span className="mt-1 flex items-center gap-1.5 text-sm text-text-2"><Icon name="lock" size={14} />{t.lock}</span>}
      {t.missing && <span className="mt-1 flex items-center gap-1.5 text-sm text-warn"><Icon name="warn" size={14} />Missing on disk</span>}
      {queued && <span className="mt-1 flex items-center gap-1.5 text-sm text-warn"><Icon name="apr" size={14} />Queued for your approval, in the Inbox</span>}
    </span>
  );
  if (t.lock) return <div className="py-3" data-locked>{body}</div>;
  return (
    <Switch className="py-2" defaultSelected={t.enabled} isDisabled={queued} onChange={onToggle} aria-label={`${t.name} enabled`}>
      {body}
    </Switch>
  );
}

// Settings → Tools fixture (the ToolsPanel): three groups, a filter and a
// search; a switch per tool, a lock and its reason instead of a switch for a
// guard, and a toggle that widens the bot queues an approval inline.
function ToolsPanel() {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const groups = useMemo(() => TOOL_GROUPS
    .filter((g) => filter === 'all' || g.id === filter)
    .map((g) => ({ ...g, tools: g.tools.filter((t) => `${t.name} ${t.purpose}`.toLowerCase().includes(q.trim().toLowerCase())) }))
    .filter((g) => g.tools.length > 0), [filter, q]);
  const toggle = (t: Tool, on: boolean) => {
    if (t.approval) { setQueued((s) => new Set(s).add(t.name)); return; }
    toast(`${t.name} ${on ? 'on' : 'off'}: applies at the next roll`, 'ok');
  };
  return (
    <div className="flex flex-col gap-3">
      <Segmented aria-label="Show" value={filter} onChange={(k) => setFilter(k as Filter)} className="w-full">
        <Segment id="all">All</Segment><Segment id="harness">Harness</Segment><Segment id="own">Own</Segment><Segment id="third">Third</Segment>
      </Segmented>
      <TextField aria-label="Search tools" placeholder="Search tools" value={q} onChange={setQ} type="search" />
      {groups.length === 0 && <p className="m-0 py-6 text-body text-text-2">No tool matches "{q}".</p>}
      {groups.map((g) => (
        <section key={g.id} className="mt-2">
          <h3 className="m-0 flex items-baseline gap-2 text-sm">
            <span className="font-semibold text-text">{g.title}</span>
            <span className="text-text-3">{g.license}</span>
            <span className="num ml-auto text-text-3">{g.tools.length}</span>
          </h3>
          <ul className="m-0 p-0 list-none">
            <AnimatedItems>
              {g.tools.map((t) => (
                <ListItem key={t.name}><ToolRow t={t} queued={queued.has(t.name)} onToggle={(on) => toggle(t, on)} /></ListItem>
              ))}
            </AnimatedItems>
          </ul>
        </section>
      ))}
    </div>
  );
}

const TABS = ['Settings', 'Telegram', 'Secrets', 'Automations', 'Tools'] as const;

export function KitTools() {
  const [bot, setBot] = useState('atlas');
  return (
    <KitScreen nav="/_kit/tools" header={<ScreenTitle>Settings</ScreenTitle>}>
      <div className="px-4">
        <Select label="Bot" selectedKey={bot} onSelectionChange={(k) => setBot(String(k))} items={BOTS.map((b) => ({ id: b.name }))}>
          {(b) => <SelectItem id={b.id}>{b.id}</SelectItem>}
        </Select>
        <Tabs defaultSelectedKey="Tools" className="mt-4">
          <TabList aria-label={`Manage ${bot}`} className="-mx-4 px-2">
            {TABS.map((t) => <Tab key={t} id={t}>{t}</Tab>)}
          </TabList>
          {TABS.map((t) => (
            <TabPanel key={t} id={t} className="pb-6">
              {t === 'Tools' ? <ToolsPanel /> : <p className="m-0 py-4 text-body text-text-2">{t} for {bot}: its fixture lands with the screen (plan step 17).</p>}
            </TabPanel>
          ))}
        </Tabs>
      </div>
    </KitScreen>
  );
}
