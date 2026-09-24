/**
 * CaptionOverlay layout parity with the engine (`render/captions.py`): words that
 * have not appeared yet keep their place in a build/cascade line, and a one-word
 * caption shows only the spoken word.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CaptionOverlay } from './CaptionOverlay.js';

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
});
