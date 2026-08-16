/** Executable outcome evals for the twelve professional timeline commands. */
import {
  compileEditorCommand,
  invertPatch,
  type Patch,
  type CommandFrameRate,
  type EditorCommand,
} from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { captureEditorInteractionContext } from './editor-context/interaction-context.js';
import {
  TimelineEditObjectiveSchema,
  resolveTimelineObjective,
  type TimelineEditObjective,
} from './controllers/timeline-controller.js';
import {
  outcomeIssues,
  type ProfessionalEvalCase,
  type ProfessionalEvalCompilation,
  type ProfessionalEvalFixture,
} from './professional-eval-runner.js';

const RATE: CommandFrameRate = { numerator: 30, denominator: 1 };

/** Linked picture/sound fixture with adjacent clips and spare handles for every command. */
function timelineEvalProject(includeLiftCover = false): Project {
  const clip = (id: string, trackId: string, start: number, end: number) => ({
    id,
    assetId: `${id.replace('_audio', '')}_asset`,
    trackId,
    start,
    end,
    sourceStart: 5,
    sourceEnd: 5 + end - start,
    effects: [],
    keyframes: [],
  });
  return parseProject({
    id: 'professional_timeline_eval',
    name: 'Professional timeline eval',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      'previous',
      'selected',
      'next',
      'replacement',
      'cam_b',
      ...(includeLiftCover ? ['lift_cover'] : []),
    ].map((id) => ({
      id: `${id}_asset`,
      path: `${id}.mp4`,
      kind: 'video',
      durationSeconds: 40,
    })),
    // `selected` doubles as the wide angle of a two-camera group, so the switch eval
    // has authored sync to compile against rather than an assumed common start.
    angleGroups: [
      {
        id: 'grp',
        angles: [
          { id: 'wide', assetId: 'selected_asset', syncOffsetSeconds: 0 },
          { id: 'tight', assetId: 'cam_b_asset', syncOffsetSeconds: 2 },
        ],
      },
    ],
    timeline: {
      revision: 0,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            clip('previous', 'v1', 0, 10),
            clip('selected', 'v1', 10, 20),
            clip('next', 'v1', 20, 30),
          ],
        },
        {
          id: 'a1',
          type: 'audio',
          clips: [
            clip('previous_audio', 'a1', 0, 10),
            clip('selected_audio', 'a1', 10, 20),
            clip('next_audio', 'a1', 20, 30),
          ],
        },
        ...(includeLiftCover
          ? [
              {
                id: 'v2',
                type: 'video' as const,
                clips: [clip('lift_cover', 'v2', 0, 30)],
              },
            ]
          : []),
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

interface TimelineEvalSpec {
  readonly fixtureId: string;
  readonly capabilityId: string;
  readonly command: EditorCommand;
  readonly playheadSeconds: number;
  readonly expectOutcome: (persisted: Project) => readonly string[];
}

function videoClips(project: Project) {
  return project.timeline.tracks[0]!.clips;
}

function audioClips(project: Project) {
  return project.timeline.tracks[1]!.clips;
}

const SPECS: readonly TimelineEvalSpec[] = [
  {
    fixtureId: 'timeline.roll.outcome',
    capabilityId: 'timeline.roll',
    command: {
      type: 'roll_edit',
      timelineRevision: 0,
      outgoingClipId: 'previous',
      incomingClipId: 'selected',
      delta: { domain: 'sequence', frames: 2, rate: RATE },
    },
    playheadSeconds: 10,
    // A roll moves only the shared cut: both clips change, the sequence duration does not.
    expectOutcome: (persisted) =>
      outcomeIssues([
        { label: 'previous.end', actual: videoClips(persisted)[0]!.end, expected: 10 + 2 / 30 },
        { label: 'selected.start', actual: videoClips(persisted)[1]!.start, expected: 10 + 2 / 30 },
        { label: 'selected.end', actual: videoClips(persisted)[1]!.end, expected: 20 },
      ]),
  },
  {
    fixtureId: 'timeline.slip.outcome',
    capabilityId: 'timeline.slip',
    command: {
      type: 'slip_edit',
      timelineRevision: 0,
      clipId: 'selected',
      delta: { domain: 'source', frames: 3, rate: { numerator: 24, denominator: 1 } },
    },
    playheadSeconds: 15,
    // A slip shifts source content only; timeline placement must not move.
    expectOutcome: (persisted) =>
      outcomeIssues([
        { label: 'selected.start', actual: videoClips(persisted)[1]!.start, expected: 10 },
        { label: 'selected.end', actual: videoClips(persisted)[1]!.end, expected: 20 },
        {
          label: 'selected.sourceStart',
          actual: videoClips(persisted)[1]!.sourceStart,
          expected: 5.125,
        },
      ]),
  },
  {
    fixtureId: 'timeline.slide.outcome',
    capabilityId: 'timeline.slide',
    command: {
      type: 'slide_edit',
      timelineRevision: 0,
      previousClipId: 'previous',
      clipId: 'selected',
      nextClipId: 'next',
      delta: { domain: 'sequence', frames: 3, rate: RATE },
    },
    playheadSeconds: 15,
    // A slide moves the clip and absorbs the change into its neighbours.
    expectOutcome: (persisted) =>
      outcomeIssues([
        { label: 'selected.start', actual: videoClips(persisted)[1]!.start, expected: 10.1 },
        { label: 'previous.end', actual: videoClips(persisted)[0]!.end, expected: 10.1 },
        { label: 'next.start', actual: videoClips(persisted)[2]!.start, expected: 20.1 },
      ]),
  },
  {
    fixtureId: 'timeline.ripple-trim.outcome',
    capabilityId: 'timeline.ripple_trim',
    command: {
      type: 'ripple_trim_edit',
      timelineRevision: 0,
      clipId: 'selected',
      edge: 'start',
      delta: { domain: 'sequence', frames: 30, rate: RATE },
    },
    playheadSeconds: 15,
    // A ripple trim shortens the clip and pulls every downstream clip up by the same amount.
    expectOutcome: (persisted) =>
      outcomeIssues([
        { label: 'next.start', actual: videoClips(persisted)[2]!.start, expected: 19 },
      ]),
  },
  {
    fixtureId: 'timeline.lift.outcome',
    capabilityId: 'timeline.lift',
    command: { type: 'lift_edit', timelineRevision: 0, clipIds: ['selected'] },
    playheadSeconds: 15,
    // A lift leaves a gap: the following clip keeps its original position.
    expectOutcome: (persisted) =>
      outcomeIssues([
        {
          label: 'video clip ids',
          actual: videoClips(persisted).map((clip) => clip.id),
          expected: ['previous', 'next'],
        },
        { label: 'next.start', actual: videoClips(persisted)[1]!.start, expected: 20 },
      ]),
  },
  {
    fixtureId: 'timeline.extract.outcome',
    capabilityId: 'timeline.extract',
    command: { type: 'extract_edit', timelineRevision: 0, clipIds: ['selected'] },
    playheadSeconds: 15,
    // An extract closes the gap: the following clip moves up to the cut.
    expectOutcome: (persisted) =>
      outcomeIssues([
        {
          label: 'video clip ids',
          actual: videoClips(persisted).map((clip) => clip.id),
          expected: ['previous', 'next'],
        },
        { label: 'next.start', actual: videoClips(persisted)[1]!.start, expected: 10 },
      ]),
  },
  {
    fixtureId: 'timeline.insert.outcome',
    capabilityId: 'timeline.insert',
    command: {
      type: 'insert_edit',
      timelineRevision: 0,
      trackId: 'v1',
      assetId: 'replacement_asset',
      at: { domain: 'sequence', frame: 450, rate: RATE },
      sourceRange: { domain: 'source', startFrame: 30, endFrame: 90, rate: RATE },
    },
    playheadSeconds: 15,
    // An insert pushes everything downstream later by the inserted duration (2s).
    expectOutcome: (persisted) =>
      outcomeIssues([
        {
          label: 'inserted asset present',
          actual: videoClips(persisted).some((clip) => clip.assetId === 'replacement_asset'),
          expected: true,
        },
        { label: 'sequence end', actual: videoClips(persisted).at(-1)!.end, expected: 32 },
      ]),
  },
  {
    fixtureId: 'timeline.overwrite.outcome',
    capabilityId: 'timeline.overwrite',
    command: {
      type: 'overwrite_edit',
      timelineRevision: 0,
      trackId: 'v1',
      assetId: 'replacement_asset',
      at: { domain: 'sequence', frame: 450, rate: RATE },
      sourceRange: { domain: 'source', startFrame: 30, endFrame: 90, rate: RATE },
    },
    playheadSeconds: 15,
    // An overwrite consumes existing material instead of extending the sequence.
    expectOutcome: (persisted) =>
      outcomeIssues([
        {
          label: 'inserted asset present',
          actual: videoClips(persisted).some((clip) => clip.assetId === 'replacement_asset'),
          expected: true,
        },
        { label: 'sequence end', actual: videoClips(persisted).at(-1)!.end, expected: 30 },
      ]),
  },
  {
    fixtureId: 'timeline.replace.outcome',
    capabilityId: 'timeline.replace',
    command: {
      type: 'replace_edit',
      timelineRevision: 0,
      clipId: 'selected',
      assetId: 'replacement_asset',
      sourceIn: { domain: 'source', frame: 90, rate: RATE },
    },
    playheadSeconds: 15,
    // A replace swaps media while preserving the clip's timeline placement exactly.
    expectOutcome: (persisted) =>
      outcomeIssues([
        {
          label: 'selected.assetId',
          actual: videoClips(persisted)[1]!.assetId,
          expected: 'replacement_asset',
        },
        { label: 'selected.start', actual: videoClips(persisted)[1]!.start, expected: 10 },
        { label: 'selected.end', actual: videoClips(persisted)[1]!.end, expected: 20 },
      ]),
  },
  {
    fixtureId: 'timeline.j-cut.outcome',
    capabilityId: 'timeline.j_cut',
    command: {
      type: 'j_cut_edit',
      timelineRevision: 0,
      videoOutgoingClipId: 'previous',
      videoIncomingClipId: 'selected',
      audioOutgoingClipId: 'previous_audio',
      audioIncomingClipId: 'selected_audio',
      delta: { domain: 'sequence', frames: 15, rate: RATE },
    },
    playheadSeconds: 10,
    // A J-cut brings the next sound in early while the picture cut stays put.
    expectOutcome: (persisted) =>
      outcomeIssues([
        { label: 'previous_audio.end', actual: audioClips(persisted)[0]!.end, expected: 9.5 },
        { label: 'selected_audio.start', actual: audioClips(persisted)[1]!.start, expected: 9.5 },
        { label: 'picture cut unmoved', actual: videoClips(persisted)[0]!.end, expected: 10 },
      ]),
  },
  {
    fixtureId: 'timeline.l-cut.outcome',
    capabilityId: 'timeline.l_cut',
    command: {
      type: 'l_cut_edit',
      timelineRevision: 0,
      videoOutgoingClipId: 'previous',
      videoIncomingClipId: 'selected',
      audioOutgoingClipId: 'previous_audio',
      audioIncomingClipId: 'selected_audio',
      delta: { domain: 'sequence', frames: 15, rate: RATE },
    },
    playheadSeconds: 10,
    // An L-cut holds the outgoing sound past the picture cut.
    expectOutcome: (persisted) =>
      outcomeIssues([
        { label: 'previous_audio.end', actual: audioClips(persisted)[0]!.end, expected: 10.5 },
        { label: 'selected_audio.start', actual: audioClips(persisted)[1]!.start, expected: 10.5 },
        { label: 'picture cut unmoved', actual: videoClips(persisted)[0]!.end, expected: 10 },
      ]),
  },
  {
    fixtureId: 'timeline.switch-angle.outcome',
    capabilityId: 'timeline.switch_angle',
    command: {
      type: 'switch_angle_edit',
      timelineRevision: 0,
      clipId: 'selected',
      targetAngleId: 'tight',
      at: { domain: 'sequence', frame: 450, rate: RATE },
    },
    playheadSeconds: 15,
    // A camera switch cuts the shot at the playhead and puts the second half on the
    // other camera at the SAME instant — 12s into camera B, which is 10s of group
    // time plus camera B's 2s offset — while sound and neighbours stay untouched.
    expectOutcome: (persisted) =>
      outcomeIssues([
        { label: 'selected.end', actual: videoClips(persisted)[1]!.end, expected: 15 },
        {
          label: 'selected.assetId',
          actual: videoClips(persisted)[1]!.assetId,
          expected: 'selected_asset',
        },
        { label: 'incoming.start', actual: videoClips(persisted)[2]!.start, expected: 15 },
        { label: 'incoming.end', actual: videoClips(persisted)[2]!.end, expected: 20 },
        {
          label: 'incoming.assetId',
          actual: videoClips(persisted)[2]!.assetId,
          expected: 'cam_b_asset',
        },
        {
          label: 'incoming.sourceStart',
          actual: videoClips(persisted)[2]!.sourceStart,
          expected: 12,
        },
        { label: 'sound untouched', actual: audioClips(persisted)[1]!.end, expected: 20 },
      ]),
  },
];

function objectiveFor(spec: TimelineEvalSpec): TimelineEditObjective {
  const values: Readonly<Record<string, unknown>> =
    spec.capabilityId === 'timeline.roll'
      ? { command: 'roll', frames: 2 }
      : spec.capabilityId === 'timeline.slip'
        ? { command: 'slip', frames: 3 }
        : spec.capabilityId === 'timeline.slide'
          ? { command: 'slide', frames: 3 }
          : spec.capabilityId === 'timeline.ripple_trim'
            ? { command: 'ripple_trim', frames: 30, edge: 'start' }
            : spec.capabilityId === 'timeline.j_cut'
              ? { command: 'j_cut', frames: 15 }
              : spec.capabilityId === 'timeline.l_cut'
                ? { command: 'l_cut', frames: 15 }
                : spec.capabilityId === 'timeline.switch_angle'
                  ? { command: 'switch_angle', cameraAngleId: 'tight' }
                  : spec.capabilityId === 'timeline.lift'
                    ? { command: 'lift', target: 'this' }
                    : spec.capabilityId === 'timeline.extract'
                      ? { command: 'extract', target: 'this' }
                      : spec.capabilityId === 'timeline.insert'
                        ? { command: 'insert' }
                        : spec.capabilityId === 'timeline.overwrite'
                          ? { command: 'overwrite' }
                          : { command: 'replace', target: 'this' };
  return TimelineEditObjectiveSchema.parse(values);
}

function timelineFixture(spec: TimelineEvalSpec): ProfessionalEvalFixture {
  // Lift intentionally creates a hole on its target track. A continuous lower layer makes the
  // programme output valid while the outcome assertion still proves the selected clip was lifted
  // and the following edit did not ripple. Generic black-frame QA must not redefine a valid lift
  // as corruption merely because this minimal fixture otherwise had no composited background.
  const project = timelineEvalProject(spec.capabilityId === 'timeline.lift');
  const slip = spec.capabilityId === 'timeline.slip';
  const sourceRate = slip ? { numerator: 24, denominator: 1 } : RATE;
  const interaction = captureEditorInteractionContext({
    project,
    projectRevision: 1,
    playheadSeconds: spec.playheadSeconds,
    selectedClipIds: ['selected'],
    primaryClipId: 'selected',
    sourceMonitor: {
      assetId: slip ? 'selected_asset' : 'replacement_asset',
      rate: sourceRate,
      playhead: { seconds: 3, frame: 3 * sourceRate.numerator },
      markedRange: { startFrame: 30, endFrame: 90 },
    },
  });
  return { project, interaction };
}

function resolveAndCompileTimeline(
  spec: TimelineEvalSpec,
  fixture: ProfessionalEvalFixture,
): ProfessionalEvalCompilation {
  const objective = objectiveFor(spec);
  const resolved = resolveTimelineObjective({
    project: fixture.project,
    projectRevision: 1,
    interaction: fixture.interaction,
    objective,
  });
  if (resolved.status !== 'resolved') {
    return {
      status: 'failed',
      failures: [`timeline controller rejected ${resolved.code}: ${resolved.detail}`],
    };
  }
  if (resolved.commands[0]?.type !== spec.command.type) {
    return { status: 'failed', failures: ['controller resolved the wrong command type'] };
  }
  const operations = [];
  for (const command of resolved.commands) {
    const compiled = compileEditorCommand({
      timeline: fixture.project.timeline,
      assets: fixture.project.assets,
      sequenceRate: RATE,
      angleGroups: fixture.project.angleGroups,
      command,
    });
    if (compiled.status !== 'compiled') {
      return {
        status: 'failed',
        failures: [`compiler rejected ${spec.capabilityId}: ${compiled.code} — ${compiled.detail}`],
      };
    }
    operations.push(...compiled.patch.operations);
  }
  const patch: Patch = {
    patchId: `professional_eval_${spec.fixtureId}` as PatchId,
    createdBy: 'agent',
    reason: `${spec.capabilityId} controller outcome`,
    operations,
  };
  return {
    status: 'compiled',
    patch,
    inversePatch: invertPatch(fixture.project.timeline, patch),
    resolution: [
      `evidence=${resolved.evidence.join(',')}`,
      `commands=${resolved.commands.length}`,
      `command=${spec.command.type}`,
    ],
  };
}

export const TIMELINE_EVAL_CASES: readonly ProfessionalEvalCase[] = SPECS.map((spec) => ({
  fixtureId: spec.fixtureId,
  capabilityId: spec.capabilityId,
  setup: () => timelineFixture(spec),
  resolveAndCompile: (fixture) => resolveAndCompileTimeline(spec, fixture),
  expectOutcome: (persisted) => spec.expectOutcome(persisted),
}));
