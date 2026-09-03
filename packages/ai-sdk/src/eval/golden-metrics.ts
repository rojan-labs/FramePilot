/**
 * @framepilot/ai-sdk/eval/golden-metrics — the ten metrics goal.md Phase 0 tracks on
 * every run, computed from what a run actually produced: its event stream, the patches it
 * applied, and the rubric verdict on the resulting project. Pure; nothing here talks to a
 * provider, a sidecar or a clock, so the same evidence scores the same way on any day.
 *
 * The metrics, and where each one's evidence comes from:
 *   - intent accuracy        — expected intent (golden case) vs what the events show
 *                              (an `ask`, a valid diff, an explanation, a failure).
 *   - target resolution      — rubric checks faceted `target` (right clips, right range).
 *   - boundary precision     — rubric checks faceted `boundary` (frame-exact edges).
 *   - operation validity     — `diff` events: how many proposals failed validation.
 *   - first-pass acceptance  — intent right AND every rubric check passed AND the run
 *                              settled `completed`, with zero follow-up.
 *   - turns / tool calls     — model calls and terminal `tool_call` events.
 *   - tokens & USD           — per accepted edit, aggregated in {@link summarizeGoldenRun}.
 *   - latency                — first visible progress and done, p50/p95 in the summary.
 *   - reversibility          — every applied patch inverted in reverse order restores the
 *                              prior project, compared as canonical JSON. `null` (unknown)
 *                              when the evidence carries no patches — an imported event
 *                              dump records what the run said, not what it applied.
 *   - failure quality        — when it did not complete: was there an error card, and does
 *                              it explain rather than leak an internal?
 *
 * Honesty rules: a missing number is `null`, never 0. A `null` USD means the provider did
 * not price the call. A `null` target/boundary means the rubric had no such check.
 */
import type { Project } from '@framepilot/timeline-schema';
import { applyProjectPatch, invertProjectPatch, type Patch } from '@framepilot/editor-core';
import type { AiEvent } from '../events.js';
import type { ExpectedIntent, GoldenCategory } from './golden-cases.js';
import type { RubricCheck, RubricScore } from './mission-rubric.js';

/** What the run visibly did, read from its events and applied operations. */
export type ObservedIntent = 'edit' | 'ask' | 'decline' | 'failed' | 'cancelled' | 'silent';

/** Event types that count as "the user can see something happening". */
const PROGRESS_EVENT_TYPES: ReadonlySet<AiEvent['type']> = new Set<AiEvent['type']>([
  'assistant_delta',
  'reasoning_delta',
  'plan',
  'tool_call',
  'progress',
  'timeline_action',
  'diff',
  'ask',
]);

/** An error message that leaks an internal instead of explaining. */
const INTERNAL_LEAK = /Internal Server Error|TypeError|ReferenceError|\bundefined\b|\bat\s+\S+\s+\(.*:\d+:\d+\)/;
/** Shorter than this and a message cannot have said what went wrong and what to do. */
const MIN_EXPLAINED_LENGTH = 20;

export interface GoldenTurnEvidence {
  readonly events: readonly AiEvent[];
  /** Epoch ms when `streamAgent` was called — the latency origin. */
  readonly startedAt: number;
  readonly wallMs: number;
  /**
   * The project the turn started from. Absent when the evidence was imported from an
   * event dump rather than produced by a live run — reversibility is then unknown.
   */
  readonly before?: Project;
  /**
   * Every valid patch the run applied, in order. Absent (NOT empty) when the evidence
   * does not record patches: an empty array means "applied nothing", `undefined` means
   * "we do not know", and the two must never collapse into the same number.
   */
  readonly appliedPatches?: readonly Patch[];
  /**
   * Operation count when the patches are not recorded. Defaults to the operations named
   * by the run's valid `diff` events; an explicit value overrides that.
   */
  readonly operations?: number;
  readonly rubric: RubricScore;
  readonly expectedIntent: ExpectedIntent;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly tokens: { readonly prompt: number; readonly output: number };
  readonly usd: number | null;
}

