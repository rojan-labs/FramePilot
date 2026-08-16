/** Professional timeline objectives resolved into editor-core commands. */
import { z } from 'zod/v4';
import { listEditBoundaries, type EditBoundary, type EditorCommand } from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import type { Clip, Project, Track } from '@framepilot/timeline-schema';
import type { EditorInteractionContext } from '../editor-context/interaction-context.js';
import {
  resolveEditorTarget,
  type ResolvedEditorTarget,
  type TargetEvidence,
  type TargetQuery,
  type TargetResolution,
} from '../editor-context/target-resolver.js';
import { rationalFrameRate } from '../frame-time.js';

const log = createLogger('ai-sdk:controllers:timeline');
const TIME_EPSILON = 1e-6;

const nonZeroFrames = z
  .number()
  .int()
  .refine((value) => value !== 0, { message: 'frames must move at least one frame' });

export const TIMELINE_EDIT_INTENTS = [
  'roll',
  'slip',
  'ripple_trim',
  'slide',
  'lift',
  'extract',
  'insert',
  'overwrite',
  'replace',
  'j_cut',
  'l_cut',
  'switch_angle',
] as const;

/**
 * Model-facing objective.
 *
 * `cameraAngleId` names a camera in an authored angle group (schema v18) and belongs
 * only to `switch_angle`; the compiler derives which angle a clip currently shows from
 * the media it plays, so the model never asserts membership.
 */
export const TimelineEditObjectiveSchema = z
  .object({
    command: z.enum(TIMELINE_EDIT_INTENTS),
    frames: nonZeroFrames.optional(),
    anchor: z.enum(['playhead', 'selection']).optional(),
    relation: z.enum(['at', 'before', 'after']).optional(),
    edge: z.enum(['start', 'end']).optional(),
    target: z.enum(['this', 'these', 'playhead']).optional(),
    syncPolicy: z.enum(['preserve', 'allow_desync']).default('preserve'),
    cameraAngleId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((objective, refinement) => {
    if (
      ['roll', 'slip', 'ripple_trim', 'slide', 'j_cut', 'l_cut'].includes(objective.command) &&
      objective.frames === undefined
    ) {
      refinement.addIssue({ code: 'custom', path: ['frames'], message: 'frames is required' });
    }
    if (
      ['j_cut', 'l_cut'].includes(objective.command) &&
      objective.frames !== undefined &&
      objective.frames <= 0
    ) {
      refinement.addIssue({
        code: 'custom',
        path: ['frames'],
        message: 'J/L cut frames must be a positive magnitude',
      });
    }
    if (objective.command === 'ripple_trim' && objective.edge === undefined) {
      refinement.addIssue({ code: 'custom', path: ['edge'], message: 'edge is required' });
    }
    if (objective.command === 'ripple_trim' && objective.target === 'these') {
      refinement.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'ripple_trim targets one clip, not these',
      });
    }
    if (objective.command === 'switch_angle' && objective.cameraAngleId === undefined) {
      refinement.addIssue({
        code: 'custom',
        path: ['cameraAngleId'],
        message: 'switch_angle requires the camera angle to cut to',
      });
    }
    if (objective.command !== 'switch_angle' && objective.cameraAngleId !== undefined) {
      refinement.addIssue({
        code: 'custom',
        path: ['cameraAngleId'],
        message: 'cameraAngleId applies only to switch_angle',
      });
    }
    if (objective.command === 'switch_angle' && objective.target === 'these') {
      refinement.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'switch_angle cuts one clip, not these',
      });
    }
  });

export type TimelineEditObjective = z.infer<typeof TimelineEditObjectiveSchema>;

export type TimelineControllerRejectionCode =
  | 'target_unresolved'
  | 'target_ambiguous'
  | 'source_state_missing'
  | 'source_asset_mismatch'
  | 'linked_target_ambiguous'
  | 'linked_media_mismatch';

