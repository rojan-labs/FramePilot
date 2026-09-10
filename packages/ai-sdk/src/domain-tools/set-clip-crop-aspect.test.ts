/**
 * Run `df81d58e` (2026-09-08) replaced the correct auto 9:16 crop on all four clips with a
 * 1:1 square and was told "Reframed clip"; the export carried 420 px bars top and bottom.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { getTool } from '../tool-registry.js';
import type { ToolContext } from '../tool-context.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { makeProject } from '../__fixtures__/project.js';

const portrait = (media?: { width: number; height: number }): Project =>
  makeProject({
    resolution: { width: 1080, height: 1920 },
    assets: [
      { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30, ...(media ? { media } : {}) },
    ],
  });

const crop = (project: Project, args: Record<string, unknown>): unknown => {
  const tool = getTool('set_clip_crop');
  if (!tool || tool.kind !== 'mutate') throw new Error('not a mutate tool');
  return tool.buildOps({ clipId: 'clip_a', ...args }, { project } as unknown as ToolContext);
};

describe('set_clip_crop refuses a shape the renderer would letterbox', () => {
  it('names the bars, the ratio, and the frame-filling crop to move instead', () => {
    let thrown: unknown;
    try {
      crop(portrait({ width: 1920, height: 1080 }), {
        crop: { x: 0.21875, y: 0, width: 0.5625, height: 1 },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolRefusalError);
    const message = (thrown as Error).message;
    expect(message).toContain('1080×1080 px crop');
    expect(message).toContain('is 1:1, and the 1080×1920 frame is 9:16');
    expect(message).toContain('420 px of black above and below');
    expect(message).toMatch(/frame-filling crop of this source is width 0\.3164\d* × height 1/);
    expect(message).toMatch(/move x \(0–0\.6835\d*\)/);
    expect((thrown as ToolRefusalError).refusalCause).toBe('crop_letterboxes');
  });

  it('accepts the frame-filling crop, wherever x puts it', () => {
    const project = portrait({ width: 1920, height: 1080 });
    expect(() => crop(project, { crop: { x: 0.341797, y: 0, width: 0.316406, height: 1 } })).not.toThrow();
    expect(() => crop(project, { crop: { x: 0.6, y: 0, width: 0.316406, height: 1 } })).not.toThrow();
  });

  it('lets bars through when they are the intent, and clears a crop unconditionally', () => {
    const project = portrait({ width: 1920, height: 1080 });
    expect(() =>
      crop(project, { crop: { x: 0.21875, y: 0, width: 0.5625, height: 1 }, allowLetterbox: true }),
    ).not.toThrow();
    expect(crop(project, { crop: null })).toEqual([{ type: 'set_clip_crop', clipId: 'clip_a', crop: null }]);
  });

  it('cannot judge an unmeasured source, so it does not', () => {
    expect(() => crop(portrait(), { crop: { x: 0.21875, y: 0, width: 0.5625, height: 1 } })).not.toThrow();
  });

  it('names a pillarbox the other way round', () => {
    // A 9:16 crop of a portrait source into a landscape frame.
    const landscape = makeProject({
      assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30, media: { width: 1080, height: 1920 } }],
    });
    expect(() => crop(landscape, { crop: { x: 0, y: 0, width: 1, height: 1 } })).toThrow(
      /9:16, and the 1920×1080 frame is 16:9.*px of black left and right/,
    );
  });
});
