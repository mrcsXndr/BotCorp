import { useState, type ReactNode } from 'react';
import { DialogTrigger } from 'react-aria-components';
import {
  AnimatedItems, Banner, Button, Disclosure, IconButton, ListItem, Menu, MenuItem, MenuSeparator, Meter, Radio, RadioGroup,
  Segment, Segmented, Select, SelectItem, Sheet, Skeleton, SkeletonRow, Dot, Switch, Tab, TabList, TabPanel, Tabs, TextField, toast,
} from '../ui';
import { ICON_NAMES, Icon, NAV_ICON_NAMES, NavIcon } from '../icons';
import { KitHeader, KitScreen } from './Kit';

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="px-4 pt-7">
      <h2 className="m-0 text-lg font-semibold leading-tight text-text">{title}</h2>
      {note && <p className="m-0 mt-1 text-sm leading-ui text-text-2">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const SWATCHES = ['bg', 'side', 'surface', 'task', 'field', 'accent', 'accent-soft', 'ok', 'warn', 'warn-soft', 'bad', 'bad-soft', 'sent', 'text', 'text-2', 'text-3'];
const SIZES: [string, string][] = [['text-2xl font-display', '2xl 30 · display'], ['text-xl font-display', 'xl 24 · display'], ['text-lg font-semibold', 'lg 18'], ['text-body', 'body 16'], ['text-ui', 'ui 15'], ['text-sm', 'sm 14'], ['text-xs', 'xs 12.5']];

type ThemeApi = { get(): string; set(t: string): void };
const themeApi = () => (globalThis as { CockpitTheme?: ThemeApi }).CockpitTheme;

export function KitPrimitives() {
  const [view, setView] = useState('chat');
  const [theme, setTheme] = useState(() => themeApi()?.get() ?? 'auto');
  const [items, setItems] = useState(['standup', 'critic', 'review-artifact']);
  const [n, setN] = useState(1);
  const [loaded, setLoaded] = useState(false);
  return (
    <KitScreen nav="/_kit" header={<KitHeader title="Primitives" />}>
      <Block title="Colour roles" note="Quiet Sage. Every colour on every screen is one of these tokens.">
        <div className="grid grid-cols-4 gap-x-2 gap-y-3">
          {SWATCHES.map((s) => (
            <div key={s} className="min-w-0">
              <div className="h-10 rounded-btn shadow-[inset_0_0_0_1px_var(--line)]" style={{ background: `var(--${s})` }} />
              <div className="num mt-1 text-xs text-text-2 truncate">{s}</div>
            </div>
          ))}
        </div>
      </Block>

      <Block title="Type" note="System face for reading, the display face for names and titles, mono for numbers.">
        <div className="flex flex-col gap-2">
          {SIZES.map(([cls, label]) => (
            <div key={label} className="flex items-baseline gap-3 min-w-0">
              <span className="num w-28 flex-none text-xs text-text-3">{label}</span>
              <span className={`${cls} leading-tight text-text truncate`}>Waiting on you</span>
            </div>
          ))}
          <div className="flex items-baseline gap-3"><span className="num w-28 flex-none text-xs text-text-3">mono</span><span className="num text-ui text-text">v0.9.0 · 42% · 4m 12s</span></div>
        </div>
      </Block>

      <Block title="Buttons" note="One primary per view. Tonal repeats down a list. Nothing moves on hover; a press settles.">
        <div className="grid grid-cols-2 gap-2">
          <Button variant="primary" onPress={() => toast('Primary pressed')}>Apply v0.9.0</Button>
          <Button variant="tonal" icon="check" onPress={() => toast('Approved (fixture)', 'ok')}>Approve</Button>
          <Button variant="secondary" icon="restart" onPress={() => toast('Secondary pressed')}>Restart</Button>
          <Button variant="quiet" onPress={() => toast('Quiet pressed')}>Skip</Button>
          <Button variant="danger" onPress={() => toast('Stopped (fixture)', 'bad')}>Stop</Button>
          <Button isDisabled>Unavailable</Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <IconButton icon="clip" label="Attach a file" onPress={() => toast('Attach')} />
          <IconButton icon="search" label="Search" onPress={() => toast('Search')} />
          <IconButton icon="send" label="Send" tone="accent" onPress={() => toast('Send')} />
          <IconButton icon="send" label="Send (disabled)" tone="accent" isDisabled />
          <Menu label="More actions" onAction={(k) => toast(`Menu: ${String(k)}`)}>
            <MenuItem id="Restart" icon="restart">Restart</MenuItem>
            <MenuItem id="Session history" icon="board">Session history</MenuItem>
            <MenuSeparator />
            <MenuItem id="Stop" tone="bad">Stop</MenuItem>
          </Menu>
        </div>
      </Block>

      <Block title="Switches">
        <Switch defaultSelected description="Plays a sound when a turn ends.">Sound</Switch>
        <Switch description="Posts each turn to Telegram.">Mirror to Telegram</Switch>
      </Block>

      <Block title="Choices" note="The sliding block is the selection; the Appearance group below sets this page's theme.">
        <Segmented aria-label="View" value={view} onChange={(k) => setView(String(k))} className="w-full">
          <Segment id="chat" icon="chat">Chat</Segment>
          <Segment id="term" icon="term">Terminal</Segment>
        </Segmented>
        <RadioGroup label="Appearance" appearance="segmented" value={theme} className="mt-4"
          onChange={(v) => { setTheme(v); themeApi()?.set(v); }}>
          <Radio value="auto">Auto</Radio><Radio value="light">Light</Radio><Radio value="dark">Dark</Radio>
        </RadioGroup>
        <RadioGroup label="Restart" defaultValue="keep" className="mt-4">
          <Radio value="keep">Keep the conversation</Radio>
          <Radio value="fresh">Start a fresh conversation</Radio>
        </RadioGroup>
      </Block>

      <Block title="Tabs">
        <Tabs>
          <TabList aria-label="Manage atlas" className="-mx-4 px-2">
            {['Settings', 'Telegram', 'Secrets', 'Automations', 'Tools'].map((t) => <Tab key={t} id={t}>{t}</Tab>)}
          </TabList>
          {['Settings', 'Telegram', 'Secrets', 'Automations', 'Tools'].map((t) => (
            <TabPanel key={t} id={t}><p className="m-0 text-body text-text-2">{t}: the indicator slides here from the last tab.</p></TabPanel>
          ))}
        </Tabs>
      </Block>

      <Block title="Fields">
        <div className="flex flex-col gap-4">
          <TextField label="Label" description="Shown in the Accounts list." placeholder="Work seat" />
          <TextField label="Token" type="password" defaultValue="short" isInvalid errorMessage="token too short: expected 40+ characters (400)" mono />
          <Select label="Bot" defaultSelectedKey="atlas">
            <SelectItem id="atlas">atlas</SelectItem><SelectItem id="wren">wren</SelectItem><SelectItem id="quill">quill</SelectItem>
          </Select>
          <TextField label="Decline reason" multiline rows={2} placeholder="Optional: tell the bot why" />
        </div>
      </Block>

      <Block title="Meters" note="Amber from 75%, red from 90%. The value is mono.">
        <div className="flex flex-col gap-4">
          <Meter label="5 h window" value={40} detail="resets 01:20" />
          <Meter label="7 d window" value={78} detail="resets Friday" />
          <Meter label="Context" value={94} detail="940k of 1M tokens" />
        </div>
      </Block>

      <Block title="Disclosure">
        <Disclosure title="Raw state" meta="bot.yaml">
          <span className="num text-sm">harness.modules.sound: true</span>
        </Disclosure>
        <Disclosure title="What changed" meta="3" defaultExpanded>
          A bottom bar with four tabs; one-tap approvals; a Tools tab per bot.
        </Disclosure>
      </Block>

      <Block title="Banners">
        <div className="flex flex-col gap-2">
          <Banner tone="warn" action={<Button variant="quiet">Open</Button>}><span className="num font-semibold">4</span> things need you</Banner>
          <Banner tone="bad" action={<Button variant="quiet">Restart</Button>}>The session ended (exit 1).</Banner>
          <Banner tone="info" action={<Button variant="quiet">Open</Button>}>A sign-in link appeared in the terminal.</Banner>
        </div>
      </Block>

      <Block title="Sheet and toast" note="On a phone the sheet docks to the bottom and slides up.">
        <div className="grid grid-cols-2 gap-2">
          <DialogTrigger>
            <Button variant="secondary" icon="new">New chat</Button>
            <Sheet title="New chat" description="Starts a session in a folder of your choice."
              footer={(close) => (<>
                <Button variant="quiet" onPress={close}>Cancel</Button>
                <Button variant="primary" onPress={() => { close(); toast('Chat started (fixture)', 'ok'); }}>Start</Button>
              </>)}>
              <div className="flex flex-col gap-4">
                <TextField label="Folder" defaultValue={'C:\\work\\site'} mono />
                <Select label="Account" defaultSelectedKey="own"><SelectItem id="own">Its own token</SelectItem><SelectItem id="seat2">seat-2</SelectItem></Select>
                <Switch description="Opens the terminal instead of the chat.">Start in the terminal</Switch>
              </div>
            </Sheet>
          </DialogTrigger>
          <Button variant="secondary" onPress={() => toast('Saved: applies at the next roll', 'ok')}>Show a toast</Button>
          <Button variant="secondary" onPress={() => toast('Restart failed: exit 1', 'bad')}>Show an error</Button>
        </div>
      </Block>

      <Block title="Loading" note="Placeholders shimmer; real content never waits on an animation.">
        {loaded ? (
          <p className="m-0 text-body text-text">Loaded: three bots, two approvals.</p>
        ) : (<><SkeletonRow /><SkeletonRow /><Skeleton className="mt-3" /></>)}
        <Button variant="quiet" className="mt-2 -ml-4" onPress={() => setLoaded((v) => !v)}>{loaded ? 'Show the skeleton' : 'Show loaded'}</Button>
      </Block>

      <Block title="List motion" note="Rows arrive and leave in 200 ms; the rest close the gap.">
        <ul className="m-0 p-0 list-none">
          <AnimatedItems>
            {items.map((it) => (
              <ListItem key={it} className="flex items-center gap-3 min-h-[var(--tap)] pl-1">
                <Dot tone="ok" />
                <span className="flex-1 text-ui text-text">{it}</span>
                <IconButton icon="x" label={`Remove ${it}`} onPress={() => setItems((l) => l.filter((x) => x !== it))} />
              </ListItem>
            ))}
          </AnimatedItems>
        </ul>
        <Button variant="secondary" className="mt-2" onPress={() => { setItems((l) => [`new-tool-${n}`, ...l]); setN(n + 1); }}>Add a row</Button>
      </Block>

      <Block title="Marks" note="A dot beside the state word carries state. The icons are the house set: 16px, 1.5 stroke, one solid part.">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {(['ok', 'warn', 'bad', 'idle', 'accent'] as const).map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5 text-sm text-text-2"><Dot tone={t} />{t}</span>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-6 gap-y-3">
          {ICON_NAMES.map((name) => (
            <div key={name} className="flex flex-col items-center gap-1 text-text">
              <Icon name={name} size={16} />
              <span className="num text-xs text-text-3">{name}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-5 gap-y-3">
          {NAV_ICON_NAMES.map((name) => (
            <div key={name} className="flex flex-col items-center gap-1 text-text">
              <NavIcon name={name} />
              <span className="num text-xs text-text-3">{name}</span>
            </div>
          ))}
        </div>
      </Block>
      <div className="h-8" />
    </KitScreen>
  );
}
