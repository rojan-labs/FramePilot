/**
 * @framepilot/ai-sdk/kernel/replay/golden-session — the migration's parity oracle
 * (plan/LANGCHAIN-MIGRATION.md M0.2).
 *
 * Every phase from M6 onward is accepted on the same question: **given identical
 * inputs, does the new orchestration path emit the identical event stream and produce
 * the identical patch?** `kernel/replay/` could already replay a run from its recorded
 * effect results, and `streamAgent-golden.test.ts` already snapshots event streams —
 * but neither gives a later phase something it can load and compare against. A vitest
 * snapshot belongs to the test that wrote it; a shadow-mode divergence report in M6
 * needs the corpus as data.
 *
 * So this module owns three things: the on-disk {@link GoldenSession} shape, a
 * normalizer that makes a run comparable without hiding what matters, and
 * {@link compareSessions}, which returns a divergence *report* rather than a boolean —
 * "they differ" is useless when a phase's exit criterion is "every divergence is
 * enumerated and accepted".
 *
 * ## What this corpus is, and is not
 *
 * It is **hermetic**: every session is driven by a scripted provider, so it is
 * deterministic, costs nothing, and runs in CI. That is what a *structural* oracle
 * needs — the same inputs and the same tool results must yield the same events and the
 * same patch, and a real network call would only add nondeterminism to that question.
 *
 * It is **not** the M0.1 performance baseline. TTFT, wall time, cost per turn and
 * prompt-cache hit rate cannot be synthesized and are deliberately absent here; they
 * still require real desktop runs against real media. A phase that passes golden-session
 * parity has proven it behaves the same, not that it performs the same.
 *
 * ## Why ids are compared, not normalized away
 *
 * The event-id contract (§7.4) is the plan's highest-impact structural risk: the
 * sidebar, the durable WAL and the replay harness all depend on one monotonic sequence
 * that survives the control/execution boundary. Normalizing ids out of the comparison
 * would delete exactly the signal the comparison exists to catch. The sessions pin a
 * fixed clock instead, so `ts` and ids are reproducible and can be compared literally.
 */
import type { AiEvent } from '../../events.js';
import type { AnyOperation } from '@framepilot/editor-core';

/** The schema version of the on-disk fixture format. Bump only with a migration. */
export const GOLDEN_SESSION_VERSION = 1;

/** One recorded run: what went in, and everything observable that came out. */
export interface GoldenSession {
  readonly version: number;
  /** Stable identifier; also the fixture's filename stem. */
  readonly name: string;
  /**
   * Why this session is in the corpus. Prose, not a tag — a future reader deciding
   * whether a divergence is acceptable needs to know what the session was protecting.
   */
  readonly covers: string;
  /** The user's prompt, as the run received it. */
  readonly prompt: string;
  /** The full event stream, ids and timestamps included (§7.4). */
  readonly events: readonly AiEvent[];
  /** The operations the run ultimately produced, in order. Empty for a no-op run. */
  readonly operations: readonly AnyOperation[];
  /** The run's terminal status, lifted out so a mismatch is reported plainly. */
  readonly terminalStatus: string | undefined;
}

/** One difference between a recorded session and a candidate run. */
export interface SessionDivergence {
  /** Where it was found: `events[12].type`, `operations.length`, `terminalStatus`. */
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** The result of comparing a candidate run against a recorded session. */
export interface SessionComparison {
  readonly name: string;
  readonly identical: boolean;
  /**
   * Every difference found, not just the first. A phase's exit criterion is that each
   * divergence is enumerated and accepted, which needs the whole list.
   */
  readonly divergences: readonly SessionDivergence[];
}

/** The observable output of one run, before it is stored or compared. */
export interface RunOutcome {
  readonly events: readonly AiEvent[];
  readonly operations: readonly AnyOperation[];
}

/** Lift the terminal status out of an event stream. */
export function terminalStatusOf(events: readonly AiEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'status') return event.status;
  }
  return undefined;
}

/** Build a storable session from a run's observable output. */
export function toGoldenSession(
  name: string,
  covers: string,
  prompt: string,
  outcome: RunOutcome,
): GoldenSession {
  return {
    version: GOLDEN_SESSION_VERSION,
    name,
    covers,
    prompt,
    events: outcome.events,
    operations: outcome.operations,
    terminalStatus: terminalStatusOf(outcome.events),
  };
}

/** Stable JSON for on-disk storage — key order fixed so a diff shows real changes. */
export function serializeSession(session: GoldenSession): string {
  return `${JSON.stringify(session, null, 2)}\n`;
}

/** Parse a stored session, rejecting a fixture written by an incompatible version. */
export function parseSession(raw: string): GoldenSession {
  const parsed = JSON.parse(raw) as GoldenSession;
  if (parsed.version !== GOLDEN_SESSION_VERSION) {
    throw new Error(
      `Golden session "${parsed.name}" is version ${String(parsed.version)}, expected ${String(GOLDEN_SESSION_VERSION)}. Regenerate the corpus.`,
    );
  }
  return parsed;
}

/**
 * Walk two values and record every difference, deeply.
 *
 * Deliberately structural rather than a `JSON.stringify` equality check: the phase exit
 * criteria are written in terms of *which* fields diverged, and a single boolean would
 * force whoever reads the report to re-derive that by eye across thousand-event streams.
 */
function diffValue(
  path: string,
  expected: unknown,
  actual: unknown,
  out: SessionDivergence[],
): void {
  if (Object.is(expected, actual)) return;

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
    }
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      diffValue(`${path}[${String(index)}]`, expected[index], actual[index], out);
    }
    return;
  }

  const bothObjects =
    typeof expected === 'object' &&
    expected !== null &&
    typeof actual === 'object' &&
    actual !== null &&
    !Array.isArray(expected) &&
    !Array.isArray(actual);

  if (bothObjects) {
    const keys = new Set([
      ...Object.keys(expected as Record<string, unknown>),
      ...Object.keys(actual as Record<string, unknown>),
    ]);
    // Every entry point below passes a non-empty root (`events`, `operations`,
    // `terminalStatus`), so the path is always qualified — no bare-key case to handle.
    for (const key of [...keys].sort()) {
      diffValue(
        `${path}.${key}`,
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        out,
      );
    }
    return;
  }

  out.push({ path, expected, actual });
}

/**
 * Compare a candidate run against a recorded session.
 *
 * Events are compared **including ids and timestamps** — see the module header for why
 * normalizing them away would defeat the purpose.
 */
export function compareSessions(session: GoldenSession, outcome: RunOutcome): SessionComparison {
  const divergences: SessionDivergence[] = [];
  diffValue('events', session.events, outcome.events, divergences);
  diffValue('operations', session.operations, outcome.operations, divergences);
  diffValue(
    'terminalStatus',
    session.terminalStatus,
    terminalStatusOf(outcome.events),
    divergences,
  );
  return { name: session.name, identical: divergences.length === 0, divergences };
}

/** A human-readable divergence report for a phase's exit record. */
export function formatComparison(comparison: SessionComparison): string {
  if (comparison.identical) return `${comparison.name}: identical`;
  const lines = comparison.divergences
    .slice(0, 20)
    .map(
      (d) => `  ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`,
    );
  const more = comparison.divergences.length - lines.length;
  return [
    `${comparison.name}: ${String(comparison.divergences.length)} divergence(s)`,
    ...lines,
    ...(more > 0 ? [`  … and ${String(more)} more`] : []),
  ].join('\n');
}
