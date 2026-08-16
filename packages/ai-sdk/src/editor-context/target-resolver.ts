/** Deterministic resolution of editor referents before any mutating tool runs. */
import { listEditBoundaries, type EditBoundary } from '@framepilot/editor-core';
import type { Clip, Project, Track } from '@framepilot/timeline-schema';
import { frameToSeconds } from '../frame-time.js';
import type { EditorInteractionContext, InteractionTimeRange } from './interaction-context.js';

export type TargetEvidence =
  | 'explicit_id'
  | 'selection'
  | 'playhead'
  | 'selected_edit_point'
  | 'linked_edit_point'
  | 'selected_track'
  /** An authored track role (schema v17) rather than anything the user has selected. */
  | 'track_role'
  | 'selection_range'
  | 'visible_range';

export interface ClipTarget {
  readonly kind: 'clips';
  readonly clipIds: readonly string[];
  readonly trackIds: readonly string[];
  readonly range: InteractionTimeRange;
}

export interface EditPointTarget {
  readonly kind: 'edit_point';
  readonly boundary: EditBoundary;
}

export interface LinkedEditPointTarget {
  readonly kind: 'linked_edit_point';
  readonly videoBoundary: EditBoundary;
  readonly audioBoundary: EditBoundary;
}

export interface TrackTarget {
  readonly kind: 'tracks';
  readonly trackIds: readonly string[];
}

export interface RangeTarget {
  readonly kind: 'range';
  readonly range: InteractionTimeRange;
  readonly trackIds: readonly string[];
}

export type ResolvedEditorTarget =
  | ClipTarget
  | EditPointTarget
  | LinkedEditPointTarget
  | TrackTarget
  | RangeTarget;

export type TargetResolution =
  | {
      readonly status: 'resolved';
      readonly target: ResolvedEditorTarget;
      readonly evidence: TargetEvidence;
    }
  | {
      readonly status: 'ambiguous';
      readonly reason:
        | 'multiple_playhead_clips'
        | 'multiple_edit_points'
        | 'multiple_linked_edit_points';
      readonly candidateIds: readonly string[];
    }
  | {
      readonly status: 'unresolved';
      readonly reason:
        | 'stale_context'
        | 'missing_explicit_target'
        | 'no_selection'
        | 'no_clip_at_playhead'
        | 'no_edit_point'
        | 'no_linked_edit_point'
        | 'missing_explicit_track'
        | 'no_selected_track'
        | 'no_selected_range'
        | 'no_visible_range';
      readonly detail: string;
    };

export type TargetQuery =
  | {
      readonly kind: 'clips';
      readonly referent: 'explicit' | 'this' | 'these' | 'playhead';
      readonly clipIds?: readonly string[];
    }
  | {
      readonly kind: 'edit_point';
      readonly anchor: 'playhead' | 'selection';
      readonly relation?: 'at' | 'before' | 'after';
      readonly toleranceFrames?: number;
    }
  | {
      readonly kind: 'linked_edit_point';
      readonly anchor: 'playhead' | 'selection';
      readonly relation?: 'at' | 'before' | 'after';
      readonly toleranceFrames?: number;
    }
  | {
      readonly kind: 'tracks';
      readonly referent: 'explicit' | 'selected';
      readonly trackIds?: readonly string[];
    }
  | {
      readonly kind: 'range';
      readonly referent: 'selection' | 'visible';
    };

export interface ResolveEditorTargetOptions {
  /** Current host authority revision. Required by mutating call sites. */
  readonly projectRevision?: number;
}

function unresolved(
  reason: Extract<TargetResolution, { status: 'unresolved' }>['reason'],
  detail: string,
): TargetResolution {
  return { status: 'unresolved', reason, detail };
}

function clipsById(project: Project): ReadonlyMap<string, Clip> {
  const clips = new Map<string, Clip>();
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) clips.set(clip.id, clip);
  }
  return clips;
}

