/**
 * @framepilot/ai-sdk/agent — types for full agent mode (PRD §7.4, Phase 7).
 *
 * Agent mode runs a multi-step autonomous edit: the model plans, calls tools, and
 * the orchestrator turns each tool call into a validated, reversible patch applied
 * to a *working copy* of the project. The loop logs every action and stops when the
 * model is done (no more tool calls), when it stops making progress, or at a step
 * cap. The result is reviewable — it is NOT auto-applied to the user's project: the
 * human approves the combined patch (AGENTS.md invariant 4), and because that patch
 * is a single reversible {@link Patch}, applying it is one-click-revertible.
 *
 * The loop itself lives on the {@link Orchestrator} (the sole patch assembler);
 * this module only defines the data it returns.
 */
import type { AnyOperation, Patch } from '@framepilot/editor-core';
import type { EditResult } from './assemble.js';
import type { CritiqueReport, RenderValidationInput } from './critic.js';
import type { TargetPlatform } from './context-builder.js';
import type { AnalysisCaps } from './kernel/cost/analysis-caps.js';

/** One turn of the agent loop. */
export interface AgentStep {
  /** 1-based step index. */
  readonly index: number;
  /** The model's rationale text for this turn (WHY). */
  readonly rationale: string;
  /** Names of the tools the model invoked this turn. */
  readonly toolCalls: readonly string[];
  /** The validated patch this step produced, if it edited the timeline. */
  readonly patch?: Patch;
  /** True when the step advanced the working timeline (a valid, novel edit). */
  readonly applied: boolean;
  /** Human-readable note (e.g. why a step was skipped or rejected). */
  readonly note: string;
}

/** The reviewable result of an agent run. */
export interface AgentRun {
  /** The goal the agent worked toward (the user's request). */
  readonly goal: string;
  /**
   * The up-front numbered plan the agent committed to before acting (R3 C4), when
   * `planFirst` is enabled. Present for legibility; the loop still validates every
   * step independently. Absent when planning was not requested.
   */
  readonly plan?: readonly string[];
  /** Every turn the agent took, in order (the action log). */
  readonly steps: readonly AgentStep[];
  /**
   * The combined, validated edit: all applied operations bundled into one patch,
   * diffed against the original timeline. Apply this to commit the whole run; a
   * single Undo reverts it. May be an empty (no-op) patch if nothing was applied.
   */
  readonly result: EditResult;
  /** The agent's self-check over the resulting project (PRD §8.6). */
  readonly critique: CritiqueReport;
  /** Flat, human-readable log of every action taken. */
  readonly log: readonly string[];
}

/** Options controlling an agent run. */
export interface AgentOptions {
  /**
   * Hard cap on model turns (safety backstop). Defaults to 30 — sized for a
   * movie/documentary-length plan (many scenes, multiple analysis passes), not just a
   * single short-form ask.
   */
  readonly maxSteps?: number;
  /**
   * Blast-radius bound: max mutating operations a single turn may contribute before
   * the turn is rejected as too large (R3 C1). Defaults to 100.
   */
  readonly maxOpsPerTurn?: number;
  /**
   * Blast-radius bound: max cumulative operations across the whole run before the
   * loop stops with a diagnostic (R3 C1). Defaults to 800.
   */
  readonly maxOpsPerRun?: number;
  /**
   * Whether to grant one bounded Critic-driven repair pass after the run when fixable
   * findings remain (R3 C3). Still human-approved; never auto-applies. Defaults to true.
   */
  readonly autoRepair?: boolean;
  /**
   * Whether the agent drafts an up-front numbered plan before acting (R3 C4). The plan
   * is surfaced on {@link AgentRun.plan} and threaded into the loop's context. Defaults
   * to false (opt-in; costs one extra model call).
   */
  readonly planFirst?: boolean;
  /**
   * Plan-approval gate (P11.3): when `planFirst` drafts a HIGH-BLAST-RADIUS plan
   * (more than `PLAN_APPROVAL_STEP_THRESHOLD` steps — see `kernel/conductor.ts`), pause
   * before the first turn and require the creator's approve/cancel decision instead of
   * running straight through. A plain, serialisable boolean — the DECISION to gate is
   * part of the run's config, but the live approve/cancel resolution mechanism is a
   * separate, non-serialisable {@link AgentRunControls.planApproval} passed alongside
   * (never part of this options object — see `run-controls.ts`). Defaults to false
   * (unchanged behavior unless a host opts in and also wires the resolver).
   */
  readonly requirePlanApproval?: boolean;
  /** Target output duration the Critic checks against (e.g. 45s). */
  readonly durationTargetSeconds?: number;
  /** Target platform, threaded into the Critic's export-settings check. */
  readonly targetPlatform?: TargetPlatform;
  /** Results of an auto preview render's validation, fed to the Critic. */
  readonly render?: RenderValidationInput;
  /**
   * Resume an interrupted run (R3 C2). Carries the operations already applied, the
   * action log, and how many turns had completed at the interruption point. When
   * present, {@link Orchestrator.streamAgent} rebuilds the working project from these
   * ops and continues from the next step instead of starting over. Sourced from the
   * persisted {@link CheckpointEvent} of a cancelled run.
   */
  readonly resume?: {
    readonly ops: readonly AnyOperation[];
    readonly log: readonly string[];
    readonly stepsCompleted: number;
    /** Canonical causal ledger captured with the checkpoint; required for safe mutation. */
    readonly working?: unknown;
  };
  /**
   * Per-run analysis budget overrides (plan B5.4): caps on frames extracted, ffmpeg
   * seconds, and transcription minutes the run may spend on host analysis. A partial
   * override merges over {@link DEFAULT_ANALYSIS_CAPS}; omit to use the defaults.
   */
  readonly analysisCaps?: Partial<AnalysisCaps>;
  /**
   * Diminishing-returns stop tuning (E4, plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md).
   * After `turns` consecutive turns that each produced fewer than `minOutputTokens`
   * output tokens AND applied no edit, the run stops with an honest "converged"
   * notice (distinct from the stall notice — this is "nothing more to add", not
   * "spinning"). Turns whose provider reports no usage never count toward the streak —
   * without a token delta there is nothing to prove diminishing returns with.
   * Defaults: `DIMINISHING_RETURNS_TURNS` / `DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS`
   * (`kernel/conductor.ts`).
   */
  readonly diminishingReturns?: {
    readonly turns?: number;
    readonly minOutputTokens?: number;
  };
}

/** The result of a standalone review/critic pass (PRD §8.6). */
export interface ReviewResult {
  /** A human-readable headline + per-check summary. */
  readonly text: string;
  /** The structured report the UI renders. */
  readonly report: CritiqueReport;
}
