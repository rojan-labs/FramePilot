/**
 * The Elements drag payload (plan/elements EL5.2, EL6b): what a tile puts on a drag is what a drop
 * reads.
 */
import { describe, expect, it } from 'vitest';
import { decodeElementDrag, encodeElementDrag } from './element-dnd.js';

describe('element drag payload', () => {
  it('round-trips a shape drag', () => {
    const payload = { kind: 'shape', presetId: 'star-5/white', colour: '#FFD400' } as const;
    expect(decodeElementDrag(encodeElementDrag(payload))).toEqual(payload);
  });

  it('reads a malformed colour as "the preset’s own" and refuses anything else', () => {
    expect(
      decodeElementDrag(JSON.stringify({ kind: 'shape', presetId: 'x/y', colour: 'red' })),
    ).toEqual({ kind: 'shape', presetId: 'x/y', colour: null });
    expect(decodeElementDrag(JSON.stringify({ kind: 'sticker', presetId: 'x' }))).toBeNull();
    expect(decodeElementDrag('not json')).toBeNull();
  });

  it('round-trips a sticker drag, which names a catalogue id and nothing path-shaped', () => {
    const payload = { kind: 'sticker', elementId: 'fire' } as const;
    expect(decodeElementDrag(encodeElementDrag(payload))).toEqual(payload);
    for (const elementId of ['../fire', 'Fire', '', 'a/b', 42]) {
      expect(decodeElementDrag(JSON.stringify({ kind: 'sticker', elementId }))).toBeNull();
    }
  });
});
