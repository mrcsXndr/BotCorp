import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icons';

// A one-line notice ("2 things need you", an auth link seen in the terminal,
// a session that ended): a tinted fill with a self-coloured edge and the
// tone's house icon, then the text, then at most one action. No accent bar.
const TONE = {
  warn: 'bg-warn-soft shadow-[inset_0_0_0_1px_var(--warn-line)]',
  bad: 'bg-bad-soft shadow-[inset_0_0_0_1px_var(--bad-line)]',
  info: 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent-soft-line)]',
} as const;
const ICON: Record<keyof typeof TONE, [IconName, string]> = { warn: ['warn', 'text-warn'], bad: ['warn', 'text-bad'], info: ['lock', 'text-accent'] };

export interface BannerProps {
  tone?: keyof typeof TONE;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function Banner({ tone = 'warn', children, action, className = '' }: BannerProps) {
  const [icon, color] = ICON[tone];
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} data-tone={tone}
      className={`flex items-center gap-3 min-h-[var(--tap)] pl-3 pr-1 py-1 rounded-btn text-ui text-text ${TONE[tone]} ${className}`}>
      <Icon name={icon} className={color} />
      <div className="flex-1 min-w-0 py-1.5 leading-ui">{children}</div>
      {action}
    </div>
  );
}
