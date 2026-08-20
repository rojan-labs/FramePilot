/**
 * @framepilot/ai-sdk/tool-registry — registered AI tools (PRD §8.3).
 *
 * The AI may ONLY edit through these approved, schema-validated tools (AGENTS.md
 * invariant 5). It never mutates project JSON directly: a mutating tool returns
 * typed {@link Operation}s that the orchestrator assembles into a reviewable,
 * validated, reversible {@link Patch}.
 *
 * ## Design
 *
 * Each tool carries a Zod `inputSchema` (the single source of truth for both
 * validation and the JSON Schema advertised to the model — derived via
 * `z.toJSONSchema`, so the two can never drift). A tool is one of:
 *
 * - **read** (`mutates: false`, `available: true`): returns JSON data from the
 *   project context (`get_timeline`, `get_transcript`, …).
 * - **mutate** (`mutates: true`, `available: true`): returns `Operation[]`
 *   built from validated args (`trim_clip`, `delete_range`, …).
 * - **action** (`mutates: false`, `available: true`): a side-effecting request
 *   the host executes (`render_preview`, `export_video`) — no patch, no data.
 * - **analysis** (`mutates: false`, `available: true`): an ffmpeg-backed read the
 *   host runs against the media and returns data for (`analyze_silence`,
 *   `detect_scenes`). Like an action, the in-process orchestrator does not run it
 *   (the render engine is Python-only, render-vs-preview rule) — the engine
 *   sidecar computes it. No patch, no in-process data.
 * - **unavailable** (`available: false`): registered for discoverability but its
 *   engine does not exist yet. Per the build-order invariant we must NOT fake the
 *   capability (`detect_faces`, `generate_mask` depend on a dependency-gated CV
 *   engine). The orchestrator refuses to invoke these rather than fabricate a result.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
// Value imports: reuse the schema package's own Zod schemas for the rich caption
// style / crop rect / blend-mode edits, so the tool arguments can NEVER drift from
// the persisted data model they write (single source of truth, ADR 0045/0047/0048).
import type { AnyOperation } from '@framepilot/editor-core';

import type { ToolContext } from './tool-context.js';
import { toModelProject } from './model-view.js';
// Type-only import — erased at runtime, so no cycle with `tool-scope.ts` (which imports
// the `ToolSpec` type from here). These tag types live with the scoping logic.
import type { ToolCost, ToolLatency, ToolPermission } from './tool-scope.js';
import { AUDIO_TOOLS } from './domain-tools/audio.js';
import { COLOR_TOOLS } from './domain-tools/color.js';
import { MOTION_TOOLS } from './domain-tools/motion.js';
import { CAPTION_TOOLS } from './domain-tools/captions.js';
import { TIMELINE_TOOLS } from './domain-tools/timeline.js';
import { GRAPHICS_TOOLS } from './domain-tools/graphics.js';
import { MEDIA_TOOLS } from './domain-tools/media.js';
import { PROJECT_TOOLS } from './domain-tools/project.js';
import { VERIFICATION_TOOLS } from './domain-tools/verification.js';
import { TRACKING_MASK_TOOLS } from './domain-tools/tracking-mask.js';
import { boolean, filterString, numeric, seconds } from './domain-tools/tool-args.js';
import { analysisTool, askTool, noArgs, readTool } from './domain-tools/tool-factories.js';
// `tool-input-contract.ts` only imports the `ToolSpec`/`ToolParameterSchema` *types* from
// this module (also erased at runtime), so importing its runtime export here is safe.
import { withToolInputContract } from './tool-input-contract.js';
import { PROFESSIONAL_EDIT_TOOL } from './domain-tools/professional-edit.js';
import { PROFESSIONAL_MOTION_TOOL } from './domain-tools/professional-motion.js';
import { PROFESSIONAL_COLOR_TOOL } from './domain-tools/professional-color.js';
import { PROFESSIONAL_TRACKING_MASK_TOOL } from './domain-tools/professional-tracking-mask.js';
import { PROFESSIONAL_AUDIO_TOOL } from './domain-tools/professional-audio.js';

const log = createLogger('ai-sdk:tool-registry');

// ---------------------------------------------------------------------------
// Tool kinds
// ---------------------------------------------------------------------------

/**
 * How a tool executes — which is also *who* executes it.
 *
 * `ask` is its own class because it is the only tool whose answer comes from a **human**:
 * it runs neither in-process (`read`/`mutate`) nor on the engine sidecar
 * (`analysis`/`action`), but as a round trip to whatever UI is driving the run. That is
 * why it cannot be an `action` — those dispatch to the sidecar executor, and no sidecar
 * can answer a question about what the editor wants.
 */
