import { describe, expect, it } from 'vitest';
import {
  decodeMediaImportChunk,
  encodeMediaImportChunk,
  isMediaImportChunkHeader,
} from './media-import-stream.js';

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

  it('carries the attachments destination across the frame', () => {
    const framed = encodeMediaImportChunk(
      { uploadId: 'upload_1', offset: 0, final: true, destination: 'attachments' },
      new Uint8Array([9]),
    );
    expect(decodeMediaImportChunk(new Uint8Array(framed))?.header.destination).toBe('attachments');
  });

  it('accepts only the one destination literal, so a renderer cannot name a directory', () => {
    const base = { uploadId: 'upload_1', offset: 0, final: true };
    expect(isMediaImportChunkHeader(base)).toBe(true);
    expect(isMediaImportChunkHeader({ ...base, destination: 'attachments' })).toBe(true);
    // Rejected outright rather than ignored: silently falling back to the media bin would
    // put an attachment where the sweep can never reclaim it.
    expect(isMediaImportChunkHeader({ ...base, destination: '../..' })).toBe(false);
    expect(isMediaImportChunkHeader({ ...base, destination: 'renders' })).toBe(false);
    expect(isMediaImportChunkHeader({ ...base, destination: '' })).toBe(false);
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