export interface FacetVerdict {
  readonly ok: boolean;
  /** The checks that decided it, `id: detail`. */
  readonly checks: readonly string[];
}

export interface FailureQuality {
  /** An `error` event or a failed status reached the user — it did not die quietly. */
  readonly loud: boolean;
  /** The message says what went wrong in words a non-technical user can act on. */
  readonly explained: boolean;
  readonly message: string | null;
}

export interface GoldenTurnMetrics {
  readonly intent: { readonly expected: ExpectedIntent; readonly observed: ObservedIntent; readonly ok: boolean };
  readonly target: FacetVerdict | null;
  readonly boundary: FacetVerdict | null;
  readonly validity: { readonly diffs: number; readonly valid: number; readonly invalid: number; readonly rate: number | null };
  readonly firstPass: boolean;
  /** Completed, expected to edit, applied nothing — the run reported done on a no-op. */
  readonly silentSuccess: boolean;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly tokens: { readonly prompt: number; readonly output: number; readonly total: number };
  readonly usd: number | null;
  readonly latency: { readonly firstProgressMs: number | null; readonly doneMs: number };
  /** `ok: null` = not checkable from this evidence (no patches recorded), never a pass. */
  readonly reversibility: { readonly ok: boolean | null; readonly detail: string };
  readonly failureQuality: FailureQuality | null;
  readonly score: number;
  readonly finalStatus: string | null;
  readonly operations: number;
}

function lastStatus(events: readonly AiEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'status') return e.status;
  }
  return null;
}

function assistantText(events: readonly AiEvent[]): string {
  let text = '';
  for (const e of events) if (e.type === 'assistant_message') text = e.text ?? text;
  return text.trim();
}

/** Read what the run did from its events and the operations it applied. */
export function observeIntent(events: readonly AiEvent[], appliedOperations: number): ObservedIntent {
  const status = lastStatus(events);
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  // Asking comes first: a question before an edit is the behaviour the guard/clarify cases
  // exist to see, and an edit after the operator's answer is judged by the rubric.
  if (events.some((e) => e.type === 'ask')) return 'ask';
  if (appliedOperations > 0) return 'edit';
  if (assistantText(events).length > 0) return 'decline';
  return 'silent';
}

export function intentMatches(expected: ExpectedIntent, observed: ObservedIntent): boolean {
  if (expected === 'ask-or-edit') return observed === 'ask' || observed === 'edit';
  return expected === observed;
}

function facet(checks: readonly RubricCheck[], name: NonNullable<RubricCheck['facet']>): FacetVerdict | null {
  const mine = checks.filter((c) => c.facet === name);
  if (mine.length === 0) return null;
  return { ok: mine.every((c) => c.ok), checks: mine.map((c) => `${c.id}: ${c.detail}`) };
}

/** JSON with keys in a stable order, so two equal projects serialise identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** First path at which two canonical structures differ — the report's pointer, not a diff. */
function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (canonicalJson(a) === canonicalJson(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length ${String(a.length)} vs ${String(b.length)}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${String(i)}]`);
      if (d) return d;
    }
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return path;
}

/**
 * Undo restores the prior state: apply every patch, then apply each inverse in reverse
 * order, and compare the result with the original as canonical JSON. A patch that cannot
 * be inverted is a failed check with the reason, never a skipped one.
 */
export function checkReversibility(
  before: Project,
  patches: readonly Patch[],
): { readonly ok: boolean; readonly detail: string } {
  if (patches.length === 0) return { ok: true, detail: 'nothing applied, nothing to undo' };
  let working = before;
  const inverses: Patch[] = [];
  try {
    for (const patch of patches) {
      inverses.push(invertProjectPatch(working, patch));
      working = applyProjectPatch(working, patch);
    }
    for (let i = inverses.length - 1; i >= 0; i--) working = applyProjectPatch(working, inverses[i]!);
  } catch (error) {
    return { ok: false, detail: `undo threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  // `timeline.revision` is a monotonic counter every structural change bumps so derived
  // work (caption cues) can tell it is stale; an undo is a change too, so the counter is
  // allowed to move. Everything else must come back exactly.
  const diff = firstDifference(withoutRevision(before), withoutRevision(working));
  return diff === null
    ? { ok: true, detail: `identical after ${String(patches.length)} patch(es) undone (timeline.revision excluded — monotonic by design)` }
    : { ok: false, detail: `differs after undo at ${diff}` };
}

