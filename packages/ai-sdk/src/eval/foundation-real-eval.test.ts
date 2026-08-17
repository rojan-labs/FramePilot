/**
 * Hermetic coverage for the Foundation real-provider eval runner. No network call is made
 * anywhere in this file — `runFoundationRealEval`'s `buildProvider` dependency is always
 * injected with a scripted, in-process `AiProvider`. The live-Gemini construction glue in
 * `defaultBuildProvider` (module-private) is intentionally not exercised here; there is no
 * way to unit-test a real network call without making one.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../providers/types.js';
import { summarizeAgentOutcomeRuns, type AgentOutcomeTopLineScore } from '../agent-run-quality.js';
import { AGENT_OUTCOME_EVAL_SCENARIOS } from '../professional-agent-evals.js';
import {
  FOUNDATION_REAL_EVAL_TIERS,
  buildRealEvalRunRecord,
  buildScenarioContextInput,
  renderFoundationRealEvalJobSummary,
  requireGoogleApiKey,
  runFoundationRealEval,
  selectFoundationRealEvalScenarios,
  writeFoundationRealEvalArtifacts,
} from './foundation-real-eval.js';

class ScriptedProvider implements AiProvider {
  public readonly name = 'google' as const;
  public readonly modelId = 'gemini-2.5-flash-scripted';
  private index = 0;

  public constructor(private readonly responses: readonly AiResponse[]) {}

  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response as AiResponse;
  }
}

describe('selectFoundationRealEvalScenarios', () => {
  it('keeps only Tier B, C and D scenarios from the canonical manifest', () => {
    const selected = selectFoundationRealEvalScenarios();
    expect(selected.length).toBe(30);
    for (const scenario of selected) {
      expect(FOUNDATION_REAL_EVAL_TIERS).toContain(scenario.tier);
    }
    expect(selected.some((scenario) => scenario.tier === 'A')).toBe(false);
    expect(selected.some((scenario) => scenario.tier === 'E')).toBe(false);
  });
});

describe('buildScenarioContextInput', () => {
  it('carries the scenario task as the prompt against the shared fixture project', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS.find((row) => row.id === 'B01-remove-silence');
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error('expected B01 scenario');
    const input = buildScenarioContextInput(scenario);
    expect(input.userPrompt).toBe(scenario.task);
    expect(input.project.timeline.tracks.length).toBeGreaterThan(0);
  });
});

describe('requireGoogleApiKey', () => {
  it('throws an actionable error when GOOGLE_API_KEY is unset', () => {
    expect(() => requireGoogleApiKey({})).toThrow(/GOOGLE_API_KEY is not set/);
  });

  it('throws when GOOGLE_API_KEY is present but blank', () => {
    expect(() => requireGoogleApiKey({ GOOGLE_API_KEY: '   ' })).toThrow(/GOOGLE_API_KEY is not set/);
  });

  it('returns the key when set', () => {
    expect(requireGoogleApiKey({ GOOGLE_API_KEY: 'test-key' })).toBe('test-key');
  });
});

describe('buildRealEvalRunRecord', () => {
  it('fails closed with no fabricated predicate or revision evidence, while keeping real metrics', () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS.find((row) => row.id === 'B01-remove-silence');
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error('expected B01 scenario');
    const record = buildRealEvalRunRecord(scenario, {
      events: [
        {
          id: 'status-1',
          conversationId: 'c',
          turnId: 't',
          ts: 10,
          type: 'status',
          status: 'completed',
        },
      ],
      capturedTurns: [
        {
          provider: 'google',
          modelId: 'gemini-2.5-flash',
          streamed: false,
          ttftMs: 500,
          wallMs: 500,
          inputTokens: 120,
          outputTokens: 40,
        },
      ],
      wallClockMs: 500,
    });

    expect(record.status).toBe('failed');
    expect(record.failures).toContain('Project revision range was not observed.');
    expect(record.hardConstraints).toEqual([]);
    expect(record.finalStatePredicates).toEqual([]);
    // Real telemetry is preserved even though the scenario fails closed.
    expect(record.metrics.wallClockMs).toBe(500);
    expect(record.metrics.modelCallCount).toBe(1);
    expect(record.metrics.tokens).toEqual({ input: 120, output: 40 });
    expect(record.metrics.runOutcome).toBe('completed');
  });
});

describe('writeFoundationRealEvalArtifacts', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'foundation-real-eval-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('writes a timestamped file and a stable latest.json pointer with the same content', async () => {
    const scenario = AGENT_OUTCOME_EVAL_SCENARIOS[10];
    const record = buildRealEvalRunRecord(scenario, {
      events: [],
      capturedTurns: [],
      wallClockMs: 100,
    });
    const summary = summarizeAgentOutcomeRuns([record]);
    const date = new Date('2026-08-17T12:00:00.000Z');

    const { outputPath, latestPath } = await writeFoundationRealEvalArtifacts(
      outDir,
      [record],
      summary,
      date,
    );

    expect(outputPath).toContain(outDir);
    expect(latestPath).toBe(join(outDir, 'latest.json'));
    const timestamped = await readFile(outputPath, 'utf8');
    const latest = await readFile(latestPath, 'utf8');
    expect(timestamped).toBe(latest);
    const parsed = JSON.parse(timestamped) as { capturedAt: string; provider: string; records: unknown[] };
    expect(parsed.provider).toBe('google');
    expect(parsed.capturedAt).toBe(date.toISOString());
    expect(parsed.records).toHaveLength(1);
  });
});

describe('renderFoundationRealEvalJobSummary', () => {
  it('renders a Markdown table naming every Foundation real-eval tier', () => {
    const summary: AgentOutcomeTopLineScore = {
      tierSuccessRate: { A: undefined, B: 0, C: 0.5, D: undefined, E: undefined },
      latencyMs: { p50: 1200, p95: 3400 },
      toolCalls: { p50: 2, p95: 5 },
      revisionRate: undefined,
      cancellationIntegrity: undefined,
      renderValidity: undefined,
    };
    const text = renderFoundationRealEvalJobSummary([], summary);
    expect(text).toContain('| B |');
    expect(text).toContain('| C |');
    expect(text).toContain('| D |');
    expect(text).toContain('1200');
    expect(text).toContain('3400');
    expect(text).toContain('Failures are expected');
  });
});

describe('runFoundationRealEval', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'foundation-real-eval-run-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('fails fast before constructing any provider when GOOGLE_API_KEY is unset', async () => {
    let providerBuilt = false;
    await expect(
      runFoundationRealEval({
        env: {},
        outDir,
        buildProvider: () => {
          providerBuilt = true;
          return new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
        },
      }),
    ).rejects.toThrow(/GOOGLE_API_KEY is not set/);
    expect(providerBuilt).toBe(false);
  });

  it('drives every selected scenario through the injected provider and writes real telemetry', async () => {
    // A tool call is required for the shipping agent runtime to terminate as `completed`
    // rather than `failed` — mirrors the working pattern in agent-run-quality.test.ts.
    const scripted = new ScriptedProvider([
      {
        text: 'Tightening the section.',
        toolCalls: [
          {
            id: 'foundation-real-delete',
            name: 'delete_range',
            arguments: { trackId: 'video_1', start: 0, end: 1 },
          },
        ],
      },
      { text: 'Done.', toolCalls: [] },
    ]);
    const scenarios = selectFoundationRealEvalScenarios().slice(0, 2);
    const logs: string[] = [];

    const result = await runFoundationRealEval({
      env: { GOOGLE_API_KEY: 'test-key' },
      scenarios,
      outDir,
      buildProvider: () => scripted,
      log: (message) => logs.push(message),
    });

    expect(result.records).toHaveLength(2);
    // Fail-closed by design: no semantic grader or host-revision observation exists yet,
    // regardless of how the real agent run itself terminated.
    expect(result.records.every((record) => record.status === 'failed')).toBe(true);
    expect(
      result.records.every((record) => record.failures.includes('Project revision range was not observed.')),
    ).toBe(true);
    expect(result.records.every((record) => record.metrics.modelCallCount > 0)).toBe(true);
    expect(result.records.every((record) => record.metrics.wallClockMs !== undefined)).toBe(true);
    expect(result.jobSummary).toContain('Google Gemini');
    expect(logs.some((line) => line.includes('running 2 Tier B-D scenario'))).toBe(true);

    const latest = JSON.parse(await readFile(result.latestPath, 'utf8')) as { records: unknown[] };
    expect(latest.records).toHaveLength(2);
  });
});
