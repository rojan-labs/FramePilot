/**
 * Professional editor commands compile editorial semantics into primitive patches.
 *
 * Commands name the edit an editor intends (roll, slip, slide) and carry integer
 * frame deltas plus the timeline revision they were resolved against. The compiler,
 * not an LLM or UI gesture handler, owns coupled operation order, handle checks,
 * patch validation, and inverse construction.
 */
import type { PatchId } from '@framepilot/shared-types';
import type { Angle, AngleGroup, Asset, Clip, Timeline, Track } from '@framepilot/timeline-schema';
import { splitClipRightId } from './operations.js';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';

const TIME_EPSILON = 1e-6;

export interface CommandFrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

export interface FrameDelta<Domain extends 'sequence' | 'source'> {
  readonly domain: Domain;
  readonly frames: number;
  readonly rate: CommandFrameRate;
}

export interface FramePoint<Domain extends 'sequence' | 'source'> {
  readonly domain: Domain;
  readonly frame: number;
  readonly rate: CommandFrameRate;
}

export interface SourceFrameRange {
  readonly domain: 'source';
  readonly startFrame: number;
  readonly endFrame: number;
  readonly rate: CommandFrameRate;
}

interface EditorCommandBase {
  /** Timeline authority used when target IDs and edit points were resolved. */
  readonly timelineRevision: number;
}

export interface RollEditCommand extends EditorCommandBase {
  readonly type: 'roll_edit';
  readonly outgoingClipId: string;
  readonly incomingClipId: string;
  readonly delta: FrameDelta<'sequence'>;
}

export interface SlipEditCommand extends EditorCommandBase {
  readonly type: 'slip_edit';
  readonly clipId: string;
  readonly delta: FrameDelta<'source'>;
}

export interface SlideEditCommand extends EditorCommandBase {
  readonly type: 'slide_edit';
  readonly previousClipId: string;
  readonly clipId: string;
  readonly nextClipId: string;
  readonly delta: FrameDelta<'sequence'>;
}

export interface RippleTrimEditCommand extends EditorCommandBase {
  readonly type: 'ripple_trim_edit';
  readonly clipId: string;
  readonly edge: 'start' | 'end';
  /** Positive frames move the named edge later; negative frames move it earlier. */
  readonly delta: FrameDelta<'sequence'>;
}

export interface LiftEditCommand extends EditorCommandBase {
  readonly type: 'lift_edit';
  readonly clipIds: readonly string[];
}

export interface ExtractEditCommand extends EditorCommandBase {
  readonly type: 'extract_edit';
  readonly clipIds: readonly string[];
}

export interface InsertEditCommand extends EditorCommandBase {
  readonly type: 'insert_edit';
  readonly trackId: string;
  readonly assetId: string;
  readonly at: FramePoint<'sequence'>;
  readonly sourceRange: SourceFrameRange;
}

export interface OverwriteEditCommand extends EditorCommandBase {
  readonly type: 'overwrite_edit';
  readonly trackId: string;
  readonly assetId: string;
  readonly at: FramePoint<'sequence'>;
  readonly sourceRange: SourceFrameRange;
}

export interface ReplaceEditCommand extends EditorCommandBase {
  readonly type: 'replace_edit';
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceIn: FramePoint<'source'>;
}

interface AsymmetricCutEditCommandBase extends EditorCommandBase {
  readonly videoOutgoingClipId: string;
  readonly videoIncomingClipId: string;
  readonly audioOutgoingClipId: string;
  readonly audioIncomingClipId: string;
  /** Positive magnitude by which the audio edit leads or trails the picture edit. */
  readonly delta: FrameDelta<'sequence'>;
}

/**
 * Cut to another camera in the same synced group, at a sequence frame (schema v18).
 *
 * The clip being watched names itself; which angle it currently shows is derived from
 * its media, and the destination is named as an angle rather than an asset so the
 * command cannot silently point at unsynced footage. The compiler maps the switch
 * position through both angles' sync offsets, so the incoming camera resumes at the
 * same *instant* rather than at the same source timestamp.
 */
export interface SwitchAngleEditCommand extends EditorCommandBase {
  readonly type: 'switch_angle_edit';
  readonly clipId: string;
  readonly targetAngleId: string;
  readonly at: FramePoint<'sequence'>;
}

export interface JCutEditCommand extends AsymmetricCutEditCommandBase {
  readonly type: 'j_cut_edit';
}

export interface LCutEditCommand extends AsymmetricCutEditCommandBase {
  readonly type: 'l_cut_edit';
}

export type EditorCommand =
  | RollEditCommand
  | SlipEditCommand
  | SlideEditCommand
  | RippleTrimEditCommand
  | LiftEditCommand
  | ExtractEditCommand
  | InsertEditCommand
  | OverwriteEditCommand
  | ReplaceEditCommand
  | SwitchAngleEditCommand
  | JCutEditCommand
  | LCutEditCommand;

/** Runtime command roster used by capability manifests and drift checks. */
export const EDITOR_COMMAND_TYPES = [
  'roll_edit',
  'slip_edit',
  'slide_edit',
  'ripple_trim_edit',
  'lift_edit',
  'extract_edit',
  'insert_edit',
  'overwrite_edit',
  'replace_edit',
  'switch_angle_edit',
  'j_cut_edit',
  'l_cut_edit',
] as const satisfies readonly EditorCommand['type'][];

type AssertNever<T extends never> = T;
/** Compile-time failure if a new EditorCommand is not added to the runtime roster. */
export type EditorCommandTypesAreExhaustive = AssertNever<
  Exclude<EditorCommand['type'], (typeof EDITOR_COMMAND_TYPES)[number]>
