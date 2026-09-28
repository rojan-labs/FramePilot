/**
 * The Transform section offers the stretch (scaleX/scaleY) beside the uniform scale: a zoom and a
 * squash stay separately editable, and an unanimated stretch is a base (time-0) value.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import { TransformPanel } from './TransformSection.js';

const clip: Clip = {
  id: 'c1',
  assetId: 'a',
  trackId: 'v',
  start: 0,
  end: 4,
  sourceStart: 0,
  sourceEnd: 4,
  effects: [],
  keyframes: [],
};

function renderPanel() {
  const timeline: Timeline = { tracks: [{ id: 'v', type: 'video', clips: [clip] }] };
  const applyPatch = vi.fn();
  const editor = { state: { timeline }, applyPatch, seek: vi.fn() } as unknown as UseEditor;
  render(<TransformPanel editor={editor} clip={clip} clipTime={1} />);
  return applyPatch;
}

describe('TransformPanel stretch', () => {
  it('shows Stretch X and Y at identity for an unstretched clip', () => {
    renderPanel();
    expect((screen.getByLabelText('scaleX') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('scaleY') as HTMLInputElement).value).toBe('1');
  });

  it('writes a stretch as its base value, one keyframe at time 0', () => {
    const applyPatch = renderPanel();
    fireEvent.change(screen.getByLabelText('scaleX'), { target: { value: '1.5' } });
    const [patch] = applyPatch.mock.calls[0]!;
    expect(patch.operations[0]).toMatchObject({
      type: 'add_keyframes',
      clipId: 'c1',
      keyframes: [{ time: 0, property: 'scaleX', value: 1.5 }],
    });
  });
});
