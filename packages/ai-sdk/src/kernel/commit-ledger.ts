/**
 * @framepilot/ai-sdk/kernel/commit-ledger — what the HOST did with a patch, told back to the
 * run that proposed it.
 *
 * ## Why this exists
 *
 * The orchestrator records an operation as `succeeded` on the strength of its own validation
 * against its own working copy (`kernel/conductor.ts#foldTurn` → `r.satisfied`). On desktop
 * that is not the last word: the host re-checks the patch against the authoritative project
 * and may refuse it — the project is no longer the one the app has open, the revision moved,
 * the patch references media that is not on disk. It stamps the verdict onto the outgoing
 * `DiffEvent.commit` for the UI and told the run nothing.
 *
 * So the two diverged. In a captured run every patch came back
 * `{state: 'stale', reason: 'the project is no longer the active authoritative project'}`
 * while the run's own ledger read `status: 'succeeded'`, `projectRevisionAfter: 1` against a
 * project still at revision 0 with an empty bin. Three consequences, all bad:
 *
 * 1. the briefing lists the edit under "ALREADY APPLIED — do not repeat", so the run will
 *    not retry the one thing it still owes;
 * 2. a run that finished rather than being cancelled would report success for a project
 *    that was never modified — the overclaim `kernel/briefing.ts` works hard to prevent,
 *    arriving through the run's own memory where that rule cannot reach it;
 * 3. a resume picks up from a revision that does not exist.
 *
 * ## Why a ledger and not a return value
 *
 * The verdict is produced by a host hook that runs while the run's generator is suspended on
 * the `yield` of its diff event (`AiStreamHub`'s publish callback awaits `beforePublish`
 * before resuming it). There is no return path down that channel — but there is a guaranteed
 * happens-before: by the time the generator resumes, the verdict exists. A ledger keyed by
 * patch id is the smallest thing that exploits that ordering without inverting the stream.
 *
 * Surfaces with no host arbiter (the browser build, MCP, the tests) simply pass none, and
 * behaviour is exactly as before: local validation is the last word because it is the only
 * word.
 */

/**
 * One patch the host refused, as the run must record it.
 *
 * Carries the host's own words rather than a code, because they are what the briefing's
 * "FAILED — fix the cause, do not retry unchanged" section renders and what the model has to
 * act on. A generic "could not apply" there is advice with no cause behind it.
 */
export interface HostPatchRefusal {
  readonly patchId: string;
  /** What the run thought it was doing, for the ledger row this corrects. */
  readonly intent: string;
  readonly reason: string;
}

/**
 * The host's verdict on one proposed patch.
 *
 * `deferred` is not a refusal and not an approval — it is the host saying it is not the
 * authority for this patch (a run under `review` policy, where the renderer applies). It
 * exists so the ledger's contract can be "rule on EVERY patch exactly once", which is what
 * lets a run wait for a verdict instead of guessing when one has arrived.
 */
export interface PatchCommitOutcome {
  readonly state: 'committed' | 'stale' | 'deferred';
  /** The authoritative project revision after a commit. Absent on refusal. */
  readonly revision?: number;
  /** Why a refusal happened, in words the model and the editor can both act on. */
  readonly reason?: string;
}

/**
 * Where a host records its verdicts and a run reads them.
 *
 * An interface rather than a class at the boundary so a host that already owns commit state
 * can expose it directly instead of mirroring into a second structure.
 */
export interface PatchCommitLedger {
  record(patchId: string, outcome: PatchCommitOutcome): void;
  outcomeFor(patchId: string): PatchCommitOutcome | undefined;
  /**
   * Resolves when the host has ruled on this patch — immediately if it already has.
   *
   * The run AWAITS this rather than polling, because there is no ordering it could poll
   * against: the graph's event queue is a fire-and-forget push, so a diff may or may not
   * have reached the host by any later point the run cares to look. Waiting turns an
   * accident of scheduling into the transactional property this whole module is for — a
   * turn is never planned against an edit whose fate is unknown.
   *
   * Presence of a ledger IS the promise that every patch gets a verdict. A host that can
   * fail before recording one must record `deferred` on its way out, or the run waits
   * forever.
   */
  settled(patchId: string): Promise<PatchCommitOutcome>;
}

/** The default ledger: run-scoped, unbounded only by how many patches one run proposes. */
export class InMemoryPatchCommitLedger implements PatchCommitLedger {
  private readonly outcomes = new Map<string, PatchCommitOutcome>();
  private readonly waiting = new Map<string, ((outcome: PatchCommitOutcome) => void)[]>();

  public record(patchId: string, outcome: PatchCommitOutcome): void {
    this.outcomes.set(patchId, outcome);
    const waiters = this.waiting.get(patchId);
    if (waiters === undefined) return;
    this.waiting.delete(patchId);
    for (const resolve of waiters) resolve(outcome);
  }

  public outcomeFor(patchId: string): PatchCommitOutcome | undefined {
    return this.outcomes.get(patchId);
  }

  public settled(patchId: string): Promise<PatchCommitOutcome> {
    const recorded = this.outcomes.get(patchId);
    if (recorded !== undefined) return Promise.resolve(recorded);
    return new Promise<PatchCommitOutcome>((resolve) => {
      const waiters = this.waiting.get(patchId) ?? [];
      waiters.push(resolve);
      this.waiting.set(patchId, waiters);
    });
  }
}

/**
 * The sentence a run is told when the host refused its patch and offered no reason.
 *
 * Never silence: a turn whose edit vanished with no explanation is indistinguishable to the
 * model from one that landed, which is the whole failure this module exists to end.
 */
export const UNEXPLAINED_HOST_REFUSAL =
  'the editor could not write this edit to the project, and gave no reason';

/**
 * Read the host's verdict for a patch, as the reason it was NOT applied.
 *
 * @param outcome - The host's verdict, or `undefined` where there is no host to give one.
 * @returns The refusal reason, or `undefined` when the patch was committed, deferred to
 *   another authority, or never ruled on because no host exists.
 */
export function hostRefusalFor(outcome: PatchCommitOutcome | undefined): string | undefined {
  if (outcome === undefined || outcome.state !== 'stale') return undefined;
  return outcome.reason ?? UNEXPLAINED_HOST_REFUSAL;
}
