/**
 * @framepilot/ai-sdk/kernel/proposers/edit-proposer — the EditProposer proposer
 * (plan/AI-ORCHESTRATION-REDESIGN.md §6, §10, Phase K3.3).
 *
 * The per-edit-task proposer (§6 roster): given ONE plan step, a focused index slice, and
 * the *relevant* tools, it proposes the concrete {@link ToolCall}s that realize the step.
 * It only ever *proposes* — "the model proposes, the runtime disposes" (§10): the kernel
 * turns each returned call into a `PatchEffect`/`HostToolEffect` the runtime schedules,
 * validates, dedups, and folds back. EditProposer never mutates anything.
 *
 * **Schema-validated by the tool registry (AI-safety invariant).** A proposed call is
 * accepted only if its name is one of the scoped tools AND its arguments pass that tool's
 * Zod `parse` — so a hallucinated tool or malformed args is rejected here, not trusted. A
 * rejection is a {@link ProposerResult} error the kernel feeds back once (§16.3), never a
 * silent bad edit. Mid model tier (§6). Pure + stateless.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import { EDIT_PROPOSER_SYSTEM_PROMPT } from '../../prompts.js';
import type { ToolCall, ToolDescriptor } from '../../providers/types.js';
import type { ToolSpec } from '../../tool-registry.js';
import type { ModelEffect } from '../effects.js';
import type { PlanStepSpec } from '../plan-compiler.js';
import {
  type ModelTier,
  type ProposerResult,
  parseJsonResponse,
  proposerModelEffect,
} from './types.js';

const log = createLogger('ai-sdk:kernel:proposers:edit-proposer');

/** Bounded input to the EditProposer (§6 roster): one step + a focused slice + tools. */
export interface EditProposerInput {
  /** The single plan step being realized. */
  readonly step: PlanStepSpec;
  /**
   * The focused Semantic Index slice for this step (the focus range + targeted layer,
   * §9). Opaque to the proposer — serialized into the prompt as retrieval context.
   */
  readonly slice: unknown;
  /**
   * Analyses this plan asked for that produced NO evidence (the tool failed and the run
   * routed around it).
   *
   * Absence is not self-describing. A montage step whose beat detection had been killed
   * arrived here with simply no beat grid in the slice, and a model handed a hole fills
   * it: the run emitted thirty-three identically-spaced cuts through the asset list in
   * library order and reported a beat-synced montage. Naming the gap is what makes the
   * difference between working without evidence and inventing it.
   */
  readonly evidenceGaps?: readonly { readonly tool: string; readonly detail: string }[];
  /**
   * Exhaustive project identities, kept in field-shaped namespaces so an opaque track id
   * can never be mistaken for an asset id merely because both are strings.
   */
  readonly identities: {
    readonly assets: readonly {
      readonly assetId: string;
      readonly kind: 'video' | 'audio' | 'image';
      readonly durationSeconds?: number;
    }[];
    readonly tracks: readonly {
      readonly trackId: string;
      readonly type: string;
    }[];
    readonly clips: readonly {
      readonly clipId: string;
      readonly assetId: string;
      readonly trackId: string;
      readonly start: number;
      readonly end: number;
    }[];
  };
  /** The scoped subset of registry tools this step may use (§9 — not all 26). */
  readonly tools: readonly ToolSpec[];
}

// Raw model output: a list of proposed calls. Args default to {} (a no-arg tool). The
// registry — not this schema — is the real validator (see parseResponse).
const RawToolCallSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

/** The EditProposer's raw output schema (validated further against the registry). */
export const RawToolCallsSchema = z.object({
  toolCalls: z.array(RawToolCallSchema),
});

// The prompt text lives in prompts.ts (the single home for model-facing prompts).
const SYSTEM = EDIT_PROPOSER_SYSTEM_PROMPT;

/**
 * Reply room for one proposal. Unlike a chat turn, this output's length is a function of the
 * EDIT: a 30-second montage cut on every drum hit is ~60 `add_clip` calls, each with full
 * -precision times and real ids — roughly 6–8K tokens, and a repair turn adds the rejected
 * attempt on top. The providers' shared conservative default (2,048 for Anthropic) truncated
 * exactly this shape mid-object, which surfaced as "model response was not valid JSON". A
 * provider clamps this down to its model's real ceiling, so asking generously is safe.
 */
