import { describe, expect, it, vi } from 'vitest';
import { demoProject } from './demo.js';
import { loadAppBootState } from './app-boot.js';

describe('loadAppBootState', () => {
  it('restores the browser project exactly once while deriving both project and path', () => {
    const restore = vi.fn(() => demoProject);
    const state = loadAppBootState({
      desktop: () => false,
      restore,
      demoRequested: () => false,
      demo: demoProject,
    });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(state.project?.id).toBe(demoProject.id);
    expect(state.path).toBe(`local://${demoProject.id}`);
  });

  it('does not touch browser storage in desktop mode', () => {
    const restore = vi.fn(() => demoProject);
    expect(
      loadAppBootState({
        desktop: () => true,
        restore,
        demoRequested: () => false,
        demo: demoProject,
      }),
    ).toEqual({ project: null, path: '' });
    expect(restore).not.toHaveBeenCalled();
  });
});
