/**
 * A colour's spoken name, for the Shapes colour row: a swatch read as "Colour #FFD400" tells a
 * listener nothing. The palette's own colours have their own words; any other (one picked with
 * the colour picker) is named by its hue and how light it is — "Dark blue", "Light pink".
 */

/** The row's default palette, in the words a person uses for them. */
const PALETTE_NAMES: Readonly<Record<string, string>> = {
  '#FFD400': 'Yellow',
  '#FF3B30': 'Red',
  '#FFFFFF': 'White',
  '#0A84FF': 'Blue',
  '#34C759': 'Green',
  '#111111': 'Black',
};

/** Hue bands (degrees, upper bound exclusive) and their names; red wraps round at 360. */
const HUE_NAMES: readonly (readonly [number, string])[] = [
  [15, 'red'],
  [45, 'orange'],
  [70, 'yellow'],
  [160, 'green'],
  [200, 'teal'],
  [255, 'blue'],
  [290, 'purple'],
  [335, 'pink'],
  [360, 'red'],
];

/** Below this lightness a colour reads as black, above the other as white. */
const BLACK_BELOW = 0.12;
const WHITE_ABOVE = 0.92;
/** Below this saturation a colour reads as a grey. */
const GREY_BELOW = 0.15;
/** Lightness bands that earn "Dark" and "Light". */
const DARK_BELOW = 0.35;
const LIGHT_ABOVE = 0.7;

const HEX = /^#([0-9a-f]{6})$/i;

const capitalise = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * @param hex - A `#rrggbb` colour.
 * @returns Its name ("Yellow", "Dark blue", "Light grey"), or "Colour" for anything unreadable.
 */
export function colourName(hex: string): string {
  const match = HEX.exec(hex);
  if (match === null) return 'Colour';
  const upper = `#${match[1]!.toUpperCase()}`;
  const known = PALETTE_NAMES[upper];
  if (known !== undefined) return known;

  const value = Number.parseInt(match[1]!, 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => c / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (lightness < BLACK_BELOW) return 'Black';
  if (lightness > WHITE_ABOVE) return 'White';
  const chroma = max - min;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  const shade = lightness < DARK_BELOW ? 'dark ' : lightness > LIGHT_ABOVE ? 'light ' : '';
  if (saturation < GREY_BELOW) return capitalise(`${shade}grey`);

  const hue =
    max === r
      ? (((g - b) / chroma) % 6) * 60
      : max === g
        ? ((b - r) / chroma + 2) * 60
        : ((r - g) / chroma + 4) * 60;
  const degrees = (hue + 360) % 360;
  const name = HUE_NAMES.find(([upperBound]) => degrees < upperBound)?.[1] ?? 'red';
  return capitalise(`${shade}${name}`);
}