function withoutRevision(project: Project): Omit<Project, 'timeline'> & { timeline: Omit<Project['timeline'], 'revision'> } {
  const { revision: _revision, ...timeline } = project.timeline;
  return { ...project, timeline };
}

/**
 * A `diff` event as it survives in a compact event dump: `edit.validation.valid` is
 * flattened to `edit.valid` and the patch is replaced by the operation kinds it carried.
 * Both shapes are read the same way so an imported run scores like a live one.
 */
interface CompactEdit {
  readonly validation?: { readonly valid?: boolean };
  readonly valid?: boolean;
  readonly ops?: readonly unknown[];
}

function editOf(event: AiEvent & { type: 'diff' }): CompactEdit {
  // The cast through `unknown` is the admission that an imported dump is not typed data:
  // a truncated one can carry a `diff` with no `edit` at all. Scoring it as an empty edit
  // (unvalidated, zero operations) is the honest reading; throwing loses the whole run.
  return (event.edit ?? {}) as unknown as CompactEdit;
}

/** Did this proposal pass validation? Live shape first, compact shape second. */
function diffIsValid(event: AiEvent & { type: 'diff' }): boolean {
  const edit = editOf(event);
  return edit.validation?.valid ?? edit.valid ?? false;
}

/** Operations named by a compact diff, when the applied patches were not recorded. */
function diffOperationCount(event: AiEvent & { type: 'diff' }): number {
  return editOf(event).ops?.length ?? 0;
}

function failureQuality(events: readonly AiEvent[], observed: ObservedIntent): FailureQuality | null {
  if (observed !== 'failed' && observed !== 'cancelled' && observed !== 'silent') return null;
  const error = events.filter((e) => e.type === 'error').at(-1);
  const message = error ? [error.message, error.detail].filter(Boolean).join(' — ') : null;
  const loud = observed === 'cancelled' || error !== undefined;
  const explained =
    message !== null && message.length >= MIN_EXPLAINED_LENGTH && !INTERNAL_LEAK.test(message);
  return { loud, explained, message };
}

