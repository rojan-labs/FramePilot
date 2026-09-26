/**
 * The animation evaluation case (plan/elements 07 section 8, case 3): "Make the arrow pop in and the
 * sticker pulse." The rubric passes a Pop entrance on the arrow and a Pulse loop on the sticker with
 * nothing else animated or moved, and fails each way of getting it wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  buildAddShapeOps,
  buildAddStickerOps,
  planElementAnimation,
  type ElementAnimationRequest,
  type Operation,
  type Patch,
} from '@framepilot/editor-core';
import { presetShapeParams, type Asset, type Project } from '@framepilot/timeline-schema';
import { GOLDEN_CASES } from './golden-cases.js';
import { scoreMissionScenario } from './mission-rubric.js';

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
  patchId: `test_${String(operations.length)}` as Patch['patchId'],
  createdBy: 'ai',
  reason: 'test',
  operations: [...operations],
});

/** Footage with an arrow and a sticker already on it, as `mission-animate-demo` builds it. */
function before(): Project {
  const empty = {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1280, height: 720 },
    assets: [{ id: 'a1', path: 'media/reaction.mp4', kind: 'video', durationSeconds: 12 }],
    folders: [],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a1',
              trackId: 'v1',
              start: 0,
              end: 12,
              sourceStart: 0,
              sourceEnd: 12,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  } as unknown as Project;
  const arrow = buildAddShapeOps(empty.timeline, presetShapeParams('line-arrow/red')!, 2, 5);
  const withArrow = applyProjectPatch(empty, patchOf(arrow.operations));
  const sticker = buildAddStickerOps(withArrow, fire, 3, 6, { artFraction: 256 / 318 });
  return applyProjectPatch(withArrow, patchOf(sticker.operations));
}

const idOf = (project: Project, test: (assetId: string) => boolean): string =>
  project.timeline.tracks.flatMap((t) => t.clips).find((c) => test(c.assetId))!.id;
const arrowId = (project: Project) => idOf(project, (id) => id === '__shape__');
const stickerId = (project: Project) => idOf(project, (id) => id === fire.id);

function animated(
  from: Project,
  requests: readonly (readonly [string, ElementAnimationRequest])[],
): Project {
  let project = from;
  for (const [clipId, request] of requests) {
    const plan = planElementAnimation(project.timeline, clipId, request, project.resolution);
    if (!plan.ok) throw new Error(plan.detail);
    project = applyProjectPatch(project, patchOf(plan.operations));
  }
  return project;
}

const failures = (from: Project, after: Project): string[] =>
  scoreMissionScenario('element-animation', { before: from, after })
    .checks.filter((check) => !check.ok)
    .map((check) => check.id);

describe('the animation case', () => {
  it('is case three of the elements set, on the demo with an arrow and a sticker', () => {
    const found = GOLDEN_CASES.find((c) => c.id === 'animate-arrow-and-sticker')!;
    expect(found.project).toBe('mission-animate-demo');
    expect(found.turns[0]!.prompt).toBe('Make the arrow pop in and the sticker pulse.');
    expect(found.turns[0]!.rubric).toBe('element-animation');
  });

  it('passes a Pop on the arrow and a Pulse on the sticker, and nothing else', () => {
    const from = before();
    const after = animated(from, [
      [arrowId(from), { in: { kind: 'pop' } }],
      [stickerId(from), { loop: { preset: 'pulse' } }],
    ]);
    expect(failures(from, after)).toEqual([]);
  });

  it('fails the wrong entrance, the wrong loop, and animation nobody asked for', () => {
    const from = before();
    expect(
      failures(
        from,
        animated(from, [
          [arrowId(from), { in: { kind: 'fade' } }],
          [stickerId(from), { loop: { preset: 'pulse' } }],
        ]),
      ),
    ).toContain('arrow-pops-in');
    expect(
      failures(
        from,
        animated(from, [
          [arrowId(from), { in: { kind: 'pop' } }],
          [stickerId(from), { loop: { preset: 'wiggle' } }],
        ]),
      ),
    ).toContain('sticker-pulses');
    expect(
      failures(
        from,
        animated(from, [
          [arrowId(from), { in: { kind: 'pop' }, loop: { preset: 'pulse' } }],
          [stickerId(from), { in: { kind: 'fade' }, loop: { preset: 'pulse' } }],
        ]),
      ),
    ).toContain('nothing-else-animated');
  });
});
