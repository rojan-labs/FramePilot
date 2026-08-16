/**
 * Bounded audit descriptors for the durable run log.
 *
 * WHY this exists: the durable effect observer used to record `JSON.stringify(effect)`
 * — the WHOLE {@link RuntimeEffect}. A `host_tool` effect carries `effect.project`, and
 * a project carries `history` (inverse patches, unbounded: a real user run in this repo
 * produced a 34 MB `run.effect_requested` record from a 39 MB history against 8 KB of
 * assets). That one value was then, per tool call:
 *
 *   1. `JSON.stringify`d, `JSON.parse`d, and deep-validated through the recursive
 *      `JsonValueSchema` — ~800 ms of BLOCKING main-process CPU, per copy;
 *   2. appended to the WAL and kept in `RunStore`'s cache as BOTH a parsed object graph
 *      and its JSON signature string — retained for the life of the process;
 *   3. structured-cloned across the IPC bridge to every subscribed renderer.
 *
 * Thirteen tool calls in one measured run cost 13 s of frozen main process and 2.3 GB of
 * retained heap, before the renderer's copy. That is the memory blow-up this module ends.
 *
 * The durable log is an AUDIT record: it must say what ran, against which project
 * revision, with which arguments, and how it settled. It is NOT a document store, so it
 * never needs the project, the prompt, the decoded frames, or the raw stream chunks —
 * all of which are reconstructible from their own authoritative homes. Everything here
 * is therefore a bounded projection, and any free-form value still passes through
 * {@link boundedJson} so no future field can reintroduce an unbounded blob.
 */
import type { AnalysisBudget, EffectResult, JsonValue, RuntimeEffect } from '@framepilot/ai-sdk';
import { exceedsTransportBudget } from './ai-event-transport.js';

/**
 * Budget for one free-form value inside a durable effect record.
 *
 * Small on purpose: this bounds a diagnostic field, not a payload. Tool arguments and
 * tool outcomes that matter to the UI travel on the `run.stream_event` channel (already
 * bounded by `MAX_TOOL_RESULT_TRANSPORT_CHARS`); this is only the audit trail beside them.
 */
export const MAX_DURABLE_EFFECT_FIELD_CHARS = 16 * 1024;

/** What replaces a value that does not fit — explicit, so a reader is never misled. */
export interface OmittedValue {
  readonly omitted: true;
  readonly reason: string;
}

function omitted(what: string): OmittedValue {
  return {
    omitted: true,
    reason: `${what} exceeded the ${String(
      MAX_DURABLE_EFFECT_FIELD_CHARS,
    )}-character durable audit budget.`,
  };
}

/**
 * `value` when it fits the audit budget, otherwise an explicit omission marker.
 *
 * @param value - Any JSON-like value from an effect or its result.
 * @param what - Human label used in the omission reason (e.g. `'Tool arguments'`).
 * @returns The value unchanged, or `{ omitted: true, reason }`.
 */
export function boundedJson(value: unknown, what: string): JsonValue {
  if (value === undefined) return null;
  if (exceedsTransportBudget(value, MAX_DURABLE_EFFECT_FIELD_CHARS)) {
    return omitted(what) as unknown as JsonValue;
  }
  return value as JsonValue;
}

/**
 * The run's caps and consumption so far, as plain data.
 *
 * WHY a projection and not the value itself: an `AnalysisBudget` is a stateful HANDLE —
 * `spend`/`check`/`record` are functions. Recording it verbatim put functions in the
 * durable record, and `JsonValueSchema.parse` (see `main.ts`) rejects those, so every
 * capped tool call aborted its run with a wall of `invalid_union` issues. Only the two
 * numeric snapshots belong in an audit trail anyway.
 */
function describeAnalysisBudget(budget: AnalysisBudget): JsonValue {
  return { caps: { ...budget.caps }, spend: { ...budget.spend() } };
}

