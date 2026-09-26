/**
 * "Animation…" in a clip's menu opens the Inspector on that clip's Animation section, in view,
 * and puts the keyboard on its first control, so the next key edits the animation rather than
 * whatever was focused on the timeline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { Inspector } from './Inspector.js';

afterEach(() => localStorage.clear());

const ASSETS: Asset[] = [
  {
    id: 'element_fluent3d_fire',
    path: 'media/p/elements/fluent3d/fire.webp',
    kind: 'image',
    media: { width: 318, height: 318 },
    source: { provider: 'fluent-emoji', remoteId: 'fire' },
  } as Asset,
];

const timeline: Timeline = {
  tracks: [
    {
      id: 'o1',
      type: 'overlay',
      clips: [
        {
          id: 'st',
          assetId: 'element_fluent3d_fire',
          trackId: 'o1',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

function Host({ nonce }: { readonly nonce: number }): JSX.Element {
  const editor = useEditor(timeline, { assets: ASSETS, assetIds: ['element_fluent3d_fire'] });
  if (editor.state.selection !== 'st') editor.select('st');
  return (
    <SettingsProvider>
      <Inspector editor={editor} focusSection={{ id: 'animation', nonce }} />
    </SettingsProvider>
  );
}

describe('Inspector — focusSection', () => {
  it('focuses the In animation control once the Animation section is in view', async () => {
    render(<Host nonce={1} />);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'In animation' }));
  });
});
