/**
 * The inspector's selection model (revamp Phase 4, F6).
 *
 * ## Why this exists
 *
 * The inspector used to decide what to show with `if` statements scattered through
 * a 1,049-line component: a `track.type === 'audio' || track.type === 'video'`
 * here, a `textEffectOf(clip)` there, an early `return` for effect layers near the
 * top. Adding a section meant editing a god-component and hoping you found every
 * place that needed a new condition — and because the conditions were inline, there
 * was no single answer to "what is selected right now?" that anything else could
 * read.
 *
 * This module answers that question once, purely, so the section registry can be a
 * plain `filter` and so multi-select behaviour has somewhere to live.
 *
 * Pure: a projection of editor state, no React and no DOM.
 */
import type { Clip, Track } from '@framepilot/timeline-schema';
import {
  type EffectLayerLocation,
  clipTransition,
  findClip,
  findEffectLayer,
} from '../../editor/selectors.js';
import { textEffectOf } from '../../editor/patch-builders.js';
import type { Timeline } from '@framepilot/timeline-schema';

/** A clip plus the track it sits on — what every section actually needs. */
export interface ClipLocation {
  readonly clip: Clip;
  readonly track: Track;
}

/**
 * What the inspector is looking at.
 *
 * `effect-layer` outranks any clip selection: an effect layer was the last thing
 * clicked and its own controls are what the user is reaching for. It is also NOT
 * attached to a clip, so it must be editable with no clip selected at all — which
 * is the normal case.
 */
export type InspectorSelectionKind = 'none' | 'clip' | 'multi-clip' | 'effect-layer';

export interface InspectorSelection {
  readonly kind: InspectorSelectionKind;
  /**
   * Every selected clip, PRIMARY FIRST. The primary is the one single-value
   * controls edit and the one whose id is shown; the rest matter for mixed values
   * and apply-to-all.
   */
  readonly clips: readonly ClipLocation[];
  /** Convenience for the (very common) single-target case. */
  readonly primary: ClipLocation | null;
  /** Selected effect layer ids, primary first. */
  readonly effectLayerIds: readonly string[];
  /** The primary effect layer, resolved — `null` unless `kind` is `effect-layer`. */
  readonly effectLayer: EffectLayerLocation | null;
  /** True when EVERY selected clip carries a text/caption effect. */
  readonly hasText: boolean;
  /** True when EVERY selected clip sits on a track that can carry audio. */
  readonly hasAudio: boolean;
  /** True when the primary clip has a transition on its incoming edge. */
  readonly hasTransition: boolean;
}

const EMPTY: InspectorSelection = {
  kind: 'none',
  clips: [],
  primary: null,
  effectLayerIds: [],
  effectLayer: null,
  hasText: false,
  hasAudio: false,
  hasTransition: false,
};

/** A track that can carry audio — the gate the Audio section has always used. */
const audioBearing = (track: Track): boolean => track.type === 'audio' || track.type === 'video';

/**
 * Resolve what the inspector should be looking at.
 *
 * @param timeline - The project timeline.
 * @param selection - The PRIMARY selected clip id (`editor.state.selection`).
 * @param selectedIds - The whole clip selection (`editor.state.selectedIds`).
 * @param effectLayerIds - Selected effect layer ids (view state, held by `Editor`).
 */
export function resolveInspectorSelection(
  timeline: Timeline,
  selection: string | null,
  selectedIds: readonly string[],
  effectLayerIds: readonly string[] = [],
): InspectorSelection {
  // An effect layer wins, and is resolved before any clip lookup — see the type note.
  const primaryLayerId = effectLayerIds[0];
  if (primaryLayerId !== undefined) {
    const layer = findEffectLayer(timeline, primaryLayerId);
    if (layer !== undefined) {
      return { ...EMPTY, kind: 'effect-layer', effectLayerIds, effectLayer: layer };
    }
  }

  // Order the clips PRIMARY FIRST. `selectedIds` is in selection order, which is
  // not the same thing: shift-clicking a second clip leaves the first primary, and
  // single-value controls must keep editing that one.
  const orderedIds =
    selection === null ? selectedIds : [selection, ...selectedIds.filter((id) => id !== selection)];
  const clips = orderedIds
    .map((id) => findClip(timeline, id))
    .filter((found): found is ClipLocation => found !== null && found !== undefined);
  if (clips.length === 0) return EMPTY;

  const primary = clips[0] as ClipLocation;
  return {
    kind: clips.length > 1 ? 'multi-clip' : 'clip',
    clips,
    primary,
    effectLayerIds: [],
    effectLayer: null,
    // EVERY, not SOME: a section that only some of the selection can accept would
    // silently no-op on the rest, which is worse than not offering it.
    hasText: clips.every((location) => textEffectOf(location.clip) !== undefined),
    hasAudio: clips.every((location) => audioBearing(location.track)),
    hasTransition: clipTransition(primary.clip) !== undefined,
  };
}

/** Whether the selection has at least one clip (single or multi). */
export function hasClipSelection(selection: InspectorSelection): boolean {
  return selection.kind === 'clip' || selection.kind === 'multi-clip';
}
