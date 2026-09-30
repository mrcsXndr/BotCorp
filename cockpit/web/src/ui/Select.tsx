import type { ReactNode } from 'react';
import {
  Button, FieldError, Label, ListBox, ListBoxItem, Popover, Select as RACSelect, SelectValue, Text,
  type ListBoxItemProps, type SelectProps as RACSelectProps,
} from 'react-aria-components';
import { Icon } from '../icons';

// A labelled select: a 44px field-toned button with the value and a chevron,
// opening a popover list the width of the field. The chosen row carries a check.
export interface SelectProps<T extends object> extends Omit<RACSelectProps<T>, 'className' | 'children'> {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  items?: Iterable<T>;
  children: ReactNode | ((item: T) => ReactNode);
  className?: string;
}

export function Select<T extends object>({ label, description, errorMessage, items, children, className = '', ...rest }: SelectProps<T>) {
  return (
    <RACSelect {...rest} className={`group flex flex-col gap-1.5 ${className}`}>
      {label != null && <Label className="text-sm font-semibold text-text">{label}</Label>}
      <Button className="flex items-center gap-2 min-h-[var(--tap)] w-full px-3 rounded-btn bg-field border border-line-strong text-left text-body text-text
        outline-none cursor-default transition-colors duration-[var(--t-fast)] ease-std data-[hovered]:border-text-3 data-[pressed]:bg-task
        data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent data-[focus-visible]:outline-offset-1 group-data-[invalid]:border-bad">
        <SelectValue className="flex-1 truncate data-[placeholder]:text-text-3" />
        <Icon name="chev" className="text-text-2 transition-transform duration-[var(--t-fast)] ease-std group-data-[open]:rotate-180" />
      </Button>
      {description != null && <Text slot="description" className="text-sm text-text-2">{description}</Text>}
      <FieldError className="text-sm text-bad">{errorMessage}</FieldError>
      <Popover offset={4} className="popover w-[var(--trigger-width)] rounded-card bg-surface shadow-2 p-1 outline-none">
        <ListBox items={items} className="outline-none max-h-[50dvh] overflow-y-auto">
          {children}
        </ListBox>
      </Popover>
    </RACSelect>
  );
}

export function SelectItem({ className = '', children, ...rest }: Omit<ListBoxItemProps, 'className'> & { className?: string }) {
  const textValue = rest.textValue ?? (typeof children === 'string' ? children : undefined);
  return (
    <ListBoxItem {...rest} textValue={textValue}
      className={`flex items-center gap-3 min-h-[var(--tap)] px-3 rounded-btn text-ui text-text cursor-default outline-none
        data-[focused]:bg-hover data-[selected]:font-semibold ${className}`}>
      {(rp) => (
        <>
          <span className="flex-1 truncate">{typeof children === 'function' ? children(rp) : children}</span>
          {rp.isSelected && <Icon name="check" className="text-accent" />}
        </>
      )}
    </ListBoxItem>
  );
}
