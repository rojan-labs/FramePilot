/**
 * @framepilot/ai-sdk/text-overlay-style-facts — a text overlay style, said in one short line.
 *
 * The model picks a style by id (`add_text_layer`'s `style`), and an id alone ("sticker",
 * "chrome", "handwritten") does not say what lands on screen. Sending every look whole would
 * spend ~59 JSON objects of outline widths and shadow offsets on a choice that needs a font,
 * a colour, a size, a place and how the letters separate from the picture. This derives that
 * line FROM the catalog data, so a style added or revised in `text-overlay-styles.ts` is
 * described correctly without anyone writing prose for it.
 */
import type {
  TextOverlayLine,
  TextOverlayLook,
} from '@framepilot/timeline-schema/text-overlay-styles';

/** A box centre above this share of the frame height reads as "top". */
const TOP_BAND_MAX_PERCENT = 34;
/** A box centre below this share of the frame height reads as "bottom". */
const BOTTOM_BAND_MIN_PERCENT = 66;
/** Tracking (em per glyph) from which letters read as deliberately spaced out. */
const WIDE_TRACKING_EM = 0.05;
/** A shadow this blurred with no offset is a glow around the letters, not a drop. */
const GLOW_MIN_BLUR_EM = 0.4;

function placement(look: TextOverlayLook): string {
  const band =
    look.yPercent < TOP_BAND_MAX_PERCENT
      ? 'top'
      : look.yPercent > BOTTOM_BAND_MIN_PERCENT
        ? 'bottom'
        : 'middle';
  return look.align === 'center' ? band : `${band}-${look.align}`;
}

/** How the letters separate from the footage beneath: chip, outline, glow or drop shadow. */
function separation(look: TextOverlayLook): string[] {
  const { typography } = look;
  const parts: string[] = [];
  if (look.background !== null) {
    const frosted = (typography.background?.blur ?? 0) > 0;
    parts.push(`${look.background} ${frosted ? 'frosted-glass chip' : 'chip'}`);
  }
  if ((typography.outlineWidth ?? 0) > 0 && typography.outlineColor !== undefined) {
    parts.push(`${typography.outlineColor} outline`);
  }
  const shadow = typography.shadow;
  if (shadow !== undefined) {
    const still = shadow.offsetX === 0 && shadow.offsetY === 0;
    parts.push(still && shadow.blur >= GLOW_MIN_BLUR_EM ? `${shadow.color} glow` : 'shadow');
  }
  return parts;
}

/** Case, slant, tracking and see-through letters: the type treatments worth naming. */
function treatment(look: TextOverlayLook): string[] {
  const { typography } = look;
  return [
    ...(typography.fontStyle === 'italic' ? ['italic'] : []),
    ...(typography.textTransform === 'uppercase' ? ['caps'] : []),
    ...(typography.textTransform === 'lowercase' ? ['lowercase'] : []),
    ...((typography.letterSpacing ?? 0) >= WIDE_TRACKING_EM ? ['wide tracking'] : []),
    ...((typography.textOpacity ?? 1) < 1 ? ['see-through letters'] : []),
  ];
}

/**
 * One line naming what a style puts on screen, e.g.
 * `Inter 800 #ffffff, 8% high, middle, shadow`.
 *
 * @param look - A catalog style's look.
 * @returns Font and weight, letter colour, size (percent of frame height), where it sits,
 *   and how the letters stand off the picture.
 */
export function describeTextOverlayLook(look: TextOverlayLook): string {
  const whole = [
    [`${look.fontFamily} ${String(look.fontWeight)}`, ...treatment(look), look.color].join(' '),
    `${String(look.fontSizePercent)}% high`,
    placement(look),
    ...separation(look),
  ].join(', ');
  const lines = look.typography.lines ?? [];
  if (lines.length === 0) return whole;
  // A lockup draws each line of the text in its own face, so the model must write one line
  // per part, in this order, or the parts land in the wrong faces.
  const parts = lines.map((line, index) => `${String(index + 1)}) ${describeLine(look, line)}`);
  return `${whole}; LOCKUP, write ${String(lines.length)} lines joined by \\n: ${parts.join('; ')}`;
}

/** One lockup line in a few words: its face and treatment, relative to the style's own look. */
function describeLine(look: TextOverlayLook, line: TextOverlayLine): string {
  const overrides = Object.keys(line).filter((key) => key !== 'spaceBefore');
  if (overrides.length === 0) return 'the headline, in the look above';
  const lineLook: TextOverlayLook = {
    ...look,
    fontFamily: line.fontFamily ?? look.fontFamily,
    fontWeight: line.fontWeight ?? look.fontWeight,
    color: line.color ?? look.color,
    typography: {
      ...look.typography,
      ...(line.fontStyle === undefined ? {} : { fontStyle: line.fontStyle }),
      ...(line.textTransform === undefined ? {} : { textTransform: line.textTransform }),
      ...(line.letterSpacing === undefined ? {} : { letterSpacing: line.letterSpacing }),
    },
  };
  const chip =
    line.background === undefined
      ? []
      : line.background === null
        ? []
        : [`${line.background} chip`];
  return [
    `${lineLook.fontFamily} ${String(lineLook.fontWeight)}`,
    ...treatment(lineLook),
    lineLook.color,
    `${String(Math.round((line.scale ?? 1) * 100))}% of the headline`,
    ...chip,
  ].join(' ');
}
