/**
 * The Stickers sub-tab (plan/elements EL6a.5): curated stickers by collection and search, a click
 * that asks main to copy the sticker in by id and then places it, the error sentences of 02 §8,
 * one Tab stop, and replace mode opened from the Inspector.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { stickerCatalog, type StickerCatalog, type StickerItem } from '@framepilot/ai-sdk';
import type { ElementAssetWire, ElementMaterializeResult } from '@framepilot/shared-types';
import { StickersBrowser } from './StickersBrowser.js';

const bridge = vi.hoisted(() => ({
  materialize: vi.fn<(request: { projectId: string; elementId: string }) => Promise<unknown>>(),
}));

vi.mock('../../editor/bridge.js', () => ({
  elementsMaterialize: (request: { projectId: string; elementId: string }) =>
    bridge.materialize(request),
}));

const item = (
  id: string,
  name: string,
  glyph: string,
  collections: string[],
  rank: number,
): StickerItem => ({
  id,
  name,
  glyph,
  unicode: null,
  group: 'Smileys & Emotion',
  collections,
  rank,
  keywords: [name.toLowerCase()],
  availability: 'bundled',
  source: `assets/${name}/3D/${id}_3d.png`,
  file: `full/${id}.webp`,
  thumb: `thumbs/${id}.webp`,
  sha256: 'x',
  bytes: 1,
  width: 318,
  height: 318,
  sharpSize: 256,
});

const CATALOG: StickerCatalog = stickerCatalog({
  spec: 'test',
  library: 'fluent3d',
  provider: 'fluent-emoji',
  commit: 'abc',
  license: 'mit',
  licenseUrl: 'https://example.test/LICENSE',
  attribution: 'Fluent Emoji by Microsoft (MIT)',
  creator: 'Microsoft',
  attributionRequired: false,
  sourceBase: 'https://example.test/',
  collections: [
    { id: 'reactions', name: 'Reactions' },
    { id: 'hearts', name: 'Hearts' },
  ],
  items: [
    item('fire', 'Fire', '🔥', ['reactions'], 1),
    item('grinning_face', 'Grinning face', '😀', ['reactions'], 0),
    item('red_heart', 'Red heart', '❤️', ['hearts'], 2),
    { ...item('cat', 'Cat', '🐈', [], 0), availability: 'packaged', rank: undefined },
  ],
});

const asset = (id: string): ElementAssetWire => ({
  id: `element_fluent3d_${id}`,
  path: `media/p/elements/fluent3d/${id}.webp`,
  kind: 'image',
  media: { width: 318, height: 318 },
  sharpSize: 256,
  source: {
    provider: 'fluent-emoji',
    remoteId: id,
    license: 'mit',
    licenseUrl: 'https://example.test/LICENSE',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    sourceUrl: 'https://example.test/x.png',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
  deduped: false,
});

async function open(props: Partial<Parameters<typeof StickersBrowser>[0]> = {}) {
  const onAddSticker = vi.fn(() => null);
  render(
    <StickersBrowser
      project={{ id: 'p' }}
      onAddSticker={onAddSticker}
      loadCatalog={async () => CATALOG}
      {...props}
    />,
  );
  await screen.findByRole('list', { name: 'Stickers' });
  return { onAddSticker };
}

const tiles = (): HTMLButtonElement[] =>
  within(screen.getByRole('list', { name: 'Stickers' })).getAllByRole(
    'button',
  ) as HTMLButtonElement[];

beforeEach(() => {
  localStorage.clear();
  bridge.materialize.mockReset();
});
afterEach(() => localStorage.clear());

describe('StickersBrowser', () => {
  it('shows the curated stickers in collection order and none this build does not ship', async () => {
    await open();
    expect(tiles().map((t) => t.getAttribute('aria-label'))).toEqual([
      'Add Grinning face',
      'Add Fire',
      'Add Red heart',
    ]);
    expect(screen.getByText('Stickers: Fluent Emoji by Microsoft (MIT)')).toBeDefined();
  });

  it('narrows to a collection and finds a sticker by its glyph', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Hearts' }));
    expect(tiles().map((t) => t.getAttribute('aria-label'))).toEqual(['Add Red heart']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search stickers' }), {
      target: { value: '🔥' },
    });
    expect(tiles().map((t) => t.getAttribute('aria-label'))).toEqual(['Add Fire']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search stickers' }), {
      target: { value: 'zzz' },
    });
    expect(
      screen.getByText('Nothing matched “zzz”. Try a simpler word — “fire”, “party”, “check”.'),
    ).toBeDefined();
  });

  it('asks main to copy the sticker in by id, then places the asset it returns', async () => {
    bridge.materialize.mockResolvedValue({ ok: true, asset: asset('fire') });
    const { onAddSticker } = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Fire' }));
    });
    expect(bridge.materialize).toHaveBeenCalledWith({ projectId: 'p', elementId: 'fire' });
    await waitFor(() => expect(onAddSticker).toHaveBeenCalledTimes(1));
    expect(onAddSticker.mock.calls[0]).toMatchObject([
      { id: 'element_fluent3d_fire' },
      { id: 'fire' },
    ]);
  });

  it('says why a sticker could not be added, in the panel’s words', async () => {
    bridge.materialize.mockResolvedValue({
      ok: false,
      error: 'disk_full',
    } satisfies ElementMaterializeResult);
    const { onAddSticker } = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Fire' }));
    });
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      "Couldn't add this sticker: there isn't enough disk space.",
    );
    expect(onAddSticker).not.toHaveBeenCalled();
  });

  it('is one Tab stop; arrows and End move through the tiles', async () => {
    await open();
    expect(tiles().filter((t) => t.tabIndex === 0)).toHaveLength(1);
    const grid = screen.getByRole('list', { name: 'Stickers' });
    act(() => tiles()[0]!.focus());
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tiles()[1]);
    fireEvent.keyDown(grid, { key: 'End' });
    expect(document.activeElement).toBe(tiles().at(-1));
  });

  it('in replace mode, swaps the target instead of adding, and can be cancelled', async () => {
    bridge.materialize.mockResolvedValue({ ok: true, asset: asset('red_heart') });
    const onReplaceSticker = vi.fn(() => null);
    const onCancelReplace = vi.fn();
    const { onAddSticker } = await open({
      replaceTarget: { clipId: 'clip_1', name: 'Fire' },
      onReplaceSticker,
      onCancelReplace,
    });
    expect(screen.getByText('Pick a sticker to replace “Fire”.')).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use Red heart' }));
    });
    await waitFor(() => expect(onReplaceSticker).toHaveBeenCalledTimes(1));
    expect(onAddSticker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelReplace).toHaveBeenCalled();
  });
});
