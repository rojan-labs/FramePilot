import { describe, expect, it } from 'vitest';
import { applyPatch, type Patch } from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { captureEditorInteractionContext } from '../editor-context/interaction-context.js';
import {
  TimelineEditObjectiveSchema,
  resolveTimelineObjective,
} from '../controllers/timeline-controller.js';
import { operationsForCall, ToolInvocationError } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { PROFESSIONAL_EDIT_TOOL } from './professional-edit.js';

function project(): Project {
  return parseProject({
    id: 'professional',
    name: 'Professional tool fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: ['previous', 'selected', 'next', 'replacement'].map((id) => ({
      id: `${id}_asset`,
      path: `${id}.mp4`,
      kind: 'video',
      durationSeconds: 40,
    })),
    timeline: {
      revision: 0,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'previous',
              assetId: 'previous_asset',
              trackId: 'v1',
              start: 0,
              end: 10,
              sourceStart: 5,
              sourceEnd: 15,
              effects: [],
              keyframes: [],
            },
            {
              id: 'selected',
              assetId: 'selected_asset',
              trackId: 'v1',
              start: 10,
              end: 20,
              sourceStart: 5,
              sourceEnd: 15,
              effects: [],
              keyframes: [],
            },
            {
              id: 'next',
              assetId: 'next_asset',
              trackId: 'v1',
              start: 20,
              end: 30,
              sourceStart: 5,
              sourceEnd: 15,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

function linkedProject(): Project {
  const base = project();
  base.timeline.tracks.push({
    id: 'a1',
    type: 'audio',
    clips: [
      {
        id: 'previous_audio',
        assetId: 'previous_asset',
        trackId: 'a1',
        start: 0,
        end: 10,
        sourceStart: 5,
        sourceEnd: 15,
        effects: [],
        keyframes: [],
      },
      {
        id: 'selected_audio',
        assetId: 'selected_asset',
        trackId: 'a1',
        start: 10,
        end: 20,
        sourceStart: 5,
        sourceEnd: 15,
        effects: [],
        keyframes: [],
      },
    ],
  });
  return base;
}

/**
 * A two-camera shoot with a separate sound recorder: the realistic multicam shape,
 * where switching picture must not disturb the audio bed.
 */
function multicamProject(over: { readonly syncTight?: number } = { syncTight: 12.4 }): Project {
  const tight: Record<string, unknown> = { id: 'tight', name: 'Tight', assetId: 'cam_b' };
  if (over.syncTight !== undefined) tight.syncOffsetSeconds = over.syncTight;
  return parseProject({
    id: 'multicam',
    name: 'Multicam fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'cam_a', path: 'a.mp4', kind: 'video', durationSeconds: 600 },
      { id: 'cam_b', path: 'b.mp4', kind: 'video', durationSeconds: 600 },
      { id: 'audio_recorder', path: 'sound.wav', kind: 'audio', durationSeconds: 600 },
    ],
    angleGroups: [
      {
        id: 'grp',
        name: 'Interview',
        angles: [{ id: 'wide', name: 'Wide', assetId: 'cam_a', syncOffsetSeconds: 0 }, tight],
      },
    ],
    timeline: {
      revision: 0,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'shot',
              assetId: 'cam_a',
              trackId: 'v1',
              start: 0,
              end: 10,
              sourceStart: 30,
              sourceEnd: 40,
              effects: [],
              keyframes: [],
            },
          ],
        },
        {
          id: 'a1',
          type: 'audio',
          role: 'dialogue',
          clips: [
            {
              id: 'shot_audio',
              assetId: 'audio_recorder',
              trackId: 'a1',
              start: 0,
              end: 10,
              sourceStart: 0,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

/** Playhead 5s into the shot, picture clip primary — what the editor's UI produces. */
function multicamContext(base: Project): ToolContext {
  return {
    project: base,
    projectRevision: 4,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: 4,
      playheadSeconds: 5,
      selectedClipIds: ['shot'],
      primaryClipId: 'shot',
    }),
  };
}

function context(base: Project, playheadSeconds = 10): ToolContext {
  return {
    project: base,
    projectRevision: 4,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: 4,
      playheadSeconds,
      selectedClipIds: ['selected'],
      primaryClipId: 'selected',
    }),
  };
}