>;

export type EditorCommandRejectionCode =
  | 'stale_timeline'
  | 'invalid_frame_delta'
  | 'no_op'
  | 'missing_clip'
  | 'locked_track'
  | 'different_tracks'
  | 'not_adjacent'
  | 'clip_too_short'
  | 'missing_media_metadata'
  | 'insufficient_source_handle'
  | 'retimed_boundary_unsupported'
  | 'empty_target'
  | 'missing_track'
  | 'missing_asset'
  | 'invalid_frame_range'
  | 'source_range_out_of_bounds'
  | 'wrong_track_kind'
  | 'linked_media_mismatch'
  | 'unaligned_linked_cut'
  | 'ungrouped_angle_media'
  | 'ambiguous_angle_group'
  | 'missing_angle'
  | 'unsynced_angle'
  | 'switch_point_outside_clip'
  | 'invalid_patch';

export interface EditorCommandFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type EditorCommandCompileResult =
  | {
      readonly status: 'compiled';
      readonly command: EditorCommand;
      readonly patch: Patch;
      readonly inversePatch: Patch;
      readonly facts: readonly EditorCommandFact[];
    }
  | {
      readonly status: 'rejected';
      readonly command: EditorCommand;
      readonly code: EditorCommandRejectionCode;
      readonly detail: string;
      readonly facts: readonly EditorCommandFact[];
    };

export interface CompileEditorCommandInput {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  readonly sequenceRate: CommandFrameRate;
  readonly command: EditorCommand;
  /**
   * Authored camera groups (schema v18). Omitted ≡ none, which makes every angle
   * switch fail closed rather than compile against invented sync.
   */
  readonly angleGroups?: readonly AngleGroup[];
}

interface ClipLocation {
  readonly clip: Clip;
  readonly track: Track;
}

function clipLocation(timeline: Timeline, clipId: string): ClipLocation | undefined {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { clip, track };
  }
  return undefined;
}

function validRate(rate: CommandFrameRate): boolean {
  return (
    Number.isInteger(rate.numerator) &&
    rate.numerator > 0 &&
    Number.isInteger(rate.denominator) &&
    rate.denominator > 0
  );
}