const PROPOSAL_MAX_TOKENS = 32_000;

/** Build the scoped tool descriptors advertised to the model for this step. */
function scopedDescriptors(tools: readonly ToolSpec[]): ToolDescriptor[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** Render the bounded input (one step + focused slice) as the user turn. */
function renderInput(input: EditProposerInput): string {
  const gaps = input.evidenceGaps ?? [];
  return [
    `Step: ${JSON.stringify({ label: input.step.label, effect: input.step.effect })}`,
    'Project identities (assetId, trackId, and clipId are separate namespaces; copy an id only ' +
      `into its matching field): ${JSON.stringify(input.identities)}`,
    `Context: ${JSON.stringify(input.slice)}`,
    // Stated as a fact about this run, with the consequence spelled out, because the
    // failure mode is the model quietly substituting an even grid for a real one.
    ...(gaps.length === 0
      ? []
      : [
          `MISSING EVIDENCE — these analyses were requested and did not return: ${JSON.stringify(gaps)}. ` +
            'You do not have this information. Do not substitute regular intervals, ' +
            'library order, or any other invented stand-in for it. Make only the edits ' +
            'the evidence you DO have supports, and say plainly in your reasoning which ' +
            'part of the request you could not carry out and why.',
        ]),
  ].join('\n');
}

/**
 * Validate the raw proposed calls against the scoped tools. Each call must name a
 * provided tool and its args must pass that tool's `parse`; the returned call carries the
 * *coerced* args (the registry's numeric-string coercion, etc.) and a deterministic id
 * when the model omitted one. A single bad call fails the whole proposal.
 */
function validateCalls(
  raw: readonly z.infer<typeof RawToolCallSchema>[],
  tools: readonly ToolSpec[],
): ProposerResult<ToolCall[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const calls: ToolCall[] = [];
  for (const [i, call] of raw.entries()) {
    const tool = byName.get(call.name);
    if (!tool) {
      return { ok: false, error: `unknown or out-of-scope tool "${call.name}"` };
    }
    let parsed: unknown;
    try {
      parsed = tool.parse(call.arguments);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `invalid arguments for "${call.name}": ${detail}` };
    }
    calls.push({
      id: call.id ?? `call_${String(i + 1)}`,
      name: call.name,
      arguments: parsed as Record<string, unknown>,
    });
  }
  return { ok: true, value: calls };
}

/**
 * The EditProposer proposer (mid tier). Unlike the other proposers it does not implement
 * the plain {@link import('./types.js').ModelProposer} contract: validating its output
 * *requires* the step's scoped tools, so {@link EditProposer.parseResponse} takes them.
 * This keeps registry validation honest — the parser has exactly the tools the request
 * advertised — rather than smuggling a stateless `parseResponse(raw)` that couldn't check.
 */
export interface EditProposer {
  readonly name: string;
  readonly tier: ModelTier;
  buildRequest(input: EditProposerInput): ModelEffect;
  /** Validate the raw response's shape, then its calls against `tools` (the registry). */
  parseResponse(raw: string, tools: readonly ToolSpec[]): ProposerResult<ToolCall[]>;
}

export const editProposer: EditProposer = {
  name: 'edit_proposer',
  tier: 'mid',
  buildRequest(input) {
    log.action('buildRequest → edit_proposer', {
      step: input.step.label,
      scopedTools: input.tools.length,
      tier: 'mid',
    });
    return proposerModelEffect(SYSTEM, renderInput(input), {
      tools: scopedDescriptors(input.tools),
      tier: 'mid',
      maxTokens: PROPOSAL_MAX_TOKENS,
    });
  },
  parseResponse(raw, tools): ProposerResult<ToolCall[]> {
    const shape = parseJsonResponse(raw, RawToolCallsSchema);
    if (!shape.ok) {
      log.warn('parseResponse ← edit_proposer raw shape rejected', { error: shape.error });
      return shape;
    }
    const result = validateCalls(shape.value.toolCalls, tools);
    if (result.ok) {
      log.action('parseResponse ← edit_proposer validated', {
        ops: result.value.length,
        tools: result.value.map((c) => c.name),
      });
    } else {
      log.warn('parseResponse ← edit_proposer call rejected', { error: result.error });
    }
    return result;
  },
};
