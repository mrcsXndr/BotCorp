import type { ReactNode } from 'react';
import { Switch as RACSwitch, type SwitchProps as RACSwitchProps } from 'react-aria-components';

// A squared switch (the house shapes have corners, not pills): a 44x26 track
// in --switch-off that fills with the accent when on; the knob slides.
export interface SwitchProps extends Omit<RACSwitchProps, 'className' | 'children'> {
  children?: ReactNode;
  /** a --text-2 line under the label */
  description?: ReactNode;
  className?: string;
}

export function Switch({ children, description, className = '', ...rest }: SwitchProps) {
  return (
    <RACSwitch {...rest}
      className={`group flex items-center gap-3 min-h-[var(--tap)] cursor-default outline-none data-[disabled]:opacity-60 ${className}`}>
      {children != null && (
        <span className="flex-1 min-w-0">
          <span className="block text-ui text-text leading-ui">{children}</span>
          {description != null && <span className="block text-sm text-text-2 leading-ui">{description}</span>}
        </span>
      )}
      <span aria-hidden
        className="relative flex-none w-11 h-[26px] rounded-btn bg-[var(--switch-off)] transition-colors duration-[var(--t-fast)] ease-std
          group-data-[selected]:bg-accent group-data-[pressed]:bg-text-3 group-data-[selected]:group-data-[pressed]:bg-accent-press
          group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-accent group-data-[focus-visible]:outline-offset-2">
        <span className="absolute top-[3px] left-[3px] size-5 rounded-xs bg-[var(--switch-knob)] shadow-1 transition-[transform,background-color] duration-[var(--t-fast)] ease-std
          group-data-[selected]:translate-x-[18px] group-data-[selected]:bg-accent-ink" />
      </span>
    </RACSwitch>
  );
}
