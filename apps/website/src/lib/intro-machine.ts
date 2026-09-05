/**
 * The landing intro is a ripple delete: the editors people already use are cut
 * off the track and thrown in the bin, and FramePilot is promoted to the navbar
 * logo (ADR 0172).
 *
 * This module is the pure part — the states, the transitions, and the session
 * flag. Everything that touches timers, the DOM, or framer-motion lives in
 * `src/components/intro/`, so the sequencing rules can be unit-tested without a
 * browser.
 */

export type IntroState = 'idle' | 'assembling' | 'discarding' | 'landing' | 'settled';

export type IntroEvent =
  /** Mount on the landing route. Reduced motion or a replay goes straight to the end. */
  | { type: 'start'; reducedMotion: boolean; alreadySeen: boolean }
  /** The current stage's timer elapsed. */
  | { type: 'advance' }
  /** The visitor scrolled, clicked, typed, or resized: end the intro now. */
  | { type: 'skip' };

/** The one place the choreography's clock is defined, in milliseconds. */
export const INTRO_TIMING = {
  /** `assembling`: the track and its tiles appear. */
  assembleMs: 520,
  /** How long the playhead takes to travel from one slot to the next. */
  slotStepMs: 170,
  /** The razor flash on a tile the playhead has just cut. */
  cutFlashMs: 120,
  /** A cut tile's arc into the bin. */
  flightMs: 400,
  /** End of `discarding`, measured from the start of the intro. */
  discardEndMs: 2100,
  /** `landing`: the playhead settles on the FramePilot tile and it pops. */
  landingMs: 300,
  /** The shared-layout flight from the track into the navbar's logo slot. */
  logoFlightMs: 430,
} as const;

/** Time from the first frame to the logo sitting still in the navbar. */
export const INTRO_TOTAL_MS =
  INTRO_TIMING.discardEndMs + INTRO_TIMING.landingMs + INTRO_TIMING.logoFlightMs;

/** How long each stage holds before `advance` moves the machine on. */
export const STAGE_DURATION_MS: Record<'assembling' | 'discarding' | 'landing', number> = {
  assembling: INTRO_TIMING.assembleMs,
  discarding: INTRO_TIMING.discardEndMs - INTRO_TIMING.assembleMs,
  landing: INTRO_TIMING.landingMs,
};

const NEXT_STAGE: Record<IntroState, IntroState> = {
  idle: 'idle',
  assembling: 'discarding',
  discarding: 'landing',
  landing: 'settled',
  settled: 'settled',
};

/**
 * The intro's only transition table.
 *
 * `skip` is accepted from every state, including `settled`, so the escape
 * hatches (scroll, keypress, resize) never have to know where the animation
 * had got to.
 */
export function introReducer(state: IntroState, event: IntroEvent): IntroState {
  switch (event.type) {
    case 'start':
      if (state !== 'idle') return state;
      return event.reducedMotion || event.alreadySeen ? 'settled' : 'assembling';
    case 'advance':
      return NEXT_STAGE[state];
    case 'skip':
      return 'settled';
    default:
      return state;
  }
}

/** True once the navbar owns the logo and the page is interactive as normal. */
export function isIntroDone(state: IntroState): boolean {
  return state === 'settled';
}

export const INTRO_SEEN_KEY = 'fp:intro-seen';

type MaybeStorage = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/**
 * Whether this browsing session already watched the intro.
 *
 * Private modes and blocked storage throw on access rather than returning
 * null, so every read is guarded: an unreadable store means "not seen", and the
 * intro replays instead of the site failing to render.
 */
export function hasSeenIntro(storage: MaybeStorage): boolean {
  try {
    return storage?.getItem(INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Record that the intro finished. Failure to persist is not an error. */
export function markIntroSeen(storage: MaybeStorage): void {
  try {
    storage?.setItem(INTRO_SEEN_KEY, '1');
  } catch {
    /* Storage unavailable: the intro simply plays again next navigation. */
  }
}

/**
 * The inline `<head>` script, as a string.
 *
 * It runs before first paint and marks the document only when the intro is
 * actually going to play, so CSS can hide the navbar's logo mark for exactly
 * that case. With JavaScript disabled the attribute never appears and the logo
 * is visible from the first frame.
 */
export const INTRO_BOOT_SCRIPT = `(function(){try{
if(location.pathname!=='/'&&location.pathname!=='/index.html')return;
try{if(sessionStorage.getItem('${INTRO_SEEN_KEY}')==='1')return;}catch(e){}
if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
document.documentElement.dataset.intro='pending';
}catch(e){}})();`;
