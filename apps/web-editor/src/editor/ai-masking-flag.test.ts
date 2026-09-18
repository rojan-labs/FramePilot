import { describe, expect, it } from 'vitest';
import { AI_MASKING_TOOL_NAMES } from '@framepilot/ai-sdk';
import { aiMaskingDisabledTools } from './ai-masking-flag.js';

describe('aiMaskingDisabledTools (RD2.1, browser build)', () => {
  it('switches nothing off in development and test builds', () => {
    expect(aiMaskingDisabledTools({ DEV: true, MODE: 'development' })).toEqual([]);
    expect(aiMaskingDisabledTools({ DEV: false, MODE: 'test' })).toEqual([]);
  });

  it('switches every masking tool off in a production build until RD3 flips the default', () => {
    expect(aiMaskingDisabledTools({ DEV: false, MODE: 'production' })).toEqual(
      AI_MASKING_TOOL_NAMES,
    );
    expect(AI_MASKING_TOOL_NAMES).toContain('create_mask');
  });

  it('lets the build variable force either way (the kill switch)', () => {
    expect(aiMaskingDisabledTools({ DEV: true, VITE_FRAMEPILOT_AI_MASKING: 'off' })).toEqual(
      AI_MASKING_TOOL_NAMES,
    );
    expect(
      aiMaskingDisabledTools({
        DEV: false,
        MODE: 'production',
        VITE_FRAMEPILOT_AI_MASKING: ' ON ',
      }),
    ).toEqual([]);
  });

  it('ignores an unrecognised value instead of guessing', () => {
    expect(
      aiMaskingDisabledTools({ DEV: false, MODE: 'production', VITE_FRAMEPILOT_AI_MASKING: 'yes' }),
    ).toEqual(AI_MASKING_TOOL_NAMES);
  });
});
