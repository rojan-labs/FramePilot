/**
 * Patch validation. Every operation is replayed transactionally, but expensive
 * overlap/transition/speed invariants are checked only on tracks whose clip state can
 * change. This keeps correctness local to the typed mutation instead of sorting every
 * track after every operation in a large AI patch.
 */
import { createLogger } from '@framepilot/shared-types';
import type {
  Clip,
  EffectLayer,
  EffectRenderKind,
  Folder,
  Marker,
  Timeline,
  Track,
} from '@framepilot/timeline-schema';
import { effectLayersOf } from '@framepilot/timeline-schema';
import { EFFECT_PARAMS } from '@framepilot/timeline-schema/effect-params';
import {
  applyOperation,
  SUPPORTED_COLOR_GRADE_EFFECTS,
  type Operation,
  type OperationError,
  type OperationType,
} from './operations.js';
import {
  isProjectOperation,
  wouldCreateFolderCycle,
  type ProjectOperation,
} from './project-operations.js';
import { clipTimelineDuration, hasSpeedRamp } from './speed-curve.js';
import { TRANSITION_OUT_EFFECT_TYPE } from './transitions.js';
import { postValidationScope } from './validation-scope.js';
import type { AnyOperation } from './patch.js';

const log = createLogger('editor-core:validator');
const EPSILON = 1e-9;
const SPEED_EPSILON = 1e-6;

export type ValidationCode =
  | 'missing_reference'
  | 'negative_duration'
  | 'invalid_layer_order'
  | 'missing_asset'
  | 'unsupported_effect'
  | 'broken_audio_link'
  | 'overlap_error'
  | 'transition_overlap'
  | 'unsupported_operation'
  | 'not_reversible'
  | 'duplicate_asset'
  | 'asset_in_use'
  | 'missing_folder'
  | 'duplicate_folder'
  | 'folder_cycle'
  | 'duplicate_layer'
  | 'invalid_style'
  | 'invalid_cue'
  | 'invalid_speed'
  | 'speed_duration_mismatch'
  | 'invalid_crop'
  | 'invalid_blend_mode'
  | 'missing_marker'
  | 'duplicate_marker'
  | 'invalid_marker_time'
  | 'invalid_track'
  | 'invalid_effect_layer'
  | 'duplicate_effect_layer'
  | 'unsupported_effect_kind'
  | 'invalid_effect_params'
  /** An apply path threw something the operations layer did not raise deliberately. */
  | 'invalid_operation';

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  readonly code: ValidationCode;
  readonly severity: ValidationSeverity;
  readonly message: string;
  readonly operationIndex?: number;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface ValidateOptions {
  readonly assetIds?: Iterable<string>;
  readonly folders?: Iterable<Folder>;
  readonly markers?: Iterable<Marker>;
}

const SUPPORTED_OPERATIONS: ReadonlySet<OperationType> = new Set<OperationType>([
  'trim_clip',
  'set_clip_source_range',
  'set_clip_media',
  'split_clip',
  'delete_range',
  'move_clip',
  'ripple_delete',
  'add_clip',
  'add_text_overlay',
  'add_caption_layer',
  'add_keyframes',
  'remove_keyframes',
  'apply_color_grade',
  'set_effect_params',
  'adjust_audio',
  'add_transition',
  'add_mask',
  'track_object',
  'set_track_flags',
  'set_track_caption_style',
  'set_caption_style',
  'set_caption_cue',
  'set_clip_speed',
  'set_clip_speed_ramp',
  'set_clip_crop',
  'set_clip_blend_mode',
  'add_layer',
  'remove_layer',
  'move_layer',
  'add_effect_layer',
  'remove_effect_layer',
  'move_effect_layer',
  'trim_effect_layer',
  'set_effect_layer_params',
  'set_effect_layer_enabled',
  'restore_effect_layer',
  'restore_clips',
]);

interface PatchLike {
  readonly operations: readonly AnyOperation[];
}