export interface TimelineControllerFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type TimelineControllerResult =
  | {
      readonly status: 'resolved';
      readonly objective: TimelineEditObjective;
      readonly commands: readonly EditorCommand[];
      readonly evidence: readonly TargetEvidence[];
      readonly facts: readonly TimelineControllerFact[];
    }
  | {
      readonly status: 'rejected';
      readonly objective: TimelineEditObjective;
      readonly code: TimelineControllerRejectionCode;
      readonly detail: string;
      readonly facts: readonly TimelineControllerFact[];
    };

type TimelineControllerRejection = Extract<TimelineControllerResult, { status: 'rejected' }>;

export interface ResolveTimelineObjectiveInput {
  readonly project: Project;
  readonly projectRevision?: number;
  readonly interaction: EditorInteractionContext;
  readonly objective: TimelineEditObjective;
}

interface ClipLocation {
  readonly clip: Clip;
  readonly track: Track;
}

type MutableResolutionState = {
  readonly evidence: TargetEvidence[];
  readonly facts: TimelineControllerFact[];
};

function rejected(
  objective: TimelineEditObjective,
  code: TimelineControllerRejectionCode,
  detail: string,
  facts: readonly TimelineControllerFact[] = [],
): TimelineControllerRejection {
  log.warn('Timeline objective rejected', { command: objective.command, code });
  return { status: 'rejected', objective, code, detail, facts };
}

function framesFor(objective: TimelineEditObjective): number {
  if (objective.frames === undefined) throw new Error(`${objective.command} requires frames.`);
  return objective.frames;
}

function clipLocation(project: Project, clipId: string): ClipLocation | undefined {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { clip, track };
  }
  return undefined;
}

function describeResolution(resolution: Exclude<TargetResolution, { status: 'resolved' }>): string {
  return resolution.status === 'ambiguous'
    ? `${resolution.reason}: ${resolution.candidateIds.join(', ')}`
    : `${resolution.reason}: ${resolution.detail}`;
}

function target(
  input: ResolveTimelineObjectiveInput,
  state: MutableResolutionState,
  query: TargetQuery,
): ResolvedEditorTarget | TimelineControllerRejection {
  const resolution = resolveEditorTarget(input.project, input.interaction, query, {
    projectRevision: input.projectRevision ?? input.interaction.projectRevision,
  });
  if (resolution.status !== 'resolved') {
    return rejected(
      input.objective,
      resolution.status === 'ambiguous' ? 'target_ambiguous' : 'target_unresolved',
      describeResolution(resolution),
      state.facts,
    );
  }
  state.evidence.push(resolution.evidence);
  return resolution.target;
}

function sameTime(left: number, right: number): boolean {
  return Math.abs(left - right) <= TIME_EPSILON;
}

/**
 * Infer an A/V companion only from exact sequence and source alignment plus a shared
 * asset. If more than one clip fits, authority is ambiguous and the edit stops.
 */
function linkedCompanion(
  project: Project,
  location: ClipLocation,
): ClipLocation | undefined | 'ambiguous' {
  const candidates = project.timeline.tracks.flatMap((track) =>
    track.type === location.track.type
      ? []
      : track.clips
          .filter(
            (clip) =>
              clip.assetId === location.clip.assetId &&
              sameTime(clip.start, location.clip.start) &&
              sameTime(clip.end, location.clip.end) &&
              sameTime(clip.sourceStart, location.clip.sourceStart) &&
              sameTime(clip.sourceEnd, location.clip.sourceEnd),
          )
          .map((clip) => ({ clip, track })),
  );
  if (candidates.length > 1) return 'ambiguous';
  return candidates[0];
}

function linkedBoundary(
  project: Project,
  boundary: EditBoundary,
): EditBoundary | undefined | 'ambiguous' {
  const outgoing = clipLocation(project, boundary.fromClipId);
  const incoming = clipLocation(project, boundary.toClipId);
  if (!outgoing || !incoming) return undefined;
  const candidates = listEditBoundaries(project.timeline, project.assets).filter((candidate) => {
    if (candidate.trackId === boundary.trackId || !sameTime(candidate.at, boundary.at))
      return false;
    const candidateOutgoing = clipLocation(project, candidate.fromClipId);
    const candidateIncoming = clipLocation(project, candidate.toClipId);
    return (
      candidateOutgoing !== undefined &&
      candidateIncoming !== undefined &&
      candidateOutgoing.track.type !== outgoing.track.type &&
      candidateOutgoing.clip.assetId === outgoing.clip.assetId &&
      candidateIncoming.clip.assetId === incoming.clip.assetId
    );
  });
  if (candidates.length > 1) return 'ambiguous';
  return candidates[0];
}

