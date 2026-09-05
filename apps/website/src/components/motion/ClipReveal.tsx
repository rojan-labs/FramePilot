'use client';

import { motion, useReducedMotion, type Variants } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * A section entering the page behaves like a clip snapping onto a track: it
 * slides a short distance along the timeline and its edge wipes open. It is
 * deliberately quick and horizontal — this is a cut, not a decorative fade, and
 * it is applied to whole blocks rather than to individual lines of body copy.
 *
 * Under `prefers-reduced-motion` the element renders in its final state with
 * the same DOM shape, so there is no hydration difference. With JavaScript
 * disabled the `<noscript>` rule in the root layout forces every
 * `[data-clip-reveal]` element visible.
 */

const SNAP: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function ClipReveal({
  children,
  delay = 0,
  from = 'left',
  /** Disable the wipe when the child has overflow that must not be clipped. */
  wipe = true,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  from?: 'left' | 'right' | 'up';
  wipe?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();

  const offset = from === 'up' ? { y: 16 } : { x: from === 'left' ? -18 : 18 };
  const hidden = reduce
    ? { opacity: 1 }
    : {
        opacity: 0,
        ...offset,
        ...(wipe ? { clipPath: from === 'right' ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)' } : {}),
      };
  const shown = reduce
    ? { opacity: 1 }
    : { opacity: 1, x: 0, y: 0, ...(wipe ? { clipPath: 'inset(0 0 0 0)' } : {}) };

  return (
    <motion.div
      data-clip-reveal
      className={className}
      initial={hidden}
      whileInView={shown}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: reduce ? 0 : 0.52, ease: SNAP, delay: reduce ? 0 : delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Parent for a run of clips that snap onto the same track one after another.
 * Pair with `ClipRow` children.
 */
export function ClipTrack({
  children,
  className = '',
  stagger = 0.06,
  as = 'div',
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
  as?: 'div' | 'ol' | 'ul';
}) {
  const reduce = useReducedMotion();
  const Component = as === 'ol' ? motion.ol : as === 'ul' ? motion.ul : motion.div;

  return (
    <Component
      data-clip-reveal
      className={className}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: '0px 0px -10% 0px' }}
      variants={{ hidden: {}, shown: { transition: { staggerChildren: reduce ? 0 : stagger } } }}
    >
      {children}
    </Component>
  );
}

const ROW_VARIANTS: Variants = {
  hidden: { opacity: 0, x: -14, clipPath: 'inset(0 100% 0 0)' },
  shown: { opacity: 1, x: 0, clipPath: 'inset(0 0 0 0)', transition: { duration: 0.46, ease: SNAP } },
};

const ROW_VARIANTS_STILL: Variants = { hidden: { opacity: 1 }, shown: { opacity: 1 } };

export function ClipRow({
  children,
  className = '',
  as = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li';
}) {
  const reduce = useReducedMotion();
  const Component = as === 'li' ? motion.li : motion.div;
  return (
    <Component className={className} variants={reduce ? ROW_VARIANTS_STILL : ROW_VARIANTS}>
      {children}
    </Component>
  );
}
