/** Media import (plan/PLAN.md Phase 3.2). */
import type { Asset, AssetMedia } from '@framepilot/timeline-schema';
import {
  encodeMediaImportChunk,
  MEDIA_IMPORT_MAX_CHUNK_BYTES,
  type MediaImportChunkBridge,
} from '@framepilot/shared-types';
import { getBridge, importAsset, importMedia, isDesktop } from './bridge.js';

export type MediaKind = Asset['kind'];

export interface ImportedMedia {
  readonly path: string;
  readonly fileName: string;
  readonly durationSeconds: number;
  readonly kind: MediaKind;
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'media';

export function kindOf(mimeType: string): MediaKind {
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('image/')) return 'image';
  return 'video';
}

export function assetIdFor(fileName: string, existingIds: readonly string[] = []): string {
  const base = `asset_${slug(fileName)}`;
  const taken = new Set(existingIds);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
  return id;
}

export function buildAsset(
  media: ImportedMedia,
  existingIds: readonly string[] = [],
  engineMedia?: AssetMedia,
): Asset {
  const id = assetIdFor(media.fileName, existingIds);
  const asset: Asset = {
    id,
    path: media.path,
    kind: media.kind,
    durationSeconds: media.durationSeconds,
  };
  return engineMedia ? { ...asset, media: engineMedia } : asset;
}

export async function deriveEngineMedia(
  onDiskPath: string,
  brainRef?: { projectId: string; assetId: string },
): Promise<AssetMedia | undefined> {
  if (!isDesktop()) return undefined;
  const result = await importAsset({ inputPath: onDiskPath, proxy: true, ...brainRef });
  if (!result.ok) return undefined;
  const { peaks, peaksPerSecond, thumbnailPaths, proxyPath } = result.media;
  if (
    peaks === undefined &&
    peaksPerSecond === undefined &&
    thumbnailPaths === undefined &&
    proxyPath === undefined
  )
    return undefined;
  const media: AssetMedia = {};
  if (peaks !== undefined) media.peaks = peaks;
  if (peaksPerSecond !== undefined) media.peaksPerSecond = peaksPerSecond;
  if (thumbnailPaths !== undefined) media.thumbnailPaths = thumbnailPaths;
  if (proxyPath !== undefined) media.proxyPath = proxyPath;
  return media;
}

/** Production payload size. Shared validation enforces this as a hard host ceiling. */
export const MEDIA_IMPORT_CHUNK_BYTES = MEDIA_IMPORT_MAX_CHUNK_BYTES;

/** Pure work-bound helper used by tests/telemetry without allocating the media bytes. */
export function mediaImportChunkCount(fileSize: number): number {
  if (!Number.isFinite(fileSize) || fileSize < 0) throw new RangeError('Invalid media file size.');
  return Math.max(1, Math.ceil(fileSize / MEDIA_IMPORT_CHUNK_BYTES));
}

let uploadSequence = 0;
const nextUploadId = (): string => `upload_${(uploadSequence += 1)}`;

async function sendMediaChunk(args: {
  readonly projectId: string;
  readonly fileName: string;
  readonly uploadId: string;
  readonly offset: number;
  readonly final: boolean;
  readonly targetPath?: string;
  readonly payload: Uint8Array;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const bridge = getBridge() as
    | (ReturnType<typeof getBridge> & Partial<MediaImportChunkBridge>)
    | null;
  if (bridge?.importMediaChunk) {
    return bridge.importMediaChunk({
      projectId: args.projectId,
      fileName: args.fileName,
      uploadId: args.uploadId,
      offset: args.offset,
      final: args.final,
      ...(args.targetPath === undefined ? {} : { targetPath: args.targetPath }),
      // `payload.buffer` may be a SharedArrayBuffer. IPC owns an exact, transferable ArrayBuffer
      // copy so the typed transport contract cannot alias mutable caller memory.
      data: Uint8Array.from(args.payload).buffer,
    });
  }
  const data = encodeMediaImportChunk(
    {
      uploadId: args.uploadId,
      offset: args.offset,
      final: args.final,
      ...(args.targetPath === undefined ? {} : { targetPath: args.targetPath }),
    },
    args.payload,
  );
  return importMedia({ projectId: args.projectId, fileName: args.fileName, data });
}

export async function materializeImportedMedia(
  media: ImportedMedia,
  file: File,
  projectId: string,
): Promise<ImportedMedia> {
  if (!isDesktop()) return media;
  const uploadId = nextUploadId();
  let offset = 0;
  let targetPath: string | undefined;
  let sent = false;
  do {
    const end = Math.min(file.size, offset + MEDIA_IMPORT_CHUNK_BYTES);
    const payload = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const result = await sendMediaChunk({
      projectId,
      fileName: file.name,
      uploadId,
      offset,
      final: end >= file.size,
      ...(targetPath === undefined ? {} : { targetPath }),
      payload,
    });
    if (!result.ok) return media;
    targetPath = result.path;
    offset = end;
    sent = true;
  } while (offset < file.size || !sent);
  URL.revokeObjectURL(media.path);
  return targetPath === undefined ? media : { ...media, path: targetPath };
}

const IMAGE_DEFAULT_SECONDS = 5;

export function probeMediaFile(file: File): Promise<ImportedMedia> {
  const kind = kindOf(file.type);
  const path = URL.createObjectURL(file);
  if (kind === 'image') {
    return Promise.resolve({
      path,
      fileName: file.name,
      durationSeconds: IMAGE_DEFAULT_SECONDS,
      kind,
    });
  }
  return new Promise<ImportedMedia>((resolve, reject) => {
    const element = document.createElement(kind === 'audio' ? 'audio' : 'video');
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const durationSeconds = Number.isFinite(element.duration) ? element.duration : 0;
      resolve({ path, fileName: file.name, durationSeconds, kind });
    };
    element.onerror = () => {
      URL.revokeObjectURL(path);
      reject(new Error(`Could not read media: ${file.name}`));
    };
    element.src = path;
  });
}
