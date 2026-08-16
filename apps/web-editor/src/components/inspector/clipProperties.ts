/**
 * Copyable clip properties (revamp Phase 4, F6 — copy / paste / apply-to-selected /
 * reset-all).
 *
 * ## Why one module for four actions
 *
 * "Copy properties", "paste properties", "apply to selected" and "reset all" are the
 * same question asked four ways: *which properties travel with a clip's look, and how
 * do you write them somewhere else?* Answering it once means the four actions cannot
 * disagree about, say, whether speed is part of a clip's look.
 *
 * ## What counts as a property, and what does not
 *
 * In: the clip's **look and sound** — base transform, colour grade, speed, crop,
 * blend mode, audio settings.
 *
 * Out, deliberately:
 *  - **Timing** (`start`/`end`/`sourceStart`/`sourceEnd`). Pasting a clip's timing
 *    onto another clip is a *move*, not a property paste, and would silently shuffle
 *    the sequence.
 *  - **Transitions.** A transition is a treatment of one boundary between two
 *    specific clips; copied onto an unrelated cut it is meaningless, and onto a clip
 *    with no cut it is invalid.
 *  - **Text/caption content.** The words are the clip's *content*, not its look.
 *  - **Animation beyond time 0.** Only the BASE transform travels. Copying a whole
 *    keyframe track onto a clip of a different length would either overrun its end or
 *    leave the animation truncated, and neither is what "paste properties" promises.
 *    Copying animation is what presets are for (Phase 11).
 *
 * ## One patch, always
 *
 * Every write here merges the individual builders' operations into a **single**
 * `Patch`. Pasting six properties onto four clips is one undo step, because it was
 * one user action. Building six patches per clip would make undo need 24 presses to
 * reverse one paste.
 */
import type { Patch } from '@framepilot/editor-core';
import type { BlendMode, CropRect, Timeline } from '@framepilot/timeline-schema';
import {
  type AudioSettings,
  type ColorGradeParams,
  audioSettings,
  clipBlendMode,
  clipCropRect,
  clipSpeed,
  colorGradeParams,
  findClip,
} from '../../editor/selectors.js';
import {
  setAudioPatch,
  setClipBlendModePatch,
  setClipCropPatch,
  setClipSpeedPatch,
  setClipTransformPatch,
  setColorGradePatch,
} from '../../editor/patch-builders.js';
import { baseTransformOf } from '../../preview/picture-transform.js';
import type { ClipLocation } from './selection.js';

