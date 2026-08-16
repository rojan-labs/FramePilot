/** Contextual category navigation for the desktop-editor inspector. */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { Inspector } from './Inspector.js';

afterEach(() => localStorage.clear());

const timeline: Timeline = {
  tracks: [
    {
      id: 'video',
      type: 'video',
      clips: [
        {
          id: 'text-clip',
          assetId: 'asset',
          trackId: 'video',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [
            {
              id: 'text-effect',
              type: 'text',
              params: { text: 'FramePilot' },
              keyframes: [],
            },
          ],
          keyframes: [],
        },
        {
          id: 'plain-clip',
          assetId: 'asset',
          trackId: 'video',
          start: 4,
          end: 8,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

function Host(): JSX.Element {
  const editor = useEditor(timeline, ['asset']);
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.select('text-clip')}>
        select text clip
      </button>
      <button type="button" onClick={() => editor.select('plain-clip')}>
        select plain clip
      </button>
      <Inspector editor={editor} />
    </SettingsProvider>
  );
}

describe('Inspector category tabs', () => {
  it('shows only categories supported by the selected clip and switches pages', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select text clip' }));

    expect(screen.getByRole('tab', { name: 'Basic' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Text' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Audio' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Color' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Mask' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Effects' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Transition' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Color' }));
    expect(screen.getByRole('tab', { name: 'Color' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Color controls' })).toBeTruthy();
    expect(document.querySelector('[hidden] .inspector-panel[aria-label="transform"]')).toBeTruthy();
    expect(document.querySelector(':not([hidden]) > .inspector-panel[aria-label="color"]')).toBeTruthy();
  });

  it('returns to Basic when a contextual tab is unavailable on the next selection', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select text clip' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Text' }));
    expect(screen.getByRole('tab', { name: 'Text' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'select plain clip' }));
    expect(screen.queryByRole('tab', { name: 'Text' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Basic' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Basic controls' })).toBeTruthy();
  });
});
