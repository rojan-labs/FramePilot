import { describe, expect, it } from 'vitest';
import { EffectSnapshotSchema } from './run-contracts.js';
import { boundedKeySegment, stableDigest } from './stable-key.js';

describe('boundedKeySegment', () => {
  it('leaves a short value exactly as it was', () => {
    expect(boundedKeySegment('host_tool:get_timeline:{}', 96)).toBe('host_tool:get_timeline:{}');
  });

  it('keeps a readable head and stays bounded however long the input is', () => {
    const long = 'x'.repeat(50_000);
    const bounded = boundedKeySegment(long, 96);
    expect(bounded.startsWith('x'.repeat(96))).toBe(true);
    expect(bounded.length).toBeLessThanOrEqual(96 + 13);
  });

  it('distinguishes values that differ only past the cut-off', () => {
    const head = 'a'.repeat(200);
    expect(boundedKeySegment(`${head}left`, 96)).not.toBe(boundedKeySegment(`${head}right`, 96));
  });

  it('is stable across calls, so a key means the same thing on every turn', () => {
    expect(stableDigest('the same input')).toBe(stableDigest('the same input'));
    expect(stableDigest('order matters')).not.toBe(stableDigest('matters order'));
  });

  it('produces a key the run contract keeps verbatim, where a raw value gets bounded', () => {
    const raw = `host_tool:trim_clip:${JSON.stringify(Array.from({ length: 200 }, (_, i) => i))}`;
    const snapshot = {
      effectId: 'effect_1',
      taskId: 'task_1',
      kind: 'host_tool',
      state: 'settled',
      attempt: 0,
    };
    // The contract no longer REJECTS an over-long key: rejecting it stranded runs
    // persisted before producers were bounded, because a snapshot that cannot parse
    // cannot be closed either. It bounds instead, and the result fits the cap.
    const fromRaw = EffectSnapshotSchema.parse({ ...snapshot, idempotencyKey: raw });
    expect(fromRaw.idempotencyKey.length).toBeLessThanOrEqual(256);

    // A producer-bounded key is already within the cap, so it survives untouched —
    // parsing must not keep re-truncating a key each time a snapshot round-trips.
    const bounded = boundedKeySegment(raw, 240);
    expect(
      EffectSnapshotSchema.parse({ ...snapshot, idempotencyKey: bounded }).idempotencyKey,
    ).toBe(bounded);
  });
});
