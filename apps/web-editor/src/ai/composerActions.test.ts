/**
 * Tests for composer power data (Phase 11 M8): slash-command filtering, the slash
 * query guard, and project-derived context items.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  SLASH_COMMANDS,
  buildContextItems,
  filterAtEntities,
  filterSlashCommands,
  isAtQuery,
  isSlashQuery,
  pinnableEntities,
  removeAtQuery,
} from './composerActions.js';

const project = (over: Record<string, unknown> = {}): Project =>
  parseProject({
    id: 'p',
    name: 'Demo',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [],
    timeline: { tracks: [] },
    transcript: [],
    aiMemory: {},
    history: [],
    ...over,
  });

describe('isSlashQuery / filterSlashCommands', () => {
  it('detects an active slash query (no whitespace yet)', () => {
    expect(isSlashQuery('/cap')).toBe(true);
    expect(isSlashQuery('/add-captions ')).toBe(false);
    expect(isSlashQuery('hello')).toBe(false);
  });

  it('filters commands by the query and returns all for a bare slash', () => {
    expect(filterSlashCommands('/').length).toBe(SLASH_COMMANDS.length);
    expect(filterSlashCommands('/silence').map((c) => c.name)).toEqual(['remove-silence']);
    expect(filterSlashCommands('not a slash')).toEqual([]);
  });
});

describe('buildContextItems', () => {
  it('lists timeline + project always, transcript/assets when present', () => {
    expect(buildContextItems(project()).map((i) => i.id)).toEqual(['timeline', 'project']);
    const rich = buildContextItems(
      project({
        assets: [{ id: 'a1', path: 'a.mp4', kind: 'video', durationSeconds: 10 }],
        transcript: [{ word: 'hi', start: 0, end: 1 }],
      }),
    );
    expect(rich.map((i) => i.id)).toEqual(['timeline', 'project', 'transcript', 'assets']);
  });

  it('shows each remembered decision as its own removable chip after the project chip (P8.2)', () => {
    const items = buildContextItems(
      project(),
      undefined,
      [],
      [
        { key: 'captionStyle', label: 'caption style', value: 'bold yellow' },
        { key: 'preferredPacing', label: 'pacing', value: 'fast' },
      ],
    );
    expect(items.map((i) => i.id)).toEqual([
      'timeline',
      'project',
      'memory:captionStyle',
      'memory:preferredPacing',
    ]);
    expect(items[2]).toEqual({
      id: 'memory:captionStyle',
      kind: 'memory',
      label: 'Remembers caption style: bold yellow',
    });
  });

  it('omits the selection chip with no selection (never claims context the AI does not get)', () => {
    expect(buildContextItems(project()).some((i) => i.id === 'selection')).toBe(false);
  });

  it('prepends a removable "Selected" chip when a live selection is given (P8.4/P12.7)', () => {
    const items = buildContextItems(project(), {
      range: { start: 12, end: 18 },
      clipCount: 2,
    });
    expect(items[0]).toEqual({
      id: 'selection',
      kind: 'selection',
      label: 'Selected: 2 clips, 12–18s',
    });
    // Still ahead of the always-present chips.
    expect(items.map((i) => i.id)).toEqual(['selection', 'timeline', 'project']);
  });

  it('singularises the label for a one-clip selection', () => {
    const items = buildContextItems(project(), { range: { start: 1, end: 2 }, clipCount: 1 });
    expect(items[0]?.label).toBe('Selected: 1 clip, 1–2s');
  });

  it('rounds the range to 1 decimal', () => {
    const items = buildContextItems(project(), {
      range: { start: 1.234, end: 5.678 },
      clipCount: 1,
    });
    expect(items[0]?.label).toBe('Selected: 1 clip, 1.2–5.7s');
  });

  it('adds one removable chip per pinned entity, right after the selection chip (P8.7)', () => {
    const items = buildContextItems(project(), { range: { start: 1, end: 2 }, clipCount: 1 }, [
      { kind: 'clip', id: 'c1', label: 'intro.mp4 0–5s' },
      { kind: 'asset', id: 'a2', label: 'broll.mp4' },
    ]);
    expect(items.map((i) => i.id)).toEqual([
      'selection',
      'pin:clip:c1',
      'pin:asset:a2',
      'timeline',
      'project',
    ]);
    expect(items[1]).toEqual({ id: 'pin:clip:c1', kind: 'pinned-clip', label: 'intro.mp4 0–5s' });
    expect(items[2]).toEqual({ id: 'pin:asset:a2', kind: 'pinned-asset', label: 'broll.mp4' });
  });

  it('renders pinned chips with no selection too', () => {
    const items = buildContextItems(project(), undefined, [
      { kind: 'asset', id: 'a1', label: 'clip.mp4' },
    ]);
    expect(items.map((i) => i.id)).toEqual(['pin:asset:a1', 'timeline', 'project']);
  });
});

describe('pinnableEntities / isAtQuery / filterAtEntities / removeAtQuery', () => {
  const richProject = () =>
    project({
      assets: [
        { id: 'a1', path: '/media/intro.mp4', kind: 'video', durationSeconds: 10 },
        { id: 'a2', path: '/media/broll.mp4', kind: 'video', durationSeconds: 20 },
      ],
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'c1',
                assetId: 'a1',
                trackId: 'video_1',
                start: 0,
                end: 5,
                sourceStart: 0,
                sourceEnd: 5,
              },
            ],
          },
        ],
      },
    });

  it('lists every clip then every asset, labelled with the asset filename', () => {
    const entities = pinnableEntities(richProject());
    expect(entities).toEqual([
      { kind: 'clip', id: 'c1', label: 'intro.mp4 0–5s' },
      { kind: 'asset', id: 'a1', label: 'intro.mp4' },
      { kind: 'asset', id: 'a2', label: 'broll.mp4' },
    ]);
  });

  it('detects an active "@" query (trailing token, not yet followed by whitespace)', () => {
    expect(isAtQuery('@in')).toBe(true);
    expect(isAtQuery('tighten @bro')).toBe(true);
    expect(isAtQuery('tighten @broll ')).toBe(false);
    expect(isAtQuery('no at sign here')).toBe(false);
    expect(isAtQuery('email me@x.com')).toBe(false);
  });

  it('filters entities by the trailing query, case-insensitively; bare "@" returns all', () => {
    const entities = pinnableEntities(richProject());
    expect(filterAtEntities('@', entities)).toEqual(entities);
    expect(filterAtEntities('use @BROLL', entities).map((e) => e.id)).toEqual(['a2']);
    expect(filterAtEntities('no query', entities)).toEqual([]);
  });

  it('removes the trailing @query token, leaving the rest of the message intact', () => {
    expect(removeAtQuery('tighten @bro')).toBe('tighten');
    expect(removeAtQuery('@bro')).toBe('');
    expect(removeAtQuery('use @broll then trim')).toBe('use @broll then trim');
  });
});
