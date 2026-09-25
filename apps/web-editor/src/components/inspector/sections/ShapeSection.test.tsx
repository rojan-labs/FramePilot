/**
 * The Shape section (plan/elements EL4a): each control is one patch, a change that would leave
 * the shape drawing nothing is not applied and says why, and a segment shows its ends and caps.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { presetShapeParams, type Clip, type Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import { ShapeInspector } from './ShapeSection.js';

function shapeClip(presetId: string): Clip {
  return {
    id: 's1',
    assetId: '__shape__',
    trackId: 'o',
    start: 0,
    end: 3,
    sourceStart: 0,
    sourceEnd: 3,
    effects: [
      { id: 's1__shape', type: 'shape', params: presetShapeParams(presetId)!, keyframes: [] },
    ],
    keyframes: [],
  };
}

function editorWith(clip: Clip): { editor: UseEditor; applyPatch: ReturnType<typeof vi.fn> } {
  const timeline: Timeline = { tracks: [{ id: 'o', type: 'overlay', clips: [clip] }] };
  const applyPatch = vi.fn();
  return { editor: { state: { timeline }, applyPatch } as unknown as UseEditor, applyPatch };
}

describe('ShapeInspector', () => {
  it('changes the stroke colour as one set_effect_params patch, keeping its opacity', () => {
    const clip = shapeClip('rounded-rect/highlight');
    const { editor, applyPatch } = editorWith(clip);
    render(<ShapeInspector editor={editor} clip={clip} />);
    fireEvent.change(screen.getByLabelText('shape stroke color'), { target: { value: '#ff3b30' } });
    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch.mock.calls[0]![0].operations).toEqual([
      {
        type: 'set_effect_params',
        clipId: 's1',
        effectId: 's1__shape',
        params: { stroke: '#ff3b30' },
      },
    ]);
  });

  it('refuses to turn off the only paint, and says why', () => {
    const clip = shapeClip('rounded-rect/highlight');
    const { editor, applyPatch } = editorWith(clip);
    render(<ShapeInspector editor={editor} clip={clip} />);
    fireEvent.click(screen.getByLabelText('shape stroke'));
    expect(applyPatch).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(
      'A shape needs a fill or a stroke — with both off it draws nothing.',
    );
  });

  it('keeps a translucent fill translucent when its colour changes', () => {
    const clip = shapeClip('marker-highlight/yellow');
    const { editor, applyPatch } = editorWith(clip);
    render(<ShapeInspector editor={editor} clip={clip} />);
    fireEvent.change(screen.getByLabelText('shape fill color'), { target: { value: '#34c759' } });
    expect(applyPatch.mock.calls[0]![0].operations[0].params).toEqual({ fill: '#34c75966' });
  });

  it('shows a segment its ends and caps, and no fill', () => {
    const clip = shapeClip('line-arrow/red');
    const { editor } = editorWith(clip);
    render(<ShapeInspector editor={editor} clip={clip} />);
    expect(screen.queryByLabelText('shape fill')).toBeNull();
    expect(screen.getByLabelText('shape end cap')).toBeDefined();
    expect(screen.getByLabelText('shape x2')).toBeDefined();
    expect(screen.getByLabelText('shape head size')).toBeDefined();
  });

  it('shows a box its corners and box, and no caps', () => {
    const clip = shapeClip('rounded-rect/filled');
    const { editor } = editorWith(clip);
    render(<ShapeInspector editor={editor} clip={clip} />);
    expect(screen.getByLabelText('shape corners')).toBeDefined();
    expect(screen.getByLabelText('shape width')).toBeDefined();
    expect(screen.queryByLabelText('shape end cap')).toBeNull();
  });
});
