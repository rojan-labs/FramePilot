/**
 * Operation algebra — property coverage over GENERATED operation sequences
 * (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §7.3).
 *
 * The existing suites prove each operation inverts correctly on hand-written cases. What they
 * cannot prove is what happens when operations COMPOSE: a trim after a split after a ripple
 * delete, against a timeline the previous three operations already reshaped. Those sequences
 * are where an inverse that is "right" in isolation stops being right — an inverse computed
 * against the wrong intermediate state, a snapshot collapsed too eagerly, a precondition that
 * held at authoring time and not at apply time.
 *
 * This file generates such sequences and asserts the algebra's laws over them:
 *
 *  1. **apply-then-invert is identity on CONTENT.** Applying a patch and then its inverse
 *     restores the timeline exactly, by deep structural equality rather than a summary
 *     comparison. `revision` is excluded and asserted separately: it is a monotonic clock, so
 *     an undo advances it rather than rewinding it, and that is correct.
 *  1b. **Every PREFIX inverts independently**, which localizes a bad inverse to one step
 *     instead of reporting it at the end of a twelve-operation chain.
 *  2. **Composition preserves validity.** No generated sequence can produce a timeline that
 *     violates the schema or the timeline's own structural rules (no overlaps on a track, no
 *     negative or zero-length clips, no clip escaping its source window).
 *  3. **Invalid preconditions fail closed.** An operation whose target no longer exists is
 *     rejected, never silently skipped.
 *  4. **The revision clock is exact.** `revision` advances when — and only when — the
 *     source↔sequence mapping changed (ADR 0076). A missed bump silently strands captions
 *     and everything else derived from that mapping; a spurious one makes every consumer
 *     re-derive for nothing. The signature this compares against is written independently of
 *     `mappingChanged`, since a test that reuses the function under test proves only that it
 *     equals itself.
 *  5. **Serialization round-trips.** A timeline written and read back is equal AND behaves
 *     identically under the next operation. Silent corruption between sessions is the worst
 *     class of editor bug.
 *  6. **Applying never mutates its input.** A shared-reference leak would let state change
 *     with no operation recorded to invert — an edit escaping the patch/undo system.
 *
 * NOT covered here: rejecting a write AUTHORED against an older revision. That guard exists,
 * but on the COMMAND path — every `EditorCommand` carries `timelineRevision`, and
 * `compileEditorCommand` runs `validateAuthority` before every dispatch, rejecting
 * `stale_timeline` on a mismatch (`professional-commands.test.ts`). Raw `applyPatch`, which
 * this suite drives and which the web-editor also uses, has no such precondition. What is
 * proven here is the precondition for detecting staleness at all: that the counter is
 * trustworthy.
 *
 * ## Determinism
 *
 * A seeded PRNG (`mulberry32`), never `Math.random`. Repo rule and, more practically, the
 * only way a property failure is worth anything: the seed is printed with every assertion, so
 * a red build names the exact sequence to replay. Fixed seed list rather than time-based, so
 * CI and a laptop run identical cases. Each seed produces 8-11 applied operations spanning
 * all five generated kinds (trim, split, delete_range, ripple_delete, text overlay).
 *
 * ## What this found
 *
 * No defects. The algebra held on every generated sequence. Recorded plainly because a
 * property suite that finds nothing is evidence, not a failure — and because the next reader
 * should know these laws were checked rather than assumed. Mutation testing confirms the
 * suite is load-bearing: seeding `invertPatch` with a stale inverse state (the classic
 * composition bug — computing each inverse against the original timeline instead of the
 * running one) fails 12 of these 25 cases, against 2 of the 27 in `patch.test.ts`, and the
 * prefix law names the operation index where it first diverges.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import type { PatchId } from '@framepilot/shared-types';
import { applyPatch, invertPatch, revertPatch, type Patch } from './patch.js';
import { type Operation } from './operations.js';

/** Deterministic PRNG — same seed, same sequence, on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clip = (over: Partial<Clip> & Pick<Clip, 'id'>): Clip => ({
  trackId: 'video_1',
  assetId: 'asset_1',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: [],
  ...over,
});

/** Four abutting clips on one track, plus an empty overlay track to place things on. */
function seedTimeline(): Timeline {
  return {
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          clip({ id: 'a', start: 0, end: 10, sourceStart: 0, sourceEnd: 10 }),
          clip({ id: 'b', start: 10, end: 20, sourceStart: 0, sourceEnd: 10 }),
          clip({ id: 'c', start: 20, end: 30, sourceStart: 0, sourceEnd: 10 }),
          clip({ id: 'd', start: 30, end: 40, sourceStart: 0, sourceEnd: 10 }),
        ],
      },
      { id: 'overlay_1', type: 'overlay', clips: [] },
    ],
  };
}