function clipTrackIndex(timeline: Timeline): Map<string, string> {
  const index = new Map<string, string>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) index.set(clip.id, track.id);
  }
  return index;
}

function refreshClipTrackIndex(
  index: Map<string, string>,
  timeline: Timeline,
  trackIds: readonly string[],
): void {
  if (trackIds.length === 0) return;
  const changed = new Set(trackIds);
  for (const [clipId, trackId] of index) {
    if (changed.has(trackId)) index.delete(clipId);
  }
  for (const track of timeline.tracks) {
    if (!changed.has(track.id)) continue;
    for (const clip of track.clips) index.set(clip.id, track.id);
  }
}

function tracksById(timeline: Timeline, ids: readonly string[]): Track[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  return timeline.tracks.filter((track) => wanted.has(track.id));
}

export function validatePatch(
  timeline: Timeline,
  patch: PatchLike,
  options: ValidateOptions = {},
): ValidationResult {
  const assetIds = options.assetIds ? new Set(options.assetIds) : undefined;
  const folders = options.folders ? [...options.folders] : undefined;
  const markers = options.markers ? [...options.markers] : undefined;
  const issues: ValidationIssue[] = [];
  const clipTracks = clipTrackIndex(timeline);
  let working = timeline;

  patch.operations.forEach((op, index) => {
    if (isProjectOperation(op)) {
      issues.push(...projectChecks(working, op, index, assetIds, folders, markers));
      advanceProjectState(op, assetIds, folders, markers);
      return;
    }
    if (!SUPPORTED_OPERATIONS.has(op.type)) {
      issues.push({
        code: 'unsupported_operation',
        severity: 'error',
        message: `Operation "${(op as { type: string }).type}" is not supported by the engine.`,
        operationIndex: index,
      });
      return;
    }

    issues.push(...staticChecks(working, op, index, assetIds, clipTracks));
    const scope = postValidationScope(op, clipTracks);
    try {
      const next = applyOperation(working, op);
      const tracks = tracksById(next, scope.trackIds);
      if (scope.overlap) issues.push(...overlapChecks(tracks, index));
      if (scope.transitions) issues.push(...transitionOverlapChecks(tracks, index));
      if (scope.speed) issues.push(...speedConsistencyChecks(tracks, index));
      refreshClipTrackIndex(clipTracks, next, scope.trackIds);
      working = next;
    } catch (cause) {
      issues.push(fromOperationError(cause, index));
    }
  });

  const valid = !issues.some((issue) => issue.severity === 'error');
  if (!valid) {
    log.warn('validatePatch rejected', {
      ops: patch.operations.length,
      errors: issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
    });
  } else {
    log.debug('validatePatch ok', { ops: patch.operations.length });
  }
  return { valid, issues };
}

function findEffectLayerForValidation(
  timeline: Timeline,
  layerId: string,
): EffectLayer | undefined {
  for (const track of timeline.tracks) {
    const found = effectLayersOf(track).find((layer) => layer.id === layerId);
    if (found) return found;
  }
  return undefined;
}

function effectLayerIssues(
  kind: string,
  params: Readonly<Record<string, number>> | undefined,
  index: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const descriptors = EFFECT_PARAMS[kind as EffectRenderKind];
  if (descriptors === undefined) {
    return [
      {
        code: 'unsupported_effect_kind',
        severity: 'error',
        message: `Unknown effect kind '${kind}'. No renderer implements it.`,
        operationIndex: index,
      },
    ];
  }
  if (params === undefined) return issues;
  const declared = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  for (const [name, value] of Object.entries(params)) {
    const descriptor = declared.get(name);
    if (!descriptor) {
      issues.push({
        code: 'invalid_effect_params',
        severity: 'error',
        message: `Effect kind '${kind}' has no parameter '${name}'.`,
        operationIndex: index,
      });
    } else if (!Number.isFinite(value)) {
      issues.push({
        code: 'invalid_effect_params',
        severity: 'error',
        message: `Parameter '${name}' of '${kind}' must be a finite number (got ${value}).`,
        operationIndex: index,
      });
    } else if (value < descriptor.min || value > descriptor.max) {
      issues.push({
        code: 'invalid_effect_params',
        severity: 'error',
        message: `Parameter '${name}' of '${kind}' must be within [${descriptor.min}, ${descriptor.max}] (got ${value}).`,
        operationIndex: index,
      });
    }
  }
  return issues;
}

