/**
 * Tests for stage policy (plan/AGENT-TASK-MEMORY.md §3.2, ADR 0075).
 *
 * The rule that carries the weight: the stage is derived from what a turn DID rather than
 * what it said. It is bookkeeping only — ADR 0199 removed every way it used to narrow the
 * tools a turn could call or how hard a step thinks.
 */
import { describe, expect, it } from 'vitest';
import { executedAnEdit, settledStageFor, stageAdvanceFor, toolRole } from './stage-policy.js';

describe('toolRole', () => {
  it('separates reading the arrangement from reading the content', () => {
    expect(toolRole('get_timeline', false)).toBe('inspection');
    expect(toolRole('get_clips', false)).toBe('inspection');
    expect(toolRole('get_transcript', false)).toBe('analysis');
    expect(toolRole('map_footage', false)).toBe('analysis');
  });

  it('knows guidance, recall, and mutation', () => {
    expect(toolRole('load_skill', false)).toBe('guidance');
    expect(toolRole('recall_evidence', false)).toBe('recall');
    expect(toolRole('delete_range', true)).toBe('mutation');
  });

  it('leaves anything unrecognised stage-neutral rather than guessing', () => {
    expect(toolRole('ask_user', false)).toBe('other');
    expect(toolRole('some_future_tool', false)).toBe('other');
  });

  it('trusts the registry over the name for mutation', () => {
    // A read-shaped name that actually mutates is still a mutation.
    expect(toolRole('get_timeline', true)).toBe('mutation');
  });

  /**
   * These fell through the old local allowlists to `other`, which meant `distil` recorded
   * no fact for them — so the briefing never listed the beat map or the media index under
   * "ESTABLISHED — do not gather again" and the run kept re-gathering them.
   */
  it('classifies the media-analysis tools that used to fall through to stage-neutral', () => {
    expect(toolRole('detect_beats', false)).toBe('analysis');
    expect(toolRole('index_media', false)).toBe('analysis');
    expect(toolRole('describe_footage', false)).toBe('analysis');
    expect(toolRole('transcribe', false)).toBe('analysis');
    expect(toolRole('detect_scenes', false)).toBe('analysis');
  });

  it('classifies the project reads that used to fall through to stage-neutral', () => {
    expect(toolRole('get_project_state', false)).toBe('inspection');
    expect(toolRole('get_timeline_map', false)).toBe('inspection');
    expect(toolRole('list_edit_boundaries', false)).toBe('inspection');
    expect(toolRole('map_time', false)).toBe('inspection');
    expect(toolRole('list_assets', false)).toBe('inspection');
  });

  it('treats remembered preferences as guidance, not analysis', () => {
    expect(toolRole('session_context', false)).toBe('guidance');
  });
});

describe('stageAdvanceFor — evidence, not narration', () => {
  it('leaves interpret only once the run actually calls something', () => {
    expect(stageAdvanceFor('interpret', [], false)).toBeNull();
    expect(stageAdvanceFor('interpret', ['inspection'], false)).toBe('inspect');
  });

  it('moves inspect → analyze on content work, not on more inspection', () => {
    expect(stageAdvanceFor('inspect', ['inspection'], false)).toBeNull();
    expect(stageAdvanceFor('inspect', ['analysis'], false)).toBe('analyze');
    expect(stageAdvanceFor('inspect', ['guidance'], false)).toBe('analyze');
  });

  it('moves analyze → plan when the run first reaches for a mutation', () => {
    expect(stageAdvanceFor('analyze', ['analysis'], false)).toBeNull();
    expect(stageAdvanceFor('analyze', ['mutation'], false)).toBe('plan');
  });

  it('treats an applied edit as proof of execution wherever the run thought it was', () => {
    expect(stageAdvanceFor('plan', ['mutation'], true)).toBe('apply');
  });

  it('stays in plan while a proposed patch has not actually landed', () => {
    // A rejected/invalid patch is still a mutation attempt, but only a LANDED one is
    // proof of execution — otherwise a run stuck rejecting its own bad patches would
    // wrongly be advanced to `apply` on the strength of the attempt alone.
    expect(stageAdvanceFor('plan', ['mutation'], false)).toBeNull();
  });

  it('advances one edge at a time, never teleporting past a stage', () => {
    // From `analyze`, a landed patch still only earns `plan` in one step — reaching
    // `apply` needs the second edge, which `settledStageFor` supplies below.
    expect(stageAdvanceFor('analyze', ['mutation'], true)).toBe('plan');
    // From `inspect` too: a mutation is a commitment wherever it is made.
    expect(stageAdvanceFor('inspect', ['mutation'], true)).toBe('plan');
    expect(stageAdvanceFor('inspect', ['mutation'], false)).toBe('plan');
  });

  it('a run that cuts straight from inspection is executing, not still inspecting', () => {
    // `s9-live-reorder`: read the timeline, `reorder_clips`, landed — and the run was left
    // at `inspect`, told to keep reading, and rotated the order again on every turn.
    expect(settledStageFor('inspect', ['inspection', 'mutation'], true)).toBe('apply');
    expect(settledStageFor('interpret', ['mutation'], true)).toBe('apply');
    // A rejected first attempt is a plan, not an execution.
    expect(settledStageFor('interpret', ['mutation'], false)).toBe('plan');
  });

  it("never proposes a move once the run is executing — that is the reducer's job", () => {
    expect(stageAdvanceFor('apply', ['inspection'], true)).toBeNull();
    expect(stageAdvanceFor('enhance', ['mutation'], true)).toBeNull();
    expect(stageAdvanceFor('verify', ['inspection'], false)).toBeNull();
  });

  it('a recall never advances anything — it returns what the run already had', () => {
    expect(stageAdvanceFor('inspect', ['recall'], false)).toBeNull();
    expect(stageAdvanceFor('analyze', ['recall'], false)).toBeNull();
  });
});

describe('settledStageFor — every transition a turn earns', () => {
  it('closes analysis and opens execution on the turn that first applies a patch', () => {
    // One turn, two closed stages. Advancing one edge per turn would leave the run
    // offering reconnaissance tools for a turn after it had provably stopped researching.
    expect(settledStageFor('analyze', ['mutation'], true)).toBe('apply');
  });

  it('walks a first turn only as far as its evidence justifies', () => {
    expect(settledStageFor('interpret', ['inspection'], false)).toBe('inspect');
    expect(settledStageFor('interpret', ['analysis'], false)).toBe('analyze');
  });

  it('stays put when a turn earns nothing', () => {
    expect(settledStageFor('analyze', ['recall'], false)).toBe('analyze');
    expect(settledStageFor('apply', [], false)).toBe('apply');
  });
});

describe('executedAnEdit — bookkeeping is not execution', () => {
  // Run `df81d58e`: `add_track` + `transcribe` landed as the second turn and opened
  // `apply`, which withheld every analysis tool before a clip was placed.
  it('holds a transcript-and-lane patch back from apply', () => {
    expect(executedAnEdit([{ type: 'add_layer' }, { type: 'set_transcript' }])).toBe(false);
    expect(executedAnEdit([{ type: 'add_marker' }, { type: 'set_track_flags' }])).toBe(false);
  });

  it('counts any real edit, and trusts a caller that handed over no operations', () => {
    expect(executedAnEdit([{ type: 'add_layer' }, { type: 'add_clip' }])).toBe(true);
    expect(executedAnEdit([{ type: 'set_track_caption_style' }])).toBe(true);
    expect(executedAnEdit([])).toBe(true);
  });
});
