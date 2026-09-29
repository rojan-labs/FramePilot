/**
 * Text overlay params from harness run 16's final project (1080x1920), verbatim: the pairs the
 * text-collision check (AL41) is judged on.
 */

/** The run's shared title look: an outline and a soft shadow, no chip colour. */
const OUTLINED = {
  outlineColor: '#000000',
  outlineWidth: 1.3333333333333333,
  background: { radius: 0, paddingX: 0.16666666666666666, paddingY: 0.16666666666666666 },
  shadow: { color: '#00000059', blur: 0.4, offsetX: 0, offsetY: 0.03 },
} as const;

/** "Until next weekend." — two italic lines, on screen 56.67–59.97 s. */
export const UNTIL_NEXT_WEEKEND = {
  text: 'Until next weekend.',
  fontFamily: 'Playfair Display',
  color: '#F5EFE6',
  fontSizePercent: 5.5,
  xPercent: 50,
  yPercent: 42,
  typography: { ...OUTLINED, fontStyle: 'italic' },
} as const;

/** "SEPT 2026" — tracked caps, on screen 57.13–59.97 s, drawn across the line above. */
export const SEPT_2026 = {
  text: 'SEPT 2026',
  fontFamily: 'Manrope',
  fontWeight: 600,
  color: '#F2A03D',
  fontSizePercent: 1.6,
  xPercent: 50,
  yPercent: 48,
  typography: { ...OUTLINED, letterSpacing: 0.25 },
} as const;

/** "Weekend" — the opening title, 0.47–3.3 s. */
export const WEEKEND = {
  text: 'Weekend',
  fontFamily: 'Playfair Display',
  color: '#F5EFE6',
  fontSizePercent: 8,
  xPercent: 50,
  yPercent: 40,
  typography: { ...OUTLINED, letterSpacing: -0.01, fontStyle: 'italic' },
} as const;

/** "TRIP" — the subtitle tucked under "Weekend", 0.93–3.3 s, clear of it on screen. */
export const TRIP = {
  text: 'TRIP',
  fontFamily: 'Manrope',
  fontWeight: 600,
  color: '#F2A03D',
  fontSizePercent: 2.2,
  xPercent: 50,
  yPercent: 46,
  typography: { ...OUTLINED, letterSpacing: 0.5 },
} as const;

/** A glass-pill caption line: a filled, bordered chip in a 86 % box, left-aligned. */
export const GLASS_PILL = {
  text: 'Somewhere between here and home.',
  fontFamily: 'Inter',
  fontWeight: 600,
  color: '#F5EFE6',
  fontSizePercent: 2.7,
  align: 'left',
  boxWidthPercent: 86,
  xPercent: 47,
  yPercent: 77,
  background: '#14141473',
  typography: {
    shadow: { color: '#000000b3', blur: 0.2, offsetX: 0, offsetY: 0.06 },
    background: {
      radius: 0.6,
      paddingX: 0.7,
      paddingY: 0.3,
      blur: 0.35,
      borderColor: '#ffffff73',
      borderWidth: 1,
    },
    textTransform: 'none',
  },
} as const;
