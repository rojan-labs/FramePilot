import { describe, expect, it, vi } from 'vitest';
import { createAssetEnroller } from './asset-enrolment.js';

interface Call {
  readonly projectId: string;
  readonly assetIds: readonly string[];
}

/** An enrol stub that completes immediately, recording every batch it received. */
function immediate() {
  const calls: Call[] = [];
  const enrol = vi.fn(async ({ projectId, assetIds }: Call) => {
    calls.push({ projectId, assetIds: [...assetIds] });
  });
  return { calls, enrol };
}

/** An enrol stub the test finishes by hand, for observing what is in flight. */
function gated() {
  const calls: Call[] = [];
  const releases: Array<() => void> = [];
  const enrol = vi.fn(async ({ projectId, assetIds }: Call) => {
    calls.push({ projectId, assetIds: [...assetIds] });
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  /** Finish every batch, including any the finished ones go on to schedule. */
  const releaseAll = async (): Promise<void> => {
    for (let guard = 0; guard < 100; guard += 1) {
      while (releases.length > 0) releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (releases.length === 0) return;
    }
    throw new Error('batches never stopped scheduling');
  };
  return { calls, enrol, releaseAll };
}

/** Let every already-scheduled microtask and its continuations run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createAssetEnroller', () => {
  it('sends a same-tick burst as ONE batch, not one loop per asset', async () => {
    // The 42-download turn. Each of those started its own `runVisualIndexLoop`, and they
    // then queued on the engine's per-project lock while holding threadpool slots.
    const { enrol, calls } = immediate();
    const enroller = createAssetEnroller({ enrol, signal: new AbortController().signal });

    for (let i = 0; i < 42; i += 1) enroller.request('p1', `asset_${i}`);
    await enroller.settled();

    expect(enrol).toHaveBeenCalledTimes(1);
    expect(calls[0]?.assetIds).toHaveLength(42);
  });

  it('never enrols the same asset twice', async () => {
    // The warm pass and the serial commit both reach this, and a re-requested id that hits
    // the bin dedupe reaches it a third time.
    const { enrol, calls } = immediate();
    const enroller = createAssetEnroller({ enrol, signal: new AbortController().signal });

    enroller.request('p1', 'a1'); // warm
    enroller.request('p1', 'a1'); // serial commit
    await enroller.settled();
    enroller.request('p1', 'a1'); // a later turn re-requests the same clip
    await enroller.settled();

    expect(enrol).toHaveBeenCalledTimes(1);
    expect(calls[0]?.assetIds).toEqual(['a1']);
  });

  it('holds one batch in flight per project and folds arrivals into the next', async () => {
    // The invariant. The engine serializes a project's index slices behind one lock, so a
    // second concurrent loop can only wait — on a threadpool thread.
    const { enrol, calls, releaseAll } = gated();
    const enroller = createAssetEnroller({ enrol, signal: new AbortController().signal });

    enroller.request('p1', 'a1');
    await flush();
    expect(enrol).toHaveBeenCalledTimes(1);

    enroller.request('p1', 'a2');
    enroller.request('p1', 'a3');
    await flush();
    expect(enrol).toHaveBeenCalledTimes(1); // still exactly one in flight

    await releaseAll();
    await enroller.settled();

    expect(enrol).toHaveBeenCalledTimes(2);
    expect(calls[0]?.assetIds).toEqual(['a1']);
    expect(calls[1]?.assetIds).toEqual(['a2', 'a3']);
  });

  it('is harmless when a scheduled drain finds the batch already sent', async () => {
    // Every new id schedules a drain, but the FIRST drain to run takes the whole queue.
    // The rest must find nothing and do nothing — including settling any `settled()`
    // waiter, or a burst would leave one hanging on work that had already gone out.
    const { enrol, calls } = immediate();
    const scheduled: Array<() => void> = [];
    const enroller = createAssetEnroller({
      enrol,
      signal: new AbortController().signal,
      schedule: (run) => scheduled.push(run),
    });

    enroller.request('p1', 'a1');
    enroller.request('p1', 'a2');
    expect(scheduled).toHaveLength(2);

    scheduled[0]!(); // takes both ids
    await flush();
    scheduled[1]!(); // nothing left to take
    await enroller.settled();

    expect(enrol).toHaveBeenCalledTimes(1);
    expect(calls[0]?.assetIds).toEqual(['a1', 'a2']);
  });

  it('still runs unrelated projects concurrently', async () => {
    // The engine's lock is keyed by project; serializing across projects would be a bound
    // it never asked for.
    const { enrol, releaseAll } = gated();
    const enroller = createAssetEnroller({ enrol, signal: new AbortController().signal });

    enroller.request('p1', 'a1');
    enroller.request('p2', 'b1');
    await flush();

    expect(enrol).toHaveBeenCalledTimes(2);
    await releaseAll();
    await enroller.settled();
  });

  it('starts nothing once the app signal has aborted', async () => {
    const { enrol } = immediate();
    const controller = new AbortController();
    const enroller = createAssetEnroller({ enrol, signal: controller.signal });

    controller.abort();
    enroller.request('p1', 'a1');
    await enroller.settled();

    expect(enrol).not.toHaveBeenCalled();
  });

  it('stops scheduling follow-up batches after an abort mid-flight', async () => {
    const { enrol, releaseAll } = gated();
    const controller = new AbortController();
    const enroller = createAssetEnroller({ enrol, signal: controller.signal });

    enroller.request('p1', 'a1');
    await flush();
    enroller.request('p1', 'a2');
    controller.abort();
    await releaseAll();
    await enroller.settled();

    expect(enrol).toHaveBeenCalledTimes(1);
  });

  it('hands the abort signal to the batch so an in-flight loop can be cancelled', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const enrol = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      seen.push(signal);
    });
    const enroller = createAssetEnroller({ enrol, signal: controller.signal });

    enroller.request('p1', 'a1');
    await enroller.settled();

    expect(seen[0]).toBe(controller.signal);
  });

  it('survives a failing batch and keeps enrolling afterwards', async () => {
    // Enrolment is an optimization; a run that cannot index must still place footage.
    const enrol = vi
      .fn()
      .mockRejectedValueOnce(new Error('sidecar down'))
      .mockResolvedValue(undefined);
    const enroller = createAssetEnroller({ enrol, signal: new AbortController().signal });

    enroller.request('p1', 'a1');
    await enroller.settled();
    enroller.request('p1', 'a2');
    await enroller.settled();

    expect(enrol).toHaveBeenCalledTimes(2);
  });

  it('bounds how many projects it remembers', async () => {
    const enrol = vi.fn(async () => undefined);
    const enroller = createAssetEnroller({
      enrol,
      signal: new AbortController().signal,
      maxTrackedProjects: 2,
    });

    for (const project of ['p1', 'p2', 'p3']) enroller.request(project, 'a1');
    await enroller.settled();
    expect(enrol).toHaveBeenCalledTimes(3);

    enroller.request('p1', 'a1'); // evicted → re-enrolled, which is the safe direction
    await enroller.settled();
    expect(enrol).toHaveBeenCalledTimes(4);

    enroller.request('p3', 'a1'); // still remembered
    await enroller.settled();
    expect(enrol).toHaveBeenCalledTimes(4);
  });
});
