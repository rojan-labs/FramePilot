/**
 * An element the agent puts entirely off the frame renders as nothing (plan/elements EL8.1, 07 §4):
 * the edit is refused with a sentence saying so, rather than applied and reported as done. An
 * element that is on the frame at any moment of its span is fine, and nothing else is judged.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  buildAddStickerOps,
  type AnyOperation,
  type Patch,
} from '@framepilot/editor-core';
import type { Asset, Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import { assembleEdit } from './assemble.js';

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

function withSticker(): { project: Project; clipId: string } {
  const empty = makeProject({
    timeline: { tracks: [{ id: 'v', type: 'video', clips: [] }] },
  } as never);
  const placed = buildAddStickerOps(empty, fire, 0, 3, { artFraction: 256 / 318 });
  const patch: Patch = {
    patchId: 'add' as Patch['patchId'],
    createdBy: 'agent',
    reason: 'add',
    operations: [...placed.operations],
  };
  return { project: applyProjectPatch(empty, patch), clipId: placed.clipId };
}

const moveX = (clipId: string, value: number): AnyOperation[] => [
  {
    type: 'add_keyframes',
    clipId,
    replace: true,
    keyframes: [{ id: 'kf_x', time: 0, property: 'x', value, easing: 'linear' }],
  },
];

describe('assembleEdit and an element off the frame', () => {
  it('refuses an edit that leaves an element off the frame for its whole span', () => {
    const { project, clipId } = withSticker();
    const result = assembleEdit(project, moveX(clipId, 5000), 'Move sticker');
    expect(result.validation.valid).toBe(false);
    const issue = result.validation.issues[0]!;
    expect(issue.code).toBe('element_off_frame');
    expect(issue.message).toContain(`"${clipId}"`);
    expect(issue.message).toContain('render as nothing');
  });

  it('applies an edit that keeps it on the frame, even partly', () => {
    const { project, clipId } = withSticker();
    expect(assembleEdit(project, moveX(clipId, 700), 'Move sticker').validation.valid).toBe(true);
  });
});