/** Score one turn against everything goal.md asks for. */
export function measureGoldenTurn(evidence: GoldenTurnEvidence): GoldenTurnMetrics {
  const { events, rubric } = evidence;
  const diffs = events.filter((e) => e.type === 'diff');
  const valid = diffs.filter(diffIsValid).length;
  // Patches recorded ⇒ count what was applied. Not recorded ⇒ count what the run's valid
  // proposals said they changed, which is the only honest reading of a dump.
  const operations =
    evidence.operations ??
    (evidence.appliedPatches
      ? evidence.appliedPatches.reduce((s, p) => s + p.operations.length, 0)
      : diffs.filter(diffIsValid).reduce((s, e) => s + diffOperationCount(e), 0));
  const observed = observeIntent(events, operations);
  const intentOk = intentMatches(evidence.expectedIntent, observed);
  const status = lastStatus(events);
  const firstProgress = events.find((e) => PROGRESS_EVENT_TYPES.has(e.type));
  const asked = observed === 'ask';
  // An `ask` turn ends `awaiting_answer`/`completed` depending on the operator; "done" for
  // the first-pass verdict means the run reached a terminal state the user was told about.
  const settled = status === 'completed' || (asked && status !== 'failed');
  return {
    intent: { expected: evidence.expectedIntent, observed, ok: intentOk },
    target: facet(rubric.checks, 'target'),
    boundary: facet(rubric.checks, 'boundary'),
    validity: {
      diffs: diffs.length,
      valid,
      invalid: diffs.length - valid,
      rate: diffs.length === 0 ? null : valid / diffs.length,
    },
    firstPass: intentOk && rubric.score === 1 && settled,
    silentSuccess:
      evidence.expectedIntent === 'edit' && status === 'completed' && operations === 0 && !asked,
    modelCalls: evidence.modelCalls,
    toolCalls: evidence.toolCalls,
    tokens: {
      prompt: evidence.tokens.prompt,
      output: evidence.tokens.output,
      total: evidence.tokens.prompt + evidence.tokens.output,
    },
    usd: evidence.usd,
    latency: {
      firstProgressMs: firstProgress ? Math.max(0, firstProgress.ts - evidence.startedAt) : null,
      doneMs: evidence.wallMs,
    },
    reversibility:
      evidence.appliedPatches && evidence.before
        ? checkReversibility(evidence.before, evidence.appliedPatches)
        : { ok: null, detail: 'patches not recorded' },
    failureQuality: failureQuality(events, observed),
    score: rubric.score,
    finalStatus: status,
    operations,
  };
}

// ── Run-level summary ────────────────────────────────────────────────────────────────

export interface GoldenRow {
  readonly caseId: string;
  readonly category: GoldenCategory | string;
  readonly turnIndex: number;
  readonly run: number;
  readonly metrics: GoldenTurnMetrics;
}

export interface GoldenPercentiles {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly n: number;
}

export interface GoldenCaseSummary {
  readonly category: string;
  readonly runs: number;
  readonly score: number | null;
  readonly intentAccuracy: number;
  readonly firstPass: number;
  /** `null` when no turn of the case recorded patches to check. */
  readonly reversible: number | null;
  readonly modelCalls: number | null;
  readonly tokens: number | null;
  /** Summed over the case's turns, p50 across runs. */
  readonly usdPerRun: number | null;
  readonly wallMsPerRun: number | null;
  readonly silentSuccesses: number;
}

export interface GoldenSummary {
  readonly cases: number;
  readonly turns: number;
  readonly intentAccuracy: number | null;
  readonly targetAccuracy: number | null;
  readonly boundaryPrecision: number | null;
  readonly validityRate: number | null;
  readonly firstPassAcceptance: number | null;
  readonly silentSuccesses: number;
  readonly reversibility: number | null;
  readonly acceptedEdits: number;
  /**
   * Turns the provider never answered (see {@link isVoidTurn}). Excluded from every rate
   * above, because a transport failure is not a decision the agent made. A non-zero value
   * here means the run is that much smaller than it looks — read the rates as being over
   * `turns` minus this.
   */
  readonly voidTurns: number;
  readonly tokensPerAcceptedEdit: number | null;
  readonly usdPerAcceptedEdit: number | null;
  readonly modelCallsPerTurn: GoldenPercentiles;
  readonly toolCallsPerTurn: GoldenPercentiles;
  readonly latency: { readonly firstProgressMs: GoldenPercentiles; readonly doneMs: GoldenPercentiles };
  readonly failureQuality: { readonly failures: number; readonly loud: number; readonly explained: number };
  readonly perCase: Readonly<Record<string, GoldenCaseSummary>>;
}

function numbers(xs: readonly (number | null | undefined)[]): number[] {
  return xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
}

/** Nearest-rank percentile; `null` on an empty sample rather than a made-up 0. */
export function percentile(xs: readonly (number | null | undefined)[], q: number): number | null {
  const a = numbers(xs);
  if (a.length === 0) return null;
  const rank = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return a[rank]!;
}

export function percentiles(xs: readonly (number | null | undefined)[]): GoldenPercentiles {
  return { p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), n: numbers(xs).length };
}

