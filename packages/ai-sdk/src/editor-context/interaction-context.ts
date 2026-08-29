/**
 * Ephemeral editor state captured at the instant an AI turn starts.
 *
 * This is intentionally separate from the persisted project schema. Selection,
 * playhead, and inspector focus describe the user's current interaction, not the
 * project document. Keeping the contract serialisable lets browser and Electron
 * feed the same resolver without giving tools access to live UI objects.
 */
import { effectLayersOf, type Project } from '@framepilot/timeline-schema';
import { secondsToFrame, type RationalFrameRate } from '../frame-time.js';

export const EDITOR_INTERACTION_CONTEXT_VERSION = 2 as const;

export interface InteractionTimeRange {
  readonly start: number;
  readonly end: number;
}

export interface InteractionKeyframeRef {
  readonly clipId: string;
  readonly property: string;
  /** Clip-relative keyframe time in seconds. */
  readonly time: number;
}

export interface SourceMonitorInteraction {
  readonly assetId: string;
  /** Rational timebase used by the monitor to quantize source frames and marks. */
  readonly rate: RationalFrameRate;
  readonly playhead: { readonly seconds: number; readonly frame: number };
  readonly markedRange?: { readonly startFrame: number; readonly endFrame: number };
}

export interface EditorInteractionContext {
  readonly schemaVersion: typeof EDITOR_INTERACTION_CONTEXT_VERSION;
  /** Host authority revision; distinct from the timeline's structural revision. */
  readonly projectRevision: number;
  /** Structural timing revision read from the captured project timeline. */
  readonly timelineRevision: number;
  /** Project id until multiple named sequences become persisted first-class state. */
  readonly sequenceId: string;
  readonly playhead: {
    readonly seconds: number;
    readonly frame: number;
  };
  readonly selection: {
    readonly primaryClipId?: string;
    readonly clipIds: readonly string[];
    readonly trackIds: readonly string[];
    readonly effectLayerIds?: readonly string[];
    readonly keyframes?: readonly InteractionKeyframeRef[];
    readonly timeRange?: InteractionTimeRange;
  };
  readonly visibleTimelineRange?: InteractionTimeRange;
  readonly sourceMonitor?: SourceMonitorInteraction;
}

export interface CaptureInteractionContextInput {
  readonly project: Project;
  readonly projectRevision: number;
  readonly playheadSeconds: number;
  readonly selectedClipIds?: readonly string[];
  readonly primaryClipId?: string | null;
  readonly selectedEffectLayerIds?: readonly string[];
  readonly selectedKeyframes?: readonly InteractionKeyframeRef[];
  readonly timeRange?: InteractionTimeRange;
  readonly visibleTimelineRange?: InteractionTimeRange;
  readonly sourceMonitor?: SourceMonitorInteraction;
}

function assertRange(range: InteractionTimeRange, label: string): void {
  if (
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    throw new RangeError(`${label} must be a finite non-negative range with start <= end.`);
  }
}

