/**
 * @framepilot/ai-sdk/title-face-lines — a bundled face's vertical line metrics, for hosts that
 * lay text out the way the engine does.
 *
 * The caption rasterizer stacks a text's rows by the face's own ascent and descent
 * (`captions.py#_layout_styled_caption`), not by a CSS line height. The web editor's preview of
 * a text overlay LOCKUP needs the same numbers to stack its lines where the export stacks them;
 * they are generated from the bundled fonts by the engine (`title-metrics.generated.ts`).
 */
import { TITLE_FACE_LINES, TITLE_ITALIC_FACE_LINES } from './title-metrics.generated.js';

/**
 * `[ascent, descent]` in 1/1000 em of a bundled family (its italic face when `italic` and the
 * family ships one), or of Pillow's default face for a family that is not bundled.
 */
export function titleFaceLines(family: string, italic = false): readonly [number, number] {
  const known = italic ? TITLE_ITALIC_FACE_LINES[family] : undefined;
  const [ascent, descent] = known ?? TITLE_FACE_LINES[family] ?? TITLE_FACE_LINES['']!;
  return [ascent, descent];
}
