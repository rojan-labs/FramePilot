/**
 * Tests for the ClipFilmstrip picture layer: ONE canvas per clip drawn from cached
 * bitmaps when the asset has derived thumbnails (P2), and a subtle skeleton when it
 * does not. Presentation only — always aria-hidden so it never pollutes the a11y
 * tree. The frame-URL resolution is pure ({@link filmstripFrameUrls}) and asserted
 * directly; the canvas blitting itself is inert in jsdom (exercised in e2e).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { Asset } from '@framepilot/timeline-schema';
import { ClipFilmstrip, filmstripFrameUrls, filmstripSlots } from './ClipFilmstrip.js';

const assetWith = (thumbnailPaths?: string[], durationSeconds?: number): Asset => ({
  id: 'v1',
  path: '/media/clip.mp4',
  kind: 'video',
  durationSeconds,
  media: thumbnailPaths ? { thumbnailPaths } : undefined,
});

describe('ClipFilmstrip', () => {
  it('renders a skeleton placeholder when the asset has no thumbnails', () => {
    const { container } = render(
      <ClipFilmstrip asset={assetWith(undefined, 10)} sourceStart={0} sourceEnd={5} />,
    );
    const strip = container.querySelector('.clip-filmstrip');
    expect(strip).not.toBeNull();
    expect(strip!.classList.contains('clip-filmstrip--skeleton')).toBe(true);
    expect(strip!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.clip-filmstrip-frame')).toHaveLength(0);
  });

  it('renders a skeleton when the asset is missing entirely', () => {
    const { container } = render(<ClipFilmstrip asset={undefined} sourceStart={0} sourceEnd={5} />);
    expect(container.querySelector('.clip-filmstrip--skeleton')).not.toBeNull();
  });

  it('renders ONE canvas (not per-frame divs) sized to the derived frame count (P2)', () => {
    const thumbs = ['a.jpg', 'b.jpg', 'c.jpg'];
    const { container } = render(
      <ClipFilmstrip asset={assetWith(thumbs, 3)} sourceStart={0} sourceEnd={3} />,
    );
    // The per-slot background-image divs are gone — their per-zoom-tick
    // re-rasterization was the thumbnail-zoom lag (P2 root cause).
    expect(container.querySelectorAll('.clip-filmstrip-frame')).toHaveLength(0);
    const canvases = container.querySelectorAll('.clip-filmstrip-canvas');
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.getAttribute('data-frames')).toBe('3');
    expect(container.querySelector('.clip-filmstrip')!.getAttribute('aria-hidden')).toBe('true');
    // Not a skeleton when frames are present.
    expect(container.querySelector('.clip-filmstrip--skeleton')).toBeNull();
  });

  it('keeps the SAME canvas element across zoom re-renders (no DOM churn)', () => {
    const thumbs = ['a.jpg', 'b.jpg', 'c.jpg'];
    const { container, rerender } = render(
      <ClipFilmstrip asset={assetWith(thumbs, 3)} sourceStart={0} sourceEnd={3} slots={4} />,
    );
    const before = container.querySelector('.clip-filmstrip-canvas');
    // A zoom tick that crosses a slot bucket re-renders with a new slot count…
    rerender(
      <ClipFilmstrip asset={assetWith(thumbs, 3)} sourceStart={0} sourceEnd={3} slots={6} />,
    );
    // …but the canvas node is reused; only its drawing is refreshed.
    expect(container.querySelector('.clip-filmstrip-canvas')).toBe(before);
  });
});

describe('filmstripFrameUrls (pure URL resolution)', () => {
  it('resolves engine thumbnail paths through mediaSrc (fp-media scheme, CSP-safe)', () => {
    expect(filmstripFrameUrls(['a.jpg'], { status: 'none' }, 4)).toEqual([
      'fp-media://local/a.jpg',
    ]);
    // A frame path that is already a usable URL passes through unchanged.
    expect(filmstripFrameUrls(['blob:abc'], { status: 'none' }, 4)).toEqual(['blob:abc']);
  });

  it('tiles the single bin-captured thumbnail across every slot as fallback', () => {
    expect(filmstripFrameUrls([], { status: 'ready', url: 'data:x' }, 3)).toEqual([
      'data:x',
      'data:x',
      'data:x',
    ]);
  });

  it('is empty (→ placeholder) with no engine frames and no capture', () => {
    expect(filmstripFrameUrls([], { status: 'loading' }, 3)).toEqual([]);
  });
});

describe('filmstripSlots (H6 — width-adaptive frame count)', () => {
  it('gives one slot to slivers so a narrow clip still shows a real frame', () => {
    expect(filmstripSlots(0)).toBe(1);
    expect(filmstripSlots(10)).toBe(1);
    expect(filmstripSlots(60)).toBe(1);
  });

  it('adds a slot roughly every TARGET_FRAME_PX of clip width', () => {
    expect(filmstripSlots(112)).toBe(2);
    expect(filmstripSlots(280)).toBe(5);
  });

  it('caps very wide clips and tolerates non-finite widths', () => {
    expect(filmstripSlots(100000)).toBe(16);
    expect(filmstripSlots(Number.NaN)).toBe(1);
    expect(filmstripSlots(-5)).toBe(1);
  });
});
