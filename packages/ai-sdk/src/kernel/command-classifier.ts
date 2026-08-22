/**
 * @framepilot/ai-sdk/kernel/command-classifier — the model-based command classifier.
 *
 * ## Why a model, not a keyword table
 *
 * The original {@link ./router.ts} `routeCommand` was a pure keyword classifier
 * (topic-regex × action-regex). It had two structural failure modes that no amount of
 * extra regexes could fix without becoming brittle:
 *
 *  1. **Greedy template hijack.** A command that merely *mentioned* a template's topic and
 *     an action word ("add an **intro** with advanced keyframes") was force-routed to that
 *     template (`add_hook`), even though it could not do what was asked. It ran, produced
 *     nothing applicable, and the user saw "No changes were made… Instant · no AI needed" —
 *     the real request (keyframes, professional polish) was never even read. The templates
 *     themselves are now gone too; only the agent loop executes edits.
 *  2. **No small-talk route.** Anything that wasn't a template or a `?`-question fell
 *     through to full planning, so a bare "hi" triggered the whole agent/planner.
 *
 * This classifier replaces the keyword table with ONE small model call that reads the
 * *entire* request plus a tiny project header and returns a {@link CommandClassification}.
 * It is deliberately cheap (a tight system prompt, a bounded JSON reply) and honest: it
 * routes every real edit to `edit` (the agent loop), including edits that must acquire
 * analysis evidence first. See ADR 0055 and ADR 0126.
 *
 * The module is pure and stateless: {@link buildClassifierMessages} describes the model call
 * as inert data and {@link parseClassification} validates the reply. {@link Orchestrator}
 * owns the actual `provider.complete` call and the dispatch (`streamAuto`).
 */
import { z } from 'zod/v4';
import type { Project } from '@framepilot/timeline-schema';
import type { TargetPlatform } from '../context-builder.js';
import { classifierSystemPrompt } from '../prompts.js';
import type { AiMessage } from '../providers/types.js';
import type { TimeRange } from './semantic-index/semantic-index.js';

/**
 * A **tiny** project header — the only project context the classifier sees. Never the
 * timeline itself: routing needs the SHAPE of the project (how long, what aspect, how many
 * layers, which platform), not its clip JSON.
 *
 * This lived in the planner path's `proposers/intent-parser.ts` until the 9.5 convergence
 * retired that path (ADR 0126). The classifier was its only surviving consumer, so it moved
 * here rather than leaving a one-type module behind as the last trace of a deleted runtime.
 */
export interface ProjectHeader {
  readonly durationSeconds: number;
  readonly resolution: { readonly width: number; readonly height: number };
  readonly layerCount: number;
  readonly platform?: TargetPlatform;
}

/** Derive the tiny {@link ProjectHeader} from a project (pure). */
export function projectHeaderOf(project: Project, platform?: TargetPlatform): ProjectHeader {
  let end = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.end > end) end = clip.end;
    }
  }
  return {
    durationSeconds: end,
    resolution: { width: project.resolution.width, height: project.resolution.height },
    layerCount: project.timeline.tracks.length,
    ...(platform !== undefined ? { platform } : {}),
  };
}

