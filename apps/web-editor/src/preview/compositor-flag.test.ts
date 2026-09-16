import { describe, expect, it } from 'vitest';
import { layerCompositorEnabled, previewCompositor } from './compositor-flag.js';

describe('previewCompositor (RD2.1)', () => {
  it('defaults to the layer compositor in development and test builds', () => {
    expect(previewCompositor({ DEV: true, MODE: 'development' })).toBe('layers');
    expect(previewCompositor({ DEV: false, MODE: 'test' })).toBe('layers');
  });

  it('keeps production builds on the legacy path until RD3 flips the default', () => {
    expect(previewCompositor({ DEV: false, MODE: 'production' })).toBe('legacy');
  });

  it('lets the build variable force either path (the kill switch)', () => {
    expect(previewCompositor({ DEV: true, VITE_FRAMEPILOT_PREVIEW_COMPOSITOR: 'legacy' })).toBe(
      'legacy',
    );
    expect(
      previewCompositor({
        DEV: false,
        MODE: 'production',
        VITE_FRAMEPILOT_PREVIEW_COMPOSITOR: ' Layers ',
      }),
    ).toBe('layers');
  });

  it('ignores an unrecognised value instead of guessing', () => {
    expect(
      previewCompositor({
        DEV: false,
        MODE: 'production',
        VITE_FRAMEPILOT_PREVIEW_COMPOSITOR: 'on',
      }),
    ).toBe('legacy');
    expect(layerCompositorEnabled({ DEV: true, VITE_FRAMEPILOT_PREVIEW_COMPOSITOR: 'yes' })).toBe(
      true,
    );
  });
});
