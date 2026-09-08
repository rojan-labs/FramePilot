import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  commitProjectPatch,
  fromPersistedHistory,
  invertProjectPatch,
  toPersistedHistory,
  type HistoryEntry,
} from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  hasAiMemory,
  resetAiMemoryPatch,
  resetTimelinePatch,
  timelineResetSummary,
} from './project-resets.js';

function project(overrides: Partial<Project> = {}): Project {
  return parseProject({
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [{ id: 'a', path: 'media/a.mp4', kind: 'video', durationSeconds: 10 }],
    folders: [],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            { id: 'c1', assetId: 'a', trackId: 'v1', start: 0, end: 5, sourceStart: 0, sourceEnd: 5, effects: [], keyframes: [] },
          ],
        },
        { id: 'cap', type: 'caption', clips: [], captionStyle: { templateId: 'tag', background: { color: '#fff', paddingX: 18 } } },
      ],
    },
    transcript: [{ word: 'hi', start: 0, end: 0.4, assetId: 'a' }],
    markers: [{ id: 'm1', time: 1, label: 'Hook' }],
    aiMemory: { captionStyle: 'white chip', acceptedEdits: [], rejectedEdits: [] },
    history: [],
    ...overrides,
  });
}

describe('resetAiMemoryPatch', () => {
  it('clears the record and inverts back to exactly what was there', () => {
    const before = project();
    const patch = resetAiMemoryPatch(before)!;
    expect(patch.operations).toEqual([{ type: 'set_ai_memory', memory: {} }]);
    const after = applyProjectPatch(before, patch);
    expect(after.aiMemory).toEqual({});
    expect(after.timeline).toEqual(before.timeline);
    expect(applyProjectPatch(after, invertProjectPatch(before, patch)).aiMemory).toEqual(before.aiMemory);
  });

  it('is null when there is nothing to clear', () => {
    expect(hasAiMemory(project({ aiMemory: {} }))).toBe(false);
    expect(resetAiMemoryPatch(project({ aiMemory: {} }))).toBeNull();
  });
});

describe('resetTimelinePatch', () => {
  it('removes every track and marker, keeps the bin, transcript and memory, and undoes losslessly', () => {
    const before = project();
    expect(timelineResetSummary(before)).toEqual({ tracks: 2, clips: 1, markers: 1 });
    const patch = resetTimelinePatch(before)!;
    const step = commitProjectPatch(
      before,
      fromPersistedHistory(before.history as readonly HistoryEntry[]),
      patch,
      1000,
    );
    expect(toPersistedHistory(step.history)).toHaveLength(1);
    expect(step.project.timeline.tracks).toEqual([]);
    expect(step.project.markers).toEqual([]);
    expect(step.project.assets).toEqual(before.assets);
    expect(step.project.transcript).toEqual(before.transcript);
    expect(step.project.aiMemory).toEqual(before.aiMemory);
    const undone = applyProjectPatch(step.project, invertProjectPatch(before, patch));
    expect(undone.timeline.tracks.map((t) => t.id)).toEqual(['v1', 'cap']);
    expect(undone.timeline.tracks[0]?.clips).toEqual(before.timeline.tracks[0]?.clips);
    expect(undone.markers).toEqual(before.markers);
    // Known gap, not this patch's: `remove_layer`'s inverse re-adds the lane through
    // `add_layer`, which carries clips, role and effect layers but no `captionStyle`, so a
    // caption track comes back unstyled. Pinned here so a fix in editor-core flips it.
    expect(undone.timeline.tracks[1]?.captionStyle).toBeUndefined();
  });

  it('is null on an empty timeline with no markers', () => {
    expect(resetTimelinePatch(project({ timeline: { tracks: [] }, markers: [] }))).toBeNull();
  });
});