function sameRate(left: CommandFrameRate, right: CommandFrameRate): boolean {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

function deltaSeconds(delta: FrameDelta<'sequence'> | FrameDelta<'source'>): number {
  return (delta.frames * delta.rate.denominator) / delta.rate.numerator;
}

function pointSeconds(point: FramePoint<'sequence'> | FramePoint<'source'>): number {
  return (point.frame * point.rate.denominator) / point.rate.numerator;
}

function sourceRangeSeconds(range: SourceFrameRange): { start: number; end: number } {
  return {
    start: (range.startFrame * range.rate.denominator) / range.rate.numerator,
    end: (range.endFrame * range.rate.denominator) / range.rate.numerator,
  };
}

function validPoint(point: FramePoint<'sequence'> | FramePoint<'source'>): boolean {
  return Number.isInteger(point.frame) && point.frame >= 0 && validRate(point.rate);
}

function rejected(
  command: EditorCommand,
  code: EditorCommandRejectionCode,
  detail: string,
  facts: readonly EditorCommandFact[] = [],
): EditorCommandCompileResult {
  return { status: 'rejected', command, code, detail, facts };
}

function validateAuthority(
  input: CompileEditorCommandInput,
): EditorCommandCompileResult | undefined {
  const { command, timeline, sequenceRate } = input;
  if ((timeline.revision ?? 0) !== command.timelineRevision) {
    return rejected(
      command,
      'stale_timeline',
      `Command resolved at timeline revision ${command.timelineRevision}, current revision is ${timeline.revision ?? 0}.`,
    );
  }
  if ('at' in command) {
    if (!validPoint(command.at) || !sameRate(command.at.rate, sequenceRate)) {
      return rejected(
        command,
        'invalid_frame_range',
        'Sequence edit points must be non-negative integer frames at the host sequence rate.',
      );
    }
  }
  if ('sourceRange' in command) {
    if (
      !Number.isInteger(command.sourceRange.startFrame) ||
      !Number.isInteger(command.sourceRange.endFrame) ||
      command.sourceRange.startFrame < 0 ||
      command.sourceRange.endFrame <= command.sourceRange.startFrame ||
      !validRate(command.sourceRange.rate)
    ) {
      return rejected(
        command,
        'invalid_frame_range',
        'Source ranges require ordered non-negative integer frames at a positive rational rate.',
      );
    }
  }
  if ('sourceIn' in command && !validPoint(command.sourceIn)) {
    return rejected(
      command,
      'invalid_frame_range',
      'Source in-points must be non-negative integer frames at a positive rational rate.',
    );
  }
  if (!('delta' in command)) return undefined;
  if (!Number.isInteger(command.delta.frames) || !validRate(command.delta.rate)) {
    return rejected(
      command,
      'invalid_frame_delta',
      'Frame deltas must use an integer frame count and a positive integer rational rate.',
    );
  }
  if (command.delta.frames === 0) {
    return rejected(command, 'no_op', 'The requested edit moves zero frames.');
  }
  if (command.delta.domain === 'sequence' && !sameRate(command.delta.rate, sequenceRate)) {
    return rejected(
      command,
      'invalid_frame_delta',
      'A sequence-domain command must use the sequence frame rate supplied by the host.',
    );
  }
  return undefined;
}

function locationsForClipSet(
  timeline: Timeline,
  command: EditorCommand,
  clipIds: readonly string[],
): ClipLocation[] | EditorCommandCompileResult {
  const uniqueIds = [...new Set(clipIds)];
  if (uniqueIds.length === 0) {
    return rejected(command, 'empty_target', 'The command requires at least one target clip.');
  }
  return assertLocations(timeline, command, uniqueIds);
}

function assertLocations(
  timeline: Timeline,
  command: EditorCommand,
  clipIds: readonly string[],
): ClipLocation[] | EditorCommandCompileResult {
  const locations: ClipLocation[] = [];
  for (const clipId of clipIds) {
    const location = clipLocation(timeline, clipId);
    if (!location) return rejected(command, 'missing_clip', `Clip "${clipId}" does not exist.`);
    if (location.track.locked === true) {
      return rejected(
        command,
        'locked_track',
        `Track "${location.track.id}" is locked. Unlock it before editing.`,
      );
    }
    locations.push(location);
  }
  return locations;
}

function assetDuration(assets: readonly Asset[], clip: Clip): number | undefined {
  return assets.find((asset) => asset.id === clip.assetId)?.durationSeconds;
}

function isRetimed(clip: Clip): boolean {
  return (clip.speed ?? 1) !== 1 || (clip.speedRamp?.length ?? 0) > 0;
}

function ensureHandle(
  command: EditorCommand,
  assets: readonly Asset[],
  clip: Clip,
  edge: 'head' | 'tail',
  requiredSeconds: number,
): EditorCommandCompileResult | undefined {
  if (requiredSeconds <= TIME_EPSILON) return undefined;
  if (edge === 'head') {
    if (clip.sourceStart + TIME_EPSILON < requiredSeconds) {
      return rejected(
        command,
        'insufficient_source_handle',
        `Clip "${clip.id}" has ${clip.sourceStart}s of head handle but ${requiredSeconds}s is required.`,
        [{ name: 'availableHeadSeconds', value: clip.sourceStart }],
      );
    }
    return undefined;
  }
  const duration = assetDuration(assets, clip);
  if (duration === undefined) {
    return rejected(
      command,
      'missing_media_metadata',
      `Asset "${clip.assetId}" needs a probed duration before its tail handle can be validated.`,
    );
  }
  const available = Math.max(0, duration - clip.sourceEnd);
  if (available + TIME_EPSILON < requiredSeconds) {
    return rejected(
      command,
      'insufficient_source_handle',
      `Clip "${clip.id}" has ${available}s of tail handle but ${requiredSeconds}s is required.`,
      [{ name: 'availableTailSeconds', value: available }],
    );
  }
  return undefined;
}

function compilePatch(
  timeline: Timeline,
  assets: readonly Asset[],
  command: EditorCommand,
  patch: Patch,
  facts: readonly EditorCommandFact[],
): EditorCommandCompileResult {
  const validation = validatePatch(timeline, patch, { assetIds: assets.map((asset) => asset.id) });
  if (!validation.valid) {
    return rejected(
      command,
      'invalid_patch',
      validation.issues.map((issue) => issue.message).join('; '),
      facts,
    );
  }
  try {
    const inversePatch = invertPatch(timeline, patch);
    applyPatch(applyPatch(timeline, patch), inversePatch);
    return { status: 'compiled', command, patch, inversePatch, facts };
  } catch (error) {
    return rejected(
      command,
      'invalid_patch',
      error instanceof Error ? error.message : String(error),
      facts,
    );
  }
}

function compileRoll(input: CompileEditorCommandInput, command: RollEditCommand) {
  const found = assertLocations(input.timeline, command, [
    command.outgoingClipId,
    command.incomingClipId,
  ]);
  if (!Array.isArray(found)) return found;
  const [outgoing, incoming] = found;
  if (outgoing!.track.id !== incoming!.track.id) {
    return rejected(command, 'different_tracks', 'A roll edit requires both clips on one track.');
  }
  if (Math.abs(outgoing!.clip.end - incoming!.clip.start) > TIME_EPSILON) {
    return rejected(command, 'not_adjacent', 'A roll edit requires a butt-joined cut.');
  }
  if (isRetimed(outgoing!.clip) || isRetimed(incoming!.clip)) {
    return rejected(
      command,
      'retimed_boundary_unsupported',
      'Roll edits on retimed boundaries require a source-curve-aware handle compiler.',
    );
  }
  const seconds = deltaSeconds(command.delta);
  const newCut = outgoing!.clip.end + seconds;
  const minDuration = input.sequenceRate.denominator / input.sequenceRate.numerator;
  if (
    newCut - outgoing!.clip.start < minDuration - TIME_EPSILON ||
    incoming!.clip.end - newCut < minDuration - TIME_EPSILON
  ) {
    return rejected(
      command,
      'clip_too_short',
      'A roll edit must leave at least one frame per clip.',
    );
  }
  const handleIssue =
    seconds > 0
      ? ensureHandle(command, input.assets, outgoing!.clip, 'tail', seconds)
      : ensureHandle(command, input.assets, incoming!.clip, 'head', -seconds);
  if (handleIssue) return handleIssue;

  const outgoingTrim = {
    type: 'trim_clip' as const,
    clipId: outgoing!.clip.id,
    start: outgoing!.clip.start,
    end: newCut,
  };
  const incomingTrim = {
    type: 'trim_clip' as const,
    clipId: incoming!.clip.id,
    start: newCut,
    end: incoming!.clip.end,
  };
  const patch: Patch = {
    patchId:
      `command__roll__${outgoing!.clip.id}__${incoming!.clip.id}__${command.delta.frames}` as PatchId,
    createdBy: 'agent',
    reason: `Roll the cut by ${command.delta.frames} frame(s)`,
    operations: seconds > 0 ? [incomingTrim, outgoingTrim] : [outgoingTrim, incomingTrim],
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'newCutSeconds', value: newCut },
    { name: 'deltaFrames', value: command.delta.frames },
  ]);
}

