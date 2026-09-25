/**
 * ElementsPanel — the sub-tab host: which sub-tabs a build offers, which one opens,
 * how it is remembered, and the keyboard model of the strip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Project } from '@framepilot/timeline-schema';
import { ElementsPanel, availableElementsTabs, coerceElementsTab } from './ElementsPanel.js';

const desktop = vi.hoisted(() => ({ value: true }));

vi.mock('../../editor/bridge.js', () => ({ isDesktop: () => desktop.value }));

// The Pexels browser has its own suite; here it only has to show which kind it was
// given and hand the query back, which is all the host is responsible for.
vi.mock('./PexelsBrowser.js', () => ({
  PexelsBrowser: (props: {
    kind: string;
    initialQuery?: string;
    onQueryChange?: (q: string) => void;
  }) => (
    <div data-testid="pexels" data-kind={props.kind}>
      <input
        aria-label="query"
        defaultValue={props.initialQuery ?? ''}
        onChange={(event) => props.onQueryChange?.(event.target.value)}
      />
    </div>
  ),
}));

const project = {
  id: 'p1',
  assets: [],
  resolution: { width: 1920, height: 1080 },
} as unknown as Project;

function renderPanel(): void {
  render(
    <ElementsPanel
      project={project}
      placementBlockedReasonFor={() => null}
      onAddStock={() => null}
    />,
  );
}

const STORAGE_KEY = 'framepilot.view.elementsTab';

describe('ElementsPanel', () => {
  beforeEach(() => {
    desktop.value = true;
    localStorage.clear();
  });
  afterEach(() => localStorage.clear());

  it('offers Photos, Videos and Shapes on the desktop, in the maintainer’s order', () => {
    renderPanel();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Photos', 'Videos', 'Shapes']);
    expect(screen.getByRole('tablist', { name: 'Elements' })).toBeDefined();
  });

  it('opens on Photos the first time and shows the photo library', () => {
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Photos' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('pexels').dataset.kind).toBe('photo');
  });

  it('switches to Videos on click and remembers the choice', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Videos' }));
    expect(screen.getByTestId('pexels').dataset.kind).toBe('video');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('"videos"');
  });

  it('restores the remembered sub-tab on the next open', () => {
    localStorage.setItem(STORAGE_KEY, '"videos"');
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Videos' }).getAttribute('aria-selected')).toBe('true');
  });

  it('ignores a remembered sub-tab this build does not offer', () => {
    localStorage.setItem(STORAGE_KEY, '"stickers"');
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Photos' }).getAttribute('aria-selected')).toBe('true');
  });

  it('moves between sub-tabs with the arrow keys and keeps one tab stop', () => {
    renderPanel();
    const photos = screen.getByRole('tab', { name: 'Photos' });
    expect(photos.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Videos' }).tabIndex).toBe(-1);
    fireEvent.keyDown(photos, { key: 'ArrowRight' });
    const videos = screen.getByRole('tab', { name: 'Videos' });
    expect(videos.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(videos);
    fireEvent.keyDown(videos, { key: 'End' });
    const shapes = screen.getByRole('tab', { name: 'Shapes' });
    expect(shapes.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(shapes, { key: 'ArrowRight' });
    // Wraps around, as a tablist does.
    expect(photos.getAttribute('aria-selected')).toBe('true');
  });

  it('labels the panel with the selected sub-tab', () => {
    renderPanel();
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('elements-tab-photos');
  });

  it('keeps the search words across a Photos ↔ Videos switch', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'city' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Videos' }));
    expect((screen.getByLabelText('query') as HTMLInputElement).value).toBe('city');
  });

  it('shows the shape tiles on the Shapes tab and adds the one clicked', () => {
    const added: string[] = [];
    render(
      <ElementsPanel
        project={project}
        placementBlockedReasonFor={() => null}
        onAddStock={() => null}
        onAddShape={(presetId) => {
          added.push(presetId);
          return null;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Shapes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Highlight box' }));
    expect(added).toEqual(['rounded-rect/highlight']);
  });

  it('is absent-and-explained in a browser build, which serves no sub-tab yet', () => {
    desktop.value = false;
    renderPanel();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/desktop app/i);
  });
});

describe('availableElementsTabs / coerceElementsTab', () => {
  it('serves Photos, Videos and Shapes only where the desktop host runs', () => {
    expect(availableElementsTabs(true)).toEqual(['photos', 'videos', 'shapes']);
    expect(availableElementsTabs(false)).toEqual([]);
  });

  it('accepts only a sub-tab the build offers', () => {
    expect(coerceElementsTab('videos', ['photos', 'videos'])).toBe('videos');
    expect(coerceElementsTab('shapes', ['photos', 'videos'])).toBeUndefined();
    expect(coerceElementsTab(42, ['photos', 'videos'])).toBeUndefined();
  });
});
