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
import { timelineDurationSeconds } from '../state-block.js';

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
  return {
    durationSeconds: timelineDurationSeconds(project.timeline),
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

/**
 * How long the request says the FINISHED video must run, as the command reader read it.
 *
 * ## Why a model reads this, not a pattern
 *
 * It used to be `critic.ts#explicitDurationTarget`: anchor words ("best", "build",
 * "video", "duration" …) within forty characters of a number and a time unit. Every brief
 * that broke it got one more guard — `PER_UNIT_QUALIFIER` for "0.3–0.6s per clip", the
 * range reader for "20–35 seconds" — and the next brief broke it again. Run `6cb12e30`'s
 * brief said "Use only the best 2–4s of each" about SHOTS and "58–62s" about the master;
 * the anchor `best` read the first as a 3-second deliverable. That one misreading became
 * an acceptance criterion the run could not satisfy without deleting its own work: seven
 * "the request is not met yet" recoveries, a DO THIS NOW pinned to "the target is 3s" for
 * the rest of the run, a question to the editor whose answer ("Keep the 60s master")
 * nothing could apply to the criterion, and a run that ended failed after 95 correct edits.
 *
 * Telling a deliverable length from a pacing figure is reading comprehension, and this
 * call already reads the whole request. What stays deterministic is the part that must:
 * {@link statedAs} has to appear verbatim in the request, so a length the model invented
 * never becomes a criterion, and every criterion and finding built on it can say which
 * words it came from.
 */
export interface DeliverableLength {
  readonly seconds: number;
  /** Half-width of a stated range ("58–62s" → 60 ± 2); absent for a single length. */
  readonly toleranceSeconds?: number;
  /** The request's own words that state the length, verbatim. */
  readonly statedAs: string;
}

/** The classifier's validated verdict. */
export interface CommandClassification {
  readonly route: CommandRoute;
  /**
   * Present only for `route: 'chitchat'` — a short, friendly, one-or-two-sentence reply
   * used verbatim so a greeting costs exactly this one classification call and no more.
   */
  readonly reply?: string;
  /**
   * `edit` only: the 1-based position, in {@link ClassifierInput.earlierRequests}, of the
   * earlier request this message carries on — "load the tools and complete the task" names
   * no work of its own; the brief two turns up does. Absent for a new request.
   */
  readonly continues?: number;
  /** `edit` only: the finished length the request states, grounded in its own words. */
  readonly deliverableLength?: DeliverableLength;
}

/** Bounded input to the classifier — the full user text + a tiny header + the selection. */
export interface ClassifierInput {
  readonly userText: string;
  readonly header: ProjectHeader;
  readonly selection?: TimeRange;
  /** Whether the editor has a live selection ("this"/"here" resolve against it). */
  readonly hasSelection?: boolean;
  /**
   * The editor's earlier messages in this conversation, oldest first — see
   * {@link earlierRequestsFrom}. Shown so the reader can tell a continuation from a new
   * request and read the length of the work a continuation refers to.
   */
  readonly earlierRequests?: readonly string[];
}

/** The classifier's Zod schema. `route` is required; the rest are route-specific. */
export const CommandClassificationSchema = z.object({
  route: z.enum(['chitchat', 'question', 'edit']),
  reply: z.string().optional(),
  // Read separately below: a malformed reading must cost the reading, never the route.
  continues: z.unknown().optional(),
  length: z.unknown().optional(),
});

const StatedLengthSchema = z.object({
  seconds: z.number().finite().positive().optional(),
  min: z.number().finite().positive().optional(),
  max: z.number().finite().positive().optional(),
  quote: z.string().trim().min(1),
});

/** What {@link parseClassification} checks a reading against. */
export interface ClassificationGrounding {
  /** The message being classified. */
  readonly request: string;
  /** The same list, in the same order, that was shown as {@link ClassifierInput.earlierRequests}. */
  readonly earlierRequests?: readonly string[];
}

/** How many of the editor's earlier messages the reader is shown. */
const MAX_EARLIER_REQUESTS = 4;

/**
 * Character budget for the earlier messages together. Big enough for the long briefs
 * editors actually paste (run `6cb12e30`'s was 27,043 characters), bounded because this
 * call sits on every turn's critical path.
 */
const MAX_EARLIER_REQUEST_CHARS = 40_000;

/** One earlier message: what the reader is shown, and the whole message it stands for. */
export interface EarlierRequest {
  readonly shown: string;
  readonly full: string;
}

/**
 * The editor's earlier messages to show the reader, oldest first: the newest
 * {@link MAX_EARLIER_REQUESTS} within {@link MAX_EARLIER_REQUEST_CHARS}. A message that
 * does not fit whole is cut at the budget — its head is where a brief states its work, and
 * a quote from a cut-off tail simply fails grounding, which drops the reading rather than
 * inventing one. `full` keeps the whole message, so a continuation's objective is the
 * request itself, never the reader's excerpt of it.
 */
export function earlierRequestsFrom(
  history: readonly { readonly role: string; readonly content: string }[] | undefined,
): EarlierRequest[] {
  const kept: EarlierRequest[] = [];
  let budget = MAX_EARLIER_REQUEST_CHARS;
  const users = (history ?? []).filter(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  );
  for (let index = users.length - 1; index >= 0 && kept.length < MAX_EARLIER_REQUESTS; index -= 1) {
    if (budget <= 0) break;
    const full = users[index]!.content.trim();
    kept.unshift({ shown: full.length <= budget ? full : full.slice(0, budget), full });
    budget -= full.length;
  }
  return kept;
}

/**
 * Text as a quote is compared against it: case, whitespace runs, dash and quote-mark
 * variants folded. A model copying "58–62s" as "58-62s" has still quoted the request.
 */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A stated length, if its shape is one number or a real range and its quote is the request's. */
function groundedLength(
  raw: unknown,
  sources: readonly string[],
): DeliverableLength | undefined {
  const parsed = StatedLengthSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { seconds, min, max, quote } = parsed.data;
  const wanted = comparable(quote);
  if (!sources.some((source) => comparable(source).includes(wanted))) return undefined;
  if (min !== undefined && max !== undefined && max > min) {
    return { seconds: (min + max) / 2, toleranceSeconds: (max - min) / 2, statedAs: quote.trim() };
  }
  return seconds === undefined ? undefined : { seconds, statedAs: quote.trim() };
}

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
  const earlier = input.earlierRequests ?? [];
  if (earlier.length > 0) {
    lines.push('Earlier requests in this conversation (oldest first):');
    earlier.forEach((text, index) => lines.push(`[${String(index + 1)}] ${text}`));
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
 *
 * The `edit` readings are kept only when they check out against `grounding`: a
 * `continues` must name a request that was shown, and a length's quote must appear in the
 * message or in the request it continues. Without `grounding` nothing can be checked, so
 * neither reading is kept — a missing criterion costs a check, a wrong one fails a run
 * that did the work.
 */
export function parseClassification(
  raw: string,
  grounding?: ClassificationGrounding,
): CommandClassification | null {
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
  if (route !== 'edit' || grounding === undefined) return { route };
  const earlier = grounding.earlierRequests ?? [];
  const continues =
    typeof parsed.data.continues === 'number' &&
    Number.isInteger(parsed.data.continues) &&
    parsed.data.continues >= 1 &&
    parsed.data.continues <= earlier.length
      ? parsed.data.continues
      : undefined;
  const sources = [grounding.request, ...(continues === undefined ? [] : [earlier[continues - 1]!])];
  const deliverableLength = groundedLength(parsed.data.length, sources);
  return {
    route,
    ...(continues === undefined ? {} : { continues }),
    ...(deliverableLength === undefined ? {} : { deliverableLength }),
  };
}

/** Strip a ```json code fence a model may wrap structured output in (mirrors proposers). */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  // Plain slicing, not a `\s*([\s\S]*?)\s*` regex: that shape is catastrophically
  // backtracking on unclosed fences padded with whitespace (model output is
  // untrusted length/content), and adds nothing a fixed-anchor match doesn't.
  const open = /^```(?:json)?\s*/.exec(trimmed);
  if (!open || !trimmed.endsWith('```')) return trimmed;
  return trimmed.slice(open[0].length, -3).trim();
}

/** The safe fallback when classification is unavailable or unparseable: treat as an edit. */
export const FALLBACK_CLASSIFICATION: CommandClassification = { route: 'edit' };

/** Whether a request is about one place on the timeline, or about the whole recording. */
export type RequestScope = 'local' | 'global';

/**
 * Words that mean "across the whole thing". Deliberately about SCOPE, not about the
 * operation: "find" and "best" are here because they are how an editor asks you to search
 * material, and searching a recording you can only see 1% of is the failure this ends.
 */
const GLOBAL_SCOPE_WORDS: readonly RegExp[] = [
  /\bwhole\b/i,
  /\bentire\b/i,
  /\bthroughout\b/i,
  /\ball (?:of )?(?:the )?(?:clips?|footage|dialogue|recording|video)\b/i,
  /\bevery\b/i,
  /\banywhere\b/i,
  /\bacross\b/i,
  /\bbest\b/i,
  /\bstrongest\b/i,
  /\bhighlights?\b/i,
  /\bfind\b/i,
  /\bsearch\b/i,
  /\bhooks?\b/i,
  /\bsummar(?:y|ize|ise)\b/i,
  /\breel\b/i,
  /\bshort\b/i,
  /\bmontage\b/i,
];

/** Words that point at one place. Only consulted when nothing is selected (rule 3). */
const LOCAL_SCOPE_WORDS: readonly RegExp[] = [
  /\bthis (?:clip|cut|shot|bit|part|moment|section|transition)\b/i,
  /\bthat (?:clip|cut|shot|bit|part|moment|section|transition)\b/i,
  /\bhere\b/i,
  /\bright (?:here|there)\b/i,
  /\bat the playhead\b/i,
  /\bthe selection\b/i,
  /\bselected\b/i,
];

/**
 * Whether a request is about ONE PLACE on the timeline or about the whole recording
 * (context-management P2.2).
 *
 * Retrieval used to have exactly one query — "near the playhead" — and it always
 * NARROWED: a 30-second selection took a 60-minute project's context from 24 clips and
 * 600 words to 11 and 97. That is correct for *"tighten this"*. It is wrong for *"find
 * the strongest hook in this recording"*, where the selection actively hurts, and there
 * was no path by which a request could widen the view at all.
 *
 * This is a deterministic, inspectable reading of the request text — NOT a model call.
 * It lives beside {@link parseClassification} because command shape has one home, but it
 * is pure by necessity: `assembleContext` is pure and cacheable, and a retrieval decision
 * that required a network round trip could not sit inside it.
 *
 * The precedence is declared rather than emergent, and a wrong guess costs relevance,
 * never access (the ranker may reorder within the room; it may not reduce coverage):
 *
 * 1. **An explicit whole-project word wins, even over a live selection.** Someone who
 *    says "the whole recording" while a clip happens to be selected means the recording.
 * 2. **Otherwise a selection means local.** They pointed at something.
 * 3. **Otherwise an explicit pointing word means local** — "this", "here", "that cut".
 * 4. **Otherwise global.** With nothing selected and nothing pointed at, the request is
 *    about the project: "add captions" and "cut this to 45 seconds" both are.
 *
 * @param userPrompt - The editor's own words for this turn.
 * @param hasSelection - Whether a timeline range is selected.
 */
export function requestScopeOf(userPrompt: string, hasSelection: boolean): RequestScope {
  const text = userPrompt ?? '';
  if (GLOBAL_SCOPE_WORDS.some((pattern) => pattern.test(text))) return 'global';
  if (hasSelection) return 'local';
  if (LOCAL_SCOPE_WORDS.some((pattern) => pattern.test(text))) return 'local';
  return 'global';
}