function resolvedClips(clips: readonly Clip[], evidence: TargetEvidence): TargetResolution {
  const range = clips.reduce(
    (current, clip) => ({
      start: Math.min(current.start, clip.start),
      end: Math.max(current.end, clip.end),
    }),
    { start: Number.POSITIVE_INFINITY, end: 0 },
  );
  return {
    status: 'resolved',
    evidence,
    target: {
      kind: 'clips',
      clipIds: clips.map((clip) => clip.id),
      trackIds: [...new Set(clips.map((clip) => clip.trackId))],
      range,
    },
  };
}

function validateContext(
  project: Project,
  context: EditorInteractionContext,
  options: ResolveEditorTargetOptions,
): TargetResolution | null {
  const currentTimelineRevision = project.timeline.revision ?? 0;
  if (context.sequenceId !== project.id || context.timelineRevision !== currentTimelineRevision) {
    return unresolved(
      'stale_context',
      `Interaction context targets ${context.sequenceId}@${context.timelineRevision}, but the project is ${project.id}@${currentTimelineRevision}.`,
    );
  }
  if (
    options.projectRevision !== undefined &&
    options.projectRevision !== context.projectRevision
  ) {
    return unresolved(
      'stale_context',
      `Interaction context targets project revision ${context.projectRevision}, but current authority is ${options.projectRevision}.`,
    );
  }
  return null;
}

function resolveTracks(
  project: Project,
  context: EditorInteractionContext,
  query: Extract<TargetQuery, { kind: 'tracks' }>,
): TargetResolution {
  const byId = new Map(project.timeline.tracks.map((track) => [track.id, track] as const));
  const requested =
    query.referent === 'explicit'
      ? [...new Set(query.trackIds ?? [])]
      : [...new Set(context.selection.trackIds)];
  const tracks = requested.map((id) => byId.get(id)).filter((track): track is Track => !!track);
  if (
    query.referent === 'explicit' &&
    (requested.length === 0 || tracks.length !== requested.length)
  ) {
    return unresolved('missing_explicit_track', 'One or more explicit track ids do not exist.');
  }
  if (tracks.length === 0) {
    return unresolved('no_selected_track', 'No selected track could be resolved.');
  }
  return {
    status: 'resolved',
    evidence: query.referent === 'explicit' ? 'explicit_id' : 'selected_track',
    target: { kind: 'tracks', trackIds: tracks.map((track) => track.id) },
  };
}

function resolveRange(
  context: EditorInteractionContext,
  query: Extract<TargetQuery, { kind: 'range' }>,
): TargetResolution {
  const range =
    query.referent === 'selection' ? context.selection.timeRange : context.visibleTimelineRange;
  if (!range) {
    return unresolved(
      query.referent === 'selection' ? 'no_selected_range' : 'no_visible_range',
      query.referent === 'selection'
        ? 'No timeline range is selected.'
        : 'No visible timeline range was captured.',
    );
  }
  return {
    status: 'resolved',
    evidence: query.referent === 'selection' ? 'selection_range' : 'visible_range',
    target: { kind: 'range', range: { ...range }, trackIds: [...context.selection.trackIds] },
  };
}

function resolveClips(
  project: Project,
  context: EditorInteractionContext,
  query: Extract<TargetQuery, { kind: 'clips' }>,
): TargetResolution {
  const byId = clipsById(project);
  if (query.referent === 'explicit') {
    const requested = [...new Set(query.clipIds ?? [])];
    const clips = requested.map((id) => byId.get(id)).filter((clip): clip is Clip => !!clip);
    if (requested.length === 0 || clips.length !== requested.length) {
      return unresolved('missing_explicit_target', 'One or more explicit clip ids do not exist.');
    }
    return resolvedClips(clips, 'explicit_id');
  }

  const selected = context.selection.clipIds
    .map((id) => byId.get(id))
    .filter((clip): clip is Clip => !!clip);
  if (query.referent === 'these') {
    return selected.length > 0
      ? resolvedClips(selected, 'selection')
      : unresolved('no_selection', '“These” requires one or more selected clips.');
  }
  if (query.referent === 'this' && selected.length > 0) {
    const primary = context.selection.primaryClipId
      ? byId.get(context.selection.primaryClipId)
      : selected[selected.length - 1];
    return primary
      ? resolvedClips([primary], 'selection')
      : unresolved('no_selection', 'The primary selected clip no longer exists.');
  }

  const atPlayhead = [...byId.values()].filter(
    (clip) => clip.start <= context.playhead.seconds && context.playhead.seconds < clip.end,
  );
  if (atPlayhead.length === 0) {
    return unresolved('no_clip_at_playhead', 'No clip is under the playhead.');
  }
  const selectedAtPlayhead = atPlayhead.find((clip) => clip.id === context.selection.primaryClipId);
  if (selectedAtPlayhead) return resolvedClips([selectedAtPlayhead], 'selection');
  if (atPlayhead.length > 1) {
    return {
      status: 'ambiguous',
      reason: 'multiple_playhead_clips',
      candidateIds: atPlayhead.map((clip) => clip.id),
    };
  }
  return resolvedClips(atPlayhead, 'playhead');
}

