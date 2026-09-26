/**
 * The agent's sticker host (plan/elements EL6a.7): it copies the sticker by id and hands back the
 * asset for the orchestrator to place, editing nothing, and says every failure as a sentence with
 * what to do instead.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { ElementMaterializeResult } from '../ipc/contract.js';
import { createStickerHost } from './sticker-host.js';

const project = { id: 'p1' } as Project;
const asset = {
  id: 'element_fluent3d_fire',
  path: 'media/p1/elements/fluent3d/fire.webp',
  kind: 'image' as const,
  media: { width: 318, height: 318 },
  sharpSize: 256,
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
  deduped: false,
};

describe('createStickerHost', () => {
  it('asks for the sticker by id in the open project and returns the asset to place', async () => {
    const materialize = vi.fn(async (): Promise<ElementMaterializeResult> => ({ ok: true, asset }));
    const outcome = await createStickerHost({ materialize })(project, { elementId: 'fire' });
    expect(materialize).toHaveBeenCalledWith({ projectId: 'p1', elementId: 'fire' });
    expect(outcome).toEqual({
      status: 'completed',
      summary: 'Added the fire sticker to the project.',
      data: { asset },
    });
  });

  it('says each failure with what to do instead, and never a code', async () => {
    for (const error of [
      'unknown_element',
      'library_missing',
      'integrity_failed',
      'disk_full',
      'io_failed',
    ] as const) {
      const outcome = await createStickerHost({
        materialize: async () => ({ ok: false, error }),
      })(project, { elementId: 'fire' });
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).not.toContain(error);
      expect(outcome.summary).not.toMatch(/\d/);
    }
  });
});
