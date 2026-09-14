/**
 * Hold a Capability Pack lease for the whole engine-driven run that references it (R4.3).
 *
 * WHY: `resolveVisualPackHandles` (`visual-packs.ts`) hands the engine a JSON handle —
 * an install path and an entrypoint — for `/brain/visual/index`, `/brain/visual/search`
 * and `/brain/visual/describe`. Unlike the tracking packs (`tracking.ts`), which the
 * DESKTOP itself launches and can wrap in `store.acquireLease()/release()` around the
 * whole chunked call (commit b98a7d0b, "under one lease"), a visual-embed or
 * visual-describe run is driven by the ENGINE: one HTTP request can make the engine spawn
 * several pack-worker subprocesses in a row (`describe_shots` chunks an asset's shots into
 * batches of `MAX_SHOTS_PER_REQUEST`). The desktop had already handed over the handle and
 * moved on by the time any of those subprocesses actually start, so nothing stood between
 * a concurrent pack removal/upgrade and a slice that was still using the old install path.
 *
 * The fix mirrors the existing design rather than inventing a new one: acquire a lease for
 * every visual pack identity a REQUEST's body references, hold it for exactly the HTTP
 * round trip that request makes (which is however long the engine takes to answer, whether
 * that is one subprocess or several), and release it once the response — or the failure —
 * comes back. `store.acquireLease` already refuses removal while any lease is outstanding
 * (`pack_leased`), so the whole slice this request causes is now protected, not just the
 * first subprocess it happens to launch.
 */
import { createLogger } from '@framepilot/shared-types';
import type { CapabilityPackInstallIdentity } from '@framepilot/capability-packs';
import type { CapabilityPackLease } from '@framepilot/capability-packs/node';

const log = createLogger('capability-packs:visual-pack-lease');

export interface VisualPackIdentities {
  readonly visualEmbedPack?: CapabilityPackInstallIdentity;
  readonly visualDescribePack?: CapabilityPackInstallIdentity;
}

const VISUAL_PACK_HANDLE_FIELDS = ['visualEmbedPack', 'visualDescribePack'] as const;

/**
 * Which visual pack identities a request body actually references, by the SAME field
 * names `visualIndexCredentials` spreads onto it — never by re-deriving anything about
 * the handle string itself, so this can never disagree with what was actually sent.
 *
 * Pure and synchronous so it is unit-testable without a fetch, a store or a filesystem:
 * the only judgment call this whole mechanism makes — "does this request need a lease,
 * and for which pack(s)" — lives in one small function.
 *
 * :param body: The parsed JSON request body, or ``undefined`` for an unparsable/absent one
 *   (never references a lease — safer to skip a lease than to throw out of a fetch).
 * :param current: The identities the CURRENTLY resolved handles belong to. A body can
 *   reference a field with no current identity (the pack store changed between building
 *   the request and sending it); that field is simply skipped, exactly as a subsequent
 *   `visualIndexCredentials()` read would already have dropped the stale handle.
 */
export function identitiesReferencedByBody(
  body: unknown,
  current: VisualPackIdentities,
): readonly CapabilityPackInstallIdentity[] {
  if (typeof body !== 'object' || body === null) return [];
  const record = body as Record<string, unknown>;
  const identities: CapabilityPackInstallIdentity[] = [];
  for (const field of VISUAL_PACK_HANDLE_FIELDS) {
    if (typeof record[field] !== 'string') continue;
    const identity = current[field];
    if (identity !== undefined) identities.push(identity);
  }
  return identities;
}

/** Best-effort JSON.parse: a body this module cannot read references no lease. */
function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Wrap `fetchImpl` so any call whose body names a visual pack handle holds that pack's
 * lease for the call's whole round trip.
 *
 * `identities` and `acquire` are read/called PER REQUEST (not captured once): the pack
 * store can change between two calls through the same wrapped fetch, and each request must
 * be judged against what is current when IT is sent, matching what `visualIndexCredentials`
 * already does for the handle itself.
 *
 * A lease that fails to acquire (pack removed the instant before, store error) is logged
 * and the request proceeds without it — exactly the honest-degrade this whole mechanism
 * protects against being ABSENT for, not a new way to fail a run: the engine still reports
 * its own honest error if the pack really is gone by the time it looks.
 */
export function withVisualPackLease(
  fetchImpl: typeof fetch,
  identities: () => VisualPackIdentities,
  acquire: (identity: CapabilityPackInstallIdentity) => Promise<CapabilityPackLease>,
): typeof fetch {
  return (async (input, init) => {
    const referenced = identitiesReferencedByBody(parseBody(init?.body), identities());
    const leases: CapabilityPackLease[] = [];
    for (const identity of referenced) {
      try {
        leases.push(await acquire(identity));
      } catch (error) {
        log.warn('visual pack lease unavailable; proceeding without it', {
          packId: identity.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      return await fetchImpl(input, init);
    } finally {
      await Promise.all(leases.map((lease) => lease.release()));
    }
  }) as typeof fetch;
}
