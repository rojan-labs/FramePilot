/**
 * @framepilot/ai-sdk/kernel/cost/analysis-caps — per-run analysis resource budget
 * (plan/ORCHESTRATION_ENHANCEMENT_PLAN.md B5.4).
 *
 * `cost-meter.ts` prices the MODEL side of a run (tokens/$). This is its analysis-side
 * sibling: a per-run budget for the deterministic-but-expensive work the host executor
 * dispatches to the Python sidecar — **ffmpeg seconds** burned by analyzers and
 * **transcription minutes** of Whisper. Left uncapped, a single agent run could
 * transcribe an entire bin, blocking the loop and running up real compute; the cap turns
 * that into an honest, bounded refusal (never a fabricated success).
 *
 * Like `cost-meter.ts` this module is **pure and total** — the caps table, the charge
 * arithmetic, and the per-call charge derivation are all deterministic and 100%-covered.
 * The one stateful piece, {@link createAnalysisBudget}, is a thin mutable wrapper the host
 * executor threads through a run; it holds no I/O.
 *
 * Enforcement lives in `sidecar-executor.ts#chargeAnalysisBudget` (the host seam that
 * actually runs these calls): it PRE-checks a call's charge before dispatch and RECORDS
 * the real consumption after — so the budget reflects what actually ran, and the run's
 * spend is reportable next to token spend (`describeAnalysisSpend`).
 *
 * That sentence used to be aspirational: `preflightCharge` returned `null` unconditionally,
 * neither charge function had a production caller, and the budget threaded through
 * `HostCallContext` → `HostToolEffect` → `EffectRuntime` → `HostExecutionContext` was read
 * by nobody. A run's spend was therefore permanently zero and the ceilings could not fire,
 * while `tool-executor.ts` documented the opposite. `analysis-caps.enforcement.test.ts`
 * now pins the wiring end to end so the claim cannot quietly become a claim again.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:kernel:cost:analysis-caps');

/** The three capped analysis resources a run consumes. */
export type AnalysisResource = 'ffmpegSeconds' | 'transcriptionMinutes';

/** Per-run ceilings, one per {@link AnalysisResource}. */
export interface AnalysisCaps {
  /** Max wall-clock seconds of ffmpeg-backed analysis across the run. */
  readonly maxFfmpegSeconds: number;
  /** Max minutes of audio transcribed (Whisper) across the run. */
  readonly maxTranscriptionMinutes: number;
}

/**
 * Conservative defaults. Generous enough for a real editing session (a montage's worth of
 * frames, a few minutes-long clips analysed and transcribed) but low enough that a runaway
 * loop hits the ceiling instead of the wall-clock/compute wall. A deployment overrides via
 * {@link createAnalysisBudget}'s argument — a cap change is config, not code.
 */
export const DEFAULT_ANALYSIS_CAPS: AnalysisCaps = {
  maxFfmpegSeconds: 900,
  maxTranscriptionMinutes: 60,
};

/** A run's consumption so far, one running total per {@link AnalysisResource}. */
export interface AnalysisSpend {
  readonly ffmpegSeconds: number;
  readonly transcriptionMinutes: number;
}

/** A fresh, zeroed spend (a run's starting analysis state). */
export function emptyAnalysisSpend(): AnalysisSpend {
  return { ffmpegSeconds: 0, transcriptionMinutes: 0 };
}

/** One resource charge a single analysis call incurs. */
export interface AnalysisCharge {
  readonly resource: AnalysisResource;
  /** Units consumed (seconds / minutes) — never negative. */
  readonly amount: number;
}

/** The outcome of checking one charge against a running budget. */
export type CapDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Static metadata mapping each resource onto its caps/spend field + a display unit. */
const RESOURCE_META: Readonly<
  Record<
    AnalysisResource,
    { readonly cap: keyof AnalysisCaps; readonly spend: keyof AnalysisSpend; readonly unit: string }
  >
