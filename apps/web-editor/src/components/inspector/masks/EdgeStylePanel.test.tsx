/**
 * Cut-out edge styles in the Mask tab (MK9.2): each control is one undoable
 * `set_clip_edge_style` edit, and the section appears only when there is a cut-out to trace.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MaskLayerSchema, type Asset, type Timeline } from '@framepilot/timeline-schema';
import { useEditor, type UseEditor } from '../../../editor/useEditor.js';
import { EdgeStylePanel, showsEdgeStyles } from './EdgeStylePanel.js';

const ASSETS: Asset[] = [
  {
    id: 'a1',
    path: 'media/a1.mp4',
    kind: 'video',
    durationSeconds: 10,
    media: { width: 1920, height: 1080 },
  } as Asset,
];

function timeline(masked: boolean): Timeline {
  return {
    revision: 0,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId: 'a1',
            trackId: 'v1',
            start: 0,
            end: 10,
            sourceStart: 0,
            sourceEnd: 10,
            effects: [],
            keyframes: [],
            ...(masked
              ? {
                  masks: [
                    MaskLayerSchema.parse({
                      kind: 'ellipse',
                      id: 'm1',
                      cx: 960,
                      cy: 540,
                      rx: 300,
                      ry: 400,
                    }),
                  ],
                }
              : {}),
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

let editor: UseEditor;

function Host({ initial }: { readonly initial: Timeline }): JSX.Element {
  editor = useEditor(initial, { assets: ASSETS });
  return <EdgeStylePanel editor={editor} clip={editor.state.timeline.tracks[0]!.clips[0]!} />;
}

const styles = () =>
  editor.state.timeline.tracks[0]!.clips[0]!.effects.filter((e) => e.type === 'edge_style');

describe('edge style panel', () => {
  it('is hidden until the clip has a cut-out to trace', () => {
    render(<Host initial={timeline(false)} />);
    expect(screen.queryByRole('group', { name: 'Edge style' })).toBeNull();
  });

  it('shows for a photo, a sticker or a title with no mask: its own alpha is the cut-out', () => {
    expect(showsEdgeStyles(timeline(false).tracks[0]!.clips[0]!, false)).toBe(false);
    expect(showsEdgeStyles(timeline(false).tracks[0]!.clips[0]!, true)).toBe(true);
    const still = [{ ...ASSETS[0]!, id: 'a1', kind: 'image', path: 'media/a1.webp' } as Asset];
    function StillHost(): JSX.Element {
      editor = useEditor(timeline(false), { assets: still });
      return <EdgeStylePanel editor={editor} clip={editor.state.timeline.tracks[0]!.clips[0]!} />;
    }
    render(<StillHost />);
    expect(screen.getByRole('group', { name: 'Edge style' })).toBeTruthy();
  });

  it('turns an outline on, edits it and turns it off, one undo step each', () => {
    render(<Host initial={timeline(true)} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Outline around the cut-out' }));
    expect(styles()).toHaveLength(1);
    expect(styles()[0]!.params).toMatchObject({ kind: 'stroke', widthPx: 8, red: 255 });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Outline width' }), {
      target: { value: '14' },
    });
    expect(styles()[0]!.params.widthPx).toBe(14);
    fireEvent.change(screen.getByLabelText('Outline colour'), { target: { value: '#ff0080' } });
    expect(styles()[0]!.params).toMatchObject({ red: 255, green: 0, blue: 128, widthPx: 14 });
    const edits = editor.history.entries.length;
    fireEvent.click(screen.getByRole('switch', { name: 'Outline around the cut-out' }));
    expect(styles()).toHaveLength(0);
    expect(editor.history.entries.length).toBe(edits + 1);
  });

  it('applies a preset as a complete setting', () => {
    render(<Host initial={timeline(true)} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Shadow around the cut-out' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Shadow preset' }));
    fireEvent.click(screen.getByRole('option', { name: 'Hard Shadow' }));
    expect(styles()[0]!.params).toMatchObject({ kind: 'shadow', softnessPx: 0, opacity: 0.85 });
  });
});
