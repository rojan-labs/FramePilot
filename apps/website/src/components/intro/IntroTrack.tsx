'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { INTRO_TIMING } from '@/lib/intro-machine';
import { useIntro } from './IntroProvider';
import { TRACK_TILES, ToolGlyph, type ToolTile } from './ToolTiles';

/**
 * The hero's intro track.
 *
 * Seven editors sit on a track as clips. The playhead reaches each competitor
 * in turn, razors it, and the clip is lifted off the track and thrown into the
 * bin in the corner while everything after it ripples left to close the gap —
 * the ripple delete the whole design is named after. FramePilot is the clip
 * left standing; it is promoted to the navbar logo while the track collapses
 * into the hero's ruler line.
 *
 * Timing lives in `INTRO_TIMING`; the sequence's *states* live in the reducer.
 * This component only paints them.
 */

interface Flight {
  tile: ToolTile;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
}

/** One animation frame, so the playhead's first position is not a transition. */
const FIRST_STEP_MS = 16;

const CUT_ORDER = TRACK_TILES.filter((tile) => !tile.survivor);
const SURVIVOR = TRACK_TILES.find((tile) => tile.survivor)!;

export function IntroTrack() {
  const { state, mounted, binRef, setLidOpen, reportDiscarded } = useIntro();
  const reduce = useReducedMotion();

  const trackRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [playheadX, setPlayheadX] = useState<number | null>(null);

  /* `idle` is the pre-hydration frame and `settled` is the aftermath: in both,
     the stage is nothing but the hero's ruler hairline. */
  const open = mounted && state !== 'idle' && state !== 'settled';

  const aim = useCallback((id: string) => {
    const slot = slotRefs.current[id];
    if (!slot) return;
    setPlayheadX(slot.offsetLeft + slot.offsetWidth / 2);
  }, []);

  /** Lift a cut clip off the track, throw it at the bin, and close the gap. */
  const launch = useCallback(
    (tile: ToolTile) => {
      const slot = slotRefs.current[tile.id];
      const bin = binRef.current;
      const from = slot?.getBoundingClientRect();
      const target = bin?.getBoundingClientRect();

      setFlash(null);
      setRemoved((current) => (current.includes(tile.id) ? current : [...current, tile.id]));

      if (!from || !target) {
        // Nothing measurable to fly between; still retire the tool.
        reportDiscarded(tile.id);
        return;
      }

      const size = Math.min(from.width, from.height);
      setLidOpen(true);
      setFlights((current) => [
        ...current,
        {
          tile,
          x0: from.left + (from.width - size) / 2,
          y0: from.top,
          x1: target.left + target.width / 2 - size / 2,
          y1: target.top - size / 2 + 6,
          size,
        },
      ]);
    },
    [binRef, reportDiscarded, setLidOpen],
  );

  // The sweep. One timer per cut, all cancelled if the visitor skips out.
  useEffect(() => {
    if (state !== 'discarding' || reduce) return;

    const timers: number[] = [];
    aim(CUT_ORDER[0].id);

    CUT_ORDER.forEach((tile, index) => {
      timers.push(
        window.setTimeout(() => {
          aim(tile.id);
          setFlash(tile.id);
          timers.push(window.setTimeout(() => launch(tile), INTRO_TIMING.cutFlashMs));
        }, FIRST_STEP_MS + index * INTRO_TIMING.slotStepMs),
      );
    });

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [state, reduce, aim, launch]);

  // The playhead comes to rest on the surviving clip once the gap has closed.
  useEffect(() => {
    if (state !== 'landing') return;
    const frame = window.requestAnimationFrame(() => aim(SURVIVOR.id));
    return () => window.cancelAnimationFrame(frame);
  }, [state, aim]);

  // Skipping mid-flight must not leave tiles hanging in the air.
  useEffect(() => {
    if (state !== 'settled') return;
    setFlights([]);
    setFlash(null);
    setLidOpen(false);
  }, [state, setLidOpen]);

  const visible = TRACK_TILES.filter((tile) => !removed.includes(tile.id));

  return (
    <div
      ref={trackRef}
      aria-hidden
      /*
       * Height is driven by CSS so the pre-hydration frame already reserves the
       * right space: `html[data-intro="pending"]` opens the stage before React
       * exists, and `data-stage` takes over the moment it does. Collapsing to
       * 1px at `settled` leaves exactly the hero's ruler line behind.
       */
      className="intro-stage relative select-none [--gap:3px] [--label:6.5px] [--slot:46px] [--tile:28px] sm:[--gap:14px] sm:[--label:8px] sm:[--slot:78px] sm:[--tile:44px]"
      data-stage={open ? 'open' : undefined}
    >
      {/* The lane. It fades out at the end, leaving the hairline behind. */}
      <motion.div
        className="lane absolute inset-x-0 bottom-px top-0"
        initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      />

      {/* The hero's ruler line: present from the first paint, JavaScript or not. */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-line-strong" />

      {/*
        The stage exists only on the client, and only while it is running, so
        the hero's copy and CTA are the page's real first paint and nothing is
        left painted behind once the intro is over.
      */}
      {open && (
        <div className="absolute bottom-[9px] left-0 flex items-end">
        {visible.map((tile) => (
            <motion.div
              key={tile.id}
              layout
              ref={(node) => {
                slotRefs.current[tile.id] = node;
              }}
              className="relative flex shrink-0 flex-col items-center"
              style={{ width: 'var(--slot)', marginRight: 'var(--gap)' }}
              initial={{ opacity: 0, y: 10 }}
              animate={{
                opacity: 1,
                y: 0,
                scale:
                  flash === tile.id
                    ? 1.14
                    : state === 'landing' && tile.survivor
                      ? 1.16
                      : 1,
              }}
              transition={{
                duration: flash === tile.id ? 0.1 : 0.3,
                ease: [0.16, 1, 0.3, 1],
                layout: { duration: 0.34, ease: [0.16, 1, 0.3, 1] },
              }}
            >
              {tile.survivor ? (
                <motion.span
                  layoutId="fp-logo-mark"
                  className="block overflow-hidden rounded-[22%]"
                  style={{ width: 'var(--tile)', height: 'var(--tile)' }}
                >
                  <ToolGlyph tile={tile} size="100%" />
                </motion.span>
              ) : (
                <span className="block" style={{ width: 'var(--tile)', height: 'var(--tile)' }}>
                  <ToolGlyph tile={tile} size="100%" />
                </span>
              )}

              {/* The razor: a 1px flash across the clip as it is cut. */}
              {flash === tile.id && (
                <span
                  className="absolute left-1/2 top-0 w-px bg-white shadow-[0_0_9px_3px_rgba(255,255,255,0.85)]"
                  style={{ height: 'var(--tile)' }}
                />
              )}

              <span
                className="tc mt-1.5 block w-full overflow-hidden whitespace-nowrap text-center leading-[10px] tracking-[0.05em] text-fg-tertiary"
                style={{ fontSize: 'var(--label)' }}
              >
                {tile.short}
              </span>
            </motion.div>
        ))}
        </div>
      )}

      {open && playheadX != null && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-px bg-accent shadow-[0_0_7px_rgba(242,101,34,0.6)] transition-transform ease-linear"
          style={{
            transform: `translateX(${playheadX}px)`,
            transitionDuration: `${state === 'landing' ? 260 : INTRO_TIMING.slotStepMs}ms`,
          }}
        >
          <span className="absolute -left-[3px] -top-px block h-[7px] w-[7px] rounded-[1px] bg-accent" />
        </div>
      )}

      <FlightLayer flights={flights} onLanded={reportDiscarded} onDone={setFlights} />
    </div>
  );
}

/**
 * Tiles in flight are portalled to `<body>`.
 *
 * They must be positioned against the viewport, and a `position: fixed`
 * descendant of an element carrying a transform (which framer-motion sets all
 * over the stage) resolves against that element instead — which painted the
 * tiles off-screen, or clipped them away entirely.
 */
function FlightLayer({
  flights,
  onLanded,
  onDone,
}: {
  flights: Flight[];
  onLanded: (id: string) => void;
  onDone: (update: (current: Flight[]) => Flight[]) => void;
}) {
  if (typeof document === 'undefined' || flights.length === 0) return null;

  return createPortal(
    <div data-intro-flights className="pointer-events-none fixed inset-0 z-[70]">
      <AnimatePresence>
        {flights.map((flight) => (
          <motion.div
            key={flight.tile.id}
            className="absolute left-0 top-0"
            style={{ width: flight.size, height: flight.size }}
            initial={{ x: flight.x0, y: flight.y0, rotate: 0, scale: 1, opacity: 1 }}
            animate={{
              x: [flight.x0, (flight.x0 + flight.x1) / 2, flight.x1],
              y: [flight.y0, Math.min(flight.y0, flight.y1) - 90, flight.y1],
              rotate: [0, 130, 315],
              scale: [1, 0.9, 0.36],
            }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{
              duration: INTRO_TIMING.flightMs / 1000,
              times: [0, 0.5, 1],
              ease: 'easeIn',
            }}
            onAnimationComplete={() => {
              onLanded(flight.tile.id);
              onDone((current) => current.filter((item) => item.tile.id !== flight.tile.id));
            }}
          >
            <ToolGlyph tile={flight.tile} size="100%" />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
