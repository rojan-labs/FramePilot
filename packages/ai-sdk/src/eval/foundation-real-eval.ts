/**
 * FramePilot 9.5 Foundation — real-provider capture for Tier B-D agent-outcome scenarios
 * (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` Phase 0, `docs/quality/FRAMEPILOT-95-FOUNDATION-BASELINE.md`
 * "Evidence exit gate").
 *
 * `pnpm eval:agent:foundation` proves the Foundation *contract* — manifest shape, linked
 * professional fixtures, and the run-quality grader — entirely offline. It cannot prove the
 * roadmap's other two Phase-0 exit rows ("real-provider/full-media benchmark distribution has
 * been captured" and real provider latency/cache), because a hermetic CI run has no network
 * and inventing either would be exactly the fabrication this whole layer refuses to do (see
 * `agent-run-quality.ts`). This module is the measuring rig for those two rows: it drives
 * Tier B/C/D scenarios through the real `Orchestrator.streamAgent` path against a real Google
 * Gemini call, through the same `BaselineCaptureProvider` / `captureAgentRunQuality` /
 * `buildAgentOutcomeEvalRunRecord` pipeline the offline suite already trusts. Nothing here adds
 * a second grading path, and Tier A/E stay on the offline contract suite — this only exists to
 * close gates that specifically require a real provider.
 *
 * ## Why most runs come back `status: 'failed'`, and why that is correct
 *
 * `buildAgentOutcomeEvalRunRecord` is fail-closed by design: a scenario only passes when its
 * `expectedHardConstraints` / `expectedFinalStatePredicates` were mechanically observed as
 * true. Tier B-D predicates are semantic judgments — "long awkward pauses are shortened",
 * "captions follow the transcript" — and this repo has no automated grader for them yet, and
 * this harness never touches a persisted project/revision store (no apply/commit path is
 * exercised), so it never observes a revision range either. This module supplies **no**
 * predicate observations and **no** revision range rather than inventing either — every
 * expected predicate is reported "not evaluated" and every record fails on "Project revision
 * range was not observed." That is the honest reading, not a defect: a `failed` status here
 * means "semantic grading and host settlement are not wired into this harness yet", not "the
 * agent did nothing." The `metrics` on every record (latency, tokens, tool calls, model
 * identity, terminal status) are real captured evidence regardless of `status`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ContextInput } from '../context-builder.js';
import type { AiEvent } from '../events.js';
import { Orchestrator } from '../orchestrator.js';
import { BaselineCaptureProvider, type CapturedTurn } from '../kernel/cost/baseline-capture.js';
import type { AiProvider } from '../providers/types.js';
import { ConcreteLangChainGoogleProvider } from '../providers/langchain-google.js';
import { GOOGLE_DEFAULT_MODEL } from '../providers/provider-defaults.js';
import { makeProject } from '../__fixtures__/project.js';
import {
  buildAgentOutcomeEvalRunRecord,
  captureAgentRunQuality,
  serializeAgentOutcomeEvalRunRecords,
  summarizeAgentOutcomeRuns,
  type AgentOutcomeEvalRunRecord,
  type AgentOutcomeTopLineScore,
} from '../agent-run-quality.js';
import {
  AGENT_OUTCOME_EVAL_SCENARIOS,
  type AgentOutcomeEvalScenario,
  type AgentOutcomeEvalTier,
} from '../professional-agent-evals.js';

/**
 * Scope explicitly narrowed with the maintainer for this capture path: Tier B (simple AI
 * edits), C (semantic editing) and D (compound agent jobs). Tier A is already exercised
 * against real professional fixtures by the offline suite; Tier E (adversarial/recovery,
 * including the 1000+ clip large-session scenario and cancellation-under-real-latency cases)
 * and human/editorial scoring stay explicitly out of scope for this change.
 */
export const FOUNDATION_REAL_EVAL_TIERS: readonly AgentOutcomeEvalTier[] = ['B', 'C', 'D'];

/** Filter the canonical manifest down to the scenarios this capture path runs. */
export function selectFoundationRealEvalScenarios(
  scenarios: readonly AgentOutcomeEvalScenario[] = AGENT_OUTCOME_EVAL_SCENARIOS,
): readonly AgentOutcomeEvalScenario[] {
  return scenarios.filter((scenario) => FOUNDATION_REAL_EVAL_TIERS.includes(scenario.tier));
}

