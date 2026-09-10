'use client';

import { useEffect, useState } from 'react';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useIntro } from './IntroProvider';
import { RETIRED_NAMES, ToolGlyph } from './ToolTiles';

/*
 * The bin lives in the corner of the landing page for the whole visit. It is
 * the editor's bin and a dustbin at once: the tools the intro threw out are
 * still in it.
 *
 * It carries no visible label. Pointing at it lifts the lid and fans the
 * discarded tools out above the rim — the icons themselves are the caption, so
 * there is nothing to read. The names stay on the button's accessible name for
 * anyone who cannot see the fan.
 */

const BIN_W = 72;
const BIN_H = 96;

/** The rim, in viewBox units. Everything else is measured from it. */
const RIM_CX = 36;
const RIM_CY = 32;
const RIM_RX = 26;
const RIM_RY = 5.5;

/**
 * Where a tool comes to rest once it is in: a heap in the mouth of the bin,
 * only the upper part of each tile clearing the rim. Drawn behind the front of
 * the bin, so the rim itself does the cropping.
 */
const HEAP = [
  { x: 10, y: 18, rot: -24, size: 26 },
  { x: 34, y: 16, rot: 15, size: 26 },
  { x: 21, y: 9, rot: -7, size: 27 },
  { x: 40, y: 11, rot: 26, size: 24 },
  { x: 28, y: 3, rot: -15, size: 24 },
  { x: 14, y: 6, rot: 9, size: 23 },
] as const;

/** How far above the bin the fan sits, and how wide it spreads. */
const FAN_SPAN = 104;
const FAN_LEFT = -64;
const FAN_RISE = 62;
const FAN_ARC = 18;
const FAN_SIZE = 28;

/** A tile's resting place in the fan, given its index and the number shown. */
function fanSlot(index: number, count: number) {
  const t = count > 1 ? index / (count - 1) : 0.5;
  return {
    x: FAN_LEFT + t * FAN_SPAN,
    y: -FAN_RISE - Math.sin(Math.PI * t) * FAN_ARC,
    rot: -18 + t * 36,
    size: FAN_SIZE,
  };
}

/** The lid's three positions: shut on the rim, ajar, and swung back. */
const LID_SHUT = { rotate: 0, x: 0, y: 0 } as const;
const LID_AJAR = { rotate: -12, x: -1, y: -2 } as const;
const LID_OPEN = { rotate: -32, x: -2, y: -5 } as const;

/** A drop with weight: fast fall, one small bounce, then still. */
const DROP = { type: 'spring', stiffness: 620, damping: 17, mass: 1.1 } as const;
/** The fan opens and shuts more gently than a tool falls. */
const FAN = { type: 'spring', stiffness: 320, damping: 26, mass: 0.7 } as const;