function staticChecks(
  timeline: Timeline,
  op: Operation,
  index: number,
  assetIds: Set<string> | undefined,
  clipTracks: ReadonlyMap<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  switch (op.type) {
    case 'add_clip':
    case 'set_clip_media':
      if (assetIds && !assetIds.has(op.assetId)) {
        issues.push({
          code: 'missing_asset',
          severity: 'error',
          message: `Unknown asset '${op.assetId}' referenced by ${op.type}.`,
          operationIndex: index,
        });
      }
      break;
    case 'apply_color_grade':
      if (
        !SUPPORTED_COLOR_GRADE_EFFECTS.includes(
          op.effect.type as (typeof SUPPORTED_COLOR_GRADE_EFFECTS)[number],
        )
      ) {
        issues.push({
          code: 'unsupported_effect',
          severity: 'error',
          message: `Unsupported color-grade effect '${op.effect.type}'. Expected one of: ${SUPPORTED_COLOR_GRADE_EFFECTS.join(', ')}.`,
          operationIndex: index,
        });
      }
      break;
    case 'adjust_audio': {
      const trackId = clipTracks.get(op.clipId);
      const track = trackId
        ? timeline.tracks.find((candidate) => candidate.id === trackId)
        : undefined;
      if (track && track.type !== 'audio' && track.type !== 'video') {
        issues.push({
          code: 'broken_audio_link',
          severity: 'error',
          message: `Cannot adjust audio on clip '${op.clipId}': its track '${track.id}' (${track.type}) carries no audio.`,
          operationIndex: index,
        });
      }
      break;
    }
    case 'add_effect_layer':
      issues.push(...effectLayerIssues(op.layer.kind, op.layer.params, index));
      break;
    case 'set_effect_layer_params':
      if (op.params !== undefined) {
        const existing = findEffectLayerForValidation(timeline, op.layerId);
        if (existing) issues.push(...effectLayerIssues(existing.kind, op.params, index));
      }
      break;
    default:
      break;
  }
  return issues;
}

function overlapChecks(tracks: readonly Track[], index: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const track of tracks) {
    const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      if (current.start < previous.end - EPSILON) {
        // BY HOW MUCH, and where. The bare sentence names the two clips and leaves the
        // caller to re-read the timeline to learn the size of the problem — which is
        // usually the whole problem. Run `137d8fd0` lost the wipeout speed ramp the
        // editor asked for by name to this message: `set_clip_speed` stretched a clip
        // into its neighbour, and "Clips A and B overlap on track v_main" gave the run
        // no way to tell whether it needed a hundredth of a second or ten.
        const by = Number((previous.end - current.start).toFixed(3));
        issues.push({
          code: 'overlap_error',
          severity: 'error',
          message:
            `Clips '${previous.id}' and '${current.id}' overlap on track '${track.id}' ` +
            `by ${by}s — '${previous.id}' ends at ${previous.end}s and '${current.id}' ` +
            `starts at ${current.start}s. Shorten one, move '${current.id}' later, or ` +
            'place it on another track.',
          operationIndex: index,
        });
      }
    }
  }
  return issues;
}

