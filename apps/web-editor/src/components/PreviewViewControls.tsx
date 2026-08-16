import {
  CUSTOM_ORIENTATION_ID,
  ORIENTATION_PRESETS,
  orientationIdFor,
} from '../editor/orientation.js';
import { Select } from './Select.js';
import { Tooltip } from './Tooltip.js';
import { Contrast, Grid, ICON_SIZE, Maximize2, Repeat, Scan } from './icons.js';

export const PREVIEW_ZOOM_OPTIONS = [
  { value: 'fit', label: 'Fit' },
  { value: '50', label: '50%' },
  { value: '100', label: '100%' },
  { value: '150', label: '150%' },
  { value: '200', label: '200%' },
] as const;

export type PreviewZoom = (typeof PREVIEW_ZOOM_OPTIONS)[number]['value'];

interface PreviewViewControlsProps {
  readonly resolution?: { readonly width: number; readonly height: number };
  readonly onChangeOrientation?: (presetId: string) => void;
  readonly isGraded: boolean;
  readonly showGrade: boolean;
  readonly onToggleGrade: () => void;
  /**
   * Loop, rendered here only when BOTH loop props are supplied.
   *
   * Loop is playback, not a view option — sitting next to the grid and the
   * safe-area guides put it in the wrong mental category (revamp Phase 2, F3), so
   * the program monitor now shows it in {@link PreviewTransport} and does not pass
   * these. They remain for surfaces that render this control strip WITHOUT the
   * shared transport, so those don't silently lose the control.
   */
  readonly loop?: boolean;
  readonly onToggleLoop?: () => void;
  readonly showGrid: boolean;
  readonly onToggleGrid: () => void;
  readonly showSafeArea: boolean;
  readonly onToggleSafeArea: () => void;
  readonly zoom: PreviewZoom;
  readonly onZoomChange: (zoom: PreviewZoom) => void;
  readonly onToggleFullscreen: () => void;
}

/**
 * Program-monitor view controls shared with internal review surfaces so neither
 * context silently loses actions as the control set evolves.
 */
export function PreviewViewControls({
  resolution,
  onChangeOrientation,
  isGraded,
  showGrade,
  onToggleGrade,
  loop,
  onToggleLoop,
  showGrid,
  onToggleGrid,
  showSafeArea,
  onToggleSafeArea,
  zoom,
  onZoomChange,
  onToggleFullscreen,
}: PreviewViewControlsProps): JSX.Element {
  return (
    <div className="transport-right">
      {resolution && onChangeOrientation && (
        <Select
          className="transport-orientation"
          label="Canvas orientation"
          popoverPlacement="up"
          value={orientationIdFor(resolution)}
          options={[
            ...ORIENTATION_PRESETS.map((preset) => ({
              value: preset.id,
              label: preset.label,
              hint: preset.hint,
            })),
            {
              value: CUSTOM_ORIENTATION_ID,
              label:
                orientationIdFor(resolution) === CUSTOM_ORIENTATION_ID
                  ? `${resolution.width}×${resolution.height}`
                  : 'Custom',
              hint: 'Current project dimensions',
            },
          ]}
          onChange={onChangeOrientation}
        />
      )}
      {isGraded && (
        <Tooltip label="Compare the ungraded source">
          <button
            type="button"
            className={`transport-btn ${showGrade ? 'is-active' : ''}`}
            aria-label="compare original"
            aria-pressed={!showGrade}
            onClick={onToggleGrade}
          >
            <Contrast size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      {loop !== undefined && onToggleLoop !== undefined && (
        <Tooltip label="Loop playback">
          <button
            type="button"
            className={`transport-btn ${loop ? 'is-active' : ''}`}
            aria-label="loop"
            aria-pressed={loop}
            onClick={onToggleLoop}
          >
            <Repeat size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <Tooltip label="Rule-of-thirds grid">
        <button
          type="button"
          className={`transport-btn ${showGrid ? 'is-active' : ''}`}
          aria-label="composition grid"
          aria-pressed={showGrid}
          onClick={onToggleGrid}
        >
          <Grid size={ICON_SIZE.md} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label="Safe-area guides">
        <button
          type="button"
          className={`transport-btn ${showSafeArea ? 'is-active' : ''}`}
          aria-label="safe-area guides"
          aria-pressed={showSafeArea}
          onClick={onToggleSafeArea}
        >
          <Scan size={ICON_SIZE.md} aria-hidden="true" />
        </button>
      </Tooltip>
      <Select
        className="transport-zoom"
        label="Preview zoom"
        popoverPlacement="up"
        value={zoom}
        options={PREVIEW_ZOOM_OPTIONS}
        onChange={(value) => onZoomChange(value as PreviewZoom)}
      />
      <Tooltip label="Fullscreen preview">
        <button
          type="button"
          className="transport-btn"
          aria-label="fullscreen preview"
          onClick={onToggleFullscreen}
        >
          <Maximize2 size={ICON_SIZE.md} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
