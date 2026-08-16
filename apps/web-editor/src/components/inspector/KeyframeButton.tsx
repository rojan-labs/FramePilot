/**
 * The keyframe diamond and its prev/next chevrons (revamp Phase 5, F5).
 *
 * ## What this replaces
 *
 * A form. To animate scale, the old inspector made you pick "scale" from a dropdown,
 * type a number, pick an easing and press "Add keyframe" — while the scale field sat
 * in the same panel above, unconnected. The property and its animation were two
 * different things in the UI even though they are one thing in the engine.
 *
 * Now the affordance is *on the property*: one diamond, next to the value it
 * animates, that says what state the animation is in and changes it when clicked.
 *
 * ## The five states, and why they are distinguishable
 *
 * `none` · `at-playhead` · `animated` (elsewhere) · `will-create` (animated, and
 * editing the value here would add a keyframe) · `pulsing` (this row just took a
 * write). They are conveyed by **fill, ring and emphasis — never hue alone** (design
 * direction §3), and every one of them is also stated in the button's accessible
 * name, because a screen-reader user gets no fill at all.
 *
 * ## Clicking is always one patch
 *
 * Add when empty or animated-elsewhere; remove when a keyframe is at the playhead.
 * The chevrons only *seek* — they move the playhead to the neighbouring keyframe and
 * write nothing, so navigating an animation is never an edit.
 */
import { Tooltip } from '../Tooltip.js';
import { ICON_SIZE, ChevronLeft, ChevronRight, Diamond } from '../icons.js';
import type { LiveKeyframeState } from './useKeyframeState.js';

export interface KeyframeButtonProps {
  /** The property's live state, from `useKeyframeState`. */
  readonly state: LiveKeyframeState;
  /** Human-readable property name for tooltips and accessible names. */
  readonly label: string;
  /** Toggle a keyframe at the playhead: add when absent, remove when present. */
  readonly onToggle: () => void;
  /** Seek the playhead to a clip-relative time. Navigation only — never an edit. */
  readonly onSeek: (clipTime: number) => void;
}

/** What clicking the diamond will do, in words. Drives tooltip and accessible name. */
function describeToggle(state: LiveKeyframeState, label: string): string {
  if (state.status === 'at-playhead') return `Remove ${label} keyframe at the playhead`;
  if (state.status === 'animated') return `Add ${label} keyframe at the playhead`;
  return `Animate ${label} — adds a keyframe at the playhead`;
}

export function KeyframeButton({
  state,
  label,
  onToggle,
  onSeek,
}: KeyframeButtonProps): JSX.Element {
  const action = describeToggle(state, label);
  return (
    <span
      className="keyframe-control"
      // One group so the three buttons read as one affordance rather than three
      // unrelated controls sharing a row.
      role="group"
      aria-label={`${label} animation`}
    >
      <Tooltip label={`Previous ${label} keyframe`}>
        <button
          type="button"
          className="keyframe-nav"
          aria-label={`previous ${label} keyframe`}
          // Disabled rather than hidden: a chevron that vanishes at the first
          // keyframe makes the row's controls jump sideways as you navigate.
          disabled={state.prevTime === undefined}
          onClick={() => {
            if (state.prevTime !== undefined) onSeek(state.prevTime);
          }}
        >
          <ChevronLeft size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
      </Tooltip>

      <Tooltip label={action}>
        <button
          type="button"
          className="keyframe-diamond"
          // `data-*` rather than a class soup: one attribute per fact, so the CSS
          // reads as the state table it is, and a test can assert the state without
          // knowing the styling.
          data-status={state.status}
          data-pulsing={state.pulsing ? 'true' : undefined}
          data-will-create={state.willCreateKeyframe ? 'true' : undefined}
          aria-label={action}
          aria-pressed={state.status === 'at-playhead'}
          onClick={onToggle}
        >
          <Diamond size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
      </Tooltip>

      <Tooltip label={`Next ${label} keyframe`}>
        <button
          type="button"
          className="keyframe-nav"
          aria-label={`next ${label} keyframe`}
          disabled={state.nextTime === undefined}
          onClick={() => {
            if (state.nextTime !== undefined) onSeek(state.nextTime);
          }}
        >
          <ChevronRight size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
      </Tooltip>

      {/*
        The promise, made BEFORE the commit. Editing an animated property at a
        playhead that has no keyframe adds one, and the user should know that while
        deciding to type — not discover it in the undo stack afterwards.
        `role="status"` so it is announced when it appears, not only when focused.
      */}
      {state.willCreateKeyframe && (
        <span className="keyframe-hint" role="status">
          <span aria-hidden="true">+kf</span>
          <span className="sr-only">{`editing ${label} here will add a keyframe`}</span>
        </span>
      )}
    </span>
  );
}
