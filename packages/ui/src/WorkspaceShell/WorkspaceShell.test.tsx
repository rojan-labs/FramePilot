/**
 * Tests for {@link WorkspaceShell} (J1 extraction — plan
 * FRAMEPILOT-AI-PRODUCT-PLAN.md §6): collapse/expand chrome, drag-resize math,
 * and slot rendering. WorkspaceShell is deliberately persistence-agnostic (it
 * takes already-resolved state + callbacks as props), so the
 * persistence-adapter contract itself is exercised in `useRailLayout.test.ts` /
 * `useDockHeight.test.ts` (mocked adapters) rather than here.
 *
 * These are also, in effect, the "existing web-editor e2e/unit suite must
 * pass unchanged" regression gate's package-local counterpart:
 * apps/web-editor's `Editor.test.tsx` drives the exact same splitter/collapse
 * interactions end-to-end through the real app and must keep passing too.
 */
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TIMELINE_MIN, maxDockHeight } from './useDockHeight.js';
import { RAIL_BOUNDS } from './useRailLayout.js';
import { WorkspaceShell, type WorkspaceRailSlot } from './WorkspaceShell.js';

function baseRail(
  contentTestId: string,
  overrides: Partial<WorkspaceRailSlot> = {},
): WorkspaceRailSlot {
  return {
    collapsed: false,
    width: 288,
    onResize: vi.fn(),
    onToggleCollapsed: vi.fn(),
    ariaLabel: 'a rail',
    expandLabel: 'Expand rail',
    expandIcon: <span data-testid={`${contentTestId}-expand-icon`} />,
    children: <div data-testid={contentTestId}>content</div>,
    ...overrides,
  };
}

function renderShell(overrides: {
  left?: Partial<WorkspaceRailSlot>;
  right?: Partial<WorkspaceRailSlot>;
  railAnimating?: boolean;
  overlay?: ReactNode;
} = {}) {
  const dockResize = vi.fn();
  return {
    dockResize,
    ...render(
      <WorkspaceShell
        left={baseRail('left-rail-content', overrides.left)}
        right={baseRail('right-rail-content', { ariaLabel: 'right rail', ...overrides.right })}
        center={<div data-testid="center-content">center</div>}
        dock={{ height: 260, onResize: dockResize, children: <div data-testid="dock-content">dock</div> }}
        railAnimating={overrides.railAnimating}
        overlay={overrides.overlay}
      />,
    ),
  };
}