function compileSlip(input: CompileEditorCommandInput, command: SlipEditCommand) {
  const found = assertLocations(input.timeline, command, [command.clipId]);
  if (!Array.isArray(found)) return found;
  const clip = found[0]!.clip;
  const seconds = deltaSeconds(command.delta);
  const nextSourceStart = clip.sourceStart + seconds;
  const nextSourceEnd = clip.sourceEnd + seconds;
  const duration = assetDuration(input.assets, clip);
  if (duration === undefined) {
    return rejected(
      command,
      'missing_media_metadata',
      `Asset "${clip.assetId}" needs a probed duration before a slip can be validated.`,
    );
  }
  if (nextSourceStart < -TIME_EPSILON || nextSourceEnd > duration + TIME_EPSILON) {
    return rejected(
      command,
      'insufficient_source_handle',
      `Slip would request source range ${nextSourceStart}s–${nextSourceEnd}s outside asset duration ${duration}s.`,
    );
  }
  const patch: Patch = {
    patchId: `command__slip__${clip.id}__${command.delta.frames}` as PatchId,
    createdBy: 'agent',
    reason: `Slip "${clip.id}" by ${command.delta.frames} source frame(s)`,
    operations: [
      {
        type: 'set_clip_source_range',
        clipId: clip.id,
        sourceStart: nextSourceStart,
        sourceEnd: nextSourceEnd,
      },
    ],
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'sourceStartSeconds', value: nextSourceStart },
    { name: 'sourceEndSeconds', value: nextSourceEnd },
    { name: 'deltaSourceFrames', value: command.delta.frames },
  ]);
}

function compileSlide(input: CompileEditorCommandInput, command: SlideEditCommand) {
  const found = assertLocations(input.timeline, command, [
    command.previousClipId,
    command.clipId,
    command.nextClipId,
  ]);
  if (!Array.isArray(found)) return found;
  const [previous, selected, next] = found;
  if (previous!.track.id !== selected!.track.id || selected!.track.id !== next!.track.id) {
    return rejected(command, 'different_tracks', 'A slide edit requires three clips on one track.');
  }
  if (
    Math.abs(previous!.clip.end - selected!.clip.start) > TIME_EPSILON ||
    Math.abs(selected!.clip.end - next!.clip.start) > TIME_EPSILON
  ) {
    return rejected(command, 'not_adjacent', 'A slide edit requires three butt-joined clips.');
  }
  if (isRetimed(previous!.clip) || isRetimed(next!.clip)) {
    return rejected(
      command,
      'retimed_boundary_unsupported',
      'Slide edits beside retimed clips require a source-curve-aware handle compiler.',
    );
  }
  const seconds = deltaSeconds(command.delta);
  const minDuration = input.sequenceRate.denominator / input.sequenceRate.numerator;
  if (
    previous!.clip.end + seconds - previous!.clip.start < minDuration - TIME_EPSILON ||
    next!.clip.end - (next!.clip.start + seconds) < minDuration - TIME_EPSILON
  ) {
    return rejected(
      command,
      'clip_too_short',
      'A slide edit must leave at least one frame in each neighbouring clip.',
    );
  }
  const handleIssue =
    seconds > 0
      ? ensureHandle(command, input.assets, previous!.clip, 'tail', seconds)
      : ensureHandle(command, input.assets, next!.clip, 'head', -seconds);
  if (handleIssue) return handleIssue;

  const previousTrim = {
    type: 'trim_clip' as const,
    clipId: previous!.clip.id,
    start: previous!.clip.start,
    end: previous!.clip.end + seconds,
  };
  const move = {
    type: 'move_clip' as const,
    clipId: selected!.clip.id,
    toTrackId: selected!.track.id,
    toStart: selected!.clip.start + seconds,
  };
  const nextTrim = {
    type: 'trim_clip' as const,
    clipId: next!.clip.id,
    start: next!.clip.start + seconds,
    end: next!.clip.end,
  };
  const patch: Patch = {
    patchId: `command__slide__${selected!.clip.id}__${command.delta.frames}` as PatchId,
    createdBy: 'agent',
    reason: `Slide "${selected!.clip.id}" by ${command.delta.frames} frame(s)`,
    operations: seconds > 0 ? [nextTrim, move, previousTrim] : [previousTrim, move, nextTrim],
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'newStartSeconds', value: selected!.clip.start + seconds },
    { name: 'newEndSeconds', value: selected!.clip.end + seconds },
    { name: 'deltaFrames', value: command.delta.frames },
  ]);
}

function clipsStartingAtOrAfter(track: Track, at: number, excludedId?: string): Clip[] {
  return track.clips
    .filter((clip) => clip.id !== excludedId && clip.start >= at - TIME_EPSILON)
    .sort((left, right) => right.start - left.start || right.id.localeCompare(left.id));
}

function moveOps(track: Track, clips: readonly Clip[], seconds: number) {
  return clips.map((clip) => ({
    type: 'move_clip' as const,
    clipId: clip.id,
    toTrackId: track.id,
    toStart: clip.start + seconds,
  }));
}

