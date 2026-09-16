/**
 * Schema v21 → v22: `mask` effects become the clip's mask stack (ADR 0178).
 *
 * Pure and defensive about shape (raw JSON is unvalidated here, exactly as in every other
 * migration step): anything that is not the expected object/array shape passes through.
 *
 * ## What a v21 mask meant, precisely
 *
 * The export compiler (`_attach_mask`) took the FIRST `mask` effect on a clip, after crop
 * and speed, and rasterised it with `render/masks.py`:
 *
 * - geometry (`bounds`, `points`) in fractions of the **cropped** source frame;
 * - `feather` as a fraction of that frame's smaller side, used as a Gaussian blur radius;
 * - keyframes on `x`/`y`/`width`/`height`/`feather`/`opacity` in **clip-relative timeline
 *   seconds** (the mask is attached after the speed transform);
 * - a `polygon` with fewer than three points fell back to the `bounds` rectangle;
 * - every later `mask` effect was ignored.
 *
 * The migration reproduces exactly that, in the v22 vocabulary: display-corrected source
 * pixels (through the crop), `featherModel: 'gaussian-legacy'`, and source-time keyframes
 * mapped through the clip's speed or ramp, so an existing project renders the same.
 */
import { evaluateSortedCurve, type TimedCurvePoint } from './keyframe-curves.js';
import { sourceTimeAt } from './speed-curve.js';
import type { SpeedPoint } from './index.js';

type RawRecord = Record<string, unknown>;

/** The v21 effect type this migration retires. */
export const LEGACY_MASK_EFFECT_TYPE = 'mask';

/** Remedy the validator repeats for a mask whose media size was unknown at upgrade time. */
export const MASK_MEASURE_MEDIA_NOTE =
  'Measure this media first: the media size was unknown when the project was upgraded, so this ' +
  "mask's geometry is kept as fractions of the frame it was drawn on.";

/** Why every mask after the first comes through disabled. */
export const MASK_DISABLED_EXTRA_NOTE =
  'Disabled during the v22 upgrade: earlier versions only rendered the first mask on a clip, ' +
  'so this one was never visible. Enable it to use it.';

const LEGACY_ANIMATABLE = new Set(['x', 'y', 'width', 'height', 'feather', 'opacity']);
const LEGACY_EASINGS = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier']);

const isRecord = (value: unknown): value is RawRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

interface Crop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

interface LegacyKeyframe extends TimedCurvePoint {
  readonly property: string;
  readonly handles?: {
    readonly out: readonly [number, number];
    readonly in: readonly [number, number];
  };
}

/** One scalar keyframe of the v22 mask, still on the legacy (timeline) clock. */
interface DraftKeyframe {
  readonly property: string;
  readonly time: number;
  readonly value: number;
  readonly easing: string;
  readonly handles?: LegacyKeyframe['handles'];
}

function readCrop(clip: RawRecord): Crop {
  const crop = clip.crop;
  if (!isRecord(crop)) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: finiteOr(crop.x, 0),
    y: finiteOr(crop.y, 0),
    width: finiteOr(crop.width, 1),
    height: finiteOr(crop.height, 1),
  };
}

