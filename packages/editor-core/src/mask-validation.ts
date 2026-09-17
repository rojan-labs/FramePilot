/**
 * Validator rules for the v22 mask stack (plan 10 "Validator", plan 04, ADR 0178).
 *
 * The applies in `mask-operations.ts` already refuse what can never be right (duplicate ids,
 * mismatched path vertex counts, targets that do not exist). These rules add what needs
 * context an apply does not have — media sizes, the clip's source range, other clips'
 * masks — and re-check the structural invariants on the stack an operation produced, so an
 * internal `restore_masks` or a hand-built patch cannot smuggle a broken stack past them.
 *
 * ## Message rule
 *
 * Every message names ids and a remedy and **never a varying magnitude**. The agent's
 * repeated-failure guard keys on message text (`orchestrator.ts#deterministicFailureKey`),
 * so "keyframe at 12.4s is outside 3s–9s" would read as a new failure on every nudge of the
 * number, and the guard would never stop a run that is walking into the same wall.
 */
import {
  masksOf,
  type Asset,
  type Clip,
  type EffectLayer,
  type MaskLayer,
  type Timeline,
  type Track,
} from '@framepilot/timeline-schema';
import { MEASURE_MEDIA_FIRST } from './mask-builders.js';
import { MASK_PATH_STRIDE, assetDisplaySize } from './mask-geometry.js';
import {
  MASK_ANIMATABLE_PROPERTIES,
  MIN_MASK_PATH_VERTICES,
  type MaskOperation,
} from './mask-operations.js';
import type { Operation } from './operations.js';
import type { ValidationCode, ValidationIssue } from './validator.js';

/**
 * How far outside the clip's source range an AUTHORED mask keyframe may sit, seconds.
 *
 * A handle, because a keyframe exactly at the clip edge is routine (drawing on the first
 * frame of a clip whose in-point is between frames), and an editor extending a trim later
 * should find the animation continuing rather than stopping at the old edge. One second is
 * the handle professional editors show beyond a clip's edges.
 */
export const MASK_KEYFRAME_HANDLE_SECONDS = 1;

/** The v21 effect type v22 retired. */
export const RETIRED_MASK_EFFECT_TYPE = 'mask';

/** What the mask rules need that a timeline does not carry. */
export interface MaskValidationContext {
  /** Measured media, by asset id. Absent ⇒ size rules are skipped (no evidence either way). */
  readonly assets?: ReadonlyMap<string, Pick<Asset, 'id' | 'media'>>;
  /** Project frame rate, for the half-frame matte coverage tolerance. */
  readonly fps?: number | null;
}

type Issue = ValidationIssue;

const error = (code: ValidationCode, message: string, operationIndex: number): Issue => ({
  code,
  severity: 'error',
  message,
  operationIndex,
});

interface Owner {
  readonly label: string;
  readonly masks: readonly MaskLayer[];
  readonly clip?: Clip;
  readonly layer?: EffectLayer;
}

function findOwner(
  timeline: Timeline,
  ref: { readonly clipId?: string | undefined; readonly layerId?: string | undefined },
): Owner | undefined {
  for (const track of timeline.tracks) {
    if (ref.clipId !== undefined) {
      const clip = track.clips.find((candidate) => candidate.id === ref.clipId);
      if (clip) return { label: `clip '${clip.id}'`, masks: masksOf(clip), clip };
    } else if (ref.layerId !== undefined) {
      const layer = (track.effectLayers ?? []).find((candidate) => candidate.id === ref.layerId);
      if (layer) return { label: `effect layer '${layer.id}'`, masks: masksOf(layer), layer };
    }
  }
  return undefined;
}

/** The owners (clip or layer) an operation's result must be checked on. */
function touchedOwners(op: MaskOperation): readonly {
  readonly clipId?: string;
  readonly layerId?: string;
}[] {
  switch (op.type) {
    case 'add_mask':
    case 'paste_masks':
      return [{ clipId: op.clipId }];
    case 'add_text_behind_subject':
      return [{ clipId: op.clipId }];
    case 'add_effect_layer_mask':
      return [{ layerId: op.layerId }];
    case 'use_track':
      return [op.to.clipId === undefined ? { layerId: op.to.layerId } : { clipId: op.to.clipId }];
    default:
      return [op.clipId === undefined ? { layerId: op.layerId } : { clipId: op.clipId }];
  }
}

