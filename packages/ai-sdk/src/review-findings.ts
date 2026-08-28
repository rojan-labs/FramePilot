/**
 * Review findings — what a read-only perceptual review produces, and when one is
 * still worth acting on.
 *
 * WHY this module exists: review used to be a second writer. On a repairable issue it
 * called back into `streamEdit`, took the resulting patch and applied it, which meant the
 * run had two things mutating one project and every turn had to wait for the review of the
 * turn before it. Review is now a reader: it produces a finding, the agent repairs it in an
 * ordinary turn, and the turn loop stays the single writer. That is what lets a review run
 * pipelined alongside the next turn instead of blocking it.
 *
 * The cost of not blocking is that a finding can settle late, describing a timeline the run
 * has since edited. {@link selectLiveFindings} is the rule that decides which findings
 * survive that: a finding is dropped only when a later turn actually rewrote the clip,
 * whole track, or time span it names.
 */
import type { TimelineDiff } from '@framepilot/editor-core';
import type { Clip, Timeline } from '@framepilot/timeline-schema';

/** A timeline span touched by an edit. End is exclusive, matching clip timing. */
export interface TouchedTimeRange {
  readonly trackId: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The clips, whole-track state and time spans one edit (or one finding) is about.
 *
 * `trackIds` is retained as diagnostic/backward-compatible metadata: older in-memory
 * callers built regions from only track/clip sets. Production regions additionally carry
 * `wholeTrackIds` and `ranges`, which are the authority for track overlap. A clip edit on V1
 * therefore does not invalidate an unrelated clip edit elsewhere on V1.
 */
export interface TouchedRegion {
  readonly trackIds: ReadonlySet<string>;
  readonly clipIds: ReadonlySet<string>;
  readonly wholeTrackIds?: ReadonlySet<string>;
  readonly ranges?: readonly TouchedTimeRange[];
}

/** What a finding was computed against, so a later turn can invalidate it. */
export interface ReviewFindingScope extends TouchedRegion {
  /** Timeline revision the reviewed snapshot carried. */
  readonly projectRevision: number;
  /** The patch whose effect was reviewed. */
  readonly patchId: string;
}

export interface ReviewFinding {
  readonly id: string;
  /** 0-based agent turn whose edit was reviewed. */
  readonly turnIndex: number;
  /** Plan step the reviewed turn belongs to, when the run drafted a plan. */
  readonly planStepId?: string;
  /** Plain-language statement of what the review found. */
  readonly detail: string;
  /** Where in the programme it sits, for a jump affordance. */
  readonly atSeconds?: number;
  /** Provenance (`temporal:*` / `vision:*`) for the run record. */
  readonly lineage: readonly string[];
  readonly scope: ReviewFindingScope;
}

const EMPTY_REGION: TouchedRegion = {
  trackIds: new Set(),
  clipIds: new Set(),
  wholeTrackIds: new Set(),
  ranges: [],
};

interface IndexedClip {
  readonly trackId: string;
  readonly clip: Clip;
}

/** Index every clip by id, remembering which track held it. */
function clipIndex(timeline: Timeline): Map<string, IndexedClip> {
  const index = new Map<string, IndexedClip>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) index.set(clip.id, { trackId: track.id, clip });
  }
  return index;
}

/**
 * Compare clip state without serialising the common immutable fast path.
 *
 * editor-core preserves object identity for clips it did not touch, so ordinary single-clip
 * edits skip JSON allocation for every other clip. The structural fallback is still needed
 * for callers that reconstruct equivalent timelines from persistence before diffing them.
 */
function sameClip(left: Clip, right: Clip): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Track-level state that can change without any clip changing. */
function trackShell(timeline: Timeline): Map<string, string> {
  const shells = new Map<string, string>();
  for (const track of timeline.tracks) {
    const { clips: _clips, ...shell } = track;
    shells.set(track.id, JSON.stringify(shell));
  }
  return shells;
}

function addClipRange(ranges: Map<string, TouchedTimeRange>, trackId: string, clip: Clip): void {
  const range = { trackId, start: clip.start, end: clip.end } satisfies TouchedTimeRange;
  ranges.set(`${trackId}\u0000${String(clip.start)}\u0000${String(clip.end)}`, range);
}

/**
 * The clips and exact timeline spans an edit actually changed.
 *
 * A clip move records both source and destination spans. Track metadata such as mute/hidden/
 * role is represented separately as a whole-track mutation. Keeping those concepts separate
 * is the correctness boundary for review supersession: changing Clip D at 40s on V1 cannot
 * erase a finding about Clip A at 2s merely because both happen to live on V1.
 */
