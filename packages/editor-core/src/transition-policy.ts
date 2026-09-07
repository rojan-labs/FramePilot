/**
 * The transition policy: the model states a reason, the measurements pick the
 * transition (`plan/visual-understanding/04-SOLVERS-COLOR-TRANSITIONS.md` §VU4.1).
 *
 * ## The problem
 *
 * `add_transition` takes a catalog id and a duration and knows nothing about the
 * two shots it sits between (ADR 0175, "Nothing consumes measurements"). Across
 * ten recorded runs (`reports/golden/BASELINE.md`) every transition the agent
 * added was chosen blind: a kind guessed from the word in the request, a duration
 * guessed from nothing at all.
 *
 * So the division of labour here is deliberate and total:
 *
 * - the **model** supplies a {@link TransitionReason} — one of seven intents it
 *   can actually justify from the transcript and the ledger ("this is a time
 *   jump", "this is a jump cut I want smoothed");
 * - the **policy** supplies the kind and the length, from the cut's measured
 *   deltas and the layer's pacing.
 *
 * A model that cannot see cannot pick between `punch-zoom` and `smooth-zoom`. It
 * can tell you why it wants a transition, and that is the input this module takes.
 *
 * ## Families, not ids
 *
 * The catalog's 78 entries stay for the UI and for explicit asks. This module
 * picks a **family** — a render kind plus, where it matters, a required tag and a
 * direction — and then asks the catalog which entry represents it, using the
 * catalog's own `recommended` / `popular` flags and its order. It never carries a
 * list of ids of its own, which is the same extensibility contract
 * `transition-catalog.ts` states in its header: nothing outside the catalog may
 * branch on an entry id.
 *
 * ## `null` means a hard cut, and that is an answer
 *
 * A dissolve on a continuity cut is the classic amateur tell. `continuity`
 * therefore returns `null` no matter how large the deltas are; only a caller
 * passing an explicit kind can override it, which is the caller's business and
 * not this function's. `reveal` away from the opening returns `null` for the same
 * kind of reason — it is a gesture that only means something once.
 *
 * Pure and deterministic: same inputs, same output. No clock, no randomness.
 * Where a choice genuinely has no measured basis (a direction with no camera
 * movement behind it), it alternates on a caller-supplied cut index rather than
 * picking at random, so a run is reproducible and a montage does not push the
 * same way eight times.
 */
import {
  TRANSITION_CATALOG,
  defaultDirectionFor,
  type CatalogTransition,
} from '@framepilot/timeline-schema/transition-catalog';

// ---------------------------------------------------------------------------
// The vocabulary the model speaks
// ---------------------------------------------------------------------------

/**
 * Why a transition belongs at this cut — the whole surface the model gets.
 *
 * Seven intents rather than 78 ids because an intent is something a model can be
 * right or wrong about from text it already has, and an id is not.
 */
export const TRANSITION_REASONS = [
  /** The shots continue one another. The answer is a hard cut. */
  'continuity',
  /** Time passed between the two shots. */
  'time_jump',
  /** The scene moved somewhere else. */
  'location_change',
  /** A deliberate lift in energy at this cut. */
  'energy',
  /** A run of shots cut as one gesture. */
  'montage',
  /** Hide a discontinuity the footage already has — a jump cut, a repeated take. */
  'soften',
  /** Open on the material rather than starting in it. */
  'reveal',
] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

/**
 * How the two shots' motion compares.
 *
 * Derived by the caller from the ledger's `motion.class` ladder
 * (`static → slow → handheld → fast`); expressed as a direction here because the
 * policy only ever asks "is this cut going up in energy?".
 */
export type MotionChange = 'up' | 'down' | 'same';

/**
 * The outgoing shot's dominant camera movement, mirroring the ledger's
 * `CameraFacts.movement` vocabulary (`@framepilot/ai-sdk/ledger`).
 *
 * Restated as a structural union rather than imported: editor-core must not
 * depend on ai-sdk, and the caller adapts. The values are copied deliberately so
 * that a caller holding a `CameraMovement` can pass it straight through.
 */
