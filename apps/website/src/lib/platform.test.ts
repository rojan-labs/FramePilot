import { describe, expect, it } from 'vitest';
import { detectPlatform } from './platform';

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';

describe('detectPlatform', () => {
  it('recognises the three desktop builds', () => {
    expect(detectPlatform(MAC, 'MacIntel')).toBe('mac');
    expect(detectPlatform(WINDOWS, 'Win32')).toBe('windows');
    expect(detectPlatform(LINUX, 'Linux x86_64')).toBe('linux');
  });

  it('does not offer a macOS build to an iPhone', () => {
    // The UA says "like Mac OS X"; there is no mobile build to hand it.
    expect(detectPlatform(IPHONE, 'iPhone')).toBe('other');
  });

  it('does not offer a macOS build to an iPad in desktop mode', () => {
    expect(detectPlatform(IPAD_DESKTOP_MODE, 'MacIntel', 5)).toBe('other');
    // The same string on a real Mac, which reports no touch points, still wins.
    expect(detectPlatform(IPAD_DESKTOP_MODE, 'MacIntel', 0)).toBe('mac');
  });

  it('does not offer a Linux build to an Android phone', () => {
    expect(detectPlatform(ANDROID, 'Linux armv8l')).toBe('other');
  });

  it('falls back to the neutral label for anything unrecognised', () => {
    expect(detectPlatform('', '')).toBe('other');
    expect(detectPlatform('Mozilla/5.0 (PlayStation 5)')).toBe('other');
  });
});
