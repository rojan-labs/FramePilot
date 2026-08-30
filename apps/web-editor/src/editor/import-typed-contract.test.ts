import type { FramePilotBridge, MediaImportChunkBridge } from '@framepilot/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_IMPORT_CHUNK_BYTES, materializeImportedMedia } from './import.js';

describe('desktop media chunk contract', () => {
  afterEach(() => {
    delete window.framepilot;
  });

  it('uses the explicit chunk method when the desktop host exposes it', async () => {
    const importMedia = vi.fn(async () => ({ ok: false as const, error: 'legacy should not run' }));
    const importMediaChunk = vi.fn(async (request: { offset: number }) => ({
      ok: true as const,
      path: 'media/project_1/video.mp4',
      offset: request.offset,
    }));
    window.framepilot = {
      importMedia,
      importMediaChunk,
    } as unknown as FramePilotBridge & MediaImportChunkBridge;

    const bytes = new Uint8Array(MEDIA_IMPORT_CHUNK_BYTES + 5);
    const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });
    const result = await materializeImportedMedia(
      { path: URL.createObjectURL(file), fileName: file.name, durationSeconds: 1, kind: 'video' },
      file,
      'project_1',
    );

    expect(result.path).toBe('media/project_1/video.mp4');
    expect(importMedia).not.toHaveBeenCalled();
    expect(importMediaChunk).toHaveBeenCalledTimes(2);
    for (const [request] of importMediaChunk.mock.calls) {
      expect((request as unknown as { data: ArrayBuffer }).data.byteLength).toBeLessThanOrEqual(
        MEDIA_IMPORT_CHUNK_BYTES,
      );
    }
  });

  it('marks an AI-sidebar attachment as such on every chunk, and a bin import not at all', async () => {
    const importMediaChunk = vi.fn(async (_request: { destination?: string }) => ({
      ok: true as const,
      path: 'media/project_1/attachments/ref.mp4',
    }));
    window.framepilot = { importMediaChunk } as unknown as FramePilotBridge &
      MediaImportChunkBridge;

    const bytes = new Uint8Array(MEDIA_IMPORT_CHUNK_BYTES + 5);
    const file = new File([bytes], 'ref.mp4', { type: 'video/mp4' });
    const media = {
      path: URL.createObjectURL(file),
      fileName: file.name,
      durationSeconds: 1,
      kind: 'video' as const,
    };

    await materializeImportedMedia(media, file, 'project_1', 'attachments');
    // Every chunk, not just the first: the host reads the destination on the chunk that
    // claims the name AND on the continuations that validate against that directory.
    expect(importMediaChunk.mock.calls).toHaveLength(2);
    for (const [request] of importMediaChunk.mock.calls) {
      expect(request.destination).toBe('attachments');
    }

    importMediaChunk.mockClear();
    await materializeImportedMedia(media, file, 'project_1');
    for (const [request] of importMediaChunk.mock.calls) {
      expect(request.destination).toBeUndefined();
    }
  });
});
