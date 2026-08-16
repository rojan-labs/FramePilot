/**
 * Tests for the orientation presets (H5): aspect matching (pixel-count agnostic),
 * custom detection, and the pure project transform.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import {
  CUSTOM_ORIENTATION_ID,
  ORIENTATION_PRESETS,
  orientationIdFor,
  withOrientation,
} from './orientation.js';

const projectAt = (width: number, height: number): Project =>
  ({ resolution: { width, height } }) as Project;

describe('orientationIdFor', () => {
  it('matches presets by aspect regardless of pixel count', () => {
    expect(orientationIdFor({ width: 1920, height: 1080 })).toBe('16:9');
    expect(orientationIdFor({ width: 3840, height: 2160 })).toBe('16:9');
    expect(orientationIdFor({ width: 1080, height: 1920 })).toBe('9:16');
    expect(orientationIdFor({ width: 720, height: 720 })).toBe('1:1');
    expect(orientationIdFor({ width: 1080, height: 1350 })).toBe('4:5');
    expect(orientationIdFor({ width: 2560, height: 1080 })).toBe('21:9');
  });

  it('reports custom for non-preset aspects and degenerate sizes', () => {
    expect(orientationIdFor({ width: 1234, height: 999 })).toBe(CUSTOM_ORIENTATION_ID);
    expect(orientationIdFor({ width: 0, height: 1080 })).toBe(CUSTOM_ORIENTATION_ID);
  });
});

describe('withOrientation', () => {
  it('returns a project with the preset resolution', () => {
    const next = withOrientation(projectAt(1920, 1080), '9:16');
    expect(next.resolution).toEqual({ width: 1080, height: 1920 });
  });

  it('is a no-op for the same resolution, unknown ids, and custom', () => {
    const project = projectAt(1080, 1920);
    expect(withOrientation(project, '9:16')).toBe(project);
    expect(withOrientation(project, 'nope')).toBe(project);
    expect(withOrientation(project, CUSTOM_ORIENTATION_ID)).toBe(project);
  });

  it('every preset id round-trips through orientationIdFor', () => {
    for (const preset of ORIENTATION_PRESETS) {
      expect(orientationIdFor(withOrientation(projectAt(999, 998), preset.id).resolution)).toBe(
        preset.id,
      );
    }
  });
});
