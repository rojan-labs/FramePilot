'use client';

import { useEffect, useState } from 'react';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useIntro } from './IntroProvider';
import { RETIRED_NAMES, ToolGlyph } from './ToolTiles';

const BIN_W = 62;
const BIN_H = 78;

/** Where the discarded icons sit once they are in: four piled above the rim… */
const PILE = [
  { x: 4, y: -6, rot: -20, size: 30 },
  { x: 30, y: -12, rot: 14, size: 32 },
  { x: 16, y: -1, rot: -3, size: 28 },
  { x: 40, y: 2, rot: 28, size: 26 },
] as const;

/** …and two that missed and lie on the floor beside it (desktop only; on a phone the corner is too tight). */
const BESIDE = [
  { x: -40, y: BIN_H - 30, rot: -26, size: 30 },
  { x: -18, y: BIN_H - 22, rot: 16, size: 24 },
] as const;

/**
 * The bin lives in the corner of the landing page for the whole visit. It is
 * the editor's bin and a dustbin at once: the tools the intro threw out are
 * still in it, plainly visible, and it says which ones on hover or focus.
 */
export function Dustbin() {
  const { binRef, discarded, lidOpen } = useIntro();
  const reduce = useReducedMotion();
  const controls = useAnimationControls();
  const [open, setOpen] = useState(false);

  // A small squash each time something lands, so the drop has weight.
  useEffect(() => {
    if (discarded.length === 0 || reduce) return;
    void controls.start({
      scaleY: [1, 0.9, 1.04, 1],
      scaleX: [1, 1.08, 0.98, 1],
      transition: { duration: 0.34, ease: 'easeOut' },
    });
  }, [discarded.length, controls, reduce]);

  const shake = () => {
    if (reduce) return;
    void controls.start({
      rotate: [0, -6, 5, -3, 0],
      transition: { duration: 0.42, ease: 'easeInOut' },
    });
  };

  const inBin = discarded.slice(0, PILE.length);
  const onFloor = discarded.slice(PILE.length, PILE.length + BESIDE.length);
  const full = discarded.length > 0;

  return (
    <div
      className="pointer-events-none fixed z-[60]"
      style={{
        right: 'calc(16px + env(safe-area-inset-right, 0px))',
        bottom: 'calc(14px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <div className="pointer-events-auto relative">
        {open && (
          <div
            role="tooltip"
            className="absolute bottom-[calc(100%+14px)] right-0 w-[212px] rounded-md border border-line-strong bg-elevated px-3 py-2.5 shadow-[0_10px_30px_rgba(23,20,15,0.14)]"
          >
            <p className="tc text-accent">Retired from this timeline</p>
            <p className="mt-1.5 text-[12px] leading-[18px] text-fg-secondary">
              {RETIRED_NAMES.join(', ')}
            </p>
          </div>
        )}

        <motion.button
          ref={binRef}
          type="button"
          data-intro-bin
          aria-label={`The bin. Retired from this timeline: ${RETIRED_NAMES.join(', ')}.`}
          onClick={shake}
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          animate={controls}
          style={{ width: BIN_W, height: BIN_H, transformOrigin: '50% 100%' }}
          className="relative block origin-bottom scale-[0.82] rounded-md sm:scale-100"
        >
          {/* In the bin: drawn behind the body, so the rim cuts them off. */}
          {inBin.map((tile, index) => {
            const slot = PILE[index];
            return (
              <motion.span
                key={tile.id}
                aria-hidden
                className="absolute z-0 block"
                style={{ left: slot.x, top: slot.y, width: slot.size, height: slot.size }}
                initial={reduce ? false : { y: -14, opacity: 0, rotate: slot.rot - 40 }}
                animate={{ y: 0, opacity: 1, rotate: slot.rot }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              >
                <ToolGlyph tile={tile} size="100%" />
              </motion.span>
            );
          })}

          <svg
            viewBox={`0 0 ${BIN_W} ${BIN_H}`}
            width={BIN_W}
            height={BIN_H}
            aria-hidden
            focusable="false"
            className="absolute inset-0 z-10"
          >
            {/* Lid, hinged at its left edge. Open wide while things land, then
                left leaning back once the bin is full, so the pile shows. */}
            <motion.g
              animate={{ rotate: lidOpen ? -60 : full ? -108 : 0 }}
              transition={{ type: 'spring', stiffness: 240, damping: 18 }}
              style={{ originX: '9px', originY: '24px' }}
            >
              <rect x="8" y="18" width="46" height="7" rx="3" fill="var(--color-fg)" />
              <rect x="23" y="12" width="16" height="5.5" rx="2.6" fill="var(--color-fg)" />
            </motion.g>

            {/* Rim and body. Opaque, so the pile only shows above the rim. */}
            <rect x="6" y="26" width="50" height="7.5" rx="3.2" fill="var(--color-fg)" />
            <path
              d="M11 34.5 H51 L47.4 72.4 A3.4 3.4 0 0 1 44 75.5 H18 A3.4 3.4 0 0 1 14.6 72.4 Z"
              fill="var(--color-canvas)"
              stroke="var(--color-fg)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
            <path
              d="M23.5 42 L22.2 66 M31 42 L31 66 M38.5 42 L39.8 66"
              stroke="var(--color-fg)"
              strokeOpacity="0.26"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </svg>

          {/* On the floor beside the bin: the ones that missed. */}
          {onFloor.map((tile, index) => {
            const slot = BESIDE[index];
            return (
              <motion.span
                key={tile.id}
                aria-hidden
                className="absolute z-20 hidden sm:block"
                style={{ left: slot.x, top: slot.y, width: slot.size, height: slot.size }}
                initial={reduce ? false : { y: -30, opacity: 0, rotate: slot.rot + 60 }}
                animate={{ y: 0, opacity: 1, rotate: slot.rot }}
                transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}
              >
                <ToolGlyph tile={tile} size="100%" />
              </motion.span>
            );
          })}
        </motion.button>
      </div>
    </div>
  );
}
