// The manage tabs against a mocked server: the tab names, the model picker from
// /api/models, the project link's request bodies, write-only Secrets, the
// Automations status lines and the account chain's one POST.
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManageScreen } from './ManageScreen';
import { MotionRoot, ToastRegion } from '../../ui';

const BOT = { name: 'example', displayName: 'example', persona: 'p', model: 'top', kind: 'bg', running: false, phase: 'stopped', telegram: true, account: 'studio', backups: [], service: 'daemon', automations: [], tools: null };
const CONFIG = { config: { persona: 'A plain bot.', model: 'top', harness: { service: 'daemon', modules: { telegram: true, board: false, review_board: false }, disable: [], failover_notify: false }, integrations: { board: { owner: null, number: null, type: 'user' }, telegram: { dm_policy: 'pairing' } }, role: null }, set: [] };
const ACCOUNTS = { accounts: [
  { id: 'studio', label: 'Studio', plan: '', masked: '****St01', state: 'ok', fiveHour: null, sevenDay: null },
  { id: 'spare', label: 'Spare', plan: '', masked: '****Sp02', state: 'ok', fiveHour: null, sevenDay: null },
], bots: [] };
const MODELS = [{ tier: 'top', id: 'claude-opus-5-5', name: 'Opus 5.5', effort: 'high' }, { tier: 'workhorse', id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', effort: 'medium' }];

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
function serve(extra: Record<string, [number, unknown]> = {}) {
  calls.length = 0;
  const routes: Record<string, [number, unknown]> = {
    'GET /api/bots': [200, [BOT]], 'GET /api/bots/example/config': [200, CONFIG], 'GET /api/models': [200, MODELS],
    'GET /api/accounts': [200, ACCOUNTS], 'GET /api/approvals': [200, { pending: [], recent: [], admin: [] }],
    'POST /api/bots/example/config': [200, { ok: true, applied: true, queued: null, code: 0 }],
    ...extra,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const [status, body] = routes[`${method} ${url}`] ?? [404, { error: `no route ${method} ${url}` }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

function mount(tab: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}><MotionRoot>
      <MemoryRouter initialEntries={[`/bots/example/manage/${tab}`]}>
        <Routes><Route path="/bots/:name/manage/:tab" element={<ManageScreen />} /></Routes>
      </MemoryRouter>
      <ToastRegion />
    </MotionRoot></QueryClientProvider>,
  );
}
// a toast is also an alertdialog: the confirm is the one inside a sheet
const confirmDialog = () => waitFor(() => {
  const d = document.querySelector<HTMLElement>('.sheet [role=alertdialog]');
  if (!d) throw new Error('no confirm sheet');
  return d;
});
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body]);

it('the five tabs, in order', async () => {
  serve();
  mount('settings');
  await screen.findByRole('textbox', { name: 'Persona' });
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Settings', 'Telegram', 'Secrets', 'Automations', 'Tools']);
});

it('the model is a picker over /api/models: its names, and no model input', async () => {
  serve();
  mount('settings');
  const picker = await screen.findByRole('button', { name: /Model/ });
  expect(document.querySelector('input[name=model]')).toBeNull();
  await userEvent.click(picker);
  const options = await screen.findAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['Opus 5.5', 'Sonnet 5.5']);
  await userEvent.click(options[1]);
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/bots/example/config', { path: 'model', value: 'workhorse' }]]));
});

it('a pasted project link writes owner, number and type, then turns the board on', async () => {
  serve();
  mount('settings');
  const field = await screen.findByRole('textbox', { name: 'GitHub project link' });
  await userEvent.type(field, 'https://github.com/users/acme/projects/7');
  await userEvent.tab();
  await waitFor(() => expect(writes()).toHaveLength(4));
  expect(writes()).toEqual([
    ['POST', '/api/bots/example/config', { path: 'integrations.board.owner', value: 'acme' }],
    ['POST', '/api/bots/example/config', { path: 'integrations.board.number', value: 7 }],
    ['POST', '/api/bots/example/config', { path: 'integrations.board.type', value: 'user' }],
    ['POST', '/api/bots/example/config', { path: 'harness.modules.board', value: true }],
  ]);
});

