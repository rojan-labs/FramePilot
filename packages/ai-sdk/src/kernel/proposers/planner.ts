/**
 * @framepilot/ai-sdk/kernel/proposers/planner — the Planner proposer
 * (plan/AI-ORCHESTRATION-REDESIGN.md §6, §8, Phase K3.3).
 *
 * The non-deterministic plan source (§8.2): for a novel/composite request the Planner
 * turns an {@link Intent} + a Semantic Index summary + the tool capabilities into a
 * {@link ProposedPlan} — the **exact** shape `plan-compiler.ts` compiles to a Task DAG. So
 * a Planner proposal flows through the *same* {@link compilePlan} a deterministic recipe
 * does; there is one execution path downstream regardless of the plan's origin.
 *
 * Bounded input (never raw `project.fp.json`): the Planner reasons over a compact
 * {@link SemanticIndexSummary} (the editor-level projection, §8.3) and a
 * {@link ToolCapability} list, not clip JSON. Mid model tier (§6). Pure + stateless.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import { PLANNER_SYSTEM_PROMPT } from '../../prompts.js';
import type { ProposedPlan } from '../plan-compiler.js';
import type { SemanticTimelineIndex } from '../semantic-index/semantic-index.js';
import type { SemanticIndexSlice } from '../semantic-index/semantic-index-slice.js';
import type { ToolSpec } from '../../tool-registry.js';
import type { Intent } from './intent-parser.js';
import {
  type ModelProposer,
  type ProposerResult,
  parseJsonResponse,
  proposerModelEffect,
} from './types.js';

const log = createLogger('ai-sdk:kernel:proposers:planner');

/**
 * A compact, model-facing summary of the {@link SemanticTimelineIndex} — counts and
 * flags, not the slices themselves. Enough for the Planner to decide *which analyses and
 * edits* a plan needs (does it need beats? are there silences to strip? how many
 * layers?), cheaply and deterministically derived.
 */
export interface SemanticIndexSummary {
  readonly layerCount: number;
  readonly dialogueSegments: number;
  readonly captions: number;
  readonly transitions: number;
  readonly effects: number;
  readonly musicTracks: number;
  readonly shots: number;
  readonly silences: number;
  readonly hasBeatGrid: boolean;
}

/** Summarize a semantic index into the compact {@link SemanticIndexSummary} (pure). */
export function summarizeSemanticIndex(index: SemanticTimelineIndex): SemanticIndexSummary {
  return {
    layerCount: index.layers.length,
    dialogueSegments: index.dialogue.length,
    captions: index.captions.length,
    transitions: index.transitions.length,
    effects: index.effects.length,
    musicTracks: index.music.length,
    shots: index.shots.length,
    silences: index.silences.length,
    hasBeatGrid: index.beats !== null,
  };
}

/** One tool's capability advertised to the Planner (scoped subset of the registry). */
export interface ToolCapability {
  readonly name: string;
  readonly kind: ToolSpec['kind'];
  readonly mutates: boolean;
  readonly description: string;
  /**
   * The arguments a step calling this tool MUST supply, and the ones it may.
   *
   * WHY these are here: the Planner authors each step's `args` itself, and it used to be
   * told only a tool's name, kind and prose description — never its parameters. So it
   * planned `search_visual` with no `query` and `describe_footage` with no `assetId`,
   * which is not a model failing to follow instructions but a model being asked to
   * produce arguments it was never shown the names of. Every downstream guard
   * (`missingRequiredArgs`, the engine's own validation) is a backstop for a gap that
   * belongs here, at the point where the plan is written.
   */
  readonly requiredArgs: readonly string[];
  readonly optionalArgs: readonly string[];
}

/** Argument names off a tool's advertised JSON Schema, split by whether they are required. */
function argNames(tool: ToolSpec): { required: string[]; optional: string[] } {
  const properties = tool.parameters.properties;
  const names =
    typeof properties === 'object' && properties !== null ? Object.keys(properties) : [];
  const requiredRaw = tool.parameters.required;
  const required = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter((k): k is string => typeof k === 'string') : [],
  );
  return {
    required: names.filter((n) => required.has(n)),
    optional: names.filter((n) => !required.has(n)),
  };
}