> = {
  ffmpegSeconds: { cap: 'maxFfmpegSeconds', spend: 'ffmpegSeconds', unit: 's ffmpeg' },
  transcriptionMinutes: {
    cap: 'maxTranscriptionMinutes',
    spend: 'transcriptionMinutes',
    unit: 'min transcribed',
  },
};

/**
 * Decide whether one charge fits the remaining budget — pure, no mutation. A charge is
 * denied when applying it would push the resource's running total PAST its cap. A
 * zero-amount charge is allowed exactly while the resource is still under its cap.
 */
export function decideCharge(
  caps: AnalysisCaps,
  spend: AnalysisSpend,
  charge: AnalysisCharge,
): CapDecision {
  const meta = RESOURCE_META[charge.resource];
  const cap = caps[meta.cap];
  const already = spend[meta.spend];
  // Deny when the resource is already at/over its ceiling (nothing left, even for a
  // count-unknown strategy call) OR when this call's known amount would push it past.
  if (already >= cap || already + charge.amount > cap) {
    return {
      allowed: false,
      reason:
        `analysis cap reached — ${String(already)}/${String(cap)} ${meta.unit} used this run` +
        (charge.amount > 0 ? `, this call needs ${String(charge.amount)} more` : '') +
        ' (per-run budget, plan B5.4)',
    };
  }
  return { allowed: true };
}

/** Fold one charge into the running spend — pure, returns a new spend. */
export function addCharge(spend: AnalysisSpend, charge: AnalysisCharge): AnalysisSpend {
  const meta = RESOURCE_META[charge.resource];
  return { ...spend, [meta.spend]: spend[meta.spend] + charge.amount };
}

/** A single analysis call's shape, as much as charge derivation needs. */
interface ChargeableCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Speech-to-text, charged in minutes of audio actually transcribed. */
const TRANSCRIPTION_TOOLS: ReadonlySet<string> = new Set(['transcribe', 'transcription']);

/**
 * Tools whose cost is ffmpeg DECODE TIME in the sidecar.
 *
 * The list is the set of calls this host executor dispatches that run a decode over media
 * bytes: the silence/scene/beat analyzers, the single-frame composite behind `get_frame`,
 * and the frame sampling behind `measure_color`.
 *
 * Deliberately NOT here:
 *  - `transcribe`, which is charged in minutes instead — one call, two resources, would
 *    double-charge the same work;
 *  - `index_media`, `search_visual`, `map_footage`, `describe_footage`, which spend their
 *    wall clock waiting on an understanding MODEL rather than on a decode (a footage map
 *    measured 409 seconds against eleven assets). Charging those against an ffmpeg ceiling
 *    would refuse local analyses to pay for a bill ffmpeg never ran up;
 *  - the sourcing/search calls, which are network requests against a catalogue.
 */
const FFMPEG_BACKED_TOOLS: ReadonlySet<string> = new Set([
  'analyze_silence',
  'remove_silences',
  'detect_scenes',
  'detect_beats',
  'get_frame',
  'measure_color',
]);

/** Which capped resource this call spends, or `null` when it spends neither. */
export function chargedResource(name: string): AnalysisResource | null {
  if (TRANSCRIPTION_TOOLS.has(name)) return 'transcriptionMinutes';
  if (FFMPEG_BACKED_TOOLS.has(name)) return 'ffmpegSeconds';
  return null;
}

/**
 * The charge to PRE-check before a call is dispatched, or `null` for an uncapped call
 * (a catalogue search, an in-process read).
 *
 * The amount is ZERO, and that is the honest number rather than a placeholder: what a
 * decode or a transcription will cost depends on the duration of media the host has not
 * opened yet. A zero-amount charge is exactly the "count-unknown" case {@link decideCharge}
 * is written for — it asks "is there anything left in this resource?", and is denied only
 * when the run is already at or over the ceiling. So the guarantee a caller gets is: the
 * FIRST call that would exceed a cap still runs (and is charged in full), and every call
 * after it is refused honestly instead of running.
 *
 * The alternative — estimating the cost up front from asset metadata — would refuse calls
 * on a guess, and a cap that refuses work that would have fit is worse than one that
 * overshoots by a single call.
 */