function selectedBoundary(
  boundaries: readonly EditBoundary[],
  context: EditorInteractionContext,
  relation: 'at' | 'before' | 'after',
): readonly EditBoundary[] {
  const clipId = context.selection.primaryClipId;
  if (!clipId) return [];
  switch (relation) {
    case 'before':
      return boundaries.filter((boundary) => boundary.toClipId === clipId);
    case 'after':
      return boundaries.filter((boundary) => boundary.fromClipId === clipId);
    case 'at':
      return boundaries.filter(
        (boundary) => boundary.fromClipId === clipId || boundary.toClipId === clipId,
      );
  }
}

function resolveEditPoint(
  project: Project,
  context: EditorInteractionContext,
  query: Extract<TargetQuery, { kind: 'edit_point' }>,
): TargetResolution {
  const boundaries = listEditBoundaries(project.timeline, project.assets);
  const relation = query.relation ?? 'at';
  let candidates: readonly EditBoundary[];
  let evidence: TargetEvidence;

  if (query.anchor === 'selection') {
    candidates = selectedBoundary(boundaries, context, relation);
    evidence = 'selected_edit_point';
  } else {
    const tolerance = frameToSeconds(query.toleranceFrames ?? 1, project.fps);
    if (relation === 'before') {
      const before = boundaries.filter((boundary) => boundary.at <= context.playhead.seconds);
      const latest = before.reduce<EditBoundary | undefined>(
        (best, boundary) => (!best || boundary.at > best.at ? boundary : best),
        undefined,
      );
      candidates = latest ? before.filter((boundary) => boundary.at === latest.at) : [];
    } else if (relation === 'after') {
      const after = boundaries.filter((boundary) => boundary.at >= context.playhead.seconds);
      const earliest = after.reduce<EditBoundary | undefined>(
        (best, boundary) => (!best || boundary.at < best.at ? boundary : best),
        undefined,
      );
      candidates = earliest ? after.filter((boundary) => boundary.at === earliest.at) : [];
    } else {
      candidates = boundaries.filter(
        (boundary) => Math.abs(boundary.at - context.playhead.seconds) <= tolerance,
      );
    }
    evidence = 'playhead';
  }

  if (candidates.length === 0) {
    return unresolved('no_edit_point', 'No matching edit point could be resolved.');
  }
  if (candidates.length > 1 && context.selection.primaryClipId) {
    const selectedCandidates = candidates.filter(
      (boundary) =>
        boundary.fromClipId === context.selection.primaryClipId ||
        boundary.toClipId === context.selection.primaryClipId,
    );
    if (selectedCandidates.length === 1) {
      candidates = selectedCandidates;
      evidence = 'selected_edit_point';
    }
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      reason: 'multiple_edit_points',
      candidateIds: candidates.map(
        (boundary) => `${boundary.trackId}:${boundary.fromClipId}->${boundary.toClipId}`,
      ),
    };
  }
  return { status: 'resolved', evidence, target: { kind: 'edit_point', boundary: candidates[0]! } };
}

