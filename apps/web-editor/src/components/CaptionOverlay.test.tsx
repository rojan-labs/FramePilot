/**
 * CaptionOverlay layout parity with the engine (`render/captions.py`): words that
 * have not appeared yet keep their place in a build/cascade line, and a one-word
 * caption shows only the spoken word.
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CAPTION_ANCHOR_CSS, CaptionOverlay } from './CaptionOverlay.js';

const WORDS = [
  { word: 'this', start: 0, end: 1 },
  { word: 'goes', start: 1, end: 2 },
  { word: 'viral', start: 2, end: 3 },
];

const states = (container: HTMLElement): (string | null)[] =>
  Array.from(container.querySelectorAll('[data-word-state]')).map((span) =>
    span.getAttribute('data-word-state'),
  );

describe('CaptionOverlay', () => {
  it('reserves the place of words a build line has not reached yet', () => {
    const { container } = render(
      <CaptionOverlay style={{ display: 'cumulative' }} lines={[WORDS]} time={0.5} />,
    );
    expect(states(container)).toEqual(['active', 'hidden', 'hidden']);
    const hidden = container.querySelector<HTMLElement>('[data-word-state="hidden"]');
    expect(hidden?.style.visibility).toBe('hidden');
  });

  it('keeps the untyped rest of a typewriter word in the layout', () => {
    const { container } = render(
      <CaptionOverlay
        style={{ display: 'phrase', animation: { in: { type: 'typewriter', duration: 2 } } }}
        lines={[WORDS]}
        time={0.5}
      />,
    );
    const first = container.querySelector('[data-word-state="active"]');
    expect(first?.textContent).toBe('this');
    expect(first?.querySelector('span')?.style.visibility).toBe('hidden');
  });

  it('shows only the spoken word in one-word display', () => {
    const { container } = render(
      <CaptionOverlay style={{ display: 'active-word' }} lines={[WORDS]} time={1.5} />,
    );
    expect(states(container)).toEqual(['active']);
    expect(container.textContent).toBe('goes');
  });

  it('draws see-through letters as stacked copies, reading only the letters copy', () => {
    // jsdom does not resolve an inherited font size; a browser gives the px value.
    const computed = window.getComputedStyle.bind(window);
    const spy = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((element) =>
        Object.assign(computed(element), { fontSize: '20px' } as Partial<CSSStyleDeclaration>),
      );
    const { container } = render(
      <CaptionOverlay
        style={{
          display: 'phrase',
          textOpacity: 0.3,
          outlineColor: '#000000',
          outlineWidth: 2,
          highlight: {
            enabled: true,
            color: '#ffd60a',
            animation: 'background',
            background: '#000',
          },
        }}
        lines={[WORDS]}
        time={0.5}
        fontSize="20px"
      />,
    );
    const stack = container.querySelector('.caption-see-through');
    expect(stack).not.toBeNull();
    // chips, the knocked-out ring/shadow copy, and the letters: one layout each.
    expect(stack?.querySelectorAll('.caption-overlay-line')).toHaveLength(3);
    expect(container.querySelector('[data-caption-layer="separation"]')).not.toBeNull();
    const filter = container.querySelector('filter');
    expect(filter?.querySelector('feMorphology')?.getAttribute('radius')).toBe('2.5');
    // Only the letters copy carries word states, so the text reads once.
    expect(states(container)).toEqual(['active', 'upcoming', 'upcoming']);
    spy.mockRestore();
  });

  it('frosts the chip behind the caption with a backdrop blur', () => {
    const { container } = render(
      <CaptionOverlay
        style={{ background: { color: '#ffffff26', blur: 0.3 } }}
        lines={[WORDS]}
        time={0.5}
      />,
    );
    const block = container.querySelector<HTMLElement>('.caption-overlay-block');
    expect(block?.style.backdropFilter).toBe('blur(0.3em)');
  });

  it('wipes an outlined karaoke word with a copy that adds no text to the page', () => {
    const { container } = render(
      <CaptionOverlay
        style={{
          display: 'phrase',
          outlineColor: '#000000',
          outlineWidth: 2,
          highlight: { enabled: true, color: '#ffd60a', animation: 'karaoke-fill' },
        }}
        lines={[WORDS]}
        time={1.5}
      />,
    );
    const active = container.querySelector<HTMLElement>('[data-word-state="active"]');
    expect(active?.textContent).toBe('goes');
    expect(active?.className).toBe('caption-karaoke-word');
    expect(active?.dataset.wipe).toBe('goes');
    expect(active?.style.getPropertyValue('--caption-wipe-hidden')).toBe('50.0%');
    expect(active?.style.backgroundImage).toBe('');
  });

  // jsdom lays nothing out, so these pin the two CSS rules whose layout was measured in
  // Chromium (run fb90e58d audit): a `left: 50%` box with no width shrink-wraps at half the
  // frame (202 px of a 404 px frame, three rows) where `max-content` + `maxWidth: 80%`
  // wraps at 323 px (two rows) — the export's width.
  it('sizes a placed caption to its text, capped at maxWidthPercent, as the export wraps', () => {
    const { container } = render(
      <CaptionOverlay
        style={{ xPercent: 50, yPercent: 64, maxWidthPercent: 80 }}
        lines={[WORDS]}
        time={1.5}
      />,
    );
    const block = container.querySelector<HTMLElement>('.caption-overlay-block');
    expect(block?.style.position).toBe('absolute');
    expect(block?.style.width).toBe('max-content');
    expect(block?.style.maxWidth).toBe('80%');
  });

  it('keeps an anchored caption 8% of the frame HEIGHT from its edge, as the export does', () => {
    // A percentage padding resolves against the WIDTH; `cqh` is the frame's height. Read
    // from the table because jsdom's CSS parser drops container-query units it does not
    // know, so an inline style reads back empty here while Chromium applies it.
    expect(CAPTION_ANCHOR_CSS.bottom?.paddingBottom).toBe('8cqh');
    expect(CAPTION_ANCHOR_CSS.top?.paddingTop).toBe('8cqh');
  });
});