export function preflightCharge(call: ChargeableCall): AnalysisCharge | null {
  const resource = chargedResource(call.name);
  return resource === null ? null : { resource, amount: 0 };
}

/**
 * The charge to RECORD after a call settled, or `null` when it consumed no capped resource.
 *
 * Two derivations, each measuring the thing its cap is named for:
 *
 *  - `transcriptionMinutes` comes from the engine's own answer — the last word's `end` is
 *    how much audio the recognizer actually got through. A call that returned no words
 *    transcribed nothing and is charged nothing.
 *  - `ffmpegSeconds` comes from `elapsedMs`, the wall clock the HOST measured around the
 *    dispatch. The engine does not report its internal ffmpeg time, so this is the only
 *    measurement available; it is an upper bound (it includes the HTTP round trip and any
 *    queueing), and for a ceiling whose job is to stop a runaway run, overestimating is
 *    the safe direction. {@link AnalysisCaps.maxFfmpegSeconds} is defined in exactly these
 *    terms: wall-clock seconds of ffmpeg-backed analysis.
 *
 * Callers charge every SETTLED outcome, including failures: a decode that ran for two
 * minutes and then timed out still burned two minutes of the machine, and not charging it
 * is what would let a failing loop run forever inside a budget that never moves.
 */
export function outcomeCharge(
  name: string,
  data: unknown,
  elapsedMs?: number,
): AnalysisCharge | null {
  const resource = chargedResource(name);
  if (resource === 'transcriptionMinutes') {
    const words = (data as { words?: unknown } | null)?.words;
    if (!Array.isArray(words) || words.length === 0) return null;
    const last = words[words.length - 1] as { end?: unknown };
    const end = typeof last.end === 'number' ? last.end : 0;
    return { resource, amount: end / 60 };
  }
  if (resource === 'ffmpegSeconds') {
    if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
    return { resource, amount: elapsedMs / 1000 };
  }
  return null;
}

/**
 * A run's mutable analysis budget — the thin stateful wrapper the host executor threads
 * through a run. Holds the caps + running spend; `check` is a pure pre-flight decision,
 * `record` folds real consumption in. One per run (created alongside the run's host cache).
 */
export interface AnalysisBudget {
  readonly caps: AnalysisCaps;
  /** The run's consumption so far (immutable snapshot). */
  spend(): AnalysisSpend;
  /** Pre-flight: would this charge fit? Does not mutate. */
  check(charge: AnalysisCharge): CapDecision;
  /** Record real consumption after a call ran. */
  record(charge: AnalysisCharge): void;
}

/**
 * Create a per-run analysis budget. Missing cap fields fall back to
 * {@link DEFAULT_ANALYSIS_CAPS}, so a partial override only changes the axes it names.
 */
export function createAnalysisBudget(caps?: Partial<AnalysisCaps>): AnalysisBudget {
  const resolved: AnalysisCaps = { ...DEFAULT_ANALYSIS_CAPS, ...caps };
  let spend = emptyAnalysisSpend();
  return {
    caps: resolved,
    spend: () => spend,
    check: (charge) => decideCharge(resolved, spend, charge),
    record: (charge) => {
      if (charge.amount <= 0) return;
      spend = addCharge(spend, charge);
      log.debug('record → analysis spend advanced', {
        resource: charge.resource,
        amount: charge.amount,
        spend,
      });
    },
  };
}

/**
 * A one-line, creator-neutral summary of a run's analysis spend for reporting next to token
 * spend (B5.4). Lists only the axes actually used; an all-zero run reports "no analysis".
 */
export function describeAnalysisSpend(spend: AnalysisSpend): string {
  const parts: string[] = [];
  if (spend.ffmpegSeconds > 0) parts.push(`${String(Math.round(spend.ffmpegSeconds))}s ffmpeg`);
  if (spend.transcriptionMinutes > 0) {
    parts.push(`${String(Math.round(spend.transcriptionMinutes * 10) / 10)} min transcribed`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'no analysis';
}
