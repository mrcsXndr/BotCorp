import type { ReactNode } from 'react';
import {
  Button, Disclosure as RACDisclosure, DisclosurePanel, Heading, type DisclosureProps as RACDisclosureProps,
} from 'react-aria-components';
import { Icon } from '../icons';

// A quiet disclosure: a 44px trigger row (title, optional meta, a chevron
// that turns), then the panel. Collapsed content is hidden by the disclosure
// itself, never by an animation.
export interface DisclosureProps extends Omit<RACDisclosureProps, 'className' | 'children'> {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Disclosure({ title, meta, children, className = '', ...rest }: DisclosureProps) {
  return (
    <RACDisclosure {...rest} className={`group ${className}`}>
      <Heading className="m-0">
        <Button slot="trigger"
          className="flex w-full items-center gap-2 min-h-[var(--tap)] px-1 -mx-1 rounded-btn text-left text-ui font-semibold text-text cursor-default outline-none
            data-[hovered]:bg-hover data-[pressed]:bg-press data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent">
          <Icon name="chev" className="text-text-2 -rotate-90 transition-transform duration-[var(--t-fast)] ease-std group-data-[expanded]:rotate-0" />
          <span className="flex-1">{title}</span>
          {meta != null && <span className="text-sm font-normal text-text-3">{meta}</span>}
        </Button>
      </Heading>
      <DisclosurePanel className="text-ui text-text-2 leading-body">
        <div className="pl-6 pb-2">{children}</div>
      </DisclosurePanel>
    </RACDisclosure>
  );
}
