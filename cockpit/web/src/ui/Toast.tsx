// The one toast region. RAC's toast API is still UNSTABLE_ in 1.21, so it is
// wrapped here: a swap to the stable names (or a hand-rolled aria-live region)
// touches this file only.
import {
  UNSTABLE_Toast as RACToast, UNSTABLE_ToastContent as ToastContent, UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as RACToastRegion, Button, Text,
} from 'react-aria-components';
import { Icon } from '../icons';

export interface ToastData { text: string; tone?: 'ok' | 'bad' }

// A toast slides up once as it mounts (.toast in app.css); its resting style is
// the shown state, so a skipped animation still shows it.
export const toastQueue = new ToastQueue<ToastData>({ maxVisibleToasts: 3 });

/** Show a toast. Errors stay until dismissed; everything else leaves after 5 s. */
export function toast(text: string, tone?: ToastData['tone']) {
  return toastQueue.add({ text, tone }, tone === 'bad' ? {} : { timeout: 5000 });
}

export function ToastRegion() {
  return (
    <RACToastRegion queue={toastQueue}
      className="fixed z-[60] left-4 right-4 bottom-[calc(var(--nav-h)+12px+env(safe-area-inset-bottom))] flex flex-col-reverse gap-2 outline-none
        sm:left-auto sm:right-6 sm:bottom-6 sm:w-[380px]">
      {({ toast: t }) => (
        <RACToast toast={t}
          className="toast flex items-start gap-3 pl-4 pr-1 py-1 rounded-card bg-surface shadow-2 outline-none
            data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent">
          {t.content.tone && (
            <Icon name={t.content.tone === 'bad' ? 'warn' : 'check'} className={`mt-3.5 ${t.content.tone === 'bad' ? 'text-bad' : 'text-ok'}`} />
          )}
          <ToastContent className="flex-1 min-w-0 py-2.5">
            <Text slot="title" className={`block text-ui leading-ui ${t.content.tone === 'bad' ? 'text-bad' : 'text-text'}`}>{t.content.text}</Text>
          </ToastContent>
          <Button slot="close" aria-label="Dismiss"
            className="grid place-items-center size-[var(--tap)] flex-none rounded-btn text-text-2 outline-none cursor-default
              data-[hovered]:bg-hover data-[pressed]:bg-press data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent">
            <Icon name="x" />
          </Button>
        </RACToast>
      )}
    </RACToastRegion>
  );
}
