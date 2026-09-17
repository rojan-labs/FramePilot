/**
 * Transform-track artifacts for the monitor (MK7.1).
 *
 * A tracked mask pins `{ key, sha256 }`; the per-frame 3x3 transforms live in the project-owned
 * `<project>/.framepilot-derived/tracks/<key>/track.json`, which the renderer reaches through the
 * sandboxed `fp-media://` scheme exactly as it reaches a matte (`matte-location.ts`).
 *
 * The rules are the export's (`render/tracks.py` `prepare_track`), in the same order, so the
 * monitor never draws a mask the export would refuse:
 *
 * 1. a missing file refuses before its digest is asked about;
 * 2. the digest is checked before the document is parsed, so a tampered file never reaches the
 *    parser;
 * 3. a track measured with a different method than the mask asks for refuses.
 *
 * Unlike a matte's gigabyte masters, `track.json` is small (about 120 bytes per frame), so its
 * digest is verified here on every load rather than trusted from project validation.
 */
import { createLogger } from '@framepilot/shared-types';
import { parseTrackArtifact, type TrackArtifact } from '@framepilot/editor-core';
import type { MaskLayer } from '@framepilot/timeline-schema';

const log = createLogger('web-editor:preview:track-source');

/** Largest `track.json` the monitor reads (`TRACK_MAX_BYTES` of the engine). */
export const TRACK_MAX_BYTES = 64 * 1024 * 1024;

/** The engine's `TrackRefusal` codes the preview can reach. */
export type TrackRefusalCode =
  | 'track_missing'
  | 'track_digest_mismatch'
  | 'track_unreadable'
  | 'track_method_mismatch'
  | 'track_unavailable';

/** `TRACK_REMEDIES`: one sentence per code, identical to the export's. */
export const TRACK_REMEDIES: Readonly<Record<TrackRefusalCode, string>> = {
  track_missing: 'Tracking data is missing — track the mask again.',
  track_digest_mismatch: 'Tracking data was changed outside FramePilot — track the mask again.',
  track_unreadable: 'Tracking data is damaged — track the mask again.',
  track_method_mismatch:
    'Tracking data was measured with a different method — track the mask again.',
  track_unavailable: 'Tracked masks preview in the desktop app.',
};

/** What the monitor has for one tracked mask. */
export type TrackLookup =
  | { readonly state: 'ready'; readonly artifact: TrackArtifact }
  /** The file is being fetched; the clip is not drawn yet. */
  | { readonly state: 'pending' }
  | { readonly state: 'refused'; readonly code: TrackRefusalCode };

/** Where a track's file lives on this host; `null` when artifacts cannot be reached here. */
export type TrackArtifactLocator = (key: string) => string | null;

async function defaultFetchBytes(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Loads and caches the transform tracks a timeline's masks pin.
 *
 * One entry per artifact key (not per mask): two masks driven by the same track — which is the
 * point of `use_track` — decode and verify it once.
 */
export class TrackSource {
  private readonly cache = new Map<string, TrackLookup>();
  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(
    private readonly locate: TrackArtifactLocator | null,
    private readonly fetchBytes: (url: string) => Promise<Uint8Array | null> = defaultFetchBytes,
  ) {}

  /**
   * What is known about `mask`'s track right now, starting a load when nothing is known yet.
   *
   * Never throws: a host that cannot reach artifacts answers `track_unavailable`, which the
   * stack turns into a visible refusal with a remedy rather than an unmasked clip.
   */
  public lookup(mask: MaskLayer): TrackLookup {
    const tracking = mask.tracking;
    if (tracking === undefined) return { state: 'refused', code: 'track_missing' };
    const key = tracking.artifact.key;
    const known = this.cache.get(key);
    if (known !== undefined) return this.checkedMethod(known, mask);
    if (this.locate === null) return { state: 'refused', code: 'track_unavailable' };
    if (!this.inFlight.has(key)) {
      this.inFlight.set(
        key,
        this.load(key, tracking.artifact.sha256).finally(() => this.inFlight.delete(key)),
      );
    }
    return { state: 'pending' };
  }

  /** Drop everything, for a project close or a re-track that reuses a key. */
  public clear(): void {
    this.cache.clear();
  }

  /** Forget one key, so the next lookup re-reads it (a finished re-track). */
  public invalidate(key: string): void {
    this.cache.delete(key);
  }

  private checkedMethod(lookup: TrackLookup, mask: MaskLayer): TrackLookup {
    if (lookup.state !== 'ready') return lookup;
    return lookup.artifact.method === mask.tracking?.method
      ? lookup
      : { state: 'refused', code: 'track_method_mismatch' };
  }

  private async load(key: string, sha256: string): Promise<void> {
    const url = this.locate?.(key) ?? null;
    if (url === null) {
      this.cache.set(key, { state: 'refused', code: 'track_unavailable' });
      return;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await this.fetchBytes(url);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      this.cache.set(key, { state: 'refused', code: 'track_missing' });
      return;
    }
    if (bytes.byteLength > TRACK_MAX_BYTES) {
      this.cache.set(key, { state: 'refused', code: 'track_unreadable' });
      return;
    }
    if ((await sha256Hex(bytes)) !== sha256) {
      log.warn('trackDigestMismatch', { key });
      this.cache.set(key, { state: 'refused', code: 'track_digest_mismatch' });
      return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.charCodeAt(0) === 0xfeff) throw new Error('byte-order mark');
      this.cache.set(key, { state: 'ready', artifact: parseTrackArtifact(JSON.parse(text)) });
    } catch {
      this.cache.set(key, { state: 'refused', code: 'track_unreadable' });
    }
  }
}
