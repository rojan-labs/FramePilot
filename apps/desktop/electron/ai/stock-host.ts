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
 * - **`atSeconds` given** — the clip is meant for the timeline. Echo the clamped
 *   position back and let the orchestrator place it.
 *
 *   This host no longer refuses an occupied span. Under ADR 0169 a full-frame
 *   cutaway is LIFTED onto a layer in front of the picture it covers, and whether
 *   this clip qualifies depends on its measured shape — which arrives WITH the
 *   download and is not knowable here (`knownItem` carries a length and nothing
 *   else). Refusing on occupancy alone therefore refused the cutaway the tool
 *   exists to make: in run `19e20922`, 35 of 38 calls. The orchestrator holds the
 *   asset and the working copy and makes the ADR 0169 decision once, for
 *   `add_stock` and `add_clip` alike, and still DECLARES its rule
 *   (`refusalCause`) for the placements that genuinely cannot be shown.
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
import { type HostToolOutcome, sourcingFailureNote } from '@framepilot/ai-sdk';
import type { Project } from '@framepilot/timeline-schema';
import type { StockDownloadRequest, StockDownloadResult } from '../ipc/contract.js';
import { sourcedAssetId } from '../media/sourced-asset-id.js';

/** The slice of `StockService` this host needs, so a test can supply it. */
export interface StockHostIO {
  /** Why `remoteId` cannot be acted on, or `null` when it can. */
  unresolvableReason(remoteId: string): string | null;
  /**
   * The searched item behind `remoteId`.
   *
   * Kept as part of the contract even though the length is no longer read here: the
   * resolvability check above is answered from the same session state, and a host that
   * cannot name its items cannot report an unresolvable id.
   */
  knownItem(remoteId: string): { readonly durationSeconds?: number | null | undefined } | undefined;
  download(request: StockDownloadRequest): Promise<StockDownloadResult>;
}

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
): (project: Project, args: StockHostArgs) => Promise<HostToolOutcome> {
  return async (project, args) => {
    const { remoteId, atSeconds } = args;
    // One owner for "can this id be acted on", so the sentence the model gets names the
    // session boundary rather than leaving it to guess why a valid id stopped working.
    const unresolvable = io.unresolvableReason(remoteId);
    if (unresolvable !== null) {
      return { status: 'failed', summary: unresolvable };
    }
    // A BIN-ONLY download has no span, so there is nothing to refuse. Checking
    // one anyway is the bug this module exists to prevent: it collapsed "no
    // position" into "position 0", and every gather after the first clip landed
    // was rejected for colliding with that clip.
    const start = atSeconds === undefined ? undefined : Math.max(0, atSeconds);

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
    // A success with nothing in it is a failure, and must say so rather than throw. The
    // download surface is a typed union, but it crosses a process boundary from a provider
    // this module does not own: `ok: true` with no asset used to be unreachable only
    // because the occupancy refusal returned first on the path that produced it.
    if (!asset) {
      return {
        status: 'failed',
        summary:
          'The download reported success but returned no file. Nothing was added to your ' +
          'media bin — call search_stock again and add_stock a different result.',
      };
    }
    // The SAME id the download's brain row and its enrolment were keyed by — one
    // formula, one owner, or the project references an asset the ledger never measured.
    const assetId = sourcedAssetId('stock', asset.source.provider, asset.source.remoteId);
    // No enrolment here any more. `io.download` is the app's single stock acquisition
    // path and it enrols what it commits (ADR 0175), so the agent's downloads and the
    // Stock panel's are measured by the same rule — this host had its own hook, and the
    // panel had none.
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
