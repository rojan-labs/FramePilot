/**
 * The transform tracks a clip's masks pin, for the monitor's editing tools (MK7.7).
 *
 * A tracked mask is DRAWN as `T(t) · G(t)`, so the monitor's handles belong where it is drawn,
 * and an edit there is a correction relative to the track (`correct_tracked_mask`), not a new
 * value of `G`. This hook hands the tools the same verified artifacts the preview draws with:
 * the same locator, the same digest check, the same method check (`TrackSource`). A track that
 * is loading, refused or unreachable is simply absent, and the tools then edit the mask's own
 * geometry exactly as before.
 */
import { useEffect, useMemo, useState } from 'react';
import type { TrackArtifact } from '@framepilot/editor-core';
import { masksOf, type Clip, type MaskLayer } from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';
import { resolveTrackArtifactLocator } from '../../preview/masks/track-location.js';
import { TrackSource } from '../../preview/masks/track-source.js';

const log = createLogger('web-editor:preview:mask-track-artifacts');

let shared: TrackSource | null = null;

/** One cache for the tools; the preview engine keeps its own, and both verify every load. */
function source(): TrackSource {
  shared ??= new TrackSource(resolveTrackArtifactLocator());
  return shared;
}

/** Forget a key, so the tools re-read it after a re-track that reused it. */
export function invalidateToolTrack(key: string): void {
  shared?.invalidate(key);
}

/**
 * The ready track of every tracked mask on `clip`, by mask id.
 *
 * @param clip - The clip whose masks the tools edit, or `null`.
 */
export function useMaskTrackArtifacts(clip: Clip | null): ReadonlyMap<string, TrackArtifact> {
  const tracked = useMemo(
    () => (clip === null ? [] : masksOf(clip).filter((mask) => mask.tracking !== undefined)),
    [clip],
  );
  const pins = tracked
    .map((mask) => `${mask.id}:${mask.tracking!.artifact.key}:${mask.tracking!.artifact.sha256}`)
    .join('|');
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    if (tracked.length === 0) return undefined;
    let live = true;
    source()
      .ensure(tracked)
      .then(() => {
        if (live) setLoaded((count) => count + 1);
      })
      .catch((error: unknown) => {
        log.warn('toolTrackLoadFailed', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      });
    return () => {
      live = false;
    };
    // `pins` is the identity of what is loaded; `tracked` changes with every edit of the clip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins]);
  return useMemo(() => {
    const ready = new Map<string, TrackArtifact>();
    for (const mask of tracked as readonly MaskLayer[]) {
      const lookup = source().lookup(mask);
      if (lookup.state === 'ready') ready.set(mask.id, lookup.artifact);
    }
    return ready;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, loaded]);
}
