/**
 * `add_stock` in the trusted main process — download the chosen rendition, hand
 * back the asset, edit nothing.
 *
 * ## Why this is a module and not a closure in `main.ts`
 *
 * It carries the one decision that made a captured run fail four times in a row:
 * what an ABSENT `atSeconds` means. That decision has to match
 * `stockOpsFromPayload` in `@framepilot/ai-sdk` exactly, and while it lived
 * inline in a three-thousand-line `main.ts` nothing could test that it did — so
 * when ADR 0140's bin-gather mode was added to `editor-core`, the tool
 * description and the orchestrator, this half of the path kept the old
 * `atSeconds ?? 0` and quietly made the new mode unreachable on desktop.
 *
 * ## The contract, in one line each
 *
 * - **`atSeconds` given** — the clip is meant for the timeline. Refuse before
 *   spending the download if that span already holds picture (ADR 0140); the
 *   answer does not depend on the bytes. That refusal DECLARES its rule
 *   (`refusalCause`), so the run remembers it by what it is rather than by a
 *   sentence that changes with every placement. Echo the clamped position back.
 * - **`atSeconds` absent** — the clip is meant for the MEDIA BIN. There is no
 *   span to check, so there is nothing to refuse: this is how a run gathers
 *   several candidates before choosing a running order, and it is placed later
 *   with `add_clip`. Echo NO position back, so the orchestrator builds bin-only
 *   operations rather than reading an invented `0`.
 *
 * The host never mutates a timeline (AGENTS.md invariant 5): it returns an
 * asset, and the orchestrator turns that into the same reversible operations the
 * Stock panel builds by hand.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_STOCK_STILL_SECONDS, stockPlacementConflictReason } from '@framepilot/editor-core';
import { type HostToolOutcome, sourcingFailureNote } from '@framepilot/ai-sdk';
import type { Project } from '@framepilot/timeline-schema';
import type { StockDownloadRequest, StockDownloadResult } from '../ipc/contract.js';

/** The slice of `StockService` this host needs, so a test can supply it. */
export interface StockHostIO {
  /** Why `remoteId` cannot be acted on, or `null` when it can. */
  unresolvableReason(remoteId: string): string | null;
  /** The searched item behind `remoteId`, for its length before the download. */
  knownItem(remoteId: string): { readonly durationSeconds?: number | null | undefined } | undefined;
  download(request: StockDownloadRequest): Promise<StockDownloadResult>;
}

/**
 * Enrol a freshly downloaded asset into the visual index, in the background.
 *
 * D1. `describe_footage` returned `{"packets":[],"reason":"not_indexed"}` for every one of
 * the eleven calls captured run `e36235cc` made against its own downloads, because nothing
 * enrolled them: the only automatic enrolment is `autoIndexImportedAssets`, on the HUMAN
 * import path in the renderer. So a montage judged on visual variety, motion matching and
 * intensity-to-beat pairing was assembled blind.
 *
 * Optional, and never awaited by the download: enrolment is an optimization, it needs a
 * configured key, and a run that cannot index must still be able to place footage. Its own
 * failures are swallowed by the honest-degrade client, exactly as the import path's are.
 */
export type EnrolStockAsset = (input: {
  readonly projectId: string;
  readonly assetId: string;
}) => void;

/** The `add_stock` arguments as the sidecar executor forwards them. */
export interface StockHostArgs {
  readonly remoteId: string;
  readonly kind: 'photo' | 'video';
  /** Absent means the media bin; present means the timeline at that second. */
  readonly atSeconds?: number;
}

/**
 * Build the agent's `add_stock` host function.
 *
 * @param io - The stock service, narrowed to what this needs.
 * @returns The host function the sidecar executor calls.
 */
