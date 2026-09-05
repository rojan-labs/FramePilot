'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { INTRO_TIMING } from '@/lib/intro-machine';
import { useIntro } from './IntroProvider';
import { COMPETITOR_TOOLS, FRAMEPILOT_TILE, ToolGlyph, type ToolTile } from './ToolTiles';

/**
 * The splash.
 *
 * A full-viewport paper ground covers the page. The FramePilot logo sits in the
 * middle and the editors people already use revolve around it. One by one they
 * are flung off the orbit into the bin in the corner; the last one in, the
 * ground fades and the logo flies up into the navbar's logo slot (a shared
 * `layoutId`, so it is the same element on both sides).
 *
 * Timing lives in `INTRO_TIMING`; the sequence's *states* live in the reducer.
 * This component only paints them. The orbit is driven by one
 * `requestAnimationFrame` loop writing transforms straight to the DOM, so six
 * revolving icons never touch React state.
 */

interface Flight {
  tile: ToolTile;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
}

/** Radians per second: one full revolution takes about three seconds. */
const ORBIT_SPEED = 2.05;

/** The logo at the centre of the splash, in CSS px. */
const LOGO_SIZE = 92;
const LOGO_SIZE_MOBILE = 68;

export function IntroSplash() {
  const { state, binRef, setLidOpen, reportDiscarded } = useIntro();
  const reduce = useReducedMotion();

  const orbitRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const goneRef = useRef<Set<string>>(new Set());
  const [flights, setFlights] = useState<Flight[]>([]);
  const [compact, setCompact] = useState(false);

  const revolving = state === 'assembling' || state === 'discarding' || state === 'landing';

  useEffect(() => {
    setCompact(window.innerWidth < 640);
  }, []);

  // The orbit: positions, depth scale, and dimming written every frame.
  useEffect(() => {
    if (!revolving || reduce) return;

    const started = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const seconds = (now - started) / 1000;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const radiusX = Math.min(width * 0.36, 330);
      const radiusY = Math.min(height * 0.2, 140);
      const count = COMPETITOR_TOOLS.length;

      COMPETITOR_TOOLS.forEach((tile, index) => {
        const node = orbitRefs.current[tile.id];
        if (!node) return;
        const angle = (index / count) * Math.PI * 2 + seconds * ORBIT_SPEED;
        const x = Math.cos(angle) * radiusX;
        const y = Math.sin(angle) * radiusY;
        // Front of the orbit (bottom of the ellipse) is closer: larger and brighter.
        const depth = (Math.sin(angle) + 1) / 2;
        const scale = 0.7 + depth * 0.4;
        node.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
        node.style.opacity = goneRef.current.has(tile.id) ? '0' : (0.5 + depth * 0.5).toFixed(3);
        node.style.zIndex = String(Math.round(depth * 10));
      });

      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [revolving, reduce]);

  /** Take an icon off the orbit where it is right now and throw it at the bin. */
  const launch = useCallback(
    (tile: ToolTile) => {
      const node = orbitRefs.current[tile.id];
      const bin = binRef.current;
      const from = node?.firstElementChild?.getBoundingClientRect();
      const target = bin?.getBoundingClientRect();

      goneRef.current.add(tile.id);
      if (node) node.style.opacity = '0';

      if (!from || !target) {
        // Nothing measurable to fly between; still retire the tool.
        reportDiscarded(tile.id);
        return;
      }

      setLidOpen(true);
      setFlights((current) => [
        ...current,
        {
          tile,
          x0: from.left,
          y0: from.top,
          x1: target.left + target.width * 0.55 - from.width / 2,
          y1: target.top + 6,
          size: from.width,
        },
      ]);
    },
    [binRef, reportDiscarded, setLidOpen],
  );

  // The throws. One timer per icon, all cancelled if the visitor skips out.
  useEffect(() => {
    if (state !== 'discarding' || reduce) return;
    const timers = COMPETITOR_TOOLS.map((tile, index) =>
      window.setTimeout(
        () => launch(tile),
        INTRO_TIMING.orbitLeadMs + index * INTRO_TIMING.launchStepMs,
      ),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [state, reduce, launch]);

  // Skipping mid-flight must not leave icons hanging in the air.
  useEffect(() => {
    if (state !== 'settled') return;
    setFlights([]);
    setLidOpen(false);
  }, [state, setLidOpen]);

  if (!revolving) return null;

  const landing = state === 'landing';
  const logoSize = compact ? LOGO_SIZE_MOBILE : LOGO_SIZE;
  const iconSize = compact ? 42 : 64;

  return (
    <>
      {/* The ground. It is what the visitor clicks to skip. */}
      <motion.div
        aria-hidden
        data-intro-splash
        className="fixed inset-0 z-[55] bg-canvas"
        initial={{ opacity: 1 }}
        animate={{ opacity: landing ? 0 : 1 }}
        transition={{ duration: INTRO_TIMING.landingMs / 1000, ease: 'easeInOut' }}
      />

      {/* The orbit and the logo, above the ground, below the flights and the bin. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[58]">
        <div className="absolute left-1/2 top-1/2">
          {COMPETITOR_TOOLS.map((tile) => (
            <div
              key={tile.id}
              ref={(node) => {
                orbitRefs.current[tile.id] = node;
              }}
              className="absolute left-0 top-0 will-change-transform"
              style={{ opacity: 0, transition: 'opacity 260ms ease-out' }}
            >
              <ToolGlyph tile={tile} size={iconSize} />
            </div>
          ))}

          <motion.div
            className="absolute left-0 top-0 z-[5] -translate-x-1/2 -translate-y-1/2"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: landing ? 0.82 : 1, opacity: 1 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <motion.span
              layoutId="fp-logo-mark"
              className="block overflow-hidden rounded-[22%] shadow-[0_18px_50px_rgba(23,20,15,0.18)]"
              style={{ width: logoSize, height: logoSize }}
              transition={{ duration: INTRO_TIMING.logoFlightMs / 1000, ease: [0.22, 1, 0.36, 1] }}
            >
              <ToolGlyph tile={FRAMEPILOT_TILE} size="100%" />
            </motion.span>
          </motion.div>
        </div>

        <motion.p
          className="tc absolute inset-x-0 bottom-[calc(28px+env(safe-area-inset-bottom,0px))] text-center text-fg-muted"
          initial={{ opacity: 0 }}
          animate={{ opacity: landing ? 0 : 1 }}
          transition={{ duration: 0.4, delay: landing ? 0 : 0.6 }}
        >
          Clearing the old timeline · click or scroll to skip
        </motion.p>
      </div>

      <FlightLayer flights={flights} onLanded={reportDiscarded} onDone={setFlights} />
    </>
  );
}

/**
 * Icons in flight are portalled to `<body>`.
 *
 * They must be positioned against the viewport, and a `position: fixed`
 * descendant of an element carrying a transform resolves against that element
 * instead, which would paint them off-screen or clip them away entirely.
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
              y: [flight.y0, Math.min(flight.y0, flight.y1) - 120, flight.y1],
              rotate: [0, 150, 340],
              scale: [1, 0.86, 0.42],
            }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{
              duration: INTRO_TIMING.flightMs / 1000,
              times: [0, 0.45, 1],
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
