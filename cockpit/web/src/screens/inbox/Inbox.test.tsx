// The Inbox against a mocked server: one-tap Approve, Decline with a reason,
// Link on an account_unlinked item, Decided / admin folded away, and the
// #/approvals redirect.
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxScreen } from './InboxScreen';
import { MotionRoot, ToastRegion } from '../../ui';

const ITEMS = [
  { bot: 'example', kind: 'approval', severity: 'warn', text: 'example asks: raises effort to max', action: { type: 'approve', bot: 'example', id: 'a1b2c3' } },
  { bot: null, kind: 'account_unlinked', severity: 'warn', text: 'Accounts still named after bots', action: { type: 'link', bots: [] } },
  { bot: null, kind: 'cc_rejected', severity: 'warn', text: 'Claude Code 2.3.2 failed its canary and was not rolled out', action: { type: 'release' } },
];
const APPROVALS = {
  pending: [{ id: 'a1b2c3', bot: 'example', op: 'set', path: 'effort', value: 'max', requested_by: 'bot:example', why: 'raises effort to max' }],
  recent: [{ bot: 'example', id: 'd4e5f6', decision: 'approved', by: 'operator:dev', at: new Date(Date.now() - 3600e3).toISOString(), path: 'effort', value: '"high"' }],
  admin: [{ at: new Date(Date.now() - 7200e3).toISOString(), by: 'bot:ops', verb: 'restart', target: 'example', refused: null }],
};

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
function serve(extra: Record<string, [number, unknown]> = {}) {
  calls.length = 0;
  const routes: Record<string, [number, unknown]> = {
    'GET /api/attention': [200, { at: '', count: ITEMS.length, items: ITEMS }], 'GET /api/approvals': [200, APPROVALS],
    'POST /api/bots/example/approvals/a1b2c3/approve': [200, { ok: true, code: 0 }],
    'POST /api/bots/example/approvals/a1b2c3/reject': [200, { ok: true, code: 0 }],
    'POST /api/accounts/link': [200, { ok: true, linked: [], relabeled: ['scratch'] }],
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
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body]);

function mount(path = '/inbox') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}><MotionRoot>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/inbox" element={<InboxScreen />} />
          <Route path="/approvals" element={<Navigate to="/inbox" replace />} />
        </Routes>
      </MemoryRouter>
      <ToastRegion />
    </MotionRoot></QueryClientProvider>,
  );
}

it('Approve is one tap: no confirm, one POST', async () => {
  serve();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/bots/example/approvals/a1b2c3/approve', {}]]));
  expect(document.querySelector('.sheet')).toBeNull();
});

it('Decline opens a reason in place and rejects with it', async () => {
  serve();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Reason (optional)' }), 'not now');
  await userEvent.click(screen.getAllByRole('button', { name: 'Decline' }).at(-1)!);
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/bots/example/approvals/a1b2c3/reject', { reason: 'not now' }]]));
});

it('Link on an account_unlinked item shares the approval card shell and asks first', async () => {
  serve();
  mount();
  await screen.findByText('Puts each bot on its own named account.');
  const card = document.querySelector<HTMLElement>('[data-kind=account_unlinked]')!;
  expect(card.tagName).toBe('ARTICLE');
  expect(card.className).toBe(document.querySelector<HTMLElement>('[data-approval]')!.className);   // one shell
  expect(card.querySelector('h3')!.textContent).toBe('Link accounts');
  await userEvent.click(screen.getByRole('button', { name: 'Link' }));
  const dialog = await waitFor(() => {
    const d = document.querySelector<HTMLElement>('.sheet [role=alertdialog]');
    if (!d) throw new Error('no confirm sheet');
    return d;
  });
  expect(within(dialog).getByText('Bots switch to their account at next start.')).toBeTruthy();
  expect(writes()).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Link accounts' }));
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/accounts/link', {}]]));
});

it('an engine item never names the engine build; Decided and admin folded away', async () => {
  serve();
  mount();
  await screen.findByText('Engine update held back');
  expect(document.body.textContent).not.toMatch(/canary|2\.3\.2/);
  const triggers = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-expanded') !== null).map((b) => b.textContent);
  expect(triggers).toEqual(['Decided1', 'Done by an admin bot1']);
  expect(screen.getByText(/approved by dev/).closest('[hidden]')).not.toBeNull();   // collapsed: hidden by the disclosure itself
});

it('an empty Inbox says so', async () => {
  serve({ 'GET /api/attention': [200, { at: '', count: 0, items: [] }], 'GET /api/approvals': [200, { pending: [], recent: [], admin: [] }] });
  mount();
  await screen.findByText('Nothing needs you');
});

it('#/approvals lands on #/inbox', async () => {
  serve();
  mount('/approvals');
  await screen.findByRole('heading', { name: /Inbox/ });
});