function readDimensions(raw: RawRecord, assetId: unknown): Dimensions | null {
  if (typeof assetId !== 'string' || !Array.isArray(raw.assets)) return null;
  const asset = raw.assets.find((candidate) => isRecord(candidate) && candidate.id === assetId);
  if (!isRecord(asset) || !isRecord(asset.media)) return null;
  const { width, height } = asset.media;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

function readHandles(value: unknown): LegacyKeyframe['handles'] | undefined {
  if (!isRecord(value)) return undefined;
  const pair = (candidate: unknown): readonly [number, number] | undefined =>
    Array.isArray(candidate) &&
    candidate.length === 2 &&
    typeof candidate[0] === 'number' &&
    typeof candidate[1] === 'number'
      ? [candidate[0], candidate[1]]
      : undefined;
  const out = pair(value.out);
  const into = pair(value.in);
  return out && into ? { out, in: into } : undefined;
}

function readLegacyKeyframes(effect: RawRecord): { keyframes: LegacyKeyframe[]; dropped: number } {
  const keyframes: LegacyKeyframe[] = [];
  let dropped = 0;
  const list = Array.isArray(effect.keyframes) ? effect.keyframes : [];
  for (const entry of list) {
    if (
      !isRecord(entry) ||
      typeof entry.property !== 'string' ||
      !LEGACY_ANIMATABLE.has(entry.property) ||
      typeof entry.time !== 'number' ||
      !Number.isFinite(entry.time) ||
      typeof entry.value !== 'number' ||
      !Number.isFinite(entry.value)
    ) {
      dropped += 1;
      continue;
    }
    const easing =
      typeof entry.easing === 'string' && LEGACY_EASINGS.has(entry.easing)
        ? entry.easing
        : 'linear';
    const handles = readHandles(entry.handles);
    keyframes.push({
      property: entry.property,
      time: entry.time,
      value: entry.value,
      easing,
      ...(handles ? { handles } : {}),
    });
  }
  return { keyframes, dropped };
}

const byTime = (a: { time: number }, b: { time: number }): number => a.time - b.time;

const pointsFor = (keyframes: readonly LegacyKeyframe[], property: string): LegacyKeyframe[] =>
  keyframes.filter((keyframe) => keyframe.property === property).sort(byTime);

/**
 * A derived property's keyframes, e.g. `cx = x + width / 2`.
 *
 * Exact whenever the inputs are animated on the same instants with the same curves (the
 * tracked-mask case) or only one input is animated: a linear combination of curves that
 * share an easing IS that easing. Otherwise it is resampled at the union of instants with
 * each instant's value evaluated exactly, and `resampled` says so.
 */
function deriveKeyframes(
  keyframes: readonly LegacyKeyframe[],
  inputs: readonly { readonly property: string; readonly fallback: number }[],
  output: string,
  combine: (values: readonly number[]) => number,
  frameTimes?: readonly number[],
): {
  readonly keyframes: DraftKeyframe[];
  readonly resampled: boolean;
  readonly sampled?: boolean;
} {
  const curves = inputs.map((input) => pointsFor(keyframes, input.property));
  const animated = curves.filter((curve) => curve.length > 0);
  if (animated.length === 0) return { keyframes: [], resampled: false };
  const moving = animated.some((curve) => curve.length > 1);
  if (frameTimes !== undefined && frameTimes.length > 0 && moving) {
    return {
      keyframes: sampleAtFrames(curves, inputs, output, combine, frameTimes),
      resampled: false,
      sampled: true,
    };
  }
  const reference = animated[0]!;
  const aligned = animated.every(
    (curve) =>
      curve.length === reference.length &&
      curve.every(
        (point, index) =>
          point.time === reference[index]!.time &&
          point.easing === reference[index]!.easing &&
          JSON.stringify(point.handles) === JSON.stringify(reference[index]!.handles),
      ),
  );
  const times = aligned
    ? reference.map((point) => point.time)
    : [...new Set(animated.flatMap((curve) => curve.map((point) => point.time)))].sort(
        (a, b) => a - b,
      );
  const draft = times.map((time, index): DraftKeyframe => {
    const values = inputs.map(
      (input, inputIndex) => evaluateSortedCurve(curves[inputIndex]!, time) ?? input.fallback,
    );
    const shape = aligned ? reference[index]! : undefined;
    return {
      property: output,
      time,
      value: combine(values),
      easing: shape ? shape.easing : 'linear',
      ...(shape?.handles ? { handles: shape.handles } : {}),
    };
  });
  return { keyframes: draft, resampled: !aligned };
}

/**
 * A derived property sampled at every rendered frame, as linear keyframes.
 *
 * WHY: v21 eased mask animation on the clip's TIMELINE clock. Through a speed ramp the
 * timeline → source mapping is not affine, so no easing on the source clock redraws that
 * curve; and even at constant speed, re-timed keyframes interpolate to a value an ulp away
 * from v21's between keyframes, which is enough to move a rasterised edge. A keyframe at every
 * frame's clip-local time (`n / fps - clip.start`, the instant the export asks for) carries
 * the exact v21 value to the exact source instant the engine evaluates. A keyframe whose
 * value equals both neighbours is dropped: linear interpolation between equal values is
 * exact, so holds stay compact.
 */
function sampleAtFrames(
  curves: readonly LegacyKeyframe[][],
  inputs: readonly { readonly property: string; readonly fallback: number }[],
  output: string,
  combine: (values: readonly number[]) => number,
  frameTimes: readonly number[],
): DraftKeyframe[] {
  const samples = frameTimes.map((time): DraftKeyframe => ({
    property: output,
    time,
    value: combine(
      inputs.map((input, index) => evaluateSortedCurve(curves[index]!, time) ?? input.fallback),
    ),
    easing: 'linear',
  }));
  return samples.filter(
    (sample, index) =>
      index === 0 ||
      index === samples.length - 1 ||
      sample.value !== samples[index - 1]!.value ||
      sample.value !== samples[index + 1]!.value,
  );
}

/**
 * Clip-local times of every frame the export renders for a clip at `fps`: global frame
 * times `n / fps` with `start <= n / fps < end`, minus `start` (MoviePy's own arithmetic).
 */
function clipFrameTimes(clip: RawRecord, fps: number): number[] {
  const start = finiteOr(clip.start, 0);
  const end = finiteOr(clip.end, start);
  const times: number[] = [];
  if (!(fps > 0)) return times;
  let frame = Math.max(0, Math.floor(start * fps) - 1);
  while (frame / fps < end) {
    if (frame / fps >= start) times.push(frame / fps - start);
    frame += 1;
  }
  return times;
}

/** Timeline-clock → source-clock mapping for one clip, mirroring the render's speed stage. */
interface ClipClock {
  readonly toSource: (time: number) => number;
  readonly reversed: boolean;
  readonly frozen: boolean;
  readonly ramped: boolean;
}

function readSpeedRamp(clip: RawRecord): SpeedPoint[] {
  if (!Array.isArray(clip.speedRamp)) return [];
  return clip.speedRamp
    .filter(
      (point): point is SpeedPoint =>
        isRecord(point) &&
        typeof point.sourceTime === 'number' &&
        typeof point.rate === 'number' &&
        point.rate > 0,
    )
    .map((point) => ({
      id: typeof point.id === 'string' ? point.id : '',
      sourceTime: point.sourceTime,
      rate: point.rate,
      easing:
        typeof point.easing === 'string' && LEGACY_EASINGS.has(point.easing)
          ? point.easing
          : 'linear',
    })) as SpeedPoint[];
}

function clipClock(clip: RawRecord): ClipClock {
  const sourceStart = finiteOr(clip.sourceStart, 0);
  const sourceEnd = finiteOr(clip.sourceEnd, sourceStart);
  const ramp = readSpeedRamp(clip);
  if (ramp.length > 0) {
    const span = Math.max(0, sourceEnd - sourceStart);
    return {
      toSource: (time) => sourceStart + sourceTimeAt(ramp, 0, time, span),
      reversed: false,
      frozen: false,
      ramped: true,
    };
  }
  const speed = finiteOr(clip.speed, 1);
  if (speed === 0) {
    return { toSource: () => sourceStart, reversed: false, frozen: true, ramped: false };
  }
  if (speed < 0) {
    return {
      toSource: (time) => sourceEnd + time * speed,
      reversed: true,
      frozen: false,
      ramped: false,
    };
  }
  return {
    toSource: (time) => sourceStart + time * speed,
    reversed: false,
    frozen: false,
    ramped: false,
  };
}

/** The easing that draws the same curve when a segment is walked backwards. */
const MIRRORED_EASING: Readonly<Record<string, string>> = {
  linear: 'linear',
  'ease-in': 'ease-out',
  'ease-out': 'ease-in',
  'ease-in-out': 'ease-in-out',
  bezier: 'bezier',
  hold: 'hold',
};

/**
 * Move one property's draft keyframes onto the source clock.
 *
 * Reverse playback walks source time backwards, so each segment's curve is carried by the
 * OTHER end and mirrored (ease-in ↔ ease-out; bezier handles reflected through the
 * segment's centre). A held segment cannot be mirrored — in reverse it jumps at the
 * start instead of at the end — which is reported. A freeze frame shows one source frame
 * for the whole clip, so only the first value can survive.
 */
function toSourceClock(
  draft: readonly DraftKeyframe[],
  clock: ClipClock,
): { readonly keyframes: DraftKeyframe[]; readonly notes: string[] } {
  const notes: string[] = [];
  if (draft.length === 0) return { keyframes: [], notes };
  const ordered = draft.slice().sort(byTime);
  if (clock.frozen) {
    if (ordered.length > 1) {
      notes.push('The clip is a freeze frame, so only the first value of its animation was kept.');
    }
    return { keyframes: [{ ...ordered[0]!, time: clock.toSource(0) }], notes };
  }
  if (!clock.reversed) {
    return {
      keyframes: ordered.map((point) => ({ ...point, time: clock.toSource(point.time) })),
      notes,
    };
  }
  const mapped: DraftKeyframe[] = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const point = ordered[index]!;
    // In source order this point's outgoing segment is the timeline segment that ENDED here,
    // which the previous timeline keyframe shaped.
    // The last point in source order has no outgoing segment, so its curve is moot.
    const carrier = index > 0 ? ordered[index - 1]! : undefined;
    if (carrier?.easing === 'hold') {
      notes.push('A held segment on a reversed clip now changes at the start of the segment.');
    }
    const handles = carrier?.handles
      ? {
          out: [1 - carrier.handles.in[0], 1 - carrier.handles.in[1]] as const,
          in: [1 - carrier.handles.out[0], 1 - carrier.handles.out[1]] as const,
        }
      : undefined;
    mapped.push({
      property: point.property,
      time: clock.toSource(point.time),
      value: point.value,
      easing: carrier ? (MIRRORED_EASING[carrier.easing] ?? 'linear') : 'linear',
      ...(handles ? { handles } : {}),
    });
  }
  return { keyframes: mapped, notes };
}