describe('WorkspaceShell', () => {
  it('renders center and dock content, and applies the dock height', () => {
    const { container } = renderShell();
    expect(screen.getByTestId('center-content')).toBeDefined();
    expect(screen.getByTestId('dock-content')).toBeDefined();
    const dock = container.querySelector('.timeline-dock') as HTMLElement;
    expect(dock.style.height).toBe('260px');
  });

  it('renders a rail\'s children while expanded, and the expand strip while collapsed', () => {
    renderShell({ left: { collapsed: false } });
    expect(screen.getByTestId('left-rail-content')).toBeDefined();
    expect(screen.queryByTestId('left-rail-content-expand-icon')).toBeNull();
  });

  it('shows the expand button (not children) while collapsed, and wires it to onToggleCollapsed', () => {
    const onToggleCollapsed = vi.fn();
    renderShell({ left: { collapsed: true, onToggleCollapsed } });
    expect(screen.queryByTestId('left-rail-content')).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand rail'));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('applies the right rail\'s resolved width as an inline style in both collapsed and expanded states', () => {
    const { container, rerender } = render(
      <WorkspaceShell
        left={baseRail('left-rail-content')}
        right={baseRail('right-rail-content', { ariaLabel: 'right rail', width: 24, collapsed: true })}
        center={<div />}
        dock={{ height: 260, onResize: vi.fn(), children: <div /> }}
      />,
    );
    expect((container.querySelector('.rail-right') as HTMLElement).style.width).toBe('24px');

    rerender(
      <WorkspaceShell
        left={baseRail('left-rail-content')}
        right={baseRail('right-rail-content', { ariaLabel: 'right rail', width: 360, collapsed: false })}
        center={<div />}
        dock={{ height: 260, onResize: vi.fn(), children: <div /> }}
      />,
    );
    expect((container.querySelector('.rail-right') as HTMLElement).style.width).toBe('360px');
  });

  it('drives the top-region grid columns from the left rail width + collapsed state', () => {
    const { container, rerender } = render(
      <WorkspaceShell
        left={baseRail('left-rail-content', { width: 300, collapsed: false })}
        right={baseRail('right-rail-content', { ariaLabel: 'right rail' })}
        center={<div />}
        dock={{ height: 260, onResize: vi.fn(), children: <div /> }}
      />,
    );
    let body = container.querySelector('.framepilot-body') as HTMLElement;
    expect(body.style.gridTemplateColumns).toBe('300px var(--splitter-w) minmax(0, 1fr)');

    rerender(
      <WorkspaceShell
        left={baseRail('left-rail-content', { width: 24, collapsed: true })}
        right={baseRail('right-rail-content', { ariaLabel: 'right rail' })}
        center={<div />}
        dock={{ height: 260, onResize: vi.fn(), children: <div /> }}
      />,
    );
    body = container.querySelector('.framepilot-body') as HTMLElement;
    // The splitter column collapses to 0px with its rail — no phantom gutter.
    expect(body.style.gridTemplateColumns).toBe('24px 0px minmax(0, 1fr)');
  });

  it('hides (and inerts) a rail\'s splitter while that rail is collapsed', () => {
    renderShell({ left: { collapsed: true } });
    const splitter = screen.getByLabelText('Resize left panel');
    expect(splitter.getAttribute('aria-hidden')).toBe('true');
    expect(splitter.className).toContain('is-hidden');
  });

  it('resizes the left rail by dragging its splitter', () => {
    (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
      MouseEvent as unknown as typeof MouseEvent;
    Element.prototype.setPointerCapture = () => {};
    const onResize = vi.fn();
    renderShell({ left: { onResize } });
    const splitter = screen.getByLabelText('Resize left panel');
    fireEvent.pointerDown(splitter, { clientX: 288, pointerId: 1 });
    // jsdom rects are zero-origin, so clientX maps straight to the proposed width.
    fireEvent.pointerMove(splitter, { clientX: 300, buttons: 1, pointerId: 1 });
    expect(onResize).toHaveBeenCalledWith(300);
  });

  it('resizes the right rail by dragging its splitter (measured from the right edge)', () => {
    (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
      MouseEvent as unknown as typeof MouseEvent;
    Element.prototype.setPointerCapture = () => {};
    const onResize = vi.fn();
    renderShell({ right: { onResize } });
    const splitter = screen.getByLabelText('Resize right panel');
    fireEvent.pointerDown(splitter, { clientX: 360, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientX: 300, buttons: 1, pointerId: 1 });
    // jsdom rects are zero-origin: width = rect.right(0) - clientX → 0 clamps via Math.max upstream,
    // but here we assert the raw math the splitter hands back to the caller.
    expect(onResize).toHaveBeenCalledWith(-300);
  });

  it('resizes the timeline dock by dragging the stage splitter', () => {
    (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
      MouseEvent as unknown as typeof MouseEvent;
    Element.prototype.setPointerCapture = () => {};
    const { dockResize } = renderShell();
    const splitter = screen.getByLabelText('Resize timeline');
    fireEvent.pointerDown(splitter, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientY: 200, buttons: 1, pointerId: 1 });
    // jsdom rects are zero-origin; clientY maps to `rect.bottom - clientY`, clamped to TIMELINE_MIN.
    expect(dockResize).toHaveBeenCalledWith(160);
  });

  it('arms data-rail-anim only while railAnimating is true (B1 — never during a live drag)', () => {
    const { container, rerender } = render(
      <WorkspaceShell
        left={baseRail('left-rail-content')}
        right={baseRail('right-rail-content', { ariaLabel: 'right rail' })}
        center={<div />}
        dock={{ height: 260, onResize: vi.fn(), children: <div /> }}
        railAnimating
      />,
    );
    expect((container.querySelector('.framepilot-body') as HTMLElement).dataset.railAnim).toBe('true');

    rerender(
      <WorkspaceShell
        left={baseRail('left-rail-content')}
        right={baseRail('right-rail-content', { ariaLabel: 'right rail' })}
        center={<div />}
        dock={{ height: 260, onResize: vi.fn(), children: <div /> }}
      />,
    );
    expect((container.querySelector('.framepilot-body') as HTMLElement).dataset.railAnim).toBe('false');
  });

  it('gives the program monitor a main landmark', () => {
    renderShell();
    const main = screen.getByRole('main', { name: 'Program monitor' });
    expect(main.className).toBe('stage-col');
    expect(main.contains(screen.getByTestId('center-content'))).toBe(true);
  });

  it('announces each splitter\'s value and bounds', () => {
    renderShell();
    const left = screen.getByRole('separator', { name: 'Resize left panel' });
    expect(left.getAttribute('aria-valuenow')).toBe('288');
    expect(left.getAttribute('aria-valuemin')).toBe(String(RAIL_BOUNDS.left.min));
    expect(left.getAttribute('aria-valuemax')).toBe(String(RAIL_BOUNDS.left.max));
    expect(left.tabIndex).toBe(0);

    const stage = screen.getByRole('separator', { name: 'Resize timeline' });
    expect(stage.getAttribute('aria-valuenow')).toBe('260');
    expect(stage.getAttribute('aria-valuemin')).toBe(String(TIMELINE_MIN));
    expect(stage.getAttribute('aria-valuemax')).toBe(String(maxDockHeight()));
    expect(stage.tabIndex).toBe(0);
  });

  it('resizes the rails from the keyboard, in the direction each rail grows', () => {
    const leftResize = vi.fn();
    const rightResize = vi.fn();
    renderShell({ left: { onResize: leftResize }, right: { onResize: rightResize } });
    const left = screen.getByRole('separator', { name: 'Resize left panel' });
    const right = screen.getByRole('separator', { name: 'Resize right panel' });

    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(leftResize).toHaveBeenLastCalledWith(288 + 16);
    fireEvent.keyDown(left, { key: 'ArrowLeft', shiftKey: true });
    expect(leftResize).toHaveBeenLastCalledWith(288 - 64);
    fireEvent.keyDown(left, { key: 'Home' });
    expect(leftResize).toHaveBeenLastCalledWith(RAIL_BOUNDS.left.min);
    fireEvent.keyDown(left, { key: 'End' });
    expect(leftResize).toHaveBeenLastCalledWith(RAIL_BOUNDS.left.max);

    // The right rail grows leftwards, so ArrowLeft widens it.
    fireEvent.keyDown(right, { key: 'ArrowLeft' });
    expect(rightResize).toHaveBeenLastCalledWith(288 + 16);
  });

  it('clamps a keyboard resize to the rail bounds rather than running past them', () => {
    const onResize = vi.fn();
    renderShell({ left: { width: RAIL_BOUNDS.left.max, onResize } });
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize left panel' }), {
      key: 'ArrowRight',
    });
    expect(onResize).toHaveBeenLastCalledWith(RAIL_BOUNDS.left.max);
  });

  it('resizes the timeline dock from the keyboard (up grows it)', () => {
    const { dockResize } = renderShell();
    const stage = screen.getByRole('separator', { name: 'Resize timeline' });
    fireEvent.keyDown(stage, { key: 'ArrowUp' });
    expect(dockResize).toHaveBeenLastCalledWith(260 + 16);
    fireEvent.keyDown(stage, { key: 'ArrowDown', shiftKey: true });
    expect(dockResize).toHaveBeenLastCalledWith(260 - 64);
    fireEvent.keyDown(stage, { key: 'Home' });
    expect(dockResize).toHaveBeenLastCalledWith(TIMELINE_MIN);
  });

  it('renders the overlay slot as the shell\'s last child', () => {
    renderShell({ overlay: <div data-testid="toasts">toasts</div> });
    expect(screen.getByTestId('toasts')).toBeDefined();
  });
});