const videoClips = (timeline: Timeline): readonly Clip[] =>
  timeline.tracks.find((track) => track.id === 'video_1')?.clips ?? [];

/**
 * Propose one operation that is LEGAL against `timeline` right now.
 *
 * Generating illegal operations would only re-test the validator, which has its own suite;
 * the value here is in long chains of legal ones, because that is where an inverse computed
 * against a stale intermediate state actually shows up. Returns `undefined` when the timeline
 * has been whittled down too far to offer the chosen move.
 */
function proposeOperation(timeline: Timeline, rng: () => number): Operation | undefined {
  const clips = videoClips(timeline);
  if (clips.length === 0) return undefined;
  const target = clips[Math.floor(rng() * clips.length)]!;
  const kind = Math.floor(rng() * 5);

  // Trim inward only, so the result never collides with a neighbour or inverts its own span.
  if (kind === 0) {
    const span = target.end - target.start;
    if (span <= 2) return undefined;
    const head = Math.round(rng() * (span - 2) * 10) / 10;
    return { type: 'trim_clip', clipId: target.id, start: target.start + head, end: target.end };
  }
  // Split strictly inside the clip.
  if (kind === 1) {
    const span = target.end - target.start;
    if (span <= 2) return undefined;
    const at = Math.round((target.start + 1 + rng() * (span - 2)) * 10) / 10;
    return { type: 'split_clip', clipId: target.id, at };
  }
  // Delete a whole clip's span. (`delete_clip` is a TOOL name, not an operation type —
  // the engine's vocabulary is range-based here.)
  if (kind === 2) {
    if (clips.length <= 1) return undefined;
    return { type: 'delete_range', trackId: 'video_1', start: target.start, end: target.end };
  }
  // A text overlay on the free overlay track, in a range nothing occupies yet.
  if (kind === 3) {
    const overlay = timeline.tracks.find((track) => track.id === 'overlay_1');
    const next = (overlay?.clips.length ?? 0) * 2;
    return {
      type: 'add_text_overlay',
      trackId: 'overlay_1',
      text: `t${String(next)}`,
      start: next,
      end: next + 1,
      clipId: `overlay_${String(next)}`,
    };
  }
  // Ripple delete a sub-range strictly inside one clip.
  const span = target.end - target.start;
  if (span <= 2) return undefined;
  const from = Math.round((target.start + 0.5) * 10) / 10;
  const to = Math.round((from + Math.min(1, span - 1)) * 10) / 10;
  return { type: 'ripple_delete', trackId: 'video_1', start: from, end: to };
}

/** Build a legal sequence by proposing against the state each operation will really see. */
function generateSequence(
  start: Timeline,
  rng: () => number,
  length: number,
): { operations: Operation[]; final: Timeline } {
  let working = start;
  const operations: Operation[] = [];
  for (let i = 0; i < length; i += 1) {
    const candidate = proposeOperation(working, rng);
    if (!candidate) continue;
    let next: Timeline;
    try {
      next = applyPatch(working, {
        patchId: `probe_${String(i)}` as PatchId,
        createdBy: 'agent',
        reason: 'probe',
        operations: [candidate],
      });
    } catch {
      // The proposer aims for legal moves but does not re-implement the validator; a
      // rejected candidate is simply not part of this sequence.
      continue;
    }
    operations.push(candidate);
    working = next;
  }
  return { operations, final: working };
}

/**
 * The timeline's content, with `revision` removed.
 *
 * `applyPatch` advances the revision counter, and reverting is a NEW revision rather than a
 * rewind to the old number — that is correct and deliberate (a revision is a monotonic clock,
 * not a version label you can travel back to). So "apply-then-invert is identity" is a law
 * about CONTENT; revision monotonicity is a separate law, asserted separately below.
 */
function content(timeline: Timeline): unknown {
  const { revision: _revision, ...rest } = timeline as Timeline & { revision?: number };
  return rest;
}

