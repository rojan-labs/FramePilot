/**
 * Public selector surface.
 *
 * The historical selector implementation remains byte-for-byte in selectors-base.ts.
 * Hot pointer-path selectors are overridden here with identity caches over immutable
 * timeline/track objects. Preview projections also carry compact identity signatures so
 * WebCodecs change guards never stringify large keyframe/effect payloads.
 */
export * from './selectors-base.js';

import type { Asset, Clip, EffectLayer, Timeline, Track } from '@framepilot/timeline-schema';
import {
  clipCompositing as baseClipCompositing,
  effectLayersInApplyOrder as baseEffectLayersInApplyOrder,
  webCodecsPreviewEligible as baseWebCodecsPreviewEligible,
  type ClipCompositing,
  type Junction,
} from './selectors-base.js';
import { withPreviewIdentity } from '../preview/semantic-signature.js';

const staticSnapTargets = new WeakMap<Timeline, readonly number[]>();
interface MergedSnapCache {
  readonly extra: readonly number[];
  readonly targets: readonly number[];
}
const mergedSnapTargets = new WeakMap<Timeline, MergedSnapCache>();
const junctionCache = new WeakMap<Track, readonly Junction[]>();
const JUNCTION_TOUCH_SECONDS = 1e-2;

// WebCodecs currently hands each loaded proxy to decodeAudioData(), which expands the complete
// source into float32 PCM. Bound that steady-state cost and use the existing streaming DOM
// preview for longer/multi-source projects. 48 kHz stereo float32 is the conservative budget;
// mono/lower-rate sources simply use less than estimated.
export const MAX_WEBCODECS_DECODED_AUDIO_BYTES = 256 * 1024 * 1024;
const PREVIEW_AUDIO_SAMPLE_RATE = 48_000;
const PREVIEW_AUDIO_CHANNELS = 2;
const PREVIEW_AUDIO_BYTES_PER_SAMPLE = 4;
const PREVIEW_AUDIO_BYTES_PER_SECOND =
  PREVIEW_AUDIO_SAMPLE_RATE * PREVIEW_AUDIO_CHANNELS * PREVIEW_AUDIO_BYTES_PER_SAMPLE;

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function baseTargets(timeline: Timeline): readonly number[] {
  const cached = staticSnapTargets.get(timeline);
  if (cached) return cached;
  const targets = new Set<number>([0]);
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      targets.add(clip.start);
      targets.add(clip.end);
    }
  }
  const sorted = [...targets].sort((a, b) => a - b);
  staticSnapTargets.set(timeline, sorted);
  return sorted;
}

/**
 * Snap targets for a gesture, optionally EXCLUDING one clip's own edges.
 *
 * `excludeClipId` exists because a clip cannot meaningfully snap to where it
 * already is. Without it the first pointer move of a drag lands inside the capture
 * radius of the edge the clip started on, the magnet grabs it, and the clip then
 * will not move until the pointer has travelled the whole release distance — a
 * dead zone at the start of every move and trim.
 *
 * The exclusion deliberately skips the identity cache: it is one array walk per
 * pointer frame over the clips of a timeline that is otherwise memoised, and
 * caching per (timeline, extra, clipId) would keep a strong key per dragged clip
 * for the life of the timeline object.
 */