export function touchedRegion(diff: TimelineDiff): TouchedRegion {
  const trackIds = new Set<string>();
  const wholeTrackIds = new Set<string>();
  const clipIds = new Set<string>();
  const ranges = new Map<string, TouchedTimeRange>();

  const before = clipIndex(diff.before);
  const after = clipIndex(diff.after);
  for (const [clipId, beforeEntry] of before) {
    const afterEntry = after.get(clipId);
    if (
      afterEntry !== undefined &&
      afterEntry.trackId === beforeEntry.trackId &&
      sameClip(afterEntry.clip, beforeEntry.clip)
    ) {
      continue;
    }
    clipIds.add(clipId);
    trackIds.add(beforeEntry.trackId);
    addClipRange(ranges, beforeEntry.trackId, beforeEntry.clip);
    if (afterEntry !== undefined) {
      trackIds.add(afterEntry.trackId);
      addClipRange(ranges, afterEntry.trackId, afterEntry.clip);
    }
  }
  for (const [clipId, afterEntry] of after) {
    if (before.has(clipId)) continue;
    clipIds.add(clipId);
    trackIds.add(afterEntry.trackId);
    addClipRange(ranges, afterEntry.trackId, afterEntry.clip);
  }

  const beforeShells = trackShell(diff.before);
  const afterShells = trackShell(diff.after);
  for (const [trackId, shell] of beforeShells) {
    if (afterShells.get(trackId) === shell) continue;
    trackIds.add(trackId);
    wholeTrackIds.add(trackId);
  }
  for (const trackId of afterShells.keys()) {
    if (beforeShells.has(trackId)) continue;
    trackIds.add(trackId);
    wholeTrackIds.add(trackId);
  }

  return {
    trackIds,
    clipIds,
    wholeTrackIds,
    ranges: [...ranges.values()],
  };
}

/** Region of an edit whose diff may be absent (a patch that changed nothing). */
export function touchedRegionOf(diff: TimelineDiff | undefined): TouchedRegion {
  return diff ? touchedRegion(diff) : EMPTY_REGION;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of small) {
    if (large.has(value)) return true;
  }
  return false;
}

function authoritativeWholeTracks(region: TouchedRegion): ReadonlySet<string> {
  // Legacy/test callers that predate precise regions supplied only `trackIds`; treating those
  // as whole-track keeps the API backward-compatible. `touchedRegion` always supplies the
  // precise empty/non-empty `wholeTrackIds`, so production never falls through this branch.
  return region.wholeTrackIds ?? region.trackIds;
}

function authoritativeRanges(region: TouchedRegion): readonly TouchedTimeRange[] {
  return region.ranges ?? [];
}

function rangesOverlap(left: TouchedTimeRange, right: TouchedTimeRange): boolean {
  return left.trackId === right.trackId && left.start < right.end && right.start < left.end;
}

/** True only when two edits actually overlap the same clip, whole track, or timeline span. */
export function regionsOverlap(left: TouchedRegion, right: TouchedRegion): boolean {
  if (intersects(left.clipIds, right.clipIds)) return true;

  const leftWhole = authoritativeWholeTracks(left);
  const rightWhole = authoritativeWholeTracks(right);
  if (intersects(leftWhole, rightWhole)) return true;

  const leftRanges = authoritativeRanges(left);
  const rightRanges = authoritativeRanges(right);
  if (leftRanges.some((range) => rightWhole.has(range.trackId))) return true;
  if (rightRanges.some((range) => leftWhole.has(range.trackId))) return true;
  for (const leftRange of leftRanges) {
    for (const rightRange of rightRanges) {
      if (rangesOverlap(leftRange, rightRange)) return true;
    }
  }
  return false;
}

/**
 * Keep only the findings that still describe the live timeline.
 *
 * `laterRegions` is what every turn *after* the reviewed one changed. A finding whose
 * precise region one of them overlaps is dropped because it describes a revision that no
 * longer occupies that location. An edit elsewhere on the same track is deliberately not
 * enough. A finding with an empty region is never dropped.
 */
export function selectLiveFindings(
  findings: readonly ReviewFinding[],
  laterRegions: ReadonlyMap<number, TouchedRegion>,
): readonly ReviewFinding[] {
  return findings.filter((finding) => {
    for (const [turnIndex, region] of laterRegions) {
      if (turnIndex <= finding.turnIndex) continue;
      if (regionsOverlap(finding.scope, region)) return false;
    }
    return true;
  });
}