function transitionOverlapChecks(tracks: readonly Track[], index: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (message: string): void => {
    issues.push({ code: 'transition_overlap', severity: 'error', message, operationIndex: index });
  };
  const duration = (clip: Clip): number => clip.end - clip.start;

  for (const track of tracks) {
    const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
    ordered.forEach((toClip, i) => {
      const effect = toClip.effects.find((candidate) => candidate.type === 'transition');
      if (!effect) return;
      const durationSeconds = effect.params.durationSeconds;
      if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) {
        issue(`Transition on clip '${toClip.id}' has a non-numeric durationSeconds.`);
        return;
      }
      if (durationSeconds <= 0) {
        issue(`Transition on clip '${toClip.id}' must have a positive durationSeconds.`);
        return;
      }
      const fromClipId = effect.params.fromClipId;
      const previous = i > 0 ? ordered[i - 1] : undefined;
      if (typeof fromClipId !== 'string' || !previous || previous.id !== fromClipId) {
        issue(
          `Transition on clip '${toClip.id}' must reference the adjacent earlier clip on track '${track.id}' as fromClipId.`,
        );
        return;
      }
      const limit = Math.min(duration(toClip), duration(previous));
      if (durationSeconds > limit + EPSILON) {
        issue(
          `Transition on clip '${toClip.id}' is ${durationSeconds}s but cannot exceed ${limit}s (the shorter neighbouring clip).`,
        );
      }
    });

    ordered.forEach((fromClip, i) => {
      const outgoing = fromClip.effects.find(
        (effect) => effect.type === TRANSITION_OUT_EFFECT_TYPE,
      );
      if (!outgoing) return;
      const next = ordered[i + 1];
      const partner = next?.effects.find((effect) => effect.type === 'transition');
      if (!next || !partner || partner.params.fromClipId !== fromClip.id) {
        issue(
          `Clip '${fromClip.id}' carries the outgoing half of a transition with no matching transition on the clip after it.`,
        );
      } else if (outgoing.params.durationSeconds !== partner.params.durationSeconds) {
        issue(
          `The two halves of the transition at the cut after '${fromClip.id}' disagree on duration (${String(outgoing.params.durationSeconds)}s vs ${String(partner.params.durationSeconds)}s).`,
        );
      }
    });
  }
  return issues;
}

function speedConsistencyChecks(tracks: readonly Track[], index: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const track of tracks) {
    for (const clip of track.clips) {
      const expectedDuration = clipTimelineDuration(clip);
      if (expectedDuration !== null) {
        const actualDuration = clip.end - clip.start;
        if (Math.abs(actualDuration - expectedDuration) > SPEED_EPSILON) {
          const rate = hasSpeedRamp(clip) ? 'its speed ramp' : `speed ${clip.speed ?? 1}x`;
          issues.push({
            code: 'speed_duration_mismatch',
            severity: 'error',
            message:
              `Clip '${clip.id}' on track '${track.id}' has timeline duration ${actualDuration}s ` +
              `but its source range (${clip.sourceEnd - clip.sourceStart}s) at ${rate} implies ${expectedDuration}s.`,
            operationIndex: index,
          });
        }
      }
      if (!hasSpeedRamp(clip)) continue;
      const sourceSpan = clip.sourceEnd - clip.sourceStart;
      for (const point of clip.speedRamp!) {
        if (point.sourceTime >= -SPEED_EPSILON && point.sourceTime <= sourceSpan + SPEED_EPSILON) {
          continue;
        }
        issues.push({
          code: 'invalid_speed',
          severity: 'error',
          message: `Clip '${clip.id}' has a speed-ramp point at source time ${point.sourceTime}s, outside its ${sourceSpan}s source range.`,
          operationIndex: index,
        });
      }
    }
  }
  return issues;
}

