/**
 * The background-removal jobs this window has running, and what became of them (BR6.4).
 *
 * A module-level store rather than component state, for one reason the plan states outright:
 * **a selection change must not lose the job.** The Inspector row unmounts the moment the editor
 * clicks another clip, and a job that can take minutes cannot depend on a panel staying open. The
 * job lives here, keyed by clip; the row is a view of it, and re-mounting reconnects to the live
 * progress instead of starting a second run.
 *
 * The outcome is kept here too. A run that finished while the row was unmounted still has to
 * become a project edit, so the finished result waits in `outcomes` until an always-mounted
 * committer (`useMatteJobCommits`) turns it into one reversible `add_matte_mask`.
 *
 * Nothing in this module touches the project. Progress, phases and ETA are the host's own numbers
 * (`MatteProgressWire`), never interpolated: a made-up ETA is worse than none.
 */
import { createLogger } from '@framepilot/shared-types';
import type {
  CapabilityPackInstallProposalWire,
  MatteArtifactWire,
  MatteProgressWire,
  MatteRunIntentWire,
  MatteRunResultWire,
} from '@framepilot/shared-types';
import { getBridge } from '../../../editor/bridge.js';

const log = createLogger('web-editor:matte-job');

/**
 * The pipeline's phases in the order they run, for the progress line (plan 05 "RUNNING").
 * An unknown phase from a newer pack is shown as-is rather than hidden.
 */
export const MATTE_PHASE_LABELS: Readonly<Record<string, string>> = {
  prepare: 'Preparing models',
  decode: 'Reading the footage',
  segment: 'Finding the subject',
  refine: 'Refining the edges',
  consensus: 'Comparing passes',
  'self-correct': 'Correcting itself',
  matte: 'Building the matte',
  foreground: 'Recovering edge colour',
  stabilise: 'Steadying the edges',
  verify: 'Checking every frame',
  encode: 'Saving the result',
};

/** The phase label an editor reads, for a phase the pack may or may not have declared. */
export function mattePhaseLabel(phase: string, round?: number | null): string {
  const base = MATTE_PHASE_LABELS[phase] ?? phase;
  return round === undefined || round === null ? base : `${base} (round ${String(round)} of 3)`;
}

export interface MatteJobState {
  readonly requestId: string;
  readonly clipId: string;
  readonly assetId: string;
  /** The matte being re-run, or `null` for a first run. */
  readonly maskId: string | null;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly phase: string;
  readonly round: number | null;
  readonly completed: number;
  readonly total: number;
  /** The host's ETA in seconds, or `null` until it has one. */
  readonly etaSeconds: number | null;
  readonly startedAt: number;
  readonly cancelling: boolean;
  readonly edgeMode: 'sharp' | 'smooth' | null;
}

/** What a finished run left for the committer. Exactly one per finished job. */
export type MatteOutcome =
  | {
      readonly kind: 'done';
      readonly clipId: string;
      readonly maskId: string | null;
      readonly artifact: MatteArtifactWire;
      readonly prompts: MatteRunIntentWire['prompts'];
      readonly needsReview: readonly {
        readonly start: number;
        readonly end: number;
        readonly reason: string;
      }[];
      readonly verifiedFrames: number;
      readonly cacheHit: boolean;
      readonly edgeMode: 'sharp' | 'smooth' | null;
    }
  | { readonly kind: 'cancelled'; readonly clipId: string }
  | { readonly kind: 'needs_prompt'; readonly clipId: string }
  | {
      readonly kind: 'pack_missing';
      readonly clipId: string;
      readonly proposal: CapabilityPackInstallProposalWire | null;
      readonly error: string | null;
    }
  | {
      readonly kind: 'failed';
      readonly clipId: string;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      /** `insufficient_disk`: what the job needed and what is free. */
      readonly requiredBytes?: number;
      readonly freeBytes?: number;
    };

