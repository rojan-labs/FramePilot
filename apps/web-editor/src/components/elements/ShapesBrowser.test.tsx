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
      'Highlight box, shape',
      'Filled box, shape',
      'Ellipse, shape',
      'Marker, shape',
      'Arrow, shape',
      'Underline, shape',
    ]);
    expect(tiles()).toHaveLength(SHAPE_PRESETS.length);
  });

  it('adds the preset clicked, in its own colours', () => {
    const onAddShape = vi.fn(() => null);
    render(<ShapesBrowser onAddShape={onAddShape} />);
    fireEvent.click(screen.getByRole('button', { name: 'Arrow, shape' }));
    expect(onAddShape).toHaveBeenCalledWith('line-arrow/red', null);
    // The refusal line is mounted empty, so it is there before it has anything to say.
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('says why a shape could not be added', () => {
    render(<ShapesBrowser onAddShape={() => 'That spot is locked.'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Marker, shape' }));
    expect(screen.getByRole('status').textContent).toBe('That spot is locked.');
  });

  it('narrows to a category chip and remembers it', () => {
    const { unmount } = render(<ShapesBrowser onAddShape={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stars & badges' }));
    expect(
      screen.getByRole('button', { name: 'Stars & badges' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const stars = SHAPE_PRESETS.filter(({ shape }) => shape.category === 'stars');
    expect(names()).toEqual(stars.map(({ preset }) => `${preset.name}, shape`));
    unmount();
    render(<ShapesBrowser onAddShape={() => null} />);
    expect(names()).toHaveLength(stars.length);
  });

  it('searches names and tags, word starts first, icons included, and Escape clears', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    const search = screen.getByRole('searchbox', { name: 'Search shapes' });
    fireEvent.change(search, { target: { value: 'bubble' } });
    expect(names()).toContain('Speech bubble, shape');
    expect(names()).toContain('Thought bubble, shape');
    fireEvent.change(search, { target: { value: 'check' } });
    // The catalogue's Check comes before the Lucide icons that share the word.
    expect(names()[0]).toBe('Check, shape');
    expect(names()).toContain('Circle check, shape');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
    fireEvent.change(search, { target: { value: 'zzzz' } });
    // The same phrasing as the other sub-tabs, with a hint of its own.
    expect(
      screen.getByText('Nothing matched “zzzz”. Try a simpler word — “arrow”, “box”, “star”.'),
    ).toBeDefined();
  });

  it('adds in the colour the row picks, and a custom colour joins the row first', () => {
    const onAddShape = vi.fn(() => null);
    render(<ShapesBrowser onAddShape={onAddShape} />);
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
    // Named in the colour it will take.
    fireEvent.click(screen.getByRole('button', { name: 'Highlight box, blue, shape' }));
    expect(onAddShape).toHaveBeenLastCalledWith('rounded-rect/highlight', '#0A84FF');
    fireEvent.change(screen.getByLabelText('Custom colour'), { target: { value: '#123456' } });
    const row = within(screen.getByRole('group', { name: 'Shape colour' }));
    expect(row.getAllByRole('button')[1]!.getAttribute('aria-label')).toBe('Dark blue');
    fireEvent.click(screen.getByRole('button', { name: 'Preset colours' }));
    fireEvent.click(screen.getByRole('button', { name: 'Highlight box, shape' }));
    expect(onAddShape).toHaveBeenLastCalledWith('rounded-rect/highlight', null);
  });

  it('pages the icons rather than drawing 1,700 at once', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Icons' }));
    expect(tiles()).toHaveLength(120);
    const more = screen.getByRole('button', { name: /^Show more icons/ });
    // How many are left, grouped as a person reads a count: "1,580 left", not "1580 more".
    expect(more.textContent).toMatch(/^Show more icons \(\d{1,3}(,\d{3})* left\)$/);
    fireEvent.click(more);
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
    fireEvent.click(screen.getByRole('button', { name: 'Red' }));
    const data = new Map<string, string>();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Ellipse, red, shape' }), {
      dataTransfer: { setData: (type: string, value: string) => data.set(type, value) },
    });
    expect(decodeElementDrag(data.get(ELEMENT_DND_TYPE)!)).toEqual({
      kind: 'shape',
      presetId: 'ellipse/outline',
      colour: '#FF3B30',
    });
  });

  it('names every swatch by its colour and the tiles by the colour they will take', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    const row = within(screen.getByRole('group', { name: 'Shape colour' }));
    expect(row.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Preset colours',
      'Yellow',
      'Red',
      'White',
      'Blue',
      'Green',
      'Black',
    ]);
    expect(screen.getByRole('button', { name: 'Red' }).getAttribute('title')).toBe('Red (#FF3B30)');
    fireEvent.click(screen.getByRole('button', { name: 'Red' }));
    expect(screen.getByRole('button', { name: 'Highlight box, red, shape' })).toBeDefined();
  });

  it('shows the chosen swatch apart from the focused one', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    // Preset colours: the picker shows no colour of its own rather than a yellow nobody chose.
    expect(screen.getByLabelText('Custom colour').hasAttribute('data-unset')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
    const blue = screen.getByRole('button', { name: 'Blue' });
    expect(blue.getAttribute('aria-pressed')).toBe('true');
    // Pressed carries a mark, not only a ring the focus ring could be mistaken for.
    expect(blue.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Red' }).querySelector('svg')).toBeNull();
    expect(screen.getByLabelText('Custom colour').hasAttribute('data-unset')).toBe(false);
  });

  it('pins its search, chips and colours, and scrolls only the grid', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    const scroll = document.querySelector('.shapes-scroll') as HTMLElement;
    expect(scroll.contains(screen.getByRole('list', { name: 'Shapes' }))).toBe(true);
    for (const pinned of [
      screen.getByRole('searchbox', { name: 'Search shapes' }),
      screen.getByRole('group', { name: 'Shape categories' }),
      screen.getByRole('group', { name: 'Shape colour' }),
    ]) {
      expect(scroll.contains(pinned)).toBe(false);
    }
  });

  it('uses the app’s one input style for its search', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    const search = screen.getByRole('searchbox', { name: 'Search shapes' });
    expect(search.getAttribute('data-ui')).toBe('input');
    expect(search.classList.contains('elements-search')).toBe(true);
  });

  it('starts from the search and scroll it is handed, and reports both as they change', () => {
    const onQueryChange = vi.fn();
    const onScrollTopChange = vi.fn();
    render(
      <ShapesBrowser
        onAddShape={() => null}
        initialQuery="arrow"
        onQueryChange={onQueryChange}
        initialScrollTop={120}
        onScrollTopChange={onScrollTopChange}
      />,
    );
    const search = screen.getByRole('searchbox', { name: 'Search shapes' }) as HTMLInputElement;
    expect(search.value).toBe('arrow');
    const scroll = document.querySelector('.shapes-scroll') as HTMLElement;
    expect(scroll.scrollTop).toBe(120);
    fireEvent.change(search, { target: { value: 'star' } });
    expect(onQueryChange).toHaveBeenLastCalledWith('star');
    scroll.scrollTop = 40;
    fireEvent.scroll(scroll);
    expect(onScrollTopChange).toHaveBeenLastCalledWith(40);
  });
});
