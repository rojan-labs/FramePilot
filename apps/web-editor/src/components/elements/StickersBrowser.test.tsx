/**
 * The Stickers sub-tab (plan/elements EL6a.5, EL6b.2): stickers by collection, group and search, a
 * click that asks main to copy the sticker in by id and then places it, the error sentences of
 * 02 §8, one Tab stop, and replace mode opened from the Inspector; the whole library where the
 * installer ships it, in a virtualised grid, with favourites, recents and a drag onto a lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { stickerCatalog, type StickerCatalog, type StickerItem } from '@framepilot/ai-sdk';
import type { ElementAssetWire, ElementMaterializeResult } from '@framepilot/shared-types';
import { ELEMENT_DND_TYPE, decodeElementDrag } from './element-dnd.js';
import type { PackagedTileSource } from './packaged-tiles.js';
import { StickersBrowser } from './StickersBrowser.js';

const bridge = vi.hoisted(() => ({
  materialize: vi.fn<(request: { projectId: string; elementId: string }) => Promise<unknown>>(),
}));

vi.mock('../../editor/bridge.js', () => ({
  elementsMaterialize: (request: { projectId: string; elementId: string }) =>
    bridge.materialize(request),
  elementsThumbnail: async () => ({ ok: true, packaged: false, thumbs: [] }),
}));

// jsdom lays nothing out and has no `Element.scrollTo`. A browser scrolls and then says so, and
// the sticker scroll area is as tall as the grid it holds, seen through a 480 px view.
const VIEW_PX = 480;
const inScrollArea = (element: HTMLElement): boolean =>
  element.classList.contains('stickers-scroll');
beforeEach(() => {
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement, options?: unknown) {
    const top = (options as ScrollToOptions | undefined)?.top ?? 0;
    this.scrollTop = top;
    this.dispatchEvent(new Event('scroll'));
  } as HTMLElement['scrollTo'];
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const grid = this.firstElementChild as HTMLElement | null;
      return inScrollArea(this) ? Number.parseFloat(grid?.style.height ?? '0') : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return inScrollArea(this) ? VIEW_PX : 0;
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

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
    { ...item('red_heart', 'Red heart', '❤️', ['hearts'], 2), group: 'Symbols' },
    (({ rank: _rank, ...rest }) => ({ ...rest, availability: 'packaged' as const }))(
      item('cat', 'Cat', '🐈', [], 0),
    ),
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

/** A main process that ships the packaged set (or not), its tiles `blob:<id>` once loaded. */
function tileSource(packaged: boolean): PackagedTileSource & { load: ReturnType<typeof vi.fn> } {
  const loaded = new Map<string, string>();
  return {
    present: async () => packaged,
    url: (elementId) => loaded.get(elementId),
    load: vi.fn(async (elementIds: readonly string[]) => {
      for (const elementId of elementIds) loaded.set(elementId, `blob:${elementId}`);
    }),
  };
}

type Props = Parameters<typeof StickersBrowser>[0];

async function open(props: Partial<Props> = {}) {
  const onAddSticker = vi.fn<Props['onAddSticker']>(() => null);
  const view = render(
    <StickersBrowser
      project={{ id: 'p', assets: [] }}
      onAddSticker={onAddSticker}
      loadCatalog={async () => CATALOG}
      packagedTiles={tileSource(false)}
      {...props}
    />,
  );
  await screen.findByRole('list', { name: 'Stickers' });
  return { onAddSticker, view };
}

/** The sticker tiles on screen (not their favourite stars). */
const tiles = (): HTMLButtonElement[] =>
  within(screen.getByRole('list', { name: 'Stickers' }))
    .getAllByRole('button')
    .filter((button) => button.classList.contains('stickers-grid-tile')) as HTMLButtonElement[];

const names = (): (string | null)[] => tiles().map((tile) => tile.getAttribute('aria-label'));

/** What a tile's `aria-describedby` reads, in order. */
const description = (element: Element): string =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

beforeEach(() => {
  localStorage.clear();
  bridge.materialize.mockReset();
});
afterEach(() => localStorage.clear());

