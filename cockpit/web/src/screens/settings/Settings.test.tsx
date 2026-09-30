// Global Settings and the PairSheet against a mocked server: four sections on a
// loopback cockpit and three under Access, no bot picker, the pairing flow (a
// 403 {need} opens the sheet, a wrong code shows the server's text, the right
// one claims and the call runs again) and Revoke behind its confirm.
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsScreen } from './SettingsScreen';
import { PairHost } from '../../app/PairSheet';
import { useDecide } from '../../api/queries';
import { MotionRoot, ToastRegion } from '../../ui';
import { deviceName } from '../../lib/browsers';

const DEVICES = { exposure: 'loopback', devices: [
  { id: '0123456789abcdef', created: new Date(Date.now() - 3600e3).toISOString(), label: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', current: true },
] };

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
function serve(routes: Record<string, [number, unknown] | (() => [number, unknown])>) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[`${method} ${url}`];
    const [status, body] = (typeof r === 'function' ? r() : r) ?? [404, { error: `no route ${method} ${url}` }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body]);
const confirmDialog = () => waitFor(() => { const d = document.querySelector<HTMLElement>('.sheet [role=alertdialog]'); if (!d) throw new Error('no confirm'); return d; });
function mount(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MotionRoot><MemoryRouter>{ui}<PairHost /></MemoryRouter><ToastRegion /></MotionRoot></QueryClientProvider>);
}

it('five section headings on loopback, no bot picker', async () => {
  serve({ 'GET /api/pair/devices': [200, DEVICES] });
  mount(<SettingsScreen />);
  await screen.findByText('Chrome on Windows');
  const h2 = [...document.querySelectorAll('h2')].map((h) => h.textContent);
  expect(h2).toEqual(['Appearance', 'Copy on select', 'Knowledge · All bots', 'Paired browsers', 'Help']);
  expect(document.querySelector('select[aria-label=bot]')).toBeNull();
  expect(screen.getByText(/This browser/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Mozilla|537\.36|141\.0/);
});

it('four under Access: nobody to pair', async () => {
  serve({ 'GET /api/pair/devices': [200, { exposure: 'access', devices: [] }] });
  mount(<SettingsScreen />);
  await screen.findByRole('link', { name: 'How BotCorp works' });
  expect([...document.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Appearance', 'Copy on select', 'Knowledge · All bots', 'Help']);
  expect(document.body.textContent).not.toMatch(/loopback|access/i);
});

it('v0.9.9: an "All bots" doc is edited here and saved with the sha it was read at', async () => {
  const sha = 'a'.repeat(64);
  serve({ 'GET /api/pair/devices': [200, { exposure: 'access', devices: [] }],
    'GET /api/knowledge': [200, { scope: 'global', docs: [{ id: 'house', file: 'x', bytes: 8, tokens: 2, sha256: sha, updated_at: new Date().toISOString() }] }],
    'GET /api/knowledge/house': [200, { id: 'house', file: 'x', bytes: 8, tokens: 2, sha256: sha, updated_at: new Date().toISOString(), content: '# House\n' }],
    'PUT /api/knowledge/house': [200, { ok: true, id: 'house', created: false, sha256: 'b'.repeat(64) }] });
  mount(<SettingsScreen />);
  await userEvent.click(await screen.findByRole('button', { name: /house/ }));
  const field = await screen.findByRole('textbox', { name: 'Doc text' });
  expect((field as HTMLTextAreaElement).value).toBe('# House\n');
  await userEvent.type(field, 'More.');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes()).toEqual([['PUT', '/api/knowledge/house', { content: '# House\nMore.', ifMatch: sha }]]));
  expect(screen.getByText('Loads at next start')).toBeTruthy();
});

it('Copy on select is this browser only, in the key the terminal reads', async () => {
  serve({ 'GET /api/pair/devices': [200, DEVICES] });
  mount(<SettingsScreen />);
  await userEvent.click(await screen.findByRole('switch', { name: 'Copy on select' }));
  expect(JSON.parse(localStorage.getItem('cockpit.settings')!)).toEqual({ copyOnSelect: true });
  expect(writes()).toEqual([]);
});

it('Revoke asks first: it must pair again', async () => {
  serve({ 'GET /api/pair/devices': [200, DEVICES], 'DELETE /api/pair/devices/0123456789abcdef': [200, { ok: true, removed: 1 }] });
  mount(<SettingsScreen />);
  await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
  const dialog = await confirmDialog();
  expect(within(dialog).getByText('It must pair again.')).toBeTruthy();
  expect(writes()).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(writes()).toEqual([['DELETE', '/api/pair/devices/0123456789abcdef', undefined]]));
});

function Gated() {
  const decide = useDecide();
  return <button onClick={() => decide.mutate({ name: 'example', id: 'a1', decision: 'approve' })}>go</button>;
}

it('a 403 {need} opens the PairSheet; a wrong code shows why; the right one claims and retries', async () => {
  let paired = false;
  serve({
    'POST /api/bots/example/approvals/a1/approve': () => (paired ? [200, { ok: true, code: 0 }] : [403, { error: 'needs the operator', need: 'approve-token' }]),
    'POST /api/pair/claim': () => {
      const last = calls.filter((c) => c.url === '/api/pair/claim').at(-1)!.body as { code: string };
      if (last.code !== 'ABCD-EFGH') return [403, { error: 'wrong or expired code' }];
      paired = true;
      return [200, { ok: true, device: { id: 'x' } }];
    },
  });
  mount(<Gated />);
  await userEvent.click(screen.getByRole('button', { name: 'go' }));
  const sheet = await screen.findByRole('dialog');
  expect(within(sheet).getByRole('heading', { name: 'Pair browser' })).toBeTruthy();
  await userEvent.type(within(sheet).getByRole('textbox', { name: 'Enter pairing code' }), 'WRONG-CODE');
  await userEvent.click(within(sheet).getByRole('button', { name: 'Pair' }));
  await waitFor(() => expect(sheet.querySelector('[data-form-error]')!.textContent).toBe('wrong or expired code'));
  await userEvent.clear(within(sheet).getByRole('textbox', { name: 'Enter pairing code' }));
  await userEvent.type(within(sheet).getByRole('textbox', { name: 'Enter pairing code' }), 'ABCD-EFGH');
  await userEvent.click(within(sheet).getByRole('button', { name: 'Pair' }));
  await waitFor(() => expect(writes().map((w) => w[1])).toEqual([
    '/api/bots/example/approvals/a1/approve', '/api/pair/claim', '/api/pair/claim', '/api/bots/example/approvals/a1/approve',
  ]));
});

it('deviceName says a browser and a system, never the raw string', () => {
  expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1')).toBe('Chrome on iOS');
  expect(deviceName('')).toBe('A browser');
});
