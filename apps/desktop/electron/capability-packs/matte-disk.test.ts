import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { estimateMatteBytes, freeDiskBytes, MATTE_DISK_HEADROOM, matteStagingBudgetBytes } from './matte-disk.js';

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

  it('budgets the staging folder at three ceilings plus one window of scratch (F1)', () => {
    const GIB = 1024 * MIB;
    const ceiling = 2 * GIB;
    // A 4K job longer than a window: 360 frames of scratch, not the whole clip.
    const long = matteStagingBudgetBytes(3840, 2160, 10_000, ceiling);
    expect(long).toBe(3 * ceiling + 360 * 3840 * 2160 * 16 + 9 * GIB);
    expect(matteStagingBudgetBytes(3840, 2160, 100_000, ceiling)).toBe(long);
    // A short job holds only its own frames.
    expect(matteStagingBudgetBytes(64, 36, 10, 1_000)).toBe(3_000 + 10 * 64 * 36 * 16 + 9 * GIB);
  });

  it('reads free space from the volume', async () => {
    expect(await freeDiskBytes(tmpdir())).toBeGreaterThan(0);
  });
});
