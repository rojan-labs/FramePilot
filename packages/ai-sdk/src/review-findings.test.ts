import { describe, expect, it } from 'vitest';
import type { TimelineDiff } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  DEFAULT_MAX_REVIEW_CONCURRENCY,
  ReviewFindingQueue,
  describeFindings,
  resolveReviewConcurrency,
  regionsOverlap,
  selectLiveFindings,
  touchedRegion,
  touchedRegionOf,
  type ReviewFinding,
  type TouchedRegion,
} from './review-findings.js';

interface ClipSeed {
  readonly id: string;
  readonly start?: number;
  readonly end?: number;
}

interface TrackSeed {
  readonly id: string;
  readonly clips: readonly ClipSeed[];
  readonly muted?: boolean;
}

function timeline(tracks: readonly TrackSeed[]): Timeline {
  return {
    revision: 1,
    tracks: tracks.map((track) => ({
      id: track.id,
      type: 'video',
      hidden: false,
      muted: track.muted ?? false,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        assetId: 'asset_1',
        start: clip.start ?? 0,
        end: clip.end ?? 1,
        effects: [],
      })),
    })),
  } as unknown as Timeline;
}

function diffOf(before: readonly TrackSeed[], after: readonly TrackSeed[]): TimelineDiff {
  return { before: timeline(before), after: timeline(after), summary: [] };
}

const region = (trackIds: readonly string[], clipIds: readonly string[]): TouchedRegion => ({
  trackIds: new Set(trackIds),
  clipIds: new Set(clipIds),
});

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'finding_1',
    turnIndex: 0,
    detail: 'A 3-frame black flash at the cut.',
    lineage: ['temporal:decision=fail'],
    scope: {
      projectRevision: 4,
      patchId: 'patch_a',
      trackIds: new Set(['track_v1']),
      clipIds: new Set(['clip_a']),
    },
    ...over,
  };
}

describe('touchedRegion', () => {
  it('reports a clip whose timing changed, and its track', () => {
    const result = touchedRegion(
      diffOf(
        [{ id: 'track_v1', clips: [{ id: 'clip_a', end: 5 }] }],
        [{ id: 'track_v1', clips: [{ id: 'clip_a', end: 3 }] }],
      ),
    );
    expect([...result.clipIds]).toEqual(['clip_a']);
    expect([...result.trackIds]).toEqual(['track_v1']);
  });

  it('ignores a clip that did not change', () => {
    const unchanged = [{ id: 'track_v1', clips: [{ id: 'clip_a' }, { id: 'clip_b' }] }] as const;
    const result = touchedRegion(diffOf(unchanged, unchanged));
    expect(result.clipIds.size).toBe(0);
    expect(result.trackIds.size).toBe(0);
  });

  it('reports added and removed clips', () => {
    const added = touchedRegion(
      diffOf([{ id: 'track_v1', clips: [] }], [{ id: 'track_v1', clips: [{ id: 'clip_new' }] }]),
    );
    expect([...added.clipIds]).toEqual(['clip_new']);

    const removed = touchedRegion(
      diffOf([{ id: 'track_v1', clips: [{ id: 'clip_gone' }] }], [{ id: 'track_v1', clips: [] }]),
    );
    expect([...removed.clipIds]).toEqual(['clip_gone']);
  });

  // A move re-answers the continuity question on BOTH sides, so a finding about either
  // track is stale — hence both must be reported, not just the destination.
  it('marks both tracks when a clip moves between them', () => {
    const result = touchedRegion(
      diffOf(
        [
          { id: 'track_v1', clips: [{ id: 'clip_a' }] },
          { id: 'track_v2', clips: [] },
        ],
        [
          { id: 'track_v1', clips: [] },
          { id: 'track_v2', clips: [{ id: 'clip_a' }] },
        ],
      ),
    );
    expect([...result.clipIds]).toEqual(['clip_a']);
    expect([...result.trackIds].sort()).toEqual(['track_v1', 'track_v2']);
  });

  it('reports a track-level change that touched no clip', () => {
    const result = touchedRegion(
      diffOf(
        [{ id: 'track_a1', clips: [{ id: 'clip_a' }], muted: false }],
        [{ id: 'track_a1', clips: [{ id: 'clip_a' }], muted: true }],
      ),
    );
    expect(result.clipIds.size).toBe(0);
    expect([...result.trackIds]).toEqual(['track_a1']);
  });

  it('reports an added track', () => {
    const result = touchedRegion(
      diffOf(
        [{ id: 'track_v1', clips: [] }],
        [
          { id: 'track_v1', clips: [] },
          { id: 'track_v2', clips: [] },
        ],
      ),
    );
    expect([...result.trackIds]).toEqual(['track_v2']);
  });

  it('treats a missing diff as an empty region', () => {
    const result = touchedRegionOf(undefined);
    expect(result.clipIds.size).toBe(0);
    expect(result.trackIds.size).toBe(0);
  });

  it('delegates to touchedRegion when a diff is present', () => {
    const result = touchedRegionOf(
      diffOf(
        [{ id: 'track_v1', clips: [{ id: 'clip_a', end: 5 }] }],
        [{ id: 'track_v1', clips: [{ id: 'clip_a', end: 2 }] }],
      ),
    );
    expect([...result.clipIds]).toEqual(['clip_a']);
  });
});

