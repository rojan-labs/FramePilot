/**
 * Vision review — the judgement deterministic evidence cannot make.
 *
 * ## Why this exists, and why it is deliberately small
 *
 * The temporal reviewer can prove a great deal: that a cut lands on frame 30,
 * that a trajectory is smooth, that scopes stay legal, that a mix is peak-safe,
 * that no frame decoded to black. What it cannot answer is whether the *edit
 * worked*: whether the subject is still framed, whether the incoming camera is
 * on the same moment, whether the grade looks like the same room. Those are
 * semantic questions, and a number cannot settle them.
 *
 * So this module exists for exactly those questions, and for nothing else. The
 * rules below are what keep it from quietly becoming the reviewer:
 *
 * 1. **It is never the default.** A vision review runs only when a caller
 *    declares a semantic objective it cannot check any other way.
 * 2. **It cannot rescue a deterministic failure.** The Critic ANDs its checks,
 *    so a vision pass adds a check — it never removes one. A model saying "looks
 *    fine" over a black frame changes nothing.
 * 3. **`cannot_tell` is not a pass.** A question that was asked and not answered
 *    settles as unverified, which fails the gate that asked it. Anything else
 *    would make an unreadable frame indistinguishable from a good one.
 * 4. **No reviewer configured is a refusal, not an assumption.** A host with no
 *    vision-capable model reports the objective unverified.
 * 5. **Bounded.** At most {@link MAX_VISION_FRAMES} frames, one call, no retry
 *    loop. Repair is the existing bounded path, not more looking.
 * 6. **A cancelled review confirms nothing.** Cancellation is checked both before
 *    an objective is dispatched and again after its verdict arrives, because a
 *    judge already in flight when the user cancels will still resolve. Accepting
 *    that late answer would let a run the user stopped commit on its authority.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:vision-review');

export const VISION_REVIEW_VERSION = 1 as const;

/**
 * The most frames one semantic question may look at.
 *
 * Four covers the shapes that actually arise — before/after a cut, or beginning/
 * middle/end of a move — and keeps a review to one bounded model call whose cost
 * does not scale with clip length.
 */
export const MAX_VISION_FRAMES = 4;

export const VisionReviewRequestSchema = z
  .object({
    schemaVersion: z.literal(VISION_REVIEW_VERSION),
    requestId: z.string().trim().min(1).max(256),
    projectRevision: z.number().int().nonnegative(),
    /**
     * The question, in the editor's words: "is the speaker still fully in frame?".
     *
     * Phrased as something a person could answer by looking, because that is the
     * only kind of question this can settle. A request for a measurement belongs
     * in temporal evidence, where the answer is a number and not an opinion.
     */
    objective: z.string().trim().min(1).max(512),
    frames: z.array(z.number().int().nonnegative()).min(1).max(MAX_VISION_FRAMES),
  })
  .strict()
  .refine((value) => new Set(value.frames).size === value.frames.length, {
    path: ['frames'],
    message: 'Vision review frames must be distinct.',
  });

export type VisionReviewRequest = z.infer<typeof VisionReviewRequestSchema>;

/** One composited frame, as the host acquired it. */
export const VisionFrameSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    /** Base64 PNG/JPEG of the composited frame at this position. */
    imageBase64: z.string().min(1),
    mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  })
  .strict();

export type VisionFrame = z.infer<typeof VisionFrameSchema>;

/**
 * The verdict shape the reviewing model must return.
 *
 * `cannot_tell` is a first-class answer rather than a failure of the model: a
 * frame can genuinely fail to show what was asked about, and an honest "I cannot
 * see that here" is worth more than a coin flip. It settles as unverified.
 */
export const VisionVerdictSchema = z
  .object({
    verdict: z.enum(['pass', 'fail', 'cannot_tell']),
    /** What was seen, in one sentence. Shown to the editor, so it must be concrete. */
    reason: z.string().trim().min(1).max(512),
    /** The frame the verdict rests on, when one frame decided it. */
    frame: z.number().int().nonnegative().optional(),
  })
  .strict();

export type VisionVerdict = z.infer<typeof VisionVerdictSchema>;

export type VisionReviewStatus = 'pass' | 'fail' | 'unverified';

export interface VisionReviewCheck {
  readonly requestId: string;
  readonly objective: string;
  readonly status: VisionReviewStatus;
  readonly reason: string;
  readonly frames: readonly number[];
}

export interface VisionReviewReport {
  /** True only when every declared semantic objective was answered and passed. */
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly checks: readonly VisionReviewCheck[];
  /** Immutable reviewer provenance recorded with the run evidence. */
  readonly reviewer?: VisionReviewerIdentity;
}

export const VisionReviewerIdentitySchema = z
  .object({
    transport: z.enum(['local_pack', 'cloud']),
    provider: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256),
    promptVersion: z.string().trim().min(1).max(64),
    /** Exact installed pack pin for local inference; never a floating channel. */
    packVersion: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.transport === 'local_pack' && value.packVersion === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['packVersion'],
        message: 'A local vision reviewer must record its exact pack version.',
      });
    }
  });

export type VisionReviewerIdentity = z.infer<typeof VisionReviewerIdentitySchema>;