/**
 * The three routes a command can take. Kept intentionally small — one route per genuinely
 * distinct execution path the Orchestrator can dispatch:
 *
 *  - `chitchat` — a greeting / thanks / off-topic remark. Answered with a short direct
 *    reply and ZERO editing work (never triggers a plan or a self-check).
 *  - `question` — a read-only question about the project ("why does this drag?", "what is
 *    on screen at 13s?"). Answered by the chat path; never mutates the timeline. It can
 *    still LOOK — render frames, search footage — because looking changes nothing.
 *  - `edit`     — EVERY real editing request, from a single trim to novel/creative/
 *    multi-step work, including work that must acquire analysis evidence before it can
 *    propose operations. Runs the agent loop.
 *
 * Two routes have been removed as the execution paths behind them were retired.
 *
 * `recipe` was a request a fixed deterministic template fully satisfied, run with zero model
 * calls. A template can only ever match the request it was written for, and the router's job
 * was to decide when it matched — so a request it matched only partly ("add an intro WITH
 * KEYFRAMES") ran the template, changed nothing the user asked for, and reported "no
 * changes, no AI needed" as if that were a success.
 *
 * `planned_edit` selected a second mutating execution universe (intent parser → planner →
 * compiled task graph → graph/effect runtime) for edits that had to detect beats or scenes
 * before proposing operations. Phase 1 of the 9.5 convergence measured both routes on the
 * same goals and found no capability the agent loop lacked, no model-call saving, and one
 * safety gap unique to the planner path — so the route, and the runtime behind it, are gone.
 * Evidence: `docs/architecture/FRAMEPILOT-95-ROUTE-PARITY-EVIDENCE.md`. Analysis-dependent
 * edits are now plain `edit` work: the agent calls `detect_beats`/`detect_scenes`/
 * `analyze_silence` and then mutates, through one validated boundary.
 */
export type CommandRoute = 'chitchat' | 'question' | 'edit';

/** The classifier's validated verdict. */
export interface CommandClassification {
  readonly route: CommandRoute;
  /**
   * Present only for `route: 'chitchat'` — a short, friendly, one-or-two-sentence reply
   * used verbatim so a greeting costs exactly this one classification call and no more.
   */
  readonly reply?: string;
}

/** Bounded input to the classifier — the full user text + a tiny header + the selection. */
export interface ClassifierInput {
  readonly userText: string;
  readonly header: ProjectHeader;
  readonly selection?: TimeRange;
  /** Whether the editor has a live selection ("this"/"here" resolve against it). */
  readonly hasSelection?: boolean;
}

/** The classifier's Zod schema. `route` is required; the rest are route-specific. */
export const CommandClassificationSchema = z.object({
  route: z.enum(['chitchat', 'question', 'edit']),
  reply: z.string().optional(),
});

// The prompt text lives in prompts.ts — the single home for model-facing prompts.
const SYSTEM = classifierSystemPrompt();

/** Render the bounded input as the user turn (tiny header + selection + request). */
function renderInput(input: ClassifierInput): string {
  const { header, selection, userText, hasSelection } = input;
  const lines = [
    `Project: ${String(header.resolution.width)}x${String(header.resolution.height)}, ` +
      `${header.durationSeconds.toFixed(2)}s, ${String(header.layerCount)} layer(s)` +
      (header.platform ? `, platform ${header.platform}` : ''),
  ];
  if (selection) {
    lines.push(`Selection: ${selection.start.toFixed(2)}s–${selection.end.toFixed(2)}s`);
  } else if (hasSelection) {
    lines.push('Selection: (a live selection exists)');
  }
  lines.push(`Request: ${userText}`);
  return lines.join('\n');
}

/** Build the inert model call (system + one user turn) for a classification. */
export function buildClassifierMessages(input: ClassifierInput): readonly AiMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: renderInput(input) },
  ];
}

/**
 * Validate a model reply into a {@link CommandClassification}, normalizing route-specific
 * fields so a downstream dispatch can trust the shape: `reply` is kept only on a
 * `chitchat` route and dropped everywhere else.
 *
 * Returns `null` when the reply is not parseable JSON or fails the schema — the caller
 * ({@link Orchestrator.streamAuto}) then falls back to the safe default (`edit`), never a
 * crash (§16.3: a bad classification is data, not an exception).
 */
export function parseClassification(raw: string): CommandClassification | null {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(raw));
  } catch {
    return null;
  }
  const parsed = CommandClassificationSchema.safeParse(json);
  if (!parsed.success) return null;
  const { route, reply } = parsed.data;

  if (route === 'chitchat') {
    return reply ? { route: 'chitchat', reply } : { route: 'chitchat' };
  }
  return { route };
}

/** Strip a ```json code fence a model may wrap structured output in (mirrors proposers). */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/** The safe fallback when classification is unavailable or unparseable: treat as an edit. */
export const FALLBACK_CLASSIFICATION: CommandClassification = { route: 'edit' };
