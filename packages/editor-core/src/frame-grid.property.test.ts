/**
 * The frame grid, over generated operation sequences (ADR 0146).
 *
 * The grid's highest-risk detail is not the rounding — it is UNDO. Quantization was
 * deliberately NOT put inside `applyOperation`, because the inverse of an operation is
 * computed from the operation, so an apply that quantized privately would invert to a
 * different state than it applied from and undo would drift a fraction of a frame per
 * edit. `commitProjectPatch` therefore quantizes the patch once, up front, and `apply`,
 * `invert`, `validate` and the recorded history entry all see the same numbers.
 *
 * These properties are what prove that:
 *
 *  1. Every sequence edit point that reaches the timeline is on the grid, whatever
 *     fractional times the caller asked for.
 *  2. Applying a chain and undoing it restores the timeline EXACTLY, by structural
 *     equality (`revision` excluded — it is a monotonic clock, so undo advances it).
 *  3. Quantization is idempotent, which is what lets the UI quantize to validate and the
 *     history authority quantize again to commit.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Project, Timeline } from '@framepilot/timeline-schema';
import type { PatchId } from '@framepilot/shared-types';
import type { Patch } from './patch.js';
import { commitProjectPatch, emptyHistory, undoProject } from './history.js';
import { quantizePatch, secondsToFrame, frameToSeconds } from './frame-grid.js';
import type { Operation } from './operations.js';

const clip = (id: string, start: number, end: number): Clip => ({
  id,
  trackId: 'video_1',
  assetId: 'asset_1',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

function seedProject(fps: number): Project {
  // Seeded ON the grid: a project authored before ADR 0146 keeps its off-grid times until
  // an edit touches them (that is the whole reason option (a) needs no migration), so an
  // off-grid seed would make this property test assert a guarantee the ADR does not make.
  const s = (seconds: number): number => frameToSeconds(secondsToFrame(seconds, fps), fps);
  return {
    id: 'proj_grid',
    name: 'Grid',
    version: 1,
    fps,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 120 }],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip('a', s(0), s(10)),
            clip('b', s(10), s(20)),
            clip('c', s(20), s(30)),
            clip('d', s(30), s(40)),
          ],
        },
        { id: 'overlay_1', type: 'overlay', clips: [] },
      ],
      revision: 0,
    },
    transcript: [],
    markers: [],
    folders: [],
    aiMemory: {},
    history: [],
  } as unknown as Project;
}

/** Deterministic PRNG — a failing seed is a reproducible failing seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const videoClips = (timeline: Timeline): readonly Clip[] =>
  timeline.tracks.find((track) => track.id === 'video_1')?.clips ?? [];

/**
 * One legal operation with a DELIBERATELY off-grid time — the whole point is that a
 * caller asking for 12.3874s gets a frame, not a rejection and not 12.3874s.
 */
function proposeOffGridOperation(timeline: Timeline, rng: () => number): Operation | undefined {
  const clips = videoClips(timeline);
  if (clips.length === 0) return undefined;
  const target = clips[Math.floor(rng() * clips.length)]!;
  const span = target.end - target.start;
  if (span <= 2) return undefined;
  const kind = Math.floor(rng() * 3);
  // A fractional offset that is never a whole frame at any of the probed rates.
  const jitter = (): number => rng() * (span - 2) + 0.0137;
  if (kind === 0) {
    return {
      type: 'trim_clip',
      clipId: target.id,
      start: target.start + jitter(),
      end: target.end,
    };
  }
  if (kind === 1) {
    return { type: 'split_clip', clipId: target.id, at: target.start + 1 + jitter() * 0.5 };
  }
  const from = target.start + 0.5 + rng() * 0.3137;
  return {
    type: 'ripple_delete',
    trackId: 'video_1',
    start: from,
    end: Math.min(from + 1.0137, target.end - 0.1),
  };
}

const patchOf = (operations: readonly Operation[], n: number): Patch => ({
  patchId: `patch_${String(n)}` as PatchId,
  createdBy: 'user',
  reason: 'property',
  operations,
});

/** Every sequence time a clip carries. Source times are excluded by design (ADR 0146). */
const sequenceTimes = (timeline: Timeline): number[] =>
  timeline.tracks.flatMap((track) => track.clips.flatMap((c) => [c.start, c.end]));