/** Rough size of a model request, without keeping any of its text. */
function promptShape(request: {
  readonly messages?: readonly { readonly content?: unknown }[];
  readonly tools?: readonly unknown[];
  readonly model?: unknown;
}): JsonValue {
  let promptChars = 0;
  for (const message of request.messages ?? []) {
    if (typeof message.content === 'string') promptChars += message.content.length;
  }
  return {
    messageCount: request.messages?.length ?? 0,
    toolCount: request.tools?.length ?? 0,
    promptChars,
    ...(typeof request.model === 'string' ? { model: request.model } : {}),
  };
}

/**
 * A bounded audit description of an effect about to run.
 *
 * Never includes the project document, the model prompt, or any other value whose size
 * is a function of the user's media rather than of the effect itself.
 *
 * @param effect - The runtime effect being requested.
 * @returns Marshallable JSON safe to append to the WAL and push over IPC.
 */
export function describeRuntimeEffect(effect: RuntimeEffect): JsonValue {
  switch (effect.kind) {
    case 'host_tool':
      return {
        kind: effect.kind,
        call: {
          id: effect.call.id,
          name: effect.call.name,
          // Arguments are model-authored and normally tiny, but a caption payload can be
          // large — bound rather than trust.
          arguments: boundedJson(effect.call.arguments, 'Tool arguments'),
        },
        // Identity and revision, never the document: the project is authoritative on
        // disk and in `ProjectCommandService`, and both are addressable from these two.
        project: {
          id: effect.project.id,
          revision: effect.project.timeline.revision ?? null,
        },
        ...(effect.analysisBudget === undefined
          ? {}
          : { analysisBudget: describeAnalysisBudget(effect.analysisBudget) }),
      };
    case 'model':
    case 'model_stream':
      return {
        kind: effect.kind,
        ...(effect.tier === undefined ? {} : { tier: effect.tier }),
        request: promptShape(effect.request as Parameters<typeof promptShape>[0]),
      };
    default: {
      // Structured effects carry a small `control` block plus one free-form payload
      // field. Keep the control verbatim (it IS the audit identity) and bound the rest.
      const { control, ...rest } = effect;
      const bounded: Record<string, JsonValue> = {
        kind: effect.kind,
        control: { ...control } as unknown as JsonValue,
      };
      for (const [key, value] of Object.entries(rest)) {
        if (key === 'kind') continue;
        bounded[key] = boundedJson(value, `Effect field "${key}"`);
      }
      return bounded;
    }
  }
}

/**
 * A bounded audit description of how an effect settled.
 *
 * @param result - The settled effect result.
 * @returns Marshallable JSON safe to append to the WAL and push over IPC.
 */
export function describeEffectResult(result: EffectResult): JsonValue {
  switch (result.kind) {
    case 'host_tool': {
      const { status, summary, data, images } = result.outcome;
      return {
        kind: result.kind,
        cached: result.cached,
        status,
        summary,
        // Decoded frames are the single largest thing a tool can return and are useless
        // in an audit log — record only that they existed.
        ...(images === undefined ? {} : { imageCount: images.length }),
        ...(data === undefined ? {} : { data: boundedJson(data, 'Tool result data') }),
      };
    }
    case 'model':
      return {
        kind: result.kind,
        cached: result.cached,
        textChars: result.response.text?.length ?? 0,
        toolCalls: (result.response.toolCalls ?? []).map((call) => call.name),
        ...(result.response.usage === undefined
          ? {}
          : { usage: boundedJson(result.response.usage, 'Model usage') }),
      };
    case 'model_stream':
      // The chunks ARE the assistant message; it is already durable as stream events.
      return { kind: result.kind, cached: result.cached, chunkCount: result.chunks.length };
    case 'structured':
      return {
        kind: result.kind,
        effectKind: result.effectKind,
        cached: result.cached,
        outcome: boundedJson(result.outcome, 'Effect outcome'),
      };
  }
}