export const VisionMediaEgressConsentSchema = z
  .object({
    approved: z.literal(true),
    consentId: z.string().trim().min(1).max(256),
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type VisionMediaEgressConsent = z.infer<typeof VisionMediaEgressConsentSchema>;

/** Acquires composited frames for a review. Missing frames are an acquisition failure. */
export type VisionFrameAcquirer = (request: VisionReviewRequest) => Promise<readonly VisionFrame[]>;

/** Asks a vision-capable reviewer one bounded question about a set of frames. */
export type VisionJudge = (input: {
  readonly objective: string;
  readonly frames: readonly VisionFrame[];
  /**
   * The request this question belongs to.
   *
   * A model-backed judge needs only the prose. A deterministic local reviewer
   * needs to know *which* objective it was handed, so it can answer the ones it
   * genuinely can and say `cannot_tell` for the rest — routing on the wording of
   * the question would be a guess about a string.
   */
  readonly requestId: string;
}) => Promise<unknown>;

export interface VisionReviewInput {
  readonly requests: readonly VisionReviewRequest[];
  readonly projectRevision: number;
  /** Absent means this host has no vision reviewer — every objective goes unverified. */
  readonly acquire?: VisionFrameAcquirer;
  readonly judge?: VisionJudge;
  /** Required whenever a judge is configured; written into review lineage. */
  readonly reviewer?: VisionReviewerIdentity;
  /** Cloud reviewers may receive rendered media only with an explicit consent receipt. */
  readonly mediaEgressConsent?: VisionMediaEgressConsent;
  /** Aborting leaves every objective unverified, including one already in flight. */
  readonly signal?: AbortSignal;
}

/** The one reason text a cancelled objective reports, so callers can match on it. */
const CANCELLED_REASON = 'The run was cancelled, so this objective was never confirmed.';

function unverified(request: VisionReviewRequest, reason: string): VisionReviewCheck {
  return {
    requestId: request.requestId,
    objective: request.objective,
    status: 'unverified',
    reason,
    frames: request.frames,
  };
}

/**
 * Run every declared semantic objective and report one check each.
 *
 * Every failure mode lands on `unverified` rather than `pass`: no reviewer, a
 * frame that could not be acquired, a malformed verdict, a thrown error, or an
 * honest `cannot_tell`. The only route to `pass` is a well-formed pass verdict
 * over frames that were actually looked at.
 */
export async function reviewVisionObjectives(
  input: VisionReviewInput,
): Promise<VisionReviewReport> {
  const requests = input.requests.map((request) => VisionReviewRequestSchema.parse(request));
  const stale = requests.find((request) => request.projectRevision !== input.projectRevision);
  if (stale) {
    throw new Error(
      `Vision review request "${stale.requestId}" targets revision ${String(
        stale.projectRevision,
      )}, not ${String(input.projectRevision)}.`,
    );
  }

  const checks: VisionReviewCheck[] = [];
  // Read through a call, not a property: the signal can abort during an await, and
  // narrowing from an earlier check would hide exactly the case that matters.
  const cancelled = (): boolean => input.signal?.aborted === true;
  const reviewer =
    input.reviewer === undefined ? undefined : VisionReviewerIdentitySchema.parse(input.reviewer);
  const consent =
    input.mediaEgressConsent === undefined
      ? undefined
      : VisionMediaEgressConsentSchema.parse(input.mediaEgressConsent);
  for (const request of requests) {
    if (cancelled()) {
      checks.push(unverified(request, CANCELLED_REASON));
      continue;
    }
    if (!input.acquire || !input.judge) {
      checks.push(
        unverified(request, 'This host has no vision reviewer, so the objective is unverified.'),
      );
      continue;
    }
    if (!reviewer) {
      checks.push(unverified(request, 'The configured vision reviewer has no identity lineage.'));
      continue;
    }
    if (reviewer.transport === 'cloud' && !consent) {
      checks.push(
        unverified(
          request,
          'Cloud vision review requires explicit media-egress consent for this run.',
        ),
      );
      continue;
    }
    let check: VisionReviewCheck;
    try {
      const frames = (await input.acquire(request)).map((frame) => VisionFrameSchema.parse(frame));
      const missing = request.frames.filter(
        (frame) => !frames.some((candidate) => candidate.frame === frame),
      );
      check = missing.length
        ? unverified(request, `Frames ${missing.join(', ')} could not be acquired.`)
        : verdictCheck(
            request,
            await input.judge({
              objective: request.objective,
              frames,
              requestId: request.requestId,
            }),
          );
    } catch (error) {
      check = unverified(
        request,
        `The vision reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Re-checked after the await: the judge was already in flight when the user
    // cancelled, and its answer arriving anyway is not consent to use it.
    if (cancelled()) check = unverified(request, CANCELLED_REASON);
    if (check.status !== 'pass') {
      log.warn('Vision objective not confirmed', {
        requestId: request.requestId,
        status: check.status,
      });
    }
    checks.push(check);
  }

  return {
    ok: checks.length > 0 && checks.every((check) => check.status === 'pass'),
    projectRevision: input.projectRevision,
    checks,
    ...(reviewer === undefined ? {} : { reviewer }),
  };
}

function verdictCheck(request: VisionReviewRequest, raw: unknown): VisionReviewCheck {
  const parsed = VisionVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return unverified(request, 'The vision reviewer returned an answer in no usable shape.');
  }
  if (parsed.data.verdict === 'cannot_tell') {
    return unverified(request, parsed.data.reason);
  }
  return {
    requestId: request.requestId,
    objective: request.objective,
    status: parsed.data.verdict,
    reason: parsed.data.reason,
    frames: parsed.data.frame === undefined ? request.frames : [parsed.data.frame],
  };
}
