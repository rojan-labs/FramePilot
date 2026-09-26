/**
 * The renderer's side of sticker materialisation (plan/elements EL6a.3): ids go to main, and a
 * build with no desktop bridge hears why rather than failing silently.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RendererBridge } from './bridge-base.js';
import { elementsMaterialize } from './bridge-base.js';

describe('elementsMaterialize', () => {
  it('asks main by id and returns its answer', async () => {
    const answer = { ok: false as const, error: 'unknown_element' as const };
    const call = vi.fn(async () => answer);
    const bridge = { elementsMaterialize: call } as unknown as RendererBridge;
    await expect(elementsMaterialize({ projectId: 'p', elementId: 'fire' }, bridge)).resolves.toBe(
      answer,
    );
    expect(call).toHaveBeenCalledWith({ projectId: 'p', elementId: 'fire' });
  });

  it('says stickers need the desktop app when there is no bridge', async () => {
    await expect(elementsMaterialize({ projectId: 'p', elementId: 'fire' }, null)).resolves.toEqual(
      {
        ok: false,
        error: 'library_missing',
        detail: 'Stickers are only available in the desktop app.',
      },
    );
  });
});
