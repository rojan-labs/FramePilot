/**
 * Conformance suite for FramePilot's single mutating AI runtime
 * (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6, ADR 0126).
 *
 * These are the invariants the Phase-1 parity gate proved before `planned_edit` was retired
 * (evidence: `docs/architecture/FRAMEPILOT-95-ROUTE-PARITY-EVIDENCE.md`). They are asserted
 * here so the convergence cannot silently rot: the one runtime must keep covering the
 * analysis-then-mutate work, cancelling honestly, refusing malformed calls at the trust
 * boundary, and producing only reversible, validated patches.
 */
import { describe, expect, it } from 'vitest';
import { RUNTIME_CONFORMANCE_SCENARIOS } from './mutating-runtime-conformance-scenarios.js';
import {
  conformanceViolations,
  observeRuntimeScenario,
  serializeRuntimeObservations,
  type RuntimeObservation,
} from './mutating-runtime-conformance.js';
import { EDITOR_RUN_ROUTE_POLICY, EditorRunRouteSchema } from './kernel/editor-run-lifecycle.js';
import { CommandClassificationSchema } from './kernel/command-classifier.js';

async function observeAll(): Promise<readonly (readonly [string, RuntimeObservation])[]> {
  const entries: (readonly [string, RuntimeObservation])[] = [];
  for (const scenario of RUNTIME_CONFORMANCE_SCENARIOS) {
    entries.push([scenario.id, await observeRuntimeScenario(scenario)]);
  }
  return entries;
}

describe('single mutating AI runtime — conformance', () => {
  it('satisfies every scenario expectation and runtime-wide invariant', async () => {
    const observed = await observeAll();
    const violations = observed.flatMap(([id, observation]) => {
      const scenario = RUNTIME_CONFORMANCE_SCENARIOS.find((row) => row.id === id)!;
      return conformanceViolations(scenario, observation).map(
        (violation) => `${violation.scenarioId}: ${violation.detail}`,
      );
    });
    expect(violations).toEqual([]);
  });

  it('covers the beat-sync capability the retired planned_edit route was written for', async () => {
    const scenario = RUNTIME_CONFORMANCE_SCENARIOS.find((row) => row.id === 'beat-sync-montage')!;
    const observed = await observeRuntimeScenario(scenario);
    expect(observed.operationKinds).toEqual(['add_clip', 'add_clip']);
    expect(observed.validated).toBe(true);
    expect(observed.reversible).toBe(true);
  });

  it('settles a run cancelled mid-analysis as cancelled, with nothing proposed', async () => {
    const scenario = RUNTIME_CONFORMANCE_SCENARIOS.find(
      (row) => row.id === 'cancel-during-analysis',
    )!;
    const observed = await observeRuntimeScenario(scenario);
    expect(observed.terminalStatus).toBe('cancelled');
    expect(observed.operationKinds).toEqual([]);
    expect(observed.eventKinds).not.toContain('diff');
  });

  it('rejects malformed tool arguments at the trust boundary before any host dispatch', async () => {
    // This is the safety gap that retiring `planned_edit` closed. The planner path built
    // `{ kind: 'host_tool', call }` straight from Planner-authored plan-step arguments and
    // dispatched them to the host analysis engine with no schema check; the agent runtime
    // parses every analysis/action call against its Zod schema first. `dispatched` proves
    // the host never saw the bad call — not merely that the timeline was unchanged.
    const dispatched: string[] = [];
    const observed = await observeRuntimeScenario({
      ...RUNTIME_CONFORMANCE_SCENARIOS.find((row) => row.id === 'invalid-tool-arguments')!,
      executor: () => ({
        async run(call) {
          dispatched.push(`${call.name}:${JSON.stringify(call.arguments)}`);
          return call.name === 'analyze_silence'
            ? {
                status: 'completed' as const,
                summary: 'Found 1 silent range',
                data: { ranges: [{ start: 2, end: 3 }] },
              }
            : { status: 'failed' as const, summary: `unexpected tool "${call.name}"` };
        },
      }),
    });
    expect(observed.operationKinds).toEqual([]);
    expect(dispatched).toEqual(['analyze_silence:{"assetId":"asset_1"}']);
  });

  it('reports a failed run with a machine-readable diagnostic on every scenario', async () => {
    for (const [id, observation] of await observeAll()) {
      expect(observation.reportedItsFailure, `${id} settled failed with no diagnostic`).toBe(true);
      expect(observation.reviewWroteNothing, `${id} let review author an edit`).toBe(true);
    }
  });

  it('leaves exactly one mutating AI execution route in the run contracts', () => {
    // The convergence claim, asserted against the schemas hosts actually validate against
    // rather than against prose. `edit` is the single-shot Cmd+K proposal surface; `agent`
    // is the mutating runtime. `planned_edit` is gone from both the lifecycle route enum
    // and the command classifier's route set.
    expect(EditorRunRouteSchema.options).toEqual(['edit', 'agent']);
    expect(Object.keys(EDITOR_RUN_ROUTE_POLICY)).toEqual(['edit', 'agent']);
    expect(CommandClassificationSchema.shape.route.options).toEqual([
      'chitchat',
      'question',
      'edit',
    ]);
  });

  it('serializes observations as stable JSON for the convergence evidence record', async () => {
    const parsed: Record<string, RuntimeObservation> = JSON.parse(
      serializeRuntimeObservations(await observeAll()),
    );
    expect(Object.keys(parsed)).toEqual(RUNTIME_CONFORMANCE_SCENARIOS.map((row) => row.id));
    expect(parsed['silence-tighten']?.metrics.modelCallCount).toBeGreaterThan(0);
  });
});
