/**
 * Perf guard: the DOM monitor owns captions, overlay layout, keyframe evaluation,
 * transition envelopes, clip lookup and transport chrome. Subscribing that whole
 * component to the raw display-rate clock makes a 30 fps project commit four times
 * per frame on a 120 Hz display. The raw clock stays inside the small imperative
 * leaves (PreviewTransport's live scrubber, PreviewAudioMixer's meters); the heavy
 * React owner reads the project-frame snapshot instead.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useEditor, useFramePlayhead, usePlayhead } from '../editor/useEditor.js';

const FPS = 30;

describe('project-frame playhead cadence', () => {
  it('yields one snapshot per project frame while the raw clock ticks at display rate', () => {
    const { result: editorResult } = renderHook(() => useEditor({ tracks: [] }, []));
    const editor = editorResult.current;

    let frameRenders = 0;
    let rawRenders = 0;
    const { result: framed } = renderHook(() => {
      frameRenders += 1;
      return useFramePlayhead(editor, FPS);
    });
    renderHook(() => {
      rawRenders += 1;
      return usePlayhead(editor);
    });

    const baselineFrame = frameRenders;
    const baselineRaw = rawRenders;

    // Four 120 Hz ticks that all land inside project frame 30 (1.000s–1.033s).
    for (const time of [1.0, 1.008, 1.016, 1.024]) {
      act(() => editor.seekTransient(time));
    }

    // The raw subscriber sees every tick; the frame subscriber sees one.
    expect(rawRenders - baselineRaw).toBe(4);
    expect(frameRenders - baselineFrame).toBe(1);
    expect(framed.current).toBeCloseTo(1.0, 5);

    // Crossing the frame boundary is the tick that must re-render.
    act(() => editor.seekTransient(1.0 + 1 / FPS));
    expect(framed.current).toBeCloseTo(1.0 + 1 / FPS, 5);
  });

  it('keeps the DOM monitor on the project-frame clock', () => {
    // Structural guard: which hook PreviewPlayer subscribes to is the regression
    // itself, and it cannot be observed from the rendered tree — the component's
    // own commits are indistinguishable from its raw-clock leaves' commits.
    const source = readFileSync(resolve(__dirname, 'PreviewPlayer.tsx'), 'utf8');
    expect(source).toContain('const playhead = useFramePlayhead(editor, fps);');
    expect(source).not.toContain('const playhead = usePlayhead(editor);');
  });
});