/** Build the same synthetic-but-valid project fixture the offline suite uses, per scenario. */
export function buildScenarioContextInput(scenario: AgentOutcomeEvalScenario): ContextInput {
  return { project: makeProject(), userPrompt: scenario.task };
}

export interface RealEvalTurnCapture {
  readonly events: readonly AiEvent[];
  readonly capturedTurns: readonly CapturedTurn[];
  readonly wallClockMs: number;
}

/**
 * Turn one real captured run into the shared fail-closed record. Deliberately passes empty
 * `hardConstraints`/`finalStatePredicates` observation arrays and no revision range — see the
 * module doc for why. Do not add stretched or fabricated observations here.
 */
export function buildRealEvalRunRecord(
  scenario: AgentOutcomeEvalScenario,
  capture: RealEvalTurnCapture,
): AgentOutcomeEvalRunRecord {
  const metrics = captureAgentRunQuality({
    routeMode: 'agent',
    events: capture.events,
    capturedTurns: capture.capturedTurns,
    wallClockMs: capture.wallClockMs,
    deterministicValidation: 'not_run',
    renderEvidence: 'not_run',
  });
  return buildAgentOutcomeEvalRunRecord({
    scenario,
    hardConstraints: [],
    finalStatePredicates: [],
    metrics,
  });
}

/** Required at the entry point: a real-provider capture with no key measures nothing. */
export function requireGoogleApiKey(env: Readonly<Record<string, string | undefined>>): string {
  const apiKey = env.GOOGLE_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error(
      'GOOGLE_API_KEY is not set. This capture drives real Google Gemini calls and cannot ' +
        'honestly measure real-provider latency/cache/full-distribution evidence without one — ' +
        'set GOOGLE_API_KEY (see .env.example), or run the "Foundation real-provider eval" ' +
        'GitHub Actions workflow (workflow_dispatch), which reads it from the GOOGLE_API_KEY ' +
        'repository secret. Refusing to silently no-op or fall back to a mock provider.',
    );
  }
  return apiKey;
}

async function runScenario(
  scenario: AgentOutcomeEvalScenario,
  provider: AiProvider,
  now: () => number,
): Promise<AgentOutcomeEvalRunRecord> {
  const capture = new BaselineCaptureProvider(provider, { now });
  const orchestrator = new Orchestrator(capture);
  const input = buildScenarioContextInput(scenario);
  const started = now();
  const events: AiEvent[] = [];
  const stream = orchestrator.streamAgent(
    input,
    {
      conversationId: `foundation-real-${scenario.id}`,
      turnId: `foundation-real-${scenario.id}-turn`,
      now,
    },
    {},
  );
  for await (const event of stream) events.push(event);
  const wallClockMs = now() - started;
  return buildRealEvalRunRecord(scenario, {
    events,
    capturedTurns: capture.captured(),
    wallClockMs,
  });
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export interface FoundationRealEvalArtifactPaths {
  readonly outputPath: string;
  readonly latestPath: string;
}

/** Injectable so the write path is testable without touching the real filesystem twice. */
export type WriteFoundationRealEvalFile = (path: string, content: string) => Promise<void>;

async function defaultWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/**
 * Write the full serialized record set (plus its top-line summary) to a timestamped file and
 * a stable `latest.json` pointer. Pure aside from the injected file writer.
 */
export async function writeFoundationRealEvalArtifacts(
  outDir: string,
  records: readonly AgentOutcomeEvalRunRecord[],
  summary: AgentOutcomeTopLineScore,
  date: Date,
  writeFileImpl: WriteFoundationRealEvalFile = defaultWriteFile,
): Promise<FoundationRealEvalArtifactPaths> {
  const payload = `${JSON.stringify(
    {
      capturedAt: date.toISOString(),
      provider: 'google',
      tiers: FOUNDATION_REAL_EVAL_TIERS,
      summary,
      records: JSON.parse(serializeAgentOutcomeEvalRunRecords(records)) as unknown,
    },
    null,
    2,
  )}\n`;
  const outputPath = join(outDir, `${timestampSlug(date)}.json`);
  const latestPath = join(outDir, 'latest.json');
  await writeFileImpl(outputPath, payload);
  await writeFileImpl(latestPath, payload);
  return { outputPath, latestPath };
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '—' : String(Math.round(value));
}

/** A concise Markdown table suitable for a CI job summary. */
export function renderFoundationRealEvalJobSummary(
  records: readonly AgentOutcomeEvalRunRecord[],
  summary: AgentOutcomeTopLineScore,
): string {
  const lines = [
    '# FramePilot 9.5 Foundation — real-provider capture (Google Gemini)',
    '',
    `Scenarios run: ${String(records.length)} (Tier B-D). This is real-provider telemetry, not ` +
      'a semantic pass/fail benchmark — see `docs/quality/FRAMEPILOT-95-FOUNDATION-BASELINE.md`.',
    '',
    '| Tier | Pass rate |',
    '| --- | --- |',
    ...FOUNDATION_REAL_EVAL_TIERS.map(
      (tier) => `| ${tier} | ${formatPercent(summary.tierSuccessRate[tier])} |`,
    ),
    '',
    '| Metric | p50 | p95 |',
    '| --- | --- | --- |',
    `| Wall-clock latency (ms) | ${formatMs(summary.latencyMs.p50)} | ${formatMs(summary.latencyMs.p95)} |`,
    `| Tool calls per run | ${formatMs(summary.toolCalls.p50)} | ${formatMs(summary.toolCalls.p95)} |`,
    '',
    'Failures are expected: no automated grader exists yet for Tier B-D semantic predicates or ' +
      'host settlement, so every scenario currently fails closed on missing predicate/revision ' +
      'evidence even when the real model call succeeded. Inspect the per-scenario `failures` ' +
      'array and `metrics` in the output JSON for what actually happened.',
  ];
  return `${lines.join('\n')}\n`;
}

export interface FoundationRealEvalDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly scenarios?: readonly AgentOutcomeEvalScenario[];
  /** Override for tests; defaults to a real `ConcreteLangChainGoogleProvider`. */
  readonly buildProvider?: (config: { readonly apiKey: string; readonly model?: string }) => AiProvider;
  readonly outDir?: string;
  readonly writeFile?: WriteFoundationRealEvalFile;
  readonly log?: (message: string) => void;
}

