import { useState } from 'react';
import { Button, Tooltip, TooltipTrigger } from 'react-aria-components';

// The "?" beside one of the five complex things (IA §6): hover or focus on a
// desktop, a tap on a phone (a tap toggles it; tapping elsewhere closes it).
// The text is at most 20 words and comes from COPY.tooltip.
export function Hint({ label, children }: { label: string; children: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipTrigger isOpen={open} onOpenChange={setOpen} delay={250} closeDelay={100} shouldCloseOnPress={false}>
      <Button aria-label={label} onPress={() => setOpen((v) => !v)}
        className="inline-grid place-items-center size-6 -my-1 rounded-xs text-xs font-semibold text-text-3 cursor-default outline-none
          transition-colors duration-[var(--t-fast)] ease-std data-[hovered]:text-text data-[pressed]:bg-press
          data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent">
        <span aria-hidden className="grid place-items-center size-4 rounded-xs shadow-[inset_0_0_0_1.5px_currentColor] leading-none">?</span>
      </Button>
      <Tooltip offset={6} className="popover max-w-[260px] px-3 py-2 rounded-btn bg-surface shadow-2 text-sm leading-ui text-text">
        {children}
      </Tooltip>
    </TooltipTrigger>
  );
}
