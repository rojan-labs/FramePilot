/**
 * The Inspector's Sticker section (plan/elements EL6a.5, 02 §4.1): which sticker this is, where it
 * comes from, and **Replace…**, which opens Elements → Stickers to swap it for another while its
 * timing, position, size and animation stay. Position & size is the ordinary Transform section.
 */
import type { Asset, Clip } from '@framepilot/timeline-schema';
import { STICKERS_BASE } from '../../elements/StickersBrowser.js';

/** A sticker's name from its catalogue id (`thumbs_up` -> `Thumbs up`). */
export function stickerName(asset: Asset | undefined): string {
  const id = asset?.source?.remoteId ?? '';
  const words = id.replace(/_/g, ' ').trim();
  return words === '' ? 'Sticker' : words.charAt(0).toUpperCase() + words.slice(1);
}

export function StickerInspector({
  clip,
  asset,
  onReplace,
}: {
  readonly clip: Clip;
  readonly asset: Asset | undefined;
  /** Open the Stickers sub-tab to replace this sticker; absent where there is no panel. */
  readonly onReplace?: (clipId: string, name: string) => void;
}): JSX.Element {
  const name = stickerName(asset);
  const itemId = asset?.source?.remoteId;
  return (
    <div className="inspector-subpanel sticker-section" aria-label="sticker">
      <div className="sticker-section-row">
        {itemId !== undefined && (
          <img
            className="sticker-section-thumb"
            src={`${STICKERS_BASE}thumbs/${itemId}.webp`}
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
      {asset?.source?.attribution !== undefined && asset.source.attribution !== null && (
        <p className="inspector-note">{asset.source.attribution}</p>
      )}
    </div>
  );
}
