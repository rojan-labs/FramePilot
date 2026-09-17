import { describe, expect, it } from 'vitest';
import { maskToolsEnabled, maskToolsSetting } from './mask-tools-flag.js';

describe('maskToolsSetting (RD2.1)', () => {
  it('is on in development and test builds', () => {
    expect(maskToolsSetting({ DEV: true, MODE: 'development' })).toBe('on');
    expect(maskToolsSetting({ DEV: false, MODE: 'test' })).toBe('on');
  });

  it('is off in production builds until RD3 flips the default', () => {
    expect(maskToolsSetting({ DEV: false, MODE: 'production' })).toBe('off');
  });

  it('lets the build variable force either way (the kill switch)', () => {
    expect(maskToolsSetting({ DEV: true, VITE_FRAMEPILOT_MASK_TOOLS: 'off' })).toBe('off');
    expect(
      maskToolsSetting({ DEV: false, MODE: 'production', VITE_FRAMEPILOT_MASK_TOOLS: ' ON ' }),
    ).toBe('on');
  });

  it('ignores an unrecognised value instead of guessing', () => {
    expect(
      maskToolsSetting({ DEV: false, MODE: 'production', VITE_FRAMEPILOT_MASK_TOOLS: 'yes' }),
    ).toBe('off');
    expect(maskToolsEnabled({ DEV: true, VITE_FRAMEPILOT_MASK_TOOLS: '1' })).toBe(true);
  });
});
