import { describe, expect, it } from 'vitest';
import { decodeMediaImportChunk, encodeMediaImportChunk } from './media-import-stream.js';

describe('media import stream framing', () => {
  it('round-trips bounded payload and ordering metadata', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const framed = encodeMediaImportChunk(
      { uploadId: 'upload_1', offset: 4, final: true, targetPath: 'media/p/clip.mp4' },
      payload,
    );
    const decoded = decodeMediaImportChunk(new Uint8Array(framed));
    expect(decoded?.header).toEqual({
      uploadId: 'upload_1',
      offset: 4,
      final: true,
      targetPath: 'media/p/clip.mp4',
    });
    expect([...decoded!.payload]).toEqual([1, 2, 3]);
  });

  it('treats unframed legacy bytes as a legacy whole-file request', () => {
    expect(decodeMediaImportChunk(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('rejects malformed framed metadata rather than guessing', () => {
    expect(() =>
      encodeMediaImportChunk({ uploadId: '../bad', offset: 0, final: true }, new Uint8Array()),
    ).toThrow('Invalid media import chunk header');

    const malformed = new Uint8Array([0x46, 0x50, 0x4d, 0x31, 0xff, 0xff, 0, 0]);
    expect(() => decodeMediaImportChunk(malformed)).toThrow('Malformed media import chunk header');
  });
});
