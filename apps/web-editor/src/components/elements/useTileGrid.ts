/**
 * The Elements grids' keyboard (plan/elements 02 §7): one Tab stop, arrows move by a tile and by a
 * row, Home and End jump to the ends; Enter is each tile's own button. Shared by the Shapes and
 * Stickers grids so both behave the same.
 */
import { useRef, useState, type KeyboardEvent } from 'react';

export interface TileGrid {
  readonly gridRef: React.RefObject<HTMLUListElement>;
  /** The tile that holds the Tab stop. */
  readonly focusIndex: number;
  /** Call from a tile's `onFocus`, and with 0 when the tile set changes. */
  readonly setActive: (index: number) => void;
  readonly onGridKey: (event: KeyboardEvent<HTMLUListElement>) => void;
}

/**
 * @param count - How many tiles are showing.
 * @param tileSelector - Selects the tiles' buttons inside the grid, in order.
 */
export function useTileGrid(count: number, tileSelector: string): TileGrid {
  const gridRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const focusIndex = Math.min(active, Math.max(0, count - 1));

  const focusTile = (index: number): void => {
    const target = Math.max(0, Math.min(count - 1, index));
    setActive(target);
    gridRef.current?.querySelectorAll<HTMLButtonElement>(tileSelector)[target]?.focus();
  };
  const columns = (): number => {
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