export function Dustbin() {
  const { binRef, discarded, lidOpen } = useIntro();
  const reduce = useReducedMotion();
  const controls = useAnimationControls();
  const [open, setOpen] = useState(false);

  // The bin takes the impact each time something lands.
  useEffect(() => {
    if (discarded.length === 0 || reduce) return;
    void controls.start({
      scaleY: [1, 0.88, 1.05, 0.98, 1],
      scaleX: [1, 1.1, 0.97, 1.01, 1],
      transition: { duration: 0.42, ease: 'easeOut' },
    });
  }, [discarded.length, controls, reduce]);

  const nudge = () => {
    if (reduce) return;
    void controls.start({
      rotate: [0, -5, 4, -2, 0],
      transition: { duration: 0.44, ease: 'easeInOut' },
    });
  };

  const heaped = discarded.slice(0, HEAP.length);
  const full = heaped.length > 0;
  // Shut when empty, ajar once there is something inside, wide while things
  // land or while the fan is out.
  const lid = lidOpen || open ? LID_OPEN : full ? LID_AJAR : LID_SHUT;

  return (
    <div
      className="pointer-events-none fixed z-[60]"
      style={{
        right: 'calc(16px + env(safe-area-inset-right, 0px))',
        bottom: 'calc(14px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <motion.button
        ref={binRef}
        type="button"
        data-intro-bin
        aria-label={`Retired from this timeline: ${RETIRED_NAMES.join(', ')}.`}
        onClick={nudge}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        animate={controls}
        style={{ width: BIN_W, height: BIN_H, transformOrigin: '50% 100%' }}
        className="pointer-events-auto relative block scale-[0.82] rounded-md outline-offset-4 sm:scale-100"
      >
        {/* Back of the bin: the shadow it casts and the hollow you look into. */}
        <svg
          viewBox={`0 0 ${BIN_W} ${BIN_H}`}
          width={BIN_W}
          height={BIN_H}
          aria-hidden
          focusable="false"
          className="absolute inset-0 z-0 overflow-visible"
        >
          <ellipse cx={RIM_CX} cy="92" rx="27" ry="4.2" fill="rgba(23,20,15,0.13)" />
          <ellipse cx={RIM_CX} cy={RIM_CY} rx="21" ry="4" fill="rgba(23,20,15,0.88)" />
          {/* Back half of the rim, so a tile in the heap sits in front of it. */}
          <path
            d={`M ${RIM_CX - RIM_RX} ${RIM_CY} A ${RIM_RX} ${RIM_RY} 0 0 1 ${RIM_CX + RIM_RX} ${RIM_CY} L 57 ${RIM_CY} A 21 4 0 0 0 15 ${RIM_CY} Z`}
            fill="var(--color-fg)"
          />

          {/*
            The lid, hinged at the back-left of the rim. It tilts and lifts
            rather than swinging right over — a flat ellipse swung past the
            vertical stops reading as a lid and starts reading as a blob.
          */}
          <motion.g
            animate={lid}
            transition={{ type: 'spring', stiffness: 300, damping: 21 }}
            style={{ originX: `${RIM_CX - RIM_RX + 2}px`, originY: `${RIM_CY}px` }}
          >
            <ellipse cx={RIM_CX} cy="26.5" rx={RIM_RX} ry={RIM_RY} fill="var(--color-fg)" />
            <rect x="29" y="18" width="14" height="5" rx="2.5" fill="var(--color-fg)" />
          </motion.g>
        </svg>

        {/* What is inside. Between the hollow and the front wall. */}
        {heaped.map((tile, index) => {
          const rest = HEAP[index];
          const fan = fanSlot(index, heaped.length);
          const shown = open ? fan : rest;
          return (
            <motion.span
              key={tile.id}
              aria-hidden
              className="absolute z-10 block"
              style={{ left: 0, top: 0, width: rest.size, height: rest.size }}
              initial={
                reduce ? false : { x: rest.x, y: rest.y - 64, rotate: rest.rot - 55, opacity: 0 }
              }
              animate={{
                x: shown.x,
                y: shown.y,
                rotate: shown.rot,
                scale: shown.size / rest.size,
                opacity: 1,
              }}
              transition={reduce ? { duration: 0 } : open ? FAN : DROP}
            >
              <ToolGlyph tile={tile} size="100%" />
            </motion.span>
          );
        })}

        {/* Front of the bin: the wall, the front lip, and the lid. */}
        <svg
          viewBox={`0 0 ${BIN_W} ${BIN_H}`}
          width={BIN_W}
          height={BIN_H}
          aria-hidden
          focusable="false"
          className="absolute inset-0 z-20 overflow-visible"
        >
          {/* Tapered wall, opaque, so the heap is only visible above the rim. */}
          <path
            d={`M 11 ${RIM_CY + 1} L 16 84 A 20 3.6 0 0 0 56 84 L 61 ${RIM_CY + 1} A 25 5 0 0 1 11 ${RIM_CY + 1} Z`}
            fill="var(--color-canvas)"
            stroke="var(--color-fg)"
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
          {/* Ribs, following the taper of the wall. */}
          <path
            d="M 25.9 42 L 27.3 76 M 36 42 L 36 76 M 46.1 42 L 44.7 76"
            stroke="var(--color-fg)"
            strokeOpacity="0.24"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          {/* Front half of the rim. */}
          <path
            d={`M ${RIM_CX + RIM_RX} ${RIM_CY} A ${RIM_RX} ${RIM_RY} 0 0 1 ${RIM_CX - RIM_RX} ${RIM_CY} L 15 ${RIM_CY} A 21 4 0 0 0 57 ${RIM_CY} Z`}
            fill="var(--color-fg)"
          />
        </svg>
      </motion.button>
    </div>
  );
}