export function snapTargets(
  timeline: Timeline,
  extra: readonly number[] = [],
  excludeClipId?: string | null,
): readonly number[] {
  if (excludeClipId !== undefined && excludeClipId !== null) {
    const excluded = new Set<number>();
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.id !== excludeClipId) continue;
        excluded.add(clip.start);
        excluded.add(clip.end);
      }
    }
    if (excluded.size > 0) {
      const full = snapTargets(timeline, extra);
      // An edge shared with another clip stays a target: a butt-joined neighbour's
      // start is a real place to land, and it happens to equal this clip's end.
      const shared = new Set<number>();
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          if (clip.id === excludeClipId) continue;
          if (excluded.has(clip.start)) shared.add(clip.start);
          if (excluded.has(clip.end)) shared.add(clip.end);
        }
      }
      return full.filter((time) => !excluded.has(time) || shared.has(time));
    }
  }
  const prior = mergedSnapTargets.get(timeline);
  if (prior && sameNumbers(prior.extra, extra)) return prior.targets;
  const base = baseTargets(timeline);
  if (extra.length === 0) {
    mergedSnapTargets.set(timeline, { extra: [], targets: base });
    return base;
  }
  const additions = [...new Set(extra.filter(Number.isFinite))].sort((a, b) => a - b);
  const merged: number[] = [];
  let left = 0;
  let right = 0;
  while (left < base.length || right < additions.length) {
    const a = base[left];
    const b = additions[right];
    let next: number;
    if (b === undefined || (a !== undefined && a < b)) {
      next = a!;
      left += 1;
    } else if (a === undefined || b < a) {
      next = b;
      right += 1;
    } else {
      next = a;
      left += 1;
      right += 1;
    }
    if (merged.at(-1) !== next) merged.push(next);
  }
  mergedSnapTargets.set(timeline, { extra: [...extra], targets: merged });
  return merged;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function snap(time: number, targets: readonly number[], threshold: number): number {
  const clamped = time < 0 ? 0 : time;
  if (targets.length === 0 || threshold < 0) return clamped;
  const index = lowerBound(targets, clamped);
  const before = index > 0 ? targets[index - 1] : undefined;
  const after = targets[index];
  const beforeDistance =
    before === undefined ? Number.POSITIVE_INFINITY : Math.abs(before - clamped);
  const afterDistance = after === undefined ? Number.POSITIVE_INFINITY : Math.abs(after - clamped);
  if (after !== undefined && afterDistance <= beforeDistance && afterDistance <= threshold)
    return after;
  if (before !== undefined && beforeDistance <= threshold) return before;
  return clamped;
}

export function trackJunctions(track: Track): readonly Junction[] {
  const cached = junctionCache.get(track);
  if (cached) return cached;
  const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
  const junctions: Junction[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const next = ordered[index]!;
    junctions.push({
      trackId: track.id,
      fromClipId: previous.id,
      toClipId: next.id,
      cutTime: next.start,
      touching: Math.abs(next.start - previous.end) <= JUNCTION_TOUCH_SECONDS,
    });
  }
  junctionCache.set(track, junctions);
  return junctions;
}

/** Full compositing data for the engine, compact identity for JSON signature guards. */
export function clipCompositing(clip: Clip): ClipCompositing {
  return withPreviewIdentity(baseClipCompositing(clip), clip);
}

/** Full effect-layer objects for the engine, compact identities for JSON signature guards. */
export function effectLayersInApplyOrder(timeline: Timeline): readonly EffectLayer[] {
  return baseEffectLayersInApplyOrder(timeline).map((layer) =>
    withPreviewIdentity({ ...layer }, layer),
  );
}

/**
 * WebCodecs eligibility plus a hard decoded-PCM budget.
 *
 * The base selector owns feature/proxy eligibility. This public override adds only resource
 * admission: each unique video source is decoded to a complete AudioBuffer today, so duration
 * is translated into a conservative PCM byte estimate. Unknown duration fails to the streaming
 * DOM preview instead of entering an unbounded allocation path.
 */
export function webCodecsPreviewEligible(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
  resolution: { readonly width: number; readonly height: number },
): boolean {
  if (!baseWebCodecsPreviewEligible(timeline, assetById, resolution)) return false;
  const sourceIds = new Set<string>();
  let estimatedAudioBytes = 0;
  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const asset = assetById.get(clip.assetId);
      if (asset?.kind === 'image' || sourceIds.has(clip.assetId)) continue;
      // The base selector already established that picture video is proxy-backed. Audio-only
      // assets are not loaded by the WebCodecs picture engine, so only video sources count.
      if (asset?.kind !== undefined && asset.kind !== 'video') continue;
      if (asset?.durationSeconds === undefined) return false;
      sourceIds.add(clip.assetId);
      estimatedAudioBytes += asset.durationSeconds * PREVIEW_AUDIO_BYTES_PER_SECOND;
      if (estimatedAudioBytes > MAX_WEBCODECS_DECODED_AUDIO_BYTES) return false;
    }
  }
  return true;
}
