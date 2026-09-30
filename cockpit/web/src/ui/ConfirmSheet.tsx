import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Button } from './Button';

// The confirm before a destructive action (IA §7): an alertdialog (a bottom
// sheet under 640px), a title of at most 5 words, one consequence line of at
// most 10, Cancel and the verb ("Restart atlas") in --bad. Never
// window.confirm(). Escape or Cancel declines; the verb confirms. `safe` marks a
// consequential but non-destructive action: its verb is the plain primary.
export interface ConfirmOptions { title: string; body: string; verb: string; cancel: string; safe?: boolean }

export function ConfirmSheet({ isOpen, title, body, verb, cancel, safe, onDecide }: ConfirmOptions & { isOpen: boolean; onDecide: (ok: boolean) => void }) {
  return (
    <Sheet role="alertdialog" isOpen={isOpen} isDismissable={false} isKeyboardDismissDisabled={false}
      onOpenChange={(o) => { if (!o) onDecide(false); }} title={title}
      footer={<>
        <Button variant="quiet" onPress={() => onDecide(false)}>{cancel}</Button>
        <Button variant={safe ? 'primary' : 'danger-primary'} data-confirm onPress={() => onDecide(true)}>{verb}</Button>
      </>}>
      <p className="m-0 text-ui text-text-2 leading-ui">{body}</p>
    </Sheet>
  );
}

/** `ask(options)` opens the ConfirmSheet and resolves true on the verb, false on Cancel. Render `sheet` once. */
export function useConfirm(): [ReactNode, (o: ConfirmOptions) => Promise<boolean>] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOpts(o);
  }), []);
  const decide = (ok: boolean) => { const r = resolver.current; resolver.current = null; setOpts(null); r?.(ok); };
  const sheet = <ConfirmSheet isOpen={!!opts} title={opts?.title ?? ''} body={opts?.body ?? ''} verb={opts?.verb ?? ''} cancel={opts?.cancel ?? ''} safe={opts?.safe} onDecide={decide} />;
  return [sheet, ask];
}
