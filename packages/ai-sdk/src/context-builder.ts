/**
 * @framepilot/ai-sdk/context-builder — assembles model context (PRD §8.2).
 *
 * Gathers the system contract, a compact timeline summary, the transcript, the
 * current selection, the target platform, and learned project memory into the
 * ordered messages handed to a provider. Kept pure and deterministic so the same
 * project + prompt always produce the same context (testable, cacheable).
 */
import { createLogger, type Seconds } from '@framepilot/shared-types';
import type { Clip, Project, Timeline } from '@framepilot/timeline-schema';
import type { AiMessage } from './providers/types.js';
import type { ContextBudget, ContextTier } from './reliability/types.js';
import { readMemory } from './memory-store.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { summarizeScopedMemory } from './scoped-memory.js';
import { type Skill, summarizeSkillsManifest } from './skills.js';
import type { UserMemory } from './user-memory.js';
import { indexFor } from './project-index.js';
import {
  summarizeEditorInteraction,
  type EditorInteractionContext,
} from './editor-context/interaction-context.js';

const log = createLogger('ai-sdk:context-builder');

export type TargetPlatform = 'reels' | 'tiktok' | 'shorts' | 'linkedin' | 'x';

/**
 * A timeline clip or project asset the user explicitly pinned as extra context via
 * the composer's "@" picker (P8.7 narrow slice), independent of the auto-derived
 * selection chip. `label` is the display string computed at pin time (composer
 * side) so the prompt block stays a pure projection of what the chip already shows.
 */
export interface PinnedEntity {
  readonly kind: 'clip' | 'asset';
  readonly id: string;
  readonly label: string;
}

export interface ContextInput {
  readonly project: Project;
  /** Current host authority revision; distinct from the timeline's structural revision. */
  readonly projectRevision?: number;
  readonly userPrompt: string;
  /** Live, ephemeral editor state captured at turn submission. */
  readonly interaction?: EditorInteractionContext;
  readonly selection?: { readonly start: Seconds; readonly end: Seconds };
  readonly targetPlatform?: TargetPlatform;
  /**
   * Clips/assets the user pinned as extra context (P8.7 narrow slice), beyond the
   * auto-derived `selection`. Surfaced as its own "Pinned context" prompt block
   * (see {@link assembleContext}). Browser-only for now — `DesktopAiSession` does not
   * thread this over IPC yet (an explicit, documented gap; see `AiSessionInput.pinned`
   * in `apps/web-editor/src/editor/ai.ts`), mirroring the `variations`/`planned-edit`
   * precedent. Deferred: `@range`/`@marker`/`@track` entity kinds (P8.7 full scope).
   */
  readonly pinned?: readonly PinnedEntity[];
  /**
   * Prior conversation turns (oldest→newest), so multi-turn requests are coherent:
   * "make *it* shorter" / "undo that and try again" can resolve their referent
   * (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R2 B1). Only the most-recent window is
   * threaded; the caller maps the conversation store's user/assistant messages here.
   */
  readonly history?: readonly AiMessage[];
  /**
   * The user's cross-project memory scope (redesign §16.1, K5.1). When present its
   * editorial defaults fill any preference the *project* memory leaves blank (project
   * wins — see `scoped-memory.ts`); when omitted, only project memory is injected.
   */
  readonly userMemory?: UserMemory;
  /**
   * Token budget for the assembled context (R2 B2). When the full context would
   * exceed it, the lowest-priority tiers are dropped first (transcript → timeline →
   * skills → memory → history → selection). Defaults to {@link DEFAULT_CONTEXT_BUDGET}.
   */
  readonly budget?: ContextBudget;
  /**
   * Skills to advertise as a compact manifest tier (ADR 0057): name + description +
   * tools per skill, with bodies fetched on demand via the `load_skill` tool. The
   * orchestrator's agent paths default this to {@link BUNDLED_SKILLS}; other modes
   * include it only when the caller opts in.
   */
  readonly skills?: readonly Skill[];
  /**
   * A pre-rendered digest of the project's narrative memory — recent corrections,
   * decisions, the last session's note, the user's cross-project style (plan B6.3).
   * Hosts build it with `summarizeSessionContext` (brain-client.ts) from the
   * sidecar's `/brain/session-context`; absent (browser build, no sidecar, nothing
   * learned yet) the block is simply not injected.
   *
   * Injected in the droppable `memory` tier, NOT as a mandatory block: it is the
   * narrative "what we've learned" layer, so under budget pressure it yields to the
   * timeline/transcript the request is actually about. Bound it before passing —
   * `assembleContext` drops tiers whole, it does not summarize them.
   */
  readonly sessionContext?: string;
  /**
   * The one-line visual-index status (plan MI6.2): coverage, vector count, and backend,
   * or the honest reason the model cannot see the footage (no key, not indexed, no
   * sidecar). Hosts build it with `summarizeVisualStatus` (brain-client.ts) from the
   * sidecar's `/brain/visual/status`; absent (browser build, no sidecar) the block is
   * simply not injected — the visual tools still degrade honestly when called.
   *
   * Rides the `timeline` tier: it is factual project state about the media the visual
   * tools act on, so it drops with the timeline under budget pressure (safe — the tools
   * report their own availability when invoked).
   */
  readonly visualStatus?: string;
  /**
   * A pre-rendered, compact chapter-segmented digest of the footage map (plan FI3.3):
   * chapters (t0–t1, title, one-line summary) and the top highlights, in time order,
   * bounded to a token budget. Hosts build it with `summarizeFootageMap` (footage-map.ts)
   * from the sidecar's `/brain/visual/footage-map`; absent (browser build, no sidecar,
   * not indexed, or no generative understanding) the block is simply not injected — the
   * `map_footage` tool still degrades honestly when called.
   *
   * Rides the `timeline` tier next to the visual status: it is the structural "what is
   * IN the footage, in order" map the model reasons over before planning an edit on long
   * or unfamiliar material. Long footage is summarized hierarchically here (chapters, top
   * highlights) — detail is retrieved on demand via describe_footage / search_visual,
   * never dumped. Drops with the timeline under budget pressure.
   */
  readonly footageMap?: string;
}

