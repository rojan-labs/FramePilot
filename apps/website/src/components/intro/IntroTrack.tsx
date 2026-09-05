'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { INTRO_TIMING } from '@/lib/intro-machine';
import { useIntro } from './IntroProvider';
import { TRACK_TILES, ToolGlyph, type ToolTile } from './ToolTiles';

/**
 * The hero's intro track.
 *
 * The seven editors sit on a track as clips. A playhead sweeps left to right;
 * every competitor it reaches is razored, lifted, and thrown into the bin in
 * the corner. When the sweep is done the gap closes — the ripple delete — and
 * FramePilot, the one clip left, is promoted to the navbar logo while the track
 * itself collapses into the hero's ruler line.
 *
 * Timing lives in `INTRO_TIMING`; the sequence's *states* live in the reducer.
 * This component only paints them.
 */

interface Flight {
  key: string;
  tile: ToolTile;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
}

type CutPhase = 'flash' | 'gone';

/** One animation frame, so the playhead's first position is not a transition. */
const FIRST_STEP_MS = 16;

export function IntroTrack() {
  const { state, mounted, binRef, setLidOpen, reportDiscarded } = useIntro();
  const reduce = useReducedMotion();

  const trackRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [cut, setCut] = useState<Record<string, CutPhase>>({});
  const [flights, setFlights] = useState<Flight[]>([]);
  const [playheadX, setPlayheadX] = useState<number | null>(null);

  const showTiles = mounted && state !== 'idle' && state !== 'settled';
  const collapsed = state === 'landing';

  const slotCentre = useCallback((id: string) => {
    const slot = slotRefs.current[id];
    if (!slot) return null;
    return slot.offsetLeft + slot.offsetWidth / 2;
  }, []);

  /** Lift a cut tile out of the track and throw it at the bin. */
  const launch = useCallback(
    (tile: ToolTile) => {
      const slot = slotRefs.current[tile.id];
      const bin = binRef.current;
      setCut((current) => ({ ...current, [tile.id]: 'gone' }));

      if (!slot || !bin) {
        // No bin to aim at (it has not mounted yet): still retire the tile.
        reportDiscarded(tile.id);
        return;
      }

      const from = slot.getBoundingClientRect();
      const target = bin.getBoundingClientRect();
      const size = Math.min(from.width, from.height);

      setLidOpen(true);
      setFlights((current) => [
        ...current,
        {
          key: tile.id,
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

  // The sweep. One timer per step, all cancelled if the visitor skips out.
  useEffect(() => {
    if (state !== 'discarding' || reduce) return;

    const timers: number[] = [];
    const first = slotCentre(TRACK_TILES[0].id);
    if (first != null) setPlayheadX(first);

    TRACK_TILES.forEach((tile, index) => {
      timers.push(
        window.setTimeout(() => {
          // Move on to the next slot; the playhead never travels backwards.
          const next = TRACK_TILES[index + 1];
          const nextX = next ? slotCentre(next.id) : (trackRef.current?.offsetWidth ?? null);
          if (nextX != null) setPlayheadX(nextX);

          if (tile.survivor) return;

          setCut((current) => ({ ...current, [tile.id]: 'flash' }));
          timers.push(window.setTimeout(() => launch(tile), INTRO_TIMING.cutFlashMs));
        }, FIRST_STEP_MS + index * INTRO_TIMING.slotStepMs),
      );
    });

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [state, reduce, slotCentre, launch]);

  // The playhead comes to rest on the surviving clip once the gap has closed.
  useEffect(() => {
    if (state !== 'landing') return;
    const frame = window.requestAnimationFrame(() => {
      const centre = slotCentre(TRACK_TILES.find((tile) => tile.survivor)!.id);
      if (centre != null) setPlayheadX(centre);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state, slotCentre]);

  // Skipping mid-flight must not leave tiles hanging in the air.
  useEffect(() => {
    if (state !== 'settled') return;
    setFlights([]);
    setLidOpen(false);
  }, [state, setLidOpen]);

  return (
    <div
      ref={trackRef}
      aria-hidden
      className="relative h-[86px] select-none [--gap:8px] [--slot:52px] [--tile:34px] sm:h-[104px] sm:[--gap:14px] sm:[--slot:78px] sm:[--tile:44px]"
    >
      {/* The lane. It fades out at the end, leaving the hairline behind. */}
      <motion.div
        className="lane absolute inset-x-0 top-0 bottom-px"
        initial={false}
        animate={{ opacity: showTiles ? 1 : 0 }}
        transition={{ duration: 0.34, ease: 'easeOut' }}
      />

      {/* The hero's ruler line: present from the first paint, JavaScript or not. */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-line-strong" />

      {/*
        The stage exists only on the client: the server ships the hairline and
        an empty box of the right height, so the hero's copy and CTA are the
        page's real first paint and nothing reflows when the intro starts.
      */}
      <div className="absolute bottom-[9px] left-0 flex items-end">
        {mounted && TRACK_TILES.map((tile) => {
          const phase = cut[tile.id];
          const gone = phase === 'gone';
          const isCollapsed = gone && collapsed;

          return (
            <div
              key={tile.id}
              ref={(node) => {
                slotRefs.current[tile.id] = node;
              }}
              className="shrink-0 overflow-hidden transition-[width,margin-right] duration-300 ease-[var(--ease-snap)]"
              style={{
                width: isCollapsed ? 0 : 'var(--slot)',
                marginRight: isCollapsed ? 0 : 'var(--gap)',
              }}
            >
              <motion.div
                className="relative flex flex-col items-center"
                style={{ width: 'var(--slot)' }}
                initial={false}
                animate={{
                  opacity: !showTiles || gone ? 0 : 1,
                  y: showTiles ? 0 : 10,
                  scale: phase === 'flash' ? 1.14 : state === 'landing' && tile.survivor ? 1.16 : 1,
                }}
                transition={{ duration: phase === 'flash' ? 0.1 : 0.28, ease: [0.16, 1, 0.3, 1] }}
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
                {phase === 'flash' && (
                  <span
                    className="absolute left-1/2 top-0 w-px bg-white shadow-[0_0_9px_3px_rgba(255,255,255,0.85)]"
                    style={{ height: 'var(--tile)' }}
                  />
                )}

                <span className="tc mt-1.5 block w-full text-center text-[7.5px] leading-[10px] tracking-[0.06em] text-fg-tertiary sm:text-[8px]">
                  {tile.name}
                </span>
              </motion.div>
            </div>
          );
        })}
      </div>

      {playheadX != null && showTiles && (
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

      {/* Tiles in flight live above the page, aimed at the bin in the corner. */}
      <div className="pointer-events-none fixed inset-0 z-[55]">
        <AnimatePresence>
          {flights.map((flight) => (
            <motion.div
              key={flight.key}
              className="absolute left-0 top-0"
              style={{ width: flight.size, height: flight.size }}
              initial={{ x: flight.x0, y: flight.y0, rotate: 0, scale: 1, opacity: 1 }}
              animate={{
                x: [flight.x0, (flight.x0 + flight.x1) / 2, flight.x1],
                y: [flight.y0, Math.min(flight.y0, flight.y1) - 90, flight.y1],
                rotate: [0, 130, 315],
                scale: [1, 0.9, 0.36],
                opacity: [1, 1, 1],
              }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: INTRO_TIMING.flightMs / 1000, times: [0, 0.5, 1], ease: 'easeIn' }}
              onAnimationComplete={() => {
                reportDiscarded(flight.tile.id);
                setFlights((current) => current.filter((item) => item.key !== flight.key));
              }}
            >
              <ToolGlyph tile={flight.tile} size="100%" />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