export function createStockHost(
  io: StockHostIO,
  enrol?: EnrolStockAsset,
): (project: Project, args: StockHostArgs) => Promise<HostToolOutcome> {
  return async (project, args) => {
    const { remoteId, atSeconds } = args;
    // One owner for "can this id be acted on", so the sentence the model gets names the
    // session boundary rather than leaving it to guess why a valid id stopped working.
    const unresolvable = io.unresolvableReason(remoteId);
    if (unresolvable !== null) {
      return { status: 'failed', summary: unresolvable };
    }
    const item = io.knownItem(remoteId)!;

    // A BIN-ONLY download has no span, so there is nothing to refuse. Checking
    // one anyway is the bug this module exists to prevent: it collapsed "no
    // position" into "position 0", and every gather after the first clip landed
    // was rejected for colliding with that clip.
    const start = atSeconds === undefined ? undefined : Math.max(0, atSeconds);
    if (start !== undefined) {
      // A still has no duration of its own; the placement builder gives it the
      // same default length a dragged-in image gets, and the occupancy check has
      // to use the same number or the two would disagree about what fits.
      const durationSeconds = item.durationSeconds ?? DEFAULT_STOCK_STILL_SECONDS;
      // Stated, not silently worked around. Stacking would preview differently from
      // how it renders, and reporting success on a stacked clip would be a completed
      // edit that lies. The sentence comes from `editor-core` so this pre-download
      // refusal and the orchestrator's post-download one cannot word it differently —
      // including the free moment it points at.
      const conflict = stockPlacementConflictReason(
        project.timeline,
        project.assets,
        start,
        durationSeconds,
      );
      if (conflict !== null) {
        // DECLARED, so the run remembers it by its RULE.
        //
        // This is a policy verdict, not a failure of the work: it is a pure function of
        // the arguments and the project handed in, reached before a byte is spent, and it
        // would say exactly the same thing if the identical call were made again. Every
        // OTHER `failed` this module returns — the unresolvable id above, the download
        // failure below — stays undeclared and therefore retryable, which is the default
        // host outcomes are given for good reason.
        //
        // Undeclared, this branch was the last unbounded arm of run `369e8c82`'s loop and
        // the one a real b-roll request hits FIRST: the orchestrator keys no host failure,
        // so the desktop refusal cost nothing per iteration and could repeat forever. The
        // sentence cannot be the identity — it interpolates both times and the conflicting
        // clip, so 4.48–6s and 4.2–6s read as two unrelated failures.
        return { status: 'failed', summary: conflict, refusalCause: 'picture_over_picture' };
      }
    }

    const result = await io.download({
      projectId: project.id,
      remoteId,
      targetHeight: project.resolution?.height ?? 1080,
      ...(project.fps ? { targetFps: project.fps } : {}),
      // `randomUUID`, not `Date.now()`: the agent now issues a turn's downloads
      // concurrently (03), and same-millisecond ids collided in the cancel map — two
      // downloads sharing one AbortController means cancelling either kills both.
      operationId: `agent_${remoteId}_${randomUUID()}`,
    });
    if (!result.ok) {
      // `stockErrorMessage` is the Stock PANEL's vocabulary and renders `cancelled` as the
      // empty string on purpose — right for a person who pressed Stop, and a tool card with
      // a red cross and no reason for the model. `sourcing-notes.ts` answers the same codes
      // for the caller that can only act by calling something.
      return {
        status: 'failed',
        summary: sourcingFailureNote('add_stock', result.error, result.detail),
      };
    }
    const { asset } = result;
    const assetId = `stock_${asset.source.provider}_${asset.source.remoteId}`.replace(
      /[^a-zA-Z0-9_]/g,
      '_',
    );
    // Fire-and-forget, on the COMMIT side of the download (D1). Deliberately not awaited:
    // it must never add to `add_stock` latency, which is the whole point of acquiring these
    // concurrently in the first place.
    enrol?.({ projectId: project.id, assetId });
    // `deduped` says whether this cost bandwidth or was already on disk. It was dropped
    // here, so nothing could tell a re-download from a free cache hit — which is exactly
    // the number that says whether warming a turn's downloads (ADR 0150) is working.
    const summary = asset.deduped
      ? `Already downloaded — reused "${asset.relativePath}".`
      : `Downloaded "${asset.relativePath}".`;
    return {
      status: 'completed',
      summary,
      data: {
        asset: {
          id: assetId,
          path: asset.relativePath,
          kind: asset.kind,
          ...(asset.durationSeconds === undefined
            ? {}
            : { durationSeconds: asset.durationSeconds }),
          ...(asset.media ? { media: asset.media } : {}),
          source: asset.source,
        },
        // Echoed back so the ORCHESTRATOR owns the placement decision; this
        // function still produces no timeline change of its own. ABSENT stays
        // absent — an echoed `0` would read as "place it at the head" and is
        // exactly how the bin-gather mode was lost on this surface.
        ...(start === undefined ? {} : { atSeconds: start }),
      },
    };
  };
}
