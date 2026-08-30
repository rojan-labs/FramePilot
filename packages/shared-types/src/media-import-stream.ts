/**
 * Bounded media-import framing and typed chunk transport shared by renderer/Electron.
 *
 * `MediaImportChunkRequest` is the production contract. The older binary frame helpers
 * remain only for compatibility with desktop/renderers that predate the explicit channel.
 */

const MAGIC = new Uint8Array([0x46, 0x50, 0x4d, 0x31]); // "FPM1"
const PREFIX_BYTES = 8;
const MAX_HEADER_BYTES = 4096;
const UPLOAD_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** Hard per-message heap bound. 16 MiB cuts IPC round trips 4x vs the old 4 MiB frames. */
export const MEDIA_IMPORT_MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Where an import lands inside the project's media folder.
 *
 * A CLOSED literal union rather than a path, and that is the whole point of it. The
 * renderer may say "this copy is an AI-sidebar attachment, not a media-bin asset", and
 * nothing more: it cannot name a directory, so no value it can send escapes the media
 * folder or lands beside the user's footage by accident.
 *
 * The distinction has to exist on disk because the two have different lifetimes.
 * A bin asset is referenced by `project.assets` and is the user's to delete; an
 * attachment is referenced only by a conversation, and when no conversation references
 * it any more nothing on earth will ever read it again. Reclaiming the second kind
 * safely is only possible if it can be told apart from the first, and while both were
 * written into one directory under the user's own file names it could not be.
 * `attachments` is that separation (see `sweepUnreferencedAttachments` in
 * `apps/desktop/electron/projects/media-import.ts`).
 */
export type MediaImportDestination = 'attachments';

export interface MediaImportChunkHeader {
  readonly uploadId: string;
  readonly offset: number;
  readonly final: boolean;
  readonly targetPath?: string;
  /** Omitted for a media-bin import; see {@link MediaImportDestination}. */
  readonly destination?: MediaImportDestination;
}

export interface MediaImportChunkRequest extends MediaImportChunkHeader {
  readonly projectId: string;
  readonly fileName: string;
  readonly data: ArrayBuffer;
}

export type MediaImportChunkResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

export interface MediaImportChunkBridge {
  importMediaChunk(request: MediaImportChunkRequest): Promise<MediaImportChunkResult>;
}

export interface DecodedMediaImportChunk {
  readonly header: MediaImportChunkHeader;
  readonly payload: Uint8Array;
}

export function isMediaImportChunkHeader(value: unknown): value is MediaImportChunkHeader {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.uploadId === 'string' &&
    UPLOAD_ID.test(record.uploadId) &&
    typeof record.offset === 'number' &&
    Number.isSafeInteger(record.offset) &&
    record.offset >= 0 &&
    typeof record.final === 'boolean' &&
    (record.targetPath === undefined ||
      (typeof record.targetPath === 'string' && record.targetPath.length > 0)) &&
    // Anything other than the one literal is rejected outright rather than ignored:
    // silently falling back to the bin would put an attachment where the sweep can
    // never reclaim it, which is the leak this field exists to close.
    (record.destination === undefined || record.destination === 'attachments')
  );
}

export function isMediaImportChunkRequest(value: unknown): value is MediaImportChunkRequest {
  // Read the record before the guard narrows `value`: once it is a
  // `MediaImportChunkHeader`, TS rejects the index-signature cast.
  const record = value as Record<string, unknown>;
  if (!isMediaImportChunkHeader(value)) return false;
  return (
    typeof record.projectId === 'string' &&
    record.projectId.trim().length > 0 &&
    typeof record.fileName === 'string' &&
    record.fileName.trim().length > 0 &&
    record.data instanceof ArrayBuffer &&
    record.data.byteLength <= MEDIA_IMPORT_MAX_CHUNK_BYTES
  );
}

export function encodeMediaImportChunk(
  header: MediaImportChunkHeader,
  payload: Uint8Array,
): ArrayBuffer {
  if (!isMediaImportChunkHeader(header)) throw new TypeError('Invalid media import chunk header.');
  if (payload.byteLength > MEDIA_IMPORT_MAX_CHUNK_BYTES) {
    throw new RangeError('Media import chunk exceeds the transport memory ceiling.');
  }
  const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
  if (encodedHeader.byteLength > MAX_HEADER_BYTES) {
    throw new RangeError('Media import chunk header is too large.');
  }
  const framed = new Uint8Array(PREFIX_BYTES + encodedHeader.byteLength + payload.byteLength);
  framed.set(MAGIC, 0);
  new DataView(framed.buffer).setUint32(4, encodedHeader.byteLength, true);
  framed.set(encodedHeader, PREFIX_BYTES);
  framed.set(payload, PREFIX_BYTES + encodedHeader.byteLength);
  return framed.buffer;
}

export function decodeMediaImportChunk(data: Uint8Array): DecodedMediaImportChunk | null {
  if (data.byteLength < PREFIX_BYTES) return null;
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (data[i] !== MAGIC[i]) return null;
  }
  const headerBytes = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
    4,
    true,
  );
  if (
    headerBytes <= 0 ||
    headerBytes > MAX_HEADER_BYTES ||
    PREFIX_BYTES + headerBytes > data.byteLength
  ) {
    throw new RangeError('Malformed media import chunk header length.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(data.subarray(PREFIX_BYTES, PREFIX_BYTES + headerBytes)),
    );
  } catch (error) {
    throw new TypeError(
      `Malformed media import chunk header: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isMediaImportChunkHeader(parsed))
    throw new TypeError('Malformed media import chunk metadata.');
  const payload = data.subarray(PREFIX_BYTES + headerBytes);
  if (payload.byteLength > MEDIA_IMPORT_MAX_CHUNK_BYTES) {
    throw new RangeError('Media import chunk exceeds the transport memory ceiling.');
  }
  return { header: parsed, payload };
}