const onGrid = (seconds: number, fps: number): boolean =>
  Math.abs(frameToSeconds(secondsToFrame(seconds, fps), fps) - seconds) < 1e-9;

/**
 * Content, with times rounded to `TIME_EPSILON` — the tolerance `timeline-map.ts` already
 * uses for exactly this.
 *
 * Bitwise equality is not achievable here and asking for it would be asking for the wrong
 * thing. A frame at 24fps is 1/24 of a second, which has no exact binary representation;
 * `trim_clip` shifts the source window by `newStart - oldStart`, and applying that delta
 * and its negation to a non-representable value lands one unit in the last place away —
 * about 2e-15 seconds, nine orders of magnitude below the smallest tolerance in the stack.
 * What the property is actually about is drift that ACCUMULATES, and rounding at 1e-6
 * catches that on the first step it appears.
 */
const TIME_EPSILON_DIGITS = 6;
const round = (n: number): number => Number(n.toFixed(TIME_EPSILON_DIGITS));
const content = (timeline: Timeline): unknown =>
  timeline.tracks.map((track) => ({
    id: track.id,
    clips: track.clips.map((c) => ({
      ...c,
      start: round(c.start),
      end: round(c.end),
      sourceStart: round(c.sourceStart),
      sourceEnd: round(c.sourceEnd),
    })),
  }));

const RATES = [24, 25, 29.97, 30, 59.94, 60];

describe('the frame grid holds over generated operation sequences', () => {
  it('puts every applied edit point on the grid, at every probed frame rate', () => {
    for (const fps of RATES) {
      for (let seed = 1; seed <= 12; seed += 1) {
        const rng = mulberry32(seed * 7919 + Math.round(fps * 100));
        let project = seedProject(fps);
        let history = emptyHistory();
        for (let step = 0; step < 8; step += 1) {
          const op = proposeOffGridOperation(project.timeline, rng);
          if (!op) continue;
          try {
            const committed = commitProjectPatch(project, history, patchOf([op], step));
            project = committed.project;
            history = committed.history;
          } catch {
            // An operation the timeline no longer admits is the validator doing its job;
            // the property is about the ones that land.
            continue;
          }
          for (const time of sequenceTimes(project.timeline)) {
            expect(onGrid(time, fps), `fps=${fps} seed=${seed} step=${step} time=${time}`).toBe(
              true,
            );
          }
        }
      }
    }
  });

  it('undo restores the exact prior timeline after a quantized apply', () => {
    for (const fps of RATES) {
      for (let seed = 1; seed <= 12; seed += 1) {
        const rng = mulberry32(seed * 104_729 + Math.round(fps * 100));
        let project = seedProject(fps);
        let history = emptyHistory();
        for (let step = 0; step < 8; step += 1) {
          const op = proposeOffGridOperation(project.timeline, rng);
          if (!op) continue;
          const before = project;
          let committed;
          try {
            committed = commitProjectPatch(project, history, patchOf([op], step));
          } catch {
            continue;
          }
          const undone = undoProject(committed.project, committed.history);
          // The one thing a quantized apply may not do: invert to the quantized state
          // instead of the state it started from.
          expect(content(undone.project.timeline), `fps=${fps} seed=${seed} step=${step}`).toEqual(
            content(before.timeline),
          );
          project = committed.project;
          history = committed.history;
        }
      }
    }
  });

  it('is idempotent — quantizing an already-quantized patch changes nothing', () => {
    for (const fps of RATES) {
      const rng = mulberry32(42 + Math.round(fps));
      const project = seedProject(fps);
      const op = proposeOffGridOperation(project.timeline, rng);
      if (!op) continue;
      const once = quantizePatch(patchOf([op], 0), fps);
      const twice = quantizePatch(once, fps);
      expect(twice).toEqual(once);
      // And the second pass returns the SAME object, so the UI's validate-then-commit
      // double pass allocates nothing.
      expect(twice).toBe(once);
    }
  });

  it('leaves an inverse snapshot untouched — restore_clips must restore exactly', () => {
    // A `restore_clips` carrying off-grid clips (a project authored before ADR 0146)
    // must come back exactly as it was, not snapped to today's grid.
    const stale = clip('legacy', 1.234_567, 9.876_543);
    const patch = patchOf([{ type: 'restore_clips', trackId: 'video_1', clips: [stale] }], 0);
    expect(quantizePatch(patch, 30)).toBe(patch);
  });
});