it('the failover notify switch posts harness.failover_notify', async () => {
  serve();
  mount('settings');
  await userEvent.click(await screen.findByRole('switch', { name: 'Notify on Telegram' }));
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/bots/example/config', { path: 'harness.failover_notify', value: true }]]));
});

it('a link that is not a project writes nothing and says why', async () => {
  serve();
  mount('settings');
  await userEvent.type(await screen.findByRole('textbox', { name: 'GitHub project link' }), 'not a link');
  await userEvent.tab();
  await screen.findByText('Invalid project link');
  expect(writes()).toEqual([]);
});

it('a setting that widens shows Waiting · Approve inline', async () => {
  serve({ 'GET /api/approvals': [200, { pending: [{ id: 'a1', bot: 'example', path: 'harness.modules.review_board' }], recent: [], admin: [] }] });
  mount('settings');
  await screen.findByRole('textbox', { name: 'Persona' });
  expect((await screen.findByText('Waiting · Approve')).closest('a')!.getAttribute('href')).toBe('/inbox');
});

it('the chain is saved in one POST after the confirm', async () => {
  serve({ 'POST /api/bots/example/accounts': [200, { ok: true, steps: [] }] });
  mount('settings');
  await userEvent.click(await screen.findByRole('button', { name: /Add a backup/ }));
  await userEvent.click(await screen.findByRole('option', { name: 'Spare' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save backups' }));
  const dialog = await confirmDialog();
  expect(writes()).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save backups' }));
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/bots/example/accounts', { primary: 'studio', backups: ['spare'] }]]));
});

it('a one-entry chain is the Primary and cannot move or be removed', async () => {
  serve();
  mount('settings');
  await screen.findByRole('button', { name: /Add a backup/ });
  expect([...document.querySelectorAll('[data-chain-role]')].map((e) => e.textContent)).toEqual(['Primary']);
  for (const name of ['Move Studio up', 'Move Studio down', 'Remove Studio']) {
    expect(screen.queryByRole('button', { name }), name).toBeNull();
  }
});

it('with two entries: up is off on the first, down on the last, the second is a Backup', async () => {
  serve({ 'GET /api/bots': [200, [{ ...BOT, backups: ['spare'] }]] });
  mount('settings');
  await screen.findByRole('button', { name: 'Move Spare down' });
  expect([...document.querySelectorAll('[data-chain-role]')].map((e) => e.textContent)).toEqual(['Primary', 'Backup']);
  const off = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
  expect([off('Move Studio up'), off('Move Studio down'), off('Move Spare up'), off('Move Spare down')]).toEqual([true, false, false, true]);
  expect(off('Remove Studio')).toBe(false);
});

it('a Telegram change asks first: nothing is written until the verb, and Cancel writes nothing', async () => {
  serve({ 'GET /api/bots/example/pairing': [200, { present: true, dmPolicy: 'pairing', allowFrom: [], pending: [{ senderId: '4242', ageS: 30 }] }],
    'POST /api/bots/example/pair': [200, { ok: true }] });
  mount('telegram');
  await userEvent.click(await screen.findByRole('radio', { name: 'Only listed' }));
  let dialog = await confirmDialog();
  expect(within(dialog).getByText('A wrong setting can cut it off.')).toBeTruthy();
  expect(writes()).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(document.querySelector('.sheet [role=alertdialog]')).toBeNull());
  expect(writes()).toEqual([]);
  await userEvent.click(screen.getByRole('radio', { name: 'Only listed' }));
  dialog = await confirmDialog();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Change Telegram' }));
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/bots/example/config', { path: 'integrations.telegram.dm_policy', value: 'allowlist' }]]));
});

it('Pair asks first, then pairs the sender', async () => {
  serve({ 'GET /api/bots/example/pairing': [200, { present: true, dmPolicy: 'pairing', allowFrom: [], pending: [{ senderId: '4242', ageS: 30 }] }],
    'POST /api/bots/example/pair': [200, { ok: true }] });
  mount('telegram');
  await userEvent.click(await screen.findByRole('button', { name: 'Pair' }));
  const dialog = await confirmDialog();
  expect(writes()).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Pair sender' }));
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/bots/example/pair', { senderId: '4242' }]]));
});

it('Secrets shows names and never a masked value', async () => {
  serve({ 'GET /api/bots/example/secrets': [200, [{ key: 'oauth_token', masked: '****PgAA', updatedAt: '2026-09-29T10:00:00Z' }, { key: 'hub_token', masked: '····abcd' }]],
    'GET /api/bots/example/secrets/lock': [200, { mode: 'none', locked: false }] });
  mount('secrets');
  await screen.findByText('oauth_token');
  const text = document.body.textContent || '';
  expect(text).not.toMatch(/[*·]{4}/);
  expect(screen.getAllByRole('button', { name: 'Replace' })).toHaveLength(2);
});

it('Replace on an existing secret asks first; the old value is gone', async () => {
  serve({ 'GET /api/bots/example/secrets': [200, [{ key: 'hub_token', masked: '****abcd' }]], 'GET /api/bots/example/secrets/lock': [200, { mode: 'none', locked: false }],
    'PUT /api/bots/example/secrets/hub_token': [200, { ok: true, key: 'hub_token' }] });
  mount('secrets');
  await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('New hub_token value'), 'new-value');
  await userEvent.click(screen.getAllByRole('button', { name: 'Replace' }).at(-1)!);
  const dialog = await confirmDialog();
  expect(within(dialog).getByText('The old value is gone.')).toBeTruthy();
  expect(writes()).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Replace secret' }));
  await waitFor(() => expect(writes()).toEqual([['PUT', '/api/bots/example/secrets/hub_token', { value: 'new-value' }]]));
});

it('every automation row starts with Next, Last, Never or Failing', async () => {
  const soon = new Date(Date.now() + 20 * 60e3).toISOString();
  serve({ 'GET /api/bots/example/automations': [200, {
    declared: [{ name: 'digest', kind: 'command', trigger: { interval_min: 30 }, enabled: true }, { name: 'sweep', kind: 'command', trigger: { cron: '0 * * * *' }, enabled: true }, { name: 'idle', kind: 'prompt', trigger: { event: 'stop' }, enabled: false }],
    state: { digest: { next_due: soon }, sweep: { failure_streak: 3 } }, present: true, runs: [] }] });
  mount('automations');
  await screen.findByText('digest');
  const rows = [...document.querySelectorAll('[data-automation]')];
  expect(rows).toHaveLength(3);
  for (const r of rows) expect(r.querySelector('[data-status]')!.textContent, r.textContent!).toMatch(/^(Next|Last|Never|Failing)/);
});

it('Tools hides the plumbing modules, and says what a module does in plain words', async () => {
  const mod = (m: string, description: string) => ({ id: `module:${m}`, source: 'harness', kind: 'module', name: m, description, on: true, locked: null, toggle: { path: `harness.modules.${m}`, on: true, off: false } });
  serve({
    'GET /api/bots/example/inventory': [200, { groups: [{ source: 'harness', label: 'BotCorp harness', license: 'MIT', sections: [{ kind: 'module', label: 'Modules', items: [
      mod('cost_meter', 'One sessions.csv row per session.'),
      mod('telegram', 'The official Telegram plugin.'),
    ] }] }] }],
    'GET /api/bots/example/tools': [200, { registry: 'off', missing: [], registered: [], proposal: { tools: [], orphans: [] } }],
  });
  mount('tools');
  await screen.findByText('Reads and answers its Telegram chat.');
  expect(document.querySelector('[data-tool="module:cost_meter"]')).toBeNull();
  expect(document.body.textContent).not.toMatch(/sessions\.csv/i);
});
