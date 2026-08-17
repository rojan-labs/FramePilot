import { describe, expect, it } from 'vitest';
import type { AiEvent } from './events.js';
import { buildAgentOutcomeEvalRunRecord, captureAgentRunQuality } from './agent-run-quality.js';
import { AGENT_OUTCOME_EVAL_SCENARIOS } from './professional-agent-evals.js';

function terminalEvent(status: 'completed' | 'failed' | 'cancelled'): AiEvent {
  return {
    id: `status-${status}`,
    conversationId: 'conversation',
    turnId: 'turn',
    ts: 10,
    type: 'status',
    status,
  };
}

function passingObservations(scenario: (typeof AGENT_OUTCOME_EVAL_SCENARIOS)[number]) {
  return {
    hardConstraints: scenario.expectedHardConstraints.map((predicate) => ({ predicate, passed: true })),
    finalStatePredicates: scenario.expectedFinalStatePredicates.map((predicate) => ({
      predicate,
      passed: true,
    })),
  };
}

describe('agent outcome terminal status contracts', () => {
  it('rejects a failed terminal status for an ordinary edit scenario', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS.find((row) => row.id === 'A01-trim');
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error('Expected A01 scenario.');

    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [terminalEvent('failed')],
      operations: { attempted: 1, applied: 1, rejected: 0 },
      projectRevisionBefore: 4,
      projectRevisionAfter: 5,
      deterministicValidation: 'passed',
    });
    const record = buildAgentOutcomeEvalRunRecord({
      scenario,
      ...passingObservations(scenario),
      metrics,
      inspectionObserved: true,
    });

    expect(record.status).toBe('failed');
    expect(record.failures).toContain(
      'Terminal run outcome "failed" is not accepted for scenario A01-trim.',
    );
  });

  it('accepts cancellation only for the adversarial scenario that requests cancellation', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS.find((row) => row.id === 'E05-cancel-analysis');
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error('Expected E05 scenario.');

    const cancelledMetrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [terminalEvent('cancelled')],
      operations: { attempted: 0, applied: 0, rejected: 0 },
      projectRevisionBefore: 4,
      projectRevisionAfter: 4,
      cancellationIntegrity: 'passed',
    });
    const completedMetrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [terminalEvent('completed')],
      operations: { attempted: 0, applied: 0, rejected: 0 },
      projectRevisionBefore: 4,
      projectRevisionAfter: 4,
    });

    const cancelledRecord = buildAgentOutcomeEvalRunRecord({
      scenario,
      ...passingObservations(scenario),
      metrics: cancelledMetrics,
      inspectionObserved: true,
    });
    const completedRecord = buildAgentOutcomeEvalRunRecord({
      scenario,
      ...passingObservations(scenario),
      metrics: completedMetrics,
      inspectionObserved: true,
    });

    expect(cancelledRecord.status).toBe('passed');
    expect(completedRecord.status).toBe('failed');
    expect(completedRecord.failures).toContain(
      'Terminal run outcome "completed" is not accepted for scenario E05-cancel-analysis.',
    );
  });
});
