/**
 * Shared collapsible inspector section.
 *
 * The native details element preserves keyboard and assistive-technology support.
 * Visual structure, iconography, reset behavior, and persisted disclosure state are
 * centralized here so every inspector type follows the same interaction contract.
 */
import type { ReactNode } from 'react';
import { Tooltip } from '../Tooltip.js';
import { ChevronRight, ICON_SIZE, RotateCcw } from '../icons.js';

export interface InspectorSectionProps {
  readonly title: string;
  /** Stable lowercase accessibility label used by tests and assistive technology. */
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly icon?: ReactNode;
  /** Reset every property owned by this section as one patch. */
  readonly onReset?: (() => void) | undefined;
  readonly canReset?: boolean;
  readonly children: ReactNode;
}

export function InspectorSection({
  title,
  label,
  open,
  onToggle,
  icon,
  onReset,
  canReset = true,
  children,
}: InspectorSectionProps): JSX.Element {
  return (
    <details
      className="inspector-panel"
      aria-label={label}
      open={open}
      onToggle={(event) => onToggle((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="inspector-section-head">
        <span className="inspector-section-chevron" aria-hidden="true">
          <ChevronRight size={ICON_SIZE.sm} />
        </span>
        {icon !== undefined && (
          <span className="inspector-section-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <h3>{title}</h3>
        {onReset !== undefined && canReset && (
          <Tooltip label={`Reset ${title.toLowerCase()}`}>
            <button
              type="button"
              className="inspector-section-reset"
              aria-label={`reset ${label}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onReset();
              }}
            >
              <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </summary>
      <div className="inspector-section-content">{children}</div>
    </details>
  );
}