function sourceContext(
  base: Project,
  options: {
    readonly playheadSeconds?: number;
    readonly assetId: string;
    readonly sourcePlayheadFrame: number;
    readonly markedRange?: { readonly startFrame: number; readonly endFrame: number };
  },
): ToolContext {
  const rate = { numerator: 30, denominator: 1 } as const;
  return {
    project: base,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: 4,
      playheadSeconds: options.playheadSeconds ?? 15,
      selectedClipIds: ['selected'],
      primaryClipId: 'selected',
      sourceMonitor: {
        assetId: options.assetId,
        rate,
        playhead: {
          frame: options.sourcePlayheadFrame,
          seconds: options.sourcePlayheadFrame / 30,
        },
        ...(options.markedRange ? { markedRange: options.markedRange } : {}),
      },
    }),
  };
}

function dispatch(base: Project, ctx: ToolContext, args: Record<string, unknown>) {
  const operations = operationsForCall(
    { id: 'call_1', name: 'professional_edit', arguments: args },
    ctx,
  );
  const patch: Patch = {
    patchId: 'professional_tool_test' as PatchId,
    createdBy: 'agent',
    reason: 'professional tool test',
    operations,
  };
  return applyPatch(base.timeline, patch);
}

describe('professional_edit domain tool', () => {
  it('resolves a playhead cut and compiles a roll without model-authored choreography', () => {
    const base = project();
    const edited = dispatch(base, context(base), {
      command: 'roll',
      frames: 3,
      anchor: 'playhead',
      relation: 'at',
    });
    expect(edited.tracks[0]!.clips.map((clip) => [clip.id, clip.start, clip.end])).toEqual([
      ['previous', 0, 10.1],
      ['selected', 10.1, 20],
      ['next', 20, 30],
    ]);
  });

  it('preserves an evidence-linked picture/sound boundary by default', () => {
    const base = linkedProject();
    const edited = dispatch(base, context(base), {
      command: 'roll',
      frames: 3,
      anchor: 'playhead',
    });
    expect(edited.tracks[0]!.clips.slice(0, 2).map((clip) => [clip.start, clip.end])).toEqual([
      [0, 10.1],
      [10.1, 20],
    ]);
    expect(edited.tracks[1]!.clips.map((clip) => [clip.start, clip.end])).toEqual([
      [0, 10.1],
      [10.1, 20],
    ]);
  });

  it('allows an explicit asymmetric roll without moving linked sound', () => {
    const base = linkedProject();
    const edited = dispatch(base, context(base), {
      command: 'roll',
      frames: 3,
      syncPolicy: 'allow_desync',
    });
    expect(edited.tracks[0]!.clips.slice(0, 2).map((clip) => [clip.start, clip.end])).toEqual([
      [0, 10.1],
      [10.1, 20],
    ]);
    expect(edited.tracks[1]!.clips.map((clip) => [clip.start, clip.end])).toEqual([
      [0, 10],
      [10, 20],
    ]);
  });

  it('cuts to another camera at the playhead and leaves the sound alone', () => {
    const base = multicamProject();
    const edited = dispatch(base, multicamContext(base), {
      command: 'switch_angle',
      cameraAngleId: 'tight',
    });

    // Picture: cut at the playhead (5s), downstream half on the other camera, landing
    // 47.4s into it — the same instant, mapped through both authored sync offsets.
    expect(
      edited.tracks[0]!.clips.map((clip) => [clip.assetId, clip.start, clip.end, clip.sourceStart]),
    ).toEqual([
      ['cam_a', 0, 5, 30],
      ['cam_b', 5, 10, 47.4],
    ]);

    // Sound: untouched. A camera change that also re-cut the audio would put an
    // audible jump in room tone at every switch.
    expect(
      edited.tracks[1]!.clips.map((clip) => [clip.id, clip.assetId, clip.start, clip.end]),
    ).toEqual([['shot_audio', 'audio_recorder', 0, 10]]);
  });

  it('refuses a camera with no authored sync rather than assuming it rolled with the others', () => {
    const base = multicamProject({ syncTight: undefined });
    expect(() =>
      operationsForCall(
        {
          id: 'call_switch',
          name: 'professional_edit',
          arguments: { command: 'switch_angle', cameraAngleId: 'tight' },
        },
        multicamContext(base),
      ),
    ).toThrow(/unsynced_angle/);
  });

  it('refuses a camera angle the group does not contain', () => {
    const base = multicamProject();
    expect(() =>
      operationsForCall(
        {
          id: 'call_switch',
          name: 'professional_edit',
          arguments: { command: 'switch_angle', cameraAngleId: 'drone' },
        },
        multicamContext(base),
      ),
    ).toThrow(/missing_angle/);
  });

  it('keeps cameraAngleId bound to switch_angle, in both directions', () => {
    expect(() =>
      TimelineEditObjectiveSchema.parse({ command: 'roll', frames: 3, cameraAngleId: 'tight' }),
    ).toThrow(/cameraAngleId applies only to switch_angle/);
    expect(() => TimelineEditObjectiveSchema.parse({ command: 'switch_angle' })).toThrow(
      /switch_angle requires the camera angle/,
    );
  });

  it('resolves the switch from live state without the model naming a clip or position', () => {
    const base = multicamProject();
    const interaction = multicamContext(base).interaction!;
    const objective = TimelineEditObjectiveSchema.parse({
      command: 'switch_angle',
      cameraAngleId: 'tight',
    });
    const result = resolveTimelineObjective({ project: base, interaction, objective });
    expect(result.status).toBe('resolved');
    const resolved = result as Extract<typeof result, { status: 'resolved' }>;
    expect(resolved.commands).toEqual([
      {
        type: 'switch_angle_edit',
        timelineRevision: 0,
        clipId: 'shot',
        targetAngleId: 'tight',
        at: { domain: 'sequence', frame: 150, rate: { numerator: 30, denominator: 1 } },
      },
    ]);
    expect(resolved.facts).toContainEqual({ name: 'soundUntouched', value: true });
  });

  it('rejects ambiguous inferred link companions instead of choosing an audio track', () => {
    const base = linkedProject();
    base.timeline.tracks.push({
      ...base.timeline.tracks[1]!,
      id: 'a2',
      clips: base.timeline.tracks[1]!.clips.map((clip) => ({
        ...clip,
        id: `${clip.id}_duplicate`,
        trackId: 'a2',
      })),
    });
    const interaction = context(base).interaction!;
    const objective = TimelineEditObjectiveSchema.parse({ command: 'slip', frames: 3 });
    const result = resolveTimelineObjective({ project: base, interaction, objective });
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'linked_target_ambiguous',
    });
  });

  it('derives slide neighbours from one selected clip', () => {
    const base = project();
    const edited = dispatch(base, context(base, 15), { command: 'slide', frames: -3 });
    expect(edited.tracks[0]!.clips.map((clip) => [clip.id, clip.start, clip.end])).toEqual([
      ['previous', 0, 9.9],
      ['selected', 9.9, 19.9],
      ['next', 19.9, 30],
    ]);
  });

  it('resolves one selected clip and compiles a ripple trim in sequence frames', () => {
    const base = project();
    const edited = dispatch(base, context(base, 15), {
      command: 'ripple_trim',
      target: 'this',
      edge: 'start',
      frames: 3,
    });
    expect(edited.tracks[0]!.clips.map((clip) => [clip.id, clip.start, clip.end])).toEqual([
      ['previous', 0, 10],
      ['selected', 10, 19.9],
      ['next', 19.9, 29.9],
    ]);
    expect(edited.tracks[0]!.clips[1]!.sourceStart).toBe(5.1);
  });

  it('slips against the selected clip source monitor clock without moving the clip', () => {
    const base = project();
    const edited = dispatch(
      base,
      sourceContext(base, {
        assetId: 'selected_asset',
        sourcePlayheadFrame: 150,
      }),
      { command: 'slip', frames: 3 },
    );
    const selected = edited.tracks[0]!.clips[1]!;
    expect([selected.start, selected.end]).toEqual([10, 20]);
    expect([selected.sourceStart, selected.sourceEnd]).toEqual([5.1, 15.1]);
  });

  it.each([
    ['insert', 22, 32],
    ['overwrite', 20, 30],
  ] as const)(
    '%s consumes source marks and the selected track at the playhead',
    (command, selectedEnd, nextEnd) => {
      const base = project();
      const edited = dispatch(
        base,
        sourceContext(base, {
          assetId: 'replacement_asset',
          sourcePlayheadFrame: 90,
          markedRange: { startFrame: 30, endFrame: 90 },
        }),
        { command },
      );
      expect(edited.tracks[0]!.clips.map((clip) => [clip.assetId, clip.start, clip.end])).toEqual([
        ['previous_asset', 0, 10],
        ['selected_asset', 10, 15],
        ['replacement_asset', 15, 17],
        ['selected_asset', 17, selectedEnd],
        ['next_asset', selectedEnd, nextEnd],
      ]);
    },
  );

  it('replaces selected media from the source playhead while preserving clip timing', () => {
    const base = project();
    const edited = dispatch(
      base,
      sourceContext(base, {
        assetId: 'replacement_asset',
        sourcePlayheadFrame: 90,
      }),
      { command: 'replace' },
    );
    const replacement = edited.tracks[0]!.clips[1]!;
    expect([
      replacement.id,
      replacement.assetId,
      replacement.start,
      replacement.end,
      replacement.sourceStart,
      replacement.sourceEnd,
    ]).toEqual(['selected', 'replacement_asset', 10, 20, 3, 13]);
  });

  it.each([
    ['j_cut', 9.5],
    ['l_cut', 10.5],
  ] as const)(
    '%s resolves linked picture/sound boundaries and moves only sound',
    (command, audioCut) => {
      const base = linkedProject();
      const edited = dispatch(base, context(base), { command, frames: 15 });
      expect(edited.tracks[0]!.clips.map((clip) => [clip.id, clip.start, clip.end])).toEqual([
        ['previous', 0, 10],
        ['selected', 10, 20],
        ['next', 20, 30],
      ]);
      expect(edited.tracks[1]!.clips.map((clip) => [clip.id, clip.start, clip.end])).toEqual([
        ['previous_audio', 0, audioCut],
        ['selected_audio', audioCut, 20],
      ]);
    },
  );

  it('rejects J/L cuts that do not resolve exactly one linked edit point', () => {
    const base = project();
    expect(() => dispatch(base, context(base), { command: 'j_cut', frames: 15 })).toThrow(
      'no_linked_edit_point',
    );
    const linked = linkedProject();
    expect(() => dispatch(linked, context(linked), { command: 'l_cut', frames: -1 })).toThrow(
      'positive magnitude',
    );
  });

  it('rejects source commands when the monitor does not prove the required source state', () => {
    const base = project();
    expect(() => dispatch(base, context(base, 15), { command: 'insert' })).toThrow(
      'active source monitor',
    );
    expect(() =>
      dispatch(
        base,
        sourceContext(base, {
          assetId: 'replacement_asset',
          sourcePlayheadFrame: 90,
        }),
        { command: 'overwrite' },
      ),
    ).toThrow('source in and out marks');
    expect(() =>
      dispatch(
        base,
        sourceContext(base, {
          assetId: 'replacement_asset',
          sourcePlayheadFrame: 90,
        }),
        { command: 'slip', frames: 3 },
      ),
    ).toThrow('selected clip asset');
  });

  it('preserves the editorial distinction between lift and extract', () => {
    const lifted = project();
    const extracted = project();
    expect(
      dispatch(lifted, context(lifted, 15), {
        command: 'lift',
        target: 'this',
      }).tracks[0]!.clips.map((clip) => [clip.id, clip.start, clip.end]),
    ).toEqual([
      ['previous', 0, 10],
      ['next', 20, 30],
    ]);
    expect(
      dispatch(extracted, context(extracted, 15), {
        command: 'extract',
        target: 'this',
      }).tracks[0]!.clips.map((clip) => [clip.id, clip.start, clip.end]),
    ).toEqual([
      ['previous', 0, 10],
      ['next', 10, 20],
    ]);
  });

  it('rejects missing and stale interaction context before emitting operations', () => {
    const base = project();
    expect(() =>
      operationsForCall(
        { id: 'call_1', name: 'professional_edit', arguments: { command: 'slide', frames: 2 } },
        { project: base },
      ),
    ).toThrow(ToolInvocationError);

    const stale = context(base);
    const changed = { ...base, timeline: { ...base.timeline, revision: 1 } };
    expect(() =>
      operationsForCall(
        { id: 'call_2', name: 'professional_edit', arguments: { command: 'slide', frames: 2 } },
        { ...stale, project: changed },
      ),
    ).toThrow('stale_context');

    // Host authority can advance without a structural timeline edit (for example, media-bin or
    // metadata changes). The live project revision, not the snapshot echo, must reject that turn.
    expect(() =>
      operationsForCall(
        { id: 'call_3', name: 'professional_edit', arguments: { command: 'slide', frames: 2 } },
        { ...stale, projectRevision: 5 },
      ),
    ).toThrow('stale_context');
  });

  it('is a host-only domain mutation until external clients gain interaction snapshots', () => {
    expect(PROFESSIONAL_EDIT_TOOL).toMatchObject({
      kind: 'mutate',
      mutates: true,
      hostUiOnly: true,
      capabilities: ['timeline', 'professional-editing'],
    });
  });
});