/** What the committer made of a finished job, for whichever panel is showing that clip. */
export interface MatteNotice {
  readonly tone: 'status' | 'alert';
  readonly message: string;
  /** Present when the run refused because the pack is not installed. */
  readonly packMissing?: boolean;
}

export interface MatteJobsState {
  readonly jobs: Readonly<Record<string, MatteJobState>>;
  readonly outcomes: Readonly<Record<string, MatteOutcome>>;
  readonly notices: Readonly<Record<string, MatteNotice>>;
}

const EMPTY: MatteJobsState = { jobs: {}, outcomes: {}, notices: {} };

type Listener = () => void;

function newRequestId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  // 1–64 of [A-Za-z0-9_-], as `MatteRunIntentWire.requestId` requires.
  return `matte-${Date.now().toString(36)}-${random}`;
}

export type MatteStartIntent = Omit<MatteRunIntentWire, 'requestId'> & {
  readonly maskId?: string | null;
  /**
   * Edge quality the editor chose before running (RD0's Sharp/Smooth control).
   *
   * Carried with the JOB rather than sent on the wire: it is a look on the delivered matte, not an
   * instruction to the pack, and it must land on the mask the run creates.
   */
  readonly edgeMode?: 'sharp' | 'smooth';
};

export class MatteJobStore {
  private state: MatteJobsState = EMPTY;
  private readonly listeners = new Set<Listener>();
  /** Progress subscription, held only while at least one job is live. */
  private stopProgress: (() => void) | null = null;

  public readonly getState = (): MatteJobsState => this.state;

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: MatteJobsState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Listen for progress once, for as long as any job is live. */
  private watchProgress(): void {
    if (this.stopProgress !== null) return;
    const bridge = getBridge();
    this.stopProgress =
      bridge?.onCapabilityPackMatteProgress?.((message: MatteProgressWire) => {
        const entry = Object.values(this.state.jobs).find(
          (job) => job.requestId === message.requestId,
        );
        if (entry === undefined) return;
        this.set({
          ...this.state,
          jobs: {
            ...this.state.jobs,
            [entry.clipId]: {
              ...entry,
              phase: message.phase,
              round: message.round ?? null,
              completed: message.completed,
              total: message.total,
              etaSeconds: message.etaSeconds ?? null,
            },
          },
        });
      }) ?? null;
  }

  /** The clip's live job, read fresh: the store changes while an invoke is in flight. */
  private jobOf(clipId: string): MatteJobState | undefined {
    return this.state.jobs[clipId];
  }

  private finish(clipId: string, outcome: MatteOutcome): void {
    const jobs = { ...this.state.jobs };
    delete jobs[clipId];
    this.set({
      ...this.state,
      jobs,
      outcomes: { ...this.state.outcomes, [clipId]: outcome },
    });
    if (Object.keys(jobs).length === 0) {
      this.stopProgress?.();
      this.stopProgress = null;
    }
  }

  /**
   * Start one background-removal job for a clip.
   *
   * @param intent - Coverage, prompts and the clip, without the request id.
   * @returns `null` once the job is under way (or the reason it could not start).
   */
  public async start(intent: MatteStartIntent): Promise<string | null> {
    const bridge = getBridge();
    if (!bridge?.capabilityPackMatte)
      return 'Background removal runs in the FramePilot desktop app.';
    const clipId = intent.clipId ?? intent.assetId;
    if (this.state.jobs[clipId] !== undefined) return 'This clip is already being processed.';
    const requestId = newRequestId();
    const { maskId, edgeMode, ...wire } = intent;
    const job: MatteJobState = {
      requestId,
      clipId,
      assetId: intent.assetId,
      maskId: maskId ?? null,
      sourceStart: intent.sourceStart,
      sourceEnd: intent.sourceEnd,
      phase: 'decode',
      round: null,
      completed: 0,
      total: 0,
      etaSeconds: null,
      startedAt: Date.now(),
      cancelling: false,
      edgeMode: edgeMode ?? null,
    };
    const outcomes = { ...this.state.outcomes };
    delete outcomes[clipId];
    const notices = { ...this.state.notices };
    delete notices[clipId];
    this.set({ jobs: { ...this.state.jobs, [clipId]: job }, outcomes, notices });
    this.watchProgress();
    log.action('matte job started', { clipId, requestId });
    try {
      const result: MatteRunResultWire = await bridge.capabilityPackMatte({ ...wire, requestId });
      // The job may have been cancelled and forgotten while the invoke was in flight.
      if (this.jobOf(clipId)?.requestId !== requestId) return null;
      this.finish(
        clipId,
        this.outcomeOf(clipId, maskId ?? null, edgeMode ?? null, wire.prompts, result),
      );
    } catch (cause) {
      if (this.jobOf(clipId)?.requestId !== requestId) return null;
      this.finish(clipId, {
        kind: 'failed',
        clipId,
        code: 'transport',
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      });
    }
    return null;
  }