export interface FoundationRealEvalResult {
  readonly records: readonly AgentOutcomeEvalRunRecord[];
  readonly summary: AgentOutcomeTopLineScore;
  readonly outputPath: string;
  readonly latestPath: string;
  readonly jobSummary: string;
}

function defaultBuildProvider(config: { readonly apiKey: string; readonly model?: string }): AiProvider {
  return new ConcreteLangChainGoogleProvider({
    name: 'google',
    apiKey: config.apiKey,
    ...(config.model !== undefined ? { model: config.model } : {}),
  });
}

/**
 * Drive every Tier B-D scenario through a real (or, in tests, injected) Google provider and
 * write the resulting evidence. Fails fast — before any provider is constructed — when
 * `GOOGLE_API_KEY` is absent.
 */
export async function runFoundationRealEval(
  deps: FoundationRealEvalDependencies = {},
): Promise<FoundationRealEvalResult> {
  const env = deps.env ?? process.env;
  const apiKey = requireGoogleApiKey(env);
  const model = env.GOOGLE_MODEL;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string): void => console.log(message));
  const scenarios = deps.scenarios ?? selectFoundationRealEvalScenarios();
  const buildProvider = deps.buildProvider ?? defaultBuildProvider;
  const provider = buildProvider({ apiKey, ...(model !== undefined ? { model } : {}) });

  log(
    `[foundation-real-eval] running ${String(scenarios.length)} Tier B-D scenario(s) against ` +
      `google/${model ?? GOOGLE_DEFAULT_MODEL}…`,
  );
  const records: AgentOutcomeEvalRunRecord[] = [];
  for (const scenario of scenarios) {
    const record = await runScenario(scenario, provider, now);
    records.push(record);
    log(
      `[foundation-real-eval] ${scenario.id} (${scenario.tier}): ${record.status} — ` +
        `${String(record.failures.length)} failure(s), ` +
        `${String(record.metrics.toolCallCount)} tool call(s), ` +
        `${record.metrics.wallClockMs === undefined ? 'no' : String(Math.round(record.metrics.wallClockMs))}ms`,
    );
  }

  const summary = summarizeAgentOutcomeRuns(records);
  const outDir = deps.outDir ?? join(process.cwd(), 'docs', 'quality', 'foundation-real-eval');
  const { outputPath, latestPath } = await writeFoundationRealEvalArtifacts(
    outDir,
    records,
    summary,
    new Date(),
    deps.writeFile,
  );
  const jobSummary = renderFoundationRealEvalJobSummary(records, summary);
  return { records, summary, outputPath, latestPath, jobSummary };
}
