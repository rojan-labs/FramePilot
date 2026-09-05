/**
 * Tests for stage policy (plan/AGENT-TASK-MEMORY.md §3.2/§3.6, ADR 0075).
 *
 * Two rules carry the weight here and both are asserted directly: the stage is derived
 * from what a turn DID rather than what it said, and an executing run cannot reach the
 * tools that would restart reconnaissance.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRECONDITION_TOOL_NAMES,
  VALIDATOR_INPUT_TOOL_NAMES,
  settledStageFor,
  stageAdvanceFor,
  stageAllowsRole,
  stageAllowsTool,
  VERIFICATION_LOOK_TOOL_NAMES,
  toolRole,
} from './stage-policy.js';
import { TOOL_REGISTRY, getTool } from '../tool-registry.js';
import { RUN_STAGES, isExecutionStage } from './working-state.js';
import { BEAT_ANALYSIS_TOOL } from './beat-grid/beat-tool.js';

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
  /**
   * The same contract, read from where the incident actually came from.
   *
   * The description scan below is phrasing-dependent by construction — it has to guess
   * which sentences state an order — and it has already been widened twice after missing
   * the real thing. But run 7d159862's deadlock was not in a description at all: it was a
   * THROWN string, `"This project has no transcript yet ... Run transcribe first."`, from
   * inside `caption_the_edit`'s handler. A thrown remedy is a stronger promise than a
   * description: the model has just been refused and told exactly what to do about it.
   *
   * So this reads the handlers' source and needs no phrasing rule at all. Any registry
   * tool name appearing in a message a domain tool throws is a remedy that tool is
   * pointing at, and it must be reachable wherever the tool that names it is.
   *
   * Attributed per FILE rather than per handler: a file's tools share a domain, and
   * over-constraining within one domain is the safe direction for a guard whose whole
   * job is to fail closed.
   */
  it('never throws a remedy naming a tool the same stage withholds', () => {
    const domainToolsDir = fileURLToPath(new URL('../domain-tools', import.meta.url));
    const registryNames = TOOL_REGISTRY.map((t) => t.name);
    // Message text of every `throw new Error(...)` in the file, template literals and
    // concatenations included — the argument list up to the closing paren.
    const THROWN = /throw new Error\(([\s\S]*?)\);/g;

    for (const file of readdirSync(domainToolsDir)) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const source = readFileSync(join(domainToolsDir, file), 'utf8');
      const thrown = [...source.matchAll(THROWN)].map((m) => m[1] ?? '').join('\n');
      if (thrown === '') continue;
      const remedies = registryNames.filter((name) => new RegExp(`\\b${name}\\b`).test(thrown));
      if (remedies.length === 0) continue;
      // The tools this file defines, by the `name:` field of each spec in it.
      const defined = [...source.matchAll(/name: '([a-z_]+)'/g)]
        .map((m) => m[1]!)
        .filter((name) => registryNames.includes(name));

      for (const toolName of defined) {
        const tool = getTool(toolName);
        if (!tool) continue;
        for (const remedy of remedies) {
          if (remedy === toolName) continue;
          const remedySpec = getTool(remedy);
          if (!remedySpec) continue;
          for (const stage of RUN_STAGES) {
            if (!stageAllowsTool(stage, tool.name, tool.mutates)) continue;
            expect(
              stageAllowsTool(stage, remedy, remedySpec.mutates),
              `${file}: ${tool.name} is offered in "${stage}" and its handlers throw a message naming ${remedy}, which is withheld there`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('never offers a tool in a stage that withholds the tool its description requires', () => {
    // Both halves of this check used to be hand-written and both had holes wide
    // enough to miss the real thing. "First read get_mapped_transcript" and "it
    // needs get_mapped_transcript first" matched neither phrasing alternative,
    // and even if they had, the name extractor only recognised `discover_*`,
    // `get_timeline` and `search_*` — so the tool at the centre of run 7d159862
    // was invisible to the guard written to catch exactly its failure.
    //
    // Match any phrasing that states an order, and extract against the REGISTRY
    // rather than a pattern, so a newly named prerequisite cannot slip past.
    const PREREQUISITE =
      /(?:call (?:this|\w+) before|(?:use|read|run|call) \w+ first|needs \w+ first|first (?:read|run|call)|\bbefore you\b)/i;
    const registryNames = TOOL_REGISTRY.map((t) => t.name);
    const named = (description: string): readonly string[] =>
      registryNames.filter((name) => new RegExp(`\\b${name}\\b`).test(description));
    for (const tool of TOOL_REGISTRY) {
      if (!PREREQUISITE.test(tool.description)) continue;
      for (const prerequisite of named(tool.description)) {
        if (prerequisite === tool.name) continue;
        const prerequisiteSpec = getTool(prerequisite);
        if (!prerequisiteSpec) continue;
        for (const stage of RUN_STAGES) {
          // Ask the question the runtime actually asks — `stageAllowsTool`, not the
          // role alone — so a documented exemption counts as reachability and an
          // undocumented gap still fails.
          if (!stageAllowsTool(stage, tool.name, tool.mutates)) continue;
          expect(
            stageAllowsTool(stage, prerequisite, prerequisiteSpec.mutates),
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

  /**
   * The invariant behind run `ea8e46ec`, asserted against what the runtime ACTUALLY
   * validates rather than against a hand-written list.
   *
   * A guard that reads a tool's stored output and refuses a proposal over it is a contract
   * with the run. If the stage policy can run that guard while withholding the tool, the
   * contract is unkeepable: the run is refused, told what would satisfy the refusal, and
   * forbidden to do it. `ea8e46ec` spent 35 minutes there.
   *
   * `VALIDATOR_CONSUMED_TOOL_NAMES` is derived from the guards themselves, so a new
   * validator input fails here until the policy admits it.
   */
  it('never withholds a tool whose output a runtime validator judges proposals against', () => {
    // The beat-grid rule reads this tool's payload and refuses proposals over it, so the
    // policy must offer it wherever that rule runs — which is every stage.
    expect(VALIDATOR_INPUT_TOOL_NAMES.has(BEAT_ANALYSIS_TOOL)).toBe(true);
    for (const name of VALIDATOR_INPUT_TOOL_NAMES) {
      const spec = getTool(name);
      expect(spec, `${name} must be a registered tool`).toBeDefined();
      for (const stage of RUN_STAGES) {
        expect(
          stageAllowsTool(stage, name, spec?.mutates === true),
          `${name} feeds a runtime validator but is withheld in "${stage}"`,
        ).toBe(true);
      }
    }
  });

  it('exempts only the named carve-outs — every other analysis tool still closes', () => {
    const analysisTools = TOOL_REGISTRY.filter(
      (tool) => toolRole(tool.name, tool.mutates) === 'analysis',
    );
    // Three named carve-outs, each with a written incident: the validator input a guard
    // reads, the picture look that verifies an edit, and the precondition a mutation's own
    // refusal names. The lockout is the whole point of the execution stages, so the
    // exempted set must stay a small minority of the analysis surface.
    const exempt = new Set([
      ...VALIDATOR_INPUT_TOOL_NAMES,
      ...VERIFICATION_LOOK_TOOL_NAMES,
      ...PRECONDITION_TOOL_NAMES,
    ]);
    expect(analysisTools.length).toBeGreaterThan(exempt.size * 2);
    for (const tool of analysisTools) {
      if (exempt.has(tool.name)) continue;
      for (const stage of RUN_STAGES.filter(isExecutionStage)) {
        expect(
          stageAllowsTool(stage, tool.name, tool.mutates),
          `${tool.name} is not a named carve-out and must stay withheld in "${stage}"`,
        ).toBe(false);
      }
    }
  });

  it('reaches every precondition tool in every stage', () => {
    // The property that makes the set legitimate rather than a convenience list:
    // some registered mutation must name the tool as the remedy for its own refusal.
    for (const name of PRECONDITION_TOOL_NAMES) {
      const spec = getTool(name);
      expect(spec, `${name} must be a registered tool`).toBeDefined();
      const demanded = TOOL_REGISTRY.some(
        (tool) => tool.mutates && new RegExp(`\\b${name}\\b`).test(tool.description),
      );
      expect(demanded, `${name} is exempt but no mutation names it as a precondition`).toBe(true);
      for (const stage of RUN_STAGES) {
        expect(
          stageAllowsTool(stage, name, spec?.mutates === true),
          `${name} is a stated precondition but is withheld in "${stage}"`,
        ).toBe(true);
      }
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

describe('verification looks in execution stages (plan/system-mission P1.1b)', () => {
  it('offers get_frame in apply/enhance/repair so a run can check the edit it just made', () => {
    for (const stage of ['apply', 'enhance', 'repair'] as const) {
      expect(stageAllowsTool(stage, 'get_frame', false)).toBe(true);
      // Same tool with numbers instead of pixels — `tool-contract.ts` gives the two an
      // identical entry. Run `137d8fd0` asked to "measure what's actually on screen",
      // called this twice in `apply`, and was refused both times; the grade went in blind.
      expect(stageAllowsTool(stage, 'measure_color', false)).toBe(true);
      // The rule is narrow: other analysis stays withheld in execution stages.
      expect(stageAllowsTool(stage, 'map_footage', false)).toBe(false);
      expect(stageAllowsTool(stage, 'describe_footage', false)).toBe(false);
    }
  });

  it('keeps the set minimal — the picture look, in pixels and in numbers', () => {
    expect([...VERIFICATION_LOOK_TOOL_NAMES]).toEqual(['get_frame', 'measure_color']);
  });
});
