/**
 * The Elements grids' keyboard (plan/elements 02 §7): one Tab stop, arrows move by a tile and by a
 * row, Home and End jump to the ends; Enter is each tile's own button. Shared by the Shapes and
 * Stickers grids so both behave the same.
 *
 * A virtualised grid (Stickers, EL6b) renders only the rows in view, so the tile an arrow lands on
 * may not exist yet: it passes its column count and a `reveal`, marks each tile with
 * `data-tile-index`, and the hook focuses the tile once the grid has drawn it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface TileGrid {
  readonly gridRef: React.RefObject<HTMLUListElement>;
  /** The tile that holds the Tab stop. */
  readonly focusIndex: number;
  /** Call from a tile's `onFocus`, and with 0 when the tile set changes. */
  readonly setActive: (index: number) => void;
  readonly onGridKey: (event: KeyboardEvent<HTMLUListElement>) => void;
}

/** What a virtualised grid tells the hook. */
export interface VirtualTileGrid {
  /** Columns in the grid's own layout. */
  readonly columns: number;
  /** Scroll tile `index` into view, so the grid draws it. */
  readonly reveal: (index: number) => void;
}

/**
 * @param count - How many tiles there are (drawn or not).
 * @param tileSelector - Selects the tiles' buttons inside the grid, in order.
 * @param virtual - Present when the grid draws only the tiles in view.
 */
export function useTileGrid(
  count: number,
  tileSelector: string,
  virtual?: VirtualTileGrid,
): TileGrid {
  const gridRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  // A tile an arrow moved to before the virtualised grid had drawn it.
  const pendingFocus = useRef<number | null>(null);
  const focusIndex = Math.min(active, Math.max(0, count - 1));

  const tileAt = (index: number): HTMLButtonElement | null => {
    const grid = gridRef.current;
    if (grid === null) return null;
    if (virtual !== undefined) {
      return grid.querySelector<HTMLButtonElement>(`${tileSelector}[data-tile-index="${index}"]`);
    }
    return grid.querySelectorAll<HTMLButtonElement>(tileSelector)[index] ?? null;
  };

  useEffect(() => {
    if (pendingFocus.current === null) return;
    const tile = tileAt(pendingFocus.current);
    if (tile === null) return;
    pendingFocus.current = null;
    tile.focus();
  });

  const focusTile = (index: number): void => {
    const target = Math.max(0, Math.min(count - 1, index));
    setActive(target);
    const tile = tileAt(target);
    if (tile !== null) {
      tile.focus();
      return;
    }
    if (virtual === undefined) return;
    pendingFocus.current = target;
    virtual.reveal(target);
  };
  const columns = (): number => {
    if (virtual !== undefined) return Math.max(1, virtual.columns);
    const grid = gridRef.current;
    if (grid === null) return 1;
    const template = getComputedStyle(grid).gridTemplateColumns;
    return Math.max(1, template === '' ? 1 : template.split(' ').length);
  };
  const onGridKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const moves: Readonly<Record<string, number>> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns(),
      ArrowUp: -columns(),
    };
    if (event.key in moves) focusTile(focusIndex + moves[event.key]!);
    else if (event.key === 'Home') focusTile(0);
    else if (event.key === 'End') focusTile(count - 1);
    else return;
    event.preventDefault();
  };
  return { gridRef, focusIndex, setActive, onGridKey };
}