  private outcomeOf(
    clipId: string,
    maskId: string | null,
    edgeMode: 'sharp' | 'smooth' | null,
    prompts: MatteRunIntentWire['prompts'],
    result: MatteRunResultWire,
  ): MatteOutcome {
    if (result.ok) {
      return {
        kind: 'done',
        clipId,
        maskId,
        artifact: result.artifact,
        prompts,
        needsReview: result.needsReview,
        verifiedFrames: result.summary.verifiedFrames,
        cacheHit: result.cacheHit,
        edgeMode,
      };
    }
    // `code` is a plain string on the general refusal arm, so it cannot discriminate the union;
    // the shape does. A missing pack carries a proposal, and nothing else does.
    if ('proposal' in result) {
      return {
        kind: 'pack_missing',
        clipId,
        proposal: result.proposal.ok ? result.proposal.proposal : null,
        error: result.proposal.ok ? null : result.proposal.error,
      };
    }
    if (!('error' in result)) return { kind: 'needs_prompt', clipId };
    if (result.code === 'cancelled') return { kind: 'cancelled', clipId };
    return {
      kind: 'failed',
      clipId,
      code: result.code,
      message: result.error,
      retryable: result.retryable,
      ...(result.requiredBytes === undefined ? {} : { requiredBytes: result.requiredBytes }),
      ...(result.freeBytes === undefined ? {} : { freeBytes: result.freeBytes }),
    };
  }

  /** Ask main to stop the clip's job. The outcome still arrives through `start`'s promise. */
  public cancel(clipId: string): void {
    const job = this.state.jobs[clipId];
    if (job === undefined || job.cancelling) return;
    this.set({
      ...this.state,
      jobs: { ...this.state.jobs, [clipId]: { ...job, cancelling: true } },
    });
    getBridge()?.capabilityPackCancelMatte?.(job.requestId);
  }

  /** Record what became of a finished job, for the panel showing that clip. */
  public setNotice(clipId: string, notice: MatteNotice | null): void {
    const notices = { ...this.state.notices };
    if (notice === null) delete notices[clipId];
    else notices[clipId] = notice;
    this.set({ ...this.state, notices });
  }

  /** Take the clip's outcome, so it is committed or shown exactly once. */
  public takeOutcome(clipId: string): MatteOutcome | null {
    const outcome = this.state.outcomes[clipId];
    if (outcome === undefined) return null;
    const outcomes = { ...this.state.outcomes };
    delete outcomes[clipId];
    this.set({ ...this.state, outcomes });
    return outcome;
  }

  /** Forget everything (tests, closing a project). Running jobs are cancelled first. */
  public reset(): void {
    for (const clipId of Object.keys(this.state.jobs)) this.cancel(clipId);
    this.stopProgress?.();
    this.stopProgress = null;
    this.set(EMPTY);
  }
}

/** The editor's one background-removal job store. */
export const matteJobStore = new MatteJobStore();