/**
 * Did the provider never answer this turn at all?
 *
 * Zero PROMPT tokens is the tell, and it is unambiguous: every real turn — an edit, a
 * refusal, a clarifying question — sends the system contract and the project context before
 * the model says anything, so a turn that billed no input never reached a model. What
 * remains is a transport failure: an unreachable provider, a dead proxy, an exhausted quota.
 *
 * It has to be separated from behaviour because it LOOKS like the worst possible behaviour.
 * In the 2026-09-03 baseline the run exhausted its provider quota after six cases and the
 * remaining fifteen each recorded "couldn't reach claude-agent-sdk" — scored as an agent
 * that declined to edit, at intent 0% and first-pass 0%. Folded in, the run reported 14%
 * intent accuracy and 7% first-pass acceptance for an agent that had, on every case it was
 * actually asked, either edited correctly or explained itself.
 */
export function isVoidTurn(m: GoldenTurnMetrics): boolean {
  return m.tokens.prompt === 0 && m.finalStatus === 'failed' && m.operations === 0;
}

function share(rows: readonly GoldenRow[], pick: (m: GoldenTurnMetrics) => boolean | null): number | null {
  const applicable = rows.map((r) => pick(r.metrics)).filter((v): v is boolean => v !== null);
  if (applicable.length === 0) return null;
  return applicable.filter(Boolean).length / applicable.length;
}

/** Fold every turn of a run into the numbers the gate compares. */
export function summarizeGoldenRun(allRows: readonly GoldenRow[]): GoldenSummary {
  // A turn the provider never answered is not evidence about the agent, so it is counted
  // and reported (`voidTurns`) rather than scored. Every rate below is over what actually
  // ran; a run that is mostly void says so in one number instead of looking like collapse.
  const voidTurns = allRows.filter((r) => isVoidTurn(r.metrics)).length;
  const rows = allRows.filter((r) => !isVoidTurn(r.metrics));
  const accepted = rows.filter((r) => r.metrics.firstPass && r.metrics.operations > 0);
  const totalTokens = rows.reduce((s, r) => s + r.metrics.tokens.total, 0);
  const pricedRows = rows.filter((r) => r.metrics.usd !== null);
  const totalUsd = pricedRows.reduce((s, r) => s + (r.metrics.usd ?? 0), 0);
  const failures = rows.filter((r) => r.metrics.failureQuality !== null);
  const diffs = rows.reduce((s, r) => s + r.metrics.validity.diffs, 0);
  const valid = rows.reduce((s, r) => s + r.metrics.validity.valid, 0);

  const perCase: Record<string, GoldenCaseSummary> = {};
  const byCase = new Map<string, GoldenRow[]>();
  for (const r of rows) {
    const list = byCase.get(r.caseId) ?? [];
    list.push(r);
    byCase.set(r.caseId, list);
  }
  for (const [caseId, list] of byCase) {
    const runs = new Set(list.map((r) => r.run));
    const perRun = [...runs].map((run) => list.filter((r) => r.run === run));
    perCase[caseId] = {
      category: list[0]!.category,
      runs: runs.size,
      score: percentile(list.map((r) => r.metrics.score), 0.5),
      intentAccuracy: list.filter((r) => r.metrics.intent.ok).length / list.length,
      firstPass: list.filter((r) => r.metrics.firstPass).length / list.length,
      reversible: share(list, (m) => m.reversibility.ok),
      modelCalls: percentile(list.map((r) => r.metrics.modelCalls), 0.5),
      tokens: percentile(list.map((r) => r.metrics.tokens.total), 0.5),
      usdPerRun: percentile(
        perRun.map((turns) =>
          turns.every((t) => t.metrics.usd !== null) ? turns.reduce((s, t) => s + (t.metrics.usd ?? 0), 0) : null,
        ),
        0.5,
      ),
      wallMsPerRun: percentile(
        perRun.map((turns) => turns.reduce((s, t) => s + t.metrics.latency.doneMs, 0)),
        0.5,
      ),
      silentSuccesses: list.filter((r) => r.metrics.silentSuccess).length,
    };
  }

  return {
    cases: byCase.size,
    turns: rows.length,
    intentAccuracy: share(rows, (m) => m.intent.ok),
    targetAccuracy: share(rows, (m) => (m.target ? m.target.ok : null)),
    boundaryPrecision: share(rows, (m) => (m.boundary ? m.boundary.ok : null)),
    validityRate: diffs === 0 ? null : valid / diffs,
    firstPassAcceptance: share(rows, (m) => m.firstPass),
    silentSuccesses: rows.filter((r) => r.metrics.silentSuccess).length,
    // A turn whose patches were not recorded is not counted either way: an unknown must
    // never be folded in as a pass or a failure.
    reversibility: share(rows, (m) => m.reversibility.ok),
    acceptedEdits: accepted.length,
    voidTurns,
    // Tokens and dollars per ACCEPTED edit — the whole run's spend over the edits that
    // needed no follow-up, so a cheap call that forces a retry is charged, not hidden.
    tokensPerAcceptedEdit: accepted.length === 0 ? null : totalTokens / accepted.length,
    usdPerAcceptedEdit:
      accepted.length === 0 || pricedRows.length !== rows.length ? null : totalUsd / accepted.length,
    modelCallsPerTurn: percentiles(rows.map((r) => r.metrics.modelCalls)),
    toolCallsPerTurn: percentiles(rows.map((r) => r.metrics.toolCalls)),
    latency: {
      firstProgressMs: percentiles(rows.map((r) => r.metrics.latency.firstProgressMs)),
      doneMs: percentiles(rows.map((r) => r.metrics.latency.doneMs)),
    },
    failureQuality: {
      failures: failures.length,
      loud: failures.filter((r) => r.metrics.failureQuality?.loud).length,
      explained: failures.filter((r) => r.metrics.failureQuality?.explained).length,
    },
    perCase,
  };
}

