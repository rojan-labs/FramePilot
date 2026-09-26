/**
 * Animation for stickers, shapes and titles (plan/elements EL7, 02 §4): **In**, **Out** and
 * **Loop**, as one request turned into one reversible set of operations. The Inspector's
 * Animation section and the agent's `set_element_animation` both build through here.
 *
 * - **In / Out** are layer transitions (`add_layer_transition`) from a curated set named by
 *   where the layer goes: "Slide left" enters travelling left, and leaves travelling left. An
 *   exit that moves plays its entrance backwards (the frame plan's `reversed`), so leaving to the
 *   left is the slide that enters from the left, reversed.
 * - **Loop** is keyframes from `loop-motion.ts`.
 * - A title's old In/Out params (`inAnimation`/`outAnimation`, honoured since EL2a) are still
 *   read, and cleared when its In or Out is set here: they are no longer written.
 */
import type { Clip, Effect, Timeline } from '@framepilot/timeline-schema';
import { getTransition } from '@framepilot/timeline-schema/transition-catalog';
import { layerTransitionEligibility } from './edit-boundaries.js';
import {
  clearLoopOperations,
  clipLoop,
  planLoopMotion,
  type AppliedLoop,
  type LoopRequest,
} from './loop-motion.js';
import type { Operation } from './operations.js';
import { syntheticClipKind } from './synthetic-assets.js';
import { TRANSITION_EFFECT_TYPE, TRANSITION_OUT_EFFECT_TYPE } from './transitions.js';

export type AnimationKind =
  'fade' | 'pop' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down' | 'wipe' | 'blur';

/** One In/Out choice: its label, and the catalogue transition that draws it at each end. */
export interface AnimationKindSpec {
  readonly id: AnimationKind;
  readonly label: string;
  /** The transition an entrance uses. */
  readonly in: string;
  /** The transition an exit uses (a moving one plays backwards, so it is the mirror entrance). */
  readonly out: string;
}

export const ANIMATION_KINDS: Readonly<Record<AnimationKind, AnimationKindSpec>> = {
  fade: { id: 'fade', label: 'Fade', in: 'fade', out: 'fade' },
  pop: { id: 'pop', label: 'Pop', in: 'zoom-out', out: 'zoom-out' },
  'slide-left': { id: 'slide-left', label: 'Slide left', in: 'slide-left', out: 'slide-right' },
  'slide-right': { id: 'slide-right', label: 'Slide right', in: 'slide-right', out: 'slide-left' },
  'slide-up': { id: 'slide-up', label: 'Slide up', in: 'slide', out: 'slide-down' },
  'slide-down': { id: 'slide-down', label: 'Slide down', in: 'slide-down', out: 'slide' },
  wipe: { id: 'wipe', label: 'Wipe', in: 'wipe', out: 'wipe' },
  blur: { id: 'blur', label: 'Blur', in: 'blur', out: 'blur' },
};

/** The title In/Out presets a title stored before EL7, in this vocabulary. */
const LEGACY_TITLE_KINDS: Readonly<Record<string, AnimationKind>> = {
  fade: 'fade',
  'slide-up': 'slide-up',
  'slide-down': 'slide-down',
  pop: 'pop',
};
/** What a title's absent `animDurationSeconds` meant (`TITLE_ANIMATION_DEFAULT_SECONDS`). */
const LEGACY_TITLE_SECONDS = 0.4;

/** One end of an element's animation. */
export interface AnimationEdge {
  readonly kind: AnimationKind;
  /** Absent: the transition's own default length (clamped to half the clip). */
  readonly seconds?: number;
}

/** What to set: an end or the loop left out stays as it is; `null` removes it. */
export interface ElementAnimationRequest {
  readonly in?: AnimationEdge | null;
  readonly out?: AnimationEdge | null;
  readonly loop?: LoopRequest | null;
}

export type ElementAnimationPlan =
  | { readonly ok: true; readonly operations: readonly Operation[] }
  | { readonly ok: false; readonly detail: string };

/** An element's animation as the Inspector shows it. */
export interface ElementAnimation {
  /** `kind: null` for a transition outside the curated set (set elsewhere): shown as it is. */
  readonly in: { readonly kind: AnimationKind | null; readonly seconds: number } | null;
  readonly out: { readonly kind: AnimationKind | null; readonly seconds: number } | null;
  readonly loop: AppliedLoop | null;
}

/** The clip's own entrance or exit — not either half of a cut, which belongs to its neighbour. */
function layerEdgeEffect(clip: Clip, edge: 'in' | 'out'): Effect | undefined {
  return clip.effects.find((effect) =>
    edge === 'in'
      ? effect.type === TRANSITION_EFFECT_TYPE && effect.params.fromClipId === undefined
      : effect.type === TRANSITION_OUT_EFFECT_TYPE && effect.params.toClipId === undefined,
  );
}

