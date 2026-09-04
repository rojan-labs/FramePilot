/**
 * @framepilot/ai-sdk/reliability/types — pure contract types for reliable AI
 * orchestration (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R0, ADR 0035).
 *
 * These types are the shared vocabulary for resilience (retry/backoff/timeout),
 * context budgeting, and per-turn tracing. They are intentionally dependency-free
 * and hold **no** persisted project state — nothing here touches `project.fp.json`
 * (invariant 1); traces and budgets are transient or live in separate stores.
 */

/**
 * A typed classification of a provider failure. Concrete providers (Anthropic,
 * NVIDIA) and the {@link ../providers/errors} classifier produce these instead of
 * bare `Error`s so the retry policy and the UI can reason about them.
 *
 * - `rate_limit` — HTTP 429; honor `retryAfterMs` if the server sent `Retry-After`.
 * - `overloaded` — Anthropic `overloaded_error` / HTTP 529; retryable with backoff.
 * - `server` — HTTP 5xx; retryable.
 * - `network` — `fetch` rejected (DNS/connection/reset) or a timeout fired; retryable.
 * - `auth` — HTTP 401/403; a misconfiguration, **not** retryable.
 * - `bad_request` — HTTP 400/422; a malformed request, **not** retryable.
 */
export type ProviderErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'auth'
  | 'bad_request';

/**
 * A typed provider error. `retryable` is derived once at classification time from
 * `kind`, so downstream code (retry loop, `ErrorEvent`) never re-guesses it.
 */
export class ProviderError extends Error {
  public readonly kind: ProviderErrorKind;
  public readonly status: number | undefined;
  public readonly retryable: boolean;
  /** Milliseconds to wait before retry, parsed from `Retry-After` when present. */
  public readonly retryAfterMs: number | undefined;
  /**
   * A sentence already written for the editor, when the thrower knows more than the
   * classification does (e.g. "the model spent its whole output allowance thinking").
   * `plainRunFailure` shows this verbatim instead of the generic copy for `kind`.
   * Classified wire failures leave it `undefined` — there is nothing to say beyond
   * what `kind` already means.
   */
  public readonly editorMessage: string | undefined;

  public constructor(
    message: string,
    kind: ProviderErrorKind,
    opts: {
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      editorMessage?: string;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.editorMessage = opts.editorMessage;
    this.retryable = opts.retryable ?? isRetryableKind(kind);
  }
}

/** Which failure kinds are transient (safe to retry) vs. permanent. */
export function isRetryableKind(kind: ProviderErrorKind): boolean {
  switch (kind) {
    case 'rate_limit':
    case 'overloaded':
    case 'server':
    case 'network':
      return true;
    case 'auth':
    case 'bad_request':
      return false;
  }
}

/** Narrowing helper — a value that is a {@link ProviderError}. */
export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/**
 * Bounded exponential-backoff-with-jitter policy for {@link ../reliability/retry}.
 * All times are milliseconds. `maxAttempts` counts the *total* tries (initial + retries).
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Jitter fraction in [0,1]; the actual delay is `delay * (1 ± jitter*rand)`. */
  readonly jitter: number;
}

/** Conservative default: 3 tries, 500ms → 4s ceiling, 50% jitter. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4000,
  jitter: 0.5,
};

/** Token usage reported by a provider turn (captured for tracing + budgeting). */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Input tokens served from the provider's prompt cache (Anthropic
   * `cache_read_input_tokens`). Optional and **never fabricated** — a provider
   * that cannot read a real count leaves it `undefined`, which is meaningfully
   * different from a measured zero.
   *
   * WHY this exists: prompt-cache hit rate is the acceptance metric for the
   * highest-impact risk in plan/LANGCHAIN-MIGRATION.md (risk 3 — a mis-placed
   * cache breakpoint silently multiplies cost per turn, with no functional
   * symptom). `providers/anthropic.ts` places two `cache_control` breakpoints
   * but nothing read the resulting hit counts back, so that risk had a
   * designated metric the codebase could not actually produce.
   */
  readonly cacheReadInputTokens?: number;
  /**
   * Input tokens written to the prompt cache this turn (Anthropic
   * `cache_creation_input_tokens`). Billed at a premium, so a run that keeps
   * re-creating instead of reading is the exact failure mode risk 3 describes.
   */
  readonly cacheCreationInputTokens?: number;
}

/**
 * The outcome of a single orchestrator turn, collected by a {@link TurnTracer}.
 * Purely observational — never gates behavior, so it is safe to no-op in prod.
 */
export interface TurnTrace {
  readonly mode: string;
  readonly provider: string;
  readonly model?: string;
  /** Wall-clock duration of the turn in milliseconds. */
  readonly latencyMs: number;
  readonly usage?: Usage;
  /** Number of transport retries the {@link ProviderError} classification triggered. */
  readonly retries: number;
  /** Names of tools the model called this turn. */
  readonly toolCalls: readonly string[];
  /** Count of validator rejections during tool assembly. */
  readonly validatorRejections: number;
  readonly aborted: boolean;
  readonly timedOut: boolean;
  /** Terminal error kind, if the turn failed. */
  readonly errorKind?: ProviderErrorKind;
}

/**
 * A sink for {@link TurnTrace}s. Injected into the orchestrator so measurement is a
 * pure seam: the default is in-memory (see {@link ../reliability/tracer}); desktop
 * wires it into the existing opt-in local telemetry (no new surface).
 */
export interface TurnTracer {
  record(trace: TurnTrace): void;
}

/**
 * Context-window budget for the {@link ../context-builder} tiered assembler (R2).
 * `budget = contextWindow − maxOutputTokens − headroom` is the room left for the
 * assembled prompt; tiers are dropped lowest-priority-first to fit it.
 */
export interface ContextBudget {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly headroom: number;
  /**
   * Prompt cost this request pays that `assembleContext` does not assemble, and
   * therefore cannot see: the tool schemas, the route's mode instruction, and any
   * pinned skill playbooks.
   *
   * Without it the budgeter decided against roughly a fifth of the prompt. Tool
   * schemas alone are ~17,500 tokens on a planning turn — more than ten times the
   * project state they were being weighed against — so a window that the assembled
   * tiers "fit" could still overflow the moment the tools were attached. The manifest
   * has counted this since ADR 0080 (*"a tool set is real prompt cost"*); the
   * reporting layer was fixed and the deciding layer was not.
   *
   * Absent ⇒ zero, which is the old behaviour: a caller that assembles context with no
   * tools and no mode instruction genuinely pays nothing here.
   */
  readonly reservedPromptTokens?: number;
}

/**
 * Priority tiers, highest (never dropped) to lowest (dropped first). See R2 B2.
 * `pinned` (P8.7, the "@" pin-context picker) sits just below `selection` — an
 * explicit user pin is high-priority context, but the live selection (when present)
 * still wins if both must compete for the budget. `skills` (ADR 0057, the bundled
 * skills manifest) sits below `memory` — it is an affordance the model can re-fetch
 * via load_skill, not ground truth about this project.
 */
export const CONTEXT_TIERS = [
  'system',
  'prompt',
  'selection',
  'pinned',
  'history',
  'memory',
  'skills',
  'timeline',
  'transcript',
] as const;

export type ContextTier = (typeof CONTEXT_TIERS)[number];
