/**
 * Local-first, opt-in crash & event telemetry (plan/PLAN.md Phase 8
 * "Crash/telemetry (opt-in, local-first)").
 *
 * Principles (PRD §18 privacy):
 *  - **Opt-in:** disabled unless the user explicitly enables it. Nothing is
 *    recorded while disabled.
 *  - **Local-first:** events are appended to a JSON-lines file on the user's own
 *    machine. This module NEVER makes a network request — there is no upload. A
 *    future opt-in uploader could read the file, but transport is out of scope.
 *  - **Minimal:** events carry a name, a coarse timestamp, and a small redactable
 *    payload. Crash records carry the error name/message/stack only.
 *
 * Pure and injectable (clock + sink) so it is unit-tested without real disk/IPC.
 */

/** A single telemetry record appended to the local log. */
export interface TelemetryEvent {
  readonly type: 'event' | 'crash';
  readonly name: string;
  /** Epoch milliseconds — injected, never read from an ambient clock. */
  readonly at: number;
  readonly data?: Record<string, unknown>;
}

/** Sink that persists one serialized record (e.g. append a line to a file). */
export type TelemetrySink = (line: string) => void;

export interface TelemetryOptions {
  /** Master switch. When false, every record call is a no-op. */
  readonly enabled: boolean;
  /** Returns the current epoch-ms; injected so records are deterministic in tests. */
  readonly now: () => number;
  /** Where records go. Defaults to a no-op (drop) so a misconfig never throws. */
  readonly sink?: TelemetrySink;
}

/**
 * Reduce an unknown thrown value to a serializable crash payload. Only the error
 * name, message, and stack are kept — never arbitrary object graphs that might
 * carry user data.
 */
export function describeCrash(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { errorName: 'NonError', message: String(error), stack: null };
}

export class LocalTelemetry {
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly sink: TelemetrySink;

  public constructor(options: TelemetryOptions) {
    this.enabled = options.enabled;
    this.now = options.now;
    this.sink = options.sink ?? (() => {});
  }

  /** Record a named product event. No-op when telemetry is disabled. */
  public recordEvent(name: string, data?: Record<string, unknown>): void {
    this.write({ type: 'event', name, at: this.now(), ...(data ? { data } : {}) });
  }

  /** Record a crash (uncaught exception / renderer gone). No-op when disabled. */
  public recordCrash(error: unknown): void {
    this.write({ type: 'crash', name: 'uncaught', at: this.now(), data: describeCrash(error) });
  }

  private write(event: TelemetryEvent): void {
    if (!this.enabled) return;
    this.sink(JSON.stringify(event));
  }
}

/** Read the opt-in flag from the environment (`FRAMEPILOT_TELEMETRY=1`). */
export function telemetryEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const v = env.FRAMEPILOT_TELEMETRY;
  return v === '1' || v === 'true';
}