function selectedClip(
  input: ResolveTimelineObjectiveInput,
  state: MutableResolutionState,
  referent: 'this' | 'playhead',
): ClipLocation | TimelineControllerRejection {
  const resolved = target(input, state, { kind: 'clips', referent });
  if ('status' in resolved) return resolved;
  if (resolved.kind !== 'clips' || resolved.clipIds.length !== 1) {
    return rejected(
      input.objective,
      'target_ambiguous',
      'Timeline objective requires exactly one clip target.',
      state.facts,
    );
  }
  const location = clipLocation(input.project, resolved.clipIds[0]!);
  return (
    location ??
    rejected(
      input.objective,
      'target_unresolved',
      `Resolved clip "${resolved.clipIds[0]}" no longer exists.`,
      state.facts,
    )
  );
}

function locationsPreservingSync(
  input: ResolveTimelineObjectiveInput,
  state: MutableResolutionState,
  primary: ClipLocation,
): readonly ClipLocation[] | TimelineControllerRejection {
  if (input.objective.syncPolicy === 'allow_desync') return [primary];
  const companion = linkedCompanion(input.project, primary);
  if (companion === 'ambiguous') {
    return rejected(
      input.objective,
      'linked_target_ambiguous',
      `More than one aligned A/V companion matches clip "${primary.clip.id}".`,
      state.facts,
    );
  }
  if (!companion) return [primary];
  state.facts.push({ name: 'linkedCompanionClipId', value: companion.clip.id });
  return [primary, companion];
}

function neighbours(location: ClipLocation): { previous: Clip; next: Clip } | undefined {
  const ordered = [...location.track.clips].sort(
    (left, right) => left.start - right.start || left.id.localeCompare(right.id),
  );
  const index = ordered.findIndex((clip) => clip.id === location.clip.id);
  const previous = ordered[index - 1];
  const next = ordered[index + 1];
  return previous && next ? { previous, next } : undefined;
}

function sourceMonitor(input: ResolveTimelineObjectiveInput) {
  return input.interaction.sourceMonitor;
}