function compileRippleTrim(
  input: CompileEditorCommandInput,
  command: RippleTrimEditCommand,
): EditorCommandCompileResult {
  const found = assertLocations(input.timeline, command, [command.clipId]);
  if (!Array.isArray(found)) return found;
  const { clip, track } = found[0]!;
  const seconds = deltaSeconds(command.delta);
  const minDuration = input.sequenceRate.denominator / input.sequenceRate.numerator;
  const nextStart = command.edge === 'start' ? clip.start + seconds : clip.start;
  const nextEnd = command.edge === 'end' ? clip.end + seconds : clip.end;
  if (nextEnd - nextStart < minDuration - TIME_EPSILON) {
    return rejected(
      command,
      'clip_too_short',
      'A ripple trim must leave at least one frame in the target clip.',
    );
  }

  const extendsSource =
    (command.edge === 'start' && seconds < 0) || (command.edge === 'end' && seconds > 0);
  if (extendsSource && isRetimed(clip)) {
    return rejected(
      command,
      'retimed_boundary_unsupported',
      'Extending a retimed clip requires a source-curve-aware handle compiler.',
    );
  }
  if (extendsSource) {
    const handleIssue = ensureHandle(
      command,
      input.assets,
      clip,
      command.edge === 'start' ? 'head' : 'tail',
      Math.abs(seconds),
    );
    if (handleIssue) return handleIssue;
  }

  let operations: Patch['operations'];
  if (command.edge === 'start' && seconds > 0) {
    operations = [{ type: 'ripple_delete', trackId: track.id, start: clip.start, end: nextStart }];
  } else if (command.edge === 'end' && seconds < 0) {
    operations = [{ type: 'ripple_delete', trackId: track.id, start: nextEnd, end: clip.end }];
  } else if (command.edge === 'start') {
    const inserted = -seconds;
    const shifted = clipsStartingAtOrAfter(track, clip.start);
    operations = [
      ...moveOps(track, shifted, inserted),
      {
        type: 'trim_clip',
        clipId: clip.id,
        start: clip.start,
        end: clip.end + inserted,
      },
    ];
  } else {
    const shifted = clipsStartingAtOrAfter(track, clip.end, clip.id);
    operations = [
      ...moveOps(track, shifted, seconds),
      { type: 'trim_clip', clipId: clip.id, start: clip.start, end: nextEnd },
    ];
  }

  const patch: Patch = {
    patchId:
      `command__ripple_trim__${clip.id}__${command.edge}__${command.delta.frames}` as PatchId,
    createdBy: 'agent',
    reason: `Ripple-trim the ${command.edge} of "${clip.id}" by ${command.delta.frames} frame(s)`,
    operations,
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'edge', value: command.edge },
    { name: 'deltaFrames', value: command.delta.frames },
    { name: 'sequenceDurationChangeSeconds', value: seconds * (command.edge === 'start' ? -1 : 1) },
  ]);
}

function compileRemoval(
  input: CompileEditorCommandInput,
  command: LiftEditCommand | ExtractEditCommand,
): EditorCommandCompileResult {
  const found = locationsForClipSet(input.timeline, command, command.clipIds);
  if (!Array.isArray(found)) return found;
  const ordered = [...found].sort(
    (left, right) =>
      right.clip.start - left.clip.start || left.track.id.localeCompare(right.track.id),
  );
  const operationType = command.type === 'lift_edit' ? 'delete_range' : 'ripple_delete';
  const patch: Patch = {
    patchId:
      `command__${command.type}__${ordered.map(({ clip }) => clip.id).join('__')}` as PatchId,
    createdBy: 'agent',
    reason: `${command.type === 'lift_edit' ? 'Lift' : 'Extract'} ${ordered.length} clip(s)`,
    operations: ordered.map(({ clip, track }) => ({
      type: operationType,
      trackId: track.id,
      start: clip.start,
      end: clip.end,
    })),
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'clipCount', value: ordered.length },
    { name: 'closesGaps', value: command.type === 'extract_edit' },
  ]);
}

function trackForCommand(
  timeline: Timeline,
  command: EditorCommand,
  trackId: string,
): Track | EditorCommandCompileResult {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return rejected(command, 'missing_track', `Track "${trackId}" does not exist.`);
  if (track.locked === true) {
    return rejected(command, 'locked_track', `Track "${trackId}" is locked. Unlock it first.`);
  }
  return track;
}

function assetForCommand(
  assets: readonly Asset[],
  command: EditorCommand,
  assetId: string,
): Asset | EditorCommandCompileResult {
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (!asset) return rejected(command, 'missing_asset', `Asset "${assetId}" does not exist.`);
  if (asset.durationSeconds === undefined) {
    return rejected(
      command,
      'missing_media_metadata',
      `Asset "${assetId}" needs a probed duration before this edit can compile.`,
    );
  }
  return asset;
}

function placementSource(
  input: CompileEditorCommandInput,
  command: InsertEditCommand | OverwriteEditCommand,
):
  | { readonly asset: Asset; readonly start: number; readonly end: number }
  | EditorCommandCompileResult {
  const asset = assetForCommand(input.assets, command, command.assetId);
  if ('status' in asset) return asset;
  const source = sourceRangeSeconds(command.sourceRange);
  if (source.end > asset.durationSeconds! + TIME_EPSILON) {
    return rejected(
      command,
      'source_range_out_of_bounds',
      `Source range ${source.start}s–${source.end}s exceeds asset duration ${asset.durationSeconds}s.`,
    );
  }
  return { asset, ...source };
}