interface Geometry {
  /** Horizontal position: legacy frame fraction → stored unit. */
  readonly x: (fraction: number) => number;
  readonly y: (fraction: number) => number;
  /** Horizontal length. */
  readonly w: (fraction: number) => number;
  readonly h: (fraction: number) => number;
  /** Feather: fraction of the cropped frame's smaller side → stored unit. */
  readonly feather: (fraction: number) => number;
}

function geometryFor(crop: Crop, dims: Dimensions | null): Geometry {
  if (dims === null) {
    // Unmeasured media: keep the frame fractions the mask was drawn in, untouched.
    const identity = (value: number): number => value;
    return { x: identity, y: identity, w: identity, h: identity, feather: identity };
  }
  const cropWidth = crop.width * dims.width;
  const cropHeight = crop.height * dims.height;
  const featherScale = Math.min(cropWidth, cropHeight);
  return {
    x: (fraction) => (crop.x + fraction * crop.width) * dims.width,
    y: (fraction) => (crop.y + fraction * crop.height) * dims.height,
    w: (fraction) => fraction * cropWidth,
    h: (fraction) => fraction * cropHeight,
    feather: (fraction) => fraction * featherScale,
  };
}

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);

/** Convert one v21 `mask` effect into a v22 mask layer. */
function migrateOneMask(
  effect: RawRecord,
  clip: RawRecord,
  position: number,
  geometry: Geometry,
  normalized: boolean,
  fps: number | null,
): RawRecord {
  const params = isRecord(effect.params) ? effect.params : {};
  const bounds = isRecord(params.bounds) ? params.bounds : {};
  const fx = finiteOr(bounds.x, 0);
  const fy = finiteOr(bounds.y, 0);
  const fw = finiteOr(bounds.width, 1);
  const fh = finiteOr(bounds.height, 1);
  const rawPoints = Array.isArray(params.points) ? params.points : [];
  const polygon = rawPoints.filter(
    (point): point is [number, number] =>
      Array.isArray(point) &&
      point.length >= 2 &&
      typeof point[0] === 'number' &&
      typeof point[1] === 'number' &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]),
  );
  const shape =
    params.shape === 'ellipse' || params.shape === 'polygon' ? params.shape : 'rectangle';
  // masks.py draws a polygon only with at least three points; otherwise the bounds rectangle.
  const kind = shape === 'polygon' ? (polygon.length >= 3 ? 'path' : 'rectangle') : shape;
  const id =
    typeof effect.id === 'string' && effect.id.length > 0 ? effect.id : `mask_${position + 1}`;
  const notes: string[] = [];
  if (normalized) notes.push(MASK_MEASURE_MEDIA_NOTE);
  if (position > 0) notes.push(MASK_DISABLED_EXTRA_NOTE);

  const { keyframes: legacy, dropped } = readLegacyKeyframes(effect);
  const clock = clipClock(clip);
  // Moving animation is sampled at every rendered frame on EVERY clock but a freeze: even at
  // constant speed, re-timed keyframes interpolate on the source clock and land an ulp away
  // from v21's timeline-clock value between keyframes, which moves a Pillow edge (measured:
  // 13 of 60 frames at 2x). A freeze shows one source frame, so its first value is kept.
  // `fps` is null for a mask AUTHORED in the v21 vocabulary today (`add_mask_advanced`):
  // nothing to reproduce, so its keyframes stay editable as a pure re-timing.
  const frames = clock.frozen || fps === null ? undefined : clipFrameTimes(clip, fps);
  const draft: DraftKeyframe[] = [];
  let resampled = false;
  let sampled = false;
  const add = (result: {
    keyframes: DraftKeyframe[];
    resampled: boolean;
    sampled?: boolean;
  }): void => {
    draft.push(...result.keyframes);
    resampled ||= result.resampled;
    sampled ||= result.sampled === true;
  };
  if (kind === 'rectangle' || kind === 'ellipse') {
    const half = kind === 'ellipse' ? 0.5 : 1;
    add(
      deriveKeyframes(
        legacy,
        [
          { property: 'x', fallback: fx },
          { property: 'width', fallback: fw },
        ],
        'cx',
        ([x, width]) => geometry.x(x! + width! / 2),
        frames,
      ),
    );
    add(
      deriveKeyframes(
        legacy,
        [
          { property: 'y', fallback: fy },
          { property: 'height', fallback: fh },
        ],
        'cy',
        ([y, height]) => geometry.y(y! + height! / 2),
        frames,
      ),
    );
    add(
      deriveKeyframes(
        legacy,
        [{ property: 'width', fallback: fw }],
        kind === 'ellipse' ? 'rx' : 'width',
        ([width]) => geometry.w(width!) * half,
        frames,
      ),
    );
    add(
      deriveKeyframes(
        legacy,
        [{ property: 'height', fallback: fh }],
        kind === 'ellipse' ? 'ry' : 'height',
        ([height]) => geometry.h(height!) * half,
        frames,
      ),
    );
  } else if (legacy.some((keyframe) => ['x', 'y', 'width', 'height'].includes(keyframe.property))) {
    notes.push(
      'Position and size keyframes had no effect on a polygon mask and were not carried over.',
    );
  }
  const staticFeather = Math.max(0, finiteOr(params.feather, 0));
  add(
    deriveKeyframes(
      legacy,
      [{ property: 'feather', fallback: staticFeather }],
      'featherOuterPx',
      ([feather]) => geometry.feather(feather!),
      frames,
    ),
  );
  add(
    deriveKeyframes(
      legacy,
      [{ property: 'opacity', fallback: 1 }],
      'opacity',
      ([opacity]) => opacity!,
      frames,
    ),
  );
  if (dropped > 0)
    notes.push('Keyframes on properties a mask never animated were not carried over.');
  if (resampled) {
    notes.push(
      'Position and size keyframes set at different instants were combined at every instant.',
    );
  }

  const byProperty = new Map<string, DraftKeyframe[]>();
  for (const keyframe of draft) {
    byProperty.set(keyframe.property, [...(byProperty.get(keyframe.property) ?? []), keyframe]);
  }
  const keyframes: RawRecord[] = [];
  for (const [property, points] of byProperty) {
    const mapped = toSourceClock(points, clock);
    for (const note of mapped.notes) if (!notes.includes(note)) notes.push(note);
    mapped.keyframes.forEach((point, index) => {
      keyframes.push({
        id: `${id}__${property}__${index}`,
        sourceTime: Math.max(0, point.time),
        property,
        value: point.value,
        easing: point.easing,
        ...(point.handles
          ? { handles: { out: [...point.handles.out], in: [...point.handles.in] } }
          : {}),
      });
    });
  }
  if (sampled) {
    notes.push('Animation was sampled at every frame so it plays exactly as before.');
  }
  if (clock.ramped && keyframes.length > 0) {
    notes.push('Keyframe instants were mapped through the speed ramp.');
  }

  const base: RawRecord = {
    id,
    name: `Mask ${position + 1}`,
    color: '#3b82f6',
    enabled: position === 0,
    locked: false,
    target: { kind: 'alpha' },
    mode: 'add',
    opacity: clamp01(finiteOr(params.opacity, 1)),
    invert: params.invert === true,
    expansionPx: 0,
    featherInnerPx: 0,
    featherOuterPx: geometry.feather(staticFeather),
    falloff: 'gaussian',
    featherModel: 'gaussian-legacy',
    space: 'source',
    ...(normalized ? { units: 'normalized' } : {}),
    keyframes,
    ...(notes.length > 0 ? { migrationNote: notes.join(' ') } : {}),
  };

  if (kind === 'path') {
    const points: number[] = [];
    for (const [px, py] of polygon) points.push(geometry.x(px), geometry.y(py), 0, 0, 0, 0);
    return {
      ...base,
      kind: 'path',
      firstVertex: 0,
      pathKeyframes: [
        {
          id: `${id}__path__0`,
          sourceTime: Math.max(0, finiteOr(clip.sourceStart, 0)),
          easing: 'linear',
          points,
          vertexTypes: polygon.map(() => 0),
        },
      ],
    };
  }
  if (kind === 'ellipse') {
    return {
      ...base,
      kind: 'ellipse',
      cx: geometry.x(fx + fw / 2),
      cy: geometry.y(fy + fh / 2),
      rx: geometry.w(fw) / 2,
      ry: geometry.h(fh) / 2,
      rotation: 0,
    };
  }
  return {
    ...base,
    kind: 'rectangle',
    cx: geometry.x(fx + fw / 2),
    cy: geometry.y(fy + fh / 2),
    width: geometry.w(fw),
    height: geometry.h(fh),
    rotation: 0,
    roundness: 0,
  };
}

