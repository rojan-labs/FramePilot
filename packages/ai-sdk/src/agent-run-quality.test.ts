import { describe, expect, it } from 'vitest';
import type { ContextInput } from './context-builder.js';
import type { AiEvent } from './events.js';
import { BaselineCaptureProvider } from './kernel/cost/baseline-capture.js';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import { makeProject } from './__fixtures__/project.js';
import {
  buildAgentOutcomeEvalRunRecord,
  captureAgentRunQuality,
  serializeAgentOutcomeEvalRunRecords,
  summarizeAgentOutcomeRuns,
} from './agent-run-quality.js';
import { AGENT_OUTCOME_EVAL_SCENARIOS } from './professional-agent-evals.js';

class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;

  public constructor(private readonly responses: readonly AiResponse[]) {}

  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response as AiResponse;
  }
}

class AbortingProvider implements AiProvider {
  public readonly name = 'mock' as const;

  public constructor(private readonly controller: AbortController) {}

  public async complete(): Promise<AiResponse> {
    this.controller.abort();
    return { text: 'cancelled partial analysis', toolCalls: [] };
  }
}

async function drain(stream: AsyncGenerator<AiEvent>): Promise<readonly AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function streamOptions(signal?: AbortSignal): StreamOptions {
  let now = 1_000;
  return {
    conversationId: 'foundation-conversation',
    turnId: 'foundation-turn',
    now: () => {
      now += 5;
      return now;
    },
    ...(signal ? { signal } : {}),
  };
}

function proposedOperationCount(events: readonly AiEvent[]): number {
  return events
    .filter((event): event is Extract<AiEvent, { type: 'diff' }> => event.type === 'diff')
    .reduce((sum, event) => sum + event.edit.patch.operations.length, 0);
}

function completedStatus(ts = 10): Extract<AiEvent, { type: 'status' }> {
  return {
    id: `status-${String(ts)}`,
    conversationId: 'conversation',
    turnId: 'turn',
    ts,
    type: 'status',
    status: 'completed',
  };
}

