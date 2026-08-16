import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IpcChannels } from './contract.js';

function preloadSource(): string {
  const candidates = [
    path.resolve(process.cwd(), 'electron/preload.cts'),
    path.resolve(process.cwd(), 'apps/desktop/electron/preload.cts'),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error('Could not locate apps/desktop/electron/preload.cts.');
  return readFileSync(file, 'utf8');
}

/** Extract the plain key/string entries from preload's sandbox-safe Channels literal. */
export function preloadChannelEntries(source: string): Record<string, string> {
  const start = source.indexOf('const Channels = {');
  const end = source.indexOf('} as const;', start);
  if (start < 0 || end < 0) throw new Error('Preload Channels registry was not found.');
  const body = source.slice(start, end);
  const entries: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*([A-Za-z0-9_]+):\s*'([^']+)',\s*$/gm)) {
    const key = match[1];
    const value = match[2];
    if (key && value) entries[key] = value;
  }
  return entries;
}

describe('sandbox preload IPC registry', () => {
  it('matches the canonical main-process channel registry exactly', () => {
    expect(preloadChannelEntries(preloadSource())).toEqual(IpcChannels);
  });

  it('rejects missing, renamed, or extra preload channels', () => {
    const source = preloadSource();
    const firstValue = Object.values(IpcChannels)[0]!;
    const changed = source.replace(firstValue, `${firstValue}:drifted`);
    expect(preloadChannelEntries(changed)).not.toEqual(IpcChannels);
  });

  it('only exposes the privileged bridge from a trusted renderer location', () => {
    const source = preloadSource();
    expect(source).toContain('function isTrustedRendererLocation(location: PreloadLocation): boolean');
    expect(source).toContain("normalizedPath.endsWith('/renderer/index.html')");
    expect(source).toContain("location.hostname === 'localhost'");
    expect(source).toContain("location.port === '5173'");
    expect(source).toContain(
      'globalThis as typeof globalThis & { readonly location: PreloadLocation }',
    );

    const guard = 'if (isTrustedRendererLocation(currentLocation)) {';
    const expose = "contextBridge.exposeInMainWorld('framepilot', bridge);";
    expect(source).toContain(guard);
    expect(source.match(/contextBridge\.exposeInMainWorld\('framepilot', bridge\);/g)).toHaveLength(1);
    expect(source.indexOf(expose)).toBeGreaterThan(source.indexOf(guard));
  });
});