/**
 * One v21-vocabulary mask (a `mask` effect's `params` and clip-timeline `keyframes`) as a
 * v22 mask layer on `clip`, exactly as the v21 → v22 migration converts it.
 *
 * Exported for the callers that still SPEAK the v21 vocabulary — the agent's
 * `add_mask_advanced` builder takes fractions, a Gaussian feather fraction and clip-time
 * box keyframes — so a mask authored that way today lands identical to one migrated from a
 * v21 file, rather than through a second, subtly different conversion. Unlike the
 * migration it has no "unknown size" fallback (new masks need measured media), and its
 * keyframes are re-timed, not sampled at every frame: there is no earlier export to
 * reproduce, and a new mask's keyframes should stay editable.
 *
 * @param effect - `{ id, params, keyframes }` in the v21 `mask` effect shape.
 * @param clip - The clip it lands on (crop, source range, speed and ramp are read).
 * @param media - The clip media's measured size.
 * @returns A raw v22 mask layer; parse it with `MaskLayerSchema`.
 */
export function maskLayerFromLegacyMaskEffect(
  effect: RawRecord,
  clip: RawRecord,
  media: { readonly width: number; readonly height: number },
): RawRecord {
  return migrateOneMask(effect, clip, 0, geometryFor(readCrop(clip), media), false, null);
}