/** Env var bounding how many perceptual reviews may run at once. */
export const REVIEW_CONCURRENCY_ENV = 'FRAMEPILOT_MAX_REVIEW_CONCURRENCY';

/** Reviews in flight at once. One, deliberately: rendered review is a memory-heavy job. */
export const DEFAULT_MAX_REVIEW_CONCURRENCY = 1;

/** Resolve the review pool size from the raw env value. */
export function resolveReviewConcurrency(rawEnvValue: string | undefined): number {
  if (rawEnvValue === undefined || rawEnvValue.trim() === '') {
    return DEFAULT_MAX_REVIEW_CONCURRENCY;
  }
  const parsed = Number(rawEnvValue);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_REVIEW_CONCURRENCY;
  return Math.floor(parsed);
}

/** Start a turn's review. Called by the queue when a slot frees, not by the caller. */
export type ReviewStarter = (signal?: AbortSignal) => Promise<readonly ReviewFinding[]>;

/**
 * How many times one defect class may steer the agent before the run stops retrying it.
 *
 * One. A perceptual finding tells the agent something it could not see; if the first
 * correction attempt does not clear it, repeating the same instruction is not a second
 * chance, it is a loop — and the defect is then far more likely to live in the render or
 * operation semantics than in the proposal the agent can change.
 */
export const MAX_STEERINGS_PER_CLASS = 1;
/**
 * The first line of every steering message the perceptual review pushes.
 *
 * The queue carries plain strings and is shared with the editor's own mid-run steering, so
 * this is how the two are told apart. It matters at the notice boundary: an editor's message
 * is worth echoing back verbatim ("Steering applied: …"), while the review's is an internal
 * instruction carrying request ids and raw measurements, and echoing THAT put
 * `edit_audio_0: Audio peak 0.08913551514039704 dBFS exceeds -0.1 dBFS.` on screen as
 * product copy.
 */
export const REVIEW_STEERING_PREAMBLE =
  'Perceptual review of the edits you already applied found the following.';

/**
 * The DEFECT CLASS a finding belongs to: its wording with every number removed.
 *
 * Frame indices and measured values are what make two reports of one cause look like two
 * defects ("black frame(s): 90, 91, 92" vs "black frame(s): 300"). Collapsing them is what
 * makes the steering cap mean "we tried to fix this cause once", which is the useful unit.
 */
