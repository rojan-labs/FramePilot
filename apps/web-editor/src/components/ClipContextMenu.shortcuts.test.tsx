/**
 * P8.3's done-when: "a shortcut list test asserts every menu item's shortcut works".
 *
 * The clip menu printed no shortcuts at all, so a right-click taught the user
 * nothing about the keyboard. Now that each row advertises a chord from the
 * registry, the claim has to be true: for every row that declares one, pressing
 * the chord must leave the timeline in exactly the state clicking the row does.
 * A drift guard walks the rendered menu, so a row that starts advertising a chord
 * without being covered here fails.
 */
import { describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { SHORTCUTS, eventToChord, formatChord, isMacPlatform } from '../editor/shortcuts.js';
import { useEditor, type UseEditor } from '../editor/useEditor.js';
import { useEditorShortcuts } from '../editor/useShortcuts.js';
import { TimelineView } from './TimelineView.js';

/**
 * Two clips with a gap between them: the gap is what makes a duplicate land at
 * all (butt-joined, it is refused for overlap and the test would pass on two
 * unchanged timelines), and the second clip is what makes a ripple delete
 * distinguishable from a lift.
 */
const fixture: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
        {
          id: 'c2',
          assetId: 'a',
          trackId: 'v',
          start: 10,
          end: 14,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

interface Row {
  /** Visible row text in the menu. */
  readonly name: string;
  readonly shortcutId: string;
  /** The keystroke a user would actually press for that chord. */
  readonly event: Partial<KeyboardEvent> & { key: string };
}

const ROWS: readonly Row[] = [
  { name: 'Split at playhead', shortcutId: 'edit.split', event: { key: 's' } },
  { name: 'Trim start to playhead', shortcutId: 'edit.trimIn', event: { key: '[' } },
  { name: 'Trim end to playhead', shortcutId: 'edit.trimOut', event: { key: ']' } },
  { name: 'Duplicate', shortcutId: 'edit.duplicate', event: { key: 'd', metaKey: true } },
  { name: 'Delete', shortcutId: 'edit.delete', event: { key: 'Delete' } },
  { name: 'Ripple delete', shortcutId: 'edit.ripple', event: { key: 'Delete', shiftKey: true } },
];

let ed: UseEditor;

function Host(): JSX.Element {
  const editor = useEditor(fixture, ['a']);
  useEditorShortcuts(editor, 30, {});
  ed = editor;
  return <TimelineView editor={editor} assets={[]} fps={30} />;
}

/** Mount, park the playhead inside c1 and select it — the state both paths start from. */
function mount(): void {
  render(<Host />);
  act(() => {
    ed.seek(1);
    ed.select('c1');
  });
}

const openMenu = (): void => {
  fireEvent.contextMenu(screen.getByLabelText('clip c1'), { clientX: 10, clientY: 10 });
};

describe('clip context menu shortcuts', () => {
  it('advertises each chord from the registry, not from hard-coded glyphs', () => {
    mount();
    openMenu();
    const isMac = isMacPlatform();
    for (const row of ROWS) {
      const chord = SHORTCUTS.find((s) => s.id === row.shortcutId)?.keys[0];
      expect(chord, row.shortcutId).toBeDefined();
      const item = screen.getByRole('menuitem', { name: new RegExp(row.name) });
      expect(item.querySelector('kbd')?.textContent).toBe(formatChord(chord!, isMac));
    }
  });

  it('advertises a chord on no row this test does not cover', () => {
    mount();
    openMenu();
    const advertised = [...screen.getByRole('menu', { name: 'clip actions' }).children]
      .filter((node) => node.querySelector('kbd') !== null)
      .map((node) => node.textContent?.trim() ?? '');
    // Each row's text is "<label><chord>"; matching on the label prefix is enough.
    for (const text of advertised) {
      expect(ROWS.some((row) => text.startsWith(row.name)), text).toBe(true);
    }
    expect(advertised).toHaveLength(ROWS.length);
  });

  for (const row of ROWS) {
    it(`"${row.name}" produces the same edit as its chord`, () => {
      // The chord the test presses must be the chord the row advertises — otherwise
      // this proves two unrelated actions agree.
      const chord = SHORTCUTS.find((s) => s.id === row.shortcutId)?.keys[0];
      expect(eventToChord(row.event as KeyboardEvent)).toBe(chord);

      mount();
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(row.name) }));
      const clicked = JSON.stringify(ed.state.timeline);
      // Neither path may pass by doing nothing.
      expect(clicked).not.toBe(JSON.stringify(fixture));

      // Second mount, same starting state, the keyboard this time.
      cleanup();
      mount();
      fireEvent.keyDown(document.body, row.event);
      expect(JSON.stringify(ed.state.timeline)).toBe(clicked);
    });
  }
});
