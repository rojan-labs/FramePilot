'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import {
  STAGE_DURATION_MS,
  hasSeenIntro,
  introReducer,
  markIntroSeen,
  type IntroState,
} from '@/lib/intro-machine';

/** `sessionStorage` itself throws in some privacy modes, before any read. */
function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Drives the intro reducer: the stage timers, the escape hatches, and the
 * once-per-session flag. The reducer stays pure; every side effect is here.
 */
export function useIntroMachine(isLanding: boolean): {
  state: IntroState;
  mounted: boolean;
  skip: () => void;
} {
  const [state, dispatch] = useReducer(introReducer, isLanding ? 'idle' : 'settled');
  const [mounted, setMounted] = useState(false);

  const skip = useCallback(() => dispatch({ type: 'skip' }), []);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Kick off (or immediately settle) once we know the visitor's preferences.
  useEffect(() => {
    if (!isLanding) {
      dispatch({ type: 'skip' });
      return;
    }
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    dispatch({ type: 'start', reducedMotion, alreadySeen: hasSeenIntro(safeSessionStorage()) });
  }, [isLanding]);

  // One timer at a time, torn down whenever the stage changes or we unmount.
  useEffect(() => {
    if (state === 'idle' || state === 'settled') return;
    const timer = window.setTimeout(
      () => dispatch({ type: 'advance' }),
      STAGE_DURATION_MS[state],
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  /*
   * Any sign that the visitor wants the page rather than the show ends it:
   * scrolling, a pointer press outside the bin, a keypress, or a viewport
   * change that would invalidate the measured flight paths mid-animation.
   */
  useEffect(() => {
    if (state === 'settled' || state === 'idle') return;

    const end = () => dispatch({ type: 'skip' });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-intro-bin]')) return;
      end();
    };

    window.addEventListener('wheel', end, { passive: true });
    window.addEventListener('touchmove', end, { passive: true });
    window.addEventListener('scroll', end, { passive: true });
    window.addEventListener('keydown', end);
    window.addEventListener('resize', end);
    window.addEventListener('orientationchange', end);
    window.addEventListener('pointerdown', onPointerDown);

    return () => {
      window.removeEventListener('wheel', end);
      window.removeEventListener('touchmove', end);
      window.removeEventListener('scroll', end);
      window.removeEventListener('keydown', end);
      window.removeEventListener('resize', end);
      window.removeEventListener('orientationchange', end);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [state]);

  // Hand the page back: the navbar owns the logo and the intro will not replay.
  useEffect(() => {
    if (state !== 'settled') return;
    markIntroSeen(safeSessionStorage());
    delete document.documentElement.dataset.intro;
  }, [state]);

  return { state, mounted, skip };
}
