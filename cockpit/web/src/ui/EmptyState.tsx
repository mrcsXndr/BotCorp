import type { ReactNode } from 'react';

// An empty list or screen: one line of at most four words in --text-2, and at
// most one action under it. No mark, no illustration, no paragraph. `inline`
// sits it on the left, as a row inside a section, instead of centred.
export function EmptyState({ children, action, inline = false, className = '' }: { children: ReactNode; action?: ReactNode; inline?: boolean; className?: string }) {
  return (
    <div data-empty className={`flex flex-col gap-3 ${inline ? 'items-start py-2' : 'items-center justify-center px-4 py-10 text-center'} ${className}`}>
      <span className="text-ui text-text-2">{children}</span>
      {action}
    </div>
  );
}
