/**
 * The families a title can be drawn in, and the weights it can take.
 *
 * One list for every tool that sets a title's face. It lived inside `masking.ts`, where only
 * `put_text_behind_subject` could use it, while `add_text_layer` had no font argument at all
 * — although the export and the desktop preview both draw a text overlay's `fontFamily` from
 * this very catalogue (`render/text_overlay.py#_load_font`). Run `6cb12e30` was briefed for
 * Playfair Display, Inter and Caveat, all three in the catalogue, and set every title in the
 * default face, faking tracking with spaces ("W E E K E N D   T R I P") and telling the
 * editor the default face was the only one available.
 */
import { z } from 'zod/v4';
import { CAPTION_FONT_CATALOG } from '@framepilot/timeline-schema/caption-fonts';
import { numeric } from './tool-args.js';

/** The bundled families a title can be drawn in — the caption font catalog, `render/fonts`. */
export const TITLE_FONT_FAMILIES = CAPTION_FONT_CATALOG.map((font) => font.family) as [
  string,
  ...string[],
];

/** A title's family, as a tool argument. */
export const titleFontFamily = z.enum(TITLE_FONT_FAMILIES);

/** A title's weight, as a tool argument: the CSS scale the catalogue's files are keyed by. */
export const titleFontWeight = numeric(z.number().int().min(100).max(900));
