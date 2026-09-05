/**
 * Which desktop build to offer a visitor.
 *
 * FramePilot ships for macOS, Windows, and Linux only, so a phone or tablet
 * must fall through to the neutral label rather than being sold a build it
 * cannot run. That needs care: an iPhone's user agent contains "like Mac OS X",
 * and iPadOS reports a desktop Macintosh string outright — the only reliable
 * tell there is a touch-capable "Mac".
 */
export type DesktopPlatform = 'mac' | 'windows' | 'linux' | 'other';

const MOBILE = /iphone|ipod|ipad|android|mobile|silk|kindle/;

export function detectPlatform(
  userAgent: string,
  platform = '',
  maxTouchPoints = 0,
): DesktopPlatform {
  const signature = `${platform} ${userAgent}`.toLowerCase();
  if (MOBILE.test(signature)) return 'other';

  const isMac = signature.includes('mac');
  // iPadOS in desktop mode: a Macintosh string on a multi-touch device.
  if (isMac && maxTouchPoints > 1) return 'other';
  if (isMac) return 'mac';
  if (signature.includes('win')) return 'windows';
  if (signature.includes('linux') || signature.includes('x11')) return 'linux';
  return 'other';
}

/** Reads the current browser. Returns `other` anywhere there is no navigator. */
export function detectCurrentPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'other';
  return detectPlatform(navigator.userAgent, navigator.platform ?? '', navigator.maxTouchPoints ?? 0);
}
