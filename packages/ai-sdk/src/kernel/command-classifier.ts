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
 * chooses `planned_edit` when an edit depends on analysis evidence before mutation
 * (notably beat synchronization), and otherwise routes a real edit to `edit` (the agent
 * loop). See ADR 0055.
 *
 * The module is pure and stateless: {@link buildClassifierMessages} describes the model call
 * as inert data and {@link parseClassification} validates the reply. {@link Orchestrator}
 * owns the actual `provider.complete` call and the dispatch (`streamAuto`).
 */
import { z } from 'zod/v4';
import { classifierSystemPrompt } from '../prompts.js';
import type { AiMessage } from '../providers/types.js';
import { type ProjectHeader } from './proposers/intent-parser.js';
import type { TimeRange } from './semantic-index/semantic-index.js';

/**
 * The four routes a command can take. Kept intentionally small — one route per genuinely
 * distinct execution path the Orchestrator can dispatch:
 *
 *  - `chitchat` — a greeting / thanks / off-topic remark. Answered with a short direct
 *    reply and ZERO editing work (never triggers a plan or a self-check).
 *  - `question` — a read-only question about the project ("why does this drag?", "what is
 *    on screen at 13s?"). Answered by the chat path; never mutates the timeline. It can
 *    still LOOK — render frames, search footage — because looking changes nothing.
 *  - `planned_edit` — an edit that must acquire analysis evidence before proposing typed
 *    operations (for example detecting beats/scenes before assembling a montage).
 *  - `edit`     — any other real editing request, including novel/creative/multi-step work
 *    ("add an intro with keyframes and make it professional"). Runs the agent loop.
 *
 * There used to be a fifth, `recipe`: a request a fixed deterministic template fully
 * satisfied, run with zero model calls. It was removed. A template can only ever match the
 * request it was written for, and the router's job was to decide when it matched — so a
 * request it matched only partly ("add an intro WITH KEYFRAMES") ran the template, changed
 * nothing the user asked for, and reported "no changes, no AI needed" as if that were a
 * success. The agent loop does the same work from the actual request.
 */
export type CommandRoute = 'chitchat' | 'question' | 'planned_edit' | 'edit';

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
  route: z.enum(['chitchat', 'question', 'planned_edit', 'edit']),
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
