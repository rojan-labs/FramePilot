import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Patch } from '@framepilot/editor-core';
import { describeUnresolvableAssets, unresolvableAddedAssets } from './asset-paths.js';

const ROOT = process.cwd();
const PROJECT_FILE = path.join(ROOT, 'project.fp.json');

const patchWith = (...paths: string[]): Patch =>
  ({
    patchId: 'p1',
    operations: paths.map((p, i) => ({
      type: 'add_asset' as const,
      asset: { id: `asset_${i}`, path: p, kind: 'video' as const },
    })),
  }) as unknown as Patch;

/** Only this repo's own package.json is treated as present. */
const io = { exists: (absolute: string) => absolute === path.join(ROOT, 'package.json') };

describe('unresolvableAddedAssets', () => {
  it('passes a patch whose media is really on disk', () => {
    expect(unresolvableAddedAssets(patchWith('package.json'), PROJECT_FILE, ROOT, io)).toEqual([]);
  });

  // The captured fabrication: a well-formed relative media path for a file that was never
  // downloaded. The pure schema cannot see through this one — only the host can.
  it('catches a well-formed path that names nothing', () => {
    const problems = unresolvableAddedAssets(
      patchWith('stock/pexels/8474616.mp4'),
      PROJECT_FILE,
      ROOT,
      io,
    );
    expect(problems).toEqual([
      { assetId: 'asset_0', assetPath: 'stock/pexels/8474616.mp4', cause: 'missing' },
    ]);
  });

  it('refuses a path that resolves outside the projects root rather than widening it', () => {
    const problems = unresolvableAddedAssets(patchWith('/etc/hosts'), PROJECT_FILE, ROOT, io);
    expect(problems[0]?.cause).toBe('escapes_sandbox');
  });

  it('reports every bad asset in one pass, and ignores non-asset operations', () => {
    const patch = {
      patchId: 'p2',
      operations: [
        { type: 'add_asset', asset: { id: 'a', path: 'package.json', kind: 'video' } },
        { type: 'add_asset', asset: { id: 'b', path: 'nope.mp4', kind: 'video' } },
        { type: 'split_clip', clipId: 'c', at: 1 },
        { type: 'add_asset', asset: { id: 'c', path: 'also-nope.mp3', kind: 'audio' } },
      ],
    } as unknown as Patch;
    expect(unresolvableAddedAssets(patch, PROJECT_FILE, ROOT, io).map((p) => p.assetId)).toEqual([
      'b',
      'c',
    ]);
  });
});

describe('describeUnresolvableAssets', () => {
  it('names the files, so the user is not hunting a bin for something never in it', () => {
    const text = describeUnresolvableAssets([
      { assetId: 'b', assetPath: 'nope.mp4', cause: 'missing' },
      { assetId: 'c', assetPath: '/etc/hosts', cause: 'escapes_sandbox' },
    ]);
    expect(text).toContain('"nope.mp4"');
    expect(text).toContain('outside this project');
    expect(text).toContain('Nothing was changed');
  });
});