/** Project a scoped list of registry tools into {@link ToolCapability} hints (pure). */
export function toolCapabilities(tools: readonly ToolSpec[]): ToolCapability[] {
  return tools.map((t) => {
    const { required, optional } = argNames(t);
    return {
      name: t.name,
      kind: t.kind,
      mutates: t.mutates,
      description: t.description,
      requiredArgs: required,
      optionalArgs: optional,
    };
  });
}

/** Bounded input to the Planner (§6 roster). */
export interface PlannerInput {
  readonly intent: Intent;
  readonly index: SemanticIndexSummary;
  readonly capabilities: readonly ToolCapability[];
  /** Exact effect kind/name pairs the planned-edit driver can execute. */
  readonly executableEffects?: Readonly<
    Partial<Record<'host_tool' | 'analysis' | 'patch' | 'model' | 'verify', readonly string[]>>
  >;
  /**
   * The real Semantic Index Slice (P4.2), not just {@link index}'s counts — e.g. actual
   * dialogue/caption/layer/music content, plus any `shots`/`silences`/`beats` an earlier
   * step in this same run already ingested (P4.1). Optional: a caller with nothing better
   * than the whole-project slice may omit it and the Planner still gets the cardinalities.
   */
  readonly slice?: SemanticIndexSlice;
}

// The Zod schema for a Planner proposal. Its shape is the `ProposedPlan` contract from
// plan-compiler.ts — the compiler assigns ids/defaults and enforces the DAG invariants
// (dangling deps, cycles), so the schema only guards structure and the effect-kind enum.
const TaskEffectSpecSchema = z.object({
  kind: z.enum(['host_tool', 'analysis', 'patch', 'model', 'verify']),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

const PlanStepSpecSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  effect: TaskEffectSpecSchema,
  resource: z.enum(['ffmpeg', 'model', 'pure', 'render', 'host']).optional(),
  priority: z.enum(['edit', 'analysis', 'speculative']).optional(),
  deps: z.array(z.string()).optional(),
});

/** The Planner's output schema — validated to be exactly a {@link ProposedPlan}. */
export const ProposedPlanSchema = z.object({
  steps: z.array(PlanStepSpecSchema).min(1),
});

// The prompt text lives in prompts.ts (the single home for model-facing prompts).
const SYSTEM = PLANNER_SYSTEM_PROMPT;

/** Render the bounded input (intent + index summary + slice + capabilities) as the user turn. */
function renderInput(input: PlannerInput): string {
  const lines = [
    `Intent: ${JSON.stringify(input.intent)}`,
    `Timeline: ${JSON.stringify(input.index)}`,
  ];
  // Only sent when the caller has one (P4.2) — never a fabricated placeholder for a run
  // that hasn't derived it.
  if (input.slice) lines.push(`Context: ${JSON.stringify(input.slice)}`);
  lines.push(`Tools: ${JSON.stringify(input.capabilities)}`);
  if (input.executableEffects) {
    lines.push(`Executable effects: ${JSON.stringify(input.executableEffects)}`);
  }
  return lines.join('\n');
}

/** The Planner proposer (mid tier). Output flows straight into `compilePlan`. */
export const planner: ModelProposer<PlannerInput, ProposedPlan> = {
  name: 'planner',
  tier: 'mid',
  buildRequest(input) {
    log.action('buildRequest → planner', {
      goal: input.intent.goal,
      capabilities: input.capabilities.length,
      hasSlice: Boolean(input.slice),
      tier: 'mid',
    });
    return proposerModelEffect(SYSTEM, renderInput(input), { tier: 'mid' });
  },
  parseResponse(raw): ProposerResult<ProposedPlan> {
    const result = parseJsonResponse(raw, ProposedPlanSchema);
    if (result.ok) {
      log.action('parseResponse ← planner parsed', { steps: result.value.steps.length });
    } else {
      log.warn('parseResponse ← planner rejected', { error: result.error });
    }
    // The validated shape IS a ProposedPlan; the cast only reconciles Zod's `| undefined`
    // optional inference with the interface's exact-optional readonly fields.
    return result.ok ? { ok: true, value: result.value as ProposedPlan } : result;
  },
};