describe('regionsOverlap', () => {
  it('is true on a shared clip and on a shared track', () => {
    expect(regionsOverlap(region([], ['clip_a']), region([], ['clip_a']))).toBe(true);
    expect(regionsOverlap(region(['track_v1'], []), region(['track_v1'], []))).toBe(true);
  });

  it('is false for disjoint regions', () => {
    expect(regionsOverlap(region(['track_v1'], ['clip_a']), region(['track_v2'], ['clip_b']))).toBe(
      false,
    );
  });

  it('is false when either side is empty', () => {
    expect(regionsOverlap(region([], []), region(['track_v1'], ['clip_a']))).toBe(false);
  });

  // The intersection iterates the smaller set, so the answer must not depend on which
  // argument that happens to be.
  it('is symmetric regardless of which side is larger', () => {
    const small = region(['track_v1'], ['clip_b']);
    const large = region(['track_v1', 'track_v2', 'track_v3'], ['clip_a', 'clip_b', 'clip_c']);
    expect(regionsOverlap(small, large)).toBe(true);
    expect(regionsOverlap(large, small)).toBe(true);
  });
});

describe('selectLiveFindings', () => {
  it('drops a finding whose region a later turn rewrote', () => {
    const live = selectLiveFindings(
      [finding({ turnIndex: 1 })],
      new Map([[2, region([], ['clip_a'])]]),
    );
    expect(live).toEqual([]);
  });

  it('keeps a finding a later turn did not touch', () => {
    const live = selectLiveFindings(
      [finding({ turnIndex: 1 })],
      new Map([[2, region(['track_v9'], ['clip_z'])]]),
    );
    expect(live).toHaveLength(1);
  });

  // The reviewed turn's own edit is what produced the finding, so it can never invalidate
  // it — only turns AFTER it can.
  it('ignores the reviewed turn and earlier turns', () => {
    const live = selectLiveFindings(
      [finding({ turnIndex: 2 })],
      new Map([
        [1, region([], ['clip_a'])],
        [2, region([], ['clip_a'])],
      ]),
    );
    expect(live).toHaveLength(1);
  });

  it('keeps a finding that names no specific region', () => {
    const unattributed = finding({
      scope: {
        projectRevision: 4,
        patchId: 'patch_a',
        trackIds: new Set<string>(),
        clipIds: new Set<string>(),
      },
    });
    const live = selectLiveFindings(
      [unattributed],
      new Map([[1, region(['track_v1'], ['clip_a'])]]),
    );
    expect(live).toHaveLength(1);
  });
});