function textEffect(clip: Clip): Effect | undefined {
  return syntheticClipKind(clip.assetId) === 'text'
    ? clip.effects.find((effect) => effect.type === 'text')
    : undefined;
}

function readEdge(clip: Clip, edge: 'in' | 'out'): ElementAnimation['in'] {
  const effect = layerEdgeEffect(clip, edge);
  if (effect !== undefined) {
    const transition = String(effect.params.kind ?? '');
    const kind =
      Object.values(ANIMATION_KINDS).find((spec) => spec[edge] === transition)?.id ?? null;
    const seconds = Number(effect.params.durationSeconds);
    return { kind, seconds: Number.isFinite(seconds) ? seconds : 0 };
  }
  const params = textEffect(clip)?.params;
  const legacy = params?.[edge === 'in' ? 'inAnimation' : 'outAnimation'];
  const kind = typeof legacy === 'string' ? LEGACY_TITLE_KINDS[legacy] : undefined;
  if (kind === undefined) return null;
  const seconds = params?.animDurationSeconds;
  return { kind, seconds: typeof seconds === 'number' ? seconds : LEGACY_TITLE_SECONDS };
}

/** The clip's In, Out and Loop. */
export function clipAnimation(clip: Clip): ElementAnimation {
  return { in: readEdge(clip, 'in'), out: readEdge(clip, 'out'), loop: clipLoop(clip) };
}

const refuse = (detail: string): ElementAnimationPlan => ({ ok: false, detail });

/**
 * The operations that set `request` on clip `clipId`: removals first, then the ends, then the
 * loop, so the whole change is one patch and one undo.
 *
 * @param frame - The project frame, which a float or bounce loop moves a share of.
 */
export function planElementAnimation(
  timeline: Timeline,
  clipId: string,
  request: ElementAnimationRequest,
  frame: { readonly width: number; readonly height: number },
): ElementAnimationPlan {
  const track = timeline.tracks.find((candidate) => candidate.clips.some((c) => c.id === clipId));
  const clip = track?.clips.find((candidate) => candidate.id === clipId);
  if (track === undefined || clip === undefined || track.type !== 'overlay') {
    return refuse(
      'Only a sticker, shape, title or picture on a graphics layer takes an animation. Pick one of those by its clip id from the timeline.',
    );
  }
  if (request.in === undefined && request.out === undefined && request.loop === undefined) {
    return refuse('Nothing to change. Pass an In, an Out or a Loop (null removes one).');
  }

  const dropped = new Set<string>();
  const legacyCleared: Record<string, undefined> = {};
  const adds: Operation[] = [];
  for (const edge of ['in', 'out'] as const) {
    const wanted = request[edge];
    if (wanted === undefined) continue;
    // Setting or removing an end retires a title's old In/Out for that end.
    const legacyKey = edge === 'in' ? 'inAnimation' : 'outAnimation';
    if (textEffect(clip)?.params[legacyKey] !== undefined) legacyCleared[legacyKey] = undefined;
    const current = layerEdgeEffect(clip, edge);
    if (wanted === null) {
      if (current !== undefined) dropped.add(current.id);
      continue;
    }
    const spec = ANIMATION_KINDS[wanted.kind] as AnimationKindSpec | undefined;
    if (spec === undefined) {
      return refuse(
        `That is not an animation this build offers. Use one of: ${Object.keys(ANIMATION_KINDS).join(', ')}.`,
      );
    }
    const transition = spec[edge];
    const durationSeconds = wanted.seconds ?? getTransition(transition)?.defaultDuration ?? 0.5;
    const verdict = layerTransitionEligibility(timeline, {
      clipId,
      edge,
      kind: transition,
      durationSeconds,
    });
    if (!verdict.ok) return refuse(verdict.detail);
    adds.push({ type: 'add_layer_transition', clipId, edge, kind: transition, durationSeconds });
  }

  let loopOperations: readonly Operation[] = [];
  if (request.loop === null) loopOperations = clearLoopOperations(clip);
  else if (request.loop !== undefined) {
    const plan = planLoopMotion(clip, request.loop, frame);
    if (!plan.ok) return refuse(plan.detail);
    loopOperations = plan.operations;
  }

  const operations: Operation[] = [];
  if (dropped.size > 0) {
    // There is no remove-effect op: the track is restored with the ends taken off, which
    // inverts to the track as it was (the Inspector's transition removal does the same).
    operations.push({
      type: 'restore_clips',
      trackId: track.id,
      clips: track.clips.map((candidate) =>
        candidate.id === clipId
          ? { ...candidate, effects: candidate.effects.filter((e) => !dropped.has(e.id)) }
          : candidate,
      ),
    });
  }
  const text = textEffect(clip);
  if (text !== undefined && Object.keys(legacyCleared).length > 0) {
    operations.push({
      type: 'set_effect_params',
      clipId,
      effectId: text.id,
      params: legacyCleared,
    });
  }
  operations.push(...adds, ...loopOperations);
  return { ok: true, operations };
}