describe('StickersBrowser', () => {
  it('shows the curated stickers in collection order and none this build does not ship', async () => {
    await open();
    expect(names()).toEqual(['Grinning face, sticker', 'Fire, sticker', 'Red heart, sticker']);
    expect(screen.getByText('Stickers: Fluent Emoji by Microsoft (MIT)')).toBeDefined();
  });

  it('narrows to a collection and finds a sticker by its glyph', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Hearts' }));
    expect(names()).toEqual(['Red heart, sticker']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search stickers' }), {
      target: { value: '🔥' },
    });
    expect(names()).toEqual(['Fire, sticker']);
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
      fireEvent.click(screen.getByRole('button', { name: 'Fire, sticker' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Fire, sticker' }));
    });
    const alert = screen.getByRole('alert');
    await waitFor(() =>
      expect(alert.textContent).toBe("Couldn't add this sticker: there isn't enough disk space."),
    );
    expect(onAddSticker).not.toHaveBeenCalled();
    // Above the grid, where the eye is, not under a thousand stickers.
    const scroll = document.querySelector('.stickers-scroll') as HTMLElement;
    expect(alert.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And gone with the next thing the person does.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search stickers' }), {
      target: { value: 'hea' },
    });
    expect(alert.textContent).toBe('');
  });

  it('says the copy failed, rather than throwing, when main does not answer', async () => {
    bridge.materialize.mockRejectedValue(new Error('the licence lapsed'));
    const { onAddSticker } = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fire, sticker' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        "Couldn't copy this sticker into the project. Check the project folder can be written to, then try again.",
      ),
    );
    expect(onAddSticker).not.toHaveBeenCalled();
    // And the grid is usable again.
    expect(screen.getByRole('button', { name: 'Fire, sticker' }).hasAttribute('disabled')).toBe(
      false,
    );
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

  it('takes focus to the search when replace mode opens, and says what it is replacing', async () => {
    await open({
      replaceTarget: { clipId: 'clip_1', name: 'Fire' },
      onReplaceSticker: vi.fn(() => null),
      onCancelReplace: vi.fn(),
    });
    const search = screen.getByRole('searchbox', { name: 'Search stickers' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    const banner = document.getElementById(search.getAttribute('aria-describedby') ?? '');
    expect(banner?.textContent).toContain('Pick a sticker to replace “Fire”.');
  });

  it('cancels replace mode with Escape, from the grid or an empty search', async () => {
    const onCancelReplace = vi.fn();
    await open({
      replaceTarget: { clipId: 'clip_1', name: 'Fire' },
      onReplaceSticker: vi.fn(() => null),
      onCancelReplace,
    });
    const search = screen.getByRole('searchbox', { name: 'Search stickers' });
    // With words in the box, Escape clears them first, as it always has.
    fireEvent.change(search, { target: { value: 'hea' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onCancelReplace).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onCancelReplace).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tiles()[0]!, { key: 'Escape' });
    expect(onCancelReplace).toHaveBeenCalledTimes(2);
  });

  it('leaves Escape alone when it is not replacing', async () => {
    const onCancelReplace = vi.fn();
    await open({ onCancelReplace });
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    fireEvent.keyDown(tiles()[0]!, { key: 'Escape' });
    window.removeEventListener('keydown', onWindowKey);
    expect(onCancelReplace).not.toHaveBeenCalled();
    expect(onWindowKey).toHaveBeenCalledTimes(1);
  });

  it('says what Enter and F do on a tile', async () => {
    await open();
    const fire = screen.getByRole('button', { name: 'Fire, sticker' });
    expect(fire.getAttribute('aria-keyshortcuts')).toBe('Enter F');
    expect(description(fire)).toBe('Enter adds it at the playhead. F adds it to favourites.');
    fireEvent.click(screen.getByRole('button', { name: 'Favourite Fire' }));
    expect(description(screen.getByRole('button', { name: 'Fire, sticker' }))).toBe(
      'Enter adds it at the playhead. In your favourites; F removes it.',
    );
  });

  it('says a favourite was added or removed', async () => {
    await open();
    const live = (): string =>
      document.querySelector('[data-live="favourites"]')?.textContent ?? '';
    const fire = screen.getByRole('button', { name: 'Fire, sticker' });
    act(() => fire.focus());
    fireEvent.keyDown(fire, { key: 'f' });
    await waitFor(() => expect(live()).toBe('Added Fire to favourites'));
    fireEvent.click(screen.getByRole('button', { name: 'Favourite Fire' }));
    await waitFor(() => expect(live()).toBe('Removed Fire from favourites'));
  });

  it('keeps the keyboard in the grid when a favourite leaves the Favourites list', async () => {
    await open();
    for (const name of ['Favourite Fire', 'Favourite Red heart']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Favourites' }));
    expect(names()).toEqual(['Red heart, sticker', 'Fire, sticker']);
    const first = tiles()[0]!;
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'f' });
    // Red heart left the list; the keyboard is on what took its place, not on the page.
    await waitFor(() => expect(names()).toEqual(['Fire, sticker']));
    await waitFor(() => expect(document.activeElement).toBe(tiles()[0]));
  });

  it('says it is loading as a status', async () => {
    render(
      <StickersBrowser
        project={{ id: 'p', assets: [] }}
        onAddSticker={() => null}
        loadCatalog={() => new Promise(() => undefined)}
        packagedTiles={tileSource(false)}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading stickers…');
  });

  it('uses the app’s one input style for its search', async () => {
    await open();
    const search = screen.getByRole('searchbox', { name: 'Search stickers' });
    expect(search.getAttribute('data-ui')).toBe('input');
    expect(search.classList.contains('elements-search')).toBe(true);
  });

  it('starts from the search and scroll it is handed, and reports both as they change', async () => {
    const onQueryChange = vi.fn();
    const onScrollTopChange = vi.fn();
    await open({
      initialQuery: 'fire',
      onQueryChange,
      initialScrollTop: 80,
      onScrollTopChange,
    });
    const search = screen.getByRole('searchbox', { name: 'Search stickers' }) as HTMLInputElement;
    expect(search.value).toBe('fire');
    expect(names()).toEqual(['Fire, sticker']);
    fireEvent.change(search, { target: { value: '' } });
    expect(onQueryChange).toHaveBeenLastCalledWith('');
    const scroll = document.querySelector('.stickers-scroll') as HTMLElement;
    await waitFor(() => expect(scroll.scrollTop).toBe(80));
    scroll.scrollTop = 30;
    fireEvent.scroll(scroll);
    expect(onScrollTopChange).toHaveBeenLastCalledWith(30);
  });

  it('narrows to one of the upstream groups', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Symbols' }));
    expect(names()).toEqual(['Red heart, sticker']);
  });

  it('lists the whole library where the installer ships it, its tiles fetched from main', async () => {
    const packagedTiles = tileSource(true);
    await open({ packagedTiles });
    await waitFor(() => expect(names()).toContain('Cat, sticker'));
    expect(names()).toEqual([
      'Grinning face, sticker',
      'Fire, sticker',
      'Red heart, sticker',
      'Cat, sticker',
    ]);
    // Curated tiles are the renderer's own files; a packaged one is asked of main, then shown.
    expect(packagedTiles.load).toHaveBeenCalledWith(['cat']);
    const cat = screen.getByRole('button', { name: 'Cat, sticker' });
    await waitFor(() => expect(cat.querySelector('img')?.getAttribute('src')).toBe('blob:cat'));
    expect(
      screen
        .getByRole('button', { name: 'Fire, sticker' })
        .querySelector('img')
        ?.getAttribute('src'),
    ).toBe('elements/stickers/thumbs/fire.webp');
  });

  it('keeps favourites: a star or F marks one, and the Favourites chip lists them', async () => {
    const { view } = await open();
    expect(screen.queryByRole('button', { name: 'Favourites' })).toBeNull();
    const star = screen.getByRole('button', { name: 'Favourite Fire' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(star);
    expect(star.getAttribute('aria-pressed')).toBe('true');
    const heart = screen.getByRole('button', { name: 'Red heart, sticker' });
    act(() => heart.focus());
    fireEvent.keyDown(heart, { key: 'f' });
    fireEvent.click(screen.getByRole('button', { name: 'Favourites' }));
    expect(names()).toEqual(['Red heart, sticker', 'Fire, sticker']);

    // A view preference: it outlives the panel.
    view.unmount();
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Favourites' }));
    expect(names()).toEqual(['Red heart, sticker', 'Fire, sticker']);
  });

  it('lists what was added lately under Recent, newest first', async () => {
    bridge.materialize.mockImplementation(async ({ elementId }) => ({
      ok: true,
      asset: asset(elementId),
    }));
    const { onAddSticker } = await open();
    expect(screen.queryByRole('button', { name: 'Recent' })).toBeNull();
    for (const name of ['Fire, sticker', 'Red heart, sticker']) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name }));
      });
    }
    await waitFor(() => expect(onAddSticker).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Recent' }));
    expect(names()).toEqual(['Red heart, sticker', 'Fire, sticker']);
  });

  it('marks a sticker the project already holds, and still adds another', async () => {
    await open({ project: { id: 'p', assets: [{ id: 'element_fluent3d_fire' }] } });
    const fire = screen.getByRole('button', { name: 'Fire, sticker' });
    expect(description(fire)).toContain('Already in this project');
    expect(fire.hasAttribute('disabled')).toBe(false);
    expect(fire.getAttribute('title')).toContain('already in this project');
    expect(fire.querySelector('.stickers-grid-held')?.getAttribute('title')).toBe(
      'Already in this project',
    );
    expect(description(screen.getByRole('button', { name: 'Red heart, sticker' }))).not.toContain(
      'Already in this project',
    );
  });

  it('puts the sticker’s id, and nothing else, on a drag to the timeline', async () => {
    await open();
    const data = new Map<string, string>();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Fire, sticker' }), {
      dataTransfer: {
        setData: (type: string, value: string) => data.set(type, value),
        effectAllowed: 'none',
      },
    });
    expect(decodeElementDrag(data.get(ELEMENT_DND_TYPE) ?? '')).toEqual({
      kind: 'sticker',
      elementId: 'fire',
    });
  });

  it('records a sticker dragged onto the timeline or the monitor as Recent, as a click is', async () => {
    const { onAddSticker, view } = await open();
    const drag = (name: string, dropEffect: DataTransfer['dropEffect']): void => {
      const tile = screen.getByRole('button', { name });
      fireEvent.dragStart(tile, { dataTransfer: { setData: () => undefined } });
      fireEvent.dragEnd(tile, { dataTransfer: { dropEffect } });
    };
    // A drag let go anywhere that did not take it ends with no drop effect: nothing was added.
    drag('Red heart, sticker', 'none');
    expect(screen.queryByRole('button', { name: 'Recent' })).toBeNull();
    // A lane (or the monitor) that took it ends the drag in a copy. The drop itself places the
    // sticker, not this panel, so the panel records it without placing anything.
    drag('Fire, sticker', 'copy');
    fireEvent.click(await screen.findByRole('button', { name: 'Recent' }));
    expect(names()).toEqual(['Fire, sticker']);
    expect(onAddSticker).not.toHaveBeenCalled();
    expect(bridge.materialize).not.toHaveBeenCalled();
    // A view preference, like a click's: it outlives the panel.
    view.unmount();
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    expect(names()).toEqual(['Fire, sticker']);
  });

  it('draws only the rows in view of the whole library, and End still reaches the last', async () => {
    const many = stickerCatalog({
      ...CATALOG,
      items: Array.from({ length: 1595 }, (_, index) =>
        item(`s${String(index)}`, `S${String(index)}`, '⭐', [], index),
      ),
    });
    await open({ loadCatalog: async () => many });
    const shown = tiles();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(200);
    expect(shown[0]!.closest('li')?.getAttribute('aria-setsize')).toBe('1595');
    act(() => shown[0]!.focus());
    fireEvent.keyDown(screen.getByRole('list', { name: 'Stickers' }), { key: 'End' });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('S1594, sticker'),
    );
    expect(document.activeElement?.closest('li')?.getAttribute('aria-posinset')).toBe('1595');
  });
});