export type ToolKind = 'read' | 'mutate' | 'action' | 'analysis' | 'ask' | 'unavailable';

/** Minimal JSON-Schema-like shape for a tool's parameters. */
export type ToolParameterSchema = Record<string, unknown>;

/**
 * One registered tool. `parse` validates untrusted args (throws `ZodError`).
 * `buildOps` is present only for available mutating tools; `read` only for read
 * tools. Both close over the tool's typed schema, erasing the generic so the
 * registry is a homogeneous list.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** True when the tool proposes a timeline patch rather than read-only data. */
  readonly mutates: boolean;
  /** False when the underlying engine capability does not exist yet. */
  readonly available: boolean;
  readonly kind: ToolKind;
  /** JSON Schema advertised to the model (derived from the Zod schema). */
  readonly parameters: ToolParameterSchema;
  /**
   * Optional registry metadata (K6.2). Additive and TS-only — never emitted in
   * {@link toolDescriptors}, so the MCP/Python descriptor parity is unaffected. When a
   * field is omitted it is *derived* from the tool's kind by `tool-scope.ts#toolMetadata`,
   * so existing tools need no annotation. Declaring them lets a tool refine its scope
   * (capability/permission tags for scoped descriptors) and cost/latency hints.
   */
  readonly version?: string;
  readonly capabilities?: readonly string[];
  readonly permissions?: readonly ToolPermission[];
  readonly cost?: ToolCost;
  readonly latency?: ToolLatency;
  /**
   * True when only FramePilot's own UI can serve this tool, so it is not part of the
   * MCP surface.
   *
   * `ask_user` is the case: it needs a human looking at the app. The MCP server has no
   * UI to render a question in and nobody to answer it — advertising it there would
   * promise a capability that surface does not have (ADR 0055). An external MCP client
   * is itself an agent with its own user; if it wants to ask something it asks them
   * directly and has no use for ours. Same reason it is absent from the Python registry:
   * the engine sidecar cannot ask anyone anything.
   */
  readonly hostUiOnly?: boolean;
  /**
   * Opt this tool OUT of concurrent execution even though its kind is normally
   * concurrency-safe (E1, plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md). For reads
   * whose execution is *stateful for the run* beyond the read memo — `load_skill` is
   * the case: it pins the playbook into the run's bounded skill ledger, and the
   * "already loaded / over the limit" answers depend on the order pins land.
   * Absent ⇒ concurrency is decided purely by {@link kind} (see {@link concurrencySafe}).
   */
  readonly serialOnly?: boolean;
  /** Validate untrusted tool arguments. Throws `ZodError` on mismatch. */
  parse(rawArgs: unknown): unknown;
  /**
   * Build operations from validated args (mutating + available only). Returns
   * timeline ops and/or project (asset/folder) ops — both are valid patch content.
   */
  readonly buildOps?: (rawArgs: unknown, ctx: ToolContext) => AnyOperation[];
  /** Read project data from context (read tools only). */
  readonly read?: (rawArgs: unknown, ctx: ToolContext) => unknown;
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

/** Duration of a clip on the timeline, or `undefined` if it is not present. */

/** Ground model-selected emphasis terms in the actual caption text/transcript. */

const recallEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    query: filterString(),
    // Character offset into the stored payload. Without it the tail of anything larger
    // than EVIDENCE_RECALL_CHARS was unreachable by any argument, so a run that needed
    // the end of a catalog or a clip list could only re-read the same head forever.
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Tool specs
//
// The spec builders these are written against now live in
// `domain-tools/tool-factories.ts`, so a domain family can own its tools without
// importing the registry it is composed into (P1.2).
// ---------------------------------------------------------------------------
// Read tools (PRD §8.3)
// ---------------------------------------------------------------------------

// `list_assets` filters (all optional): narrow the bin to one media `kind` and/or a
// single `folderId`. Mirrors the Python `ListAssetsArgs` so the schema-parity guard
// stays green.

const readTools: ToolSpec[] = [
  readTool(
    {
      name: 'get_project_state',
      description:
        'Return the current editable project state without editor-only undo history. This is the live state for the active session — read it here, not from project.fp.json on disk.',
    },
    noArgs,
    (_args, ctx) => toModelProject(ctx.project),
  ),
  readTool(
    {
      name: 'recall_evidence',
      description:
        'Re-open something you already read. Every read you make this run is filed under ' +
        'a short handle like [ev_3] shown next to it in your action log; pass that handle ' +
        'to get the full result back, optionally narrowed by a word or phrase. Use this ' +
        'instead of re-running the read — it is free, it cannot change under you, and it ' +
        'returns more of the payload than the log preview shows. A query matches on any ' +
        'of its words, so several keywords are fine. When a result says it was truncated ' +
        'at N characters, call again with offset N to read on from there.',
    },
    recallEvidenceSchema,
    // The store lives on the run's HostCallContext, not the ToolContext, so the agent
    // loop answers this call before the generic read path (see `runAgentCall`). This
    // body is the honest degraded answer for surfaces that have no store — never a lie
    // about what was recalled.
    () => ({ recalled: false, reason: 'No evidence store is attached to this run.' }),
  ),
  // -------------------------------------------------------------------------
  // Timeline mapping + verification (ADR 0076)
  //
  // These exist because the model used to do this arithmetic in its head. Asked
  // to caption an edited timeline, it would read the source transcript, reason
  // in prose about "source time minus segment source start plus segment timeline
  // start", and emit cue times from that. It is wrong the moment a clip has a
  // speed, a range is reused, a word straddles a cut, or the timeline changes
  // after the offsets were computed — and nothing detected it, because every
  // operation still returned success.
  //
  // So: the engine computes the mapping and the model reads it, and there are
  // tools that let a completion claim be checked instead of asserted.
  // -------------------------------------------------------------------------
  readTool(
    {
      name: 'load_skill',
      description:
        'Load the full instructions of a skill from the skills manifest in your ' +
        'context. Call it BEFORE starting work the skill covers, then follow the ' +
        'returned playbook. Returns { name, description, tools, body } or the list ' +
        'of valid names when the skill is unknown.',
      capabilities: ['skills'],
      // E1: pins into the run's ordered, bounded skill ledger — see ToolSpec.serialOnly.
      serialOnly: true,
    },
    z.object({ name: z.string() }).strict(),
    (a, ctx) => {
      const skill = ctx.skills?.get(a.name);
      if (skill) return skill;
      return {
        error: `Unknown skill "${a.name}".`,
        available: [...(ctx.skills?.keys() ?? [])],
      };
    },
  ),
];

// ---------------------------------------------------------------------------
// Mutating tools (PRD §8.3) — every one returns typed, reversible operations
// ---------------------------------------------------------------------------

// The agent chooses only the real project asset. Word timestamps are produced
// by the trusted host's ASR provider and never accepted from the model.

// ---------------------------------------------------------------------------
// Action tools + not-yet-available tools
// ---------------------------------------------------------------------------

// Analysis tools mirror the Python Pydantic args in
// engine/python/.../ai_tools/registry.py (AnalyzeSilenceArgs / DetectScenesArgs)
// — same field names, all optional, so the schema-parity guard stays green.