function linkedBoundaryCandidates(
  project: Project,
  context: EditorInteractionContext,
  query: Extract<TargetQuery, { kind: 'linked_edit_point' }>,
): readonly EditBoundary[] {
  const boundaries = listEditBoundaries(project.timeline, project.assets);
  const relation = query.relation ?? 'at';
  if (query.anchor === 'selection') {
    const selected = selectedBoundary(boundaries, context, relation);
    const selectedTimes = new Set(selected.map((boundary) => boundary.at));
    return boundaries.filter((boundary) => selectedTimes.has(boundary.at));
  }
  const tolerance = frameToSeconds(query.toleranceFrames ?? 1, project.fps);
  if (relation === 'at') {
    return boundaries.filter(
      (boundary) => Math.abs(boundary.at - context.playhead.seconds) <= tolerance,
    );
  }
  const onSide = boundaries.filter((boundary) =>
    relation === 'before'
      ? boundary.at <= context.playhead.seconds
      : boundary.at >= context.playhead.seconds,
  );
  const nearest = onSide.reduce<number | undefined>((best, boundary) => {
    if (best === undefined) return boundary.at;
    return relation === 'before' ? Math.max(best, boundary.at) : Math.min(best, boundary.at);
  }, undefined);
  return nearest === undefined ? [] : onSide.filter((boundary) => boundary.at === nearest);
}

function resolveLinkedEditPoint(
  project: Project,
  context: EditorInteractionContext,
  query: Extract<TargetQuery, { kind: 'linked_edit_point' }>,
): TargetResolution {
  const candidates = linkedBoundaryCandidates(project, context, query);
  const tracks = new Map(project.timeline.tracks.map((track) => [track.id, track] as const));
  const clips = clipsById(project);
  const video = candidates.filter((boundary) => tracks.get(boundary.trackId)?.type === 'video');
  const audio = candidates.filter((boundary) => tracks.get(boundary.trackId)?.type === 'audio');
  const pairs = video.flatMap((videoBoundary) =>
    audio
      .filter((audioBoundary) => {
        const videoOut = clips.get(videoBoundary.fromClipId);
        const videoIn = clips.get(videoBoundary.toClipId);
        const audioOut = clips.get(audioBoundary.fromClipId);
        const audioIn = clips.get(audioBoundary.toClipId);
        return (
          videoOut !== undefined &&
          videoIn !== undefined &&
          audioOut !== undefined &&
          audioIn !== undefined &&
          Math.abs(videoBoundary.at - audioBoundary.at) <= 1e-6 &&
          videoOut.assetId === audioOut.assetId &&
          videoIn.assetId === audioIn.assetId
        );
      })
      .map((audioBoundary) => ({ videoBoundary, audioBoundary })),
  );
  if (pairs.length === 0) {
    return unresolved(
      'no_linked_edit_point',
      'No aligned picture/sound edit with matching outgoing and incoming source assets was resolved.',
    );
  }
  if (pairs.length > 1) {
    return {
      status: 'ambiguous',
      reason: 'multiple_linked_edit_points',
      candidateIds: pairs.map(
        ({ videoBoundary, audioBoundary }) =>
          `${videoBoundary.trackId}:${videoBoundary.fromClipId}->${videoBoundary.toClipId}+${audioBoundary.trackId}:${audioBoundary.fromClipId}->${audioBoundary.toClipId}`,
      ),
    };
  }
  return {
    status: 'resolved',
    evidence: 'linked_edit_point',
    target: { kind: 'linked_edit_point', ...pairs[0]! },
  };
}

/** Resolve an editor target without model inference or fallback guessing. */
export function resolveEditorTarget(
  project: Project,
  context: EditorInteractionContext,
  query: TargetQuery,
  options: ResolveEditorTargetOptions = {},
): TargetResolution {
  const invalid = validateContext(project, context, options);
  if (invalid) return invalid;
  switch (query.kind) {
    case 'clips':
      return resolveClips(project, context, query);
    case 'edit_point':
      return resolveEditPoint(project, context, query);
    case 'linked_edit_point':
      return resolveLinkedEditPoint(project, context, query);
    case 'tracks':
      return resolveTracks(project, context, query);
    case 'range':
      return resolveRange(context, query);
  }
}
