/**
 * Searchable, grouped keyboard-shortcut list (plan 3.4 Part 3 / Part 6).
 *
 * Generated entirely from the {@link SHORTCUTS} registry so it can never drift
 * from the keys the handler actually honours. Used both by the `?` help overlay
 * ({@link ShortcutHelp}) and the Settings dialog's Keyboard section, so there is
 * one rendering of the cheat-sheet in the app.
 */
import { useMemo, useState } from 'react';
import {
  type Shortcut,
  type ShortcutGroup,
  SHORTCUTS,
  formatChord,
  isMacPlatform,
} from '../editor/shortcuts.js';
import { ICON_SIZE, Search } from './icons.js';

/** Display order of the registry groups. */
const GROUP_ORDER: readonly ShortcutGroup[] = [
  'Transport',
  'Editing',
  'Selection',
  'Markers',
  'View',
  'History',
  'AI',
  'Help',
];

/** Does a shortcut match the search query (over label, group, and key glyphs)? */
function matches(shortcut: Shortcut, query: string, isMac: boolean): boolean {
  if (query === '') return true;
  const haystack = [
    shortcut.label,
    shortcut.group,
    ...shortcut.keys.map((chord) => formatChord(chord, isMac)),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export interface ShortcutListProps {
  /** Optional ref to focus the search field (the overlay autofocuses it). */
  readonly searchRef?: React.RefObject<HTMLInputElement>;
}

export function ShortcutList({ searchRef }: ShortcutListProps): JSX.Element {
  const [query, setQuery] = useState('');
  const isMac = useMemo(() => isMacPlatform(), []);

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      items: SHORTCUTS.filter((s) => s.group === group && matches(s, query, isMac)),
    })).filter((section) => section.items.length > 0);
  }, [query, isMac]);

  return (
    <>
      <div className="shortcut-search">
        <Search size={ICON_SIZE.sm} aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          placeholder="Search shortcuts…"
          aria-label="Search shortcuts"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="shortcut-groups">
        {grouped.length === 0 && <p className="panel-empty">No shortcuts match “{query}”.</p>}
        {grouped.map(({ group, items }) => (
          <section key={group} className="shortcut-group" aria-label={group}>
            <h3>{group}</h3>
            <ul>
              {items.map((shortcut) => (
                <li key={shortcut.id}>
                  <span className="shortcut-label">{shortcut.label}</span>
                  <span className="shortcut-keys">
                    {shortcut.keys.map((chord) => (
                      <kbd key={chord} className="tabular">
                        {formatChord(chord, isMac)}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
