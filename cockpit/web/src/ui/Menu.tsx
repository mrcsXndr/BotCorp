import type { ReactNode } from 'react';
import {
  Menu as RACMenu, MenuItem as RACMenuItem, MenuTrigger, Popover, Separator,
  type MenuItemProps, type MenuProps as RACMenuProps,
} from 'react-aria-components';
import { IconButton } from './IconButton';
import { Icon, type IconName } from '../icons';

// An overflow menu: a quiet "more" icon button opening a popover of 44px rows.
// A destructive row is --bad text; nothing in a menu is a filled button.
export interface MenuProps<T> extends Omit<RACMenuProps<T>, 'className'> {
  label: string;
  trigger?: ReactNode;
}

export function Menu<T extends object>({ label, trigger, children, ...rest }: MenuProps<T>) {
  return (
    <MenuTrigger>
      {trigger ?? <IconButton icon="more" label={label} />}
      <Popover placement="bottom end" offset={4}
        className="popover min-w-[220px] max-w-[calc(100vw-32px)] rounded-card bg-surface shadow-2 p-1 outline-none">
        <RACMenu {...rest} aria-label={label} className="outline-none max-h-[70dvh] overflow-y-auto">
          {children}
        </RACMenu>
      </Popover>
    </MenuTrigger>
  );
}

export function MenuItem({ icon, tone, className = '', children, ...rest }:
  Omit<MenuItemProps, 'className'> & { icon?: IconName; tone?: 'bad'; className?: string }) {
  const textValue = rest.textValue ?? (typeof children === 'string' ? children : undefined);
  return (
    <RACMenuItem {...rest} textValue={textValue}
      className={`flex items-center gap-3 min-h-[var(--tap)] px-3 rounded-btn text-ui cursor-default outline-none
        ${tone === 'bad' ? 'text-bad' : 'text-text'} data-[focused]:bg-hover data-[pressed]:bg-press data-[disabled]:text-text-3 ${className}`}>
      {(rp) => (
        <>
          {icon && <Icon name={icon} className={tone === 'bad' ? '' : 'text-text-2'} />}
          <span className="flex-1">{typeof children === 'function' ? children(rp) : children}</span>
        </>
      )}
    </RACMenuItem>
  );
}

export function MenuSeparator() {
  return <Separator className="my-1 mx-3 h-px bg-line" />;
}
