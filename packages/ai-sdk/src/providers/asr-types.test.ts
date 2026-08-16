/** Tests for the two-choice ASR product contract and legacy migration. */
import { describe, expect, it } from 'vitest';
import {
  ASR_PROVIDER_NAMES,
  DEFAULT_ASR_PROVIDER,
  DEFAULT_GROQ_ASR_MODEL,
  DEFAULT_NVIDIA_ASR_MODEL,
  LEGACY_ASR_PROVIDER_NAMES,
  asrNeedsApiKey,
  asrSendsAudioOffDevice,
  defaultAsrModel,
  isAsrProviderName,
  isUserAsrProviderName,
  migrateAsrProvider,
  migrateAsrProviderName,
  parseAsrWords,
} from './asr-types.js';
import { ProviderError } from '../reliability/types.js';

describe('ASR provider rosters', () => {
  it('exposes only Local and TwelveLabs to new settings and requests', () => {
    expect(ASR_PROVIDER_NAMES).toEqual(['whisper-cli', 'twelvelabs']);
    expect(DEFAULT_ASR_PROVIDER).toBe('whisper-cli');
    for (const name of ASR_PROVIDER_NAMES) {
      expect(isUserAsrProviderName(name)).toBe(true);
      expect(isAsrProviderName(name)).toBe(true);
    }
  });

  it('recognizes old hosted values only at migration boundaries', () => {
    expect(LEGACY_ASR_PROVIDER_NAMES).toEqual(['groq', 'nvidia']);
    for (const name of LEGACY_ASR_PROVIDER_NAMES) {
      expect(isUserAsrProviderName(name)).toBe(false);
      expect(isAsrProviderName(name)).toBe(true);
    }
    expect(isUserAsrProviderName('deepgram')).toBe(false);
    expect(isAsrProviderName('deepgram')).toBe(false);
  });
});

describe('ASR provider migration', () => {
  it('preserves current choices', () => {
    expect(migrateAsrProvider('whisper-cli')).toEqual({ provider: 'whisper-cli' });
    expect(migrateAsrProvider('twelvelabs')).toEqual({ provider: 'twelvelabs' });
  });

  it('moves Groq and NVIDIA to Local and reports the old value for a notice', () => {
    expect(migrateAsrProvider('groq')).toEqual({
      provider: 'whisper-cli',
      migratedFrom: 'groq',
    });
    expect(migrateAsrProvider('nvidia')).toEqual({
      provider: 'whisper-cli',
      migratedFrom: 'nvidia',
    });
  });

  it('defaults malformed or unknown persisted values to Local', () => {
    expect(migrateAsrProvider(undefined)).toEqual({ provider: 'whisper-cli' });
    expect(migrateAsrProvider(42)).toEqual({ provider: 'whisper-cli' });
    expect(migrateAsrProvider('unknown')).toEqual({ provider: 'whisper-cli' });
    expect(migrateAsrProviderName('groq')).toBe('whisper-cli');
    expect(migrateAsrProviderName('twelvelabs')).toBe('twelvelabs');
  });
});

describe('ASR disclosure and legacy adapter metadata', () => {
  it('keeps Local on-device and treats every hosted adapter as off-device', () => {
    expect(asrSendsAudioOffDevice('whisper-cli')).toBe(false);
    expect(asrSendsAudioOffDevice('twelvelabs')).toBe(true);
    expect(asrSendsAudioOffDevice('groq')).toBe(true);
    expect(asrSendsAudioOffDevice('nvidia')).toBe(true);
  });

  it('derives API-key requirements from off-device behavior', () => {
    expect(asrNeedsApiKey('whisper-cli')).toBe(false);
    expect(asrNeedsApiKey('twelvelabs')).toBe(true);
    expect(asrNeedsApiKey('groq')).toBe(true);
    expect(asrNeedsApiKey('nvidia')).toBe(true);
  });

  it('retains defaults only for legacy adapters until their callers are removed', () => {
    expect(defaultAsrModel('nvidia')).toBe(DEFAULT_NVIDIA_ASR_MODEL);
    expect(defaultAsrModel('groq')).toBe(DEFAULT_GROQ_ASR_MODEL);
    expect(defaultAsrModel('whisper-cli')).toBeUndefined();
    expect(defaultAsrModel('twelvelabs')).toBeUndefined();
  });
});

describe('parseAsrWords', () => {
  it('preserves exact provider timing, including leading silence', () => {
    expect(
      parseAsrWords(
        'fixture',
        JSON.stringify({ words: [{ word: 'hello', start: 0.93, end: 1.25 }] }),
      ),
    ).toEqual([{ word: 'hello', start: 0.93, end: 1.25 }]);
  });

  it('rejects malformed JSON and invalid or zero-duration timing', () => {
    expect(() => parseAsrWords('fixture', '{bad json')).toThrow(ProviderError);
    expect(() =>
      parseAsrWords(
        'fixture',
        JSON.stringify({ words: [{ word: 'hello', start: 0.93, end: 0.93 }] }),
      ),
    ).toThrow('invalid word timestamps');
    expect(() =>
      parseAsrWords('fixture', JSON.stringify({ words: [{ word: 'hello', start: -1, end: 2 }] })),
    ).toThrow(ProviderError);
  });

  it('treats a missing or null words value as an empty transcript', () => {
    expect(parseAsrWords('fixture', JSON.stringify({}))).toEqual([]);
    expect(parseAsrWords('fixture', JSON.stringify({ words: null }))).toEqual([]);
  });
});
