/**
 * Canonical bundled caption-font catalog.
 *
 * Every entry maps a user-facing family to the files shipped in both preview
 * and export runtimes. The generator derives the web @font-face sheet and
 * Python manifest from this data so a font choice never depends on what
 * happens to be installed on the editor's machine.
 *
 * LICENSING: every bundled face is SIL Open Font License 1.1 (`OFL-*.txt`) or
 * Apache 2.0 (`Apache-*.txt`), both of which permit redistribution inside the
 * app and use in exported video. The license text ships next to each face.
 * Commercial faces (Gilroy, Proxima Nova, The Bold Font, …) cannot be bundled:
 * their licences do not allow redistributing the file to every user.
 *
 * Weight ranges are read from the font files themselves (the variable `wght`
 * axis, or the OS/2 weight class of each static file), capped to the schema's
 * 100–900. A static family with a `boldFile` draws it at `fontWeight >= 600`
 * in both renderers; a single-file family draws its one face at every weight
 * (the preview disables synthetic bold/italic so it cannot fake a heavier
 * face the export does not have — see `captionPreview.ts#captionLineCss`).
 *
 * Variable families with axes besides `wght` (optical size, width, softness)
 * are drawn at those axes' DEFAULT values in both renderers: Pillow sets only
 * `wght`, and the preview turns off automatic optical sizing to match.
 *
 * SCRIPTS are measured from the files too (`engine/python/framepilot_engine/render/
 * font_coverage.py`, re-checked by `tests/test_caption_font_scripts.py`): a family lists a
 * script only when every file it ships maps that script's whole core alphabet. Neither
 * renderer falls back to another face per glyph in the export — a letter the face lacks is
 * drawn as a missing-glyph box — so this is what the caption tools warn from.
 */
export type CaptionFontCategory = 'sans' | 'display' | 'serif' | 'mono' | 'handwritten';

/**
 * The writing systems the catalog records coverage for, in display order. `latin` is the
 * ASCII letters plus Western European accents; `latin-ext` is Central European, Baltic and
 * Turkish (Latin Extended-A); `cjk` is kana plus common ideographs.
 */
export const CAPTION_FONT_SCRIPTS = [
  'latin',
  'latin-ext',
  'cyrillic',
  'greek',
  'devanagari',
  'bengali',
  'arabic',
  'hebrew',
  'thai',
  'cjk',
] as const;

export type CaptionFontScript = (typeof CAPTION_FONT_SCRIPTS)[number];

export interface CaptionFontFamily {
  readonly family: string;
  readonly category: CaptionFontCategory;
  readonly file: string;
  readonly variable: boolean;
  readonly minWeight: number;
  readonly maxWeight: number;
  readonly boldFile?: string;
  readonly italicFile?: string;
  /** The scripts every file of the family can draw — measured, never guessed (see above). */
  readonly scripts: readonly CaptionFontScript[];
}

