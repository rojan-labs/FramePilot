import { describe, expect, it } from 'vitest';
import {
  isActiveAsrProviderName,
  isActiveTranscriptionRequest,
} from './active-transcription-ipc.js';

describe('active transcription IPC contract', () => {
  it('allows only Local and TwelveLabs on new renderer requests', () => {
    expect(isActiveAsrProviderName('whisper-cli')).toBe(true);
    expect(isActiveAsrProviderName('twelvelabs')).toBe(true);
    expect(isActiveAsrProviderName('groq')).toBe(false);
    expect(isActiveAsrProviderName('nvidia')).toBe(false);
  });

  it('rejects a legacy hosted provider even when the rest of the request is valid', () => {
    expect(
      isActiveTranscriptionRequest({
        projectPath: '/project/project.fp.json',
        assetId: 'asset_1',
        provider: 'groq',
      }),
    ).toBe(false);
  });
});