function projectChecks(
  timeline: Timeline,
  op: ProjectOperation,
  index: number,
  assetIds: Set<string> | undefined,
  folders: Folder[] | undefined,
  markers: Marker[] | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (code: ValidationCode, message: string): void => {
    issues.push({ code, severity: 'error', message, operationIndex: index });
  };
  const folderExists = (id: string): boolean =>
    !folders || folders.some((folder) => folder.id === id);
  const assetExists = (id: string): boolean => !assetIds || assetIds.has(id);
  const markerExists = (id: string): boolean =>
    !markers || markers.some((marker) => marker.id === id);

  switch (op.type) {
    case 'add_asset':
      if (assetIds?.has(op.asset.id))
        issue('duplicate_asset', `Asset id already exists: ${op.asset.id}`);
      if (op.asset.folderId !== undefined && !folderExists(op.asset.folderId)) {
        issue('missing_folder', `add_asset targets unknown folder '${op.asset.folderId}'.`);
      }
      break;
    case 'remove_asset':
      if (!assetExists(op.assetId)) issue('missing_asset', `Unknown asset '${op.assetId}'.`);
      else if (assetIsInUse(timeline, op.assetId)) {
        issue(
          'asset_in_use',
          `Asset '${op.assetId}' is still used by timeline clips; remove its clips first.`,
        );
      }
      break;
    case 'move_asset':
      if (!assetExists(op.assetId)) issue('missing_asset', `Unknown asset '${op.assetId}'.`);
      if (op.folderId !== null && !folderExists(op.folderId)) {
        issue('missing_folder', `move_asset targets unknown folder '${op.folderId}'.`);
      }
      break;
    case 'create_folder':
      if (folders?.some((folder) => folder.id === op.folderId)) {
        issue('duplicate_folder', `Folder id already exists: ${op.folderId}`);
      }
      if (op.parentId !== null && !folderExists(op.parentId)) {
        issue('missing_folder', `create_folder targets unknown parent '${op.parentId}'.`);
      }
      break;
    case 'rename_folder':
      if (!folderExists(op.folderId)) issue('missing_folder', `Unknown folder '${op.folderId}'.`);
      break;
    case 'move_folder':
      if (!folderExists(op.folderId)) issue('missing_folder', `Unknown folder '${op.folderId}'.`);
      if (op.parentId !== null && !folderExists(op.parentId)) {
        issue('missing_folder', `move_folder targets unknown parent '${op.parentId}'.`);
      } else if (folders && wouldCreateFolderCycle(folders, op.folderId, op.parentId)) {
        issue('folder_cycle', `move_folder would make folder '${op.folderId}' its own ancestor.`);
      }
      break;
    case 'delete_folder':
      if (!folderExists(op.folderId)) issue('missing_folder', `Unknown folder '${op.folderId}'.`);
      break;
    case 'set_transcript':
      break;
    // Nothing to validate structurally: `aiMemory` is a free-form record by design, and
    // `memory-store.ts` parses it defensively on read because it round-trips through
    // `project.fp.json`. Validating a shape here would be a second, weaker copy of that.
    case 'set_ai_memory':
      break;
    case 'add_marker':
      if (markers?.some((marker) => marker.id === op.id)) {
        issue('duplicate_marker', `Marker id already exists: ${op.id}`);
      }
      if (!Number.isFinite(op.time) || op.time < 0) {
        issue(
          'invalid_marker_time',
          `add_marker time must be a non-negative finite number, got: ${op.time}.`,
        );
      }
      break;
    case 'remove_marker':
      if (!markerExists(op.id)) issue('missing_marker', `Unknown marker '${op.id}'.`);
      break;
    case 'restore_assets':
    case 'restore_folders':
      break;
  }
  return issues;
}

function assetIsInUse(timeline: Timeline, assetId: string): boolean {
  return timeline.tracks.some((track) => track.clips.some((clip) => clip.assetId === assetId));
}

