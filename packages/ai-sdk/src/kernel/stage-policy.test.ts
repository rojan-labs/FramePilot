/**
 * Tests for stage policy (plan/AGENT-TASK-MEMORY.md §3.2/§3.6, ADR 0075).
 *
 * Two rules carry the weight here and both are asserted directly: the stage is derived
 * from what a turn DID rather than what it said, and an executing run cannot reach the
 * tools that would restart reconnaissance.
 */
import { describe, expect, it } from 'vitest';
import {
  planningExhausted,
  settledStageFor,
  stageAdvanceFor,
  stageAllowsRole,
  toolRole,
} from './stage-policy.js';

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

describe('the locked plan is actually closed to re-analysis', () => {
  // The point of the classification fix, expressed as behaviour: an executing run can no
  // longer be offered `detect_beats`, so it cannot re-derive the beat map mid-montage.
  it.each(['apply', 'enhance', 'repair'] as const)('withholds re-analysis during %s', (stage) => {
    for (const tool of ['detect_beats', 'index_media', 'describe_footage', 'transcribe']) {
      expect(stageAllowsRole(stage, toolRole(tool, false))).toBe(false);
    }
    // Guidance is closed too — the playbook was loaded during planning.
    expect(stageAllowsRole(stage, toolRole('load_skill', false))).toBe(false);
    // But the CURRENT arrangement stays readable: a patch needs live clip ids.
    expect(stageAllowsRole(stage, toolRole('get_timeline', false))).toBe(true);
    // And recall always works — that is the way back to the stored payload.
    expect(stageAllowsRole(stage, toolRole('recall_evidence', false))).toBe(true);
  });

  it('leaves every role open while the run is still planning', () => {
    for (const stage of ['interpret', 'inspect', 'analyze', 'plan'] as const) {
      expect(stageAllowsRole(stage, toolRole('detect_beats', false))).toBe(true);
    }
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
    // Inspection has seen no content work, so a mutation alone earns nothing here.
    expect(stageAdvanceFor('inspect', ['mutation'], true)).toBeNull();
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

describe('stageAllowsRole — the boundary is structural', () => {
  it('leaves every tool available while the run is still deciding', () => {
    for (const stage of ['interpret', 'inspect', 'analyze', 'plan'] as const) {
      expect(stageAllowsRole(stage, 'analysis')).toBe(true);
      expect(stageAllowsRole(stage, 'guidance')).toBe(true);
    }
  });

  it('closes fresh reconnaissance once the plan is locked', () => {
    for (const stage of ['apply', 'enhance', 'repair'] as const) {
      expect(stageAllowsRole(stage, 'analysis')).toBe(false);
      expect(stageAllowsRole(stage, 'guidance')).toBe(false);
    }
  });

  it('keeps inspection, mutation and recall open during execution', () => {
    // Writing a patch needs the CURRENT arrangement — the last cut may have moved the
    // ids it is written against — and recall is reading back, not researching.
    expect(stageAllowsRole('apply', 'inspection')).toBe(true);
    expect(stageAllowsRole('apply', 'mutation')).toBe(true);
    expect(stageAllowsRole('apply', 'recall')).toBe(true);
    expect(stageAllowsRole('apply', 'other')).toBe(true);
  });
});

describe('planningExhausted', () => {
  it('fires at the budget, not before', () => {
    expect(planningExhausted(7, 8)).toBe(false);
    expect(planningExhausted(8, 8)).toBe(true);
    expect(planningExhausted(9, 8)).toBe(true);
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
