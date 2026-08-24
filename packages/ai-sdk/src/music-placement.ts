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
 * Default duck depth, matching `audio-commands.ts`: a duck requested without an
 * explicit amount lands on −12 dB — deep enough to clear speech, shallow enough
 * to keep the bed audible.
 */
export const DEFAULT_DUCK_DB = -12;

/**
 * The host's `add_music` payload.
 *
 * Parsed rather than trusted: it crosses a process boundary, and a malformed
 * payload must fail the tool closed rather than produce a half-formed edit.
 * `atSeconds` and `duckUnderTrackId` echo back what the model asked for, so the
 * placement decision stays with the orchestrator and the host stays download-only.
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
  duckUnderTrackId: z.string().min(1).optional(),
});
export type MusicAssetPayload = z.infer<typeof MusicAssetPayloadSchema>;

/**
 * Why `duckUnderTrackId` cannot be honored, or `null` when it can.
 *
 * The validator would accept a duck at an unknown sidechain track and the render
 * would silently apply no duck at all — a bed the model believes is under the
 * voice but that plays at full level. So the sidechain is resolved HERE, where a
 * specific sentence can fail the tool before any edit exists.
 */
export function musicDuckSidechainIssue(
  project: Project,
  duckUnderTrackId: string | undefined,
): string | null {
  if (duckUnderTrackId === undefined || duckUnderTrackId.trim() === '') return null;
  const track = project.timeline.tracks.find((candidate) => candidate.id === duckUnderTrackId);
  if (!track) {
    return (
      `duckUnderTrackId "${duckUnderTrackId}" is not a track in this project. ` +
      'Pass the id of the dialogue track the bed should drop under.'
    );
  }
  if (track.clips.length === 0) {
    return (
      `duckUnderTrackId "${duckUnderTrackId}" names a track with no clips, so there is ` +
      'nothing to duck under. Place the dialogue first, or omit duckUnderTrackId.'
    );
  }
  return null;
}

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
 * The operations that put a downloaded track on the timeline: bin, layer, clip,
 * and — when a sidechain was requested — the duck that keeps speech clear.
 *
 * Returned as ONE list so they land in one patch and invert together — a single
 * undo takes all of them back rather than leaving an orphan asset, an empty
 * layer, or an unducked bed behind.
 *
 * The layer is labelled `role: 'music'` at creation, which is what lets
 * `adjust_audio`'s `duckUnderTrackId` and the role-based ducking controller see
 * the bed. The role is set here because this caller *knows*; it is never
 * inferred from a track name (ADR 0112).
 *
 * The clip id is deterministic (`${layerId}_clip`) because the duck op must name
 * the clip it adjusts in the SAME list — the derived fallback id would not be
 * knowable before apply.
 *
 * Callers must resolve the sidechain first (`musicDuckSidechainIssue`): this
 * builder trusts that the track exists, so the failure lands as one specific
 * sentence rather than as a silent no-op at render.
 */
export function buildAddMusicOps(
  project: Project,
  asset: MusicAssetPayload['asset'],
  atSeconds = 0,
  duckUnderTrackId?: string,
): AnyOperation[] {
  const start = Math.max(0, atSeconds);
  const duration = asset.durationSeconds ?? DEFAULT_MUSIC_SECONDS;
  const layerId = nextMusicLayerId(project);
  const sidechain = duckUnderTrackId?.trim();
  return [
    { type: 'add_asset', asset: asset as Asset },
    { type: 'add_layer', layerId, layerType: 'audio', atIndex: 0, role: 'music' },
    {
      type: 'add_clip',
      trackId: layerId,
      assetId: asset.id,
      clipId: `${layerId}_clip`,
      start,
      end: start + duration,
      sourceStart: 0,
      sourceEnd: duration,
    },
    ...(sidechain !== undefined && sidechain !== ''
      ? [
          {
            type: 'adjust_audio' as const,
            clipId: `${layerId}_clip`,
            gainDb: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
            duckUnderTrackId: sidechain,
            duckAmountDb: DEFAULT_DUCK_DB,
          },
        ]
      : []),
  ];
}