/** Frame rate assumed when a raw project does not state one. */
const DEFAULT_MIGRATION_FPS = 30;

function projectFps(raw: RawRecord): number {
  return typeof raw.fps === 'number' && raw.fps > 0 ? raw.fps : DEFAULT_MIGRATION_FPS;
}

function migrateClip(raw: RawRecord, clip: unknown): unknown {
  if (!isRecord(clip) || !Array.isArray(clip.effects)) return clip;
  const legacy = clip.effects.filter(
    (effect): effect is RawRecord => isRecord(effect) && effect.type === LEGACY_MASK_EFFECT_TYPE,
  );
  if (legacy.length === 0) return clip;
  const dims = readDimensions(raw, clip.assetId);
  const geometry = geometryFor(readCrop(clip), dims);
  const migrated = legacy.map((effect, position) =>
    migrateOneMask(effect, clip, position, geometry, dims === null, projectFps(raw)),
  );
  const existing = Array.isArray(clip.masks) ? clip.masks : [];
  return {
    ...clip,
    effects: clip.effects.filter(
      (effect) => !(isRecord(effect) && effect.type === LEGACY_MASK_EFFECT_TYPE),
    ),
    masks: [...existing, ...migrated],
  };
}

/**
 * The v21 → v22 migration step: every clip's `mask` effects become its mask stack.
 *
 * @param raw - A raw v21 project.
 * @returns The same project with `mask` effects replaced by `Clip.masks`.
 */
export function migrateMaskEffectsToStack(raw: RawRecord): RawRecord {
  const timeline = raw.timeline;
  if (!isRecord(timeline) || !Array.isArray(timeline.tracks)) return raw;
  let changed = false;
  const tracks = timeline.tracks.map((track) => {
    if (!isRecord(track) || !Array.isArray(track.clips)) return track;
    const clips = track.clips.map((clip) => {
      const next = migrateClip(raw, clip);
      if (next !== clip) changed = true;
      return next;
    });
    return clips.some((clip, index) => clip !== (track.clips as unknown[])[index])
      ? { ...track, clips }
      : track;
  });
  return changed ? { ...raw, timeline: { ...timeline, tracks } } : raw;
}