function compileInsert(
  input: CompileEditorCommandInput,
  command: InsertEditCommand,
): EditorCommandCompileResult {
  const track = trackForCommand(input.timeline, command, command.trackId);
  if ('status' in track) return track;
  const source = placementSource(input, command);
  if ('status' in source) return source;
  const at = pointSeconds(command.at);
  const duration = source.end - source.start;
  const containing = track.clips.find(
    (clip) => clip.start < at - TIME_EPSILON && clip.end > at + TIME_EPSILON,
  );
  const splitOperation = containing
    ? ({ type: 'split_clip', clipId: containing.id, at } as const)
    : undefined;
  const downstream = track.clips
    .filter((clip) => clip.start >= at - TIME_EPSILON)
    .map((clip) => ({ id: clip.id, start: clip.start }));
  if (containing) downstream.push({ id: splitClipRightId(containing.id, at), start: at });
  downstream.sort((left, right) => right.start - left.start || right.id.localeCompare(left.id));

  const patch: Patch = {
    patchId:
      `command__insert__${command.assetId}__${command.trackId}__${command.at.frame}` as PatchId,
    createdBy: 'agent',
    reason: `Insert "${command.assetId}" at sequence frame ${command.at.frame}`,
    operations: [
      ...(splitOperation ? [splitOperation] : []),
      ...downstream.map(({ id, start }) => ({
        type: 'move_clip' as const,
        clipId: id,
        toTrackId: track.id,
        toStart: start + duration,
      })),
      {
        type: 'add_clip',
        trackId: track.id,
        assetId: source.asset.id,
        start: at,
        end: at + duration,
        sourceStart: source.start,
        sourceEnd: source.end,
      },
    ],
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'sequenceStartSeconds', value: at },
    { name: 'insertedDurationSeconds', value: duration },
    { name: 'splitExistingClip', value: containing !== undefined },
    { name: 'shiftedClipCount', value: downstream.length },
  ]);
}

function compileOverwrite(
  input: CompileEditorCommandInput,
  command: OverwriteEditCommand,
): EditorCommandCompileResult {
  const track = trackForCommand(input.timeline, command, command.trackId);
  if ('status' in track) return track;
  const source = placementSource(input, command);
  if ('status' in source) return source;
  const at = pointSeconds(command.at);
  const duration = source.end - source.start;
  const patch: Patch = {
    patchId:
      `command__overwrite__${command.assetId}__${command.trackId}__${command.at.frame}` as PatchId,
    createdBy: 'agent',
    reason: `Overwrite with "${command.assetId}" at sequence frame ${command.at.frame}`,
    operations: [
      { type: 'delete_range', trackId: track.id, start: at, end: at + duration },
      {
        type: 'add_clip',
        trackId: track.id,
        assetId: source.asset.id,
        start: at,
        end: at + duration,
        sourceStart: source.start,
        sourceEnd: source.end,
      },
    ],
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'sequenceStartSeconds', value: at },
    { name: 'overwrittenDurationSeconds', value: duration },
  ]);
}

function compileReplace(
  input: CompileEditorCommandInput,
  command: ReplaceEditCommand,
): EditorCommandCompileResult {
  const found = assertLocations(input.timeline, command, [command.clipId]);
  if (!Array.isArray(found)) return found;
  const clip = found[0]!.clip;
  const asset = assetForCommand(input.assets, command, command.assetId);
  if ('status' in asset) return asset;
  const sourceStart = pointSeconds(command.sourceIn);
  const sourceEnd = sourceStart + (clip.sourceEnd - clip.sourceStart);
  if (sourceEnd > asset.durationSeconds! + TIME_EPSILON) {
    return rejected(
      command,
      'source_range_out_of_bounds',
      `Replacement needs source through ${sourceEnd}s but asset duration is ${asset.durationSeconds}s.`,
    );
  }
  const patch: Patch = {
    patchId: `command__replace__${clip.id}__${asset.id}__${command.sourceIn.frame}` as PatchId,
    createdBy: 'agent',
    reason: `Replace footage in "${clip.id}" with "${asset.id}"`,
    operations: [
      {
        type: 'set_clip_media',
        clipId: clip.id,
        assetId: asset.id,
        sourceStart,
        sourceEnd,
      },
    ],
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'preservedClipId', value: clip.id },
    { name: 'replacementSourceStartSeconds', value: sourceStart },
    { name: 'replacementSourceEndSeconds', value: sourceEnd },
  ]);
}

interface AngleMembership {
  readonly group: AngleGroup;
  readonly angle: Angle;
}

/**
 * Which camera a clip is showing, derived from the media it points at.
 *
 * Returns `undefined` when the clip's asset is in no group, and the ambiguous list
 * when it is in more than one — the caller refuses both rather than choosing, because
 * picking a group would pick a sync relationship the editor never authored.
 */
function angleMembership(
  angleGroups: readonly AngleGroup[],
  assetId: string,
): { readonly matches: AngleMembership[] } {
  const matches: AngleMembership[] = [];
  for (const group of angleGroups) {
    const angle = group.angles.find((candidate) => candidate.assetId === assetId);
    if (angle) matches.push({ group, angle });
  }
  return { matches };
}

