/**
 * @framepilot/ai-sdk/music-placement — the `add_music` host payload boundary.
 *
 * ## What is here, and what moved
 *
 * The *shape* of "a music bed on the timeline" lives in
 * `@framepilot/editor-core` (`buildAddMusicOps`), shared with the Sounds panel
 * so the agent path and the manual path cannot drift. What is left here is the
 * process boundary: the host's payload is **parsed, not trusted**, because it
 * crosses a process boundary and a malformed one must fail the tool closed
 * rather than produce a half-formed edit.
 *
 * ## The host downloads; it does not edit
 *
 * `add_music` reaches the network in the trusted host, then hands back an
 * asset. Everything after that is a typed, validated, reversible patch — the
 * host never mutates a timeline (AGENTS.md invariant 5). This module is the
 * boundary where a side effect becomes an edit.
 */
import { z } from 'zod';

// Re-exported so existing importers (the orchestrator, the desktop main process)
// reach the shared builder through this module's stable surface.
export {
  DEFAULT_DUCK_DB,
  DEFAULT_MUSIC_SECONDS,
  buildAddMusicOps,
  musicDuckSidechainIssue,
  nextMusicLayerId,
  pictureEndSeconds,
} from '@framepilot/editor-core';

/**
 * Is this `remoteId` actually the id of a track the project already holds?
 *
 * `add_music` mints its bin id from the provider identity — `music_<provider>_<remoteId>`,
 * squeezed to `[A-Za-z0-9_]` — so the id it PRODUCES is a plausible thing for a later turn
 * to hand back to it, and `list_assets` shows exactly that string. It was not accepted:
 * the id went to the network, the provider did not recognise it, and the tool answered
 * `unknown_track` — "Search again and use an id from the new results".
 *
 * That advice is right for a stale provider id and wrong for this one. The track is on
 * disk; no search result will ever return a local id, so searching is the single recovery
 * that cannot work. Run `fc10301a` lost a turn and 34 seconds of reasoning to it, and it
 * reproduces on every project reopened after a track was fetched.
 *
 * Placing an asset the project already owns is `add_clip`'s job, so the refusal says that
 * instead of sending the model back to the network.
 *
 * Pure and host-agnostic so the rule is testable here rather than only inside the Electron
 * main process, which is where the bug lived.
 *
 * @param assets - The project's media bin.
 * @param remoteId - Whatever the model passed as `add_music`'s `remoteId`.
 * @returns The refusal sentence, or `undefined` when this really is a remote id.
 */
export function localMusicAssetRefusal(
  assets: readonly { readonly id: string; readonly kind: string }[],
  remoteId: string,
): string | undefined {
  const held = assets.find((asset) => asset.id === remoteId);
  if (!held) return undefined;
  return (
    `"${remoteId}" is ${held.kind === 'audio' ? 'a track' : 'an asset'} already in this ` +
    "project's media bin, not a search result. Place it with add_clip on an audio track."
  );
}

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
