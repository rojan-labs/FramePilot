/**
 * MK5.1: every effect row in the Inspector offers "Add mask", and the click arms the drawing
 * tool for that effect and sends the editor to the Mask tab.
 *
 * The real Inspector is rendered (not the row in isolation) because the tab switch and the
 * "measure this media first" refusal are the parts that break in integration.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../../../editor/useEditor.js';
import { SettingsProvider } from '../../../editor/useSettings.js';
import { Inspector } from '../../Inspector.js';
import { maskToolStore } from '../masks/useMaskTools.js';

afterEach(() => {
  localStorage.clear();
  maskToolStore.reset();
});

const MEASURED: Asset = {
  id: 'measured',
  path: 'media/measured.mp4',
  kind: 'video',
  media: { width: 1920, height: 1080 },
};

const UNMEASURED: Asset = { id: 'raw', path: 'media/raw.mp4', kind: 'video' };

const timeline: Timeline = {
  tracks: [
    {
      id: 'video',
      type: 'video',
      clips: [
        {
          id: 'graded',
          assetId: 'measured',
          trackId: 'video',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [
            { id: 'grade', type: 'color_grade', params: {}, keyframes: [] },
            { id: 'look', type: 'lut', params: { path: 'looks/a.cube' }, keyframes: [] },
          ],
          keyframes: [],
        },
        {
          id: 'unmeasured',
          assetId: 'raw',
          trackId: 'video',
          start: 4,
          end: 8,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [{ id: 'grade2', type: 'color_grade', params: {}, keyframes: [] }],
          keyframes: [],
        },
      ],
    },
  ],
} as unknown as Timeline;

function Host(): JSX.Element {
  const editor = useEditor(timeline, { assets: [MEASURED, UNMEASURED] });
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.select('graded')}>
        select graded clip
      </button>
      <button type="button" onClick={() => editor.select('unmeasured')}>
        select unmeasured clip
      </button>
      <Inspector editor={editor} />
    </SettingsProvider>
  );
}

const openEffects = (): void => {
  fireEvent.click(screen.getByRole('tab', { name: 'Effects' }));
};

describe('Inspector effect rows (MK5.1)', () => {
  it('offers "Add mask" on every effect row', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select graded clip' }));
    openEffects();
    expect(screen.getByRole('button', { name: 'Add mask to color grade' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add mask to lut' })).toBeTruthy();
  });

  it('arms the drawing tool for that effect and opens the Mask tab', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select graded clip' }));
    openEffects();
    fireEvent.click(screen.getByRole('button', { name: 'Add mask to lut' }));

    expect(maskToolStore.getState().pendingTarget).toEqual({ kind: 'effect', effectId: 'look' });
    expect(maskToolStore.getState().tool).toBe('rectangle');
    expect(screen.getByRole('tab', { name: 'Mask' }).getAttribute('aria-selected')).toBe('true');
  });

  it('refuses to arm a mask on media that was never measured', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select unmeasured clip' }));
    openEffects();
    const button = screen.getByRole('button', { name: 'Add mask to color grade' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(maskToolStore.getState().pendingTarget).toBeNull();
  });

  it('counts the masks already limiting an effect', () => {
    const masked = {
      ...timeline,
      tracks: [
        {
          ...timeline.tracks[0]!,
          clips: [
            {
              ...timeline.tracks[0]!.clips[0]!,
              masks: [
                {
                  id: 'm1',
                  kind: 'rectangle',
                  name: 'Face',
                  color: '#3b82f6',
                  enabled: true,
                  locked: false,
                  target: { kind: 'effect', effectId: 'grade' },
                  mode: 'add',
                  opacity: 1,
                  invert: false,
                  expansionPx: 0,
                  featherInnerPx: 0,
                  featherOuterPx: 0,
                  falloff: 'smooth',
                  featherModel: 'distance',
                  space: 'source',
                  keyframes: [],
                  cx: 900,
                  cy: 500,
                  width: 200,
                  height: 200,
                  rotation: 0,
                  roundness: 0,
                },
              ],
            },
            timeline.tracks[0]!.clips[1]!,
          ],
        },
      ],
    } as unknown as Timeline;
    function MaskedHost(): JSX.Element {
      const editor = useEditor(masked, { assets: [MEASURED, UNMEASURED] });
      return (
        <SettingsProvider>
          <button type="button" onClick={() => editor.select('graded')}>
            select graded clip
          </button>
          <Inspector editor={editor} />
        </SettingsProvider>
      );
    }
    render(<MaskedHost />);
    fireEvent.click(screen.getByRole('button', { name: 'select graded clip' }));
    openEffects();
    expect(screen.getByText('1 mask')).toBeTruthy();
  });

  it('adds a blur a mask can limit, and edits its strength in place', () => {
    let live: ReturnType<typeof useEditor> | null = null;
    function BlurHost(): JSX.Element {
      const editor = useEditor(timeline, { assets: [MEASURED, UNMEASURED] });
      live = editor;
      return (
        <SettingsProvider>
          <button type="button" onClick={() => editor.select('graded')}>
            select graded clip
          </button>
          <Inspector editor={editor} />
        </SettingsProvider>
      );
    }
    const blurOf = () =>
      live!.state.timeline.tracks[0]!.clips[0]!.effects.find((effect) => effect.type === 'blur');
    render(<BlurHost />);
    fireEvent.click(screen.getByRole('button', { name: 'select graded clip' }));
    openEffects();
    fireEvent.click(screen.getByRole('button', { name: 'Add blur' }));
    expect(blurOf()).toEqual({
      id: 'graded__blur',
      type: 'blur',
      params: { amount: 0.04 },
      keyframes: [],
    });
    // One blur per clip: the button goes, and the blur's row offers "Add mask" like any effect.
    expect(screen.queryByRole('button', { name: 'Add blur' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add mask to blur' })).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Blur strength' }), {
      target: { value: '10' },
    });
    expect(blurOf()?.params).toEqual({ amount: 0.1 });
    expect(blurOf()?.id).toBe('graded__blur');
  });
});
