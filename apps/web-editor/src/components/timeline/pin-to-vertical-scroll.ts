/** What stays at the top of the lanes while the track stack scrolls vertically. */
const PINNED_TO_TOP_SELECTOR = '.ruler, .playhead-head';

/**
 * Holds the ruler and the playhead's grab head at the top of the visible lanes.
 *
 * WHY not `position: sticky`: both live inside `.lane-scroll`, whose `overflow-x: auto`
 * makes it a scroll container on BOTH axes (CSS computes the other axis to `auto`).
 * A sticky element sticks to its nearest scroll container, so they stuck to
 * `.lane-scroll` — which never scrolls vertically — and rode away with the tracks as
 * the stack grew past the dock. The vertical scroller is `.timeline-vscroll`, one
 * level up, so the offset is written from its `scrollTop` directly (a style write, no
 * React render). The line under the head is not moved: it spans every lane already.
 *
 * @param scroller - `.timeline-vscroll`, the element that scrolls the stack.
 * @param lanes - `.timeline-lanes`, which holds the ruler and the playhead.
 */
export function pinToVerticalScroll(scroller: HTMLElement, lanes: HTMLElement): void {
  const offset = `translateY(${scroller.scrollTop}px)`;
  for (const pinned of lanes.querySelectorAll<HTMLElement>(PINNED_TO_TOP_SELECTOR)) {
    pinned.style.transform = offset;
  }
}
