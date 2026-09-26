/**
 * The Inspector's Animation section (plan/elements EL7.1, 02 §4): In, Out and Loop for a sticker,
 * shape or title, each a preset and a duration (a loop: its speed and how far it moves). Every
 * change is one undoable edit through editor-core's element-animation builder, the one the
 * assistant's set_element_animation uses.
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clipAnimation } from '@framepilot/editor-core';
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import { useEditor, type UseEditor } from '../../../editor/useEditor.js';
import { AnimationInspector } from './AnimationSection.js';

const FRAME = { width: 1920, height: 1080 } as const;

const ASSETS: Asset[] = [
  { id: 'land', path: 'media/land.mp4', kind: 'video', durationSeconds: 10 } as Asset,
  {
    id: 'element_fluent3d_fire',
    path: 'media/p/elements/fluent3d/fire.webp',
    kind: 'image',
    media: { width: 318, height: 318 },
    source: { provider: 'fluent-emoji', remoteId: 'fire' },
  } as Asset,
];

function sticker(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'st',
    assetId: 'element_fluent3d_fire',
    trackId: 'o1',
    start: 1,
    end: 5,
    sourceStart: 0,
    sourceEnd: 4,
    effects: [],
    keyframes: [{ id: 'kf_st_scale', time: 0, property: 'scale', value: 0.4, easing: 'linear' }],
    ...extra,
  };
}

const timelineWith = (clip: Clip): Timeline => ({
  tracks: [
    { id: 'o1', type: 'overlay', clips: [clip] },
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'bg',
          assetId: 'land',
          trackId: 'v1',
          start: 0,
          end: 8,
          sourceStart: 0,
          sourceEnd: 8,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
});

let editor: UseEditor;

function Host({ initial }: { readonly initial: Timeline }): JSX.Element {
  editor = useEditor(initial, { assets: ASSETS });
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  return <AnimationInspector editor={editor} clip={clip} resolution={FRAME} />;
}

const current = () => clipAnimation(editor.state.timeline.tracks[0]!.clips[0]!);

function pick(combobox: string, option: string): void {
  act(() => {
    fireEvent.click(screen.getByRole('combobox', { name: combobox }));
  });
  act(() => {
    fireEvent.click(screen.getByRole('option', { name: option }));
  });
}

describe('AnimationInspector', () => {
  it('sets an entrance, its length, and an exit, each one undoable edit', () => {
    render(<Host initial={timelineWith(sticker())} />);
    pick('In animation', 'Pop');
    expect(current().in?.kind).toBe('pop');
    const seconds = screen.getByLabelText('In duration');
    act(() => {
      fireEvent.change(seconds, { target: { value: '0.8' } });
      fireEvent.blur(seconds);
    });
    expect(current().in).toEqual({ kind: 'pop', seconds: 0.8 });
    pick('Out animation', 'Slide left');
    expect(current().out?.kind).toBe('slide-left');
    act(() => editor.undo());
    expect(current().out).toBeNull();
    act(() => editor.undo());
    act(() => editor.undo());
    expect(current().in).toBeNull();
  });

  it('removes an end with None', () => {
    render(<Host initial={timelineWith(sticker())} />);
    pick('In animation', 'Fade');
    pick('In animation', 'None');
    expect(current().in).toBeNull();
  });

  it('loops, changes how fast and how far, and re-applies a loop its clip has outgrown', () => {
    render(<Host initial={timelineWith(sticker())} />);
    pick('Loop animation', 'Pulse');
    expect(current().loop).toMatchObject({ preset: 'pulse', coversClip: true });
    const speed = screen.getByLabelText('Loop period');
    act(() => {
      fireEvent.change(speed, { target: { value: '2' } });
      fireEvent.blur(speed);
    });
    expect(current().loop?.periodSeconds).toBe(2);
    expect(screen.queryByRole('button', { name: 'Re-apply the loop' })).toBeNull();
  });

  it('offers Re-apply when the clip is longer than its loop', () => {
    const outgrown = timelineWith(sticker());
    render(<Host initial={outgrown} />);
    pick('Loop animation', 'Wiggle');
    // Lengthen the clip past its loop, as a trim would.
    const clip = editor.state.timeline.tracks[0]!.clips[0]!;
    act(() => {
      editor.applyPatch({
        patchId: 'extend' as never,
        createdBy: 'user',
        reason: 'Extend',
        operations: [{ type: 'trim_clip', clipId: clip.id, start: clip.start, end: clip.end + 3 }],
      });
    });
    expect(current().loop?.coversClip).toBe(false);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-apply the loop' }));
    });
    expect(current().loop).toMatchObject({ preset: 'wiggle', coversClip: true });
  });

  it('says why a loop cannot be set, in the builder’s words', () => {
    render(
      <Host
        initial={timelineWith(
          sticker({
            keyframes: [
              ...sticker().keyframes,
              { id: 'kf_grow', time: 2, property: 'scale', value: 0.8, easing: 'linear' },
            ],
          }),
        )}
      />,
    );
    pick('Loop animation', 'Pulse');
    expect(screen.getByRole('status').textContent).toContain('already animated');
    expect(current().loop).toBeNull();
  });
});
