/**
 * Canonical bundled caption-font catalog.
 *
 * Every entry maps a user-facing family to the OFL-licensed files shipped in
 * both preview and export runtimes. The generator derives the web @font-face
 * sheet and Python manifest from this data so a font choice never depends on
 * what happens to be installed on the editor's machine.
 */
export type CaptionFontCategory = 'sans' | 'display' | 'serif' | 'mono' | 'handwritten';

export interface CaptionFontFamily {
  readonly family: string;
  readonly category: CaptionFontCategory;
  readonly file: string;
  readonly variable: boolean;
  readonly minWeight: number;
  readonly maxWeight: number;
  readonly boldFile?: string;
  readonly italicFile?: string;
}

export const CAPTION_FONT_CATALOG: readonly CaptionFontFamily[] = [
  {
    family: 'Inter',
    category: 'sans',
    file: 'Inter-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
  },
  {
    family: 'Montserrat',
    category: 'sans',
    file: 'Montserrat-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
  },
  {
    family: 'Roboto',
    category: 'sans',
    file: 'Roboto-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
  },
  {
    family: 'Open Sans',
    category: 'sans',
    file: 'OpenSans-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 800,
  },
  {
    family: 'Lato',
    category: 'sans',
    file: 'Lato-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'Lato-Bold.ttf',
  },
  {
    family: 'Raleway',
    category: 'sans',
    file: 'Raleway-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
  },
  {
    family: 'Figtree',
    category: 'sans',
    file: 'Figtree-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 900,
  },
  {
    family: 'Manrope',
    category: 'sans',
    file: 'Manrope-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 800,
  },
  {
    family: 'Poppins',
    category: 'sans',
    file: 'Poppins-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'Poppins-Bold.ttf',
  },
  {
    family: 'Nunito',
    category: 'sans',
    file: 'Nunito-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 900,
  },
  {
    family: 'Archivo Black',
    category: 'display',
    file: 'ArchivoBlack-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 900,
  },
  {
    family: 'Oswald',
    category: 'display',
    file: 'Oswald-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 700,
  },
  {
    family: 'Bebas Neue',
    category: 'display',
    file: 'BebasNeue-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
  },
  {
    family: 'Anton',
    category: 'display',
    file: 'Anton-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 900,
  },
  {
    family: 'Bangers',
    category: 'display',
    file: 'Bangers-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
  },
  {
    family: 'DM Serif Display',
    category: 'serif',
    file: 'DMSerifDisplay-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    italicFile: 'DMSerifDisplay-Italic.ttf',
  },
  {
    family: 'Playfair Display',
    category: 'serif',
    file: 'PlayfairDisplay-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 900,
  },
  {
    family: 'Merriweather',
    category: 'serif',
    file: 'Merriweather-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 900,
  },
  {
    family: 'Space Mono',
    category: 'mono',
    file: 'SpaceMono-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'SpaceMono-Bold.ttf',
  },
  {
    family: 'Caveat',
    category: 'handwritten',
    file: 'Caveat-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 700,
  },
  {
    family: 'Pacifico',
    category: 'handwritten',
    file: 'Pacifico-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
  },
  {
    family: 'Shadows Into Light',
    category: 'handwritten',
    file: 'ShadowsIntoLight-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
  },
] as const;

export const DEFAULT_CAPTION_FONT_FAMILY = 'Inter';

export function getCaptionFont(family: string): CaptionFontFamily | undefined {
  return CAPTION_FONT_CATALOG.find((font) => font.family === family);
}