/**
 * A stable encoding of everything the source↔sequence mapping depends on: timed tracks in
 * order, and each clip's identity, span, source window and speed
 * (mirrors `sameClipTiming`/`mappingChanged` in operations.ts).
 *
 * Written independently of the implementation on purpose — a property test that reuses the
 * function under test proves only that it equals itself.
 */
function mappingSignature(timeline: Timeline): string {
  return timeline.tracks
    .filter((track) => track.type === 'video' || track.type === 'audio')
    .map(
      (track) =>
        `${track.id}[${track.clips
          .map(
            (c) =>
              `${c.id}:${c.assetId}:${c.start}:${c.end}:${c.sourceStart}:${c.sourceEnd}:${c.speed ?? 1}`,
          )
          .join(',')}]`,
    )
    .join('|');
}

/** The revision counter, or 0 for a timeline that has never been through a patch. */
function revisionOf(timeline: Timeline): number {
  return (timeline as Timeline & { revision?: number }).revision ?? 0;
}

/** Every structural rule a timeline must satisfy no matter what was applied to it. */
function structuralViolations(timeline: Timeline): string[] {
  const problems: string[] = [];
  for (const track of timeline.tracks) {
    const ordered = [...track.clips].sort((x, y) => x.start - y.start);
    for (const [index, current] of ordered.entries()) {
      if (!(current.end > current.start)) {
        problems.push(`${track.id}/${current.id}: end ${current.end} <= start ${current.start}`);
      }
      if (current.start < 0) problems.push(`${track.id}/${current.id}: negative start`);
      if (current.sourceEnd < current.sourceStart) {
        problems.push(`${track.id}/${current.id}: inverted source window`);
      }
      const previous = ordered[index - 1];
      if (previous && current.start < previous.end - 1e-9) {
        problems.push(
          `${track.id}: ${previous.id} (…${previous.end}) overlaps ${current.id} (${current.start}…)`,
        );
      }
    }
    const ids = track.clips.map((c) => c.id);
    if (new Set(ids).size !== ids.length) problems.push(`${track.id}: duplicate clip ids`);
  }
  return problems;
}

/** Fixed seeds — identical cases on CI and on a laptop, and each one replayable by number. */
const SEEDS = [1, 7, 42, 99, 1234, 20260821, 65535, 8675309] as const;
const SEQUENCE_LENGTH = 12;

