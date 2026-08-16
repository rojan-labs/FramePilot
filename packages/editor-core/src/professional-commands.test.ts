import { describe, expect, it } from 'vitest';
import type { AngleGroup, Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import { applyPatch } from './patch.js';
import {
  compileEditorCommand,
  type CommandFrameRate,
  type EditorCommand,
  type EditorCommandCompileResult,
  type SwitchAngleEditCommand,
} from './professional-commands.js';

const RATE_30: CommandFrameRate = { numerator: 30, denominator: 1 };
const RATE_2997: CommandFrameRate = { numerator: 30_000, denominator: 1001 };

const clip = (id: string, start: number, end: number): Clip => ({
  id,
  assetId: `${id}_asset`,
  trackId: 'v1',
  start,
  end,
  sourceStart: 5,
  sourceEnd: 5 + end - start,
  effects: [],
  keyframes: [],
});

const timeline = (
  over: { readonly revision?: number; readonly locked?: boolean } = {},
): Timeline => ({
  revision: over.revision ?? 0,
  tracks: [
    {
      id: 'v1',
      type: 'video',
      ...(over.locked === true ? { locked: true } : {}),
      clips: [clip('previous', 0, 10), clip('selected', 10, 20), clip('next', 20, 30)],
    },
  ],
});

const assets: Asset[] = ['previous', 'selected', 'next'].map((id) => ({
  id: `${id}_asset`,
  path: `${id}.mp4`,
  kind: 'video',
  durationSeconds: 40,
}));
assets.push({
  id: 'replacement_asset',
  path: 'replacement.mp4',
  kind: 'video',
  durationSeconds: 40,
});

const linkedTimeline = (): Timeline => ({
  revision: 0,
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [clip('previous', 0, 10), clip('selected', 10, 20)],
    },
    {
      id: 'a1',
      type: 'audio',
      clips: [
        { ...clip('previous', 0, 10), id: 'previous_audio', trackId: 'a1' },
        { ...clip('selected', 10, 20), id: 'selected_audio', trackId: 'a1' },
      ],
    },
  ],
});

function compiled(
  command: EditorCommand,
  rate: CommandFrameRate = RATE_30,
  base = timeline(),
  media = assets,
): Extract<EditorCommandCompileResult, { status: 'compiled' }> {
  const result = compileEditorCommand({
    timeline: base,
    assets: media,
    sequenceRate: rate,
    command,
  });
  expect(result.status, result.status === 'rejected' ? result.detail : undefined).toBe('compiled');
  return result as Extract<EditorCommandCompileResult, { status: 'compiled' }>;
}

function expectContentRestored(
  base: Timeline,
  result: Extract<EditorCommandCompileResult, { status: 'compiled' }>,
): void {
  const edited = applyPatch(base, result.patch);
  const restored = applyPatch(edited, result.inversePatch);
  // Timeline revision is intentionally monotonic through undo; project content is exact.
  expect({ ...restored, revision: base.revision }).toEqual(base);
}

