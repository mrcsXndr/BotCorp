import type { ReactNode } from 'react';

/** A screen title in the display face, with an optional mono count and a right-hand slot. */
export function ScreenHeader({ children, count, right }: { children: ReactNode; count?: number; right?: ReactNode }) {
  return (
    <header className="flex items-center gap-3 px-4 pt-[max(20px,env(safe-area-inset-top))] pb-3">
      <h1 className="m-0 flex-1 min-w-0 font-display text-2xl leading-tight text-text">
        {children}{count != null && <span className="num ml-2 align-[3px] text-lg text-text-3 font-normal">{count}</span>}
      </h1>
      {right}
    </header>
  );
}
