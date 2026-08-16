/**
 * One inspector property row (revamp Phase 4, F6).
 *
 * The density contract for this revamp: a **28px row** with the label column fixed
 * at **72px**, so every control in the panel left-aligns on one axis. Before this,
 * each panel laid its own fields out and nothing lined up between sections.
 *
 * Two affordances live here rather than in every section:
 *
 *  - **Reset this property**, hover-revealed. Invisible at rest so a panel of twelve
 *    rows is not a panel of twelve buttons, but always in layout and always in the
 *    accessibility tree — a keyboard user tabs to it, and nothing reflows when it
 *    appears. Rendered only when the value actually differs from its default, so the
 *    button's presence is itself information.
 *  - **The mixed-value indicator**, for a multi-clip selection where this property
 *    differs. Shown as the em-dash in place of the value, with the real control still
 *    live — typing writes to the whole selection (see `mixed.ts`).
 */
import type { ReactNode } from 'react';
import { MIXED_INDICATOR } from './mixed.js';
import { Tooltip } from '../Tooltip.js';
import { ICON_SIZE, RotateCcw } from '../icons.js';

export interface InspectorRowProps {
  /** Visible caption in the fixed-width label column. */
  readonly label: string;
  /**
   * Identifies the row for assistive tech and tests. The reset button's accessible
   * name is derived from it (`reset <name>`), so it should read as the property does
   * elsewhere in the app.
   */
  readonly name: string;
  /** The control itself. */
  readonly children: ReactNode;
  /**
   * True when this property differs across a multi-clip selection. The row shows
   * {@link MIXED_INDICATOR} beside the control; the control stays interactive,
   * because editing it is how you make the selection uniform.
   */
  readonly mixed?: boolean;
  /**
   * Reset just this property. Omitted (or with `canReset` false) renders no button —
   * a disabled reset raises the question and then refuses to answer it.
   */
  readonly onReset?: (() => void) | undefined;
  /** Whether the value differs from its default. Drives whether reset renders. */
  readonly canReset?: boolean;
  /**
   * The keyframe affordance for an animatable property (revamp Phase 5) — normally a
   * `<KeyframeButton>`.
   *
   * A **slot**, not a `keyframe: KeyframeState` prop, on purpose: rows exist for
   * plenty of properties the engine cannot animate (blend mode, duck target), and
   * teaching this component about keyframes would make every one of them carry a
   * concept it has no use for. The row owns layout; what goes in the slot is the
   * section's business.
   */
  readonly keyframe?: ReactNode;
}

export function InspectorRow({
  label,
  name,
  children,
  mixed = false,
  onReset,
  canReset = true,
  keyframe,
}: InspectorRowProps): JSX.Element {
  return (
    <div className="inspector-row" data-mixed={mixed ? 'true' : undefined}>
      <span className="inspector-row-label">{label}</span>
      <div className="inspector-row-control">{children}</div>
      {keyframe}
      {mixed && (
        // aria-hidden: the em-dash is a visual shorthand. Screen-reader users get
        // the fact stated in words instead, which an em-dash cannot convey.
        <>
          <span className="inspector-row-mixed" aria-hidden="true">
            {MIXED_INDICATOR}
          </span>
          <span className="sr-only">{`${name} differs across the selection`}</span>
        </>
      )}
      {onReset !== undefined && canReset && (
        <Tooltip label={`Reset ${label.toLowerCase()}`}>
          <button
            type="button"
            className="inspector-row-reset"
            aria-label={`reset ${name}`}
            onClick={onReset}
          >
            <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