function compileSwitchAngle(
  input: CompileEditorCommandInput,
  command: SwitchAngleEditCommand,
): EditorCommandCompileResult {
  const found = assertLocations(input.timeline, command, [command.clipId]);
  if (!Array.isArray(found)) return found;
  const { clip, track } = found[0]!;

  const { matches } = angleMembership(input.angleGroups ?? [], clip.assetId);
  if (matches.length === 0) {
    return rejected(
      command,
      'ungrouped_angle_media',
      `Clip "${clip.id}" plays "${clip.assetId}", which is not part of any camera group. ` +
        'Group the cameras and give each one a sync offset before switching angles.',
    );
  }
  if (matches.length > 1) {
    return rejected(
      command,
      'ambiguous_angle_group',
      `Asset "${clip.assetId}" belongs to ${matches.length} camera groups ` +
        `(${matches.map((match) => match.group.id).join(', ')}), so the angle this clip shows is ` +
        'undecidable. Remove it from all but one group.',
    );
  }
  const { group, angle: current } = matches[0]!;

  const target = group.angles.find((candidate) => candidate.id === command.targetAngleId);
  if (!target) {
    return rejected(
      command,
      'missing_angle',
      `Camera group "${group.id}" has no angle "${command.targetAngleId}". ` +
        `Available angles: ${group.angles.map((a) => a.id).join(', ')}.`,
    );
  }
  if (target.id === current.id) {
    return rejected(command, 'no_op', `Clip "${clip.id}" is already on angle "${target.id}".`);
  }

  // Sync is the whole contract. An absent offset is not zero — see AngleSchema.
  for (const unsynced of [current, target]) {
    if (unsynced.syncOffsetSeconds === undefined) {
      return rejected(
        command,
        'unsynced_angle',
        `Angle "${unsynced.id}" in group "${group.id}" has no syncOffsetSeconds, so a switch ` +
          'cannot land on the same moment. Author the offset for this angle first.',
        [{ name: 'unsyncedAngleId', value: unsynced.id }],
      );
    }
  }

  // A retimed clip maps sequence time to source time non-linearly, so the single
  // offset arithmetic below would land on the wrong frame. Refuse rather than guess.
  if (isRetimed(clip)) {
    return rejected(
      command,
      'retimed_boundary_unsupported',
      `Clip "${clip.id}" is retimed, so its source position at the switch point is not a ` +
        'straight offset. Switch angles before retiming, or cut the clip first.',
    );
  }

  const targetAsset = assetForCommand(input.assets, command, target.assetId);
  if ('status' in targetAsset) return targetAsset;

  const at = pointSeconds(command.at);
  if (at < clip.start - TIME_EPSILON || at > clip.end - TIME_EPSILON) {
    return rejected(
      command,
      'switch_point_outside_clip',
      `Sequence frame ${command.at.frame} (${at}s) is not inside clip "${clip.id}" ` +
        `(${clip.start}s–${clip.end}s). A switch must land on a frame the clip actually shows.`,
    );
  }

  // Whole-clip switch when the point sits on the clip's own head; otherwise the clip
  // is cut and only the downstream half changes camera.
  const splitsClip = at > clip.start + TIME_EPSILON;
  const switchedStart = splitsClip ? at : clip.start;
  const switchedSourceStart = clip.sourceStart + (switchedStart - clip.start);
  const groupTime = switchedSourceStart - current.syncOffsetSeconds!;
  const sourceStart = groupTime + target.syncOffsetSeconds!;
  const sourceEnd = sourceStart + (clip.end - switchedStart);

  if (sourceStart < -TIME_EPSILON) {
    return rejected(
      command,
      'source_range_out_of_bounds',
      `Angle "${target.id}" was not yet recording at this moment: the switch needs its source ` +
        `at ${sourceStart}s.`,
      [{ name: 'requiredSourceStartSeconds', value: sourceStart }],
    );
  }
  if (sourceEnd > targetAsset.durationSeconds! + TIME_EPSILON) {
    return rejected(
      command,
      'source_range_out_of_bounds',
      `Angle "${target.id}" runs out of footage: the switch needs source through ${sourceEnd}s ` +
        `but "${target.assetId}" is ${targetAsset.durationSeconds}s long.`,
      [{ name: 'requiredSourceEndSeconds', value: sourceEnd }],
    );
  }

  const switchedClipId = splitsClip ? splitClipRightId(clip.id, at) : clip.id;
  const patch: Patch = {
    patchId: `command__switch_angle__${clip.id}__${target.id}__${command.at.frame}` as PatchId,
    createdBy: 'agent',
    reason: `Switch to angle "${target.id}" at sequence frame ${command.at.frame}`,
    operations: [
      ...(splitsClip ? [{ type: 'split_clip' as const, clipId: clip.id, at }] : []),
      {
        type: 'set_clip_media',
        clipId: switchedClipId,
        assetId: target.assetId,
        sourceStart,
        sourceEnd,
      },
    ],
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'angleGroupId', value: group.id },
    { name: 'fromAngleId', value: current.id },
    { name: 'toAngleId', value: target.id },
    { name: 'trackId', value: track.id },
    // The cut boundary the temporal reviewer must look at.
    { name: 'switchSequenceSeconds', value: switchedStart },
    { name: 'splitExistingClip', value: splitsClip },
    { name: 'groupTimeSeconds', value: groupTime },
    { name: 'targetSourceStartSeconds', value: sourceStart },
    { name: 'targetSourceEndSeconds', value: sourceEnd },
  ]);
}