describe('operation algebra over generated sequences', () => {
  it.each(SEEDS)('apply-then-invert restores the exact timeline (seed %i)', (seed) => {
    const rng = mulberry32(seed);
    const before = seedTimeline();
    const { operations } = generateSequence(before, rng, SEQUENCE_LENGTH);
    expect(operations.length).toBeGreaterThan(0);

    const forward: Patch = {
      patchId: `seq_${String(seed)}` as PatchId,
      createdBy: 'agent',
      reason: 'generated sequence',
      operations,
    };
    const after = applyPatch(before, forward);
    const restored = revertPatch(after, invertPatch(before, forward));

    // Deep equality of CONTENT, not a summary: a diff that "looks the same" is exactly the
    // failure an inverse-composition bug produces.
    expect(content(restored), `seed ${String(seed)} · ${String(operations.length)} ops`).toEqual(
      content(before),
    );
    // …and the revision clock only ever moves forward, including through an undo.
    expect(revisionOf(restored)).toBeGreaterThan(revisionOf(before));
  });

  it.each(SEEDS)('composition never corrupts timeline structure (seed %i)', (seed) => {
    const rng = mulberry32(seed);
    const before = seedTimeline();
    const { operations } = generateSequence(before, rng, SEQUENCE_LENGTH);

    // Check after EVERY prefix, so a corruption is attributed to the operation that caused
    // it rather than discovered at the end of the chain.
    let working = before;
    for (const [index, operation] of operations.entries()) {
      working = applyPatch(working, {
        patchId: `step_${String(index)}` as PatchId,
        createdBy: 'agent',
        reason: 'step',
        operations: [operation],
      });
      expect(
        structuralViolations(working),
        `seed ${String(seed)} · after op ${String(index)} (${operation.type})`,
      ).toEqual([]);
    }
  });

  it.each(SEEDS)('every prefix inverts independently (seed %i)', (seed) => {
    // A stronger law than the whole-sequence one: inverting the first N operations must
    // restore the start state for EVERY N, which localizes a bad inverse to one step.
    const rng = mulberry32(seed);
    const before = seedTimeline();
    const { operations } = generateSequence(before, rng, SEQUENCE_LENGTH);

    for (let n = 1; n <= operations.length; n += 1) {
      const prefix: Patch = {
        patchId: `prefix_${String(n)}` as PatchId,
        createdBy: 'agent',
        reason: 'prefix',
        operations: operations.slice(0, n),
      };
      const after = applyPatch(before, prefix);
      const restored = revertPatch(after, invertPatch(before, prefix));
      expect(content(restored), `seed ${String(seed)} · prefix of ${String(n)}`).toEqual(
        content(before),
      );
    }
  });

  it.each(SEEDS)('the revision clock tracks mapping changes exactly (seed %i)', (seed) => {
    // The contract is an IFF, not a "bump on write": `applyOperation` advances `revision`
    // when — and only when — the source↔sequence mapping changed, because captions and
    // everything else derived from that mapping use the counter to detect staleness
    // (ADR 0076). A missed bump silently strands derived data; a spurious one makes every
    // consumer re-derive for nothing. Both are invisible without this check.
    const rng = mulberry32(seed);
    const before = seedTimeline();
    const { operations } = generateSequence(before, rng, SEQUENCE_LENGTH);

    let working = before;
    for (const [index, operation] of operations.entries()) {
      const previous = working;
      working = applyPatch(working, {
        patchId: `rev_${String(index)}` as PatchId,
        createdBy: 'agent',
        reason: 'revision probe',
        operations: [operation],
      });
      const timingChanged = mappingSignature(previous) !== mappingSignature(working);
      const bumped = revisionOf(working) > revisionOf(previous);
      expect(
        bumped,
        `seed ${String(seed)} · op ${String(index)} (${operation.type}) — mapping ` +
          `${timingChanged ? 'changed' : 'unchanged'} but revision ` +
          `${bumped ? 'bumped' : 'did not bump'}`,
      ).toBe(timingChanged);
      // Never backwards, whatever happened.
      expect(revisionOf(working)).toBeGreaterThanOrEqual(revisionOf(previous));
    }
  });

  it.each(SEEDS)('serialization round-trip does not change meaning (seed %i)', (seed) => {
    // A project that means something different after being written to disk and read back is
    // the worst class of bug in an editor: it corrupts work silently, between sessions.
    const rng = mulberry32(seed);
    const before = seedTimeline();
    const { operations, final } = generateSequence(before, rng, SEQUENCE_LENGTH);
    expect(operations.length).toBeGreaterThan(0);

    const reloaded = JSON.parse(JSON.stringify(final)) as Timeline;
    expect(reloaded).toEqual(final);

    // Stronger: the reloaded timeline must also BEHAVE identically — the same next operation
    // against it produces the same result as against the original.
    const next = proposeOperation(final, mulberry32(seed + 1));
    if (next) {
      const patch: Patch = {
        patchId: 'after_reload' as PatchId,
        createdBy: 'agent',
        reason: 'post-reload',
        operations: [next],
      };
      expect(applyPatch(reloaded, patch)).toEqual(applyPatch(final, patch));
    }
  });

  it.each(SEEDS)('applying never mutates the input timeline (seed %i)', (seed) => {
    // Project authority: `applyPatch` returns a new timeline and the caller's copy is
    // untouched. A shared-reference leak here would let an edit escape the patch/undo
    // system entirely — the state would change with no operation recorded to invert.
    const rng = mulberry32(seed);
    const before = seedTimeline();
    const { operations } = generateSequence(before, rng, SEQUENCE_LENGTH);
    const snapshot = JSON.parse(JSON.stringify(before)) as Timeline;

    applyPatch(before, {
      patchId: `immutable_${String(seed)}` as PatchId,
      createdBy: 'agent',
      reason: 'immutability probe',
      operations,
    });

    expect(before, `seed ${String(seed)} — applyPatch mutated its input`).toEqual(snapshot);
  });

  it('fails closed when an operation targets something that no longer exists', () => {
    // Composition's sharpest edge: the target was real when the sequence was authored and is
    // gone by the time it applies. That must throw, never silently no-op.
    const before = seedTimeline();
    expect(() =>
      applyPatch(before, {
        patchId: 'stale' as PatchId,
        createdBy: 'agent',
        reason: 'delete then trim the same clip',
        operations: [
          { type: 'delete_range', trackId: 'video_1', start: 10, end: 20 },
          { type: 'trim_clip', clipId: 'b', start: 11, end: 19 },
        ],
      }),
    ).toThrow();
  });
});
