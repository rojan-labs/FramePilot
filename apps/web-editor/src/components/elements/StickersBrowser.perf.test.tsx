/**
 * The Stickers tab's budgets (plan/elements 02 §9, EL6b.2) over the real 1,595-sticker catalogue:
 * a search keystroke's work fits one 60 Hz frame (16 ms), and a warm open draws its first tiles
 * within 100 ms, because the grid draws only the rows in view.
 *
 * Search is measured as the work itself (`searchStickers`, what each keystroke runs), since a DOM
 * without layout times React and jsdom, not the browser. The open is measured in jsdom, which is
 * slower than Chromium at the same work, so passing here is passing with room.
 *
 * Runs only with FRAMEPILOT_RUN_PERF=1 (never under coverage; see `vite.config.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { loadStickerCatalog, searchStickers } from '@framepilot/ai-sdk';
import type { PackagedTileSource } from './packaged-tiles.js';
import { StickersBrowser } from './StickersBrowser.js';

vi.mock('../../editor/bridge.js', () => ({
  elementsMaterialize: async () => ({ ok: false, error: 'library_missing' }),
  elementsThumbnail: async () => ({ ok: true, packaged: true, thumbs: [] }),
}));

/** 02 §9: one frame at 60 Hz. */
const SEARCH_BUDGET_MS = 16;
/** 02 §9: Open Elements → first tiles painted (Stickers, warm). */
const FIRST_TILES_BUDGET_MS = 100;
/** Every prefix of a few real searches, typed a key at a time, plus a glyph. */
const KEYSTROKES = ['fire', 'party popper', 'thumbs', 'heart', 'check', 'rocket', '🔥'].flatMap(
  (word) => Array.from(word, (_, index) => word.slice(0, index + 1)),
);
const WARMUP_ROUNDS = 2;

const percentile = (samples: readonly number[], share: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
};

const packaged: PackagedTileSource = {
  present: async () => true,
  url: () => undefined,
  load: async () => {},
};

describe('Stickers tab budgets (02 §9)', () => {
  it('searches the whole library within a frame per keystroke', async () => {
    const catalog = await loadStickerCatalog();
    expect(catalog.items).toHaveLength(1595);
    const samples: number[] = [];
    for (let round = 0; round < WARMUP_ROUNDS + 1; round += 1) {
      for (const query of KEYSTROKES) {
        const started = performance.now();
        searchStickers(catalog, query, { includePackaged: true });
        if (round >= WARMUP_ROUNDS) samples.push(performance.now() - started);
      }
    }
    const p95 = percentile(samples, 0.95);
    console.info(
      `[EL6b stickers] search p50 ${percentile(samples, 0.5).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`,
    );
    expect(p95).toBeLessThanOrEqual(SEARCH_BUDGET_MS);
  });

  it('draws its first tiles within 100 ms of a warm open, and only the rows in view', async () => {
    await loadStickerCatalog();
    /** Mount the tab and wait for its first tile; the open's time and how many tiles it drew. */
    const open = async (): Promise<{ elapsed: number; drawn: number }> => {
      const started = performance.now();
      const view = render(
        <StickersBrowser
          project={{ id: 'p', assets: [] }}
          onAddSticker={() => null}
          packagedTiles={packaged}
        />,
      );
      await screen.findByRole('button', { name: 'Add Grinning face' });
      const elapsed = performance.now() - started;
      const drawn = document.querySelectorAll('.stickers-grid-tile').length;
      view.unmount();
      return { elapsed, drawn };
    };
    // Warm, as 02 §9 measures it: the tab has been opened before this session. The median of
    // three keeps one collection pause on a shared runner from deciding it.
    const cold = await open();
    const warm = [await open(), await open(), await open()];
    const elapsed = percentile(
      warm.map((run) => run.elapsed),
      0.5,
    );
    console.info(
      `[EL6b stickers] cold open ${cold.elapsed.toFixed(1)} ms (not budgeted), warm ${elapsed.toFixed(1)} ms, ${String(cold.drawn)} tiles drawn of 1,595`,
    );
    expect(elapsed).toBeLessThanOrEqual(FIRST_TILES_BUDGET_MS);
    expect(Math.max(...warm.map((run) => run.drawn))).toBeLessThan(200);
  });
});