// ── Cost estimate before the run ─────────────────────────────────────────────────────

export interface RunEstimate {
  readonly usd: number | null;
  readonly minutes: number | null;
  readonly perCase: readonly {
    readonly caseId: string;
    readonly usd: number | null;
    readonly minutes: number | null;
    readonly basis: 'prior' | 'unknown';
  }[];
  /** Cases with no prior run — their cost is genuinely unknown, not zero. */
  readonly unknown: readonly string[];
}

/**
 * What the run is about to cost, from the last summary of the same cases. A case that was
 * never run has no estimate; the total is reported only when every case has one, because
 * a partial total reads as a complete one.
 */
export function estimateRun(
  prior: GoldenSummary | undefined,
  caseIds: readonly string[],
  runs: number,
): RunEstimate {
  const perCase = caseIds.map((caseId) => {
    const p = prior?.perCase[caseId];
    if (!p) return { caseId, usd: null, minutes: null, basis: 'unknown' as const };
    return {
      caseId,
      usd: p.usdPerRun === null ? null : p.usdPerRun * runs,
      minutes: p.wallMsPerRun === null ? null : (p.wallMsPerRun * runs) / 60_000,
      basis: 'prior' as const,
    };
  });
  const unknown = perCase.filter((c) => c.basis === 'unknown').map((c) => c.caseId);
  const allUsd = perCase.every((c) => c.usd !== null);
  const allMin = perCase.every((c) => c.minutes !== null);
  return {
    usd: allUsd ? perCase.reduce((s, c) => s + (c.usd ?? 0), 0) : null,
    minutes: allMin ? perCase.reduce((s, c) => s + (c.minutes ?? 0), 0) : null,
    perCase,
    unknown,
  };
}

// ── Human summary ────────────────────────────────────────────────────────────────────

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
const num = (v: number | null, digits = 0): string => (v === null ? '—' : v.toFixed(digits));
const secs = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);

