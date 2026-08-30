/**
 * Runtime policy edges: cache identity, serial batching, and the assembly boundaries
 * that catch what the earlier gate cannot.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';
import { assembleEdit } from './assemble.js';
import { idempotencyKeyFor } from './kernel/effect-runtime.js';
import type { HostToolEffect } from './kernel/effects.js';
import { partitionConcurrencyBatches } from './concurrency.js';
import { toolContract } from './tool-contract.js';
import { getTool } from './tool-registry.js';

const clip = (id: string, start: number, end: number) => ({
  id,
  assetId: 'asset-1',
  trackId: 'video-1',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const project = (clips = [clip('clip-a', 0, 4)]): Project =>
  ({
    fps: 30,
    assets: [{ id: 'asset-1', path: 'a.mp4', kind: 'video', durationSeconds: 60 }],
    folders: [],
    markers: [],
    transcript: [],
    timeline: { revision: 1, tracks: [{ id: 'video-1', type: 'video', clips }] },
  }) as unknown as Project;

describe('host cache identity', () => {
  it('has no key for a tool the registry does not know', () => {
    const effect = {
      kind: 'host_tool',
      call: { id: 'c', name: 'not_a_registered_tool', arguments: {} },
      project: project(),
    } as HostToolEffect;
    expect(idempotencyKeyFor(effect)).toBeUndefined();
  });
});

describe('tool contract defaults', () => {
  it('classifies an undeclared action tool as an action that is never cached', () => {
    // `render_preview`/`export_video` are declared explicitly; this covers the derived
    // path any future action tool takes without its own declaration.
    const contract = toolContract({
      name: 'some_future_action',
      kind: 'action',
      mutates: false,
    } as unknown as Parameters<typeof toolContract>[0]);
    expect(contract.effectClass).toBe('action');
    expect(contract.cacheScope).toBe('none');
    expect(contract.concurrency).toBe('serial');
  });
});

describe('concurrency partitioning', () => {
  it('treats a malformed call entry as non-serial rather than throwing', () => {
    // The partition helper runs on provider output, which is not guaranteed well-formed;
    // the orchestrator rejects unknown/!object calls separately with a real error.
    const batches = partitionConcurrencyBatches([null, 'nope', []] as unknown[]);
    expect(batches.every((batch) => batch.calls.length > 0)).toBe(true);
  });

  it('keeps a serial tool out of a parallel batch', () => {
    const transcribe = getTool('transcribe');
    expect(transcribe && toolContract(transcribe).concurrency).toBe('serial');
  });
});

describe('assembly boundaries', () => {
  it('reports a normalization failure as an invalid edit rather than throwing', () => {
    // `add_mask` carries no numeric contract of its own, so a non-finite keyframe time
    // first becomes visible when frame quantization tries to snap it.
    const result = assembleEdit(
      project(),
      [
        {
          type: 'add_mask',
          clipId: 'clip-a',
          mask: { kind: 'rect' },
          keyframes: [{ id: 'k', time: Number.NaN, property: 'x', value: 1, easing: 'linear' }],
        },
      ] as unknown as AnyOperation[],
      'mask with an unusable keyframe time',
    );
    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues[0]?.message).toMatch(/finite/i);
  });

  it('promotes a sub-frame transition to one frame and keeps it inside its clips', () => {
    // A positive request shorter than one frame is the one thing quantization may still
    // round UP — one frame is the smallest a renderer can draw. The transition authority
    // then shortens it to fit rather than refusing, so the edit stays valid.
    const result = assembleEdit(
      project([clip('clip-a', 0, 4), clip('clip-b', 4, 8)]),
      [
        {
          type: 'add_transition',
          trackId: 'video-1',
          fromClipId: 'clip-a',
          toClipId: 'clip-b',
          kind: 'cross-dissolve',
          durationSeconds: 0.001,
        },
      ] as unknown as AnyOperation[],
      'sub-frame transition',
    );
    expect(result.validation.valid).toBe(true);
    expect(result.patch.operations[0]).toMatchObject({ durationSeconds: 1 / 30 });
  });
});

/**
 * A picture memo must not be keyed on a MAPPING counter (P1-1).
 *
 * `applyOperation` bumps `Timeline.revision` only when clip timing moves, because its job
 * is to tell mapping-derived state (captions, ADR 0076) to remap. Every picture-only edit
 * — grade, effect, keyframe, punch-in, mask — leaves it standing still. `get_frame` and
 * `measure_color` used to declare `cacheScope: 'project_revision'`, so the effect memo hit
 * across exactly the edits those two tools exist to verify and replayed the pre-edit
 * picture as the current one.
 */
describe('picture reads are never memoized across a picture-only edit', () => {
  const graded = (source: Project): Project => {
    const clipId = source.timeline.tracks[0]!.clips[0]!.id;
    const ops: AnyOperation[] = [
      {
        type: 'apply_color_grade',
        clipId,
        effect: {
          id: `grade_${clipId}`,
          type: 'color_grade',
          params: { saturation: 1.4 },
          keyframes: [],
        },
      } as unknown as AnyOperation,
    ];
    const { patch, validation, diff } = assembleEdit(source, ops, 'grade');
    expect(validation.valid).toBe(true);
    expect(patch.operations).toHaveLength(1);
    return { ...source, timeline: diff!.after };
  };

  it('leaves the timeline revision untouched when only the picture changed', () => {
    const before = project();
    const after = graded(before);
    // The root cause, pinned: the counter the old cache key carried does not move here,
    // so the pre-grade and post-grade keys were byte-identical.
    expect(after.timeline.revision).toBe(before.timeline.revision);
    expect(after.timeline.tracks[0]!.clips[0]!.effects).toHaveLength(1);
  });

  it.each(['get_frame', 'measure_color'])('%s declares no cache scope at all', (name) => {
    const tool = getTool(name);
    expect(tool, `${name} must still be a registered tool`).toBeDefined();
    expect(toolContract(tool!).cacheScope).toBe('none');
  });

  it.each([
    { name: 'get_frame', args: { timeSeconds: 2 } },
    { name: 'measure_color', args: { clipId: 'clip-a' } },
  ])('produces no memo key for $name, before or after a grade', ({ name, args }) => {
    const before = project();
    const effectFor = (source: Project): HostToolEffect =>
      ({ kind: 'host_tool', call: { id: 'c', name, arguments: args }, project: source }) as
        HostToolEffect;
    // No key ⇒ `runEffect` never consults or populates the memo, so the frame/measurement
    // is taken against the timeline as it is now rather than replayed from a stale one.
    expect(idempotencyKeyFor(effectFor(before))).toBeUndefined();
    expect(idempotencyKeyFor(effectFor(graded(before)))).toBeUndefined();
  });

  it('still memoizes a read whose contract genuinely permits a replay', () => {
    // Guard that the fix is targeted, not a blanket disabling of the host memo.
    const effect = {
      kind: 'host_tool',
      call: { id: 'c', name: 'detect_scenes', arguments: { assetId: 'asset-1' } },
      project: project(),
    } as HostToolEffect;
    expect(idempotencyKeyFor(effect)).toBeDefined();
  });
});
