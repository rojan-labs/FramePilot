import { describe, expect, it } from 'vitest';
import { parseProject, safeParseProject } from '@framepilot/timeline-schema';
import {
  DEFAULT_FPS,
  DEFAULT_RESOLUTION,
  addAsset,
  assetIdsOf,
  ensureBaseTracks,
  newProject,
  newProjectFromVideo,
  removeAsset,
  uniqueProjectId,
} from './project.js';

describe('newProject', () => {
  it('builds a schema-valid empty project with a slugged id and defaults', () => {
    const project = newProject('My First Short!');
    expect(safeParseProject(project).success).toBe(true);
    expect(project.id).toBe('project_my_first_short');
    expect(project.name).toBe('My First Short!');
    expect(project.fps).toBe(DEFAULT_FPS);
    expect(project.resolution).toEqual(DEFAULT_RESOLUTION);
    // A fresh project starts with no tracks (CapCut-style): tracks are created
    // on demand by placeAssetPatch when assets are dropped onto the timeline.
    expect(project.timeline.tracks).toEqual([]);
  });

  it('falls back to an "untitled" slug when the name has no usable characters', () => {
    expect(newProject('   ').id).toBe('project_untitled');
  });

  it('honors an explicit id so same-named projects never share storage', () => {
    const project = newProject('Wedding', { id: 'project_wedding_abc123' });
    expect(project.id).toBe('project_wedding_abc123');
    expect(safeParseProject(project).success).toBe(true);
  });

  it('honors fps and resolution overrides', () => {
    const project = newProject('Wide', { fps: 24, resolution: { width: 1920, height: 1080 } });
    expect(project.fps).toBe(24);
    expect(project.resolution).toEqual({ width: 1920, height: 1080 });
  });
});

describe('uniqueProjectId', () => {
  it('keeps the readable slug and appends a unique suffix', () => {
    const id = uniqueProjectId('My Wedding!', 1_700_000_000_000, () => 0.5);
    expect(id.startsWith('project_my_wedding_')).toBe(true);
    expect(id.length).toBeGreaterThan('project_my_wedding_'.length);
  });

  it('differs for two projects created with the same name', () => {
    const first = uniqueProjectId('Same', 1_700_000_000_000, () => 0.1);
    const second = uniqueProjectId('Same', 1_700_000_000_000, () => 0.9);
    expect(first).not.toBe(second);
  });

  it('stays a file-name-safe slug even for a hostile name', () => {
    const id = uniqueProjectId('../../etc/passwd', 1_700_000_000_000, () => 0.5);
    expect(id).toMatch(/^project_[a-z0-9_]+$/);
  });
});

describe('newProjectFromVideo', () => {
  it('seeds one video asset and a single video track with a clip spanning the source', () => {
    const project = newProjectFromVideo('Trip', {
      path: '/media/trip.mp4',
      durationSeconds: 12.5,
    });
    expect(safeParseProject(project).success).toBe(true);
    expect(project.assets).toEqual([
      { id: 'asset_trip', path: '/media/trip.mp4', kind: 'video', durationSeconds: 12.5 },
    ]);
    // Only one track is created — no empty overlay/caption/audio lanes pre-seeded.
    expect(project.timeline.tracks).toHaveLength(1);
    expect(project.timeline.tracks[0]).toMatchObject({ id: 'video_1', type: 'video' });
    const clip = project.timeline.tracks[0]?.clips[0];
    expect(clip).toMatchObject({ assetId: 'asset_trip', start: 0, end: 12.5, sourceEnd: 12.5 });
  });
});

describe('ensureBaseTracks', () => {
  it('is a no-op: returns the project unchanged (tracks are created on demand)', () => {
    const project = newProject('Complete');
    expect(ensureBaseTracks(project)).toBe(project);
  });

  it('leaves an existing project with tracks untouched', () => {
    const partial = parseProject({
      id: 'project_partial',
      name: 'Partial',
      version: 1,
      fps: DEFAULT_FPS,
      resolution: DEFAULT_RESOLUTION,
      assets: [],
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
      transcript: [],
      aiMemory: {},
      history: [],
    });
    const result = ensureBaseTracks(partial);
    // No new tracks appended — function is a no-op.
    expect(result).toBe(partial);
    expect(result.timeline.tracks).toHaveLength(1);
  });
});

describe('removeAsset', () => {
  it('drops the matching asset and re-validates, leaving others intact', () => {
    const seeded = addAsset(
      addAsset(newProject('Bin'), { id: 'asset_a', path: 'blob:a', kind: 'video' }),
      { id: 'asset_b', path: 'blob:b', kind: 'audio' },
    );
    const next = removeAsset(seeded, 'asset_a');
    expect(safeParseProject(next).success).toBe(true);
    expect(assetIdsOf(next)).toEqual(['asset_b']);
  });

  it('is a no-op (validated copy) when the asset id is unknown', () => {
    const project = addAsset(newProject('Bin'), { id: 'asset_a', path: 'blob:a', kind: 'video' });
    expect(assetIdsOf(removeAsset(project, 'asset_missing'))).toEqual(['asset_a']);
  });
});

describe('assetIdsOf', () => {
  it('lists the asset ids referenced by a project', () => {
    const project = newProjectFromVideo('Trip', { path: '/m.mp4', durationSeconds: 5 });
    expect(assetIdsOf(project)).toEqual(['asset_trip']);
    expect(assetIdsOf(newProject('Empty'))).toEqual([]);
  });
});
