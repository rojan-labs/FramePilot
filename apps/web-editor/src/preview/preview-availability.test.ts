import { describe, expect, it } from 'vitest';
import { BROWSER_PREVIEW_UNAVAILABLE, previewFailureMessage } from './preview-availability.js';

describe('previewFailureMessage', () => {
  it('keeps the actionable detail on the desktop', () => {
    expect(previewFailureMessage('decoder error: unsupported codec', true)).toBe(
      'decoder error: unsupported codec',
    );
  });

  it('says plainly that the browser cannot preview this timeline', () => {
    expect(previewFailureMessage('WebGL2 unavailable', false)).toBe(BROWSER_PREVIEW_UNAVAILABLE);
    expect(BROWSER_PREVIEW_UNAVAILABLE).toBe(
      'Preview unavailable for this timeline in the browser',
    );
  });
});