/** Capture one immutable, bounded-by-caller interaction snapshot for an AI turn. */
export function captureEditorInteractionContext(
  input: CaptureInteractionContextInput,
): EditorInteractionContext {
  if (!Number.isInteger(input.projectRevision) || input.projectRevision < 0) {
    throw new RangeError('projectRevision must be a non-negative integer.');
  }
  if (!Number.isFinite(input.playheadSeconds) || input.playheadSeconds < 0) {
    throw new RangeError('playheadSeconds must be finite and non-negative.');
  }
  if (input.timeRange) assertRange(input.timeRange, 'timeRange');
  if (input.visibleTimelineRange) assertRange(input.visibleTimelineRange, 'visibleTimelineRange');

  // A source-monitor asset can disappear between the panel publishing its ephemeral snapshot and
  // the AI turn capturing authoritative project state (for example, the user removes that media
  // from the bin). Treat that stale reference as no current source focus. The remaining validation
  // stays strict because malformed clocks/marks for a live asset are still untrusted input.
  const sourceMonitor = input.sourceMonitor
    ? input.project.assets.some((asset) => asset.id === input.sourceMonitor?.assetId)
      ? input.sourceMonitor
      : undefined
    : undefined;

  if (sourceMonitor) {
    const { assetId, rate, playhead, markedRange } = sourceMonitor;
    const asset = input.project.assets.find((candidate) => candidate.id === assetId);
    const validRate =
      Number.isSafeInteger(rate.numerator) &&
      rate.numerator > 0 &&
      Number.isSafeInteger(rate.denominator) &&
      rate.denominator > 0;
    const frameSeconds = validRate ? rate.denominator / rate.numerator : 0;
    const frameAtPlayhead = validRate ? Math.round(playhead.seconds / frameSeconds) : -1;
    const durationSeconds = asset?.durationSeconds;
    const exceedsDuration =
      durationSeconds !== undefined && playhead.seconds > durationSeconds + frameSeconds;
    const marksExceedDuration =
      markedRange !== undefined &&
      durationSeconds !== undefined &&
      markedRange.endFrame * frameSeconds > durationSeconds + frameSeconds;
    if (
      !asset ||
      !validRate ||
      !Number.isFinite(playhead.seconds) ||
      playhead.seconds < 0 ||
      exceedsDuration ||
      !Number.isSafeInteger(playhead.frame) ||
      playhead.frame < 0 ||
      Math.abs(playhead.frame - frameAtPlayhead) > 1 ||
      (markedRange !== undefined &&
        (!Number.isSafeInteger(markedRange.startFrame) ||
          !Number.isSafeInteger(markedRange.endFrame) ||
          markedRange.startFrame < 0 ||
          markedRange.endFrame <= markedRange.startFrame ||
          marksExceedDuration))
    ) {
      throw new RangeError('sourceMonitor must reference live media and valid frame positions.');
    }
  }

  const clipIds = [...new Set(input.selectedClipIds ?? [])];
  const primaryClipId =
    input.primaryClipId && clipIds.includes(input.primaryClipId)
      ? input.primaryClipId
      : clipIds[clipIds.length - 1];
  const tracksByClip = new Map<string, string>();
  for (const track of input.project.timeline.tracks) {
    for (const clip of track.clips) tracksByClip.set(clip.id, track.id);
  }
  const trackIds = [
    ...new Set(
      clipIds.map((clipId) => tracksByClip.get(clipId)).filter((id): id is string => !!id),
    ),
  ];
  const liveEffectLayerIds = new Set(
    input.project.timeline.tracks.flatMap((track) =>
      effectLayersOf(track).map((layer) => layer.id),
    ),
  );
  const effectLayerIds = [...new Set(input.selectedEffectLayerIds ?? [])].filter((id) =>
    liveEffectLayerIds.has(id),
  );
  const clipsById = new Map(
    input.project.timeline.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip])),
  );
  const keyframes = (input.selectedKeyframes ?? []).filter((reference) => {
    const clip = clipsById.get(reference.clipId);
    return (
      clip !== undefined &&
      Number.isFinite(reference.time) &&
      reference.time >= 0 &&
      clip.keyframes.some(
        (keyframe) =>
          keyframe.property === reference.property &&
          Math.abs(keyframe.time - reference.time) <= 0.001,
      )
    );
  });

  return {
    schemaVersion: EDITOR_INTERACTION_CONTEXT_VERSION,
    projectRevision: input.projectRevision,
    timelineRevision: input.project.timeline.revision ?? 0,
    sequenceId: input.project.id,
    playhead: {
      seconds: input.playheadSeconds,
      frame: secondsToFrame(input.playheadSeconds, input.project.fps),
    },
    selection: {
      ...(primaryClipId ? { primaryClipId } : {}),
      clipIds,
      trackIds,
      effectLayerIds,
      keyframes,
      ...(input.timeRange ? { timeRange: { ...input.timeRange } } : {}),
    },
    ...(input.visibleTimelineRange
      ? { visibleTimelineRange: { ...input.visibleTimelineRange } }
      : {}),
    ...(sourceMonitor
      ? {
          sourceMonitor: {
            ...sourceMonitor,
            playhead: { ...sourceMonitor.playhead },
            ...(sourceMonitor.markedRange ? { markedRange: { ...sourceMonitor.markedRange } } : {}),
          },
        }
      : {}),
  };
}

