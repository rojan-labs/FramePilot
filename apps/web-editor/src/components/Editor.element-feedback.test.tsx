/**
 * Every way an element lands says so (plan/elements 02 §3): a click, a key or a drop selects the
 * new clip and the editor's polite live region reads "Added … at 0:12" — the same message twice
 * included — through the real Editor on the desktop path. A sticker is placed against the editor
 * as it is when main's copy lands, not as it was at the click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  ElementAssetWire,
  ElementMaterializeResult,
  StockItemWire,
} from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { demoProject } from '../editor/demo.js';
import { resetDownloadRegistriesForTests } from '../editor/download-registry.js';
import { Editor } from './Editor.js';

const stickerAsset = (id: string): ElementAssetWire => ({
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

/** A portrait Pexels clip, the demo project's own shape, so the feed keeps it. */
const clip: StockItemWire = {
  remoteId: '777',
  provider: 'pexels',
  kind: 'video',
  title: 'Waves at night',
  width: 1080,
  height: 1920,
  durationSeconds: 4,
  avgColor: '#223344',
  hasPreview: false,
  variants: [
    { id: 'hd', width: 1080, height: 1920, fps: 30, contentType: 'video/mp4', format: 'mp4' },
  ],
  license: 'pexels',
  licenseUrl: 'https://www.pexels.com/license/',
  attributionRequired: false,
  attribution: 'Video by Someone on Pexels',
  creator: 'Someone',
};

function installDesktop(bridge: Record<string, unknown>): void {
  (window as unknown as { framepilot?: unknown }).framepilot = bridge;
}

afterEach(() => {
  delete (window as unknown as { framepilot?: unknown }).framepilot;
  window.localStorage.clear();
  resetDownloadRegistriesForTests();
});

function mount(): ReturnType<typeof vi.fn<(project: Project) => void>> {
  const onProjectChange = vi.fn<(project: Project) => void>();
  render(<Editor project={demoProject} onProjectChange={onProjectChange} />);
  return onProjectChange;
}

const lastProject = (spy: ReturnType<typeof vi.fn>): Project =>
  spy.mock.calls[spy.mock.calls.length - 1]![0] as Project;

/** The editor's polite region for arrivals. */
const addedRegion = (): HTMLElement => document.querySelector<HTMLElement>('[data-live="added"]')!;

function openElementsTab(name: 'Photos' | 'Videos' | 'Stickers' | 'Shapes'): void {
  fireEvent.click(screen.getByRole('tab', { name: 'Elements' }));
  fireEvent.click(
    within(screen.getByRole('tablist', { name: 'Elements' })).getByRole('tab', { name }),
  );
}

const selected = (clipId: string): string | null =>
  screen.getByRole('button', { name: `clip ${clipId}` }).getAttribute('data-selected');

describe('Editor — feedback after every element add', () => {
  it('selects and announces a shape added from the Shapes tab, and again when repeated', async () => {
    installDesktop({});
    const onProjectChange = mount();
    openElementsTab('Shapes');
    const tile = screen.getAllByRole('button', { name: /Highlight box/ })[0]!;

    fireEvent.click(tile);
    await waitFor(() => expect(addedRegion().textContent).toBe('Added the highlight box at 0:00'));
    const shapes = (): string[] =>
      lastProject(onProjectChange)
        .timeline.tracks.flatMap((track) => track.clips)
        .filter((candidate) => candidate.assetId === '__shape__')
        .map((candidate) => candidate.id);
    expect(selected(shapes()[0]!)).toBe('true');

    // The same message again is read again: the region empties first.
    fireEvent.click(tile);
    expect(addedRegion().textContent).toBe('');
    await waitFor(() => expect(addedRegion().textContent).toBe('Added the highlight box at 0:00'));
    expect(shapes()).toHaveLength(2);
  });

  it('places a sticker where the playhead is when the copy lands, selected and announced', async () => {
    let land: (result: ElementMaterializeResult) => void = () => undefined;
    installDesktop({
      elementsMaterialize: () =>
        new Promise<ElementMaterializeResult>((resolve) => {
          land = resolve;
        }),
    });
    const onProjectChange = mount();
    openElementsTab('Stickers');
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search stickers' }), {
      target: { value: 'fire' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^(Add Fire|Fire, sticker)$/ })[0]!);

    // The copy takes a moment; the playhead moves in the meantime.
    fireEvent.change(screen.getByLabelText('playhead', { exact: true }), {
      target: { value: '2' },
    });
    await act(async () => {
      land({ ok: true, asset: stickerAsset('fire') });
    });

    await waitFor(() => expect(addedRegion().textContent).toBe('Added Fire at 0:02'));
    const sticker = lastProject(onProjectChange)
      .timeline.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.assetId === 'element_fluent3d_fire')!;
    expect(sticker.start).toBe(2);
    expect(selected(sticker.id)).toBe('true');
  });

  it('selects and announces a Pexels clip added as a cutaway', async () => {
    installDesktop({
      stockQuota: async () => ({ kind: 'unmeasured' }),
      stockSearch: async () => ({
        ok: true,
        items: [clip],
        page: 1,
        totalResults: 1,
        hasMore: false,
      }),
      stockThumbnail: async () => ({ ok: false }),
      stockDownload: async () => ({
        ok: true,
        asset: {
          relativePath: 'media/p/waves.mp4',
          kind: 'video',
          durationSeconds: 4,
          media: { width: 1080, height: 1920 },
          source: {
            provider: 'pexels',
            remoteId: '777',
            license: 'pexels',
            attributionRequired: false,
            fetchedAt: '2026-09-26T00:00:00.000Z',
          },
          deduped: false,
        },
      }),
    });
    const onProjectChange = mount();
    // After the footage, where a cutaway has room.
    fireEvent.change(screen.getByLabelText('playhead', { exact: true }), {
      target: { value: '14' },
    });
    openElementsTab('Videos');
    const tile = await screen.findByRole('button', { name: /^Waves at night, 0:04/ });
    await act(async () => {
      fireEvent.keyDown(tile, { key: 'Enter' });
    });

    await waitFor(() => expect(addedRegion().textContent).toBe('Added the video at 0:14'));
    const placed = lastProject(onProjectChange)
      .timeline.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.assetId === 'stock_pexels_777')!;
    expect(placed.start).toBe(14);
    expect(selected(placed.id)).toBe('true');
  });
});
