/**
 * @framepilot/ai-sdk/kernel/proposers/types — the proposer contract + cost-class metadata
 * (plan/AI-ORCHESTRATION-REDESIGN.md §6, §10, Phase K3.3).
 *
 * A **proposer** is the plan's demoted-LLM primitive (§6): "a role — a prompt + an
 * output schema + a model tier — not a long-lived actor." It has no memory, no
 * conversation, and no ability to call another proposer. It is a pure pair of functions:
 *
 *  - {@link ModelProposer.buildRequest} turns bounded input into an inert
 *    {@link ModelEffect} (effects-as-data, tenet 5) — it describes the model call, it
 *    does NOT perform it; the Effect Runtime disposes ("the model proposes, the runtime
 *    disposes", §10); and
 *  - {@link ModelProposer.parseResponse} validates the model's raw text against a Zod
 *    schema, so a malformed response is *rejected* (a {@link ProposerResult} error the
 *    kernel can retry once), never trusted (§16.3).
 *
 * ## Model cost classes
 *
 * Each proposer declares a {@link ModelTier} for budgeting and telemetry. It does not
 * select a provider or model: one host-selected provider owns the complete request so
 * credentials, capabilities, and retry behavior cannot drift midway through a run.
 */
import { z } from 'zod/v4';
import type { ModelEffect } from '../effects.js';

/**
 * The model-work cost class used for budgets and telemetry. It never changes the
 * host-selected provider or model.
 */
export type ModelTier = 'small' | 'mid' | 'large';

/**
 * The result of validating a model response. A malformed proposal is an `ok: false`
 * error the kernel feeds back once to self-correct (§16.3), never a thrown crash —
 * exactly the discipline the current `describeArgValidationError` loop applies to tool
 * args, generalized to every proposer output.
 */
export type ProposerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * A model-backed proposer: a name, a tier, a pure request builder, and a pure response
 * parser. Stateless and single-purpose (§6). The Critic is the one exception — it is
 * deterministic-first (its findings need no model), so it does not implement this
 * interface; see `critic.ts`.
 */
export interface ModelProposer<Input, Output> {
  /** Stable identifier for tracing/telemetry (e.g. `intent_parser`). */
  readonly name: string;
  /** The model-work cost class used for budgeting and telemetry. */
  readonly tier: ModelTier;
  /** Build the inert {@link ModelEffect} describing this proposer's model call. */
  buildRequest(input: Input): ModelEffect;
  /** Validate the model's raw text into the proposer's output schema. */
  parseResponse(raw: string): ProposerResult<Output>;
}

/**
 * Assemble an inert {@link ModelEffect} from a system contract + user content. Proposers
 * run at `temperature: 0` — they emit *structured* decisions, not prose, so determinism
 * is preferred and the output is cacheable/replayable. Optional `tools` scopes the tool
 * descriptors to just what this proposer may use (§9 — "not all 26 every turn").
 */
export function proposerModelEffect(
  system: string,
  user: string,
  options: {
    readonly tools?: ModelEffect['request']['tools'];
    /** Stamps the effect with the calling proposer's declared {@link ModelTier} (P3.4). */
    readonly tier?: ModelTier;
    /**
     * Reply room this proposer's output needs, in tokens. A proposer whose output grows
     * with the timeline (the EditProposer's per-cut tool calls) must state it — the
     * provider's own conservative default truncates a long structured proposal into
     * invalid JSON. Omitted means "the provider default is enough".
     */
    readonly maxTokens?: number;
  } = {},
): ModelEffect {
  return {
    kind: 'model',
    request: {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    },
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
  };
}

/** Strip a ```json … ``` (or bare ```` ``` ````) code fence a model wraps JSON in. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

const JSON_RECOVERY_MAX_CHARS = 20_000;
const JSON_RECOVERY_MAX_CANDIDATES = 3;

/** Extract bounded, balanced JSON objects from a provider's harmless prose wrapper. */
function embeddedJsonObjects(raw: string): string[] {
  const source = raw.slice(0, JSON_RECOVERY_MAX_CHARS);
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && depth > 0) {
      quoted = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.push(source.slice(start, index + 1));
      start = -1;
      if (candidates.length >= JSON_RECOVERY_MAX_CANDIDATES) break;
    }
  }
  return candidates;
}

/**
 * Parse a model's raw text into a schema-validated struct — the shared spine of every
 * model proposer. Tolerates a code-fenced JSON block (models routinely wrap structured
 * output in one); a non-JSON body or a schema mismatch returns a
 * {@link ProposerResult} error, never throws (§16.3 — a bad proposal is data, not a crash).
 */
export function parseJsonResponse<S extends z.ZodType>(
  raw: string,
  schema: S,
): ProposerResult<z.infer<S>> {
  const primary = stripCodeFence(raw);
  const candidates = [primary, ...embeddedJsonObjects(raw).filter((value) => value !== primary)];
  let firstSchemaError: z.ZodError | undefined;
  for (const candidate of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data };
    firstSchemaError ??= parsed.error;
  }
  if (firstSchemaError) {
    // A failed safeParse always carries at least one issue (Zod invariant).
    const first = firstSchemaError.issues[0]!;
    const where = first.path.length ? ` at ${first.path.join('.')}` : '';
    return { ok: false, error: `schema validation failed${where}: ${first.message}` };
  }
  return { ok: false, error: 'model response was not valid JSON' };
}