/** How many transcript words to include before truncating (keeps prompts bounded). */
const MAX_TRANSCRIPT_WORDS = 600;

/**
 * K2.2 slice bounds. `MAX_CLIPS_PER_LAYER` caps an unfocused layer's clip listing so a
 * 10k-clip timeline still renders a bounded slice; `TRANSCRIPT_FOCUS_PAD` is the
 * lead-in/out (seconds) included around a focus range when slicing the transcript, so a
 * word straddling the edge of the selection is not lost.
 */
export const MAX_CLIPS_PER_LAYER = 12;
const TRANSCRIPT_FOCUS_PAD = 2;

/** Most-recent prior turns threaded into context (keeps the prompt bounded). */
export const MAX_HISTORY_MESSAGES = 8;

/**
 * The bounded, most-recent window of prior user/assistant turns to thread into
 * context. System/tool roles are dropped (the current system contract is authoritative);
 * empty-content turns are skipped. Pure + deterministic.
 */
export function boundedHistory(
  history: readonly AiMessage[] | undefined,
  max: number = MAX_HISTORY_MESSAGES,
): AiMessage[] {
  if (!history || history.length === 0) return [];
  return history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .slice(-max);
}

// The shared system contract lives in prompts.ts (the single home for every
// model-facing prompt); re-exported here so existing importers keep working.
export { SYSTEM_PROMPT } from './prompts.js';

const round = (n: number): string => (Math.round(n * 1000) / 1000).toString();

// Synthetic asset ids for clips with no media source (Phase 2, ADR 0032). A clip's
// kind is derived from its content, never from its layer — layers are type-agnostic.
const TEXT_OVERLAY_ASSET_ID = '__text__';
const CAPTION_ASSET_ID = '__caption__';

