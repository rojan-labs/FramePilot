/**
 * The one font list for everything that sets type: caption cues, the caption track and titles.
 *
 * Every bundled family (`caption-fonts.ts`), grouped by category and drawn in its own face, so
 * the list is a specimen. Only bundled families are offered because they are the only ones both
 * renderers draw: a system font the editor's machine happens to have would change face in the
 * export, and again on another machine.
 *
 * A stored family that is not bundled (a title from before titles took the caption fonts, say
 * "Georgia") is still shown, marked, so the control never pretends it is something else; picking
 * any family from the list replaces it.
 */
import {
  CAPTION_FONT_CATALOG,
  getCaptionFont,
  type CaptionFontCategory,
} from '@framepilot/timeline-schema/caption-fonts';
import { Select, type SelectOption } from './Select.js';

/** The font categories, in the order every font list shows them. */
export const FONT_CATEGORIES: readonly { id: CaptionFontCategory; label: string }[] = [
  { id: 'sans', label: 'Sans serif' },
  { id: 'display', label: 'Display' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Monospace' },
  { id: 'handwritten', label: 'Handwritten & script' },
];

const specimen = (family: string) => ({
  fontFamily: `'${family}', var(--font-sans, sans-serif)`,
});

/** Every bundled family, in category order. Built once: the catalog is static. */
const FONT_OPTIONS: readonly SelectOption[] = FONT_CATEGORIES.flatMap((category) =>
  CAPTION_FONT_CATALOG.filter((font) => font.category === category.id).map((font) => ({
    value: font.family,
    label: font.family,
    hint: category.label,
    labelStyle: specimen(font.family),
  })),
);

export interface FontFamilySelectProps {
  readonly value: string;
  readonly onChange: (family: string) => void;
  /** Accessible name of the trigger. */
  readonly label: string;
  readonly id?: string;
  readonly disabled?: boolean;
}

export function FontFamilySelect({
  value,
  onChange,
  label,
  id,
  disabled = false,
}: FontFamilySelectProps): JSX.Element {
  const options =
    getCaptionFont(value) !== undefined
      ? FONT_OPTIONS
      : [
          { value, label: `${value} (not bundled)`, hint: 'Current', labelStyle: specimen(value) },
          ...FONT_OPTIONS,
        ];
  return (
    <Select
      {...(id === undefined ? {} : { id })}
      label={label}
      value={value}
      disabled={disabled}
      options={options}
      onChange={onChange}
    />
  );
}