export type OutgoingCameraMovement = 'static' | 'pan' | 'tilt' | 'zoom' | 'handheld' | 'tracking';

/**
 * What was measured about the cut.
 *
 * Every field is optional and absence means *unknown*, never "normal" — the third
 * rule the shot ledger enforces (ADR 0175). A cut with nothing measured still
 * gets a defensible answer: the reason's default family at the pacing's duration.
 */
export interface MeasuredCut {
  /**
   * Incoming mean luma minus outgoing, on the ledger's normalised 0..1 Y scale.
   * Signed: negative means the edit goes darker.
   */
  readonly lumaDelta?: number;
  /**
   * Incoming warmth minus outgoing, on the ledger's calibrated −1..1 scale.
   *
   * Carried but not read by any rule today. It is in the shape because the caller
   * measures the pair once and prints the deltas it decided from, and a later row
   * that reads warmth must not have to change every call site.
   */
  readonly warmthDelta?: number;
  /**
   * Signed steps on the shot-size ladder; positive means the incoming shot is
   * tighter (`shotSizeSteps` in `@framepilot/ai-sdk/ledger`).
   */
  readonly shotSizeSteps?: number;
  readonly motionChange?: MotionChange;
  readonly outgoingCameraMovement?: OutgoingCameraMovement;
  /** The incoming shot repeats the outgoing one — a second take of the same setup. */
  readonly duplicate?: boolean;
  /** The caller's own jump-cut determination, e.g. a `list_edit_boundaries` flag. */
  readonly jumpCut?: boolean;
  /**
   * The INCOMING shot is dark. Only the incoming side is read: a dip to black is about what
   * the cut lands on, and `lumaDelta` already carries the size of the step.
   *
   * There was an `outgoingIsDark` beside this, set by `transition-planning.ts` and read by
   * nothing — so a caller computed it, passed it, and reasonably assumed a dark shot being
   * cut AWAY from would dip. It never did. Removed rather than left to mislead. Whether a
   * dark outgoing shot should also dip is a real question about the craft; it is open, and
   * deleting an unread field is deliberately not the place to answer it.
   */
  readonly incomingIsDark?: boolean;
  /** True when this is the first cut of the sequence — the only place a reveal means anything. */
  readonly isFirstCut?: boolean;
  /**
   * This cut's position among the cuts being treated.
   *
   * Only read where a choice has no measured basis, to alternate instead of
   * repeating. Absent behaves as 0.
   */
  readonly index?: number;
}

