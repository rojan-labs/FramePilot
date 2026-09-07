/**
 * Batches background visual-index enrolment for freshly acquired assets.
 *
 * ## The defect
 *
 * `add_stock` enrolled its download by calling `runVisualIndexLoop` fire-and-forget, once
 * per call, with no bound of any kind. Three things followed from that, and all three got
 * worse the better the run was doing:
 *
 *  - **No dedupe.** A turn's downloads are warmed concurrently and then committed in
 *    series, so every asset enrolled at least twice; a re-requested id that hit the bin
 *    dedupe enrolled again on top of that.
 *  - **No batching.** `/brain/visual/index` takes `assetIds` as a LIST and paces its own
 *    slices, and the engine holds a per-project lock across read → process → write. N
 *    single-asset loops for one project therefore serialize on that lock anyway — while
 *    each one occupies a slot in Starlette's 40-slot threadpool waiting its turn. A
 *    42-download turn was 42+ loops queueing to do what one loop does natively, and the
 *    sidecar has no threads left over for the render, analysis and asset-media calls the
 *    same run depends on.
 *  - **No signal.** Nothing could stop them. Quitting the app or closing the project left
 *    them running against a sidecar that was being shut down.
 *
 * ## The shape that fixes it
 *
 * One loop in flight per project, ever. Ids that arrive while a loop is running collect
 * into the next batch and go out together when it finishes — so the FIRST asset starts
 * immediately (enrolment is not delayed behind a timer) and every asset after it rides a
 * batch, which is exactly the pacing the engine route was written for. Nothing is enrolled
 * twice, and an abort signal ends the whole thing.
 *
 * ## Why this is now the app's only enrolment path
 *
 * It was built for `add_stock` and used by nothing else, while the renderer ran its own
 * per-import warm-up and the Stock and Sounds panels ran none. Every acquired asset —
 * human import, agent download, panel download — goes through this one loop now
 * (ADR 0175). The batching argument above is the reason it can: an import of forty files
 * and a turn of forty downloads are the same shape of work, and the engine paces both
 * from one list.
 *
 * A batch that does not complete FORGETS its ids, so they can be enrolled again later.
 * Remembering them would be right if failure meant "already done", and it does not: the
 * realistic failure is a sidecar that had not finished starting when the project opened,
 * and the assets imported in that window would stay unmeasured for the whole session.
 */
import { createLogger } from '@framepilot/shared-types';
import type { ImportAssetRequest, ImportAssetResult } from '../ipc/contract.js';

const log = createLogger('desktop:asset-enrolment');

/** The project asset an acquisition produced, as the enroller needs to name it. */
export interface EnrolmentTarget {
  readonly projectId: string;
  readonly assetId: string;
}

/**
 * Whether a finished media-import derivation should be enrolled, and as what.
 *
 * Extracted from the IPC handler because it is the whole import-side policy and there is
 * nothing else in that handler worth testing. Note what it does NOT consult: no API key,
 * no provider, no setting. Tier 0 of the shot ledger is one local ffmpeg pass (ADR 0175),
 * so a clean install with nothing configured enrols exactly like a fully configured one.
 *
 * @param request - The import request, whose ids say which asset this file is.
 * @param result - What the sidecar's `/asset-media` route returned.
 * @returns The target to enrol, or `null` when there is nothing to enrol.
 */
export function enrolmentTargetFor(
  request: ImportAssetRequest,
  result: ImportAssetResult,
): EnrolmentTarget | null {
  // A failed derivation wrote no brain row, and the visual index answers `asset not known
  // to brain` for anything that has none — enrolling would burn the id on a certain miss.
  if (!result.ok) return null;
  // Without both ids the sidecar was explicitly told to skip the brain write.
  if (request.projectId === undefined || request.assetId === undefined) return null;
  // The ledger is a ledger of PICTURES. A track is recorded in the brain by the same call
  // and simply has no shots; asking the engine to measure it is noise, not coverage.
  if (result.kind === 'audio') return null;
  return { projectId: request.projectId, assetId: request.assetId };
}

/**
 * How many projects keep an enrolment record. The main process outlives every project it
 * opens, so "remember what has been enrolled" has to have an end. Oldest-first; evicting a
 * project costs a redundant enrolment if it is reopened, never a wrong one.
 */
const DEFAULT_MAX_TRACKED_PROJECTS = 32;

