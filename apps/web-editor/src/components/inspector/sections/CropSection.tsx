/**
 * Crop section body (revamp Phase 4 — extracted from the monolithic Inspector).
 * Title/label/order/open state live in the registry; this owns the controls.
 */
import { useState } from 'react';
import { Button } from '@framepilot/ui';
import type { Clip, CropRect } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import { FULL_FRAME_CROP, clipCropRect, isFullFrameCrop } from '../../../editor/selectors.js';
import { setClipCropPatch } from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';

/** Crop rect axes shown in the inspector (fractions of the source frame). */
const CROP_CONTROLS: readonly { readonly key: keyof CropRect; readonly label: string }[] = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
];

/**
 * Crop panel (H1.2h) — sets the clip's crop rect via `set_clip_crop`. Numeric
 * x/y/width/height inputs (fractions 0–1 of the source frame), not an
 * on-canvas drag gizmo: `PreviewTransform.tsx`'s handle machinery is built for
 * single-point uniform scale/translate, not an independent 4-edge rect, so a
 * proper crop gizmo is a larger follow-up (tracked in plan/PLAN.md H1.2h);
 * this ships the fully functional numeric primitive now. Seeded from the
 * clip's current crop and re-mounted per clip (via `key`); "Apply" commits one
 * reversible patch, mirroring `ColorPanel`'s explicit-commit convention.
 */
export function CropPanel({
  editor,
  clip,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
}): JSX.Element {
  const committed = clipCropRect(clip);
  const [crop, setCrop] = useState<CropRect>(committed);
  const set = (key: keyof CropRect, value: number): void =>
    setCrop((prev) => ({ ...prev, [key]: value }));

  const apply = (next: CropRect): void => {
    const patch = setClipCropPatch(
      editor.state.timeline,
      clip.id,
      isFullFrameCrop(next) ? null : next,
    );
    if (patch) editor.applyPatch(patch);
  };

  const unchanged =
    crop.x === committed.x &&
    crop.y === committed.y &&
    crop.width === committed.width &&
    crop.height === committed.height;

  return (
    <>
      <div className="inspector-subpanel" aria-label="clip crop">
        {CROP_CONTROLS.map((control) => (
          <ScrubNumber
            key={control.key}
            label={control.label}
            ariaLabel={`crop ${control.label.toLowerCase()}`}
            value={crop[control.key]}
            min={0}
            max={1}
            step={0.01}
            defaultValue={FULL_FRAME_CROP[control.key]}
            onChange={(value) => set(control.key, value)}
          />
        ))}
        <div className="inspector-actions">
          <Button
            variant="secondary"
            type="button"
            onClick={() => apply(crop)}
            disabled={unchanged}
          >
            Apply crop
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setCrop(FULL_FRAME_CROP);
              apply(FULL_FRAME_CROP);
            }}
            disabled={isFullFrameCrop(committed)}
          >
            Reset crop
          </Button>
        </div>
      </div>
    </>
  );
}
