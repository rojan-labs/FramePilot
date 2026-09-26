/**
 * The Inspector's Sticker section (plan/elements EL6a.5, EL6b.3, 02 §4.1): which sticker this is,
 * where it comes from, and **Replace…**, which opens Elements → Stickers to swap it for another
 * while its timing, position, size and animation stay; an **Outline** and a **Shadow** drawn
 * around the sticker's own alpha (the Mask tab's edge styles, fewer controls); and a note when the
 * sticker is drawn beyond its sharp size at the export resolution. Position & size is the ordinary
 * Transform section.
 */
import { useMemo } from 'react';
import type { Asset, Clip } from '@framepilot/timeline-schema';
import { mediaSrc } from '../../../editor/media.js';
import { STICKER_SOFT_ENLARGEMENT, stickerEnlargement } from '@framepilot/editor-core';
import type { UseEditor } from '../../../editor/useEditor.js';
import { EdgeStyleControls } from '../masks/EdgeStylePanel.js';

/** A sticker's name from its catalogue id (`thumbs_up` -> `Thumbs up`). */
export function stickerName(asset: Asset | undefined): string {
  const id = asset?.source?.remoteId ?? '';
  const words = id.replace(/_/g, ' ').trim();
  return words === '' ? 'Sticker' : words.charAt(0).toUpperCase() + words.slice(1);
}

export interface StickerInspectorProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly asset: Asset | undefined;
  /** The export frame size, which decides how far the sticker is enlarged. */
  readonly resolution: { readonly width: number; readonly height: number };
  /** Open the Stickers sub-tab to replace this sticker; absent where there is no panel. */
  readonly onReplace?: (clipId: string, name: string) => void;
}

export function StickerInspector({
  editor,
  clip,
  asset,
  resolution,
  onReplace,
}: StickerInspectorProps): JSX.Element {
  const name = stickerName(asset);
  const { timeline, assets } = editor.state;
  const enlargement = useMemo(
    () => stickerEnlargement({ timeline, assets, resolution }, clip.id),
    [timeline, assets, resolution, clip.id],
  );
  return (
    <div className="inspector-subpanel sticker-section" aria-label="sticker">
      <div className="sticker-section-row">
        {asset !== undefined && (
          // The project's own copy: every placed sticker has one, curated or packaged.
          <img
            className="sticker-section-thumb"
            src={mediaSrc(asset.path)}
            alt=""
            width={40}
            height={40}
          />
        )}
        <span className="sticker-section-name">{name}</span>
        {onReplace !== undefined && (
          <button
            type="button"
            className="sticker-section-replace"
            onClick={() => onReplace(clip.id, name)}
          >
            Replace…
          </button>
        )}
      </div>
      <div className="sticker-section-look" role="group" aria-label="Sticker look">
        <EdgeStyleControls
          editor={editor}
          clip={clip}
          kind="stroke"
          label="Outline"
          around="the sticker"
          fields={['colour', 'widthPx']}
        />
        <EdgeStyleControls
          editor={editor}
          clip={clip}
          kind="shadow"
          label="Shadow"
          around="the sticker"
          fields={['preset']}
        />
      </div>
      {enlargement !== null && enlargement > STICKER_SOFT_ENLARGEMENT && (
        <p className="inspector-note" role="note">
          Enlarged beyond its sharp size: it will look soft in the export. Make it smaller to keep
          it crisp.
        </p>
      )}
      {asset?.source?.attribution !== undefined && asset.source.attribution !== null && (
        <p className="inspector-note">{asset.source.attribution}</p>
      )}
    </div>
  );
}
