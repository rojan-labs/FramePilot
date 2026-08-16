import { describe, expect, it } from 'vitest';
import { mediaSrc, previewMediaSrc } from './media.js';

describe('mediaSrc', () => {
  it('wraps an on-disk relative path in the fp-media:// scheme', () => {
    expect(mediaSrc('media/project_x/clip.mp4')).toBe(
      'fp-media://local/media%2Fproject_x%2Fclip.mp4',
    );
  });

  it('percent-encodes spaces and other unsafe characters in the path', () => {
    expect(mediaSrc('media/my project/a clip.mp4')).toBe(
      'fp-media://local/media%2Fmy%20project%2Fa%20clip.mp4',
    );
  });

  it.each([
    'blob:abc',
    'http://x/y.mp4',
    'https://x/y.mp4',
    'fp-media://local/z',
    'data:video/mp4,',
  ])('passes through an already-usable URL unchanged: %s', (url) => {
    expect(mediaSrc(url)).toBe(url);
  });
});

describe('previewMediaSrc (H3 — proxy-first preview)', () => {
  it('prefers the engine-generated proxy when present', () => {
    expect(
      previewMediaSrc({ path: 'media/p/original.mov', media: { proxyPath: 'media/p/.proxy.mp4' } }),
    ).toBe('fp-media://local/media%2Fp%2F.proxy.mp4');
  });

  it.each([
    { path: 'media/p/original.mov' },
    { path: 'media/p/original.mov', media: null },
    { path: 'media/p/original.mov', media: { proxyPath: null } },
    { path: 'media/p/original.mov', media: { proxyPath: '' } },
  ])('falls back to the original when no proxy exists: %j', (asset) => {
    expect(previewMediaSrc(asset)).toBe('fp-media://local/media%2Fp%2Foriginal.mov');
  });

  it('passes an object-URL original through unchanged', () => {
    expect(previewMediaSrc({ path: 'blob:session-import' })).toBe('blob:session-import');
  });

  it('never uses a proxy for an image — an <img> cannot render an .mp4', () => {
    // An older import that mislabelled a photo as video may leave a (stale)
    // proxy path on an image asset; the image must always preview from source.
    expect(
      previewMediaSrc({
        path: 'media/p/photo.jpeg',
        kind: 'image',
        media: { proxyPath: 'media/p/.proxy.mp4' },
      }),
    ).toBe('fp-media://local/media%2Fp%2Fphoto.jpeg');
  });
});
