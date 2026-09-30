import { Button as RACButton, type ButtonProps as RACButtonProps } from 'react-aria-components';
import { Icon, type IconName } from '../icons';

export type ButtonVariant = 'primary' | 'tonal' | 'secondary' | 'quiet' | 'danger';

// Primary = the accent fill, one per view. Tonal = accent text on the soft
// accent: a positive action that repeats down a list (Approve on every card)
// without breaking "one primary per view". Secondary = the surface with a
// strong edge. Quiet = text only. Danger = a quiet button in --bad; a
// destructive primary is a filled --bad. Nothing moves on hover: state is a
// tone shift; a press darkens and settles 2% smaller.
const base =
  'inline-flex items-center justify-center gap-2 min-h-[var(--tap)] px-4 rounded-btn border border-transparent font-ui text-ui font-semibold leading-ui ' +
  'select-none cursor-default transition-[background-color,color,border-color,transform] duration-[var(--t-fast)] ease-std ' +
  'data-[pressed]:scale-[.98] outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent data-[focus-visible]:outline-offset-2 ' +
  'data-[disabled]:bg-transparent data-[disabled]:text-text-3 data-[disabled]:border-dashed data-[disabled]:border-line-strong data-[disabled]:shadow-none';

export const buttonClass: Record<ButtonVariant | 'danger-primary', string> = {
  primary: 'bg-accent text-accent-ink shadow-1 data-[hovered]:bg-accent-hover data-[pressed]:bg-accent-press',
  tonal: 'bg-accent-soft text-accent border-accent-soft-line data-[hovered]:border-accent data-[pressed]:bg-accent-soft-line',
  secondary: 'bg-surface text-text border-line-strong shadow-1 data-[hovered]:bg-task data-[pressed]:bg-accent-soft',
  quiet: 'bg-transparent text-text-2 data-[hovered]:bg-hover data-[hovered]:text-text data-[pressed]:bg-press',
  danger: 'bg-transparent text-bad data-[hovered]:bg-bad-soft data-[pressed]:bg-press',
  'danger-primary': 'bg-bad text-bad-ink shadow-1 data-[pressed]:bg-bad',
};

export interface ButtonProps extends Omit<RACButtonProps, 'className'> {
  variant?: ButtonVariant | 'danger-primary';
  icon?: IconName;
  className?: string;
  /** full width: a sheet's action row on a phone */
  block?: boolean;
}

export function Button({ variant = 'secondary', icon, className = '', block, children, ...rest }: ButtonProps) {
  return (
    <RACButton {...rest} data-variant={variant}
      className={`${base} ${buttonClass[variant]} ${block ? 'w-full' : ''} ${className}`}>
      {(rp) => (
        <>
          {icon && <Icon name={icon} />}
          {typeof children === 'function' ? children(rp) : children}
        </>
      )}
    </RACButton>
  );
}