export const CAPTION_FONT_CATALOG: readonly CaptionFontFamily[] = [
  {
    family: 'Inter',
    category: 'sans',
    file: 'Inter-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic', 'greek'],
  },
  {
    family: 'Montserrat',
    category: 'sans',
    file: 'Montserrat-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Roboto',
    category: 'sans',
    file: 'Roboto-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic', 'greek'],
  },
  {
    family: 'Open Sans',
    category: 'sans',
    file: 'OpenSans-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 800,
    scripts: ['latin', 'latin-ext', 'cyrillic', 'greek', 'hebrew'],
  },
  {
    family: 'Lato',
    category: 'sans',
    file: 'Lato-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'Lato-Bold.ttf',
    scripts: ['latin', 'latin-ext', 'cyrillic', 'greek'],
  },
  {
    family: 'Raleway',
    category: 'sans',
    file: 'Raleway-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Figtree',
    category: 'sans',
    file: 'Figtree-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Manrope',
    category: 'sans',
    file: 'Manrope-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 800,
    scripts: ['latin', 'latin-ext', 'cyrillic', 'greek'],
  },
  {
    family: 'Poppins',
    category: 'sans',
    file: 'Poppins-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'Poppins-Bold.ttf',
    scripts: ['latin', 'latin-ext', 'devanagari'],
  },
  {
    family: 'Nunito',
    category: 'sans',
    file: 'Nunito-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Plus Jakarta Sans',
    category: 'sans',
    file: 'PlusJakartaSans-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 800,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Outfit',
    category: 'sans',
    file: 'Outfit-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Lexend',
    category: 'sans',
    file: 'Lexend-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Sora',
    category: 'sans',
    file: 'Sora-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 800,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Urbanist',
    category: 'sans',
    file: 'Urbanist-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin'],
  },
  {
    family: 'DM Sans',
    category: 'sans',
    file: 'DMSans-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Space Grotesk',
    category: 'sans',
    file: 'SpaceGrotesk-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 700,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Rubik',
    category: 'sans',
    file: 'Rubik-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic', 'arabic', 'hebrew'],
  },
  {
    family: 'Kanit',
    category: 'sans',
    file: 'Kanit-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 800,
    boldFile: 'Kanit-ExtraBold.ttf',
    scripts: ['latin', 'latin-ext', 'thai'],
  },
  {
    family: 'Barlow',
    category: 'sans',
    file: 'Barlow-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'Barlow-Bold.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'League Spartan',
    category: 'sans',
    file: 'LeagueSpartan-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Geist',
    category: 'sans',
    file: 'Geist-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Bricolage Grotesque',
    category: 'sans',
    file: 'BricolageGrotesque-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 800,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Fredoka',
    category: 'sans',
    file: 'Fredoka-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 700,
    scripts: ['latin', 'hebrew'],
  },
  {
    family: 'Quicksand',
    category: 'sans',
    file: 'Quicksand-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 700,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Josefin Sans',
    category: 'sans',
    file: 'JosefinSans-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 700,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Archivo Black',
    category: 'display',
    file: 'ArchivoBlack-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Oswald',
    category: 'display',
    file: 'Oswald-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 700,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Bebas Neue',
    category: 'display',
    file: 'BebasNeue-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Anton',
    category: 'display',
    file: 'Anton-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Bangers',
    category: 'display',
    file: 'Bangers-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Unbounded',
    category: 'display',
    file: 'Unbounded-Variable.ttf',
    variable: true,
    minWeight: 200,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Syne',
    category: 'display',
    file: 'Syne-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 800,
    scripts: ['latin', 'latin-ext', 'greek'],
  },
  {
    family: 'Exo 2',
    category: 'display',
    file: 'Exo2-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Barlow Condensed',
    category: 'display',
    file: 'BarlowCondensed-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 800,
    boldFile: 'BarlowCondensed-ExtraBold.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Luckiest Guy',
    category: 'display',
    file: 'LuckiestGuy-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Lilita One',
    category: 'display',
    file: 'LilitaOne-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Titan One',
    category: 'display',
    file: 'TitanOne-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Bungee',
    category: 'display',
    file: 'Bungee-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Rubik Mono One',
    category: 'display',
    file: 'RubikMonoOne-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'cyrillic', 'hebrew'],
  },
  {
    family: 'Righteous',
    category: 'display',
    file: 'Righteous-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Staatliches',
    category: 'display',
    file: 'Staatliches-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Teko',
    category: 'display',
    file: 'Teko-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 700,
    scripts: ['latin', 'devanagari'],
  },
  {
    family: 'Big Shoulders',
    category: 'display',
    file: 'BigShoulders-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'League Gothic',
    category: 'display',
    file: 'LeagueGothic-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Alfa Slab One',
    category: 'display',
    file: 'AlfaSlabOne-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Russo One',
    category: 'display',
    file: 'RussoOne-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Orbitron',
    category: 'display',
    file: 'Orbitron-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 900,
    scripts: ['latin'],
  },
  {
    family: 'Passion One',
    category: 'display',
    file: 'PassionOne-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'PassionOne-Bold.ttf',
    scripts: ['latin'],
  },
  {
    family: 'Paytone One',
    category: 'display',
    file: 'PaytoneOne-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Chewy',
    category: 'display',
    file: 'Chewy-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Knewave',
    category: 'display',
    file: 'Knewave-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Shrikhand',
    category: 'display',
    file: 'Shrikhand-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Abril Fatface',
    category: 'display',
    file: 'AbrilFatface-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'DM Serif Display',
    category: 'serif',
    file: 'DMSerifDisplay-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    italicFile: 'DMSerifDisplay-Italic.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Playfair Display',
    category: 'serif',
    file: 'PlayfairDisplay-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 900,
    italicFile: 'PlayfairDisplay-Italic-Variable.ttf',
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Merriweather',
    category: 'serif',
    file: 'Merriweather-Variable.ttf',
    variable: true,
    minWeight: 300,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Fraunces',
    category: 'serif',
    file: 'Fraunces-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    italicFile: 'Fraunces-Italic-Variable.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Instrument Serif',
    category: 'serif',
    file: 'InstrumentSerif-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    italicFile: 'InstrumentSerif-Italic.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Lora',
    category: 'serif',
    file: 'Lora-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 700,
    italicFile: 'Lora-Italic-Variable.ttf',
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Libre Baskerville',
    category: 'serif',
    file: 'LibreBaskerville-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 700,
    italicFile: 'LibreBaskerville-Italic-Variable.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Bodoni Moda',
    category: 'serif',
    file: 'BodoniModa-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 900,
    italicFile: 'BodoniModa-Italic-Variable.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Cinzel',
    category: 'serif',
    file: 'Cinzel-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Prata',
    category: 'serif',
    file: 'Prata-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'cyrillic'],
  },
  {
    family: 'Roboto Slab',
    category: 'serif',
    file: 'RobotoSlab-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    scripts: ['latin', 'latin-ext', 'cyrillic', 'greek'],
  },
  {
    family: 'Young Serif',
    category: 'serif',
    file: 'YoungSerif-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Gloock',
    category: 'serif',
    file: 'Gloock-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Space Mono',
    category: 'mono',
    file: 'SpaceMono-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'SpaceMono-Bold.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'JetBrains Mono',
    category: 'mono',
    file: 'JetBrainsMono-Variable.ttf',
    variable: true,
    minWeight: 100,
    maxWeight: 800,
    scripts: ['latin', 'latin-ext', 'cyrillic', 'greek'],
  },
  {
    family: 'IBM Plex Mono',
    category: 'mono',
    file: 'IBMPlexMono-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'IBMPlexMono-Bold.ttf',
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Courier Prime',
    category: 'mono',
    file: 'CourierPrime-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'CourierPrime-Bold.ttf',
    italicFile: 'CourierPrime-Italic.ttf',
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'VT323',
    category: 'mono',
    file: 'VT323-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Press Start 2P',
    category: 'mono',
    file: 'PressStart2P-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext', 'cyrillic', 'greek'],
  },
  {
    family: 'Silkscreen',
    category: 'mono',
    file: 'Silkscreen-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'Silkscreen-Bold.ttf',
    scripts: ['latin'],
  },
  {
    family: 'Caveat',
    category: 'handwritten',
    file: 'Caveat-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 700,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Pacifico',
    category: 'handwritten',
    file: 'Pacifico-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Shadows Into Light',
    category: 'handwritten',
    file: 'ShadowsIntoLight-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Permanent Marker',
    category: 'handwritten',
    file: 'PermanentMarker-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Dancing Script',
    category: 'handwritten',
    file: 'DancingScript-Variable.ttf',
    variable: true,
    minWeight: 400,
    maxWeight: 700,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Satisfy',
    category: 'handwritten',
    file: 'Satisfy-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Great Vibes',
    category: 'handwritten',
    file: 'GreatVibes-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Sacramento',
    category: 'handwritten',
    file: 'Sacramento-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Yellowtail',
    category: 'handwritten',
    file: 'Yellowtail-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Lobster',
    category: 'handwritten',
    file: 'Lobster-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    family: 'Patrick Hand',
    category: 'handwritten',
    file: 'PatrickHand-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Rock Salt',
    category: 'handwritten',
    file: 'RockSalt-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Gloria Hallelujah',
    category: 'handwritten',
    file: 'GloriaHallelujah-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Homemade Apple',
    category: 'handwritten',
    file: 'HomemadeApple-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Kaushan Script',
    category: 'handwritten',
    file: 'KaushanScript-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Mr Dafoe',
    category: 'handwritten',
    file: 'MrDafoe-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin'],
  },
  {
    family: 'Caveat Brush',
    category: 'handwritten',
    file: 'CaveatBrush-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 400,
    scripts: ['latin', 'latin-ext'],
  },
  {
    family: 'Amatic SC',
    category: 'handwritten',
    file: 'AmaticSC-Regular.ttf',
    variable: false,
    minWeight: 400,
    maxWeight: 700,
    boldFile: 'AmaticSC-Bold.ttf',
    scripts: ['latin', 'latin-ext', 'cyrillic', 'hebrew'],
  },
] as const;

