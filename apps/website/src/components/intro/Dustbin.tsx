'use client';

import { useEffect, useState } from 'react';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useIntro } from './IntroProvider';
import { RETIRED_NAMES, ToolGlyph } from './ToolTiles';

const BIN_W = 46;
const BIN_H = 58;

/**
 * The bin lives in the corner of the landing page for the whole visit. It is
 * the editor's bin and a dustbin at once: the tools the intro ripple-deleted
 * are still in it, tops sticking out, and it says which ones on hover or focus.
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
      scaleY: [1, 0.88, 1.04, 1],
      scaleX: [1, 1.1, 0.98, 1],
      transition: { duration: 0.34, ease: 'easeOut' },
    });
  }, [discarded.length, controls, reduce]);

  const shake = () => {
    if (reduce) return;
    void controls.start({
      rotate: [0, -7, 6, -4, 0],
      transition: { duration: 0.42, ease: 'easeInOut' },
    });
  };

  const peeking = discarded.slice(-4);

  return (
    <div
      className="pointer-events-none fixed z-[60]"
      style={{
        right: 'calc(14px + env(safe-area-inset-right, 0px))',
        bottom: 'calc(14px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <div className="pointer-events-auto relative">
        {open && (
          <div
            role="tooltip"
            className="absolute bottom-[calc(100%+10px)] right-0 w-[196px] rounded-md border border-line-strong bg-elevated px-3 py-2.5 shadow-[0_10px_30px_rgba(23,20,15,0.14)]"
          >
            <p className="tc text-accent">Retired from this timeline</p>
            <p className="mt-1.5 text-[12px] leading-[18px] text-fg-secondary">
              {RETIRED_NAMES.join(', ')}
            </p>
          </div>
        )}

        <motion.button
          /* The track measures this element to aim each cut tile at it. */
          ref={(node) => {
            binRef.current = node;
          }}
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
          className="relative block scale-90 rounded-md sm:scale-100"
        >
          {/* Tops of the discarded tiles, clipped by the rim below them. */}
          <span
            aria-hidden
            className="absolute left-[8px] right-[8px] flex h-[11px] items-end justify-center gap-[3px] overflow-hidden"
            style={{ bottom: `${BIN_H - 23}px` }}
          >
            {peeking.map((tile, index) => (
              <span
                key={tile.id}
                className="block"
                style={{ transform: `translateY(6px) rotate(${(index - 1.5) * 7}deg)` }}
              >
                <ToolGlyph tile={tile} size={15} />
              </span>
            ))}
          </span>

          <svg
            viewBox={`0 0 ${BIN_W} ${BIN_H}`}
            width={BIN_W}
            height={BIN_H}
            aria-hidden
            focusable="false"
            className="absolute inset-0"
          >
            {/* Lid, hinged at its left edge. */}
            <motion.g
              animate={{ rotate: lidOpen ? -46 : discarded.length > 0 ? -16 : 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 18 }}
              style={{ originX: '7px', originY: '18px' }}
            >
              <rect x="6" y="13" width="34" height="5.5" rx="2.4" fill="var(--color-fg)" />
              <rect x="17" y="8.5" width="12" height="4.2" rx="2.1" fill="var(--color-fg)" />
            </motion.g>

            {/* Rim and body. Opaque, so the tiles behind it only show at the top. */}
            <rect x="5" y="20" width="36" height="5.6" rx="2.4" fill="var(--color-fg)" />
            <path
              d="M8.4 26.4 H37.6 L35 53.4 A2.6 2.6 0 0 1 32.4 55.8 H13.6 A2.6 2.6 0 0 1 11 53.4 Z"
              fill="var(--color-canvas)"
              stroke="var(--color-fg)"
              strokeWidth="2.4"
              strokeLinejoin="round"
            />
            <path
              d="M17.6 32 L16.6 49 M23 32 L23 49 M28.4 32 L29.4 49"
              stroke="var(--color-fg)"
              strokeOpacity="0.28"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </motion.button>
      </div>
    </div>
  );
}