function resolveCommands(
  input: ResolveTimelineObjectiveInput,
  state: MutableResolutionState,
): readonly EditorCommand[] | TimelineControllerRejection {
  const { objective, project, interaction } = input;
  const timelineRevision = interaction.timelineRevision;
  const rate = rationalFrameRate(project.fps);

  if (objective.command === 'roll') {
    const resolved = target(input, state, {
      kind: 'edit_point',
      anchor: objective.anchor ?? 'playhead',
      relation: objective.relation ?? 'at',
    });
    if ('status' in resolved) return resolved;
    if (resolved.kind !== 'edit_point') {
      return rejected(objective, 'target_unresolved', 'Roll requires an edit point.', state.facts);
    }
    const boundaries = [resolved.boundary];
    if (objective.syncPolicy === 'preserve') {
      const companion = linkedBoundary(project, resolved.boundary);
      if (companion === 'ambiguous') {
        return rejected(
          objective,
          'linked_target_ambiguous',
          'More than one aligned A/V edit point matches the resolved roll boundary.',
          state.facts,
        );
      }
      if (companion) {
        boundaries.push(companion);
        state.facts.push({ name: 'linkedBoundaryPreserved', value: true });
      }
    }
    const delta = { domain: 'sequence' as const, frames: framesFor(objective), rate };
    return boundaries.map((boundary) => ({
      type: 'roll_edit',
      timelineRevision,
      outgoingClipId: boundary.fromClipId,
      incomingClipId: boundary.toClipId,
      delta,
    }));
  }

  if (objective.command === 'j_cut' || objective.command === 'l_cut') {
    const resolved = target(input, state, {
      kind: 'linked_edit_point',
      anchor: objective.anchor ?? 'playhead',
      relation: objective.relation ?? 'at',
    });
    if ('status' in resolved) return resolved;
    if (resolved.kind !== 'linked_edit_point') {
      return rejected(
        objective,
        'target_unresolved',
        'J/L cut requires linked media.',
        state.facts,
      );
    }
    return [
      {
        type: objective.command === 'j_cut' ? 'j_cut_edit' : 'l_cut_edit',
        timelineRevision,
        videoOutgoingClipId: resolved.videoBoundary.fromClipId,
        videoIncomingClipId: resolved.videoBoundary.toClipId,
        audioOutgoingClipId: resolved.audioBoundary.fromClipId,
        audioIncomingClipId: resolved.audioBoundary.toClipId,
        delta: { domain: 'sequence', frames: framesFor(objective), rate },
      },
    ];
  }

  if (objective.command === 'insert' || objective.command === 'overwrite') {
    const monitor = sourceMonitor(input);
    if (!monitor) {
      return rejected(objective, 'source_state_missing', 'An active source monitor is required.');
    }
    if (!monitor.markedRange) {
      return rejected(
        objective,
        'source_state_missing',
        'source in and out marks are required for insert/overwrite.',
      );
    }
    const resolved = target(input, state, { kind: 'tracks', referent: 'selected' });
    if ('status' in resolved) return resolved;
    if (resolved.kind !== 'tracks' || resolved.trackIds.length !== 1) {
      return rejected(
        objective,
        'target_ambiguous',
        'Insert/overwrite requires exactly one selected destination track.',
        state.facts,
      );
    }
    state.facts.push(
      { name: 'sourceAssetId', value: monitor.assetId },
      { name: 'destinationTrackId', value: resolved.trackIds[0]! },
      { name: 'sequenceFrame', value: interaction.playhead.frame },
    );
    return [
      {
        type: objective.command === 'insert' ? 'insert_edit' : 'overwrite_edit',
        timelineRevision,
        trackId: resolved.trackIds[0]!,
        assetId: monitor.assetId,
        at: { domain: 'sequence', frame: interaction.playhead.frame, rate },
        sourceRange: {
          domain: 'source',
          startFrame: monitor.markedRange.startFrame,
          endFrame: monitor.markedRange.endFrame,
          rate: monitor.rate,
        },
      },
    ];
  }

  if (objective.command === 'lift' || objective.command === 'extract') {
    const resolved = target(input, state, {
      kind: 'clips',
      referent: objective.target ?? 'these',
    });
    if ('status' in resolved) return resolved;
    if (resolved.kind !== 'clips') {
      return rejected(
        objective,
        'target_unresolved',
        'Removal requires clip targets.',
        state.facts,
      );
    }
    const ids = new Set(resolved.clipIds);
    if (objective.syncPolicy === 'preserve') {
      for (const id of resolved.clipIds) {
        const location = clipLocation(project, id);
        if (!location) continue;
        const companion = linkedCompanion(project, location);
        if (companion === 'ambiguous') {
          return rejected(
            objective,
            'linked_target_ambiguous',
            `More than one aligned A/V companion matches clip "${id}".`,
            state.facts,
          );
        }
        if (companion) ids.add(companion.clip.id);
      }
    }
    state.facts.push({ name: 'targetClipCount', value: ids.size });
    return [
      {
        type: objective.command === 'lift' ? 'lift_edit' : 'extract_edit',
        timelineRevision,
        clipIds: [...ids],
      },
    ];
  }

  // A camera switch happens AT the playhead, so the clip it applies to is the clip
  // the playhead is over unless the editor named a different referent.
  const defaultReferent = objective.command === 'switch_angle' ? 'playhead' : 'this';
  const primary = selectedClip(
    input,
    state,
    objective.target === undefined
      ? defaultReferent
      : objective.target === 'playhead'
        ? 'playhead'
        : 'this',
  );
  if ('status' in primary) return primary;

  if (objective.command === 'switch_angle') {
    // Picture only. The sound bed keeps playing from whatever it was cut from, which
    // is what stops every camera change from also being an audible jump in room tone —
    // and because no edit point moves in time, nothing goes out of A/V sync.
    state.facts.push(
      { name: 'switchClipId', value: primary.clip.id },
      { name: 'sequenceFrame', value: interaction.playhead.frame },
      { name: 'soundUntouched', value: true },
    );
    return [
      {
        type: 'switch_angle_edit',
        timelineRevision,
        clipId: primary.clip.id,
        targetAngleId: objective.cameraAngleId!,
        at: { domain: 'sequence', frame: interaction.playhead.frame, rate },
      },
    ];
  }

  const locations = locationsPreservingSync(input, state, primary);
  if ('status' in locations) return locations;

  if (objective.command === 'slip') {
    const monitor = sourceMonitor(input);
    if (!monitor) {
      return rejected(objective, 'source_state_missing', 'An active source monitor is required.');
    }
    if (monitor.assetId !== primary.clip.assetId) {
      return rejected(
        objective,
        'source_asset_mismatch',
        'The selected clip asset must be loaded in the source monitor for a slip edit.',
        state.facts,
      );
    }
    return locations.map((location) => ({
      type: 'slip_edit',
      timelineRevision,
      clipId: location.clip.id,
      delta: { domain: 'source', frames: framesFor(objective), rate: monitor.rate },
    }));
  }

  if (objective.command === 'ripple_trim') {
    return locations.map((location) => ({
      type: 'ripple_trim_edit',
      timelineRevision,
      clipId: location.clip.id,
      edge: objective.edge!,
      delta: { domain: 'sequence', frames: framesFor(objective), rate },
    }));
  }

  if (objective.command === 'slide') {
    const commands: EditorCommand[] = [];
    for (const location of locations) {
      const adjacent = neighbours(location);
      if (!adjacent) {
        return rejected(
          objective,
          'target_unresolved',
          `Slide target "${location.clip.id}" requires two neighbours.`,
          state.facts,
        );
      }
      if (
        location.clip.id !== primary.clip.id &&
        (adjacent.previous.assetId !== neighbours(primary)?.previous.assetId ||
          adjacent.next.assetId !== neighbours(primary)?.next.assetId)
      ) {
        return rejected(
          objective,
          'linked_media_mismatch',
          'The linked slide target does not share aligned neighbouring source assets.',
          state.facts,
        );
      }
      commands.push({
        type: 'slide_edit',
        timelineRevision,
        previousClipId: adjacent.previous.id,
        clipId: location.clip.id,
        nextClipId: adjacent.next.id,
        delta: { domain: 'sequence', frames: framesFor(objective), rate },
      });
    }
    return commands;
  }

  const monitor = sourceMonitor(input);
  if (!monitor) {
    return rejected(objective, 'source_state_missing', 'An active source monitor is required.');
  }
  return locations.map((location) => ({
    type: 'replace_edit',
    timelineRevision,
    clipId: location.clip.id,
    assetId: monitor.assetId,
    sourceIn: { domain: 'source', frame: monitor.playhead.frame, rate: monitor.rate },
  }));
}

/** Resolve a professional timeline objective without emitting primitive operations. */
export function resolveTimelineObjective(
  input: ResolveTimelineObjectiveInput,
): TimelineControllerResult {
  const state: MutableResolutionState = { evidence: [], facts: [] };
  const commands = resolveCommands(input, state);
  if ('status' in commands) return commands;
  const result: TimelineControllerResult = {
    status: 'resolved',
    objective: input.objective,
    commands,
    evidence: [...new Set(state.evidence)],
    facts: [
      ...state.facts,
      { name: 'syncPolicy', value: input.objective.syncPolicy },
      { name: 'commandCount', value: commands.length },
    ],
  };
  log.action('Timeline objective resolved', {
    command: input.objective.command,
    commandCount: commands.length,
    syncPolicy: input.objective.syncPolicy,
  });
  return result;
}
