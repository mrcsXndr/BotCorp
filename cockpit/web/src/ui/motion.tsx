import { forwardRef, type ReactNode } from 'react';
import { AnimatePresence, LazyMotion, MotionConfig, domMax, m, useReducedMotion, type HTMLMotionProps } from 'motion/react';

// Motion for lists only (items arriving, leaving, and the rest closing the gap).
// Rules: at most 200 ms, eased; nothing enters from opacity 0 (an arriving row
// is visible from its first frame and only settles 6px into place); the first
// render never animates; prefers-reduced-motion makes every change instant.
const EASE = [0.2, 0.7, 0.2, 1] as const;

export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: EASE }}>{children}</MotionConfig>
    </LazyMotion>
  );
}

/** Wrap a list's items: keyed <ListItem>s animate in and out; the first render does not. */
export function AnimatedItems({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false} mode="popLayout">{children}</AnimatePresence>;
}

export const ListItem = forwardRef<HTMLLIElement, HTMLMotionProps<'li'>>(function ListItem(props, ref) {
  const reduce = useReducedMotion();
  return (
    <m.li ref={ref} layout="position"
      initial={{ y: -6 }} animate={{ y: 0 }} exit={{ opacity: 0, x: 24 }}
      transition={reduce ? { duration: 0 } : { duration: 0.2, ease: EASE }}
      {...props} />
  );
});