/** Compact factual block for the model; resolver logic never parses this text. */
export function summarizeEditorInteraction(context: EditorInteractionContext): string {
  const effectLayerIds = context.selection.effectLayerIds ?? [];
  const keyframes = context.selection.keyframes ?? [];
  // Revision, playhead and the selected range are stated once, in the STATE block at
  // the head of the context (P1.3); this summary carries the referents only.
  const lines = [
    `Editor state (timeline revision ${context.timelineRevision}, playhead frame ${context.playhead.frame}):`,
    `- Selected clips: ${context.selection.clipIds.length > 0 ? context.selection.clipIds.join(', ') : '(none)'}`,
    `- Selected tracks: ${context.selection.trackIds.length > 0 ? context.selection.trackIds.join(', ') : '(none)'}`,
    `- Selected effect layers: ${effectLayerIds.length > 0 ? effectLayerIds.join(', ') : '(none)'}`,
    `- Selected keyframes: ${keyframes.length > 0 ? keyframes.map((keyframe) => `${keyframe.clipId}:${keyframe.property}@${keyframe.time}s`).join(', ') : '(none)'}`,
  ];
  if (context.selection.primaryClipId) {
    lines.push(`- Primary clip: ${context.selection.primaryClipId}`);
  }
  if (context.sourceMonitor) {
    lines.push(
      `- Source monitor: ${context.sourceMonitor.assetId} at frame ${context.sourceMonitor.playhead.frame} (${context.sourceMonitor.rate.numerator}/${context.sourceMonitor.rate.denominator} fps timebase)`,
    );
    if (context.sourceMonitor.markedRange) {
      lines.push(
        `- Source marks: frames ${context.sourceMonitor.markedRange.startFrame}–${context.sourceMonitor.markedRange.endFrame}`,
      );
    }
  }
  return lines.join('\n');
}

/** Reject renderer-supplied references that do not exist in the authoritative project. */
export function assertEditorInteractionReferences(
  project: Project,
  context: EditorInteractionContext,
): void {
  if (context.sequenceId !== project.id) {
    throw new Error(`Interaction sequence "${context.sequenceId}" does not match this project.`);
  }
  const trackIds = new Set(project.timeline.tracks.map((track) => track.id));
  const clips = new Map(
    project.timeline.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip])),
  );
  const effectLayerIds = new Set(
    project.timeline.tracks.flatMap((track) => effectLayersOf(track).map((layer) => layer.id)),
  );
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const missing = [
    ...context.selection.clipIds.filter((id) => !clips.has(id)).map((id) => `clip:${id}`),
    ...context.selection.trackIds.filter((id) => !trackIds.has(id)).map((id) => `track:${id}`),
    ...(context.selection.effectLayerIds ?? [])
      .filter((id) => !effectLayerIds.has(id))
      .map((id) => `effect:${id}`),
    ...(context.sourceMonitor && !assetIds.has(context.sourceMonitor.assetId)
      ? [`asset:${context.sourceMonitor.assetId}`]
      : []),
  ];
  for (const reference of context.selection.keyframes ?? []) {
    const clip = clips.get(reference.clipId);
    if (
      !clip?.keyframes.some(
        (keyframe) =>
          keyframe.property === reference.property &&
          Math.abs(keyframe.time - reference.time) <= 0.001,
      )
    ) {
      missing.push(`keyframe:${reference.clipId}:${reference.property}@${reference.time}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Interaction references are not live in this project: ${missing.join(', ')}.`);
  }
}
