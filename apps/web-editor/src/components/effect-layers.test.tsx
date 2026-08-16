/**
 * Tests for the effect-layer editing surface (schema v13, ADR 0088).
 *
 * Covers the interactions the library tests in `panels.test.tsx` do not: the
 * timeline lane's gestures, the context menu, and the Inspector's generated
 * controls — all driven through the real `useEditor` store, so every assertion is
 * about a validated patch actually landing rather than a callback firing.
 *
 * The two behaviours worth stating explicitly, because they are easy to regress:
 *
 * · a drag commits ONE patch on release, not one per pointer-move — otherwise a
 *   single gesture fills the undo history with hundreds of entries;
 * · an effect lane is SHORTER than a media lane, which is a stated product
 *   requirement rather than a style detail.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { effectLayersOf } from '@framepilot/timeline-schema';
import { resolveParams, findEffect } from '@framepilot/timeline-schema/effect-catalog';
import { useEditor } from '../editor/useEditor.js';
import { assetIdsOf } from '../editor/project.js';
import { demoProject } from '../editor/demo.js';
import {
  COLLAPSED_TRACK_HEIGHT,
  DEFAULT_TRACK_VIEW,
  EFFECT_TRACK_HEIGHT,
  effectiveTrackHeight,
} from '../editor/useTrackLayout.js';
import { EffectLayerChip } from './EffectLayerChip.js';
import { EffectLayerMenu } from './EffectLayerMenu.js';
import { EffectInspector } from './EffectInspector.js';
import {
  addEffectLayerPatch,
  duplicateEffectLayerPatch,
  moveEffectLayerPatch,
  removeEffectLayerPatch,
  removeEffectLayersPatch,
  setEffectLayerEnabledPatch,
  setEffectLayerParamsPatch,
  trimEffectLayerPatch,
} from '../editor/patch-builders.js';
import { findEffectLayer, effectLayersInApplyOrder } from '../editor/selectors.js';
import { applyOperation, invertOperation, type Operation } from '@framepilot/editor-core';

// ---------------------------------------------------------------------------
// Lane height — a stated product requirement
// ---------------------------------------------------------------------------

describe('effect lane height', () => {
  it('is shorter than a media lane', () => {
    const media = effectiveTrackHeight(DEFAULT_TRACK_VIEW, 'video');
    const effect = effectiveTrackHeight(DEFAULT_TRACK_VIEW, 'effect');
    expect(effect).toBeLessThan(media);
    expect(effect).toBe(EFFECT_TRACK_HEIGHT);
  });

  it('ignores a persisted height, which would look like a bug on an effect lane', () => {
    const stretched = { ...DEFAULT_TRACK_VIEW, heightPx: 200 };
    expect(effectiveTrackHeight(stretched, 'effect')).toBe(EFFECT_TRACK_HEIGHT);
    // A media lane still honours it.
    expect(effectiveTrackHeight(stretched, 'video')).toBe(200);
  });

  it('still collapses like any other lane', () => {
    const collapsed = { ...DEFAULT_TRACK_VIEW, collapsed: true };
    expect(effectiveTrackHeight(collapsed, 'effect')).toBe(COLLAPSED_TRACK_HEIGHT);
  });

  it('keeps working for callers that pass no track type', () => {
    expect(effectiveTrackHeight(DEFAULT_TRACK_VIEW)).toBe(DEFAULT_TRACK_VIEW.heightPx);
  });
});

// ---------------------------------------------------------------------------
// Patch builders — one patch per action, all reversible
// ---------------------------------------------------------------------------

describe('effect patch builders', () => {
  const seeded = (): Timeline => ({
    tracks: [
      { id: 'fx_1', type: 'effect', clips: [] },
      { id: 'video_1', type: 'video', clips: [] },
    ],
  });

  const withLayer = (): Timeline => {
    const patch = addEffectLayerPatch(seeded(), 'mosaic-block', 1, { end: 3, layerId: 'fx-a' });
    let timeline = seeded();
    // A Patch carries `AnyOperation` (timeline + project ops); these builders only
    // ever emit timeline ops, so the narrow is safe and keeps the fixture honest
    // about what it is replaying.
    for (const op of patch?.operations ?? []) {
      timeline = applyOperation(timeline, op as Operation);
    }
    return timeline;
  };

  it('creates the lane and the layer in ONE patch', () => {
    // Two operations, one patch: the lane and the layer must appear and disappear
    // together, or undo leaves an orphan empty track behind.
    const patch = addEffectLayerPatch({ tracks: [] }, 'halo-bloom', 0);
    expect(patch?.operations.map((o) => o.type)).toEqual(['add_layer', 'add_effect_layer']);
  });

  it('reuses an existing lane rather than stacking empty tracks', () => {
    const patch = addEffectLayerPatch(seeded(), 'halo-bloom', 0);
    expect(patch?.operations).toHaveLength(1);
  });

  it('stores the complete resolved param bag', () => {
    const patch = addEffectLayerPatch(seeded(), 'tape-warp', 0);
    const op = patch?.operations[0] as { layer: { params: Record<string, number> } };
    expect(op.layer.params).toEqual(resolveParams(findEffect('tape-warp')!));
  });

  it('rejects an unknown effect id and a negative start', () => {
    expect(addEffectLayerPatch(seeded(), 'not-real', 0)).toBeNull();
    expect(addEffectLayerPatch(seeded(), 'halo-bloom', -1)).toBeNull();
  });

  it('duplicates a layer immediately after itself', () => {
    const patch = duplicateEffectLayerPatch(withLayer(), 'fx-a');
    const op = patch?.operations[0] as { layer: { id: string; start: number; end: number } };
    expect(op.layer.id).not.toBe('fx-a');
    // Placed after, not on top: an exact overlap would look like nothing happened.
    expect(op.layer.start).toBe(3);
    expect(op.layer.end).toBe(5);
  });

  it('produces no patch for a trim that would invert the layer', () => {
    // Returning null (rather than an invalid patch the validator rejects) keeps a
    // rejected drag out of the history entirely.
    expect(trimEffectLayerPatch(withLayer(), 'fx-a', 3, 3)).toBeNull();
    expect(trimEffectLayerPatch(withLayer(), 'fx-a', -1, 2)).toBeNull();
  });

  it('produces no patch for an unknown layer', () => {
    const timeline = withLayer();
    expect(moveEffectLayerPatch(timeline, 'ghost', 1)).toBeNull();
    expect(trimEffectLayerPatch(timeline, 'ghost', 0, 1)).toBeNull();
    expect(setEffectLayerParamsPatch(timeline, 'ghost', { size: 8 })).toBeNull();
    expect(setEffectLayerEnabledPatch(timeline, 'ghost', true)).toBeNull();
    expect(removeEffectLayerPatch(timeline, 'ghost')).toBeNull();
    expect(duplicateEffectLayerPatch(timeline, 'ghost')).toBeNull();
  });

  it('clamps a param against the layer’s own kind', () => {
    const patch = setEffectLayerParamsPatch(withLayer(), 'fx-a', { size: 99999 });
    const op = patch?.operations[0] as { params: Record<string, number> };
    expect(op.params['size']).toBe(128);
  });

  it('produces no patch when nothing was asked to change', () => {
    expect(setEffectLayerParamsPatch(withLayer(), 'fx-a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Apply order — the shared contract with the render engine
// ---------------------------------------------------------------------------

describe('effectLayersInApplyOrder', () => {
  it('walks tracks bottom-up, then by start', () => {
    // Same rule the export engine walks. Two orders would make a stacked effect
    // look different in the preview than in the rendered file.
    const timeline: Timeline = {
      tracks: [
        {
          id: 'fx_front',
          type: 'effect',
          clips: [],
          effectLayers: [
            {
              id: 'front-late',
              effectId: 'halo-bloom',
              kind: 'bloom',
              start: 4,
              end: 6,
              params: {},
              keyframes: [],
            },
            {
              id: 'front-early',
              effectId: 'halo-bloom',
              kind: 'bloom',
              start: 0,
              end: 2,
              params: {},
              keyframes: [],
            },
          ],
        },
        {
          id: 'fx_back',
          type: 'effect',
          clips: [],
          effectLayers: [
            {
              id: 'back',
              effectId: 'mosaic-block',
              kind: 'mosaic',
              start: 0,
              end: 6,
              params: {},
              keyframes: [],
            },
          ],
        },
      ],
    };
    expect(effectLayersInApplyOrder(timeline).map((l) => l.id)).toEqual([
      'back',
      'front-early',
      'front-late',
    ]);
  });

  it('skips hidden lanes', () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: 'fx_1',
          type: 'effect',
          clips: [],
          hidden: true,
          effectLayers: [
            {
              id: 'a',
              effectId: 'halo-bloom',
              kind: 'bloom',
              start: 0,
              end: 2,
              params: {},
              keyframes: [],
            },
          ],
        },
      ],
    };
    expect(effectLayersInApplyOrder(timeline)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The lane chip
// ---------------------------------------------------------------------------

/**
 * Dispatch a pointer event that actually carries its coordinates.
 *
 * jsdom implements no `PointerEvent`, so testing-library's `fireEvent.pointerDown`
 * falls back to a bare `Event` and silently DROPS `button`, `clientX` and
 * `pointerId` — every gesture assertion then fails for reasons unrelated to the
 * component. Backing the event with a `MouseEvent` (which jsdom does implement)
 * and attaching `pointerId` gives React a faithful synthetic event.
 */
