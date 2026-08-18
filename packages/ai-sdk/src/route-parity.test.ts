/**
 * The FramePilot 9.5 Phase-1 retirement gate
 * (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6.3).
 *
 * This suite is the evidence a human reads before approving the deletion of a mutating
 * execution route. It fails when the primary agent runtime regresses against `planned_edit`
 * on any dimension a deterministic scenario can actually measure, and it pins the waived
 * dimensions so an unmeasured one can never quietly become a claimed pass.
 */
import { describe, expect, it } from 'vitest';
import { ROUTE_PARITY_SCENARIOS } from './route-parity-scenarios.js';
import {
  ROUTE_PARITY_DIMENSIONS,
  runRouteParityScenario,
  serializeRouteParityRecords,
  summarizeRouteParityGate,
  type RouteParityRecord,
} from './route-parity.js';

async function allRecords(): Promise<readonly RouteParityRecord[]> {
  const records: RouteParityRecord[] = [];
  for (const scenario of ROUTE_PARITY_SCENARIOS) {
    records.push(await runRouteParityScenario(scenario));
  }
  return records;
}

describe('Phase-1 mutating-route parity', () => {
  it('covers every §6.3 gate dimension with at least one scenario or an explicit waiver', () => {
    const claimed = new Set(ROUTE_PARITY_SCENARIOS.flatMap((scenario) => scenario.proves));
    const uncovered = ROUTE_PARITY_DIMENSIONS.filter((dimension) => !claimed.has(dimension));
    // `outcome` and `latency` are the two dimensions a scripted provider structurally
    // cannot measure; anything else missing means the scenario set has a real hole.
    expect(uncovered).toEqual(['outcome', 'latency']);
  });

  it('shows no measured regression against planned_edit on any scenario', async () => {
    const records = await allRecords();
    const regressions = records.flatMap((record) =>
      record.dimensions
        .filter((result) => result.disposition === 'agent_worse')
        .map((result) => `${record.scenarioId}/${result.dimension}: ${result.reason}`),
    );
    expect(regressions).toEqual([]);
  });

  it('reaches an unblocked retirement verdict with the two known waivers named', async () => {
    const gate = summarizeRouteParityGate(await allRecords());
    expect(gate.blockers).toEqual([]);
    expect(gate.verdict).toBe('retirement_unblocked');
    expect(gate.waived.map((waiver) => waiver.dimension)).toEqual(['outcome', 'latency']);
    for (const waiver of gate.waived) {
      expect(waiver.reason).toContain('real-provider capture');
    }
  });

  it('proves the agent covers the beat-sync capability planned_edit was written for', async () => {
    const record = await runRouteParityScenario(
      ROUTE_PARITY_SCENARIOS.find((scenario) => scenario.id === 'beat-sync-montage')!,
    );
    expect(record.agent.operationKinds).toContain('add_clip');
    expect(record.agent.validated).toBe(true);
    expect(record.agent.reversible).toBe(true);
    const capability = record.dimensions.find((result) => result.dimension === 'capability');
    expect(capability?.disposition).not.toBe('agent_worse');
  });

  it('keeps a cancelled run cancelled on both routes without fabricated work', async () => {
    const record = await runRouteParityScenario(
      ROUTE_PARITY_SCENARIOS.find((scenario) => scenario.id === 'cancel-during-analysis')!,
    );
    expect(record.plannedEdit.terminalStatus).toBe('cancelled');
    expect(record.agent.terminalStatus).toBe('cancelled');
    expect(record.agent.operationKinds).toEqual([]);
  });

  it('never lets a malformed tool call reach the timeline on either route', async () => {
    const record = await runRouteParityScenario(
      ROUTE_PARITY_SCENARIOS.find((scenario) => scenario.id === 'invalid-tool-arguments')!,
    );
    expect(record.plannedEdit.operationKinds).toEqual([]);
    expect(record.agent.operationKinds).toEqual([]);
  });

  it('measures a real, non-zero model-call count on both routes', async () => {
    // Guards the `cost` dimension against the failure mode it is most prone to: a missing
    // telemetry wire-up makes both sides zero, and "0 === 0" reports as parity. A vacuous
    // pass here would be evidence for a deletion that nothing actually measured.
    const record = await runRouteParityScenario(
      ROUTE_PARITY_SCENARIOS.find((scenario) => scenario.id === 'silence-tighten')!,
    );
    expect(record.plannedEdit.metrics.modelCallCount).toBeGreaterThan(0);
    expect(record.agent.metrics.modelCallCount).toBeGreaterThan(0);
    // The bounded-planner cost argument for keeping `planned_edit` does not survive
    // measurement: the agent reaches the same edit in no more model calls.
    expect(record.agent.metrics.modelCallCount).toBeLessThanOrEqual(
      record.plannedEdit.metrics.modelCallCount,
    );
  });

  it('serializes records as stable JSON for the convergence evidence record', async () => {
    const json = serializeRouteParityRecords(await allRecords());
    const parsed: RouteParityRecord[] = JSON.parse(json);
    expect(parsed).toHaveLength(ROUTE_PARITY_SCENARIOS.length);
    expect(parsed[0]?.dimensions.length).toBe(ROUTE_PARITY_DIMENSIONS.length);
  });
});