const getFrameSchema = z
  .object({
    // Timeline time, not source time: the model reasons about the edit, and every other
    // timing tool in this registry is timeline-relative too.
    timeSeconds: seconds,
    // Small default (see the engine's DEFAULT_MAX_DIMENSION): an image costs input
    // tokens in proportion to its pixels, and most framing/legibility questions are
    // answered at 512px. Raised only when the question is genuinely about fine detail.
    maxDimension: numeric(z.number().int().min(128).max(1280)).optional(),
    // Captions are burned in by default — soft captions are invisible in a still, and
    // "do the captions look right?" is the most common reason to look at one.
    burnCaptions: boolean().optional(),
  })
  .strict();
const sessionContextSchema = z.object({}).strict();
const analysisTools: ToolSpec[] = [
  analysisTool(
    {
      name: 'get_frame',
      description:
        'LOOK at the edit: render one frame of the timeline at a given time and see it as ' +
        'an image. Use it to CHECK your own work visually — caption placement and ' +
        'legibility, framing after a punch-in or reframe, whether a title collides with ' +
        'the footage, whether a grade reads as intended. Prefer it over guessing from ' +
        'numbers whenever the question is about how something LOOKS. It renders through ' +
        'the same engine as the final export, so what you see is what will be delivered. ' +
        'One frame per call, and each costs real context — grab the few moments that ' +
        'actually settle the question, not a sweep of the timeline.',
      capabilities: ['vision'],
    },
    getFrameSchema,
  ),
  analysisTool(
    {
      name: 'session_context',
      description:
        "Read what's already known about this project before doing anything else: the " +
        'media bin digest, what happened in the last session, the edits this user ' +
        'rejected (do not repeat them) and accepted, plus their cross-project working ' +
        'style. Use at the start of a session, or when you need to know what the user ' +
        'has already told us. Does not edit the timeline.',
    },
    sessionContextSchema,
  ),
];

/**
 * `ask_user` (P12) — the model's own question, in its own words.
 *
 * Nothing here is a fixed prompt: the model supplies the `question` and, when a choice
 * makes sense, its own `options`. The orchestration carries whatever it authors, so
 * situations nobody enumerated in advance ("this footage has no faces to track — what do
 * you want instead?") work the same as the ones we did. Omit `options` for a genuinely
 * open question and the editor types a free-text answer.
 *
 * Bounds are for the UI, not the vocabulary: a question long enough to scroll or a list
 * of ten choices is a worse question, not a richer one.
 */
const askOptionSchema = z
  .object({
    label: z.string().min(1).max(80),
    /** One line on what picking this means — shown under the label. */
    description: z.string().max(240).optional(),
  })
  .strict();

const askUserSchema = z
  .object({
    question: z.string().min(1).max(600),
    options: z.array(askOptionSchema).min(2).max(5).optional(),
  })
  .strict();

const askTools: ToolSpec[] = [
  askTool(
    {
      name: 'ask_user',
      description:
        'Ask the editor a question and wait for their answer. Use it when only they can ' +
        'settle something: the request is ambiguous, a capability you need does not exist ' +
        'so you must offer alternatives, you are about to do something large or hard to ' +
        'undo, or the answer depends on taste or on what they know about the footage. ' +
        'Write your own question and, when it is a choice, 2-5 concrete options (a short ' +
        'label each, plus a description when the consequence is not obvious); omit options ' +
        'to invite a free-text answer. Their answer comes back as the result and you ' +
        'continue from it. This tool is the ONLY way to ask: a question written into your ' +
        'reply text cannot be clicked or answered — this call renders your options as ' +
        'selectable choices and pauses until the editor picks. Ask instead of guessing ' +
        'when a wrong guess would waste their footage or their time — but never ask what ' +
        'a tool can tell you, and never ask twice about the same thing. Does not edit ' +
        'the timeline.',
    },
    askUserSchema,
  ),
];