const pointer = (
  el: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; button?: number; altKey?: boolean },
): void => {
  fireEvent(
    el,
    Object.assign(
      new MouseEvent(type, {
        bubbles: true,
        button: init.button ?? 0,
        clientX: init.clientX,
        altKey: init.altKey ?? false,
      }),
      { pointerId: 1 },
    ),
  );
};

describe('EffectLayerChip', () => {
  const layer = {
    id: 'fx-a',
    effectId: 'mosaic-block',
    kind: 'mosaic' as const,
    start: 1,
    end: 3,
    params: {},
    keyframes: [],
  };

  const renderChip = (
    overrides: Partial<React.ComponentProps<typeof EffectLayerChip>> = {},
  ): {
    moves: number[];
    trims: [number, number][];
  } => {
    const moves: number[] = [];
    const trims: [number, number][] = [];
    render(
      <EffectLayerChip
        layer={layer}
        trackId="fx_1"
        pxPerSecond={100}
        selected={false}
        onSelect={() => {}}
        onMove={(_id, toStart) => moves.push(toStart)}
        onTrim={(_id, start, end) => trims.push([start, end])}
        onContextMenu={() => {}}
        snap={(seconds) => seconds}
        {...overrides}
      />,
    );
    return { moves, trims };
  };

  const chip = (): HTMLElement => screen.getByRole('button', { name: /Mosaic Block effect/ });

  it('names itself and its range for assistive tech', () => {
    renderChip();
    expect(chip().getAttribute('aria-label')).toContain('1.00 to 3.00 seconds');
  });

  it('says when it is bypassed', () => {
    renderChip({ layer: { ...layer, disabled: true } });
    expect(screen.getByRole('button', { name: /Mosaic Block effect.*bypassed/ })).toBeDefined();
  });

  it('positions and sizes from the time range', () => {
    renderChip();
    expect(chip().style.left).toBe('100px');
    expect(chip().style.width).toBe('200px');
  });

  it('commits ONE move on release, not one per pointer-move', () => {
    const { moves } = renderChip();
    const target = chip();
    pointer(target, 'pointerdown', { clientX: 150 });
    pointer(target, 'pointermove', { clientX: 200 });
    pointer(target, 'pointermove', { clientX: 250 });
    pointer(target, 'pointermove', { clientX: 300 });
    // Nothing committed yet — a drag in progress must not write history.
    expect(moves).toEqual([]);
    pointer(target, 'pointerup', { clientX: 300 });
    // 150px of travel at 100px/s = +1.5s from a start of 1.
    expect(moves).toEqual([2.5]);
  });

  it('never moves to a negative start', () => {
    const { moves } = renderChip();
    const target = chip();
    pointer(target, 'pointerdown', { clientX: 500 });
    pointer(target, 'pointermove', { clientX: 0 });
    pointer(target, 'pointerup', { clientX: 0 });
    expect(moves).toEqual([0]);
  });

  it('trims from the out edge without touching the in point', () => {
    const { trims } = renderChip();
    const handle = document.querySelector('.fx-layer-handle--end') as HTMLElement;
    pointer(handle, 'pointerdown', { clientX: 300 });
    pointer(handle, 'pointermove', { clientX: 400 });
    pointer(handle, 'pointerup', { clientX: 400 });
    expect(trims).toEqual([[1, 4]]);
  });

  it('stops a trim at the fixed edge rather than inverting the layer', () => {
    const { trims } = renderChip();
    const handle = document.querySelector('.fx-layer-handle--start') as HTMLElement;
    // Dragged far past the out point.
    pointer(handle, 'pointerdown', { clientX: 100 });
    pointer(handle, 'pointermove', { clientX: 900 });
    pointer(handle, 'pointerup', { clientX: 900 });
    const [start, end] = trims[0] as [number, number];
    expect(start).toBeLessThan(end);
    expect(end).toBe(3);
  });

  it('commits nothing when the pointer did not actually move', () => {
    // A plain click selects; it must not create an undo entry.
    const { moves } = renderChip();
    const target = chip();
    pointer(target, 'pointerdown', { clientX: 150 });
    pointer(target, 'pointerup', { clientX: 150 });
    expect(moves).toEqual([]);
  });

  it('ignores a non-primary button so right-click cannot start a silent edit', () => {
    const { moves } = renderChip();
    const target = chip();
    pointer(target, 'pointerdown', { clientX: 150, button: 2 });
    pointer(target, 'pointermove', { clientX: 300 });
    pointer(target, 'pointerup', { clientX: 300 });
    expect(moves).toEqual([]);
  });

  it('selects on pointer-down and on Enter', () => {
    const selected: string[] = [];
    renderChip({ onSelect: (id) => selected.push(id) });
    const target = chip();
    pointer(target, 'pointerdown', { clientX: 150 });
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(selected).toEqual(['fx-a', 'fx-a']);
  });

  it('opens the context menu without letting the timeline see the event', () => {
    const opened: string[] = [];
    renderChip({ onContextMenu: (id) => opened.push(id) });
    fireEvent.contextMenu(chip());
    expect(opened).toEqual(['fx-a']);
  });
});

