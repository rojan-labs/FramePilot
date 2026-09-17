import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { estimateMatteBytes, freeDiskBytes, MATTE_DISK_HEADROOM } from './matte-disk.js';

const MIB = 1024 * 1024;

describe('matte disk preflight estimate', () => {
  it('reproduces the BR0 storage-per-minute measurements at 1080p30 and 4K30 (plus previews)', () => {
    const minute = 30 * 60;
    const hd = estimateMatteBytes(1920, 1080, minute, true);
    expect(hd.estimatedBytes).toBeCloseTo((23.2 + 81.4) * MIB * 1.1, -3);
    expect(estimateMatteBytes(1920, 1080, minute, false).estimatedBytes).toBeCloseTo(23.2 * MIB * 1.1, -3);
    expect(estimateMatteBytes(3840, 2160, minute, true).estimatedBytes).toBeCloseTo((61.2 + 218.6) * MIB * 1.1, -3);
    expect(hd.requiredBytes).toBe(Math.ceil(hd.estimatedBytes * MATTE_DISK_HEADROOM));
  });

  it('scales with clip length and never goes to zero or negative for small frames', () => {
    const ten = estimateMatteBytes(1920, 1080, 300, true).estimatedBytes;
    expect(estimateMatteBytes(1920, 1080, 600, true).estimatedBytes).toBeCloseTo(ten * 2, -2);
    expect(estimateMatteBytes(64, 36, 30, true).estimatedBytes).toBeGreaterThan(0);
  });

  it('reads free space from the volume', async () => {
    expect(await freeDiskBytes(tmpdir())).toBeGreaterThan(0);
  });
});
