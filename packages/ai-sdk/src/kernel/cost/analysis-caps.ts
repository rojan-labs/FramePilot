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
 * Enforcement lives in `sidecar-executor.ts` (the host seam that actually runs these
 * calls): it PRE-checks a call's charge before dispatch and RECORDS the real consumption
 * after — so the budget reflects what actually ran, and the run's spend is reportable next
 * to token spend (`describeAnalysisSpend`).
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

/**
 * The charge to PRE-check before a call is dispatched, or `null` for an uncapped call
 * (search, probe, a cache hit). Transcription/ffmpeg charges are learned post-run (their
 * cost depends on media duration the host does not know up front), so they do not pre-check
 * here.
 */
export function preflightCharge(_call: ChargeableCall): AnalysisCharge | null {
  return null;
}

/**
 * The charge to RECORD after a call settled successfully, derived from the real engine
 * response — or `null` when the call consumed no capped resource. `transcribe`/
 * `transcription` charges the transcribed audio duration in minutes (from the last word's
 * `end`, when present).
 */
export function outcomeCharge(name: string, data: unknown): AnalysisCharge | null {
  if (name === 'transcribe' || name === 'transcription') {
    const words = (data as { words?: unknown } | null)?.words;
    if (!Array.isArray(words) || words.length === 0) return null;
    const last = words[words.length - 1] as { end?: unknown };
    const end = typeof last.end === 'number' ? last.end : 0;
    return { resource: 'transcriptionMinutes', amount: end / 60 };
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
