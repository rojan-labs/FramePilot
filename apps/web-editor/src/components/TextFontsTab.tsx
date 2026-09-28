/**
 * The Text panel's Fonts tab: every font captions have, for text overlays too.
 *
 * The list is the bundled caption families (`caption-fonts.ts`), each drawn in its own face, so
 * whatever a caption can be set in, a text overlay can be set in. With a text overlay selected, a click sets
 * that text overlay's font (keeping it to a weight and style the family ships, `textOverlayFontParams`);
 * with none selected, a click adds a heading in that font at the playhead. CapCut and Canva
 * behave the same way.
 *
 * Rows render lazily (`content-visibility`), so a font's file is only fetched when its row
 * scrolls into view.
 */
import { memo, useMemo, useState } from 'react';
import {
  CAPTION_FONT_CATALOG,
  type CaptionFontCategory,
  type CaptionFontFamily,
} from '@framepilot/timeline-schema/caption-fonts';
import { useViewPreference } from '../editor/useViewPreference.js';
import { fontHasItalic, fontWeightsFor } from '../editor/textOverlayFonts.js';
import { useTileGrid } from './elements/useTileGrid.js';
import { FONT_CATEGORIES } from './FontFamilySelect.js';
import { Check, ICON_SIZE } from './icons.js';

type FontChip = 'all' | CaptionFontCategory;

const FONT_CHIPS: readonly { readonly id: FontChip; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  ...FONT_CATEGORIES,
];

const CATEGORY_LABEL: ReadonlyMap<string, string> = new Map(
  FONT_CATEGORIES.map((category) => [category.id, category.label]),
);
/** Category order, so "All" lists sans first and scripts last, as the Inspector's picker does. */
const CATEGORY_ORDER: ReadonlyMap<string, number> = new Map(
  FONT_CATEGORIES.map((category, index) => [category.id, index]),
);
const ORDERED_FONTS: readonly CaptionFontFamily[] = [...CAPTION_FONT_CATALOG].sort(
  (a, b) => (CATEGORY_ORDER.get(a.category) ?? 0) - (CATEGORY_ORDER.get(b.category) ?? 0),
);

const coerceFontChip = (raw: unknown): FontChip | undefined =>
  FONT_CHIPS.some((chip) => chip.id === raw) ? (raw as FontChip) : undefined;

/** "100–900 · Italic": what the family can be asked for. */
function fontFacts(family: string): string {
  const weights = fontWeightsFor(family);
  const range =
    weights.length === 1
      ? 'One weight'
      : `${String(weights[0])}–${String(weights[weights.length - 1])}`;
  return fontHasItalic(family) ? `${range} · Italic` : range;
}

export interface TextFontsTabProps {
  /** The selected text overlay's family, when a text overlay is selected. */
  readonly currentFamily: string | undefined;
  /** Set the selected text overlay's font, or add a heading in it when none is selected. */
  readonly onPick: (family: string) => void;
}

export function TextFontsTab({ currentFamily, onPick }: TextFontsTabProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [chip, setChip] = useViewPreference<FontChip>('textFontCategory', 'all', coerceFontChip);
  const trimmed = query.trim().toLowerCase();
  const fonts = useMemo(
    () =>
      ORDERED_FONTS.filter(
        (font) =>
          (trimmed !== '' || chip === 'all' || font.category === chip) &&
          (trimmed === '' ||
            `${font.family} ${CATEGORY_LABEL.get(font.category) ?? ''}`
              .toLowerCase()
              .includes(trimmed)),
      ),
    [trimmed, chip],
  );
  const { gridRef, focusIndex, setActive, onGridKey } = useTileGrid(fonts.length, '.text-font-row');
  const selecting = currentFamily !== undefined;

  return (
    <div className="text-panel-tab">
      <input
        type="search"
        className="elements-search"
        data-ui="input"
        data-size="sm"
        aria-label="Search fonts"
        placeholder={`Search ${String(CAPTION_FONT_CATALOG.length)} fonts`}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation();
            setQuery('');
          }
        }}
      />
      {trimmed === '' && (
        <div className="shapes-chips" role="group" aria-label="Font categories">
          {FONT_CHIPS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="shapes-chip"
              aria-pressed={chip === id}
              onClick={() => {
                setChip(id);
                setActive(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <p className="text-panel-hint">
        {selecting
          ? 'Click a font to use it for the selected text overlay.'
          : 'The same fonts as captions. Click one to add a heading in it.'}
      </p>
      <div className="text-panel-scroll">
        {fonts.length === 0 ? (
          <p className="stock-note">Nothing matched “{query.trim()}”. Try “serif” or “mono”.</p>
        ) : (
          <ul ref={gridRef} className="text-font-list" aria-label="Fonts" onKeyDown={onGridKey}>
            {fonts.map((font, index) => (
              <FontRow
                key={font.family}
                family={font.family}
                index={index}
                tabbable={index === focusIndex}
                current={font.family === currentFamily}
                selecting={selecting}
                onFocus={setActive}
                onPick={onPick}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const FontRow = memo(function FontRow({
  family,
  index,
  tabbable,
  current,
  selecting,
  onFocus,
  onPick,
}: {
  readonly family: string;
  readonly index: number;
  readonly tabbable: boolean;
  readonly current: boolean;
  readonly selecting: boolean;
  readonly onFocus: (index: number) => void;
  readonly onPick: (family: string) => void;
}): JSX.Element {
  return (
    <li className="text-font-item">
      <button
        type="button"
        className={`text-font-row${current ? ' is-current' : ''}`}
        tabIndex={tabbable ? 0 : -1}
        aria-pressed={selecting ? current : undefined}
        aria-label={
          selecting ? `Use ${family} for the selected text overlay` : `Add a heading in ${family}`
        }
        onFocus={() => onFocus(index)}
        onClick={() => onPick(family)}
      >
        <span
          className="text-font-name"
          style={{ fontFamily: `'${family}', var(--font-sans, sans-serif)` }}
        >
          {family}
        </span>
        <span className="text-font-facts">{fontFacts(family)}</span>
        {current && <Check className="text-font-check" size={ICON_SIZE.sm} aria-hidden="true" />}
      </button>
    </li>
  );
});
