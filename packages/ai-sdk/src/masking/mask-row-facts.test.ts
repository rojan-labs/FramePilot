import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { makeProject } from '../__fixtures__/project.js';
import { buildContext } from '../context-builder.js';
import { getTool } from '../tool-registry.js';
import { maskFactFor, withMaskFacts } from './mask-row-facts.js';

const SHA = (seed: string): string => seed.repeat(64).slice(0, 64);
const review = (flagged: number) => ({
  flagged: Array.from({ length: flagged }, (_, i) => ({ start: i, end: i + 0.5 })),
  approved: [],
  locked: [],
});

const matteCutout = {
  id: 'mask_1',
  kind: 'matte',
  invert: false,
  enabled: true,
  target: { kind: 'clip' },
  review: review(3),
  artifact: { key: SHA('a') },
};
const trackedFaceHide = {
  id: 'mask_2',
  kind: 'ellipse',
  invert: true,
  enabled: true,
  target: { kind: 'clip' },
  tracking: { review: review(0) },
};
const disabledSkyGrade = {
  id: 'mask_3',
  kind: 'rectangle',
  invert: false,
  enabled: false,
  target: { kind: 'effect', effectId: 'clip_a__grade' },
};

/** The fixture with masks put straight on `clip_a`: the fact reads fields, not validity. */
function withMasks(masks: readonly unknown[]): Project {
  const project = makeProject();
  const [track] = project.timeline.tracks;
  const clips = track!.clips.map((clip) =>
    clip.id === 'clip_a' ? ({ ...clip, masks } as unknown as typeof clip) : clip,
  );
  return {
    ...project,
    timeline: {
      ...project.timeline,
      tracks: [{ ...track!, clips }, ...project.timeline.tracks.slice(1)],
    },
  };
}

const prompt = (project: Project): string =>
  buildContext({ project, userPrompt: 'tighten the intro' })
    .map((message) => message.content)
    .join('\n');

describe('mask facts on clip rows (AM4.1)', () => {
  it('costs nothing on a project without masks: the same facts object comes back', () => {
    const project = makeProject();
    const facts = new Map([['clip_a', 'MS man at desk']]);
    expect(withMaskFacts(project, facts)).toBe(facts);
    expect(withMaskFacts(project, undefined)).toBeUndefined();
    expect(prompt(project)).not.toContain('masks:');
  });

  it('adds nothing to the prompt but the masked clip’s own suffix', () => {
    const plain = prompt(makeProject());
    const masked = prompt(withMasks([matteCutout]));
    expect(masked).toContain('clip_a[0–6s] · masks: matte-cutout (3 flagged)');
    expect(masked.replace(' · masks: matte-cutout (3 flagged)', '')).toBe(plain);
  });

  it('says what each mask does, whether it is tracked or off, and what is flagged', () => {
    expect(maskFactFor({ masks: [matteCutout, trackedFaceHide, disabledSkyGrade] as never })).toBe(
      'masks: matte-cutout (3 flagged), ellipse-hide tracked, rectangle-effect off',
    );
    expect(maskFactFor({})).toBeUndefined();
  });

  it('never says verified, nor marks a clean mask as checked', () => {
    const fact = maskFactFor({ masks: [{ ...matteCutout, review: review(0) }] as never })!;
    expect(fact).toBe('masks: matte-cutout');
    expect(fact).not.toMatch(/verified|✓|✔/iu);
  });

  it('joins picture words and repeat markers already on the row', () => {
    const merged = withMaskFacts(withMasks([trackedFaceHide]), new Map([['clip_a', 'MS man']]));
    expect(merged?.get('clip_a')).toBe('MS man · masks: ellipse-hide tracked');
    expect(merged?.has('clip_b')).toBe(false);
  });

  it('rides get_clips rows only for clips that have masks', () => {
    const listing = getTool('get_clips')!.read!({}, { project: withMasks([matteCutout]) }) as {
      clips: Record<string, unknown>[];
    };
    const byId = new Map(listing.clips.map((row) => [row.id, row]));
    expect(byId.get('clip_a')).toMatchObject({ masks: 'matte-cutout (3 flagged)' });
    expect(byId.get('clip_b')).not.toHaveProperty('masks');
  });
});