/** The short human summary that sits beside `summary.json`. */
export function renderGoldenSummary(
  summary: GoldenSummary,
  meta: { readonly label: string; readonly provider: string; readonly model: string; readonly generatedAt: string; readonly replayed?: boolean },
): string {
  const lines: string[] = [];
  lines.push(`# Golden run — ${meta.label}`);
  lines.push('');
  lines.push(
    `${meta.generatedAt} · provider \`${meta.provider}\` · model \`${meta.model}\`` +
      (meta.replayed ? ' · **replayed from recordings (no model calls; latency not meaningful)**' : ''),
  );
  lines.push('');
  lines.push(`${String(summary.cases)} case(s), ${String(summary.turns)} turn(s).`);
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| intent accuracy | ${pct(summary.intentAccuracy)} |`);
  lines.push(`| target resolution | ${pct(summary.targetAccuracy)} |`);
  lines.push(`| boundary precision | ${pct(summary.boundaryPrecision)} |`);
  lines.push(`| operation validity | ${pct(summary.validityRate)} |`);
  lines.push(`| first-pass acceptance | ${pct(summary.firstPassAcceptance)} |`);
  lines.push(`| silent successes | ${String(summary.silentSuccesses)} |`);
  lines.push(`| reversibility | ${pct(summary.reversibility)} |`);
  lines.push(`| accepted edits | ${String(summary.acceptedEdits)} |`);
  // Printed only when it happened, and printed loudly: a run with void turns is smaller
  // than its case table suggests, and every rate above is over what actually ran.
  if (summary.voidTurns > 0) {
    lines.push(
      `| **turns the provider never answered** | **${String(summary.voidTurns)} — excluded from every rate above; re-run them** |`,
    );
  }
  lines.push(`| tokens / accepted edit | ${num(summary.tokensPerAcceptedEdit)} |`);
  // Named for what it is. `cost-meter.ts` prices every call from a per-TIER table, not from
  // what the provider billed, and the vendored model catalogue carries no prices at all
  // (`cost: null` for all 279 entries). A dollar sign on its own reads as an invoice; this
  // number is a unit that is comparable BETWEEN runs and wrong in absolute terms — for a
  // free or uncatalogued model, wrong by orders of magnitude.
  lines.push(
    `| tier-priced cost / accepted edit (not billed) | ${summary.usdPerAcceptedEdit === null ? '—' : `$${summary.usdPerAcceptedEdit.toFixed(3)}`} |`,
  );
  lines.push(`| model calls / turn p50 · p95 | ${num(summary.modelCallsPerTurn.p50)} · ${num(summary.modelCallsPerTurn.p95)} |`);
  lines.push(`| tool calls / turn p50 · p95 | ${num(summary.toolCallsPerTurn.p50)} · ${num(summary.toolCallsPerTurn.p95)} |`);
  lines.push(`| first progress p50 · p95 | ${secs(summary.latency.firstProgressMs.p50)} · ${secs(summary.latency.firstProgressMs.p95)} |`);
  lines.push(`| done p50 · p95 | ${secs(summary.latency.doneMs.p50)} · ${secs(summary.latency.doneMs.p95)} |`);
  lines.push(
    `| failure quality | ${String(summary.failureQuality.failures)} failure(s): ${String(summary.failureQuality.loud)} loud, ${String(summary.failureQuality.explained)} explained |`,
  );
  lines.push('');
  lines.push('| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [id, c] of Object.entries(summary.perCase)) {
    lines.push(
      `| ${id} | ${c.category} | ${String(c.runs)} | ${num(c.score, 2)} | ${pct(c.intentAccuracy)} | ${pct(c.firstPass)} | ${pct(c.reversible)} | ${num(c.modelCalls)} | ${num(c.tokens)} | ${c.usdPerRun === null ? '—' : `$${c.usdPerRun.toFixed(2)}`} | ${secs(c.wallMsPerRun)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