describe('ReviewFindingQueue', () => {
  it('yields a settled review’s findings without waiting for a pending one', async () => {
    const queue = new ReviewFindingQueue();
    queue.recordTurn(0, region(['track_v1'], ['clip_a']));
    queue.recordTurn(1, region(['track_v2'], ['clip_b']));
    queue.track(0, () => Promise.resolve([finding({ turnIndex: 0 })]));
    queue.track(1, () => new Promise(() => undefined));

    const drained = await queue.drainSettled();
    expect(drained).toHaveLength(1);
    expect(queue.hasPending).toBe(true);
  });

  // A real review resolves through acquire → measure → critique, several microtasks deep.
  it('drains a review that resolved through a deep async chain', async () => {
    const queue = new ReviewFindingQueue();
    queue.recordTurn(0, region(['track_v1'], ['clip_a']));
    queue.track(0, async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return [finding({ turnIndex: 0 })];
    });

    expect(await queue.drainSettled()).toHaveLength(1);
  });

  it('does not re-yield a finding it already drained', async () => {
    const queue = new ReviewFindingQueue();
    queue.recordTurn(0, region(['track_v1'], ['clip_a']));
    queue.track(0, () => Promise.resolve([finding({ turnIndex: 0 })]));

    expect(await queue.drainSettled()).toHaveLength(1);
    expect(await queue.drainSettled()).toHaveLength(0);
  });

  it('drops a finding invalidated by a turn committed while its review ran', async () => {
    const queue = new ReviewFindingQueue();
    queue.recordTurn(0, region(['track_v1'], ['clip_a']));
    queue.track(0, () => Promise.resolve([finding({ turnIndex: 0 })]));
    // Turn 1 rewrites the very clip turn 0's review is about.
    queue.recordTurn(1, region(['track_v1'], ['clip_a']));

    expect(await queue.drainAll()).toEqual([]);
  });

  it('waits for every outstanding review in drainAll', async () => {
    const queue = new ReviewFindingQueue();
    queue.recordTurn(0, region(['track_v1'], ['clip_a']));
    let release: ((value: readonly ReviewFinding[]) => void) | undefined;
    queue.track(
      0,
      () =>
        new Promise<readonly ReviewFinding[]>((resolve) => {
          release = resolve;
        }),
    );
    setTimeout(() => release?.([finding({ turnIndex: 0 })]), 0);

    expect(await queue.drainAll()).toHaveLength(1);
    expect(queue.hasPending).toBe(false);
  });

  // An unreachable reviewer is not a verdict about the edit: it must neither fail the run
  // nor be mistaken for "reviewed and clean".
  it('records a failed review as a failure and contributes no findings', async () => {
    const queue = new ReviewFindingQueue();
    queue.recordTurn(0, region(['track_v1'], ['clip_a']));
    queue.track(0, () => Promise.reject(new Error('Temporal evidence engine unreachable.')));

    expect(await queue.drainAll()).toEqual([]);
    expect(queue.reviewFailures).toEqual(['Temporal evidence engine unreachable.']);
    expect(queue.hasPending).toBe(false);
  });

  // One engine outage fails every batch in the turn with the identical message. The
  // run must report that as one problem at a scale, not as N separate problems.
  it('collapses the identical failure message and keeps its scale', async () => {
    const queue = new ReviewFindingQueue();
    const same =
      'Temporal evidence engine rejected the batch (503): projects_root is not configured.';
    // Distinct regions so no turn supersedes another: three real reviews, one outage.
    for (const turn of [0, 1, 2]) {
      queue.recordTurn(turn, region([`track_v${String(turn)}`], [`clip_${String(turn)}`]));
      queue.track(turn, () => Promise.reject(new Error(same)));
    }
    await queue.drainAll();
    expect(queue.reviewFailures).toEqual([`${same} (3 reviews)`]);
  });

  it('keeps distinct failure messages separate, in first-seen order', async () => {
    const queue = new ReviewFindingQueue();
    queue.recordTurn(0, region(['track_v1'], ['clip_a']));
    queue.track(0, () => Promise.reject(new Error('first')));
    await queue.drainAll();
    queue.recordTurn(1, region(['track_v1'], ['clip_a']));
    queue.track(1, () => Promise.reject(new Error('second')));
    await queue.drainAll();
    expect(queue.reviewFailures).toEqual(['first', 'second']);
  });

  it('stringifies a non-Error rejection', async () => {
    const queue = new ReviewFindingQueue();
    queue.track(0, () => Promise.reject('sidecar gone'));
    await queue.drainAll();
    expect(queue.reviewFailures).toEqual(['sidecar gone']);
  });

  // The crash this bound exists for: every committed turn used to start a full sidecar
  // review immediately, so a fast multi-turn run held one UHD frame batch per turn at once.
  describe('admission control', () => {
    it('never runs more reviews at once than the bound allows', async () => {
      const queue = new ReviewFindingQueue(2);
      let live = 0;
      let peak = 0;
      const releases: (() => void)[] = [];
      for (let turn = 0; turn < 8; turn += 1) {
        // Disjoint regions, so nothing is skipped as superseded and the pool is the only
        // thing keeping the count down.
        queue.recordTurn(turn, region([`track_${String(turn)}`], [`clip_${String(turn)}`]));
        queue.track(turn, async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise<void>((resolve) => releases.push(resolve));
          live -= 1;
          return [];
        });
      }

      // Let the pool start whatever it is willing to start before releasing anything.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(peak).toBe(2);

      const drained = queue.drainAll();
      while (releases.length > 0) {
        releases.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await drained;
      expect(peak).toBe(2);
      expect(queue.hasPending).toBe(false);
    });

    // The saving that makes a long run flat: work whose result was already destined to be
    // discarded is never paid for at all.
    it('never starts a review a later turn has already superseded', async () => {
      const queue = new ReviewFindingQueue(1);
      const started: number[] = [];

      queue.recordTurn(0, region(['track_v1'], ['clip_a']));
      queue.track(0, () => {
        started.push(0);
        return new Promise<readonly ReviewFinding[]>(() => undefined);
      });
      // Turn 1 rewrites the same clip before turn 0's review has been dispatched.
      queue.recordTurn(1, region(['track_v1'], ['clip_a']));
      queue.track(1, () => {
        started.push(1);
        return Promise.resolve([finding({ turnIndex: 1 })]);
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      // Turn 0's render is never dispatched at all — its finding was already destined to be
      // dropped by `selectLiveFindings`, so turn 1 gets the slot instead.
      expect(started).toEqual([1]);
      expect(queue.supersededCount).toBe(1);
      expect(await queue.drainSettled()).toHaveLength(1);
    });

    it('skips a queued review whose region was rewritten before it could start', async () => {
      const queue = new ReviewFindingQueue(1);
      let startedTurnOne = false;
      queue.recordTurn(0, region(['track_v1'], ['clip_a']));
      queue.track(0, () => new Promise<readonly ReviewFinding[]>(() => undefined));
      queue.recordTurn(1, region(['track_v2'], ['clip_b']));
      queue.track(1, () => {
        startedTurnOne = true;
        return Promise.resolve([finding({ turnIndex: 1 })]);
      });
      // Turn 2 rewrites turn 1's clip while turn 1 is still queued behind turn 0.
      queue.recordTurn(2, region(['track_v2'], ['clip_b']));

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(startedTurnOne).toBe(false);
      expect(queue.supersededCount).toBeGreaterThanOrEqual(1);
    });

    // A cancellation we chose is not evidence about the user's edit, and must never reach
    // them as "review could not run".
    it('does not report a review it superseded as a reviewer failure', async () => {
      const queue = new ReviewFindingQueue(1);
      queue.recordTurn(0, region(['track_v1'], ['clip_a']));
      queue.track(
        0,
        (signal) =>
          new Promise<readonly ReviewFinding[]>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      );
      queue.recordTurn(1, region(['track_v1'], ['clip_a']));

      expect(await queue.drainAll()).toEqual([]);
      expect(queue.reviewFailures).toEqual([]);
    });

    // drainAll runs after the agent stops; a review still queued behind the pool at that
    // moment must still be waited for, or its finding is silently lost.
    it('drains a review still queued behind the pool', async () => {
      const queue = new ReviewFindingQueue(1);
      let release: (() => void) | undefined;
      queue.recordTurn(0, region(['track_v1'], ['clip_a']));
      queue.track(
        0,
        () =>
          new Promise<readonly ReviewFinding[]>((resolve) => {
            release = () => resolve([]);
          }),
      );
      queue.recordTurn(1, region(['track_v2'], ['clip_b']));
      queue.track(1, () => Promise.resolve([finding({ turnIndex: 1 })]));

      await new Promise((resolve) => setTimeout(resolve, 0));
      const drained = queue.drainAll();
      release?.();
      expect(await drained).toHaveLength(1);
      expect(queue.hasPending).toBe(false);
    });
  });

  describe('resolveReviewConcurrency', () => {
    it('defaults when unset, blank, non-numeric, or below one', () => {
      for (const raw of [undefined, '', '  ', 'many', '0', '-3']) {
        expect(resolveReviewConcurrency(raw)).toBe(DEFAULT_MAX_REVIEW_CONCURRENCY);
      }
    });

    it('floors a usable override', () => {
      expect(resolveReviewConcurrency('3')).toBe(3);
      expect(resolveReviewConcurrency('2.9')).toBe(2);
    });
  });

  describe('resolution', () => {
    // Resolution requires a clean *review* of the overlapping revision, not merely an edit to
    // its region — an edit is only an attempt; a clean review is the evidence it worked.
    it('resolves a delivered finding once a later turn is reviewed clean over its region', async () => {
      const queue = new ReviewFindingQueue();
      queue.recordTurn(0, region(['track_v1'], ['clip_a']));
      queue.markDelivered([finding({ turnIndex: 0 })]);
      expect(queue.takeResolved()).toEqual([]);

      queue.recordTurn(1, region(['track_v1'], ['clip_a']));
      queue.track(1, () => Promise.resolve([]));
      await queue.drainAll();
      expect(queue.takeResolved()).toHaveLength(1);
    });

    // Crediting the run with a repair it never knew to make would overstate what it did.
    it('never resolves a finding that was not delivered', async () => {
      const queue = new ReviewFindingQueue();
      queue.recordTurn(0, region(['track_v1'], ['clip_a']));
      queue.recordTurn(1, region(['track_v1'], ['clip_a']));
      queue.track(1, () => Promise.resolve([]));
      await queue.drainAll();
      expect(queue.takeResolved()).toEqual([]);
    });

    it('does not resolve on a clean review elsewhere', async () => {
      const queue = new ReviewFindingQueue();
      queue.markDelivered([finding({ turnIndex: 0 })]);
      queue.recordTurn(1, region(['track_v9'], ['clip_z']));
      queue.track(1, () => Promise.resolve([]));
      await queue.drainAll();
      expect(queue.takeResolved()).toEqual([]);
    });

    it('resolves each finding exactly once', async () => {
      const queue = new ReviewFindingQueue();
      queue.markDelivered([finding({ turnIndex: 0 })]);
      queue.recordTurn(1, region(['track_v1'], ['clip_a']));
      queue.track(1, () => Promise.resolve([]));
      await queue.drainAll();
      expect(queue.takeResolved()).toHaveLength(1);
      expect(queue.takeResolved()).toEqual([]);
    });
  });

  // The captured run's steering loop: one defect, re-detected on every turn that touched the
  // region, re-instructed every time, never fixable by a proposal.
  describe('steering budget', () => {
    it('steers a defect class once, then reports later repeats as exhausted', () => {
      const queue = new ReviewFindingQueue();
      const first = queue.admitForSteering([finding({ id: 'f1' })]);
      expect(first.steer).toHaveLength(1);
      expect(first.exhausted).toEqual([]);
      queue.markDelivered(first.steer);

      const second = queue.admitForSteering([finding({ id: 'f2', turnIndex: 1 })]);
      expect(second.steer).toEqual([]);
      expect(second.exhausted).toHaveLength(1);
      expect(queue.hasExhaustedSteering(finding())).toBe(true);
    });

    it('treats the same defect at different frames as one class', () => {
      const queue = new ReviewFindingQueue();
      queue.admitForSteering([
        finding({ id: 'f1', detail: 'Unexpected black frame(s): 90, 91, 92.' }),
      ]);
      const again = queue.admitForSteering([
        finding({ id: 'f2', detail: 'Unexpected black frame(s): 300.' }),
      ]);
      expect(again.steer).toEqual([]);
      expect(again.exhausted).toHaveLength(1);
    });

    it('still steers a genuinely different defect', () => {
      const queue = new ReviewFindingQueue();
      queue.admitForSteering([finding({ id: 'f1', detail: 'Unexpected black frame(s): 90.' })]);
      const other = queue.admitForSteering([
        finding({ id: 'f2', detail: 'Audio peak 0.4 dBFS exceeds -1 dBFS.' }),
      ]);
      expect(other.steer).toHaveLength(1);
      expect(other.exhausted).toEqual([]);
    });
  });
});

describe('describeFindings', () => {
  // GAP-005. The unresolved-review warning joined every detail end to end: fifteen
  // sentences describing one fact at fifteen frame numbers, which reads as fifteen
  // problems and names none of them.
  it('reports one line per defect, with a count when the same defect repeats', () => {
    const text = describeFindings([
      finding({ id: 'f1', detail: 'Unexpected black frame(s): 0, 1, 2.' }),
      finding({ id: 'f2', detail: 'Unexpected black frame(s): 90, 91.' }),
      finding({ id: 'f3', detail: 'Unexpected black frame(s): 300.' }),
      finding({ id: 'f4', detail: 'Audio peak 0.4 dBFS exceeds -1 dBFS.' }),
    ]);
    expect(text).toContain('Unexpected black frame(s): 0, 1, 2. (reported at 3 places)');
    expect(text).toContain('Audio peak 0.4 dBFS exceeds -1 dBFS.');
    // One line per cause, not one per measurement.
    expect(text.match(/Unexpected black/g)).toHaveLength(1);
  });

  it('leaves a single finding exactly as it was written', () => {
    const one = finding({ id: 'f1', detail: 'Unexpected black frame(s): 90.' });
    expect(describeFindings([one])).toBe('Unexpected black frame(s): 90.');
    expect(describeFindings([])).toBe('');
  });
});