export interface AssetEnrolmentOptions {
  /**
   * Run one enrolment for a whole batch. A rejection means the batch did not land: it is
   * logged, never rethrown, and the ids are forgotten so a later request retries them.
   */
  readonly enrol: (input: {
    readonly projectId: string;
    readonly assetIds: readonly string[];
    readonly signal: AbortSignal;
  }) => Promise<void>;
  /** Ends all enrolment — app shutdown. */
  readonly signal: AbortSignal;
  readonly maxTrackedProjects?: number;
  /** Injected for tests; defaults to `queueMicrotask`. */
  readonly schedule?: (run: () => void) => void;
}

export interface AssetEnroller {
  /** Ask for `assetId` to be enrolled. Returns at once; never throws. */
  request(projectId: string, assetId: string): void;
  /** Resolves when no batch is running or pending. Test and shutdown seam. */
  settled(): Promise<void>;
}

/**
 * Build the enroller.
 *
 * @param options - The batch runner, the app-lifetime abort signal, and test seams.
 */
export function createAssetEnroller(options: AssetEnrolmentOptions): AssetEnroller {
  const schedule = options.schedule ?? ((run: () => void) => queueMicrotask(run));
  const maxTracked = Math.max(1, options.maxTrackedProjects ?? DEFAULT_MAX_TRACKED_PROJECTS);
  /** Ids asked for but not yet sent, per project. */
  const pending = new Map<string, Set<string>>();
  /** Ids already sent (or in flight), per project — the dedupe. */
  const seen = new Map<string, Set<string>>();
  /** Projects with a batch in flight; the invariant this whole module exists to hold. */
  const running = new Set<string>();
  let active = 0;
  let idle: { promise: Promise<void>; resolve: () => void } | null = null;

  const settleIfIdle = (): void => {
    if (active > 0 || pending.size > 0 || idle === null) return;
    const waiter = idle;
    idle = null;
    waiter.resolve();
  };

  // An abort drops everything not yet sent. Without this, work queued behind a batch that
  // was in flight at shutdown would keep a `settled()` waiter hanging forever.
  options.signal.addEventListener(
    'abort',
    () => {
      pending.clear();
      settleIfIdle();
    },
    { once: true },
  );

  const seenFor = (projectId: string): Set<string> => {
    const existing = seen.get(projectId);
    if (existing) {
      // Refresh recency so the project being worked on is not the one evicted.
      seen.delete(projectId);
      seen.set(projectId, existing);
      return existing;
    }
    const fresh = new Set<string>();
    seen.set(projectId, fresh);
    while (seen.size > maxTracked) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
    return fresh;
  };

  const drain = (projectId: string): void => {
    if (options.signal.aborted || running.has(projectId)) return;
    const queued = pending.get(projectId);
    if (!queued || queued.size === 0) {
      pending.delete(projectId);
      settleIfIdle();
      return;
    }
    pending.delete(projectId);
    const assetIds = [...queued];
    running.add(projectId);
    active += 1;

    void options
      .enrol({ projectId, assetIds, signal: options.signal })
      .catch((error: unknown) => {
        // Enrolment is an optimization: a run that cannot index must still place footage.
        // Same honest-degrade contract the import path has.
        log.debug('asset enrolment failed', {
          projectId,
          assets: assetIds.length,
          error: error instanceof Error ? error.message : String(error),
        });
        // Forget the ids. A failed batch is not a completed one, and the asset must stay
        // eligible for the next acquisition or session to enrol it.
        const already = seen.get(projectId);
        if (already) for (const assetId of assetIds) already.delete(assetId);
      })
      .finally(() => {
        running.delete(projectId);
        active -= 1;
        // Everything that arrived while this batch ran goes out as ONE follow-up batch.
        if (pending.has(projectId)) drain(projectId);
        else settleIfIdle();
      });
  };

  return {
    request(projectId: string, assetId: string): void {
      if (options.signal.aborted) return;
      const already = seenFor(projectId);
      if (already.has(assetId)) return;
      already.add(assetId);
      const queued = pending.get(projectId) ?? new Set<string>();
      queued.add(assetId);
      pending.set(projectId, queued);
      // Scheduled rather than immediate so a same-tick burst leaves as one batch.
      schedule(() => drain(projectId));
    },
    settled(): Promise<void> {
      if (active === 0 && pending.size === 0) return Promise.resolve();
      if (idle === null) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        idle = { promise, resolve };
      }
      return idle.promise;
    },
  };
}
