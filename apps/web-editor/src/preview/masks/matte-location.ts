/**
 * Where the monitor reads a matte artifact's files (BR5.1).
 *
 * Artifacts are project-owned: `<project folder>/.framepilot-derived/mattes/<key>/<file>`
 * (`render/mattes.py` `MATTES_DIR`, plan 03 MD-4). On the desktop the renderer reaches them
 * through the sandboxed `fp-media://` scheme, which only serves paths inside the projects root,
 * so nothing new is exposed. The plain browser build has no project folder and no artifact; the
 * parity oracle stands in for the desktop with `window.__fpMatteArtifactUrl`.
 */
import { getBridge } from '../../editor/bridge-base.js';
import { mediaSrc } from '../../editor/media.js';
import type { MatteArtifactLocator, MatteTierLocator } from './matte-source.js';

const KEY = /^[0-9a-f]{64}$/;
const FILE_NAMES = new Set([
  'matte.mkv',
  'foreground.mkv',
  'preview.webm',
  'foreground.preview.webm',
  'frames.json',
  'report.json',
]);

/** The monitor tier's files (`render/matte_tier.py`), PX5.3. */
const TIER_FILE_NAMES = new Set(['tier.json', 'planes.mkv']);

let activeProjectPath = '';

/** The open project's file path on disk (`''` when unsaved or in the browser). */
export function setActiveProjectPath(path: string): void {
  activeProjectPath = path;
}

function projectFolder(path: string): string | null {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : null;
}

/** The open project's folder, shared with the other project-owned artifact locators (MK7.1). */
export function activeProjectFolder(): string | null {
  return projectFolder(activeProjectPath);
}

/** The locator for this host, or `null` when artifacts cannot be reached here. */
export function resolveMatteArtifactLocator(): MatteArtifactLocator | null {
  const hook =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { __fpMatteArtifactUrl?: MatteArtifactLocator }).__fpMatteArtifactUrl;
  const guard =
    (locate: MatteArtifactLocator): MatteArtifactLocator =>
    (key, name) =>
      KEY.test(key) && FILE_NAMES.has(name) ? locate(key, name) : null;
  if (hook !== undefined) return guard(hook);
  if (getBridge() === null) return null;
  const folder = projectFolder(activeProjectPath);
  if (folder === null) return null;
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return guard((key, name) =>
    mediaSrc([folder, '.framepilot-derived', 'mattes', key, name].join(separator)),
  );
}

/**
 * PX5.3: where the monitor reads an artifact's monitor tier, `<project folder>/.framepilot-
 * derived/matte-tiers/<key>/<file>` (`render/matte_tier.py`): beside the artifact, never in it.
 * Same scheme and root as the artifact itself, so nothing new is exposed. `null` when this host
 * cannot reach one; the parity oracle and the Scale-row run stand in with `__fpMatteTierUrl`.
 */
export function resolveMatteTierLocator(): MatteTierLocator | null {
  const hook =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { __fpMatteTierUrl?: MatteTierLocator }).__fpMatteTierUrl;
  const guard =
    (locate: MatteTierLocator): MatteTierLocator =>
    (key, name) =>
      KEY.test(key) && TIER_FILE_NAMES.has(name) ? locate(key, name) : null;
  if (hook !== undefined) return guard(hook);
  if (getBridge() === null) return null;
  const folder = projectFolder(activeProjectPath);
  if (folder === null) return null;
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return guard((key, name) =>
    mediaSrc([folder, '.framepilot-derived', 'matte-tiers', key, name].join(separator)),
  );
}