/** Tool registry mirroring PRD §8.3. */
/**
 * The public manifest: one list, composed from the domain modules that own the specs.
 *
 * Order is organisational only. `toolDescriptors` sorts by name before serialising
 * — an explicit prompt-cache invariant — so nothing here can reach a provider.
 *
 * What remains declared in *this* file is the agent's session surface rather than
 * a domain: reading project state, re-opening an evidence handle, loading a skill,
 * grabbing a frame, and asking the human a question. Those are how a run works,
 * not what it edits, and there is no editing domain that owns them.
 */
export const TOOL_REGISTRY: readonly ToolSpec[] = [
  ...readTools,
  ...analysisTools,
  ...askTools,
  ...TIMELINE_TOOLS,
  ...MEDIA_TOOLS,
  ...MOTION_TOOLS,
  ...COLOR_TOOLS,
  ...TRACKING_MASK_TOOLS,
  ...AUDIO_TOOLS,
  ...CAPTION_TOOLS,
  ...GRAPHICS_TOOLS,
  ...PROJECT_TOOLS,
  ...VERIFICATION_TOOLS,
  // Resolver-gated professional intent, one module per domain.
  PROFESSIONAL_EDIT_TOOL,
  PROFESSIONAL_MOTION_TOOL,
  PROFESSIONAL_COLOR_TOOL,
  PROFESSIONAL_TRACKING_MASK_TOOL,
  PROFESSIONAL_AUDIO_TOOL,
];

/** Look up a tool spec by name. */
export const getTool = (name: string): ToolSpec | undefined => {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  if (!tool) log.warn('getTool → lookup missed', { name });
  return tool;
};

/**
 * May this call run concurrently with its neighbours in the same turn (E1,
 * plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md)?
 *
 * Safe by default only for `read`/`analysis` kinds — the two that never produce
 * operations, never advance the turn's speculative working copy, and whose per-run
 * memos (`readCache`/`hostCache`) are keyed per call and consulted before dispatch.
 * `mutate`/`action`/`ask`/`unavailable` are never safe: mutations thread the working
 * copy call-to-call, actions have host side effects, and an ask blocks on a human.
 * A per-tool {@link ToolSpec.serialOnly} opts a stateful read back out.
 *
 * `args` is validated against the tool's schema here; a parse failure — or anything
 * else this predicate throws — conservatively means **not** safe (the call still runs,
 * just serially, and fails its own card through the normal path).
 */
export function concurrencySafe(tool: ToolSpec, args: unknown): boolean {
  try {
    if (tool.serialOnly === true) return false;
    if (tool.kind !== 'read' && tool.kind !== 'analysis') return false;
    tool.parse(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tool descriptors (name + JSON Schema) advertised to a provider.
 *
 * Each entry is built through {@link withToolInputContract} — the same immutable,
 * per-tool wrapper `selectTools`/`selectAutonomousTools` (`tool-scope.ts`) apply — so a
 * provider always sees the relational/semantic schema tightening (e.g. `map_time`'s
 * one-domain `oneOf`, the `add_keyframes` property enum, `add_transition`'s
 * `discover_transitions` wording) instead of the raw registry entry. `TOOL_REGISTRY`
 * itself is never mutated; wrapping happens fresh on every call.
 *
 * Sorted by name — a deterministic byte order, not `localeCompare` (locale-dependent) —
 * so the serialized tool block is byte-identical across turns, runs, and registry
 * insertion-order refactors. Prompt-cache stability is an explicit invariant (E3.3,
 * plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md): the tool array is part of the
 * provider's cache-key prefix, and an order change silently voids every cached prefix.
 */
export const toolDescriptors = (
  filter?: (tool: ToolSpec) => boolean,
): { name: string; description: string; parameters: ToolParameterSchema }[] =>
  TOOL_REGISTRY.filter((t) => t.available && (filter ? filter(t) : true))
    .map(withToolInputContract)
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
    // Tool names are unique (registry shape test), so a two-way comparison suffices.
    .sort((a, b) => (a.name < b.name ? -1 : 1));