describe('professional command compiler', () => {
  it('compiles a roll into shrink-first coupled trims and exact undo', () => {
    const base = timeline();
    const result = compiled({
      type: 'roll_edit',
      timelineRevision: 0,
      outgoingClipId: 'previous',
      incomingClipId: 'selected',
      delta: { domain: 'sequence', frames: 2, rate: RATE_30 },
    });
    expect(result.patch.operations.map((operation) => operation.type)).toEqual([
      'trim_clip',
      'trim_clip',
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips.map((item) => [item.id, item.start, item.end])).toEqual([
      ['previous', 0, 10 + 2 / 30],
      ['selected', 10 + 2 / 30, 20],
      ['next', 20, 30],
    ]);
    expectContentRestored(base, result);
  });

  it('compiles a source-rate slip without moving the clip on the sequence', () => {
    const base = timeline();
    const result = compiled({
      type: 'slip_edit',
      timelineRevision: 0,
      clipId: 'selected',
      delta: {
        domain: 'source',
        frames: 3,
        rate: { numerator: 24, denominator: 1 },
      },
    });
    const edited = applyPatch(base, result.patch);
    const selected = edited.tracks[0]!.clips[1]!;
    expect([selected.start, selected.end]).toEqual([10, 20]);
    expect([selected.sourceStart, selected.sourceEnd]).toEqual([5.125, 15.125]);
    expectContentRestored(base, result);
  });

  it('compiles a slide in an order that never creates a transient overlap', () => {
    const base = timeline();
    const result = compiled({
      type: 'slide_edit',
      timelineRevision: 0,
      previousClipId: 'previous',
      clipId: 'selected',
      nextClipId: 'next',
      delta: { domain: 'sequence', frames: 3, rate: RATE_30 },
    });
    expect(result.patch.operations.map((operation) => operation.type)).toEqual([
      'trim_clip',
      'move_clip',
      'trim_clip',
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips.map((item) => [item.id, item.start, item.end])).toEqual([
      ['previous', 0, 10.1],
      ['selected', 10.1, 20.1],
      ['next', 20.1, 30],
    ]);
    expectContentRestored(base, result);
  });

  it('uses rational sequence rates without decimal-fps drift', () => {
    const result = compiled(
      {
        type: 'roll_edit',
        timelineRevision: 0,
        outgoingClipId: 'previous',
        incomingClipId: 'selected',
        delta: { domain: 'sequence', frames: 10, rate: RATE_2997 },
      },
      RATE_2997,
    );
    expect(result.facts).toContainEqual({
      name: 'newCutSeconds',
      value: 10 + (10 * 1001) / 30_000,
    });
  });

  it('ripple-trims a head shorter while closing the removed sequence time', () => {
    const base = timeline();
    const result = compiled({
      type: 'ripple_trim_edit',
      timelineRevision: 0,
      clipId: 'selected',
      edge: 'start',
      delta: { domain: 'sequence', frames: 30, rate: RATE_30 },
    });
    expect(result.patch.operations).toEqual([
      { type: 'ripple_delete', trackId: 'v1', start: 10, end: 11 },
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips.map((item) => [item.id, item.start, item.end])).toEqual([
      ['previous', 0, 10],
      ['selected', 10, 19],
      ['next', 19, 29],
    ]);
    expect(edited.tracks[0]!.clips[1]!.sourceStart).toBe(6);
    expectContentRestored(base, result);
  });

  it('ripple-extends a tail after moving downstream clips out of the way', () => {
    const base = timeline();
    const result = compiled({
      type: 'ripple_trim_edit',
      timelineRevision: 0,
      clipId: 'selected',
      edge: 'end',
      delta: { domain: 'sequence', frames: 30, rate: RATE_30 },
    });
    expect(result.patch.operations.map((operation) => operation.type)).toEqual([
      'move_clip',
      'trim_clip',
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips.map((item) => [item.id, item.start, item.end])).toEqual([
      ['previous', 0, 10],
      ['selected', 10, 21],
      ['next', 21, 31],
    ]);
    expectContentRestored(base, result);
  });

  it('distinguishes lift from extract and round-trips both', () => {
    const base = timeline();
    const lift = compiled({
      type: 'lift_edit',
      timelineRevision: 0,
      clipIds: ['selected'],
    });
    const extract = compiled({
      type: 'extract_edit',
      timelineRevision: 0,
      clipIds: ['selected'],
    });
    const lifted = applyPatch(base, lift.patch);
    const extracted = applyPatch(base, extract.patch);
    expect(lifted.tracks[0]!.clips.map((item) => [item.id, item.start])).toEqual([
      ['previous', 0],
      ['next', 20],
    ]);
    expect(extracted.tracks[0]!.clips.map((item) => [item.id, item.start])).toEqual([
      ['previous', 0],
      ['next', 10],
    ]);
    expectContentRestored(base, lift);
    expectContentRestored(base, extract);
  });

  it('inserts a marked source range inside a clip by splitting before shifting', () => {
    const base = timeline();
    const result = compiled({
      type: 'insert_edit',
      timelineRevision: 0,
      trackId: 'v1',
      assetId: 'replacement_asset',
      at: { domain: 'sequence', frame: 450, rate: RATE_30 },
      sourceRange: { domain: 'source', startFrame: 30, endFrame: 90, rate: RATE_30 },
    });
    expect(result.patch.operations.map((operation) => operation.type)).toEqual([
      'split_clip',
      'move_clip',
      'move_clip',
      'add_clip',
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips.map((item) => [item.assetId, item.start, item.end])).toEqual([
      ['previous_asset', 0, 10],
      ['selected_asset', 10, 15],
      ['replacement_asset', 15, 17],
      ['selected_asset', 17, 22],
      ['next_asset', 22, 32],
    ]);
    expectContentRestored(base, result);
  });

  it('overwrites timeline time without shifting downstream clips', () => {
    const base = timeline();
    const result = compiled({
      type: 'overwrite_edit',
      timelineRevision: 0,
      trackId: 'v1',
      assetId: 'replacement_asset',
      at: { domain: 'sequence', frame: 450, rate: RATE_30 },
      sourceRange: { domain: 'source', startFrame: 30, endFrame: 90, rate: RATE_30 },
    });
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips.map((item) => [item.assetId, item.start, item.end])).toEqual([
      ['previous_asset', 0, 10],
      ['selected_asset', 10, 15],
      ['replacement_asset', 15, 17],
      ['selected_asset', 17, 20],
      ['next_asset', 20, 30],
    ]);
    expectContentRestored(base, result);
  });

  it('replaces media while preserving the edited clip identity and attached state', () => {
    const base = timeline();
    const selected = base.tracks[0]!.clips[1]!;
    selected.effects.push({ id: 'look', type: 'color_grade', params: {}, keyframes: [] });
    selected.keyframes.push({
      id: 'move',
      property: 'x',
      time: 1,
      value: 0.2,
      easing: 'linear',
    });
    const result = compiled(
      {
        type: 'replace_edit',
        timelineRevision: 0,
        clipId: 'selected',
        assetId: 'replacement_asset',
        sourceIn: { domain: 'source', frame: 90, rate: RATE_30 },
      },
      RATE_30,
      base,
    );
    const edited = applyPatch(base, result.patch);
    const replacement = edited.tracks[0]!.clips[1]!;
    expect([replacement.id, replacement.assetId, replacement.start, replacement.end]).toEqual([
      'selected',
      'replacement_asset',
      10,
      20,
    ]);
    expect([replacement.sourceStart, replacement.sourceEnd]).toEqual([3, 13]);
    expect(replacement.effects).toEqual(selected.effects);
    expect(replacement.keyframes).toEqual(selected.keyframes);
    expectContentRestored(base, result);
  });

  it('compiles a J-cut by leading incoming sound while leaving picture fixed', () => {
    const base = linkedTimeline();
    const result = compiled(
      {
        type: 'j_cut_edit',
        timelineRevision: 0,
        videoOutgoingClipId: 'previous',
        videoIncomingClipId: 'selected',
        audioOutgoingClipId: 'previous_audio',
        audioIncomingClipId: 'selected_audio',
        delta: { domain: 'sequence', frames: 15, rate: RATE_30 },
      },
      RATE_30,
      base,
    );
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips.map((item) => [item.id, item.start, item.end])).toEqual([
      ['previous', 0, 10],
      ['selected', 10, 20],
    ]);
    expect(edited.tracks[1]!.clips.map((item) => [item.id, item.start, item.end])).toEqual([
      ['previous_audio', 0, 9.5],
      ['selected_audio', 9.5, 20],
    ]);
    expectContentRestored(base, result);
  });

  it('compiles an L-cut by trailing outgoing sound while leaving picture fixed', () => {
    const base = linkedTimeline();
    const result = compiled(
      {
        type: 'l_cut_edit',
        timelineRevision: 0,
        videoOutgoingClipId: 'previous',
        videoIncomingClipId: 'selected',
        audioOutgoingClipId: 'previous_audio',
        audioIncomingClipId: 'selected_audio',
        delta: { domain: 'sequence', frames: 15, rate: RATE_30 },
      },
      RATE_30,
      base,
    );
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips.map((item) => [item.id, item.start, item.end])).toEqual([
      ['previous', 0, 10],
      ['selected', 10, 20],
    ]);
    expect(edited.tracks[1]!.clips.map((item) => [item.id, item.start, item.end])).toEqual([
      ['previous_audio', 0, 10.5],
      ['selected_audio', 10.5, 20],
    ]);
    expectContentRestored(base, result);
  });

  it('rejects asymmetric cuts when the asserted audio pair is not linked media', () => {
    const base = linkedTimeline();
    base.tracks[1]!.clips[0]!.assetId = 'selected_asset';
    const result = compileEditorCommand({
      timeline: base,
      assets,
      sequenceRate: RATE_30,
      command: {
        type: 'j_cut_edit',
        timelineRevision: 0,
        videoOutgoingClipId: 'previous',
        videoIncomingClipId: 'selected',
        audioOutgoingClipId: 'previous_audio',
        audioIncomingClipId: 'selected_audio',
        delta: { domain: 'sequence', frames: 15, rate: RATE_30 },
      },
    });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('linked_media_mismatch');
  });

  it('rejects stale authority, locked tracks, insufficient handles, and guessed rates', () => {
    const cases = [
      compileEditorCommand({
        timeline: timeline({ revision: 2 }),
        assets,
        sequenceRate: RATE_30,
        command: {
          type: 'slip_edit',
          timelineRevision: 1,
          clipId: 'selected',
          delta: { domain: 'source', frames: 1, rate: RATE_30 },
        },
      }),
      compileEditorCommand({
        timeline: timeline({ locked: true }),
        assets,
        sequenceRate: RATE_30,
        command: {
          type: 'roll_edit',
          timelineRevision: 0,
          outgoingClipId: 'previous',
          incomingClipId: 'selected',
          delta: { domain: 'sequence', frames: 1, rate: RATE_30 },
        },
      }),
      compileEditorCommand({
        timeline: timeline(),
        assets,
        sequenceRate: RATE_30,
        command: {
          type: 'slip_edit',
          timelineRevision: 0,
          clipId: 'selected',
          delta: { domain: 'source', frames: -151, rate: RATE_30 },
        },
      }),
      compileEditorCommand({
        timeline: timeline(),
        assets,
        sequenceRate: RATE_30,
        command: {
          type: 'slide_edit',
          timelineRevision: 0,
          previousClipId: 'previous',
          clipId: 'selected',
          nextClipId: 'next',
          delta: { domain: 'sequence', frames: 1, rate: RATE_2997 },
        },
      }),
    ];
    expect(
      cases.map((result) => (result.status === 'rejected' ? result.code : 'compiled')),
    ).toEqual([
      'stale_timeline',
      'locked_track',
      'insufficient_source_handle',
      'invalid_frame_delta',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Multicam angle switching (schema v18)
// ---------------------------------------------------------------------------

const CAM_A_OFFSET = 0;
const CAM_B_OFFSET = 12.4;

const multicamAssets: Asset[] = [
  { id: 'cam_a', path: 'a.mp4', kind: 'video', durationSeconds: 600 },
  { id: 'cam_b', path: 'b.mp4', kind: 'video', durationSeconds: 600 },
];

const multicamGroup = (over: Partial<AngleGroup> = {}): AngleGroup => ({
  id: 'grp',
  name: 'Interview',
  angles: [
    { id: 'wide', name: 'Wide', assetId: 'cam_a', syncOffsetSeconds: CAM_A_OFFSET },
    { id: 'tight', name: 'Tight', assetId: 'cam_b', syncOffsetSeconds: CAM_B_OFFSET },
  ],
  ...over,
});

/** One 10s shot on the wide camera, starting 30s into that camera's recording. */
const multicamTimeline = (over: Partial<Clip> = {}): Timeline => ({
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
          ...over,
        },
      ],
    },
  ],
});

function switchCommand(over: Partial<SwitchAngleEditCommand> = {}): SwitchAngleEditCommand {
  return {
    type: 'switch_angle_edit',
    timelineRevision: 0,
    clipId: 'shot',
    targetAngleId: 'tight',
    at: { domain: 'sequence', frame: 150, rate: RATE_30 },
    ...over,
  };
}

function compileSwitch(
  command: SwitchAngleEditCommand = switchCommand(),
  over: {
    readonly timeline?: Timeline;
    readonly angleGroups?: readonly AngleGroup[];
    readonly assets?: readonly Asset[];
    readonly sequenceRate?: CommandFrameRate;
  } = {},
): EditorCommandCompileResult {
  return compileEditorCommand({
    timeline: over.timeline ?? multicamTimeline(),
    assets: over.assets ?? multicamAssets,
    sequenceRate: over.sequenceRate ?? RATE_30,
    angleGroups: over.angleGroups ?? [multicamGroup()],
    command,
  });
}

function rejection(result: EditorCommandCompileResult): { code: string; detail: string } {
  expect(result.status).toBe('rejected');
  const rejected = result as Extract<EditorCommandCompileResult, { status: 'rejected' }>;
  return { code: rejected.code, detail: rejected.detail };
}

describe('multicam angle switching', () => {
  it('cuts to the other camera at the same instant, not the same source timestamp', () => {
    const base = multicamTimeline();
    const result = compileSwitch();
    expect(result.status, result.status === 'rejected' ? result.detail : undefined).toBe(
      'compiled',
    );
    const compiledResult = result as Extract<EditorCommandCompileResult, { status: 'compiled' }>;

    expect(compiledResult.patch.operations.map((operation) => operation.type)).toEqual([
      'split_clip',
      'set_clip_media',
    ]);

    const edited = applyPatch(base, compiledResult.patch);
    const clips = edited.tracks[0]!.clips;
    expect(clips.map((item) => [item.assetId, item.start, item.end])).toEqual([
      ['cam_a', 0, 5],
      ['cam_b', 5, 10],
    ]);

    // The switch happens 5s into a shot that started 30s into camera A, i.e. at
    // group time 35s. Camera B started rolling 12.4s earlier in its own timebase,
    // so the same instant is 47.4s into camera B — NOT 35s, which is what a
    // naive source-preserving replace would have used.
    const incoming = clips[1]!;
    expect(incoming.sourceStart).toBeCloseTo(47.4, 9);
    expect(incoming.sourceEnd).toBeCloseTo(52.4, 9);
    // Duration is preserved on the sequence: a switch is a cut, not a trim.
    expect(incoming.end - incoming.start).toBeCloseTo(5, 9);

    expectContentRestored(base, compiledResult);
  });

  it('switches the whole clip when the cut lands on its head, without splitting', () => {
    const base = multicamTimeline();
    const result = compileSwitch(
      switchCommand({ at: { domain: 'sequence', frame: 0, rate: RATE_30 } }),
    );
    const compiledResult = result as Extract<EditorCommandCompileResult, { status: 'compiled' }>;
    expect(compiledResult.status).toBe('compiled');
    expect(compiledResult.patch.operations.map((operation) => operation.type)).toEqual([
      'set_clip_media',
    ]);

    const clips = applyPatch(base, compiledResult.patch).tracks[0]!.clips;
    expect(clips).toHaveLength(1);
    expect(clips[0]!.assetId).toBe('cam_b');
    expect(clips[0]!.sourceStart).toBeCloseTo(42.4, 9);
    expect(clips[0]!.sourceEnd).toBeCloseTo(52.4, 9);
    expect([clips[0]!.start, clips[0]!.end]).toEqual([0, 10]);
    expectContentRestored(base, compiledResult);
  });

  it('reports the cut boundary and both angles as review facts', () => {
    const result = compileSwitch() as Extract<EditorCommandCompileResult, { status: 'compiled' }>;
    const facts = Object.fromEntries(result.facts.map((fact) => [fact.name, fact.value]));
    expect(facts).toMatchObject({
      angleGroupId: 'grp',
      fromAngleId: 'wide',
      toAngleId: 'tight',
      switchSequenceSeconds: 5,
      splitExistingClip: true,
      groupTimeSeconds: 35,
    });
  });

  it('refuses an unsynced angle instead of assuming the cameras rolled together', () => {
    const unsynced = multicamGroup({
      angles: [
        { id: 'wide', assetId: 'cam_a', syncOffsetSeconds: 0 },
        { id: 'tight', assetId: 'cam_b' },
      ],
    });
    const { code, detail } = rejection(compileSwitch(switchCommand(), { angleGroups: [unsynced] }));
    expect(code).toBe('unsynced_angle');
    // The fix names the angle that is missing an offset.
    expect(detail).toContain('"tight"');
    expect(detail).toContain('syncOffsetSeconds');
  });

  it('refuses media that belongs to no camera group', () => {
    const { code, detail } = rejection(compileSwitch(switchCommand(), { angleGroups: [] }));
    expect(code).toBe('ungrouped_angle_media');
    expect(detail).toContain('cam_a');
  });

  it('refuses an asset that two groups both claim rather than picking one', () => {
    const second = multicamGroup({
      id: 'grp2',
      angles: [
        { id: 'wide2', assetId: 'cam_a', syncOffsetSeconds: 100 },
        { id: 'other', assetId: 'cam_b', syncOffsetSeconds: 0 },
      ],
    });
    const { code, detail } = rejection(
      compileSwitch(switchCommand(), { angleGroups: [multicamGroup(), second] }),
    );
    expect(code).toBe('ambiguous_angle_group');
    expect(detail).toContain('grp2');
  });

  it('refuses an angle the group does not contain, and lists the ones it does', () => {
    const { code, detail } = rejection(compileSwitch(switchCommand({ targetAngleId: 'drone' })));
    expect(code).toBe('missing_angle');
    expect(detail).toContain('wide');
    expect(detail).toContain('tight');
  });

  it('refuses switching to the angle already on screen', () => {
    expect(rejection(compileSwitch(switchCommand({ targetAngleId: 'wide' }))).code).toBe('no_op');
  });

  it('refuses when the incoming camera has no footage at that moment', () => {
    // Camera B stopped after 50s of its own recording, but the switch needs 52.4s.
    const shortAssets: Asset[] = [
      multicamAssets[0]!,
      { ...multicamAssets[1]!, durationSeconds: 50 },
    ];
    const { code, detail } = rejection(compileSwitch(switchCommand(), { assets: shortAssets }));
    expect(code).toBe('source_range_out_of_bounds');
    expect(detail).toContain('runs out of footage');
  });

  it('refuses when the incoming camera was not yet rolling at that moment', () => {
    // Camera B starts 100s AFTER group zero, so group time 35s predates its first frame.
    const later = multicamGroup({
      angles: [
        { id: 'wide', assetId: 'cam_a', syncOffsetSeconds: 0 },
        { id: 'tight', assetId: 'cam_b', syncOffsetSeconds: -100 },
      ],
    });
    const { code, detail } = rejection(compileSwitch(switchCommand(), { angleGroups: [later] }));
    expect(code).toBe('source_range_out_of_bounds');
    expect(detail).toContain('not yet recording');
  });

  it('refuses a retimed clip, whose source position is not a straight offset', () => {
    const { code } = rejection(
      compileSwitch(switchCommand(), { timeline: multicamTimeline({ speed: 2 }) }),
    );
    expect(code).toBe('retimed_boundary_unsupported');
  });

  it('refuses a switch point the clip never shows', () => {
    const { code } = rejection(
      compileSwitch(switchCommand({ at: { domain: 'sequence', frame: 300, rate: RATE_30 } })),
    );
    expect(code).toBe('switch_point_outside_clip');
  });

  it('refuses a locked track and a stale timeline revision', () => {
    const locked = multicamTimeline();
    const lockedTimeline: Timeline = {
      ...locked,
      tracks: [{ ...locked.tracks[0]!, locked: true }],
    };
    expect(rejection(compileSwitch(switchCommand(), { timeline: lockedTimeline })).code).toBe(
      'locked_track',
    );
    expect(rejection(compileSwitch(switchCommand({ timelineRevision: 9 }))).code).toBe(
      'stale_timeline',
    );
  });

  it('stays frame-accurate at 29.97', () => {
    const at = { domain: 'sequence' as const, frame: 150, rate: RATE_2997 };
    const result = compileSwitch(switchCommand({ at }), { sequenceRate: RATE_2997 });
    const compiledResult = result as Extract<EditorCommandCompileResult, { status: 'compiled' }>;
    expect(compiledResult.status).toBe('compiled');
    const switchSeconds = (150 * 1001) / 30_000;
    const clips = applyPatch(multicamTimeline(), compiledResult.patch).tracks[0]!.clips;
    expect(clips[1]!.start).toBeCloseTo(switchSeconds, 9);
    // Same instant on the other camera: group time + camera B's offset.
    expect(clips[1]!.sourceStart).toBeCloseTo(30 + switchSeconds + CAM_B_OFFSET, 9);
    expectContentRestored(multicamTimeline(), compiledResult);
  });
});
