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

function operationCount(events: readonly AiEvent[]): number {
  return events
    .filter((event): event is Extract<AiEvent, { type: 'diff' }> => event.type === 'diff')
    .reduce((sum, event) => sum + event.edit.patch.operations.length, 0);
}

describe('FramePilot 9.5 agent run quality telemetry', () => {
  it('records the complete metric surface on a production-like mutating agent run', async () => {
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
    const applied = operationCount(events);
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events,
      capturedTurns: provider.captured(),
      toolSchemasExposedPerTurn: [1, 1],
      operations: { attempted: applied, applied, rejected: 0 },
      projectRevisionBefore: 0,
      projectRevisionAfter: applied > 0 ? 1 : 0,
      deterministicValidation: 'passed',
      renderEvidence: 'not_run',
    });

    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(events.some((event) => event.type === 'status' && event.status === 'completed')).toBe(true);
    expect(metrics.routeMode).toBe('agent');
    expect(metrics.models).toEqual([{ provider: 'mock' }]);
    expect(metrics.modelCallCount).toBe(2);
    expect(metrics.toolCallCount).toBe(1);
    expect(metrics.operations.applied).toBeGreaterThan(0);
    expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);
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
      deterministicValidation: 'not_run',
      renderEvidence: 'not_run',
    });

    expect(metrics.runOutcome).toBe('cancelled');
    expect(metrics.cancellation).toEqual({ state: 'cancelled', latencyMs: 0 });
    expect(metrics.operations.applied).toBe(0);
    expect(events.some((event) => event.type === 'status' && event.status === 'failed')).toBe(false);
  });

  it('grades hard constraints and semantic predicates into a serializable eval artifact', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS[0];
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [
        {
          id: 'status-1',
          conversationId: 'conversation',
          turnId: 'turn',
          ts: 10,
          type: 'status',
          status: 'completed',
        },
        {
          id: 'status-2',
          conversationId: 'conversation',
          turnId: 'turn',
          ts: 25,
          type: 'status',
          status: 'completed',
        },
      ],
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
    });

    expect(record.status).toBe('passed');
    const serialized = serializeAgentOutcomeEvalRunRecords([record]);
    expect(JSON.parse(serialized)).toEqual([record]);
    expect(serialized).toContain('toolSchemasExposedPerTurn');
    expect(serialized).toContain('deterministicValidation');
  });

  it('keeps unavailable subjective/render evidence out of top-line denominators', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS[0];
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events: [],
      operations: { attempted: 0, applied: 0, rejected: 0 },
      deterministicValidation: 'not_run',
      renderEvidence: 'unavailable',
    });
    const record = buildAgentOutcomeEvalRunRecord({
      scenario,
      hardConstraints: scenario.expectedHardConstraints.map((predicate) => ({ predicate, passed: true })),
      finalStatePredicates: scenario.expectedFinalStatePredicates.map((predicate) => ({ predicate, passed: true })),
      metrics,
    });
    const score = summarizeAgentOutcomeRuns([record]);

    expect(score.tierSuccessRate.A).toBe(1);
    expect(score.tierSuccessRate.B).toBeUndefined();
    expect(score.renderValidity).toBeUndefined();
    expect(score.latencyMs).toEqual({});
  });

  it('rejects fabricated out-of-range human editorial scores', () => {
    expect(() =>
      captureAgentRunQuality({
        routeMode: 'agent',
        events: [],
        humanEditorialScore: 1.1,
      }),
    ).toThrow(RangeError);
  });
});
