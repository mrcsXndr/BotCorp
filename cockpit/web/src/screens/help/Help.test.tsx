import { expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { HelpScreen } from './HelpScreen';
import helpText from '../../help.md?raw';

it('renders at least seven sections as real h2s', () => {
  render(<MemoryRouter><HelpScreen /></MemoryRouter>);
  const h2 = [...document.querySelectorAll('h2')].map((h) => h.textContent);
  expect(h2.length).toBeGreaterThanOrEqual(7);
  expect(h2).toContain('Chats and pinned bots');
  expect(helpText).not.toMatch(/setup-token/);   // the command lives in the Add account tooltip
});

it('stays short and engine-neutral', () => {
  expect(helpText.trim().split(/\s+/).length).toBeLessThanOrEqual(450);
  expect(helpText).not.toMatch(/remote.?control|\/login|loopback|via\s*access|\bpty\b|\bpid\b|—/i);
});
