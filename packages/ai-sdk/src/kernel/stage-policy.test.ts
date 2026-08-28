/**
 * Tests for stage policy (plan/AGENT-TASK-MEMORY.md §3.2/§3.6, ADR 0075).
 *
 * Two rules carry the weight here and both are asserted directly: the stage is derived
 * from what a turn DID rather than what it said, and an executing run cannot reach the
 * tools that would restart reconnaissance.
 */
import { describe, expect, it } from 'vitest';
import {
  settledStageFor,
  stageAdvanceFor,
  stageAllowsRole,
  toolRole,
} from './stage-policy.js';
import { TOOL_REGISTRY, getTool } from '../tool-registry.js';
import { RUN_STAGES } from './working-state.js';

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
    // Guidance is NOT closed (GAP-006's sibling, GAP-008). It is static reference data —
    // the shipped effect and transition catalogs, the playbooks, the remembered
    // preferences — not observation of the material, so there is nothing stored to recall
    // in its place. Withholding it took `discover_transitions` away from an executing run
    // while leaving `add_transition`, whose own description says the ids are not guessable.
    expect(stageAllowsRole(stage, toolRole('discover_transitions', false))).toBe(true);
    expect(stageAllowsRole(stage, toolRole('discover_effects', false))).toBe(true);
    expect(stageAllowsRole(stage, toolRole('load_skill', false))).toBe(true);
    // But the CURRENT arrangement stays readable: a patch needs live clip ids.
    expect(stageAllowsRole(stage, toolRole('get_timeline', false))).toBe(true);
    // And recall always works — that is the way back to the stored payload.
    expect(stageAllowsRole(stage, toolRole('recall_evidence', false))).toBe(true);
  });

  /**
   * The invariant behind GAP-008, asserted against the registry rather than against a
   * hand-written list.
   *
   * A tool description that says "call X first" is a contract with the model. If the
   * stage policy can offer the tool while withholding X, the contract is unkeepable and
   * the model is left to invent an id that the validator will refuse — which is exactly
   * what an executing run faced with `add_transition` and no `discover_transitions` had
   * to do. Whenever a prerequisite is NAMED in a description, it must be reachable in
   * every stage the tool itself is reachable in.
   */
  it('never offers a tool in a stage that withholds the tool its description requires', () => {
    const PREREQUISITE = /(?:call (?:this|\w+) before|use (\w+) first)/i;
    const named = (description: string): readonly string[] =>
      [...description.matchAll(/\b(discover_[a-z_]+|get_timeline|search_[a-z_]+)\b/g)].map(
        (m) => m[1]!,
      );
    for (const tool of TOOL_REGISTRY) {
      if (!PREREQUISITE.test(tool.description)) continue;
      for (const prerequisite of named(tool.description)) {
        const prerequisiteSpec = getTool(prerequisite);
        if (!prerequisiteSpec) continue;
        for (const stage of RUN_STAGES) {
          const toolRoleHere = toolRole(tool.name, tool.mutates);
          const prerequisiteRole = toolRole(prerequisite, prerequisiteSpec.mutates);
          if (!stageAllowsRole(stage, toolRoleHere)) continue;
          expect(
            stageAllowsRole(stage, prerequisiteRole),
            `${tool.name} is offered in "${stage}" but its stated prerequisite ${prerequisite} is not`,
          ).toBe(true);
        }
      }
    }
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

  it('closes fresh reconnaissance of the MATERIAL once the plan is locked', () => {
    for (const stage of ['apply', 'enhance', 'repair'] as const) {
      expect(stageAllowsRole(stage, 'analysis')).toBe(false);
      // Reference data is not reconnaissance: a catalog the run never read has nothing
      // stored to recall, and the mutators that require its ids stay on offer.
      expect(stageAllowsRole(stage, 'guidance')).toBe(true);
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
