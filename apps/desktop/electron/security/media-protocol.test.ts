/**
 * Tests for the pure CSP + media-URL helpers (Phase 8 audit finding 3.2).
 */
import { describe, expect, it } from 'vitest';
import {
  FP_MEDIA_SCHEME,
  buildCsp,
  mediaContentType,
  mediaUrlForPath,
  parseByteRange,
  pathFromMediaUrl,
} from './media-protocol.js';

describe('media URL round-trip', () => {
  it('encodes and decodes an absolute path, including spaces and unicode', () => {
    const p = '/Users/me/My Projects/clip — final.mp4';
    const url = mediaUrlForPath(p);
    expect(url.startsWith(`${FP_MEDIA_SCHEME}://`)).toBe(true);
    expect(pathFromMediaUrl(url)).toBe(p);
  });

  it('rejects a non-fp-media URL', () => {
    expect(() => pathFromMediaUrl('file:///etc/passwd')).toThrow(/Not an fp-media/);
  });

  it('rejects an empty media path', () => {
    expect(() => pathFromMediaUrl(`${FP_MEDIA_SCHEME}://local/`)).toThrow(/Empty media path/);
  });
});

describe('parseByteRange', () => {
  const SIZE = 1000;

  it('returns null when there is no range (serve the whole file)', () => {
    expect(parseByteRange(null, SIZE)).toBeNull();
    expect(parseByteRange(undefined, SIZE)).toBeNull();
    expect(parseByteRange('', SIZE)).toBeNull();
  });

  it('parses a closed range inclusively', () => {
    expect(parseByteRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
    expect(parseByteRange('bytes=200-799', SIZE)).toEqual({ start: 200, end: 799 });
  });

  it('treats an open-ended range as running to the last byte', () => {
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
    // A suffix larger than the file clamps to the whole file.
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past the last byte', () => {
    expect(parseByteRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('falls back to null for malformed, multi-range, or unsatisfiable headers', () => {
    expect(parseByteRange('bytes=abc-def', SIZE)).toBeNull();
    expect(parseByteRange('bytes=0-99,200-299', SIZE)).toBeNull();
    expect(parseByteRange('bytes=1000-1100', SIZE)).toBeNull(); // start past EOF
    expect(parseByteRange('bytes=500-200', SIZE)).toBeNull(); // start > end
    expect(parseByteRange('bytes=0-0', 0)).toBeNull(); // empty resource
  });
});

describe('mediaContentType', () => {
  it('maps common video/audio/image extensions, case-insensitively', () => {
    expect(mediaContentType('/a/b/clip.mp4')).toBe('video/mp4');
    expect(mediaContentType('/a/b/CLIP.MOV')).toBe('video/quicktime');
    expect(mediaContentType('voiceover.wav')).toBe('audio/wav');
    expect(mediaContentType('cover.PNG')).toBe('image/png');
  });

  it('falls back to octet-stream for unknown or extensionless paths', () => {
    expect(mediaContentType('/a/b/data.xyz')).toBe('application/octet-stream');
    expect(mediaContentType('/a/b/noext')).toBe('application/octet-stream');
  });
});

describe('buildCsp', () => {
  it('locks default-src to self and forbids objects/frames', () => {
    const csp = buildCsp('http://127.0.0.1:8765');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  it('allows media only from the fp-media scheme + blob/data, never file:', () => {
    const csp = buildCsp('http://127.0.0.1:8765');
    expect(csp).toContain(`media-src ${FP_MEDIA_SCHEME}: blob: data:`);
    expect(csp).not.toContain('file:');
  });

  it('permits the engine origin and fp-media scheme in connect-src', () => {
    const csp = buildCsp('http://127.0.0.1:8765');
    expect(csp).toContain('connect-src');
    expect(csp).toContain('http://127.0.0.1:8765');
    // fp-media: in connect-src lets the renderer fetch() audio bytes for waveform
    // extraction; the path sandbox in main still enforces file-level access.
    expect(csp).toContain(`${FP_MEDIA_SCHEME}:`);
  });

  it('in dev, also allows the Vite origin, its ws, and eval; production does not', () => {
    const dev = buildCsp('http://127.0.0.1:8765', 'http://localhost:5173');
    expect(dev).toContain('http://localhost:5173');
    expect(dev).toContain('ws://localhost:5173');
    expect(dev).toContain("'unsafe-eval'");

    const prod = buildCsp('http://127.0.0.1:8765');
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).not.toContain('localhost:5173');
  });
});