/** Ids of the masks whose keyframes an operation AUTHORED (and so must be in range). */
function authoredMaskIds(op: MaskOperation, owner: Owner): ReadonlySet<string> {
  switch (op.type) {
    case 'add_mask':
    case 'add_effect_layer_mask': {
      const id = (op.mask as { id?: unknown }).id;
      return new Set(typeof id === 'string' ? [id] : []);
    }
    case 'paste_masks':
      // Pasted masks are appended; everything past the prior stack length is new.
      return new Set(owner.masks.slice(owner.masks.length - op.masks.length).map((m) => m.id));
    case 'set_mask_path':
    case 'add_mask_keyframe':
    case 'move_mask_keyframe':
    case 'apply_mask_tracking':
      return new Set([op.maskId]);
    case 'use_track':
      return new Set([op.to.maskId]);
    default:
      return new Set();
  }
}

const finiteNumbers = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteNumbers);
  if (typeof value === 'object' && value !== null) return Object.values(value).every(finiteNumbers);
  return true;
};

function structuralIssues(owner: Owner, index: number): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const mask of owner.masks) {
    if (seen.has(mask.id)) {
      issues.push(
        error(
          'duplicate_mask',
          `Mask id '${mask.id}' is used twice on ${owner.label}. Give each mask its own id.`,
          index,
        ),
      );
    }
    seen.add(mask.id);
    if (!finiteNumbers(mask)) {
      issues.push(
        error(
          'invalid_mask',
          `Mask '${mask.id}' on ${owner.label} has a non-finite number. Use finite values for every field.`,
          index,
        ),
      );
    }
    const allowed = new Set<string>(MASK_ANIMATABLE_PROPERTIES[mask.kind]);
    if (mask.keyframes.some((keyframe) => !allowed.has(keyframe.property))) {
      issues.push(
        error(
          'invalid_mask',
          `Mask '${mask.id}' on ${owner.label} animates a property its kind does not have. ` +
            `Animate one of: ${MASK_ANIMATABLE_PROPERTIES[mask.kind].join(', ')}.`,
          index,
        ),
      );
    }
    if (mask.target.kind === 'effect') {
      const effectId = mask.target.effectId;
      if (!owner.clip?.effects.some((effect) => effect.id === effectId)) {
        issues.push(
          error(
            'invalid_mask_target',
            `Mask '${mask.id}' on ${owner.label} targets effect '${effectId}', which is not on it. ` +
              "Target an effect on the same clip, or 'alpha'.",
            index,
          ),
        );
      }
    }
    if (owner.layer && (mask.space !== 'frame' || mask.target.kind !== 'alpha')) {
      issues.push(
        error(
          'invalid_mask',
          `Mask '${mask.id}' on ${owner.label} must be a frame-space alpha mask. Use space 'frame' and target 'alpha'.`,
          index,
        ),
      );
    }
    if (mask.kind === 'path') issues.push(...pathIssues(mask, owner, index));
  }
  return issues;
}

function pathIssues(
  mask: Extract<MaskLayer, { kind: 'path' }>,
  owner: Owner,
  index: number,
): Issue[] {
  const counts = new Set(mask.pathKeyframes.map((keyframe) => keyframe.vertexTypes.length));
  const broken = mask.pathKeyframes.some(
    (keyframe) =>
      keyframe.points.length !== keyframe.vertexTypes.length * MASK_PATH_STRIDE ||
      (keyframe.featherPx !== undefined &&
        keyframe.featherPx.length !== keyframe.vertexTypes.length),
  );
  const issues: Issue[] = [];
  if (mask.pathKeyframes.length === 0 || broken) {
    issues.push(
      error(
        'invalid_mask_path',
        `Path mask '${mask.id}' on ${owner.label} needs path keyframes storing six numbers and one vertex type per vertex. Rewrite them with set_mask_path.`,
        index,
      ),
    );
  }
  if (counts.size > 1) {
    issues.push(
      error(
        'invalid_mask_path',
        `Every keyframe of path mask '${mask.id}' on ${owner.label} must have the same number of vertices. Use insert_mask_vertex or remove_mask_vertex.`,
        index,
      ),
    );
  }
  if ([...counts].some((count) => count < MIN_MASK_PATH_VERTICES)) {
    issues.push(
      error(
        'invalid_mask_path',
        `Path mask '${mask.id}' on ${owner.label} needs at least three vertices. Add vertices to the path.`,
        index,
      ),
    );
  }
  return issues;
}

