import { describe, expect, it } from 'vitest';
import { PROFESSIONAL_EVAL_CASES } from './professional-eval-cases.js';
import { runProfessionalEvalCase } from './professional-evals.js';
import {
  AGENT_OUTCOME_EVAL_SCENARIOS,
  AGENT_OUTCOME_EVAL_TIERS,
  agentOutcomeEvalDriftIssues,
} from './professional-agent-evals.js';

describe('FramePilot 9.5 agent outcome benchmark manifest', () => {
  it('freezes fifty canonical scenarios with ten rows in every tier', () => {
    expect(AGENT_OUTCOME_EVAL_SCENARIOS).toHaveLength(50);
    for (const tier of AGENT_OUTCOME_EVAL_TIERS) {
      expect(AGENT_OUTCOME_EVAL_SCENARIOS.filter((row) => row.tier === tier)).toHaveLength(10);
    }
    expect(new Set(AGENT_OUTCOME_EVAL_SCENARIOS.map((row) => row.id)).size).toBe(50);
  });

  it('requires outcome predicates, hard constraints and bounded revision expectations', () => {
    for (const scenario of AGENT_OUTCOME_EVAL_SCENARIOS) {
      expect(scenario.expectedFinalStatePredicates.length).toBeGreaterThan(0);
      expect(scenario.expectedHardConstraints.length).toBeGreaterThan(0);
      expect(scenario.maxToleratedRevisionCount).toBeGreaterThanOrEqual(0);
      if (scenario.executionCoverage !== 'contract') {
        expect(scenario.linkedFixtureId).toBeTruthy();
      }
    }
  });

  it('has no release-registration drift', () => {
    expect(agentOutcomeEvalDriftIssues()).toEqual([]);
  });

  it('executes linked deterministic rows through the existing professional eval runner', async () => {
    const linkedFixtureIds = new Set(
      AGENT_OUTCOME_EVAL_SCENARIOS.filter(
        (row) => row.executionCoverage === 'professional_eval' && row.linkedFixtureId,
      ).map((row) => row.linkedFixtureId as string),
    );
    const cases = PROFESSIONAL_EVAL_CASES.filter((evalCase) =>
      linkedFixtureIds.has(evalCase.fixtureId),
    );
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const evalCase of cases) {
      const result = await runProfessionalEvalCase(evalCase);
      expect(result.status, `${evalCase.fixtureId}: ${result.failures.join('; ')}`).toBe('passed');
      expect(result.stages).toContain('persist_reload');
      expect(result.stages).toContain('cross_host');
    }
  });
});
