/**
 * What a wrong track id is told.
 *
 * It is almost always a typo on an id the author has already read. Run `25e06a6f` asked
 * twice for `captains_main` on a project whose only caption track is `captions_main` — once
 * through `caption_the_edit`, once through `set_track_caption_style` — and lost the turn to
 * it. One message said "use get_timeline to list real ids"; the other said "Track not
 * found: captains_main" and nothing else. Both had the real ids in hand.
 */
import { describe, expect, it } from 'vitest';
import { applyOperation } from '@framepilot/editor-core';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { operationsForCall } from './tool-dispatch.js';
import type { ToolContext } from './tool-context.js';

const timeline: Timeline = {
  tracks: [
    { id: 'v_main', type: 'video', clips: [] },
    { id: 'captions_main', type: 'caption', clips: [] },
    { id: 't_motion_gfx', type: 'overlay', clips: [] },
  ],
} as unknown as Timeline;

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [],
    folders: [],
    timeline,
    transcript: [{ word: 'hi', start: 0, end: 0.4, assetId: 'a' }],
    markers: [],
    aiMemory: {},
    history: [],
    ...over,
  }) as unknown as Project;

const ctx = (p: Project = project()): ToolContext => ({ project: p }) as unknown as ToolContext;

describe('a caption tool handed a track id that does not exist', () => {
  it('names the caption tracks instead of sending the model to look them up', () => {
    expect(() =>
      operationsForCall(
        { id: '1', name: 'caption_the_edit', arguments: { trackId: 'captains_main' } },
        ctx(),
      ),
    ).toThrow(/The caption track in this project: captions_main\./);
  });

  it('says so when there is no caption track at all, and how to make one', () => {
    const bare = project({
      timeline: { tracks: [{ id: 'v_main', type: 'video', clips: [] }] } as unknown as Timeline,
    });
    expect(() =>
      operationsForCall(
        { id: '1', name: 'caption_the_edit', arguments: { trackId: 'captions_main' } },
        ctx(bare),
      ),
    ).toThrow(/no caption track yet/);
  });

  it('names them when a REAL track of the wrong type is passed', () => {
    expect(() =>
      operationsForCall(
        { id: '1', name: 'caption_the_edit', arguments: { trackId: 'v_main' } },
        ctx(),
      ),
    ).toThrow(/not a caption track\. The caption track in this project: captions_main\./);
  });
});

describe('an operation handed a track id that does not exist', () => {
  it('names the tracks the timeline has', () => {
    // `set_track_caption_style` reached the operations layer and came back "Track not
    // found: captains_main" with nothing else at all.
    expect(() =>
      applyOperation(timeline, {
        type: 'set_track_caption_style',
        trackId: 'captains_main',
        captionStyle: { templateId: 'boxed' },
      } as never),
    ).toThrow(/v_main, captions_main, t_motion_gfx/);
  });
});
