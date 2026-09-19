import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureSwsUnscaledConverterFromHost,
  setSwsUnscaledConverter,
  swsUnscaledConverter,
  unscaledConverterForHints,
} from './sws-host.js';

describe('the export host unscaled converter (MK6.4)', () => {
  afterEach(() => {
    setSwsUnscaledConverter('simd');
    vi.unstubAllGlobals();
  });

  it('is the C converter only on macOS arm, the pair that was measured', () => {
    expect(unscaledConverterForHints({ platform: 'macOS', architecture: 'arm' })).toBe('tables');
    expect(unscaledConverterForHints({ platform: 'macOS', architecture: 'x86' })).toBe('simd');
    expect(unscaledConverterForHints({ platform: 'Windows', architecture: 'x86' })).toBe('simd');
    expect(unscaledConverterForHints({ platform: 'Linux', architecture: 'arm' })).toBe('simd');
    expect(unscaledConverterForHints({})).toBe('simd');
  });

  it('defaults to the SIMD arithmetic without client hints', async () => {
    vi.stubGlobal('navigator', {});
    await configureSwsUnscaledConverterFromHost();
    expect(swsUnscaledConverter()).toBe('simd');
  });

  it('follows the client hints once they resolve', async () => {
    vi.stubGlobal('navigator', {
      userAgentData: {
        getHighEntropyValues: () => Promise.resolve({ platform: 'macOS', architecture: 'arm' }),
      },
    });
    await configureSwsUnscaledConverterFromHost();
    expect(swsUnscaledConverter()).toBe('tables');
  });

  it('prefers the export host a harness states over the browser hints', async () => {
    vi.stubGlobal('__fpExportHostHints', { platform: 'macOS', architecture: 'arm' });
    vi.stubGlobal('navigator', {
      userAgentData: {
        getHighEntropyValues: () => Promise.resolve({ platform: 'Windows', architecture: 'x86' }),
      },
    });
    await configureSwsUnscaledConverterFromHost();
    expect(swsUnscaledConverter()).toBe('tables');
  });

  it('keeps the SIMD arithmetic when the hints refuse', async () => {
    vi.stubGlobal('navigator', {
      userAgentData: { getHighEntropyValues: () => Promise.reject(new Error('denied')) },
    });
    await configureSwsUnscaledConverterFromHost();
    expect(swsUnscaledConverter()).toBe('simd');
  });
});
