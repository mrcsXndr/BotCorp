import { Button as RACButton, type ButtonProps as RACButtonProps } from 'react-aria-components';
import { Icon, type IconName } from '../icons';

// A bare icon in a 44px square target: no tile behind the mark at rest, a
// tonal wash on hover and press. The label is required (it is the only name).
export interface IconButtonProps extends Omit<RACButtonProps, 'className' | 'children'> {
  icon: IconName;
  label: string;
  /** 'accent' fills the square: the composer's send, the one primary */
  tone?: 'quiet' | 'accent';
  size?: number;
  className?: string;
}

export function IconButton({ icon, label, tone = 'quiet', size = 18, className = '', ...rest }: IconButtonProps) {
  const toneClass = tone === 'accent'
    ? 'bg-accent text-accent-ink data-[hovered]:bg-accent-hover data-[pressed]:bg-accent-press data-[disabled]:bg-transparent data-[disabled]:text-text-3'
    : 'text-text-2 data-[hovered]:bg-hover data-[hovered]:text-text data-[pressed]:bg-press data-[disabled]:text-text-3';
  return (
    <RACButton {...rest} aria-label={label}
      className={`inline-grid place-items-center size-[var(--tap)] flex-none rounded-btn outline-none select-none cursor-default ` +
        `transition-[background-color,color,transform] duration-[var(--t-fast)] ease-std data-[pressed]:scale-[.96] ` +
        `data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent data-[focus-visible]:outline-offset-2 ${toneClass} ${className}`}>
      <Icon name={icon} size={size} />
    </RACButton>
  );
}