/** What the policy decided. `null` from {@link chooseTransition} means a hard cut. */
export interface TransitionChoice {
  /** A catalog entry id, resolved from the family — never a literal in this module. */
  readonly kind: string;
  readonly durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Constants. Every number the policy uses is here, with why it is that number.
// ---------------------------------------------------------------------------

/**
 * A scene-level transition takes a quarter of a shot.
 *
 * Long enough that the blend is a statement rather than a stutter, short enough
 * that three quarters of the incoming shot still plays clean.
 */
const SCENE_DURATION_FACTOR = 0.25;

/** Under this a dissolve reads as a mistimed cut rather than a passage of time. */
const SCENE_MIN_SECONDS = 0.4;

/** Over this the blend outlives the viewer's patience on anything but an ending. */
const SCENE_MAX_SECONDS = 1.2;

/**
 * An energy transition takes a tenth of a shot.
 *
 * It is punctuation between beats, not a scene change: it must finish inside the
 * gesture that motivated it.
 */
const ENERGY_DURATION_FACTOR = 0.1;

/** Under this the ramp is shorter than the eye's response and the transition is invisible. */
const ENERGY_MIN_SECONDS = 0.15;

/** Over this a zoom or push stops reading as energy and starts reading as a move. */
const ENERGY_MAX_SECONDS = 0.4;

/** A soften is short by construction — it hides a defect, it does not announce one. */
const SOFTEN_MIN_SECONDS = 0.3;
const SOFTEN_MAX_SECONDS = 0.5;

/**
 * A real jump cut needs at least this much blend before the subject's pop stops
 * being visible; below it the dissolve reads as a glitch on top of the glitch.
 */
const JUMP_CUT_MIN_SOFTEN_SECONDS = 0.4;

/** An opening fade has to be slow enough to feel like a curtain and no slower. */
const REVEAL_MIN_SECONDS = 0.6;
const REVEAL_MAX_SECONDS = 1.0;

/**
 * A fifth of the luma range between the two shots — the point at which a straight
 * dissolve muddies rather than blends, because the mid-blend frame is a grey
 * neither shot contains. Past it, going into a dark shot, black is the honest
 * middle.
 */
const DARK_DIP_LUMA_DELTA = 0.2;

/** Median shot under this and the edit is cutting fast enough for a wipe to belong. */
const FAST_PACING_SECONDS = 2.0;

/**
 * A cut that already changes framing by two ladder steps carries its own push.
 * A zoom transition on top of it is the same gesture twice, so the energy family
 * moves laterally instead.
 */
const REDUNDANT_ZOOM_SHOT_SIZE_STEPS = 2;

/**
 * Used when the caller's pacing is missing or nonsensical.
 *
 * Four seconds is an ordinary talking-head shot; it puts the scene default at a
 * mid-range 1.0s rather than at a clamp boundary, so an unknown pacing produces a
 * plainly reasonable transition rather than an extreme one.
 */
const FALLBACK_MEDIAN_SHOT_SECONDS = 4;

/** Durations are reported to the nearest 10 ms: printable, and finer than any cut. */
const DURATION_ROUNDING = 100;

// ---------------------------------------------------------------------------
// Family resolution — the catalog answers, this module does not
// ---------------------------------------------------------------------------

/**
 * The families this policy can ask for.
 *
 * A family is a *query against catalog data*, never a list of ids: a render kind,
 * optionally narrowed by a tag the catalog already carries. Adding an entry to the
 * catalog can change which entry a family resolves to, and that is intended — the
 * catalog stays the authority on what its own entries mean.
 */
type TransitionFamily = 'dissolve' | 'fade' | 'dip-to-black' | 'wipe' | 'zoom' | 'slide';

interface FamilyQuery {
  /** One value of the catalog's closed `TransitionRenderKind` enum. */
  readonly renderKind: CatalogTransition['renderKind'];
  /** Every tag must be present on the entry. Matched against the catalog's own `tags`. */
  readonly requireTags?: readonly string[];
}

const FAMILY_QUERIES: Readonly<Record<TransitionFamily, FamilyQuery>> = {
  /** The neutral blend. */
  dissolve: { renderKind: 'dissolve' },
  /** The blend that rises out of what is beneath it — an opening, not a join. */
  fade: { renderKind: 'dissolve', requireTags: ['fade'] },
  /** Down to black and back up: the only honest middle between two very different exposures. */
  'dip-to-black': { renderKind: 'dip-color', requireTags: ['black'] },
  /** A hard edge travelling across the frame. */
  wipe: { renderKind: 'wipe-linear' },
  /** Scale across the cut. */
  zoom: { renderKind: 'zoom' },
  /** Translation across the cut. */
  slide: { renderKind: 'slide' },
};

/**
 * The entry that represents a family, optionally in a given direction.
 *
 * Preference order — the catalog's own editorial judgement, in the catalog's own
 * fields: an entry it marks `recommended` ("safe on almost any cut"), else one it
 * marks `popular`, else the first in catalog order. The hard-cut entry is never a
 * candidate: removing a transition is not a transition.
 *
 * @param family - The family to resolve.
 * @param direction - Preferred direction; ignored when no entry in the family
 *   offers it, so a family always resolves.
 * @returns The catalog entry, or `undefined` if the catalog holds none — which
 *   the module's test asserts can never happen for the families it queries.
 */
function resolveFamily(
  family: TransitionFamily,
  direction?: string,
): CatalogTransition | undefined {
  const query = FAMILY_QUERIES[family];
  const candidates = TRANSITION_CATALOG.filter(
    (entry) =>
      entry.isCut !== true &&
      entry.renderKind === query.renderKind &&
      (query.requireTags ?? []).every((tag) => entry.tags.includes(tag)),
  );
  const directed =
    direction === undefined
      ? candidates
      : candidates.filter((entry) => defaultDirectionFor(entry) === direction);
  const pool = directed.length > 0 ? directed : candidates;
  return (
    pool.find((entry) => entry.recommended === true) ??
    pool.find((entry) => entry.popular === true) ??
    pool[0]
  );
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function clampDuration(seconds: number, min: number, max: number): number {
  const bounded = Math.min(max, Math.max(min, seconds));
  return Math.round(bounded * DURATION_ROUNDING) / DURATION_ROUNDING;
}

/** The layer's median picture-clip duration, or the fallback when it is unusable. */
function usablePacing(pacing: number): number {
  return Number.isFinite(pacing) && pacing > 0 ? pacing : FALLBACK_MEDIAN_SHOT_SECONDS;
}

/**
 * Alternate between two options on the cut's own index.
 *
 * Deterministic by construction, and it is what stops eight cuts of a montage all
 * pushing left — the thing that makes an auto-edit look auto.
 */
function alternate<T>(cut: MeasuredCut, even: T, odd: T): T {
  return Math.abs(Math.trunc(cut.index ?? 0)) % 2 === 0 ? even : odd;
}

/** True when the footage itself has the discontinuity a soften is meant to hide. */
function isJumpCut(cut: MeasuredCut): boolean {
  return cut.jumpCut === true || (cut.duplicate === true && (cut.shotSizeSteps ?? 0) === 0);
}

/**
 * A travel direction taken from the outgoing shot's camera movement.
 *
 * A pan or a tracking shot is already moving sideways and a tilt is already moving
 * vertically, so a transition that travels the same way continues the motion
 * instead of fighting it. The movement vocabulary carries no left/right or up/down,
 * so the sign alternates; a still or handheld camera gives no travel at all.
 */
function travelDirection(cut: MeasuredCut): string | undefined {
  switch (cut.outgoingCameraMovement) {
    case 'pan':
    case 'tracking':
      return alternate(cut, 'left', 'right');
    case 'tilt':
      return alternate(cut, 'up', 'down');
    default:
      return undefined;
  }
}

interface FamilyChoice {
  readonly family: TransitionFamily;
  readonly direction?: string;
}

/**
 * The family an energy or montage cut takes.
 *
 * A camera already zooming hands the cut a zoom; a camera already travelling hands
 * it a slide. With nothing measured the cut alternates push-in and pull-out, which
 * reads as variety rather than as a decision nobody made.
 */
function energyFamily(cut: MeasuredCut): FamilyChoice {
  const travel = travelDirection(cut);
  if (travel !== undefined) return { family: 'slide', direction: travel };
  if (Math.abs(cut.shotSizeSteps ?? 0) >= REDUNDANT_ZOOM_SHOT_SIZE_STEPS) {
    return { family: 'slide', direction: alternate(cut, 'left', 'right') };
  }
  if (cut.outgoingCameraMovement === 'zoom') return { family: 'zoom', direction: 'in' };
  return { family: 'zoom', direction: alternate(cut, 'in', 'out') };
}

/** A scene cut goes through black when the incoming shot is dark and the step down is large. */
function needsDipToBlack(cut: MeasuredCut): boolean {
  return cut.incomingIsDark === true && Math.abs(cut.lumaDelta ?? 0) >= DARK_DIP_LUMA_DELTA;
}

interface Decision {
  readonly family: TransitionFamily;
  readonly direction?: string;
  readonly seconds: number;
  readonly min: number;
  readonly max: number;
  readonly factor: number;
}

function decide(reason: TransitionReason, cut: MeasuredCut, pacing: number): Decision | null {
  switch (reason) {
    // A transition here is the classic amateur tell. No delta earns one.
    case 'continuity':
      return null;

    case 'time_jump':
      return {
        family: needsDipToBlack(cut) ? 'dip-to-black' : 'dissolve',
        seconds: pacing,
        min: SCENE_MIN_SECONDS,
        max: SCENE_MAX_SECONDS,
        factor: SCENE_DURATION_FACTOR,
      };

    case 'location_change': {
      // A wipe is a graphic device; it belongs only where the edit is already
      // cutting fast and the energy is rising, and reads as dated anywhere else.
      const wipes = cut.motionChange === 'up' && pacing < FAST_PACING_SECONDS;
      const direction = wipes ? travelDirection(cut) : undefined;
      return {
        family: wipes ? 'wipe' : 'dissolve',
        ...(direction === undefined ? {} : { direction }),
        seconds: pacing,
        min: SCENE_MIN_SECONDS,
        max: SCENE_MAX_SECONDS,
        factor: SCENE_DURATION_FACTOR,
      };
    }

    case 'energy':
    case 'montage': {
      const choice = energyFamily(cut);
      return {
        family: choice.family,
        ...(choice.direction === undefined ? {} : { direction: choice.direction }),
        seconds: pacing,
        min: ENERGY_MIN_SECONDS,
        max: ENERGY_MAX_SECONDS,
        factor: ENERGY_DURATION_FACTOR,
      };
    }

    case 'soften':
      return {
        family: 'dissolve',
        seconds: pacing,
        // A measured jump cut needs enough blend to swallow the pop; a plain
        // "smooth this" does not, and a shorter dissolve draws less attention.
        min: isJumpCut(cut) ? JUMP_CUT_MIN_SOFTEN_SECONDS : SOFTEN_MIN_SECONDS,
        max: SOFTEN_MAX_SECONDS,
        factor: SCENE_DURATION_FACTOR,
      };

    case 'reveal':
      // An opening gesture. Mid-timeline it is a dissolve the user did not ask
      // for, so the honest answer there is the hard cut the edit already has.
      //
      // `!== true`, not `=== false`: `isFirstCut` is OPTIONAL, and an absent flag means the
      // caller does not know where this cut sits. Treating unknown as "first" put a fade
      // anywhere in the timeline for any caller that omitted it — the exact behaviour the
      // line above says is dishonest. A reveal needs positive proof it opens the sequence.
      if (cut.isFirstCut !== true) return null;
      return {
        family: 'fade',
        seconds: pacing,
        min: REVEAL_MIN_SECONDS,
        max: REVEAL_MAX_SECONDS,
        factor: SCENE_DURATION_FACTOR,
      };
  }
}

/**
 * The transition this cut should get, or `null` for a hard cut.
 *
 * @param reason - Why the model believes a transition belongs here.
 * @param cut - What was measured about the two shots. Absent fields are unknown.
 * @param pacing - Median picture-clip duration on the layer, in seconds. A
 *   non-finite or non-positive value falls back to a nominal shot length.
 * @returns The catalog id and the duration to add, or `null` when the right
 *   answer is to leave the cut hard.
 */
export function chooseTransition(
  reason: TransitionReason,
  cut: MeasuredCut,
  pacing: number,
): TransitionChoice | null {
  const decision = decide(reason, cut, usablePacing(pacing));
  if (decision === null) return null;
  const entry = resolveFamily(decision.family, decision.direction);
  if (entry === undefined) return null;
  return {
    kind: entry.id,
    durationSeconds: clampDuration(decision.seconds * decision.factor, decision.min, decision.max),
  };
}
