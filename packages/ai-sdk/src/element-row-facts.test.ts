/**
 * What the model reads about an element (plan/elements EL8.2, 07 §5): each sticker and shape row
 * in the timeline summary names the element, where it sits in the units the tools take, and its
 * animation, so "move the fire sticker" or "make the box red" needs no extra call — in a bounded
 * number of tokens.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  buildAddShapeOps,
  buildAddStickerOps,
  planElementAnimation,
  type Operation,
  type Patch,
} from '@framepilot/editor-core';
import { presetShapeParams, type Asset, type Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import { estimateTokens, summarizeTimeline } from './context-builder.js';
import { elementFactFor, withElementFacts } from './element-row-facts.js';

const fire: Asset = {
  id: 'element_fluent3d_fire',
  path: 'media/p/elements/fluent3d/fire.webp',
  kind: 'image',
  media: { width: 318, height: 318 },
  source: {
    provider: 'fluent-emoji',
    remoteId: 'fire',
    license: 'mit',
    licenseUrl: 'https://example.test/LICENSE',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    sourceUrl: 'https://example.test/fire.png',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
} as Asset;

const patchOf = (operations: readonly Operation[]): Patch => ({
  patchId: `t_${String(operations.length)}` as Patch['patchId'],
  createdBy: 'agent',
  reason: 't',
  operations: [...operations],
});

function project(): Project {
  const empty = makeProject({
    timeline: { tracks: [{ id: 'v', type: 'video', clips: [] }] },
  } as never);
  const sticker = buildAddStickerOps(empty, fire, 1, 3, {
    artFraction: 256 / 318,
    offset: { x: 480, y: -270 },
  });
  let p = applyProjectPatch(empty, patchOf(sticker.operations));
  const shape = buildAddShapeOps(p.timeline, presetShapeParams('rounded-rect/highlight')!, 2, 4);
  p = applyProjectPatch(p, patchOf(shape.operations));
  const pop = planElementAnimation(
    p.timeline,
    sticker.clipId,
    { in: { kind: 'pop' } },
    p.resolution,
  );
  if (!pop.ok) throw new Error(pop.detail);
  return applyProjectPatch(p, patchOf(pop.operations));
}

const clip = (p: Project, assetId: string) =>
  p.timeline.tracks.flatMap((t) => t.clips).find((c) => c.assetId === assetId)!;

describe('element row facts', () => {
  it('names a sticker, where it sits in add_sticker’s units, and its animation', () => {
    const p = project();
    expect(elementFactFor(p, clip(p, fire.id))).toBe(
      'sticker "Fire" at 75%, 25%, 30% high · in: pop',
    );
  });

  it('names a shape by its kind, colours and box in add_shape’s units', () => {
    const p = project();
    expect(elementFactFor(p, clip(p, '__shape__'))).toBe(
      'shape rounded-rect · outline #FFD400 · box 50, 50, 48×27',
    );
  });

  it('rides the timeline summary, and costs a few tokens an element', () => {
    const p = project();
    const facts = withElementFacts(p, undefined)!;
    const summary = summarizeTimeline(p.timeline, new Map(), undefined, Infinity, undefined, facts);
    expect(summary).toContain('sticker "Fire"');
    expect(summary).toContain('shape rounded-rect');
    const plain = summarizeTimeline(p.timeline);
    const perElement = (estimateTokens(summary) - estimateTokens(plain)) / 2;
    expect(perElement).toBeLessThan(20);
    // Footage rows are untouched: no facts for clips that are not elements.
    expect(withElementFacts(makeProject(), undefined)).toBeUndefined();
  });
});
