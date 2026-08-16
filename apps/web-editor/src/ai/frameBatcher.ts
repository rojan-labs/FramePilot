/**
 * Frame-coalescing event batcher for the streaming AI sidebar (Phase 15 H1).
 *
 * A fast model can emit hundreds of stream events per second; dispatching one React
 * update per event burns the main thread on re-renders without making the text
 * appear any sooner than the display can paint. This batcher buffers pushed items
 * and flushes them as ONE batch per animation frame — tokens are never delayed by
 * more than a frame (~16ms at 60Hz), and render work is bounded at one commit per
 * frame regardless of chunk rate.
 *
 * `flush()` drains synchronously (used on run completion/error so terminal events
 * are ordered after every streamed chunk). Pure logic with injectable scheduling,
 * unit-tested without a DOM clock.
 */

export interface FrameBatcher<T> {
  /** Buffer one item; schedules a flush on the next frame if none is pending. */
  push(item: T): void;
  /** Synchronously flush anything pending (no-op when the buffer is empty). */
  flush(): void;
}

/** Schedule/cancel pair — defaults to `requestAnimationFrame`, injectable for tests. */
export interface FrameScheduler {
  readonly schedule: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
}

/**
 * A bounded-frequency scheduler for expensive streaming UI. Event ingestion stays
 * lossless, but React/Markdown work need not run at display refresh rate; 20 Hz is
 * visually continuous for text while leaving most main-thread time to the editor.
 */
export function createIntervalScheduler(intervalMs: number): FrameScheduler {
  const delay = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 50;
  return {
    schedule: (callback) => setTimeout(callback, delay) as unknown as number,
    cancel: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  };
}

const defaultScheduler = (): FrameScheduler =>
  typeof requestAnimationFrame === 'function'
    ? {
        schedule: (callback) => requestAnimationFrame(callback),
        cancel: (handle) => cancelAnimationFrame(handle),
      }
    : {
        // Non-browser fallback (tests/SSR): a macrotask keeps ordering guarantees.
        schedule: (callback) => setTimeout(callback, 16) as unknown as number,
        cancel: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
      };

/**
 * Create a {@link FrameBatcher} delivering buffered items to `onFlush` once per frame.
 *
 * @param onFlush - Receives every buffered item, in push order.
 * @param scheduler - Frame scheduler (injectable for deterministic tests).
 */
export function createFrameBatcher<T>(
  onFlush: (items: readonly T[]) => void,
  scheduler: FrameScheduler = defaultScheduler(),
): FrameBatcher<T> {
  let buffer: T[] = [];
  let handle: number | null = null;

  const flush = (): void => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];
    onFlush(items);
  };

  return {
    push(item: T): void {
      buffer.push(item);
      if (handle === null) {
        handle = scheduler.schedule(() => {
          handle = null;
          flush();
        });
      }
    },
    flush,
  };
}