function findingClass(finding: ReviewFinding): string {
  return (
    finding.detail
      .toLowerCase()
      .replace(/-?\d+(?:\.\d+)?/g, '#')
      // A list of frame indices is one report, however many entries it happens to carry:
      // "frames #, #, #" and "frame #" must land in the same class or the cap counts frames
      // instead of causes.
      .replace(/#(?:\s*,\s*#)+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * One line per DEFECT for a person to read, not one per measurement.
 *
 * The unresolved-review warning used to join every finding's detail end to end. On a
 * timeline with no picture that produced fifteen sentences describing the same fact at
 * fifteen frame numbers — a wall of numbers that reads as fifteen problems and names none
 * of them. Findings already have a notion of sameness (see {@link findingClass}, which the
 * steering cap has always used); this reuses it so the text the editor gets is the text
 * the harness already believes.
 *
 * @param findings - The findings to describe, in report order.
 * @returns One sentence per distinct defect class, with a count when a class repeats.
 */
export function describeFindings(findings: readonly ReviewFinding[]): string {
  const byClass = new Map<string, { detail: string; count: number }>();
  for (const finding of findings) {
    const key = findingClass(finding);
    const seen = byClass.get(key);
    if (seen) seen.count += 1;
    else byClass.set(key, { detail: finding.detail, count: 1 });
  }
  return [...byClass.values()]
    .map(({ detail, count }) =>
      count > 1 ? `${detail} (reported at ${String(count)} places)` : detail,
    )
    .join(' ');
}

interface QueuedReview {
  readonly turnIndex: number;
  readonly start: ReviewStarter;
}

/**
 * Admission, staleness, and verified-repair bookkeeping for detached perceptual reviews.
 *
 * A later edit can make an older review stale, but it does not prove an older finding was
 * fixed. Resolution therefore has a stricter rule than supersession: the finding must have
 * been delivered to the agent, a later turn must touch the same precise region, and that
 * later turn's own perceptual review must finish cleanly.
 */
export class ReviewFindingQueue {
  private readonly regions = new Map<number, TouchedRegion>();
  private readonly settled: ReviewFinding[] = [];
  private readonly failures: string[] = [];
  private readonly delivered: ReviewFinding[] = [];
  private readonly verifiedResolved: ReviewFinding[] = [];
  /** How many times each defect class has already been steered on (see `admitForSteering`). */
  private readonly steeringAttempts = new Map<string, number>();
  /** Admitted but not yet started, oldest first. */
  private readonly queued: QueuedReview[] = [];
  /** Started and not yet settled, by turn. */
  private readonly running = new Map<number, Promise<void>>();
  /** Aborts for running reviews, so a superseded one can be cut short. */
  private readonly aborts = new Map<number, AbortController>();
  /** Turns whose review we cancelled ourselves; their rejection is not a reviewer failure. */
  private readonly cancelled = new Set<number>();
  private readonly maxConcurrent: number;
  private superseded = 0;

  public constructor(maxConcurrent: number = DEFAULT_MAX_REVIEW_CONCURRENCY) {
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  /** Record what a committed turn changed and retire review work that became stale. */
  public recordTurn(turnIndex: number, region: TouchedRegion): void {
    this.regions.set(turnIndex, region);
    this.dropSupersededQueued();
    this.abortSupersededRunning();
    this.pump();
  }

  /** Admit a turn's review. The queue decides when, or whether, it actually starts. */
  public track(turnIndex: number, start: ReviewStarter): void {
    this.queued.push({ turnIndex, start });
    this.pump();
  }

  public get hasPending(): boolean {
    return this.running.size > 0 || this.queued.length > 0;
  }

  /** Reviews skipped or aborted because a later turn rewrote their precise region. */
  public get supersededCount(): number {
    return this.superseded;
  }

  private isSuperseded(turnIndex: number): boolean {
    const region = this.regions.get(turnIndex);
    if (region === undefined) return false;
    for (const [later, laterRegion] of this.regions) {
      if (later <= turnIndex) continue;
      if (regionsOverlap(region, laterRegion)) return true;
    }
    return false;
  }

  private dropSupersededQueued(): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      const entry = this.queued[index] as QueuedReview;
      if (!this.isSuperseded(entry.turnIndex)) continue;
      this.queued.splice(index, 1);
      this.superseded += 1;
    }
  }

  private abortSupersededRunning(): void {
    for (const [turnIndex, controller] of this.aborts) {
      if (this.cancelled.has(turnIndex) || !this.isSuperseded(turnIndex)) continue;
      this.cancelled.add(turnIndex);
      this.superseded += 1;
      controller.abort();
    }
  }

  /** Start queued reviews while slots are free, skipping any the run has outrun. */
  private pump(): void {
    while (this.running.size < this.maxConcurrent && this.queued.length > 0) {
      const entry = this.queued.shift() as QueuedReview;
      if (this.isSuperseded(entry.turnIndex)) {
        this.superseded += 1;
        continue;
      }
      this.begin(entry);
    }
  }

  private begin(entry: QueuedReview): void {
    const controller = new AbortController();
    this.aborts.set(entry.turnIndex, controller);
    const finish = (): void => {
      this.running.delete(entry.turnIndex);
      this.aborts.delete(entry.turnIndex);
      this.pump();
    };
    const done = Promise.resolve()
      .then(async (): Promise<readonly ReviewFinding[]> => {
        if (this.cancelled.has(entry.turnIndex)) return [];
        if (this.isSuperseded(entry.turnIndex)) {
          this.cancelled.add(entry.turnIndex);
          this.superseded += 1;
          return [];
        }
        return entry.start(controller.signal);
      })
      .then(
        (findings) => {
          // A clean review of a later overlapping edit is the evidence that an actually
          // delivered finding was fixed. Merely editing the region is only an attempt.
          if (!this.cancelled.has(entry.turnIndex) && findings.length === 0) {
            this.resolveDeliveredThroughCleanReview(entry.turnIndex);
          }
          this.settled.push(...findings);
          finish();
        },
        (error: unknown) => {
          if (!this.cancelled.has(entry.turnIndex)) {
            this.failures.push(error instanceof Error ? error.message : String(error));
          }
          finish();
        },
      );
    this.running.set(entry.turnIndex, done);
  }

  private resolveDeliveredThroughCleanReview(reviewedTurn: number): void {
    const reviewedRegion = this.regions.get(reviewedTurn);
    if (reviewedRegion === undefined) return;
    const remaining: ReviewFinding[] = [];
    for (const finding of this.delivered) {
      if (reviewedTurn > finding.turnIndex && regionsOverlap(finding.scope, reviewedRegion)) {
        this.verifiedResolved.push(finding);
      } else {
        remaining.push(finding);
      }
    }
    this.delivered.length = 0;
    this.delivered.push(...remaining);
  }

  /** Findings from reviews that have already finished, without waiting for active renders. */
  public async drainSettled(): Promise<readonly ReviewFinding[]> {
    if (this.hasPending) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    return this.take();
  }

  /** Wait for every outstanding review. Called once when the agent says it is done. */
  public async drainAll(): Promise<readonly ReviewFinding[]> {
    while (this.hasPending) {
      this.pump();
      await Promise.all([...this.running.values()]);
    }
    return this.take();
  }

  /**
   * Messages from reviews that could not run, for the run's honest account.
   *
   * Deduplicated by message, in first-seen order, with a count when one message
   * repeats. Every review in a turn shares one engine, so a single outage — an
   * unreachable sidecar, a 5xx — fails every batch with the SAME text, and the
   * run used to publish that identical sentence once per batch. Repeating one
   * fact verbatim reads as several separate problems and buries the findings
   * around it; the count keeps the scale visible without the repetition.
   */
  public get reviewFailures(): readonly string[] {
    const counts = new Map<string, number>();
    for (const failure of this.failures) {
      counts.set(failure, (counts.get(failure) ?? 0) + 1);
    }
    return [...counts].map(([message, count]) =>
      count === 1 ? message : `${message} (${String(count)} reviews)`,
    );
  }

  /** Remember findings that were actually handed to the agent. */
  public markDelivered(findings: readonly ReviewFinding[]): void {
    this.delivered.push(...findings);
  }

  /**
   * Split live findings into the ones worth steering the agent with and the ones it has
   * already been told about and failed to fix.
   *
   * WHY there is a cap at all. Steering was unbounded: every turn that touched a region
   * re-reviewed it, re-detected the same defect, and pushed the same instruction again. When
   * the defect is not something a proposal can fix — in the captured run, a black frame at
   * every cut, which comes from the transition model rather than from the edit — the run
   * spends its whole budget being told to fix the unfixable, and the request the editor
   * actually made never advances.
   *
   * A defect CLASS gets exactly {@link MAX_STEERINGS_PER_CLASS} attempt. After that the
   * finding is still published — the editor must see it — but it stops consuming turns. The
   * class deliberately ignores the numbers in the detail so "black frames at 90, 91, 92" and
   * "black frames at 300" count as one defect: they are one cause, and steering the model
   * once per affected frame is the same loop with more steps.
   */
  public admitForSteering(findings: readonly ReviewFinding[]): {
    readonly steer: readonly ReviewFinding[];
    readonly exhausted: readonly ReviewFinding[];
  } {
    const steer: ReviewFinding[] = [];
    const exhausted: ReviewFinding[] = [];
    for (const finding of findings) {
      const seen = this.steeringAttempts.get(findingClass(finding)) ?? 0;
      if (seen >= MAX_STEERINGS_PER_CLASS) exhausted.push(finding);
      else steer.push(finding);
    }
    for (const finding of steer) {
      const key = findingClass(finding);
      this.steeringAttempts.set(key, (this.steeringAttempts.get(key) ?? 0) + 1);
    }
    return { steer, exhausted };
  }

  /** True once a defect class has spent its steering budget without being resolved. */
  public hasExhaustedSteering(finding: ReviewFinding): boolean {
    return (this.steeringAttempts.get(findingClass(finding)) ?? 0) >= MAX_STEERINGS_PER_CLASS;
  }

  /**
   * Findings whose later repair edit was itself perceptually reviewed cleanly.
   *
   * This intentionally does not infer success from an overlapping edit. An edit can make a
   * finding stale, but only a clean review of the resulting revision proves the defect is gone.
   * Returned findings are removed so each resolution is emitted exactly once.
   */
  public takeResolved(): readonly ReviewFinding[] {
    const resolved = [...this.verifiedResolved];
    this.verifiedResolved.length = 0;
    return resolved;
  }

  private take(): readonly ReviewFinding[] {
    const live = selectLiveFindings(this.settled, this.regions);
    this.settled.length = 0;
    return live;
  }
}