// ---------------------------------------------------------------------------
// The context menu
// ---------------------------------------------------------------------------

describe('EffectLayerMenu', () => {
  it('names the ACTION, not the state', () => {
    const { unmount } = render(
      <EffectLayerMenu x={10} y={10} disabled={false} onAction={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('menuitem', { name: 'Bypass' })).toBeDefined();
    unmount();
    render(<EffectLayerMenu x={10} y={10} disabled onAction={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('menuitem', { name: 'Enable' })).toBeDefined();
  });

  it('reports each action', () => {
    const actions: string[] = [];
    render(
      <EffectLayerMenu
        x={10}
        y={10}
        disabled={false}
        onAction={(a) => actions.push(a)}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bypass' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(actions).toEqual(['duplicate', 'toggle', 'remove']);
  });

  it('closes on Escape', () => {
    let closed = false;
    render(
      <EffectLayerMenu
        x={10}
        y={10}
        disabled={false}
        onAction={() => {}}
        onClose={() => {
          closed = true;
        }}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Inspector's generated controls
// ---------------------------------------------------------------------------

describe('EffectInspector', () => {
  const layer = {
    id: 'fx-a',
    effectId: 'tape-warp',
    kind: 'analog-vhs' as const,
    start: 1,
    end: 3,
    params: resolveParams(findEffect('tape-warp')!),
    keyframes: [],
  };

  const renderInspector = (
    overrides: Partial<React.ComponentProps<typeof EffectInspector>> = {},
  ): { commits: [unknown, unknown][]; unmount: () => void } => {
    const commits: [unknown, unknown][] = [];
    const view = render(
      <EffectInspector
        layer={layer}
        onPreview={() => {}}
        onCommit={(params, intensity) => commits.push([params, intensity])}
        onToggleEnabled={() => {}}
        onRemove={() => {}}
        {...overrides}
      />,
    );
    return { commits, unmount: view.unmount };
  };

  it('generates a control per declared param, with no per-effect code', () => {
    renderInspector();
    // analog-vhs declares tracking/chroma/noise/jitter/speed.
    for (const label of ['Tracking error', 'Chroma bleed', 'Noise', 'Line jitter', 'Speed']) {
      expect(screen.getByLabelText(label), label).toBeDefined();
    }
  });

  it('bounds each slider to the declared range', () => {
    renderInspector();
    const tracking = screen.getByLabelText('Tracking error') as HTMLInputElement;
    expect(tracking.min).toBe('0');
    expect(tracking.max).toBe('1');
  });

  it('always offers a Strength dial, whatever the kind', () => {
    renderInspector();
    expect(screen.getByLabelText('Strength')).toBeDefined();
  });

  it('commits a slider on release, not on every change', () => {
    const { commits } = renderInspector();
    const slider = screen.getByLabelText('Noise');
    fireEvent.change(slider, { target: { value: '0.8' } });
    fireEvent.change(slider, { target: { value: '0.9' } });
    expect(commits).toEqual([]);
    fireEvent.pointerUp(slider);
    expect(commits).toHaveLength(1);
    expect((commits[0]?.[0] as Record<string, number>)['noise']).toBe(0.9);
  });

  it('commits on keyup too, so a keyboard user is not stranded', () => {
    const { commits } = renderInspector();
    const slider = screen.getByLabelText('Noise');
    fireEvent.change(slider, { target: { value: '0.5' } });
    fireEvent.keyUp(slider);
    expect(commits).toHaveLength(1);
  });

  it('clears the intensity override when dragged back to full', () => {
    // 1 is the canonical default and is stored ABSENT, so committing exactly 1
    // must clear rather than persist it — otherwise undo cannot land deep-equal.
    //
    // The layer starts at 0.5 deliberately: a controlled slider already showing 1
    // fires no change event when set to 1, so starting at full would test nothing.
    const { commits } = renderInspector({ layer: { ...layer, intensity: 0.5 } });
    const slider = screen.getByLabelText('Strength');
    fireEvent.change(slider, { target: { value: '1' } });
    fireEvent.pointerUp(slider);
    expect(commits[0]?.[1]).toBeNull();
  });

  it('persists a partial intensity', () => {
    const { commits } = renderInspector();
    const slider = screen.getByLabelText('Strength');
    fireEvent.change(slider, { target: { value: '0.4' } });
    fireEvent.pointerUp(slider);
    expect(commits[0]?.[1]).toBe(0.4);
  });

  it('renders a discrete param as a segmented control that commits immediately', () => {
    const { commits } = renderInspector({
      layer: {
        ...layer,
        effectId: 'mirror-split',
        kind: 'mirror',
        params: resolveParams(findEffect('mirror-split')!),
      },
    });
    // `axis` declares four choices — a slider would be the wrong control.
    fireEvent.click(screen.getByRole('button', { name: 'Top → bottom' }));
    expect((commits[0]?.[0] as Record<string, number>)['axis']).toBe(2);
  });

  it('names the bypass action, not the state', () => {
    const { unmount } = renderInspector();
    expect(screen.getByRole('button', { name: 'Bypass' })).toBeDefined();
    unmount();
    renderInspector({ layer: { ...layer, disabled: true } });
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDefined();
  });

  it('shows the layer’s time range', () => {
    renderInspector();
    expect(screen.getByText('1.00s – 3.00s')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the real store
// ---------------------------------------------------------------------------

describe('effect editing through the real editor store', () => {
  beforeEach(() => {
    for (const key of ['framepilot.effects.favourites', 'framepilot.effects.recents']) {
      globalThis.localStorage.removeItem(key);
    }
  });

  function Host(): JSX.Element {
    const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
    const layers = effectLayersInApplyOrder(editor.state.timeline);
    const first = layers[0];
    return (
      <>
        <span data-testid="count">{layers.length}</span>
        <span data-testid="range">{first ? `${first.start}-${first.end}` : 'none'}</span>
        <span data-testid="disabled">{String(first?.disabled === true)}</span>
        <button
          type="button"
          onClick={() => {
            const patch = addEffectLayerPatch(editor.state.timeline, 'mosaic-block', 1, {
              end: 3,
              layerId: 'fx-a',
            });
            if (patch) editor.applyPatch(patch);
          }}
        >
          add
        </button>
        <button
          type="button"
          onClick={() => {
            const patch = trimEffectLayerPatch(editor.state.timeline, 'fx-a', 1, 5);
            if (patch) editor.applyPatch(patch);
          }}
        >
          trim
        </button>
        <button
          type="button"
          onClick={() => {
            const found = findEffectLayer(editor.state.timeline, 'fx-a');
            const patch = setEffectLayerEnabledPatch(
              editor.state.timeline,
              'fx-a',
              found?.layer.disabled === true,
            );
            if (patch) editor.applyPatch(patch);
          }}
        >
          toggle
        </button>
        <button type="button" onClick={() => editor.undo()}>
          undo
        </button>
      </>
    );
  }

  it('applies, trims, bypasses and undoes — each one step', () => {
    render(<Host />);
    expect(screen.getByTestId('count').textContent).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('range').textContent).toBe('1-3');

    fireEvent.click(screen.getByRole('button', { name: 'trim' }));
    expect(screen.getByTestId('range').textContent).toBe('1-5');

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('disabled').textContent).toBe('true');

    // Three undos walk back through bypass → trim → add, one step each.
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(screen.getByTestId('disabled').textContent).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(screen.getByTestId('range').textContent).toBe('1-3');
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('leaves no orphan effect lane after undoing the first apply', () => {
    // The lane and the layer are created in one patch, so undo must remove both.
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(screen.getByTestId('count').textContent).toBe('0');
  });
});

// Referenced so the import is not pruned; `effectLayersOf` is the sanctioned
// accessor these tests assert through the selectors above.
void effectLayersOf;

// The synthetic preview frame's PIXELS are asserted in the Playwright spec
// (tests/e2e/specs/effect-layers.spec.ts), not here: jsdom implements no canvas
// 2D context, and pulling in the `canvas` npm package to get one would be a new
// dependency for a test that a real browser can run natively.

// ---------------------------------------------------------------------------
// Apply targeting: clip range, and auto-stacking on conflict
// ---------------------------------------------------------------------------

describe('where a new effect lands', () => {
  const lanes = (count: number): Timeline['tracks'] =>
    Array.from({ length: count }, (_, i) => ({
      id: `fx_${i}`,
      type: 'effect' as const,
      clips: [],
    }));

  const withLayerOn = (trackId: string, start: number, end: number): Timeline => ({
    tracks: lanes(1).map((t) =>
      t.id === trackId
        ? {
            ...t,
            effectLayers: [
              {
                id: 'existing',
                effectId: 'halo-bloom',
                kind: 'bloom' as const,
                start,
                end,
                params: {},
                keyframes: [],
              },
            ],
          }
        : t,
    ),
  });

  it('reuses a lane when the span is free', () => {
    const timeline = withLayerOn('fx_0', 0, 2);
    const patch = addEffectLayerPatch(timeline, 'mosaic-block', 5, { end: 7 });
    // Free after 2s, so it shares the lane rather than spawning a new one.
    expect(patch?.operations).toHaveLength(1);
    expect(patch?.operations[0]).toMatchObject({ trackId: 'fx_0' });
  });

  it('stacks onto a NEW lane above when the span conflicts', () => {
    // Two effects covering the same moment must BOTH apply. Dropping the second
    // on top of the first would be ambiguous to read even though the engine
    // orders them deterministically.
    const timeline = withLayerOn('fx_0', 0, 4);
    const patch = addEffectLayerPatch(timeline, 'mosaic-block', 1, { end: 3 });
    expect(patch?.operations.map((o) => o.type)).toEqual(['add_layer', 'add_effect_layer']);
    // atIndex 0 = visual front, so the new lane applies LAST — "on top".
    expect(patch?.operations[0]).toMatchObject({ atIndex: 0, layerType: 'effect' });
  });

  it('treats touching ranges as free, not conflicting', () => {
    // [0,2) and [2,4) never overlap, so they belong on one lane.
    const timeline = withLayerOn('fx_0', 0, 2);
    const patch = addEffectLayerPatch(timeline, 'mosaic-block', 2, { end: 4 });
    expect(patch?.operations).toHaveLength(1);
  });

  it('finds a free lane lower in the stack before creating one', () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: 'fx_top',
          type: 'effect',
          clips: [],
          effectLayers: [
            {
              id: 'a',
              effectId: 'halo-bloom',
              kind: 'bloom',
              start: 0,
              end: 4,
              params: {},
              keyframes: [],
            },
          ],
        },
        { id: 'fx_bottom', type: 'effect', clips: [] },
      ],
    };
    const patch = addEffectLayerPatch(timeline, 'mosaic-block', 1, { end: 3 });
    expect(patch?.operations).toHaveLength(1);
    // The lowest free lane, so the new effect sits as close to the picture as it can.
    expect(patch?.operations[0]).toMatchObject({ trackId: 'fx_bottom' });
  });

  it('honours an explicitly targeted lane even when occupied', () => {
    // A deliberate drop onto a specific lane is the user saying where they want it.
    const timeline = withLayerOn('fx_0', 0, 4);
    const patch = addEffectLayerPatch(timeline, 'mosaic-block', 1, { end: 3, trackId: 'fx_0' });
    expect(patch?.operations).toHaveLength(1);
    expect(patch?.operations[0]).toMatchObject({ trackId: 'fx_0' });
  });
});

describe('removeEffectLayersPatch', () => {
  const seeded = (): Timeline => {
    let timeline: Timeline = { tracks: [{ id: 'fx_1', type: 'effect', clips: [] }] };
    for (const [id, start] of [
      ['a', 0],
      ['b', 3],
    ] as const) {
      const patch = addEffectLayerPatch(timeline, 'halo-bloom', start, {
        end: start + 2,
        layerId: id,
      });
      for (const op of patch?.operations ?? [])
        timeline = applyOperation(timeline, op as Operation);
    }
    return timeline;
  };

  it('removes several layers in ONE patch, so it is one undo step', () => {
    const patch = removeEffectLayersPatch(seeded(), ['a', 'b']);
    expect(patch?.operations).toHaveLength(2);
    expect(patch?.reason).toContain('2 effects');
  });

  it('ignores stale ids rather than failing the whole delete', () => {
    // A layer an AI edit removed under the selection must not block the rest.
    const patch = removeEffectLayersPatch(seeded(), ['a', 'ghost']);
    expect(patch?.operations).toHaveLength(1);
  });

  it('produces no patch when nothing in the selection still exists', () => {
    expect(removeEffectLayersPatch(seeded(), ['ghost'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manual overlap: a drag or trim that collides relocates
// ---------------------------------------------------------------------------

describe('a manual move or trim that would overlap', () => {
  /** One lane holding `a` at [0,4) and `b` at [6,10). */
  const twoOnOneLane = (): Timeline => {
    let timeline: Timeline = { tracks: [{ id: 'fx_0', type: 'effect', clips: [] }] };
    for (const [id, start, end] of [
      ['a', 0, 4],
      ['b', 6, 10],
    ] as const) {
      const patch = addEffectLayerPatch(timeline, 'halo-bloom', start, { end, layerId: id });
      for (const op of patch?.operations ?? [])
        timeline = applyOperation(timeline, op as Operation);
    }
    return timeline;
  };

  it('stays put when the new position is clear', () => {
    const patch = moveEffectLayerPatch(twoOnOneLane(), 'b', 12);
    expect(patch?.operations).toHaveLength(1);
    expect(patch?.reason).toBe('Move effect');
  });

  it('relocates to a NEW lane when dragged onto a neighbour', () => {
    // Two effects over the same moment must BOTH apply, so refusing the drag
    // would be wrong; two chips stacked on one lane is unreadable, so leaving it
    // would be wrong too.
    const patch = moveEffectLayerPatch(twoOnOneLane(), 'b', 1);
    expect(patch?.operations.map((o) => o.type)).toEqual(['add_layer', 'move_effect_layer']);
    expect(patch?.operations[0]).toMatchObject({ atIndex: 0, layerType: 'effect' });
  });

  it('prefers an EXISTING free lane over creating one', () => {
    const timeline: Timeline = {
      ...twoOnOneLane(),
      tracks: [...twoOnOneLane().tracks, { id: 'fx_spare', type: 'effect', clips: [] }],
    };
    const patch = moveEffectLayerPatch(timeline, 'b', 1);
    expect(patch?.operations).toHaveLength(1);
    expect(patch?.operations[0]).toMatchObject({ toTrackId: 'fx_spare' });
  });

  it('never counts a layer as overlapping itself', () => {
    // A layer always "overlaps" its own old range; nudging one on an otherwise
    // empty lane must not bounce it to a new track.
    let timeline: Timeline = { tracks: [{ id: 'fx_0', type: 'effect', clips: [] }] };
    const seed = addEffectLayerPatch(timeline, 'halo-bloom', 2, { end: 6, layerId: 'solo' });
    for (const op of seed?.operations ?? []) timeline = applyOperation(timeline, op as Operation);
    const patch = moveEffectLayerPatch(timeline, 'solo', 3);
    expect(patch?.operations).toHaveLength(1);
    expect(patch?.reason).toBe('Move effect');
  });

  it('relocates when a TRIM extends a layer into its neighbour', () => {
    // Extending an edge collides just as a drag does.
    const patch = trimEffectLayerPatch(twoOnOneLane(), 'a', 0, 8);
    expect(patch?.operations.map((o) => o.type)).toEqual([
      'trim_effect_layer',
      'add_layer',
      'move_effect_layer',
    ]);
  });

  it('trims in place when the result still fits', () => {
    const patch = trimEffectLayerPatch(twoOnOneLane(), 'a', 0, 5);
    expect(patch?.operations).toHaveLength(1);
    expect(patch?.reason).toBe('Trim effect');
  });

  it('applies the relocation cleanly and reversibly', () => {
    // The multi-op sequence has to actually replay AND invert as one step.
    const before = twoOnOneLane();
    const patch = moveEffectLayerPatch(before, 'b', 1);
    let after = before;
    for (const op of patch?.operations ?? []) after = applyOperation(after, op as Operation);

    const lanes = after.tracks.filter((t) => t.type === 'effect');
    expect(lanes).toHaveLength(2);
    // Both survive, on different lanes, and neither overlaps a sibling now.
    expect(
      effectLayersInApplyOrder(after)
        .map((l) => l.id)
        .sort(),
    ).toEqual(['a', 'b']);

    const states: Timeline[] = [];
    let cursor = before;
    for (const op of patch?.operations ?? []) {
      states.push(cursor);
      cursor = applyOperation(cursor, op as Operation);
    }
    for (let i = (patch?.operations.length ?? 0) - 1; i >= 0; i -= 1) {
      for (const inv of invertOperation(states[i] as Timeline, patch?.operations[i] as Operation)) {
        cursor = applyOperation(cursor, inv);
      }
    }
    expect(cursor).toEqual(before);
  });
});
