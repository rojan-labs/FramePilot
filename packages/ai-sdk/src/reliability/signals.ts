/**
 * @framepilot/ai-sdk/reliability/signals — combine multiple AbortSignals into one
 * (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R1).
 *
 * The resilient stream links the caller's cancel signal with an idle-timeout signal
 * so either one cancels the upstream fetch. `AbortSignal.any` isn't available on all
 * targeted runtimes, so we implement it with a small forwarding controller.
 */

export interface CombinedSignal {
  readonly signal: AbortSignal;
  /** Detach listeners (call when the operation completes) to avoid leaks. */
  dispose(): void;
}

/**
 * Combine zero or more signals into a single `AbortSignal` that aborts as soon as any
 * input does (propagating the first input's `reason`). Aborts synchronously if an
 * input is already aborted.
 */
export function combineSignals(...signals: (AbortSignal | undefined)[]): CombinedSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];

  const abortWith = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  for (const source of present) {
    if (source.aborted) {
      abortWith(source.reason);
      break;
    }
    const onAbort = (): void => abortWith(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => source.removeEventListener('abort', onAbort));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
