import { describe, expect, it } from 'vitest';
import { decideReferenceRole, REFERENCE_ROLE_LABEL } from './role.js';

describe('decideReferenceRole', () => {
  it.each([
    ['put our logo bottom right', 'image', 'x.png', 'brand-logo'],
    ['grade it like this', 'image', 'mood.jpg', 'color'],
    ['make the captions look like this', 'video', 'ref.mp4', 'caption-style'],
    ['cut it with this pacing', 'video', 'reel.mp4', 'pacing'],
    ['use this as the thumbnail reference', 'image', 'a.jpg', 'thumbnail'],
    ['this person is the host', 'image', 'a.jpg', 'character'],
    ['use this footage as b-roll', 'video', 'b.mov', 'b-roll'],
    ['match this title card design', 'image', 'a.png', 'design'],
    ['make mine feel like this', 'video', 'ref.mp4', 'style'],
  ] as const)('%s → %s', (prompt, kind, fileName, role) => {
    const d = decideReferenceRole({ kind, fileName, promptText: prompt });
    expect(d.role).toBe(role);
    expect(d.confidence).toBe(1);
    expect(d.ambiguous).toBe(false);
  });

  it('reads the file name when the words say nothing', () => {
    expect(decideReferenceRole({ kind: 'image', fileName: 'acme-logo.png' }).role).toBe('brand-logo');
    expect(decideReferenceRole({ kind: 'image', fileName: 'thumb-v2.jpg' }).role).toBe('thumbnail');
  });

  it('treats a small image with alpha as a logo, and a plain image as an ambiguous style ref', () => {
    const logo = decideReferenceRole({ kind: 'image', fileName: 'mark.png', width: 512, height: 512, hasAlpha: true });
    expect(logo.role).toBe('brand-logo');
    expect(logo.ambiguous).toBe(false);
    const photo = decideReferenceRole({ kind: 'image', fileName: 'IMG_1.jpg', width: 4000, height: 3000 });
    expect(photo.role).toBe('style');
    expect(photo.ambiguous).toBe(true);
  });

  it('defaults a silent video to an ambiguous style reference', () => {
    const d = decideReferenceRole({ kind: 'video', fileName: 'clip.mp4', promptText: 'hello' });
    expect(d).toMatchObject({ role: 'style', ambiguous: true });
  });

  it('has a label for every role', () => {
    for (const role of ['style', 'pacing', 'caption-style', 'color', 'brand-logo', 'thumbnail', 'b-roll', 'character', 'design'] as const) {
      expect(REFERENCE_ROLE_LABEL[role].length).toBeGreaterThan(3);
    }
  });
});
