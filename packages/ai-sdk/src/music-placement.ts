/**
 * @framepilot/ai-sdk/music-placement — turning a downloaded track into timeline
 * operations.
 *
 * ## Why this is its own module
 *
 * Two callers place a fetched music bed: the Sounds panel (a person clicked Add)
 * and `add_music` (the agent decided). If they built their operations
 * separately they would drift, and the drift would be invisible until someone
 * noticed the agent's beds were not duckable or carried no credit.
 *
 * So the *shape* of "a music bed on the timeline" is defined once, here, and a
 * test asserts the two paths produce deep-equal timelines. The renderer's
 * `addMusicTrackPatch` wraps this same decision for its own store.
 *
 * ## The host downloads; it does not edit
 *
 * `add_music` reaches the network in the trusted host, then hands back an
 * asset. Everything after that is a typed, validated, reversible patch — the
 * host never mutates a timeline (AGENTS.md invariant 5). This module is the
 * boundary where a side effect becomes an edit.
 */
import { z } from 'zod';
import type { Asset, Project } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';

/** Default bed length when a provider reported no duration. */
const DEFAULT_MUSIC_SECONDS = 30;

/**
 * The host's `add_music` payload.
 *
 * Parsed rather than trusted: it crosses a process boundary, and a malformed
 * payload must fail the tool closed rather than produce a half-formed edit.
 */
export const MusicAssetPayloadSchema = z.object({
  asset: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    kind: z.literal('audio'),
    durationSeconds: z.number().positive().optional(),
    media: z
      .object({
        proxyPath: z.string().nullish(),
        peaks: z.array(z.number()).nullish(),
        peaksPerSecond: z.number().positive().nullish(),
        thumbnailPaths: z.array(z.string()).nullish(),
      })
      .nullish(),
    source: z.object({
      provider: z.string().min(1),
      remoteId: z.string().min(1),
      license: z.string().min(1),
      licenseUrl: z.string().optional(),
      attributionRequired: z.boolean(),
      attribution: z.string().optional(),
      creator: z.string().optional(),
      creatorUrl: z.string().optional(),
      sourceUrl: z.string().optional(),
      fetchedAt: z.string(),
    }),
  }),
  atSeconds: z.number().nonnegative().optional(),
});
export type MusicAssetPayload = z.infer<typeof MusicAssetPayloadSchema>;

/**
 * The next free `music_N` layer id for this project.
 *
 * Ids are per-project and stable within a run, so two `add_music` calls in one
 * turn land on separate layers rather than colliding.
 */
export function nextMusicLayerId(project: Project): string {
  const taken = new Set(project.timeline.tracks.map((track) => track.id));
  for (let n = 1; ; n += 1) {
    const candidate = `music_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The operations that put a downloaded track on the timeline: bin, layer, clip.
 *
 * Returned as ONE list so they land in one patch and invert together — a single
 * undo takes all three back rather than leaving an orphan asset or an empty
 * layer behind.
 *
 * The layer is labelled `role: 'music'` at creation, which is what lets
 * `adjust_audio`'s `duckUnderTrackId` and the role-based ducking controller see
 * the bed. The role is set here because this caller *knows*; it is never
 * inferred from a track name (ADR 0112).
 */
export function buildAddMusicOps(
  project: Project,
  asset: MusicAssetPayload['asset'],
  atSeconds = 0,
): AnyOperation[] {
  const start = Math.max(0, atSeconds);
  const duration = asset.durationSeconds ?? DEFAULT_MUSIC_SECONDS;
  const layerId = nextMusicLayerId(project);
  return [
    { type: 'add_asset', asset: asset as Asset },
    { type: 'add_layer', layerId, layerType: 'audio', atIndex: 0, role: 'music' },
    {
      type: 'add_clip',
      trackId: layerId,
      assetId: asset.id,
      start,
      end: start + duration,
      sourceStart: 0,
      sourceEnd: duration,
    },
  ];
}
