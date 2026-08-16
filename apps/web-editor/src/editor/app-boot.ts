import type { Project } from '@framepilot/timeline-schema';
import { BROWSER_PATH_PREFIX, loadLastBrowserProject } from './persistence.js';
import { ensureBaseTracks } from './project.js';
import { demoProject } from './demo.js';
import { isDesktop } from './bridge.js';

export interface AppBootState {
  readonly project: Project | null;
  readonly path: string;
}

export interface AppBootDependencies {
  readonly desktop: () => boolean;
  readonly restore: () => Project | null;
  readonly demoRequested: () => boolean;
  readonly demo: Project;
}

const defaultDemoRequested = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).has('demo');
  } catch {
    return false;
  }
};

const DEFAULT_DEPENDENCIES: AppBootDependencies = {
  desktop: isDesktop,
  restore: loadLastBrowserProject,
  demoRequested: defaultDemoRequested,
  demo: demoProject,
};

/** Resolve project and path together so browser restore parses/validates only once. */
export function loadAppBootState(
  dependencies: AppBootDependencies = DEFAULT_DEPENDENCIES,
): AppBootState {
  if (dependencies.desktop()) return { project: null, path: '' };
  const restored = dependencies.restore();
  if (restored) {
    return {
      project: ensureBaseTracks(restored),
      path: `${BROWSER_PATH_PREFIX}${restored.id}`,
    };
  }
  if (dependencies.demoRequested()) {
    return {
      project: ensureBaseTracks(dependencies.demo),
      path: `${BROWSER_PATH_PREFIX}${dependencies.demo.id}`,
    };
  }
  return { project: null, path: '' };
}