/** The base transform, as it travels between clips. */
export interface TransformProperties {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

/** A clip's look and sound, detached from the clip. */
export interface ClipProperties {
  readonly transform: TransformProperties;
  readonly grade: ColorGradeParams;
  /**
   * The EFFECTIVE playback rate, where `1` is native — the same convention
   * `clipSpeed` reports and the Speed section shows. Not `number | null`: a clip
   * with no `speed` set reads as 1, so holding null here would make an untouched
   * clip look different from its own identity and "reset all" would always produce
   * a patch.
   */
  readonly speed: number;
  readonly crop: CropRect;
  readonly blendMode: BlendMode;
  readonly audio: AudioSettings;
}

/** The engine's identity for every copyable property — what "reset all" writes. */
export const IDENTITY_TRANSFORM: TransformProperties = { scale: 1, x: 0, y: 0, rotation: 0 };

/** Whether two base transforms are the same to the precision the engine stores. */
function sameTransform(a: TransformProperties, b: TransformProperties): boolean {
  return a.scale === b.scale && a.x === b.x && a.y === b.y && a.rotation === b.rotation;
}

/** Whether two grades agree on every axis. */
function sameGrade(a: ColorGradeParams, b: ColorGradeParams): boolean {
  return (Object.keys(a) as (keyof ColorGradeParams)[]).every((key) => a[key] === b[key]);
}

/** Whether two crop rects describe the same region. */
function sameCrop(a: CropRect, b: CropRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Whether two audio settings agree on every field the inspector writes. */
function sameAudio(a: AudioSettings, b: AudioSettings): boolean {
  return (
    a.gainDb === b.gainDb &&
    a.fadeInSeconds === b.fadeInSeconds &&
    a.fadeOutSeconds === b.fadeOutSeconds &&
    a.muted === b.muted &&
    a.normalize === b.normalize &&
    a.duckUnderTrackId === b.duckUnderTrackId
  );
}

/** Read a clip's copyable properties. */
export function readClipProperties(location: ClipLocation): ClipProperties {
  const { clip } = location;
  return {
    transform: baseTransformOf(clip.keyframes),
    grade: colorGradeParams(clip),
    speed: clipSpeed(clip),
    crop: clipCropRect(clip),
    blendMode: clipBlendMode(clip),
    audio: audioSettings(clip),
  };
}

/**
 * One patch that writes `properties` onto every clip in `clipIds`.
 *
 * Returns `null` when nothing would change — an empty target list, or a paste whose
 * values already match everywhere. A no-op patch would still land in history as an
 * undoable step that did nothing, which makes undo untrustworthy.
 */
export function applyClipPropertiesPatch(
  timeline: Timeline,
  clipIds: readonly string[],
  properties: ClipProperties,
  reason: string,
): Patch | null {
  const operations = clipIds.flatMap((clipId) => {
    const found = findClip(timeline, clipId);
    if (!found) return [];
    // Compare against what the clip already has, per property, and skip the ones
    // that would not change.
    //
    // This guard has to live HERE rather than being left to the builders: most of
    // them return null for a no-op, but `setClipTransformPatch` does not — it
    // writes `add_keyframes` whenever the values are finite, because its normal
    // caller is a drag that has by definition moved something. Without this,
    // "reset all" on an already-default clip produced a patch that changed nothing
    // and still consumed an undo step.
    const current = readClipProperties(found);
    // `unless` is applied to EVERY property, not just some: none of the underlying
    // builders compares against the clip's current value — each returns a patch
    // whenever the clip merely exists, because each one's normal caller is a control
    // the user has just moved. Only this function has both sides to compare.
    const unless = (same: boolean, build: () => Patch | null): Patch | null =>
      same ? null : build();
    return [
      unless(sameTransform(current.transform, properties.transform), () =>
        setClipTransformPatch(timeline, clipId, properties.transform),
      ),
      unless(sameGrade(current.grade, properties.grade), () =>
        setColorGradePatch(timeline, clipId, properties.grade as unknown as Record<string, number>),
      ),
      unless(current.speed === properties.speed, () =>
        // 1 clears the property rather than storing a redundant `speed: 1`, which is
        // the same mapping the Speed section applies.
        setClipSpeedPatch(timeline, clipId, properties.speed === 1 ? null : properties.speed),
      ),
      unless(sameCrop(current.crop, properties.crop), () =>
        setClipCropPatch(timeline, clipId, properties.crop),
      ),
      unless(current.blendMode === properties.blendMode, () =>
        setClipBlendModePatch(timeline, clipId, properties.blendMode),
      ),
      unless(sameAudio(current.audio, properties.audio), () =>
        setAudioPatch(timeline, clipId, properties.audio),
      ),
    ]
      .filter((patch): patch is Patch => patch !== null)
      .flatMap((patch) => patch.operations);
  });
  if (operations.length === 0) return null;
  return {
    // `PatchId` is a branded string; the cast is the same one `patch-builders.ts`
    // makes in its own local `patchId` helper.
    patchId: `inspector_props_${clipIds.join('_')}_${operations.length}` as Patch['patchId'],
    createdBy: 'user',
    reason,
    operations,
  };
}

/** One patch returning every clip in `clipIds` to the engine's default look. */
export function resetClipPropertiesPatch(
  timeline: Timeline,
  clipIds: readonly string[],
  defaults: ClipProperties,
): Patch | null {
  return applyClipPropertiesPatch(
    timeline,
    clipIds,
    defaults,
    `Reset properties on ${clipIds.length} clip${clipIds.length === 1 ? '' : 's'}`,
  );
}