function advanceProjectState(
  op: ProjectOperation,
  assetIds: Set<string> | undefined,
  folders: Folder[] | undefined,
  markers: Marker[] | undefined,
): void {
  switch (op.type) {
    case 'add_asset':
      assetIds?.add(op.asset.id);
      break;
    case 'remove_asset':
      assetIds?.delete(op.assetId);
      break;
    case 'create_folder':
      folders?.push({ id: op.folderId, name: op.name, parentId: op.parentId });
      break;
    case 'move_folder':
      mutateFolder(folders, op.folderId, (folder) => ({ ...folder, parentId: op.parentId }));
      break;
    case 'rename_folder':
      mutateFolder(folders, op.folderId, (folder) => ({ ...folder, name: op.name }));
      break;
    case 'delete_folder':
      if (folders) {
        const target = folders.find((folder) => folder.id === op.folderId);
        const parentId = target?.parentId ?? null;
        const remaining = folders
          .filter((folder) => folder.id !== op.folderId)
          .map((folder) => (folder.parentId === op.folderId ? { ...folder, parentId } : folder));
        folders.length = 0;
        folders.push(...remaining);
      }
      break;
    case 'restore_folders':
      if (folders) {
        folders.length = 0;
        folders.push(...op.folders.map((folder) => ({ ...folder })));
      }
      break;
    case 'restore_assets':
      if (assetIds) {
        assetIds.clear();
        for (const asset of op.assets) assetIds.add(asset.id);
      }
      break;
    case 'add_marker':
      markers?.push({
        id: op.id,
        time: op.time,
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...(op.color !== undefined ? { color: op.color } : {}),
      });
      break;
    case 'remove_marker':
      if (markers) {
        const remaining = markers.filter((marker) => marker.id !== op.id);
        markers.length = 0;
        markers.push(...remaining);
      }
      break;
    case 'move_asset':
    case 'set_transcript':
    case 'set_ai_memory':
      break;
  }
}

function mutateFolder(
  folders: Folder[] | undefined,
  folderId: string,
  transform: (folder: Folder) => Folder,
): void {
  if (!folders) return;
  const index = folders.findIndex((folder) => folder.id === folderId);
  if (index >= 0) folders[index] = transform(folders[index]!);
}

function fromOperationError(cause: unknown, index: number): ValidationIssue {
  const error = cause as OperationError;
  const message = error.message;
  switch (error.code) {
    case 'missing_clip':
    case 'missing_track':
    case 'missing_effect':
      return { code: 'missing_reference', severity: 'error', message, operationIndex: index };
    case 'invalid_range':
    case 'invalid_split':
      return { code: 'negative_duration', severity: 'error', message, operationIndex: index };
    case 'duplicate_clip':
      return { code: 'overlap_error', severity: 'error', message, operationIndex: index };
    case 'duplicate_layer':
      return { code: 'duplicate_layer', severity: 'error', message, operationIndex: index };
    case 'invalid_style':
      return { code: 'invalid_style', severity: 'error', message, operationIndex: index };
    case 'invalid_cue':
      return { code: 'invalid_cue', severity: 'error', message, operationIndex: index };
    case 'invalid_speed':
      return { code: 'invalid_speed', severity: 'error', message, operationIndex: index };
    case 'invalid_crop':
      return { code: 'invalid_crop', severity: 'error', message, operationIndex: index };
    case 'invalid_blend_mode':
      return { code: 'invalid_blend_mode', severity: 'error', message, operationIndex: index };
    case 'invalid_transition':
      return { code: 'transition_overlap', severity: 'error', message, operationIndex: index };
    case 'invalid_track':
      return { code: 'invalid_track', severity: 'error', message, operationIndex: index };
    case 'invalid_effect_layer':
      return { code: 'invalid_effect_layer', severity: 'error', message, operationIndex: index };
    case 'duplicate_effect_layer':
      return { code: 'duplicate_effect_layer', severity: 'error', message, operationIndex: index };
  }
  // Anything the operations layer did not raise deliberately — a TypeError from a
  // malformed clip, a bug in an apply path. Without this arm the switch falls off the end
  // and returns `undefined`, which is pushed into `issues` and then crashes the
  // `issue.severity` read below: a patch that should have been REPORTED invalid takes the
  // whole validation down instead, which is the one thing a validator must never do.
  return {
    code: 'invalid_operation',
    severity: 'error',
    message: message || 'Operation could not be applied.',
    operationIndex: index,
  };
}
