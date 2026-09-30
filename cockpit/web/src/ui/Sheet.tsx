import type { ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay, type ModalOverlayProps } from 'react-aria-components';
import { IconButton } from './IconButton';

// A sheet: docked to the bottom edge on a phone (full width, at most 88dvh,
// top corners rounded, slides up), a centred dialog from 640px. The open
// state is the resting style: the slide is an animation from off-screen, so
// a skipped animation still shows the whole sheet.
export interface SheetProps extends Omit<ModalOverlayProps, 'className' | 'children'> {
  title: ReactNode;
  /** one --text-2 line on what the sheet is for */
  description?: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  /** pinned under the scrolling body: the sheet's action row */
  footer?: ReactNode | ((close: () => void) => ReactNode);
  /** 'alertdialog' for a confirm */
  role?: 'dialog' | 'alertdialog';
}

export function Sheet({ title, description, children, footer, role = 'dialog', isDismissable = true, ...rest }: SheetProps) {
  return (
    <ModalOverlay {...rest} isDismissable={isDismissable}
      className="sheet-overlay fixed inset-0 z-50 flex items-end justify-center bg-scrim sm:items-center sm:p-6">
      <Modal className="sheet w-full max-h-[88dvh] flex flex-col bg-surface shadow-2 outline-none
        rounded-t-card sm:rounded-card sm:max-w-[520px] sm:max-h-[80dvh]">
        <Dialog role={role} className="flex flex-col min-h-0 flex-1 outline-none">
          {({ close }) => (
            <>
              <header className="flex items-start gap-2 pl-5 pr-2 pt-3">
                <div className="flex-1 min-w-0 pt-2">
                  <Heading slot="title" className="m-0 text-lg font-semibold leading-tight text-text">{title}</Heading>
                  {description != null && <p className="m-0 mt-1 text-sm text-text-2 leading-ui">{description}</p>}
                </div>
                <IconButton icon="x" label="Close" onPress={close} />
              </header>
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-3 pb-5">
                {typeof children === 'function' ? children(close) : children}
              </div>
              {footer != null && (
                <footer className="grid auto-cols-fr grid-flow-col gap-2 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] bg-surface">
                  {typeof footer === 'function' ? footer(close) : footer}
                </footer>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
