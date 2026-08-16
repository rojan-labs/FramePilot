import { describe, expect, it } from 'vitest';
import { createAsrProvider, resolveAsrProviderConfig } from './index.js';

describe('active ASR host boundary', () => {
  it.each(['groq', 'nvidia'] as const)(
    'migrates legacy %s to Local before constructing a provider',
    (legacy) => {
      expect(resolveAsrProviderConfig(legacy).provider).toBe('whisper-cli');
      expect(createAsrProvider(legacy).name).toBe('whisper-cli');
    },
  );
});