describe('FramePilot 9.5 agent run quality telemetry', () => {
  it('records provider and proposal metrics without fabricating host settlement evidence', async () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS.find((row) => row.id === 'A01-trim');
    expect(scenario).toBeDefined();
    const scripted = new ScriptedProvider([
      {
        text: 'Tightening the selected opening.',
        toolCalls: [
          {
            id: 'foundation-delete',
            name: 'delete_range',
            arguments: { trackId: 'video_1', start: 0, end: 2 },
          },
        ],
      },
      { text: 'Done.', toolCalls: [] },
    ]);
    let providerNow = 0;
    const provider = new BaselineCaptureProvider(scripted, {
      now: () => {
        providerNow += 7;
        return providerNow;
      },
    });
    const input: ContextInput = {
      project: makeProject(),
      userPrompt: scenario?.task ?? 'Trim the opening.',
    };
    const events = await drain(new Orchestrator(provider).streamAgent(input, streamOptions(), {}));
    const proposed = proposedOperationCount(events);
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events,
      capturedTurns: provider.captured(),
      toolSchemasExposedPerTurn: [1, 1],
      operations: { attempted: proposed, applied: 0, rejected: 0 },
      projectRevisionBefore: 0,
      projectRevisionAfter: 0,
      wallClockMs: 42,
      deterministicValidation: 'not_run',
      renderEvidence: 'not_run',
    });

    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(events.some((event) => event.type === 'status' && event.status === 'completed')).toBe(true);
    expect(metrics.routeMode).toBe('agent');
    expect(metrics.models).toEqual([{ provider: 'mock' }]);
    expect(metrics.modelCallCount).toBe(2);
    expect(metrics.toolCallCount).toBe(1);
    expect(metrics.operations.attempted).toBeGreaterThan(0);
    expect(metrics.operations.applied).toBe(0);
    expect(metrics.revisions).toEqual({ before: 0, after: 0 });
    expect(metrics.deterministicValidation).toBe('not_run');
    expect(metrics.wallClockMs).toBe(42);
    expect(metrics.runOutcome).toBe('completed');
    expect(metrics.cancellation.state).toBe('not_cancelled');
  });

  it('records cancellation without turning a stopped analysis into a failed or successful run', async () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS.find((row) => row.id === 'E05-cancel-analysis');
    expect(scenario).toBeDefined();
    const controller = new AbortController();
    let providerNow = 0;
    const provider = new BaselineCaptureProvider(new AbortingProvider(controller), {
      now: () => {
        providerNow += 3;
        return providerNow;
      },
    });
    const input: ContextInput = {
      project: makeProject(),
      userPrompt: scenario?.task ?? 'Analyze the intro.',
    };
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, streamOptions(controller.signal), {}),
    );
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events,
      capturedTurns: provider.captured(),
      toolSchemasExposedPerTurn: [1],
      operations: { attempted: 0, applied: 0, rejected: 0 },
      projectRevisionBefore: 0,
      projectRevisionAfter: 0,
      cancellationLatencyMs: 0,
      cancellationIntegrity: 'passed',
      deterministicValidation: 'not_run',
      renderEvidence: 'not_run',
    });

    expect(metrics.runOutcome).toBe('cancelled');
    expect(metrics.cancellation).toEqual({
      state: 'cancelled',
      latencyMs: 0,
      integrity: 'passed',
    });
    expect(metrics.operations.applied).toBe(0);
    expect(events.some((event) => event.type === 'status' && event.status === 'failed')).toBe(false);
  });

  it('grades required execution evidence into a serializable eval artifact', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS[0];
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [completedStatus(10), completedStatus(25)],
      operations: { attempted: 1, applied: 1, rejected: 0 },
      projectRevisionBefore: 4,
      projectRevisionAfter: 5,
      deterministicValidation: 'passed',
      renderEvidence: 'not_run',
    });
    const hardConstraints = scenario.expectedHardConstraints.map((predicate) => ({
      predicate,
      passed: true,
    }));
    const finalStatePredicates = scenario.expectedFinalStatePredicates.map((predicate) => ({
      predicate,
      passed: true,
    }));
    const record = buildAgentOutcomeEvalRunRecord({
      scenario,
      hardConstraints,
      finalStatePredicates,
      metrics,
      inspectionObserved: true,
    });

    expect(record.status).toBe('passed');
    expect(record.executionEvidence).toEqual({
      inspection: 'observed',
      review: 'not_required',
      revisionCount: 1,
    });
    const serialized = serializeAgentOutcomeEvalRunRecords([record]);
    expect(JSON.parse(serialized)).toEqual([record]);
    expect(serialized).toContain('toolSchemasExposedPerTurn');
    expect(serialized).toContain('deterministicValidation');
  });

  it('fails closed when required inspection, review, revision or terminal evidence is missing', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS.find((row) => row.id === 'B01-remove-silence');
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error('Expected B01 scenario.');
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [],
      deterministicValidation: 'not_run',
      renderEvidence: 'not_run',
    });
    const record = buildAgentOutcomeEvalRunRecord({
      scenario,
      hardConstraints: scenario.expectedHardConstraints.map((predicate) => ({ predicate, passed: true })),
      finalStatePredicates: scenario.expectedFinalStatePredicates.map((predicate) => ({ predicate, passed: true })),
      metrics,
    });

    expect(record.status).toBe('failed');
    expect(record.failures).toEqual(
      expect.arrayContaining([
        'Required inspection evidence was not observed.',
        'Required review evidence was not observed.',
        'Project revision range was not observed.',
        'Terminal run outcome was not observed.',
      ]),
    );
  });

  it('enforces the scenario revision budget and failed render evidence', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS[0];
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [completedStatus()],
      projectRevisionBefore: 4,
      projectRevisionAfter: 6,
      deterministicValidation: 'passed',
      renderEvidence: 'failed',
    });
    const record = buildAgentOutcomeEvalRunRecord({
      scenario,
      hardConstraints: scenario.expectedHardConstraints.map((predicate) => ({ predicate, passed: true })),
      finalStatePredicates: scenario.expectedFinalStatePredicates.map((predicate) => ({ predicate, passed: true })),
      metrics,
      inspectionObserved: true,
    });

    expect(record.status).toBe('failed');
    expect(record.failures).toEqual(
      expect.arrayContaining([
        'Project revision count 2 exceeded the tolerated maximum 1.',
        'Render/media evidence failed.',
      ]),
    );
  });

  it('keeps unavailable render, latency and cancellation-integrity evidence out of denominators', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS[0];
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [completedStatus()],
      operations: { attempted: 0, applied: 0, rejected: 0 },
      projectRevisionBefore: 0,
      projectRevisionAfter: 0,
      deterministicValidation: 'not_run',
      renderEvidence: 'unavailable',
    });
    const record = buildAgentOutcomeEvalRunRecord({
      scenario,
      hardConstraints: scenario.expectedHardConstraints.map((predicate) => ({ predicate, passed: true })),
      finalStatePredicates: scenario.expectedFinalStatePredicates.map((predicate) => ({ predicate, passed: true })),
      metrics,
      inspectionObserved: true,
    });
    const score = summarizeAgentOutcomeRuns([record]);

    expect(record.status).toBe('passed');
    expect(score.tierSuccessRate.A).toBe(1);
    expect(score.tierSuccessRate.B).toBeUndefined();
    expect(score.renderValidity).toBeUndefined();
    expect(score.cancellationIntegrity).toBeUndefined();
    expect(score.latencyMs).toEqual({});
  });

  it('only scores cancellation integrity when it was explicitly observed', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS.find((row) => row.id === 'E05-cancel-analysis');
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error('Expected E05 scenario.');
    const events: AiEvent[] = [
      {
        id: 'cancelled',
        conversationId: 'conversation',
        turnId: 'turn',
        ts: 10,
        type: 'status',
        status: 'cancelled',
      },
    ];
    const withoutIntegrity = captureAgentRunQuality({
      routeMode: 'agent',
      events,
      projectRevisionBefore: 0,
      projectRevisionAfter: 0,
    });
    const withIntegrity = captureAgentRunQuality({
      routeMode: 'agent',
      events,
      projectRevisionBefore: 0,
      projectRevisionAfter: 0,
      cancellationIntegrity: 'passed',
    });
    const observations = {
      hardConstraints: scenario.expectedHardConstraints.map((predicate) => ({ predicate, passed: true })),
      finalStatePredicates: scenario.expectedFinalStatePredicates.map((predicate) => ({ predicate, passed: true })),
    };
    const recordWithoutIntegrity = buildAgentOutcomeEvalRunRecord({
      scenario,
      ...observations,
      metrics: withoutIntegrity,
      inspectionObserved: true,
    });
    const recordWithIntegrity = buildAgentOutcomeEvalRunRecord({
      scenario,
      ...observations,
      metrics: withIntegrity,
      inspectionObserved: true,
    });

    expect(summarizeAgentOutcomeRuns([recordWithoutIntegrity]).cancellationIntegrity).toBeUndefined();
    expect(summarizeAgentOutcomeRuns([recordWithIntegrity]).cancellationIntegrity).toBe(1);
  });

  it('rejects fabricated or invalid metric values instead of coercing them to zero', () => {
    expect(() =>
      captureAgentRunQuality({
        routeMode: 'agent',
        events: [],
        repairAttemptCount: -1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      captureAgentRunQuality({
        routeMode: 'agent',
        events: [],
        wallClockMs: Number.NaN,
      }),
    ).toThrow(RangeError);
    expect(() =>
      captureAgentRunQuality({
        routeMode: 'agent',
        events: [],
        humanEditorialScore: 1.1,
      }),
    ).toThrow(RangeError);
  });
});
