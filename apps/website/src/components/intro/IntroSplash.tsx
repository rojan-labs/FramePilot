'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { INTRO_TIMING, INTRO_TOTAL_MS } from '@/lib/intro-machine';
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
  /** Total tumble, in degrees. Varied so no two throws look alike. */
  spin: number;
}

/** How high above the higher of its two ends a thrown tool arcs, in px. */
const APEX_PX = 150;

/** Radians per second: one full revolution takes about three seconds. */
const ORBIT_SPEED = 2.05;

/** How far out of focus a tool at the very back of the orbit goes. */
const MAX_BLUR_PX = 2.6;

/** The orbit's ellipse for a given viewport. Shared by the loop and the ring. */
function orbitRadii(width: number, height: number) {
  return { rx: Math.min(width * 0.36, 330), ry: Math.min(height * 0.2, 140) };
}

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
  /** The orbit's radii, so the guide ring can be drawn at the same size. */
  const [orbit, setOrbit] = useState({ rx: 0, ry: 0 });
  const logo = useAnimationControls();

  const revolving = state === 'assembling' || state === 'discarding' || state === 'landing';

  useEffect(() => {
    setCompact(window.innerWidth < 640);
    setOrbit(orbitRadii(window.innerWidth, window.innerHeight));
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
      const { rx: radiusX, ry: radiusY } = orbitRadii(width, height);
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
        node.style.opacity = goneRef.current.has(tile.id) ? '0' : (0.42 + depth * 0.58).toFixed(3);
        node.style.zIndex = String(Math.round(depth * 10));
        // Depth of field: what is at the back of the orbit is out of focus.
        const blur = (1 - depth) * MAX_BLUR_PX;
        node.style.filter = blur > 0.15 ? `blur(${blur.toFixed(2)}px)` : 'none';
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
      if (node) {
        /*
         * The node carries a 260ms fade so it can appear softly. Leaving that
         * on here would keep the tool on the orbit while its copy is already
         * flying to the bin — the same icon in two places at once.
         */
        node.style.transition = 'none';
        node.style.opacity = '0';
      }

      // The logo takes the recoil of each throw.
      void logo.start({
        scale: [1, 1.075, 1],
        transition: { duration: 0.34, ease: [0.16, 1, 0.3, 1] },
      });

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
          x1: target.left + target.width * 0.5 - from.width / 2,
          y1: target.top + 10,
          size: from.width,
          spin: 260 + Math.random() * 220,
        },
      ]);
    },
    [binRef, logo, reportDiscarded, setLidOpen],
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
      >
        {/* A warm pool of light under the logo, so the paper is not a flat slab. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(58% 48% at 50% 46%, rgba(242,101,34,0.09), rgba(242,101,34,0) 70%)',
          }}
        />
      </motion.div>

      {/* The orbit and the logo, above the ground, below the flights and the bin. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[58]">
        <div className="absolute left-1/2 top-1/2">
          {/* The path the tools travel, drawn faintly so the motion has a track. */}
          <motion.div
            className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-dashed border-line"
            style={{ width: orbit.rx * 2, height: orbit.ry * 2 }}
            initial={{ opacity: 0, scale: 0.88 }}
            animate={{ opacity: landing ? 0 : 1, scale: 1 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          />

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
            initial={{ scale: 0.55, opacity: 0, filter: 'blur(10px)' }}
            animate={{ scale: landing ? 0.82 : 1, opacity: 1, filter: 'blur(0px)' }}
            transition={{ duration: 0.62, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Recoil lives on its own element so it never fights the shared layout flight. */}
            <motion.span animate={logo} className="block">
              <motion.span
                layoutId="fp-logo-mark"
                className="block overflow-hidden rounded-[22%] shadow-[0_18px_50px_rgba(23,20,15,0.18)]"
                style={{ width: logoSize, height: logoSize }}
                transition={{
                  duration: INTRO_TIMING.logoFlightMs / 1000,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <ToolGlyph tile={FRAMEPILOT_TILE} size="100%" />
              </motion.span>
            </motion.span>
          </motion.div>
        </div>

        {/* A render bar, because that is what this site's language calls a wait. */}
        <motion.div
          className="absolute inset-x-0 bottom-[calc(26px+env(safe-area-inset-bottom,0px))] flex flex-col items-center gap-3"
          initial={{ opacity: 0 }}
          animate={{ opacity: landing ? 0 : 1 }}
          transition={{ duration: 0.4, delay: landing ? 0 : 0.5 }}
        >
          <div className="relative h-px w-[168px] overflow-hidden bg-line">
            <motion.div
              className="absolute inset-y-0 left-0 bg-accent"
              initial={{ width: '0%' }}
              animate={{ width: '100%' }}
              transition={{ duration: INTRO_TOTAL_MS / 1000, ease: 'linear' }}
            />
          </div>
          <p className="tc text-fg-muted">Clearing the old timeline · click or scroll to skip</p>
        </motion.div>
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
              x: flight.x1,
              y: [flight.y0, Math.min(flight.y0, flight.y1) - APEX_PX, flight.y1],
              rotate: flight.spin,
              scale: [1, 0.9, 0.44],
            }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            /*
             * A thrown object keeps its horizontal speed and loses its vertical
             * one to gravity, so x is linear while y rises decelerating and
             * falls accelerating. Easing the whole arc at once — the old
             * behaviour — read as a swoosh rather than a throw.
             */
            transition={{
              duration: INTRO_TIMING.flightMs / 1000,
              x: { ease: 'linear' },
              y: { times: [0, 0.4, 1], ease: ['easeOut', 'easeIn'] },
              rotate: { ease: 'linear' },
              scale: { times: [0, 0.4, 1], ease: 'easeIn' },
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
