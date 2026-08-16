import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FramePilotBridge, ImportAssetResult, MediaImportRequest } from '@framepilot/shared-types';
import { decodeMediaImportChunk } from '@framepilot/shared-types';
import {
  MEDIA_IMPORT_CHUNK_BYTES,
  assetIdFor,
  buildAsset,
  deriveEngineMedia,
  kindOf,
  materializeImportedMedia,
  type ImportedMedia,
} from './import.js';

describe('kindOf', () => {
  it('classifies media by MIME type, defaulting unknown types to video', () => {
    expect(kindOf('audio/mpeg')).toBe('audio');
    expect(kindOf('image/png')).toBe('image');
    expect(kindOf('video/mp4')).toBe('video');
    expect(kindOf('application/octet-stream')).toBe('video');
  });
});

describe('buildAsset', () => {
  const media = (fileName: string): ImportedMedia => ({
    path: `blob:${fileName}`,
    fileName,
    durationSeconds: 12.5,
    kind: 'video',
  });

  it('derives deterministic ids and de-duplicates them', () => {
    const first = buildAsset(media('My Clip.MP4'));
    const second = buildAsset(media('My Clip.MP4'), [first.id]);
    expect(first.id).toBe('asset_my_clip');
    expect(second.id).toBe('asset_my_clip_2');
    expect(buildAsset(media('***.mov')).id).toBe('asset_media');
  });

  it('attaches engine media only when present', () => {
    expect(buildAsset(media('clip.mp4'), [], { peaks: [0.1] }).media).toEqual({ peaks: [0.1] });
    expect('media' in buildAsset(media('clip.mp4'))).toBe(false);
  });
});

describe('deriveEngineMedia', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  const installBridge = (bridge: Partial<FramePilotBridge>): void => {
    (globalThis as { window?: { framepilot?: FramePilotBridge } }).window = {
      framepilot: bridge as FramePilotBridge,
    };
  };

  it('returns undefined in browser mode', async () => {
    (globalThis as { window?: { framepilot?: FramePilotBridge } }).window = {};
    expect(await deriveEngineMedia('media/p/clip.mp4')).toBeUndefined();
  });

  it('maps successful media handles and forwards the brain reference', async () => {
    const importAsset = vi.fn(
      async (): Promise<ImportAssetResult> => ({
        ok: true,
        durationSeconds: 12,
        kind: 'video',
        media: { peaks: [0.2], proxyPath: 'proxy.mp4' },
      }),
    );
    installBridge({ importAsset });
    await expect(
      deriveEngineMedia('media/p/clip.mp4', { projectId: 'proj_1', assetId: 'asset_clip' }),
    ).resolves.toEqual({ peaks: [0.2], proxyPath: 'proxy.mp4' });
    expect(importAsset).toHaveBeenCalledWith({
      inputPath: 'media/p/clip.mp4',
      proxy: true,
      projectId: 'proj_1',
      assetId: 'asset_clip',
    });
  });

  it('degrades on engine failure or empty media', async () => {
    installBridge({ importAsset: async () => ({ ok: false, error: 'down' }) });
    expect(await deriveEngineMedia('x')).toBeUndefined();
    installBridge({
      importAsset: async () => ({ ok: true, durationSeconds: 1, kind: 'video', media: {} }),
    });
    expect(await deriveEngineMedia('x')).toBeUndefined();
  });
});

describe('materializeImportedMedia', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('sends large desktop files as bounded ordered chunks and continues at the returned path', async () => {
    const requests: MediaImportRequest[] = [];
    const importMedia = vi.fn(async (request: MediaImportRequest) => {
      requests.push(request);
      return { ok: true as const, path: 'media/project_demo/big.mp4' };
    });
    (globalThis as { window?: { framepilot?: FramePilotBridge } }).window = {
      framepilot: { importMedia } as unknown as FramePilotBridge,
    };
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const bytes = new Uint8Array(MEDIA_IMPORT_CHUNK_BYTES + 17);
    bytes[0] = 7;
    bytes[bytes.length - 1] = 9;
    const file = new File([bytes], 'big.mp4', { type: 'video/mp4' });
    const media: ImportedMedia = {
      path: 'blob:big',
      fileName: 'big.mp4',
      durationSeconds: 10,
      kind: 'video',
    };
    await expect(materializeImportedMedia(media, file, 'project_demo')).resolves.toEqual({
      ...media,
      path: 'media/project_demo/big.mp4',
    });
    expect(requests).toHaveLength(2);
    const first = decodeMediaImportChunk(new Uint8Array(requests[0]!.data))!;
    const second = decodeMediaImportChunk(new Uint8Array(requests[1]!.data))!;
    expect(first.payload.byteLength).toBe(MEDIA_IMPORT_CHUNK_BYTES);
    expect(first.header).toMatchObject({ offset: 0, final: false });
    expect(second.payload.byteLength).toBe(17);
    expect(second.header).toMatchObject({
      offset: MEDIA_IMPORT_CHUNK_BYTES,
      final: true,
      targetPath: 'media/project_demo/big.mp4',
    });
  });

  it('keeps browser imports on their object URL and keeps it on a host copy failure', async () => {
    const media: ImportedMedia = {
      path: 'blob:small',
      fileName: 'small.mp4',
      durationSeconds: 1,
      kind: 'video',
    };
    const file = new File([new Uint8Array([1])], 'small.mp4', { type: 'video/mp4' });
    (globalThis as { window?: { framepilot?: FramePilotBridge } }).window = {};
    expect(await materializeImportedMedia(media, file, 'p')).toBe(media);

    (globalThis as { window?: { framepilot?: FramePilotBridge } }).window = {
      framepilot: {
        importMedia: async () => ({ ok: false as const, error: 'disk full' }),
      } as unknown as FramePilotBridge,
    };
    expect(await materializeImportedMedia(media, file, 'p')).toBe(media);
  });
});

describe('assetIdFor', () => {
  it('matches buildAsset id selection', () => {
    const predicted = assetIdFor('My Clip.MP4');
    expect(predicted).toBe('asset_my_clip');
    expect(assetIdFor('My Clip.MP4', [predicted])).toBe('asset_my_clip_2');
  });
});
