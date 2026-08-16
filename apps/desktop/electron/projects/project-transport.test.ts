import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { mergeLiveProjectForHost } from './project-transport.js';

const project = (id: string, name: string, history: Project['history']): Project => ({
  id,
  name,
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [],
  folders: [],
  markers: [],
  timeline: { tracks: [] },
  transcript: [],
  aiMemory: {},
  history,
});

describe('mergeLiveProjectForHost', () => {
  it('keeps host recovery history while accepting live renderer slices', () => {
    const history = [
      {
        patch: { patchId: 'p', operations: [] },
        inverse: { patchId: 'p:inverse', operations: [] },
        committedAt: 1,
      },
    ];
    const merged = mergeLiveProjectForHost(
      project('same', 'live name', []),
      project('same', 'host name', history),
    );

    expect(merged.name).toBe('live name');
    expect(merged.history).toBe(history);
  });

  it('does not borrow history from a different project', () => {
    const supplied = project('live', 'live', []);
    expect(mergeLiveProjectForHost(supplied, project('other', 'other', []))).toBe(supplied);
  });
});
