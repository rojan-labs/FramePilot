import { MEDIA_IMPORT_MAX_CHUNK_BYTES } from '@framepilot/shared-types';
import { describe, expect, it } from 'vitest';
import { MEDIA_IMPORT_CHUNK_BYTES, mediaImportChunkCount } from './import.js';

describe('media import throughput work bound', () => {
  it('uses the shared 16 MiB memory ceiling', () => {
    expect(MEDIA_IMPORT_CHUNK_BYTES).toBe(16 * 1024 * 1024);
    expect(MEDIA_IMPORT_CHUNK_BYTES).toBe(MEDIA_IMPORT_MAX_CHUNK_BYTES);
  });

  it('cuts a 20 GiB import to 1280 sequential IPC calls instead of the old 5120', () => {
    const twentyGiB = 20 * 1024 * 1024 * 1024;
    expect(mediaImportChunkCount(twentyGiB)).toBe(1280);
    expect(mediaImportChunkCount(twentyGiB)).toBe((twentyGiB / (4 * 1024 * 1024)) / 4);
  });

  it('still sends one bounded message for an empty or tiny file', () => {
    expect(mediaImportChunkCount(0)).toBe(1);
    expect(mediaImportChunkCount(1)).toBe(1);
  });
});
