/**
 * The monitor's mask view switch (MK3.3): Off / Overlay / Mask only / Checkerboard.
 *
 * Shown only while a selected picture clip has an enabled mask, so it never adds chrome to an
 * ordinary edit. The views are inspection aids on the monitor; exports never see them.
 */
import { SegmentedControl } from '@framepilot/ui';
import { MASK_DEBUG_VIEWS, type MaskDebugView } from '../preview/masks/mask-view.js';

export interface MaskViewToggleProps {
  readonly value: MaskDebugView;
  readonly onChange: (view: MaskDebugView) => void;
}

export function MaskViewToggle({ value, onChange }: MaskViewToggleProps): JSX.Element {
  return (
    <SegmentedControl
      className="preview-mask-view"
      label="Mask view"
      value={value}
      options={MASK_DEBUG_VIEWS}
      onValueChange={onChange}
    />
  );
}
