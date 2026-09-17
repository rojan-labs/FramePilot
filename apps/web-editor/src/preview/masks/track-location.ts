/**
 * Where the monitor reads a transform-track artifact (MK7.1).
 *
 * The matte twin of `matte-location.ts`, and deliberately the same shape: artifacts are
 * project-owned (`<project folder>/.framepilot-derived/tracks/<key>/track.json`,
 * `render/tracks.py` `TRACKS_DIR`), and the renderer reaches them through the sandboxed
 * `fp-media://` scheme, which only serves paths inside the projects root, so nothing new is
 * exposed. The plain browser build has no project folder and no artifact; the parity oracle
 * stands in for the desktop with `window.__fpTrackArtifactUrl`.
 */
import { getBridge } from '../../editor/bridge-base.js';
import { mediaSrc } from '../../editor/media.js';
import { activeProjectFolder } from './matte-location.js';
import type { TrackArtifactLocator } from './track-source.js';

const KEY = /^[0-9a-f]{64}$/;
const TRACK_FILE = 'track.json';

/** The locator for this host, or `null` when artifacts cannot be reached here. */
export function resolveTrackArtifactLocator(): TrackArtifactLocator | null {
  const hook =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { __fpTrackArtifactUrl?: TrackArtifactLocator }).__fpTrackArtifactUrl;
  const guard =
    (locate: TrackArtifactLocator): TrackArtifactLocator =>
    (key) =>
      KEY.test(key) ? locate(key) : null;
  if (hook !== undefined) return guard(hook);
  if (getBridge() === null) return null;
  const folder = activeProjectFolder();
  if (folder === null) return null;
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return guard((key) =>
    mediaSrc([folder, '.framepilot-derived', 'tracks', key, TRACK_FILE].join(separator)),
  );
}
