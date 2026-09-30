// The Accounts page against a mocked server: two meters per account with a
// reading (one "No usage yet" line without), the plan
// read and never typed, rename as a PATCH, the server's 400 in the form's error
// region, and remove behind its confirm.
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountsScreen } from './AccountsScreen';
import { MotionRoot, ToastRegion } from '../../ui';
import { hasReading, maskedText, newAccountId, stateView, windowView } from '../../lib/accounts';

const RESET = Math.floor(Date.now() / 1000) + 7200;
const ACCOUNTS = () => ({ accounts: [
  { id: 'studio', label: 'Studio', plan: 'Max 20×', plan_source: 'credentials', masked: '****St01', state: 'ok', fiveHour: { pct: 42, resetsAt: RESET }, sevenDay: { pct: 78 },
    used_by: [{ bot: 'example', role: 'primary', order: 1 }, { bot: 'chat-0930-0845', role: 'backup', order: 1 }] },
  { id: 'spare', label: 'Spare', plan: '', masked: '****Sp02', state: 'limited', blocked_until: new Date(Date.now() + 3600e3).toISOString(), fiveHour: null, sevenDay: { na: 'no reading' }, used_by: [] },
], bots: [] });

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
let label = 'Studio';
function serve(extra: Record<string, [number, unknown]> = {}) {
  calls.length = 0;
  label = 'Studio';
  const routes: Record<string, [number, unknown]> = {
    'PATCH /api/accounts/studio': [200, { ok: true, code: 0 }],
    'DELETE /api/accounts/spare': [200, { ok: true, code: 0 }],
    'POST /api/accounts': [200, { ok: true, code: 0 }],
    ...extra,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (method === 'PATCH') label = body.label;   // the label changes after the refetch
    if (method === 'GET' && url === '/api/accounts') {
      const d = ACCOUNTS();
      d.accounts[0].label = label;
      return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const [status, out] = routes[`${method} ${url}`] ?? [404, { error: `no route ${method} ${url}` }];
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => vi.unstubAllGlobals());
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body]);
const confirmDialog = () => waitFor(() => { const d = document.querySelector<HTMLElement>('.sheet [role=alertdialog]'); if (!d) throw new Error('no confirm'); return d; });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MotionRoot><MemoryRouter><AccountsScreen /></MemoryRouter><ToastRegion /></MotionRoot></QueryClientProvider>);
}

it('two meters per account with a reading, one line without; no own-token wording; no plan input; masked as ····', async () => {
  serve();
  mount();
  await screen.findByText('Studio');
  expect(document.querySelectorAll('[role~=meter]')).toHaveLength(2);   // RAC's role is "meter progressbar"; Spare has no reading
  expect(document.querySelectorAll('[data-account=studio] [role~=meter]')).toHaveLength(2);
  expect(document.querySelector('[data-account=spare] [data-no-usage]')?.textContent).toBe('No usage yet');
  expect(document.querySelector('[data-account=studio] [data-no-usage]')).toBeNull();
  expect(document.body.textContent).not.toMatch(/own token|its own token/i);
  expect([...document.querySelectorAll('h2')].some((h) => /^bot /i.test(h.textContent || ''))).toBe(false);   // no account is named after a bot
  expect(document.querySelector('input[name=plan]')).toBeNull();
  expect(screen.getByText('····St01')).toBeTruthy();
  expect(screen.getByText('Max 20×')).toBeTruthy();
  expect(screen.queryAllByText('n/a')).toHaveLength(0);
  expect(document.querySelectorAll('[data-plan]')).toHaveLength(1);   // an unknown plan is hidden
  const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-used-by]')].map((l) => [l.textContent, l.getAttribute('href')]);
  expect(links).toEqual([['example primary', '/bots/example/manage/settings'], ['chat-0930-0845 backup 1', '/bots/chat-0930-0845/manage/settings']]);
});

it('a rename PATCHes the label and it shows after the refetch', async () => {
  serve();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Menu for Studio' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const field = screen.getByRole('textbox', { name: 'Label' });
  await userEvent.clear(field);
  await userEvent.type(field, 'Work');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes()).toEqual([['PATCH', '/api/accounts/studio', { label: 'Work' }]]));
  await screen.findByRole('heading', { name: 'Work' });
});

it('a 10-character token shows the server text in the form error region', async () => {
  const msg = 'token: the whole string `claude setup-token` printed (20 to 400 characters, no spaces)';
  serve({ 'POST /api/accounts': [400, { error: msg }] });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  const sheet = await screen.findByRole('dialog');
  await userEvent.type(within(sheet).getByLabelText('Setup token', { selector: 'input' }), 'abcdefghij');
  await userEvent.type(within(sheet).getByRole('textbox', { name: 'Label' }), 'Work login');
  await userEvent.click(within(sheet).getByRole('button', { name: 'Add account' }));
  await waitFor(() => expect(sheet.querySelector('[data-form-error]')!.textContent).toBe(msg));
  expect(writes()).toEqual([['POST', '/api/accounts', { id: 'work-login', label: 'Work login', token: 'abcdefghij' }]]);
  expect(within(sheet).queryByRole('textbox', { name: /plan/i })).toBeNull();
});

it('Remove waits for its confirm: its token leaves the vault', async () => {
  serve();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Menu for Spare' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove account' }));
  const dialog = await confirmDialog();
  expect(within(dialog).getByText('Its token leaves the vault.')).toBeTruthy();
  expect(writes()).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove account' }));
  await waitFor(() => expect(writes()).toEqual([['DELETE', '/api/accounts/spare', undefined]]));
});

it('the helpers: state words, windows, ids', () => {
  expect(stateView({ state: 'ok' })).toEqual({ word: 'ok', tone: 'ok' });
  expect(stateView({ state: 'limited', blocked_until: '2026-09-30T12:05:00Z' }).word).toMatch(/^limited until \d/);
  expect(stateView({ state: 'no-token' }).word).toBe('no token');
  expect(windowView({ pct: 41.6 }).text).toBe('42%');
  expect(windowView(null)).toEqual({ value: 0, text: 'n/a', detail: '' });
  expect([hasReading(null), hasReading({ na: 'no reading' }), hasReading({ pct: 0 }), hasReading({ pct: 42 })]).toEqual([false, false, true, true]);
  expect(maskedText('****PgAA')).toBe('····PgAA');
  expect(newAccountId('Work login', 'x', ['studio'])).toBe('work-login');
  expect(newAccountId('Studio', 'x', ['studio'])).toBe('studio-2');
  expect(newAccountId('', 'sk-ant-oat01-AAAAPgAA', [])).toBe('acct-pgaa');
});
