import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DialogTrigger } from 'react-aria-components';
import {
  AnimatedItems, Banner, Button, Disclosure, IconButton, ListItem, Menu, MenuItem, Meter, MotionRoot, Radio, RadioGroup,
  Segment, Segmented, Select, SelectItem, Sheet, Skeleton, Switch, Tab, TabList, TabPanel, Tabs, TextField, ToastRegion,
  meterLevel, toast, toastQueue,
} from './index';
import { ICON_NAMES, Icon, NAV_ICON_NAMES, NavIcon } from '../icons';

describe('Button', () => {
  it('fires onPress and carries its variant', async () => {
    const onPress = vi.fn();
    render(<Button variant="primary" onPress={onPress}>Approve</Button>);
    const b = screen.getByRole('button', { name: 'Approve' });
    expect(b.dataset.variant).toBe('primary');
    await userEvent.click(b);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it('does not fire when disabled', async () => {
    const onPress = vi.fn();
    render(<Button isDisabled onPress={onPress}>Apply</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('is named by its label', () => {
    render(<IconButton icon="clip" label="Attach a file" />);
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeTruthy();
  });
});

describe('Switch', () => {
  it('toggles and reports the new value', async () => {
    const onChange = vi.fn();
    render(<Switch onChange={onChange}>Sound</Switch>);
    const sw = screen.getByRole('switch', { name: 'Sound' });
    expect((sw as HTMLInputElement).checked).toBe(false);
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    expect((sw as HTMLInputElement).checked).toBe(true);
  });
});

describe('Tabs', () => {
  it('shows the panel of the pressed tab', async () => {
    render(
      <Tabs>
        <TabList aria-label="Manage"><Tab id="a">Overview</Tab><Tab id="b">Tools</Tab></TabList>
        <TabPanel id="a">overview body</TabPanel><TabPanel id="b">tools body</TabPanel>
      </Tabs>,
    );
    expect(screen.getByText('overview body')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    expect(screen.getByText('tools body')).toBeTruthy();
    expect(screen.queryByText('overview body')).toBeNull();
  });
});

describe('Sheet', () => {
  it('opens as a dialog named by its title and closes from its close button', async () => {
    render(
      <DialogTrigger>
        <Button>New chat</Button>
        <Sheet title="Start a chat" description="A fresh session">body text</Sheet>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    const dlg = screen.getByRole('dialog', { name: 'Start a chat' });
    expect(within(dlg).getByText('body text')).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Menu', () => {
  it('opens from the more button and runs the chosen action', async () => {
    const onAction = vi.fn();
    render(
      <Menu label="Bot actions" onAction={onAction}>
        <MenuItem id="restart" icon="restart">Restart</MenuItem>
        <MenuItem id="stop" tone="bad">Stop</MenuItem>
      </Menu>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Bot actions' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Stop' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['stop']);
  });
});

describe('Select', () => {
  it('shows the chosen item as its value', async () => {
    const onChange = vi.fn();
    render(
      <Select label="Bot" placeholder="Pick a bot" onChange={onChange}>
        <SelectItem id="atlas">atlas</SelectItem>
        <SelectItem id="wren">wren</SelectItem>
      </Select>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Bot/ }));
    await userEvent.click(screen.getByRole('option', { name: 'wren' }));
    expect(onChange).toHaveBeenCalledWith('wren');
    expect(screen.getByRole('button', { name: /wren/ })).toBeTruthy();
  });
});

describe('TextField', () => {
  it('labels its input and shows the error text when invalid', () => {
    render(<TextField label="Token" isInvalid errorMessage="token too short (400)" />);
    const input = screen.getByRole('textbox', { name: 'Token' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('token too short (400)')).toBeTruthy();
  });
});

describe('Meter', () => {
  it('levels at 75 and 90 percent', () => {
    expect([0, 74, 75, 89, 90, 100].map(meterLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', 'bad']);
  });
  it('exposes a meter with its value and level', () => {
    render(<Meter label="5 h window" value={82} />);
    const m = screen.getByRole('meter', { name: '5 h window' });
    expect(m.getAttribute('aria-valuenow')).toBe('82');
    expect(m.querySelector('[data-level]')?.getAttribute('data-level')).toBe('warn');
  });
});

describe('RadioGroup', () => {
  it('reports the chosen option (segmented)', async () => {
    const onChange = vi.fn();
    render(
      <RadioGroup label="Appearance" appearance="segmented" defaultValue="auto" onChange={onChange}>
        <Radio value="auto">Auto</Radio><Radio value="light">Light</Radio><Radio value="dark">Dark</Radio>
      </RadioGroup>,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
    // the chosen option, and only it, draws the block
    const blocks = document.querySelectorAll('[data-sel]');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].closest('label')!.textContent).toBe('Dark');
  });
});

describe('Segmented', () => {
  it('switches the selected segment', async () => {
    const onChange = vi.fn();
    render(<Segmented aria-label="View" value="chat" onChange={onChange}><Segment id="chat">Chat</Segment><Segment id="term">Terminal</Segment></Segmented>);
    await userEvent.click(screen.getByRole('radio', { name: 'Terminal' }));
    expect(onChange).toHaveBeenCalledWith('term');
  });
});

describe('Disclosure', () => {
  it('keeps the panel hidden until expanded', async () => {
    render(<Disclosure title="Release notes">the notes</Disclosure>);
    const trigger = screen.getByRole('button', { name: /Release notes/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('the notes')).toBeTruthy();
  });
});

describe('Toast', () => {
  it('shows a queued toast in the region; an error does not time out', () => {
    render(<ToastRegion />);
    act(() => { toast('Saved: applies at next roll', 'ok'); });
    expect(screen.getByText('Saved: applies at next roll')).toBeTruthy();
    let key = '';
    act(() => { key = toast('Restart failed', 'bad'); });
    const queued = toastQueue.visibleToasts.find((t) => t.key === key);
    expect(queued?.timeout).toBeUndefined();
    act(() => { toastQueue.visibleToasts.forEach((t) => toastQueue.close(t.key)); });
  });
});

describe('Banner and Skeleton', () => {
  it('announce themselves', () => {
    render(<><Banner tone="bad">Session ended</Banner><Banner>2 things need you</Banner><Skeleton /></>);
    expect(screen.getByRole('alert').textContent).toContain('Session ended');
    expect(screen.getAllByRole('status').map((n) => n.getAttribute('aria-label') ?? n.textContent)).toEqual(['2 things need you', 'Loading']);
  });
});

describe('AnimatedItems', () => {
  it('renders the first list without any entrance state (content visible)', () => {
    render(<MotionRoot><ul><AnimatedItems>{['a', 'b'].map((k) => <ListItem key={k}>{k}</ListItem>)}</AnimatedItems></ul></MotionRoot>);
    for (const li of screen.getAllByRole('listitem')) {
      expect(li.style.opacity === '' || li.style.opacity === '1').toBe(true);
      expect(li.style.transform === '' || li.style.transform === 'none').toBe(true);
    }
  });
});

describe('icons', () => {
  it('every mark draws something and has at most one solid part', () => {
    const { container } = render(<>{ICON_NAMES.map((n) => <Icon key={n} name={n} data-n={n} />)}{NAV_ICON_NAMES.map((n) => <NavIcon key={n} name={n} data-n={n} />)}</>);
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(ICON_NAMES.length + NAV_ICON_NAMES.length);
    for (const s of svgs) {
      expect(s.children.length, s.dataset.n).toBeGreaterThan(0);
      expect(s.querySelectorAll('.solid').length, s.dataset.n).toBeLessThanOrEqual(1);
      expect(s.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
