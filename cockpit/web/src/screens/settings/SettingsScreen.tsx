import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { usePairDevices, usePairRevoke } from '../../api/queries';
import { Button, EmptyState, Radio, RadioGroup, Skeleton, Switch, toast, useConfirm } from '../../ui';
import { ScreenHeader } from '../../app/ScreenHeader';
import { Icon } from '../../icons';
import { deviceName, readCopyOnSelect, writeCopyOnSelect } from '../../lib/browsers';
import { ago } from '../../lib/settings';
import { COPY } from '../../lib/copy';
import { KnowledgePanel } from '../manage/KnowledgeTab';

type ThemeApi = { get(): string; set(t: string): void };
const themeApi = () => (globalThis as { CockpitTheme?: ThemeApi }).CockpitTheme;

function Section({ title, right, children }: { title: string; right?: ReactNode; children?: ReactNode }) {
  return (
    <section className="mx-4 py-4 flex flex-col gap-3 shadow-[0_1px_0_var(--line)] last:shadow-none">
      <div className="flex items-center gap-3">
        <h2 className="m-0 flex-1 text-sm font-semibold text-text-2">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function PairedBrowsers() {
  const q = usePairDevices();
  const revoke = usePairRevoke();
  const [confirmSheet, ask] = useConfirm();
  const devices = q.data?.devices || [];
  const onRevoke = async (id: string) => {
    const c = COPY.confirm.revoke;
    if (!(await ask({ title: c.title, body: c.body, verb: c.verb, cancel: COPY.button.cancel }))) return;
    try { await revoke.mutateAsync({ id }); toast(COPY.toast.browserRevoked, 'ok'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <Section title={COPY.row.pairedBrowsers}>
      {!devices.length ? <EmptyState inline>{COPY.empty.noBrowsers}</EmptyState> : (
        <ul className="m-0 p-0 list-none flex flex-col" data-devices>
          {devices.map((d) => (
            <li key={d.id} data-device={d.id} className="flex items-center gap-2 min-h-[var(--tap)] py-1">
              <span className="flex-1 min-w-0 flex flex-col">
                <span className="text-ui text-text truncate">{deviceName(d.label)}</span>
                <span className="text-sm text-text-3">{d.current ? `${COPY.row.thisBrowser} · ` : ''}{ago(String(d.created || ''))}</span>
              </span>
              <Button variant="danger" onPress={() => onRevoke(d.id)}>{COPY.button.revoke}</Button>
            </li>
          ))}
        </ul>
      )}
      {confirmSheet}
    </Section>
  );
}

// Settings is short and global (IA §4): this browser's Appearance and Copy on
// select, the knowledge every bot loads (the operator's only), the browsers
// paired to operate this cockpit (a loopback cockpit only: behind Access the
// verified identity is the operator), and Help. A bot's own settings are on the bot.
export function SettingsScreen() {
  const [theme, setTheme] = useState(() => themeApi()?.get() ?? 'auto');
  const [copy, setCopy] = useState(readCopyOnSelect);
  const exposure = usePairDevices().data?.exposure;
  return (
    <div className="mx-auto w-full max-w-[720px] pb-6">
      <ScreenHeader>{COPY.title.settings}</ScreenHeader>
      <Section title={COPY.row.appearance}>
        <RadioGroup aria-label={COPY.row.appearance} appearance="segmented" value={theme} onChange={(v) => { setTheme(v); themeApi()?.set(v); }}>
          <Radio value="auto">{COPY.row.auto}</Radio>
          <Radio value="light">{COPY.row.light}</Radio>
          <Radio value="dark">{COPY.row.dark}</Radio>
        </RadioGroup>
      </Section>
      <Section title={COPY.row.copySelect}
        right={<Switch aria-label={COPY.row.copySelect} isSelected={copy} onChange={(v) => { setCopy(v); writeCopyOnSelect(v); }} />} />
      <Section title={`${COPY.title.knowledge} · ${COPY.row.allBots}`}>
        <KnowledgePanel bot={null} />
      </Section>
      {!exposure ? <Skeleton lines={2} className="px-4 py-4" /> : exposure === 'loopback' && <PairedBrowsers />}
      <Section title={COPY.row.help}>
        <Link to="/help" className="flex items-center gap-2 min-h-[var(--tap)] text-ui text-text no-underline outline-none rounded-btn hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
          <Icon name="guide" className="text-text-2" />
          <span className="flex-1">{COPY.row.guide}</span>
          <Icon name="chev" className="-rotate-90 text-text-3" />
        </Link>
      </Section>
    </div>
  );
}
