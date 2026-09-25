/**
 * The Shapes sub-tab (plan/elements EL4a, EL5): the staples first, chips and search over the
 * catalogue and the icons, a colour row that recolours the tiles and the next shape, a grid with
 * one tab stop, drag to the timeline, and a refusal said, not swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SHAPE_PRESETS } from '@framepilot/timeline-schema';
import { ShapesBrowser } from './ShapesBrowser.js';
import { ELEMENT_DND_TYPE, decodeElementDrag } from './element-dnd.js';

const tiles = (): HTMLButtonElement[] =>
  within(screen.getByRole('list', { name: 'Shapes' })).getAllByRole(
    'button',
  ) as HTMLButtonElement[];
const names = (): (string | null)[] => tiles().map((tile) => tile.getAttribute('aria-label'));

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('ShapesBrowser', () => {
  it('opens on All with the six screen-recording staples first, every preset a button', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    expect(names().slice(0, 6)).toEqual([
      'Add Highlight box',
      'Add Filled box',
      'Add Ellipse',
      'Add Marker',
      'Add Arrow',
      'Add Underline',
    ]);
    expect(tiles()).toHaveLength(SHAPE_PRESETS.length);
  });

  it('adds the preset clicked, in its own colours', () => {
    const onAddShape = vi.fn(() => null);
    render(<ShapesBrowser onAddShape={onAddShape} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Arrow' }));
    expect(onAddShape).toHaveBeenCalledWith('line-arrow/red', null);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says why a shape could not be added', () => {
    render(<ShapesBrowser onAddShape={() => 'That spot is locked.'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Marker' }));
    expect(screen.getByRole('status').textContent).toBe('That spot is locked.');
  });

  it('narrows to a category chip and remembers it', () => {
    const { unmount } = render(<ShapesBrowser onAddShape={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stars & badges' }));
    expect(
      screen.getByRole('button', { name: 'Stars & badges' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const stars = SHAPE_PRESETS.filter(({ shape }) => shape.category === 'stars');
    expect(names()).toEqual(stars.map(({ preset }) => `Add ${preset.name}`));
    unmount();
    render(<ShapesBrowser onAddShape={() => null} />);
    expect(names()).toHaveLength(stars.length);
  });

  it('searches names and tags, word starts first, icons included, and Escape clears', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    const search = screen.getByRole('searchbox', { name: 'Search shapes' });
    fireEvent.change(search, { target: { value: 'bubble' } });
    expect(names()).toContain('Add Speech bubble');
    expect(names()).toContain('Add Thought bubble');
    fireEvent.change(search, { target: { value: 'check' } });
    // The catalogue's Check comes before the Lucide icons that share the word.
    expect(names()[0]).toBe('Add Check');
    expect(names()).toContain('Add Circle check');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(screen.getByText('No shapes match “zzzz”. Try another word.')).toBeDefined();
  });

  it('adds in the colour the row picks, and a custom colour joins the row first', () => {
    const onAddShape = vi.fn(() => null);
    render(<ShapesBrowser onAddShape={onAddShape} />);
    fireEvent.click(screen.getByRole('button', { name: 'Colour #0A84FF' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Highlight box' }));
    expect(onAddShape).toHaveBeenLastCalledWith('rounded-rect/highlight', '#0A84FF');
    fireEvent.change(screen.getByLabelText('Custom colour'), { target: { value: '#123456' } });
    const row = within(screen.getByRole('group', { name: 'Shape colour' }));
    expect(row.getAllByRole('button')[1]!.getAttribute('aria-label')).toBe('Colour #123456');
    fireEvent.click(screen.getByRole('button', { name: 'Preset colours' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Highlight box' }));
    expect(onAddShape).toHaveBeenLastCalledWith('rounded-rect/highlight', null);
  });

  it('pages the icons rather than drawing 1,700 at once', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Icons' }));
    expect(tiles()).toHaveLength(120);
    fireEvent.click(screen.getByRole('button', { name: /^Show more icons/ }));
    expect(tiles()).toHaveLength(360);
  });

  it('is one tab stop; arrows, Home and End move through the tiles', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    expect(tiles().filter((tile) => tile.tabIndex === 0)).toHaveLength(1);
    const grid = screen.getByRole('list', { name: 'Shapes' });
    act(() => tiles()[0]!.focus());
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tiles()[1]);
    fireEvent.keyDown(grid, { key: 'End' });
    expect(document.activeElement).toBe(tiles().at(-1));
    fireEvent.keyDown(grid, { key: 'Home' });
    expect(document.activeElement).toBe(tiles()[0]);
    expect(tiles()[0]!.tabIndex).toBe(0);
  });

  it('puts the preset and the chosen colour on a drag', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Colour #FF3B30' }));
    const data = new Map<string, string>();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Add Ellipse' }), {
      dataTransfer: { setData: (type: string, value: string) => data.set(type, value) },
    });
    expect(decodeElementDrag(data.get(ELEMENT_DND_TYPE)!)).toEqual({
      kind: 'shape',
      presetId: 'ellipse/outline',
      colour: '#FF3B30',
    });
  });
});
