/**
 * PX5.5 — playback presents the export's frame: the plan at `k / fps` for the project frame on
 * screen, never the audio clock's continuous instant.
 *
 * The engine half, `engine/python/tests/test_export_frame_grid.py`, proves the export reads
 * `frame_plan_at(k / fps)`'s source frame at project frame `k`, and pins the numbers for a
 * 60 fps source in a 30 fps project (every other source frame: 60, 62, …, 178). The frame-plan
 * parity vectors prove `framePlanAt` equals `frame_plan_at` at any time. This file closes the
 * chain: at every display refresh inside frame `k` (60 Hz and 144 Hz ticks, and a tick a hair
 * before the next boundary), the snapped plan names exactly those frames.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { framePlanAt } from '@framepilot/editor-core';
import { ProjectSchema } from '@framepilot/timeline-schema';
import { projectFrameIndex, projectFrameTime } from './project-frame.js';

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the workspace root.');
    dir = parent;
  }
  return dir;
}

interface TimeCase {
  readonly id: string;
  readonly probe: { readonly fps: Readonly<Record<string, number>> };
  readonly project: unknown;
}

function mixedFrameRates(): TimeCase {
  const file = path.join(repoRoot(), 'tests', 'fixtures', 'frame-plan', 'time.json');
  const document = JSON.parse(readFileSync(file, 'utf8')) as { cases: readonly TimeCase[] };
  const found = document.cases.find((c) => c.id === 'mixed-frame-rates');
  if (!found) throw new Error('mixed-frame-rates vector missing');
  return found;
}

describe('projectFrameIndex / projectFrameTime', () => {
  it('names the frame on screen and the instant the export composites it', () => {
    expect(projectFrameIndex(0, 30)).toBe(0);
    expect(projectFrameIndex(1 / 30 - 1e-4, 30)).toBe(0);
    expect(projectFrameIndex(1 / 30, 30)).toBe(1);
    expect(projectFrameTime(0.049, 30)).toBe(1 / 30);
    expect(projectFrameTime(1.0 + 1 / 60, 30)).toBe(30 / 30);
    // The export divides k by fps; the snapped time is that quotient, bit for bit.
    expect(projectFrameTime(12.3456, 29.97)).toBe(Math.floor(12.3456 * 29.97 + 1e-6) / 29.97);
  });

  it('clamps a rate below 1 and a time before 0', () => {
    expect(projectFrameTime(0.5, 0)).toBe(0);
    expect(projectFrameTime(-0.2, 30)).toBe(0);
  });

  it('is idempotent: a snapped time snaps to itself', () => {
    for (let k = 0; k < 5_400; k++) {
      const t = k / 30;
      expect(projectFrameTime(t, 30)).toBe(t);
      expect(projectFrameIndex(t, 30)).toBe(k);
    }
  });
});

describe('a 60 fps source in a 30 fps project plays the export frames', () => {
  const vector = mixedFrameRates();
  const project = ProjectSchema.parse(vector.project);
  const sourceFps = { ...vector.probe.fps, land: 60 };
  const fps = project.fps;
  const frameOf = (t: number): number | null => {
    const plan = framePlanAt(project.timeline, project.assets, t, project.resolution, {
      sourceFps,
    });
    return plan.layers.find((layer) => layer.clipId === 'c2')?.source?.frame ?? null;
  };

  it('presents every other source frame, the ones the export renders', () => {
    const presented: number[] = [];
    for (let k = 0; k < 60; k++) {
      const ticks = [0, 1 / 144, 1 / 60, 2 / 144, 3 / 144, 1 / fps - 1e-4].map((d) => k / fps + d);
      const frames = new Set(ticks.map((t) => frameOf(projectFrameTime(t, fps))));
      expect([...frames], `project frame ${k}`).toHaveLength(1);
      presented.push([...frames][0]!);
    }
    // engine/python/tests/test_export_frame_grid.py: the export reads 60, 62, …, 178.
    expect(presented).toEqual(Array.from({ length: 60 }, (_, k) => 60 + 2 * k));
  });

  it('would have shown the frames in between at the continuous clock (the old behaviour)', () => {
    expect(frameOf(1 / 60 + 1e-4)).toBe(61);
    expect(frameOf(projectFrameTime(1 / 60 + 1e-4, fps))).toBe(60);
  });
});
