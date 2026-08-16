/**
 * Branch coverage for component paths the demo project doesn't exercise: the
 * toolbar's validation-issue list (surfaced as a toast), and the inspector's
 * transform/effects read-outs for a clip that actually has keyframes/effects.
 * Export lives in the header (Topbar) now, covered by App.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Patch } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { Toolbar } from './Toolbar.js';
import { Toasts } from './Toasts.js';
import { Inspector } from './Inspector.js';

const richTimeline: Timeline = {
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [
        {
          id: 'clip_a',
          assetId: 'asset_a',
          trackId: 'video_1',
          start: 0,
          end: 5,
          sourceStart: 0,
          sourceEnd: 5,
          effects: [{ id: 'fx_1', type: 'color_grade', params: {}, keyframes: [] }],
          keyframes: [{ id: 'kf_1', time: 1, property: 'scale', value: 1.2, easing: 'linear' }],
        },
      ],
    },
  ],
};

/** Invalid patch (trims a clip that does not exist) → populates `issues`. */
const badPatch: Patch = {
  patchId: 'bad' as Patch['patchId'],
  createdBy: 'user',
  reason: 'invalid',
  operations: [{ type: 'trim_clip', clipId: 'missing', start: 0, end: 1 }],
};

describe('Toolbar rejected-edit toast', () => {
  it('surfaces a rejected patch as an error toast', () => {
    function Host(): JSX.Element {
      const editor = useEditor(richTimeline);
      return (
        <div>
          <button type="button" onClick={() => editor.applyPatch(badPatch)}>
            break
          </button>
          <Toolbar editor={editor} />
          <Toasts editor={editor} />
        </div>
      );
    }
    render(<Host />);

    // A rejected edit no longer shows an inline list — it raises a toast.
    fireEvent.click(screen.getByRole('button', { name: 'break' }));
    const toasts = screen.getByLabelText('notifications');
    expect(toasts.querySelector('.toast.is-error')).not.toBeNull();
  });
});

describe('Inspector transform/effects read-outs', () => {
  it('surfaces the animation and effects of the selected clip', () => {
    function Host(): JSX.Element {
      const editor = useEditor(richTimeline);
      return (
        <div>
          <button type="button" onClick={() => editor.select('clip_a')}>
            pick
          </button>
          <Inspector editor={editor} />
        </div>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));

    const inspector = screen.getByLabelText('inspector');
    // Revamp Phase 5 replaced the read-only keyframe dump with real property rows:
    // the clip's single scale keyframe now shows as scale being animated, and the
    // scale field reads the curve (a lone keyframe holds its value everywhere).
    expect(screen.getByLabelText('animated properties').textContent).toContain('scale');
    expect((screen.getByLabelText('scale') as HTMLInputElement).value).toBe('1.2');
    expect(inspector.textContent).toContain('color_grade');
  });
});