/** Derive a clip's kind from its asset (or synthetic id). Mirrors the engine. */
function deriveClipKind(clip: Clip, assetKinds: ReadonlyMap<string, string | undefined>): string {
  if (clip.assetId === TEXT_OVERLAY_ASSET_ID) return 'text';
  if (clip.assetId === CAPTION_ASSET_ID) return 'caption';
  const kind = assetKinds.get(clip.assetId);
  if (kind === 'audio') return 'audio';
  if (kind === 'image') return 'image';
  return 'video';
}

/** The dominant kind of a layer's clips (by count), or 'empty'. */
function layerKindLabel(
  clips: readonly Clip[],
  assetKinds: ReadonlyMap<string, string | undefined>,
): string {
  if (clips.length === 0) return 'empty';
  const counts = new Map<string, number>();
  for (const clip of clips) {
    const kind = deriveClipKind(clip, assetKinds);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** A time range the summary should zoom in on (R2 B3). */
export interface FocusRange {
  readonly start: Seconds;
  readonly end: Seconds;
}

/**
 * Select the clips a scoped summary shows in full (R2 B3): the clips overlapping the
 * focus range plus their immediate neighbours. When nothing overlaps (the focus sits
 * in a gap), the clips bounding that gap are chosen. Returns the set of clip ids to
 * render in detail; everything else is collapsed to a count/span. Pure + deterministic.
 */
export function focusedClipIds(clips: readonly Clip[], focus: FocusRange): Set<string> {
  const sorted = [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const overlaps = (c: Clip): boolean => c.start < focus.end && c.end > focus.start;
  const overlapIndices = sorted.map((c, i) => (overlaps(c) ? i : -1)).filter((i) => i >= 0);
  const ids = new Set<string>();
  if (overlapIndices.length > 0) {
    const first = overlapIndices[0]!;
    const last = overlapIndices[overlapIndices.length - 1]!;
    for (let i = Math.max(0, first - 1); i <= Math.min(sorted.length - 1, last + 1); i += 1) {
      ids.add(sorted[i]!.id);
    }
  } else {
    // Focus is in a gap/outside: include the clip ending before it and starting after it.
    const before = [...sorted].reverse().find((c) => c.end <= focus.start);
    const after = sorted.find((c) => c.start >= focus.end);
    if (before) ids.add(before.id);
    if (after) ids.add(after.id);
  }
  return ids;
}

/** The span (start→end) covering a set of clips. Callers guarantee `clips` is non-empty. */
function clipsSpan(clips: readonly Clip[]): { start: number; end: number } {
  return clips.reduce(
    (acc, c) => ({ start: Math.min(acc.start, c.start), end: Math.max(acc.end, c.end) }),
    { start: Infinity, end: 0 },
  );
}

/**
 * Render a track's clip list, scoping to `focus` when given (B3) and otherwise bounding
 * the listing to `maxClips` (K2.2): a huge unfocused layer shows its first `maxClips`
 * clips and collapses the rest to a count/span, so the context slice stays bounded
 * (O(slice) tokens) instead of growing with the whole timeline.
 */
function renderTrackClips(
  clips: readonly Clip[],
  focus?: FocusRange,
  maxClips: number = Infinity,
): string {
  const inFull = (c: Clip): string => `${c.id}[${round(c.start)}–${round(c.end)}s]`;
  if (!focus) {
    if (clips.length <= maxClips) return clips.map(inFull).join(', ');
    const shown = clips.slice(0, maxClips);
    const omitted = clips.slice(maxClips);
    const span = clipsSpan(omitted);
    return `${shown.map(inFull).join(', ')}, …(+${omitted.length} more clip(s) over ${round(span.start)}–${round(span.end)}s)`;
  }
  const focusIds = focusedClipIds(clips, focus);
  const shown = clips.filter((c) => focusIds.has(c.id));
  const omitted = clips.filter((c) => !focusIds.has(c.id));
  const shownStr = shown.map(inFull).join(', ');
  if (omitted.length === 0) return shownStr;
  const span = clipsSpan(omitted);
  const more = `…(+${omitted.length} more clip(s) over ${round(span.start)}–${round(span.end)}s, outside the focus)`;
  // When any clip is omitted, at least one is always shown (focusedClipIds returns an
  // overlapping clip or a bounding neighbour whenever clips exist), so `shownStr` is
  // guaranteed non-empty here — no empty-prefix case to guard.
  return `${shownStr}, ${more}`;
}

/**
 * One-line-per-layer summary of the timeline (counts + spans, not full JSON).
 *
 * Layers are type-agnostic (Phase 2, ADR 0032): each is described by its **z-order**
 * — index 0 is the visual front, compositing runs front→back — and by the kind of
 * clips it actually holds, not a fixed track type. Passing `assetKinds` lets the
 * summary name media kinds (video/audio/image); without it, only text/caption (which
 * need no asset) are distinguished.
 *
 * When `focus` is given (R2 B3, a selection/target range), each layer shows the clips
 * overlapping the range plus their immediate neighbours in full and collapses the rest
 * to a count/span — so a huge timeline stays relevant and bounded around the request.
 * When no focus is given, `maxClipsPerLayer` (K2.2) bounds each layer's listing so the
 * slice never grows unboundedly with the timeline; overflow collapses to a count/span.
 */
export function summarizeTimeline(
  timeline: Timeline,
  assetKinds: ReadonlyMap<string, string | undefined> = new Map(),
  focus?: FocusRange,
  maxClipsPerLayer: number = Infinity,
): string {
  if (timeline.tracks.length === 0) return 'Timeline: (empty)';
  const count = timeline.tracks.length;
  const lines = timeline.tracks.map((track, i) => {
    const z = i === 0 ? 'front' : i === count - 1 ? 'back' : 'mid';
    const kind = layerKindLabel(track.clips, assetKinds);
    const head = `- Layer ${i + 1}/${count} (${z}, ${kind}) "${track.id}"`;
    if (track.clips.length === 0) return `${head}: empty`;
    const span = clipsSpan(track.clips);
    const clips = renderTrackClips(track.clips, focus, maxClipsPerLayer);
    return `${head} (${track.clips.length} clip(s), ${round(span.start)}–${round(span.end)}s): ${clips}`;
  });
  const heading = focus
    ? `Timeline (focused on ${round(focus.start)}–${round(focus.end)}s; layers front→back):`
    : 'Timeline (layers front→back; index 0 renders on top):';
  return [heading, ...lines].join('\n');
}

/**
 * Transcript as plain text.
 *
 * Without `focus`: the head of the transcript, truncated to {@link MAX_TRANSCRIPT_WORDS}
 * to keep the prompt bounded.
 *
 * With `focus` (K2.2): a **relevance slice** — the words spoken within the focus range
 * (± {@link TRANSCRIPT_FOCUS_PAD} seconds of lead-in/out), not the transcript head.
 * This turns "ship the first 600 words" into "ship what is actually being talked about
 * around the edit," and stays bounded even for one long unbroken monologue (word-level,
 * so it narrows regardless of utterance segmentation).
 */
export function summarizeTranscript(project: Project, focus?: FocusRange): string {
  if (project.transcript.length === 0) return 'Transcript: (none)';
  if (!focus) {
    const words = project.transcript.slice(0, MAX_TRANSCRIPT_WORDS).map((w) => w.word);
    const suffix = project.transcript.length > MAX_TRANSCRIPT_WORDS ? ' …(truncated)' : '';
    return `Transcript:\n${words.join(' ')}${suffix}`;
  }
  const from = focus.start - TRANSCRIPT_FOCUS_PAD;
  const to = focus.end + TRANSCRIPT_FOCUS_PAD;
  const inWindow = project.transcript.filter((w) => w.start < to && w.end > from);
  const label = `Transcript (focused on ${round(focus.start)}–${round(focus.end)}s):`;
  if (inWindow.length === 0) return `${label} (no dialogue in range)`;
  return `${label}\n${inWindow.map((w) => w.word).join(' ')}`;
}

/**
 * Render the "Pinned context" prompt block for user-pinned clips/assets (P8.7).
 * Empty input renders nothing — callers only push this tier when `pinned` is
 * non-empty, so an empty pin list never claims context the model doesn't get.
 */
export function summarizePinned(pinned: readonly PinnedEntity[]): string {
  const lines = pinned.map((p) => `- [${p.kind}] ${p.label} (id: ${p.id})`);
  return ['Pinned context (user-selected, in addition to any selection above):', ...lines].join(
    '\n',
  );
}

/**
 * Rough token estimate for budgeting (R2 B2). Uses the standard ≈4-chars-per-token
 * heuristic — deliberately dependency-free; an exact tokenizer is a §7-gated upgrade.
 * Conservative headroom in {@link ContextBudget} absorbs the heuristic's drift.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Default budget. Generous on purpose: small/medium projects never trim (behaviour
 * unchanged), so the budgeter is a safety net that only engages for very large
 * timelines/transcripts. Callers can pass a tighter `budget` on {@link ContextInput}.
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  contextWindow: 190_000,
  maxOutputTokens: 4096,
  headroom: 2000,
};

/** The room the assembled prompt may occupy = window − reserved output − headroom. */
export function budgetTokens(budget: ContextBudget): number {
  return Math.max(0, budget.contextWindow - budget.maxOutputTokens - budget.headroom);
}

/**
 * A context block tagged with the tier it belongs to (for priority dropping) and a
 * stable `label` naming what it actually is. Several blocks share a tier — the visual
 * status, the footage map and the timeline summary are all `timeline` — so the tier
 * alone cannot answer "what is taking up the room"; the label can (ADR 0080).
 */
interface TieredBlock {
  readonly tier: ContextTier;
  readonly label: string;
  readonly text: string;
}

/**
 * Priority order in which tiers are DROPPED to fit the budget — lowest value first.
 * Mirrors `CONTEXT_TIERS` (system > prompt > selection > pinned > history > memory >
 * timeline > transcript): `system` and `prompt` are mandatory and never appear here.
 */
const DROP_ORDER: readonly ContextTier[] = [
  'transcript',
  'timeline',
  'skills',
  'memory',
  'history',
  'pinned',
  'selection',
];

/**
 * One assembled block, with what it cost and whether it survived the budgeter.
 *
 * This is the raw material for the request's context manifest (ADR 0080): the UI and the
 * dev inspector must be able to say *which* content moved between two requests, and an
 * omitted section is as informative as an included one — "the transcript was dropped to
 * fit" is the honest answer to "why did the number change", where a bare total is not.
 */
export interface AssembledSection {
  readonly tier: ContextTier;
  readonly label: string;
  readonly tokenEstimate: number;
  readonly included: boolean;
}

/** The messages plus a full account of what went in, what did not, and what it cost. */
export interface AssembledContext {
  readonly messages: AiMessage[];
  readonly trimmed: readonly ContextTier[];
  /**
   * Every block the assembler built, in display order, including the ones it dropped.
   * Estimates only — {@link estimateTokens} is a heuristic, and the manifest labels the
   * figure as an estimate until the provider reports real input usage.
   */
  readonly sections: readonly AssembledSection[];
  /** Tokens removed by tier-dropping this request; zero when nothing was trimmed. */
  readonly droppedTokenEstimate: number;
}

/**
 * Assemble the tiered, token-budgeted model context (R2 B2). Builds every tier, then
 * drops the lowest-priority tiers first until the estimated total fits the budget,
 * reporting which tiers were trimmed so the caller can surface an honest notice.
 *
 * @param input - Project + prompt + optional selection/platform/history/budget.
 * @returns The ordered messages and the list of trimmed tiers.
 */
export function assembleContext(input: ContextInput): AssembledContext {
  const { project, userPrompt, selection, targetPlatform } = input;
  const budget = budgetTokens(input.budget ?? DEFAULT_CONTEXT_BUDGET);

  // Entity lookup via the shared project index (built once per project snapshot,
  // reused by names/describe/tool reads) — context assembly no longer re-walks
  // the asset list on every turn.
  const projectIndex = indexFor(project);
  const assetKinds = new Map([...projectIndex.assetById].map(([id, asset]) => [id, asset.kind]));
  // Mandatory blocks (never dropped): project header + platform. The user request is
  // appended last, always.
  const header = `Project: "${project.name}" — ${project.resolution.width}x${project.resolution.height} @ ${project.fps}fps`;
  const mandatory: string[] = [header];
  if (targetPlatform) mandatory.push(`Target platform: ${targetPlatform}`);

  // Droppable, priority-tiered blocks, in their display order. The timeline and
  // transcript tiers are index-slice RETRIEVALS (K2.2), not whole-document dumps:
  // - timeline: when a selection exists it is scoped to it (B3, clips near the
  //   selection in full, the rest collapsed); otherwise each layer's listing is bounded
  //   to MAX_CLIPS_PER_LAYER so the slice never grows unboundedly with the timeline.
  // - transcript: when a selection exists it is a relevance window (the dialogue around
  //   the selection) drawn from the semantic index, not the transcript head.
  const tiered: TieredBlock[] = [
    {
      tier: 'timeline',
      label: 'timeline summary',
      text: summarizeTimeline(project.timeline, assetKinds, selection, MAX_CLIPS_PER_LAYER),
    },
  ];
  // The visual-index status line (MI6.2) sits with the timeline it describes, so the
  // model reads "what it can see" right next to "what is on the timeline".
  if (input.visualStatus && input.visualStatus.trim() !== '') {
    tiered.push({
      tier: 'timeline',
      label: 'visual index status',
      text: input.visualStatus.trim(),
    });
  }
  // The footage map (FI3.3) sits right after the visual status: it is the time-ordered
  // structural digest of what is IN the footage, the map the model consults before
  // planning cuts/zooms/reframes on long or unfamiliar material.
  if (input.footageMap && input.footageMap.trim() !== '') {
    tiered.push({ tier: 'timeline', label: 'footage map', text: input.footageMap.trim() });
  }
  if (project.transcript.length > 0) {
    tiered.push({
      tier: 'transcript',
      label: 'transcript slice',
      text: summarizeTranscript(project, selection),
    });
  }
  if (selection) {
    tiered.push({
      tier: 'selection',
      label: 'selected range',
      text: `Selected range: ${round(selection.start)}–${round(selection.end)}s`,
    });
  }
  if (input.interaction) {
    tiered.push({
      tier: 'selection',
      label: 'editor interaction state',
      text: summarizeEditorInteraction(input.interaction),
    });
  }
  if (input.pinned && input.pinned.length > 0) {
    tiered.push({ tier: 'pinned', label: 'pinned context', text: summarizePinned(input.pinned) });
  }
  const memory = summarizeScopedMemory(readMemory(project), input.userMemory);
  if (memory)
    tiered.push({
      tier: 'memory',
      label: 'project memory',
      text: `Project memory (honour these preferences):\n${memory}`,
    });
  // The narrative memory tier (B6.3) rides alongside the typed preferences above,
  // under the same `memory` tier — they are one concern to the budgeter, and both
  // yield together when the request's own material needs the room.
  if (input.sessionContext && input.sessionContext.trim() !== '') {
    tiered.push({
      tier: 'memory',
      label: 'session context',
      text: `What we have learned on this project so far:\n${input.sessionContext.trim()}`,
    });
  }
  if (input.skills && input.skills.length > 0) {
    const manifest = summarizeSkillsManifest(input.skills);
    if (manifest) tiered.push({ tier: 'skills', label: 'skills manifest', text: manifest });
  }

  const history = boundedHistory(input.history);
  const dropped = new Set<ContextTier>();

  // Cost of the current selection of tiers + mandatory + prompt + system + history.
  const promptBlock = `User request:\n${userPrompt}`;
  const cost = (): number => {
    const kept = tiered.filter((b) => !dropped.has(b.tier));
    const historyCost = dropped.has('history')
      ? 0
      : history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const blockCost = [...mandatory, ...kept.map((b) => b.text), promptBlock].reduce(
      (sum, t) => sum + estimateTokens(t),
      estimateTokens(SYSTEM_PROMPT),
    );
    return blockCost + historyCost;
  };

  // Drop lowest-priority tiers until we fit (or nothing droppable remains present).
  for (const tier of DROP_ORDER) {
    if (cost() <= budget) break;
    const present = tier === 'history' ? history.length > 0 : tiered.some((b) => b.tier === tier);
    if (present) dropped.add(tier);
  }

  const keptBlocks = tiered.filter((b) => !dropped.has(b.tier)).map((b) => b.text);
  const keptHistory = dropped.has('history') ? [] : history;
  const userContent = [...mandatoryOrdered(header, keptBlocks, mandatory), promptBlock].join(
    '\n\n',
  );

  // The per-section account (ADR 0080). Mandatory blocks are reported too, so the
  // manifest adds up to the whole user message rather than only its droppable part.
  const allSections: AssembledSection[] = [
    {
      tier: 'system',
      label: 'system contract',
      tokenEstimate: estimateTokens(SYSTEM_PROMPT),
      included: true,
    },
    {
      tier: 'prompt',
      label: 'project header',
      tokenEstimate: estimateTokens(header),
      included: true,
    },
    ...mandatory
      .filter((m) => m !== header)
      .map((text) => ({
        tier: 'prompt' as const,
        label: 'target platform',
        tokenEstimate: estimateTokens(text),
        included: true,
      })),
    ...tiered.map((block) => ({
      tier: block.tier,
      label: block.label,
      tokenEstimate: estimateTokens(block.text),
      included: !dropped.has(block.tier),
    })),
    {
      tier: 'history',
      label: `conversation history (${keptHistory.length} of ${history.length} turn(s))`,
      tokenEstimate: history.reduce((sum, m) => sum + estimateTokens(m.content), 0),
      included: !dropped.has('history') && history.length > 0,
    },
    {
      tier: 'prompt',
      label: 'user request',
      tokenEstimate: estimateTokens(promptBlock),
      included: true,
    },
  ];
  const sections = allSections.filter((section) => section.tokenEstimate > 0);

  const droppedTokenEstimate = sections
    .filter((section) => !section.included)
    .reduce((sum, section) => sum + section.tokenEstimate, 0);

  if (dropped.size > 0) {
    log.warn('context.compaction.completed', {
      trimmed: [...dropped],
      budget,
      removedTokenEstimate: droppedTokenEstimate,
    });
  } else {
    log.debug('context.assembly.completed', { tiers: tiered.map((b) => b.tier) });
  }

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...keptHistory,
      { role: 'user', content: userContent },
    ],
    trimmed: [...dropped],
    sections,
    droppedTokenEstimate,
  };
}

/**
 * Interleave the mandatory header/platform blocks with the kept tiered blocks in their
 * original display order: header, timeline, transcript, selection, memory, then any
 * remaining mandatory (platform). Keeps the message text stable when nothing is trimmed.
 */
function mandatoryOrdered(header: string, keptBlocks: string[], mandatory: string[]): string[] {
  const platform = mandatory.filter((m) => m !== header);
  return [header, ...keptBlocks, ...platform];
}

/**
 * Build the ordered message context for a completion request.
 *
 * @param input - Project + prompt + optional selection/platform/history/budget.
 * @returns `[system, …history, context+prompt]` messages ready to send to a provider.
 */
export function buildContext(input: ContextInput): AiMessage[] {
  return assembleContext(input).messages;
}
