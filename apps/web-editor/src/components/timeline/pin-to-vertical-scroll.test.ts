import { describe, expect, it } from 'vitest';
import { pinToVerticalScroll } from './pin-to-vertical-scroll.js';

/** The timeline's shape: the vertical scroller around the lanes, which hold the ruler,
 *  the playhead (head + line) and the tracks. */
function timeline(): { scroller: HTMLElement; lanes: HTMLElement } {
  const scroller = document.createElement('div');
  scroller.innerHTML = `
    <div class="timeline-lanes">
      <div class="ruler"></div>
      <div class="playhead" style="transform: translate3d(120px, 0, 0)">
        <button class="playhead-head"></button>
        <div class="playhead-line"></div>
      </div>
      <ol class="tracks"><li class="clip-block"></li></ol>
    </div>`;
  return { scroller, lanes: scroller.querySelector<HTMLElement>('.timeline-lanes')! };
}

const styleOf = (root: HTMLElement, selector: string): string =>
  root.querySelector<HTMLElement>(selector)!.style.transform;

describe('pinToVerticalScroll', () => {
  it('holds the ruler and the playhead head at the scrolled-to top of the stack', () => {
    const { scroller, lanes } = timeline();
    scroller.scrollTop = 180;

    pinToVerticalScroll(scroller, lanes);

    expect(styleOf(lanes, '.ruler')).toBe('translateY(180px)');
    expect(styleOf(lanes, '.playhead-head')).toBe('translateY(180px)');
  });

  it('leaves the playhead x position, its full-height line and the clips alone', () => {
    const { scroller, lanes } = timeline();
    scroller.scrollTop = 64;

    pinToVerticalScroll(scroller, lanes);

    expect(styleOf(lanes, '.playhead')).toBe('translate3d(120px, 0, 0)');
    expect(styleOf(lanes, '.playhead-line')).toBe('');
    expect(styleOf(lanes, '.clip-block')).toBe('');
  });

  it('returns them to the top when the stack scrolls back', () => {
    const { scroller, lanes } = timeline();
    scroller.scrollTop = 90;
    pinToVerticalScroll(scroller, lanes);
    scroller.scrollTop = 0;

    pinToVerticalScroll(scroller, lanes);

    expect(styleOf(lanes, '.ruler')).toBe('translateY(0px)');
    expect(styleOf(lanes, '.playhead-head')).toBe('translateY(0px)');
  });
});