export const DEFAULT_CAPTION_FONT_FAMILY = 'Inter';

export function getCaptionFont(family: string): CaptionFontFamily | undefined {
  return CAPTION_FONT_CATALOG.find((font) => font.family === family);
}

/**
 * The script of one character, in the catalog's vocabulary, or `undefined` for anything the
 * catalog does not track (digits, punctuation, emoji, scripts no bundled face is measured
 * for). Only letters and combining marks count: the danda and the Arabic comma are shared
 * punctuation, and a combining accent belongs to whatever letter it sits on.
 */
function scriptOfChar(char: string): CaptionFontScript | undefined {
  if (!/[\p{L}\p{M}]/u.test(char)) return undefined;
  if (/\p{Script=Latin}/u.test(char)) {
    // `codePointAt` is defined: `char` is one code point from a for-of over a string.
    return char.codePointAt(0)! <= 0xff ? 'latin' : 'latin-ext';
  }
  if (/\p{Script=Cyrillic}/u.test(char)) return 'cyrillic';
  if (/\p{Script=Greek}/u.test(char)) return 'greek';
  if (/\p{Script=Devanagari}/u.test(char)) return 'devanagari';
  if (/\p{Script=Bengali}/u.test(char)) return 'bengali';
  if (/\p{Script=Arabic}/u.test(char)) return 'arabic';
  if (/\p{Script=Hebrew}/u.test(char)) return 'hebrew';
  if (/\p{Script=Thai}/u.test(char)) return 'thai';
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) return 'cjk';
  return undefined;
}

/**
 * The catalog scripts `text` is written in, in {@link CAPTION_FONT_SCRIPTS} order.
 *
 * @param text - Any caption or title text.
 */
export function captionScriptsIn(text: string): readonly CaptionFontScript[] {
  const found = new Set<CaptionFontScript>();
  for (const char of text.normalize('NFC')) {
    const script = scriptOfChar(char);
    if (script !== undefined) found.add(script);
  }
  return CAPTION_FONT_SCRIPTS.filter((script) => found.has(script));
}

/** The bundled families that can draw `script`, in catalog order. */
export function captionFontsWithScript(script: CaptionFontScript): readonly string[] {
  return CAPTION_FONT_CATALOG.filter((font) => font.scripts.includes(script)).map(
    (font) => font.family,
  );
}