function keyframeRangeIssues(owner: Owner, authored: ReadonlySet<string>, index: number): Issue[] {
  const clip = owner.clip;
  if (!clip || authored.size === 0) return [];
  const low = clip.sourceStart - MASK_KEYFRAME_HANDLE_SECONDS;
  const high = clip.sourceEnd + MASK_KEYFRAME_HANDLE_SECONDS;
  const outside = (time: number): boolean => time < low || time > high;
  const issues: Issue[] = [];
  for (const mask of owner.masks) {
    if (!authored.has(mask.id)) continue;
    const times = [
      ...mask.keyframes.map((keyframe) => keyframe.sourceTime),
      ...(mask.kind === 'path' ? mask.pathKeyframes.map((keyframe) => keyframe.sourceTime) : []),
      ...(mask.tracking ? [mask.tracking.referenceSourceTime] : []),
    ];
    if (times.some(outside)) {
      issues.push(
        error(
          'mask_keyframe_out_of_range',
          `Mask '${mask.id}' on ${owner.label} has a keyframe outside the clip's source range. ` +
            "Mask keyframes use the clip's SOURCE time (its in- and out-points, not timeline seconds); place them within the clip.",
          index,
        ),
      );
    }
  }
  return issues;
}

function mediaIssues(
  owner: Owner,
  op: MaskOperation,
  authored: ReadonlySet<string>,
  context: MaskValidationContext,
  index: number,
): Issue[] {
  const clip = owner.clip;
  // Only an asset the caller actually supplied is evidence: an id the caller knows nothing
  // about (a registered-only id, a synthetic text asset) is neither measured nor unmeasured.
  const asset = context.assets?.get(clip?.assetId ?? '');
  if (!clip || asset === undefined) return [];
  const media = asset.media;
  const measured =
    typeof media?.width === 'number' &&
    media.width > 0 &&
    typeof media.height === 'number' &&
    media.height > 0;
  const issues: Issue[] = [];
  for (const mask of owner.masks) {
    if (mask.units === 'normalized') {
      // A v21 mask on media that was never measured. Surfaced on every mask edit of the clip,
      // as a warning: blocking would stop the editor fixing it with the very edits it needs.
      issues.push({
        code: 'mask_needs_media_dimensions',
        severity: 'warning',
        message: `Mask '${mask.id}' on ${owner.label} is stored as frame fractions. ${MEASURE_MEDIA_FIRST}`,
        operationIndex: index,
      });
      continue;
    }
    const created = op.type === 'add_mask' || op.type === 'paste_masks';
    if (created && authored.has(mask.id) && mask.space === 'source' && !measured) {
      issues.push(
        error(
          'mask_needs_media_dimensions',
          `Mask '${mask.id}' on ${owner.label}: ${MEASURE_MEDIA_FIRST}`,
          index,
        ),
      );
    }
    // A matte artifact is written in DISPLAY space (PAR applied, rotation turned), each side
    // the nearest integer with halves rounding up, the same rule as the engine (BR2.6).
    const display = measured ? assetDisplaySize(media) : null;
    if (
      mask.kind === 'matte' &&
      display !== null &&
      (mask.artifact.width !== Math.floor(display.width + 0.5) ||
        mask.artifact.height !== Math.floor(display.height + 0.5))
    ) {
      issues.push(
        error(
          'invalid_mask',
          `Matte '${mask.id}' on ${owner.label} was made for a different picture size than this media. Remove the background again for this clip.`,
          index,
        ),
      );
    }
  }
  return issues;
}

/**
 * Layer masks read another clip's (or a whole track's) picture. A loop — A's matte is B and
 * B's matte is A — has no defined picture, so it is refused.
 */