function compileAsymmetricCut(
  input: CompileEditorCommandInput,
  command: JCutEditCommand | LCutEditCommand,
): EditorCommandCompileResult {
  if (command.delta.frames < 1) {
    return rejected(
      command,
      'invalid_frame_delta',
      'J-cut and L-cut deltas are positive magnitudes; the command type owns direction.',
    );
  }
  const found = assertLocations(input.timeline, command, [
    command.videoOutgoingClipId,
    command.videoIncomingClipId,
    command.audioOutgoingClipId,
    command.audioIncomingClipId,
  ]);
  if (!Array.isArray(found)) return found;
  const [videoOutgoing, videoIncoming, audioOutgoing, audioIncoming] = found;
  if (videoOutgoing!.track.type !== 'video' || videoIncoming!.track.type !== 'video') {
    return rejected(command, 'wrong_track_kind', 'Picture sides of a J/L cut must be video clips.');
  }
  if (audioOutgoing!.track.type !== 'audio' || audioIncoming!.track.type !== 'audio') {
    return rejected(command, 'wrong_track_kind', 'Sound sides of a J/L cut must be audio clips.');
  }
  if (
    videoOutgoing!.track.id !== videoIncoming!.track.id ||
    audioOutgoing!.track.id !== audioIncoming!.track.id
  ) {
    return rejected(
      command,
      'different_tracks',
      'Each side of a J/L cut must be butt-joined on one video track and one audio track.',
    );
  }
  if (
    videoOutgoing!.clip.assetId !== audioOutgoing!.clip.assetId ||
    videoIncoming!.clip.assetId !== audioIncoming!.clip.assetId
  ) {
    return rejected(
      command,
      'linked_media_mismatch',
      'J/L cut video and audio pairs must reference the same source assets.',
    );
  }
  const pictureCut = videoOutgoing!.clip.end;
  const soundCut = audioOutgoing!.clip.end;
  if (
    Math.abs(pictureCut - videoIncoming!.clip.start) > TIME_EPSILON ||
    Math.abs(soundCut - audioIncoming!.clip.start) > TIME_EPSILON ||
    Math.abs(pictureCut - soundCut) > TIME_EPSILON
  ) {
    return rejected(
      command,
      'unaligned_linked_cut',
      'A new J/L cut requires aligned, butt-joined picture and sound cuts.',
    );
  }
  if (isRetimed(audioOutgoing!.clip) || isRetimed(audioIncoming!.clip)) {
    return rejected(
      command,
      'retimed_boundary_unsupported',
      'J/L cuts on retimed audio require a source-curve-aware handle compiler.',
    );
  }

  const magnitude = deltaSeconds(command.delta);
  const seconds = command.type === 'j_cut_edit' ? -magnitude : magnitude;
  const nextSoundCut = soundCut + seconds;
  const minDuration = input.sequenceRate.denominator / input.sequenceRate.numerator;
  if (
    nextSoundCut - audioOutgoing!.clip.start < minDuration - TIME_EPSILON ||
    audioIncoming!.clip.end - nextSoundCut < minDuration - TIME_EPSILON
  ) {
    return rejected(
      command,
      'clip_too_short',
      'A J/L cut must leave at least one frame in each audio clip.',
    );
  }
  const handleIssue =
    seconds > 0
      ? ensureHandle(command, input.assets, audioOutgoing!.clip, 'tail', seconds)
      : ensureHandle(command, input.assets, audioIncoming!.clip, 'head', -seconds);
  if (handleIssue) return handleIssue;

  const outgoingTrim = {
    type: 'trim_clip' as const,
    clipId: audioOutgoing!.clip.id,
    start: audioOutgoing!.clip.start,
    end: nextSoundCut,
  };
  const incomingTrim = {
    type: 'trim_clip' as const,
    clipId: audioIncoming!.clip.id,
    start: nextSoundCut,
    end: audioIncoming!.clip.end,
  };
  const style = command.type === 'j_cut_edit' ? 'j_cut' : 'l_cut';
  const patch: Patch = {
    patchId:
      `command__${style}__${audioOutgoing!.clip.id}__${audioIncoming!.clip.id}__${command.delta.frames}` as PatchId,
    createdBy: 'agent',
    reason: `${command.type === 'j_cut_edit' ? 'Lead' : 'Trail'} sound by ${command.delta.frames} frame(s)`,
    operations: seconds > 0 ? [incomingTrim, outgoingTrim] : [outgoingTrim, incomingTrim],
  };
  return compilePatch(input.timeline, input.assets, command, patch, [
    { name: 'pictureCutSeconds', value: pictureCut },
    { name: 'soundCutSeconds', value: nextSoundCut },
    {
      name: 'audioOffsetFrames',
      value: command.type === 'j_cut_edit' ? -command.delta.frames : command.delta.frames,
    },
  ]);
}

/** Compile a revision-bound professional command into a validated reversible patch. */
export function compileEditorCommand(input: CompileEditorCommandInput): EditorCommandCompileResult {
  const authorityIssue = validateAuthority(input);
  if (authorityIssue) return authorityIssue;
  switch (input.command.type) {
    case 'roll_edit':
      return compileRoll(input, input.command);
    case 'slip_edit':
      return compileSlip(input, input.command);
    case 'slide_edit':
      return compileSlide(input, input.command);
    case 'ripple_trim_edit':
      return compileRippleTrim(input, input.command);
    case 'lift_edit':
    case 'extract_edit':
      return compileRemoval(input, input.command);
    case 'insert_edit':
      return compileInsert(input, input.command);
    case 'overwrite_edit':
      return compileOverwrite(input, input.command);
    case 'replace_edit':
      return compileReplace(input, input.command);
    case 'switch_angle_edit':
      return compileSwitchAngle(input, input.command);
    case 'j_cut_edit':
    case 'l_cut_edit':
      return compileAsymmetricCut(input, input.command);
  }
}
