/**
 * The Elements drag payload (plan/elements EL5.2, EL6b): what a tile puts on a drag is what a drop
 * reads.
 */
import { describe, expect, it } from 'vitest';
import {
  ELEMENT_DND_TYPE,
  decodeElementDrag,
  dragCarriesElementKind,
  encodeElementDrag,
  writeElementDrag,
  type ElementDragPayload,
} from './element-dnd.js';

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

  it('round-trips a photo or video drag, which carries a provider id and a kind only', () => {
    const photo = { kind: 'stock', mediaKind: 'photo', remoteId: '2014422' } as const;
    const video = { kind: 'stock', mediaKind: 'video', remoteId: '3129671' } as const;
    expect(decodeElementDrag(encodeElementDrag(photo))).toEqual(photo);
    expect(decodeElementDrag(encodeElementDrag(video))).toEqual(video);
  });

  it('refuses a photo or video drag with anything path- or URL-shaped in it', () => {
    // The id only indexes what main itself fetched this session; a drop from another window can
    // still put anything on the drag, so everything is checked.
    for (const remoteId of ['../x', 'a/b', 'https://x.test/1', 'a b', '', 'x'.repeat(65), 42]) {
      expect(
        decodeElementDrag(JSON.stringify({ kind: 'stock', mediaKind: 'photo', remoteId })),
      ).toBeNull();
    }
    for (const mediaKind of ['audio', 'image', undefined]) {
      expect(
        decodeElementDrag(JSON.stringify({ kind: 'stock', mediaKind, remoteId: '1' })),
      ).toBeNull();
    }
    // Extra fields are dropped, never passed through.
    expect(
      decodeElementDrag(
        JSON.stringify({ kind: 'stock', mediaKind: 'video', remoteId: '1', path: '/etc/passwd' }),
      ),
    ).toEqual({ kind: 'stock', mediaKind: 'video', remoteId: '1' });
  });

  it('names the tile’s kind in the drag’s types, so a target can decide before the drop', () => {
    // During dragover a target sees the types alone; the payload is readable only on drop.
    const typesOf = (payload: ElementDragPayload): string[] => {
      const data = new Map<string, string>();
      writeElementDrag({ setData: (type, value) => data.set(type, value) }, payload);
      expect(decodeElementDrag(data.get(ELEMENT_DND_TYPE)!)).toEqual(payload);
      return [...data.keys()];
    };
    const sticker = typesOf({ kind: 'sticker', elementId: 'fire' });
    const shape = typesOf({ kind: 'shape', presetId: 'rounded-rect/highlight', colour: null });
    const photo = typesOf({ kind: 'stock', mediaKind: 'photo', remoteId: '1' });
    // The program monitor takes stickers and shapes; photos and videos are not offered there yet.
    const onMonitor = ['sticker', 'shape'] as const;
    expect(dragCarriesElementKind(sticker, onMonitor)).toBe(true);
    expect(dragCarriesElementKind(shape, onMonitor)).toBe(true);
    expect(dragCarriesElementKind(photo, onMonitor)).toBe(false);
    // A bin asset or a file from the desktop carries no element at all.
    expect(dragCarriesElementKind(['application/x-framepilot-asset', 'Files'], onMonitor)).toBe(
      false,
    );
    // The kind rides in the type name, which a browser lower-cases; nothing else rides with it.
    for (const type of [...sticker, ...shape, ...photo]) expect(type).toBe(type.toLowerCase());
  });
});