function layerCycleIssues(
  timeline: Timeline,
  startClipIds: readonly string[],
  index: number,
): Issue[] {
  const clipsById = new Map<string, Clip>();
  const tracksById = new Map<string, Track>();
  for (const track of timeline.tracks) {
    tracksById.set(track.id, track);
    for (const clip of track.clips) clipsById.set(clip.id, clip);
  }
  const issues: Issue[] = [];
  const reads = (clip: Clip): string[] =>
    masksOf(clip).flatMap((mask) => {
      if (mask.kind !== 'layer' || !mask.enabled) return [];
      if (mask.source.kind === 'clip') return [mask.source.clipId];
      return (tracksById.get(mask.source.trackId)?.clips ?? []).map((candidate) => candidate.id);
    });
  for (const startId of startClipIds) {
    const start = clipsById.get(startId);
    if (!start) continue;
    for (const mask of masksOf(start)) {
      if (mask.kind !== 'layer') continue;
      const exists =
        mask.source.kind === 'clip'
          ? clipsById.has(mask.source.clipId)
          : tracksById.has(mask.source.trackId);
      if (!exists) {
        issues.push(
          error(
            'missing_reference',
            `Layer mask '${mask.id}' on clip '${start.id}' reads a clip or track that does not exist. Point it at an existing clip or track.`,
            index,
          ),
        );
      }
    }
    // Depth-first from the touched clip: reaching it again is a loop through it.
    const stack = reads(start);
    const visited = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === startId) {
        issues.push(
          error(
            'mask_layer_cycle',
            `Layer masks starting at clip '${startId}' lead back to it. Point the layer mask at a clip that does not use '${startId}' as its matte.`,
            index,
          ),
        );
        break;
      }
      if (visited.has(id)) continue;
      visited.add(id);
      const next = clipsById.get(id);
      if (next) stack.push(...reads(next));
    }
  }
  return issues;
}

/**
 * Issues in the stack a mask operation produced.
 *
 * @param after - The timeline after the operation applied.
 * @param op - The mask operation.
 * @param index - Its index in the patch.
 * @param context - Media sizes and frame rate, when the caller has them.
 */
export function maskOperationIssues(
  after: Timeline,
  op: MaskOperation,
  index: number,
  context: MaskValidationContext,
): Issue[] {
  const issues: Issue[] = [];
  const clipIds: string[] = [];
  for (const ref of touchedOwners(op)) {
    const owner = findOwner(after, ref);
    if (!owner) continue;
    if (owner.clip) clipIds.push(owner.clip.id);
    const authored = authoredMaskIds(op, owner);
    issues.push(...structuralIssues(owner, index));
    issues.push(...keyframeRangeIssues(owner, authored, index));
    issues.push(...mediaIssues(owner, op, authored, context, index));
  }
  issues.push(...layerCycleIssues(after, clipIds, index));
  return issues;
}

/**
 * Refuse the retired v21 `mask` effect wherever an operation writes clip effects wholesale.
 *
 * Migration converts every stored one, so a `mask` effect can only arrive from an author
 * that still speaks v21 — and a renderer that no longer reads it would drop it silently.
 */
export function retiredMaskEffectIssues(op: Operation, index: number): Issue[] {
  // `add_layer` is the one public operation that writes whole clips (with their effects).
  const clips: readonly Clip[] = op.type === 'add_layer' ? (op.clips ?? []) : [];
  const effects = clips.flatMap((clip) => clip.effects);
  if (!effects.some((effect) => (effect.type as string) === RETIRED_MASK_EFFECT_TYPE)) return [];
  return [
    error(
      'unsupported_effect',
      "The 'mask' effect type was replaced by the clip's mask stack in project format 22. Use add_mask instead.",
      index,
    ),
  ];
}

/**
 * Enabled mattes must cover the whole source range their clip plays (±½ frame).
 *
 * Run after any operation that can move a clip's source range (trim, slip, split, speed), on
 * the tracks it touched: a trim that extends past the matte's coverage would otherwise export
 * un-matted frames with no warning.
 */
export function matteCoverageIssues(
  tracks: readonly Track[],
  index: number,
  context: MaskValidationContext,
): Issue[] {
  const fps = context.fps ?? null;
  const tolerance = fps !== null && fps > 0 ? 0.5 / fps : 1e-3;
  const issues: Issue[] = [];
  for (const track of tracks) {
    for (const clip of track.clips) {
      for (const mask of masksOf(clip)) {
        if (mask.kind !== 'matte' || !mask.enabled) continue;
        const { sourceStart, sourceEnd } = mask.artifact.coverage;
        if (clip.sourceStart < sourceStart - tolerance || clip.sourceEnd > sourceEnd + tolerance) {
          issues.push(
            error(
              'matte_out_of_coverage',
              `Matte '${mask.id}' on clip '${clip.id}' does not cover the clip's whole source range. Update the background removal for the new range.`,
              index,
            ),
          );
        }
      }
    }
  }
  return issues;
}
