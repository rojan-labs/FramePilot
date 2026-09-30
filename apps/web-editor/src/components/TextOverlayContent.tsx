/**
 * The words inside a text overlay's box: its text as one block, or a LOCKUP's lines, each in its
 * own face, size, colour and chip (`typography.lines`, `textOverlayLineBlocks`).
 *
 * Every surface that draws a text overlay's words in the DOM renders them through this, so a
 * lockup looks the same on the browser monitor, in the on-canvas editor, on the Text panel's
 * tiles and as the desktop monitor's hit target (which paints nothing over the engine's raster).
 */
import type { TextOverlayParams } from '../editor/patch-builders.js';
import { TEXT_HIT_TARGET_STYLE, textOverlayLineBlocks } from '../editor/textOverlay.js';

export interface TextOverlayContentProps {
  readonly params: TextOverlayParams;
  /** The words to draw, when they are not `params.text` (a stored clip with no text param). */
  readonly text?: string;
  /** Paint nothing: the box only covers the letters the engine's raster drew beneath it. */
  readonly hitTarget?: boolean;
}

export function TextOverlayContent({
  params,
  text = params.text,
  hitTarget = false,
}: TextOverlayContentProps): JSX.Element {
  const blocks = textOverlayLineBlocks(text === params.text ? params : { ...params, text });
  if (blocks === null) return <>{text}</>;
  return (
    <>
      {blocks.map((block) => (
        <span
          key={block.index}
          className="text-overlay-line"
          style={hitTarget ? { ...block.css, ...TEXT_HIT_TARGET_STYLE } : block.css}
        >
          {block.text}
        </span>
      ))}
    </>
  );
}
