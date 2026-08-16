/**
 * @framepilot/ai-sdk/reliability/tracer — the measurement backbone
 * (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R0, ADR 0035).
 *
 * A {@link TurnTracer} is a pure, injectable sink the orchestrator calls at each turn
 * boundary. The default is in-memory; desktop wires it into the existing opt-in local
 * telemetry (no new persisted surface). Tracing is observational only — it never
 * gates behavior, so a no-op tracer is always safe.
 */
import type { TurnTrace, TurnTracer, Usage } from './types.js';

/** A tracer that records nothing (production default when telemetry is off). */
export const NOOP_TRACER: TurnTracer = { record: () => {} };

/** An in-memory tracer that retains a bounded ring of recent traces for inspection. */
export class InMemoryTurnTracer implements TurnTracer {
  private readonly traces: TurnTrace[] = [];

  public constructor(private readonly max = 200) {}

  public record(trace: TurnTrace): void {
    this.traces.push(trace);
    if (this.traces.length > this.max) this.traces.shift();
  }

  /** A snapshot of retained traces, oldest first. */
  public list(): readonly TurnTrace[] {
    return [...this.traces];
  }

  /** The most recent trace, or `undefined` if none recorded. */
  public last(): TurnTrace | undefined {
    return this.traces[this.traces.length - 1];
  }

  public clear(): void {
    this.traces.length = 0;
  }
}

/**
 * Accumulates the observations of one in-flight turn, then emits a single immutable
 * {@link TurnTrace} to the sink. Keeps the orchestrator call-sites terse: start a
 * builder, note retries/usage/tool-calls as they happen, `finish()` at the boundary.
 */
export class TurnTraceBuilder {
  private retries = 0;
  private validatorRejections = 0;
  private readonly toolCalls: string[] = [];
  private usage: Usage | undefined;
  private aborted = false;
  private timedOut = false;
  private errorKind: TurnTrace['errorKind'];

  public constructor(
    private readonly mode: string,
    private readonly provider: string,
    private readonly startedAt: number,
    private readonly model?: string,
    private readonly now: () => number = Date.now,
  ) {}

  public addRetry(): void {
    this.retries += 1;
  }

  public addValidatorRejection(): void {
    this.validatorRejections += 1;
  }

  public addToolCall(name: string): void {
    this.toolCalls.push(name);
  }

  public setUsage(usage: Usage): void {
    this.usage = usage;
  }

  public markAborted(): void {
    this.aborted = true;
  }

  public markTimedOut(): void {
    this.timedOut = true;
  }

  public setErrorKind(kind: TurnTrace['errorKind']): void {
    this.errorKind = kind;
  }

  /** Build the immutable trace (omitting absent optional fields). */
  public build(): TurnTrace {
    return {
      mode: this.mode,
      provider: this.provider,
      ...(this.model !== undefined ? { model: this.model } : {}),
      latencyMs: this.now() - this.startedAt,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      retries: this.retries,
      toolCalls: [...this.toolCalls],
      validatorRejections: this.validatorRejections,
      aborted: this.aborted,
      timedOut: this.timedOut,
      ...(this.errorKind !== undefined ? { errorKind: this.errorKind } : {}),
    };
  }

  /** Build and emit to the sink in one call. */
  public finish(sink: TurnTracer): TurnTrace {
    const trace = this.build();
    sink.record(trace);
    return trace;
  }
}
