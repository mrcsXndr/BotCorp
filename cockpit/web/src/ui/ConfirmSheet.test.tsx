import { expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfirm } from './ConfirmSheet';

const OPTS = { title: 'Restart atlas?', body: 'Keeps the conversation.', verb: 'Restart atlas', cancel: 'Cancel' };
function Harness({ onResult }: { onResult: (ok: boolean) => void }) {
  const [sheet, ask] = useConfirm();
  return <><button type="button" onClick={() => ask(OPTS).then(onResult)}>go</button>{sheet}</>;
}

it('useConfirm: an alertdialog; Cancel resolves false, the verb resolves true', async () => {
  const results: boolean[] = [];
  render(<Harness onResult={(ok) => results.push(ok)} />);
  await userEvent.click(screen.getByRole('button', { name: 'go' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('Keeps the conversation.');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(results).toEqual([false]));

  await userEvent.click(screen.getByRole('button', { name: 'go' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Restart atlas' }));
  await waitFor(() => expect(results).toEqual([false, true]));
});
