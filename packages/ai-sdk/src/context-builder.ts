/**
 * @framepilot/ai-sdk/context-builder — assembles model context (PRD §8.2).
 *
 * Gathers the system contract, a compact timeline summary, the transcript, the
 * current selection, the target platform, and learned project memory into the
 * ordered messages handed to a provider. Kept pure and deterministic so the same
 * project + prompt always produce the same context (testable, cacheable).
 */
import { summarizeReferences, type ReferenceProfile } from './references/profile.js';
import { createLogger, type Seconds } from '@framepilot/shared-types';
import type { Clip, Project, Timeline } from '@framepilot/timeline-schema';
import type { AiMessage } from './providers/types.js';
import type { ContextBudget, ContextTier } from './reliability/types.js';
import { readMemory } from './memory-store.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { summarizeScopedMemory } from './scoped-memory.js';
import { renderStateBlock } from './state-block.js';
import { type Skill, summarizeSkillsManifest } from './skills.js';
import type { UserMemory } from './user-memory.js';
import { indexFor } from './project-index.js';
import {
  type RetrievalQuery,
  deriveRetrievalQuery,
  rankedClipIds,
  rankedDialogue,
} from './context-retrieval.js';
import { semanticIndexFor } from './kernel/semantic-index/semantic-index.js';
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
   * in `apps/web-editor/src/editor/ai.ts`), mirroring the `variations`
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
   * Reference videos/images the editor attached, analyzed once into profiles (P3.4).
   * Rendered as a fixed block so a turn that says "like the reference" reads the
   * constraints, never re-analyzes.
   */
  readonly references?: readonly ReferenceProfile[];
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

/**
 * The FLOOR for an unfocused transcript slice — never the cap.
 *
 * It was the cap, as a compile-time constant, and the result was a project view flat in
 * project size: 600 words whether the recording was ten minutes (40% of it) or four hours
 * (1.7%). {@link allocateGroundingSlice} now grows the slice into whatever room the budget
 * leaves, and this is what it may never fall below — so a 32K-window model behaves exactly
 * as it did before, and the change can only ever add coverage.
 */
export const MIN_TRANSCRIPT_WORDS = 600;

/**
 * K2.2 slice bounds. `MIN_CLIPS_PER_LAYER` is the FLOOR for an unfocused layer's clip
 * listing (it was the cap — see {@link MIN_TRANSCRIPT_WORDS}); `TRANSCRIPT_FOCUS_PAD` is
 * the lead-in/out (seconds) included around a focus range when slicing the transcript, so
 * a word straddling the edge of the selection is not lost.
 */
export const MIN_CLIPS_PER_LAYER = 12;
const TRANSCRIPT_FOCUS_PAD = 2;

/**
 * How the room left over after everything else is split between the two grounding tiers.
 *
 * Evenly, on purpose. The failure mode this guards against is one tier starving the
 * other: a transcript that consumed the whole allowance would leave the model unable to
 * NAME a clip it wants to trim, and a timeline listing that consumed it would leave the
 * model cutting dialogue it never read. Whichever tier does not need its half gives the
 * remainder back to the other (see {@link allocateGroundingSlice}), so the split costs
 * nothing when only one of them is large.
 */
const TIMELINE_SHARE_OF_GROUNDING_ROOM = 0.5;

/**
 * How many times {@link largestFittingCount} may halve its search interval.
 *
 * The search is over a count, not a size, and its oracle is the real renderer — so the
 * answer is exact rather than estimated from a per-item token guess that drifts with clip
 * id length and time formatting. 14 iterations resolve any count up to 16,384, which is
 * past the 4,500-clip and 36,000-word scales the benchmark probes; beyond that the search
 * simply returns a slightly conservative count, which is the safe direction.
 */
const FIT_SEARCH_ITERATIONS = 14;

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
  retrieval?: RetrievalQuery,
): string {
  const inFull = (c: Clip): string => `${c.id}[${round(c.start)}–${round(c.end)}s]`;
  // P2.1/P2.2: ranked selection. The clips the request is about are chosen first, then the
  // room left over is filled — evenly across the whole timeline for a global request,
  // outward from the selection for a local one. Rendering stays in TIME order whatever the
  // rank, because a timeline read out of order is harder to reason about than one with
  // declared gaps in it.
  if (retrieval) {
    if (clips.length <= maxClips) return clips.map(inFull).join(', ');
    const keep = rankedClipIds(clips, retrieval, maxClips);
    const shown = clips.filter((c) => keep.has(c.id));
    const omitted = clips.filter((c) => !keep.has(c.id));
    if (omitted.length === 0) return shown.map(inFull).join(', ');
    const span = clipsSpan(omitted);
    return `${shown.map(inFull).join(', ')}, …(+${omitted.length} more clip(s) over ${round(span.start)}–${round(span.end)}s; get_clips lists them)`;
  }
  if (!focus) {
    if (clips.length <= maxClips) return clips.map(inFull).join(', ');
    const shown = clips.slice(0, maxClips);
    const omitted = clips.slice(maxClips);
    const span = clipsSpan(omitted);
    return `${shown.map(inFull).join(', ')}, …(+${omitted.length} more clip(s) over ${round(span.start)}–${round(span.end)}s; get_clips lists them)`;
  }
  const focusIds = focusedClipIds(clips, focus);
  const shown = clips.filter((c) => focusIds.has(c.id));
  const omitted = clips.filter((c) => !focusIds.has(c.id));
  const shownStr = shown.map(inFull).join(', ');
  if (omitted.length === 0) return shownStr;
  const span = clipsSpan(omitted);
  const more = `…(+${omitted.length} more clip(s) over ${round(span.start)}–${round(span.end)}s, outside the focus; get_clips lists them)`;
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
  retrieval?: RetrievalQuery,
): string {
  if (timeline.tracks.length === 0) return 'Timeline: (empty)';
  const count = timeline.tracks.length;
  const lines = timeline.tracks.map((track, i) => {
    const z = i === 0 ? 'front' : i === count - 1 ? 'back' : 'mid';
    const kind = layerKindLabel(track.clips, assetKinds);
    const head = `- Layer ${i + 1}/${count} (${z}, ${kind}) "${track.id}"`;
    if (track.clips.length === 0) return `${head}: empty`;
    const span = clipsSpan(track.clips);
    const clips = renderTrackClips(track.clips, focus, maxClipsPerLayer, retrieval);
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
 * Without `focus`: the head of the transcript, truncated to `maxWords` — an allocation
 * derived from the room the budget leaves ({@link allocateGroundingSlice}), floored at
 * {@link MIN_TRANSCRIPT_WORDS}, not a compile-time cap.
 *
 * With `focus` (K2.2): a **relevance slice** — the words spoken within the focus range
 * (± {@link TRANSCRIPT_FOCUS_PAD} seconds of lead-in/out), not the transcript head.
 * This turns "ship the first N words" into "ship what is actually being talked about
 * around the edit," and stays bounded even for one long unbroken monologue (word-level,
 * so it narrows regardless of utterance segmentation).
 *
 * @param maxWords - Unfocused word allowance. Defaults to the floor so a direct caller
 *   (tests, host code) gets the historical behaviour rather than an unbounded dump.
 */
export function summarizeTranscript(
  project: Project,
  focus?: FocusRange,
  maxWords: number = MIN_TRANSCRIPT_WORDS,
  retrieval?: RetrievalQuery,
): string {
  if (project.transcript.length === 0) return 'Transcript: (none)';
  if (retrieval) return rankedTranscriptBlock(project, retrieval, maxWords);
  if (!focus) {
    const words = project.transcript.slice(0, maxWords).map((w) => w.word);
    const suffix = project.transcript.length > maxWords ? ' …(truncated)' : '';
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
 * The transcript tier as RANKED, TIMED dialogue (P2.1/P2.2/P2.3).
 *
 * Three changes from the head-of-list block above, each one a finding:
 *
 * - **It is the Semantic Timeline Index's dialogue, not the raw word list.**
 *   `semantic-index-slice.ts` was built, tested and exported under plan K3 and had zero
 *   production consumers; `semanticIndexFor` segments the transcript into utterances at a
 *   0.6s gap, which is the unit a ranker can keep whole.
 * - **Every segment carries its start time.** A model asked to cut on a line could read
 *   the words but had no idea when they were said, so it guessed a time and the cut
 *   landed somewhere else. This is also what Phase 3 makes frame-exact.
 * - **The gaps are declared, with their spans.** A model that silently receives 6% of a
 *   recording reasons as though that is the recording. Saying "40 more stretches over
 *   12–58 min, read them with get_transcript" turns a fragment into a fragment the model
 *   knows is one, and knows how to complete.
 */
function rankedTranscriptBlock(
  project: Project,
  retrieval: RetrievalQuery,
  maxWords: number,
): string {
  const dialogue = semanticIndexFor(project).dialogue;
  // An index with no dialogue is not a reason to show nothing: fall back to exactly the
  // head-of-list behaviour Phase 1 shipped. A ranker may never reduce coverage.
  if (dialogue.length === 0) return summarizeTranscript(project, undefined, maxWords);
  const shown = rankedDialogue(dialogue, retrieval, maxWords);
  // Rule 2, enforced: a ranker may never reduce coverage below what Phase 1 would show.
  // One unbroken monologue is a single segment, and keeping whole records means it either
  // fits or it does not — so when nothing fits, fall back to the word-level head view
  // rather than hand the model an empty transcript with a note about it.
  if (shown.length === 0) return summarizeTranscript(project, undefined, maxWords);
  const lines = shown.map((segment) => `[${round(segment.start)}s] ${segment.text}`);
  if (shown.length === dialogue.length) return `Transcript (whole, timed):\n${lines.join('\n')}`;
  const kept = new Set(shown);
  const omitted = dialogue.filter((segment) => !kept.has(segment));
  const first = omitted[0]!;
  const last = omitted[omitted.length - 1]!;
  const scope =
    retrieval.scope === 'global' ? 'sampled across the whole recording' : 'around the selection';
  return [
    `Transcript (${shown.length} of ${dialogue.length} spoken stretches, ${scope}, timed):`,
    ...lines,
    `…(+${omitted.length} more stretch(es) of dialogue between ${round(first.start)}–${round(last.end)}s not shown; read any window with get_transcript)`,
  ].join('\n');
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
 * How many characters the media-bin block may occupy.
 *
 * A character budget rather than an asset count, for the reason the footage-map digest
 * learned the same lesson: a count sized for long video shows a fraction of a library of
 * stills. 61 photographs is a normal import and a small number of characters; ten hours of
 * rushes is a small number of assets and a large number of characters. The budget bounds
 * the thing that actually costs.
 */
const MEDIA_BIN_CHARS = 4000;

/**
 * The media bin, and which of it is already on the timeline.
 *
 * ## Why the bin is in the project view at all
 *
 * It was not, and on an import-heavy project that was the single most expensive omission
 * in the prompt. `summarizeTimeline` describes the clips that have been PLACED; nothing
 * described the material waiting to be placed. So a montage run had to spend a
 * `list_assets` call to learn what it was editing — and, because the action log keeps
 * payloads for only its two freshest entries, spend more calls recalling the same list
 * later. Run `fc10301a` retrieved one unchanging list of 62 asset ids five times.
 *
 * The orchestrator's own comment states the rule this violated: "anything the run must not
 * forget has to live in the briefing" — or, for project state, in the project view. Asset
 * ids are precisely what a montage run must not forget.
 *
 * ## Why `placed` is the load-bearing column
 *
 * "Which of my 61 photos have I not used yet" is the question a montage asks on every
 * turn, and it is not answerable from the bin or the timeline alone — it is the join. A
 * run that can read it off its project view does not have to reconstruct it by diffing two
 * tool results.
 *
 * Rides the `timeline` tier: it is factual project state, and it drops with the timeline
 * under budget pressure — where `list_assets` remains available to answer on demand.
 */
export function summarizeMediaBin(project: Project): string {
  const assets = project.assets;
  if (assets.length === 0) return '';
  const placed = new Set(
    project.timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)),
  );
  const unplaced = assets.filter((asset) => !placed.has(asset.id)).length;
  // Nothing waiting to be placed means the timeline summary above is already the complete
  // account of the project's material, and a second listing of the same ids is weight the
  // grounding tiers could have spent on the cut itself. The block exists to answer "what
  // is there still to place"; with no answer, it says nothing.
  if (unplaced === 0) return '';
  const head =
    `Media bin — ${String(assets.length)} asset(s), ` +
    `${String(assets.length - unplaced)} placed, ${String(unplaced)} not yet used:`;
  const lines: string[] = [];
  let used = head.length;
  for (const [index, asset] of assets.entries()) {
    const duration =
      typeof asset.durationSeconds === 'number' ? ` ${round(asset.durationSeconds)}s` : '';
    const line = `- ${asset.id} [${asset.kind}]${duration}${placed.has(asset.id) ? ' · placed' : ''}`;
    if (used + line.length > MEDIA_BIN_CHARS) {
      // Say what was left out and how to get it, never trail off. A run told "+37 more"
      // with no route to them is a run that invents ids.
      lines.push(
        `- …and ${String(assets.length - index)} more — call list_assets to read them all`,
      );
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return [head, ...lines].join('\n');
}

/** Orientation of a frame from its pixel dimensions. */
function orientationOf(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

const SOURCE_MEDIA_CHARS = 1800;

/**
 * The per-asset facts an editor reads off a thumbnail and the model cannot: file name,
 * source dimensions, and whether the source's orientation matches the sequence's.
 *
 * WHY: in the mission montage ledger the model spent five `recall_evidence` calls and
 * five `describe_footage` calls asking "is this landscape, will it letterbox?" — facts the
 * project file already holds. Stated once, in one line per asset, they cost ~15 tokens
 * each and remove those requests. Assets with no known dimensions are listed by kind only;
 * nothing is guessed.
 */
export function summarizeSourceMedia(project: Project): string {
  if (project.assets.length === 0) return '';
  const sequence = orientationOf(project.resolution.width, project.resolution.height);
  const lines: string[] = [];
  let used = 0;
  for (const [index, asset] of project.assets.entries()) {
    const name = asset.path.split('/').pop() ?? asset.path;
    const width = asset.media?.width ?? null;
    const height = asset.media?.height ?? null;
    let shape = '';
    if (asset.kind !== 'audio' && width !== null && height !== null) {
      const orientation = orientationOf(width, height);
      const fit =
        orientation === sequence
          ? 'matches the sequence'
          : `sequence is ${sequence}: fills the frame only with a crop, else letterboxed`;
      shape = ` · ${String(width)}×${String(height)} ${orientation} — ${fit}`;
    } else if (asset.kind === 'audio') {
      shape = ' · audio';
    }
    const line = `- ${asset.id} ${name}${shape}`;
    if (used + line.length > SOURCE_MEDIA_CHARS) {
      lines.push(
        `- …and ${String(project.assets.length - index)} more — call list_assets for their dimensions`,
      );
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return ['Source media (file · dimensions · fit in this sequence):', ...lines].join('\n');
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

/**
 * The room the assembled prompt may occupy = window − reserved output − headroom −
 * the fixed prompt cost the assembler does not build ({@link ContextBudget.reservedPromptTokens}).
 *
 * The last term is the one that was missing. `assembleContext` sums the system prompt,
 * the tiers, the history and the request — and then the caller attaches ~17,500 tokens of
 * tool schemas and a mode instruction it never saw, so "fits the budget" was a statement
 * about roughly a fifth of the prompt.
 */
export function budgetTokens(budget: ContextBudget): number {
  return Math.max(
    0,
    budget.contextWindow -
      budget.maxOutputTokens -
      budget.headroom -
      (budget.reservedPromptTokens ?? 0),
  );
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
  /**
   * The same user content, split where it stops being stable for the run (P1.3).
   *
   * Only the TIMELINE summary changes between turns of one run: it is rendered from the
   * mutating working copy, so every applied patch rewrites it. The transcript, the
   * footage map, the visual status, the selection, the memory tiers and the skills
   * manifest are all fixed for the run's duration.
   *
   * That distinction is worth money. A provider caches a byte-identical PREFIX, so
   * anything stable that sits after something volatile is re-billed at full price every
   * turn. Growing the grounding slice (P1.3) put ~9,000 more tokens into the prompt, and
   * with the whole block in the volatile tail the cacheable share fell from 85% to 45%
   * — the phase's own risk table says that must not happen. The agent loop reads this
   * split and puts `stable` above its cache boundary.
   *
   * `messages` is UNCHANGED and still carries the whole block in its historical order:
   * every non-agent route keeps exactly the prompt it had.
   */
  readonly split: ContextSplit;
}

/** The run-stable and per-turn halves of the assembled user content (P1.3). */
export interface ContextSplit {
  /**
   * Fixed for the run: header, transcript, memory, skills, the request — everything but
   * the timeline.
   */
  readonly stable: string;
  /** Re-rendered every turn from the working copy: the timeline tier and any omissions. */
  readonly volatile: string;
}

/**
 * The largest count in `[floor, total]` whose rendering fits `room` tokens.
 *
 * Binary search with the REAL renderer as its oracle, not a per-item token estimate: a
 * clip line's cost depends on the id length and the time formatting, and a transcript
 * word's on the word, so an estimate drifts by tier and by project. The common case —
 * the whole thing fits — is answered by the first probe and never enters the search.
 *
 * Returns `floor` when even the floor does not fit. That is deliberate: the floor is
 * today's behaviour, this change may only ever ADD coverage, and a request that cannot
 * afford the floor is exactly the case `DROP_ORDER` already handles. Pure.
 */
function largestFittingCount(
  floor: number,
  total: number,
  room: number,
  render: (count: number) => string,
): number {
  if (total <= floor) return total;
  if (estimateTokens(render(total)) <= room) return total;
  let low = floor;
  let high = total;
  for (let i = 0; i < FIT_SEARCH_ITERATIONS && high - low > 1; i += 1) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTokens(render(mid)) <= room) low = mid;
    else high = mid;
  }
  return low;
}

/** What the two grounding tiers may spend, as record counts rather than tokens. */
export interface GroundingAllocation {
  readonly maxClipsPerLayer: number;
  readonly maxTranscriptWords: number;
}

/**
 * Turn the room left after everything else into per-tier record allowances (P1.3).
 *
 * `MAX_CLIPS_PER_LAYER = 12` and `MAX_TRANSCRIPT_WORDS = 600` were compile-time
 * constants that consulted neither the budget, the model, nor the capacity the manifest
 * computes — so the project view was FLAT IN PROJECT SIZE, about 1,350 tokens whether the
 * video ran ten minutes or four hours. On Opus at sixty minutes that meant showing the
 * model 2.1% of its cuts while ~114,000 tokens of its window sat unused.
 *
 * Three rules make this safe to ship without a per-model regression matrix:
 *
 * 1. **Floored at the old constants.** Coverage can only go up. A 32K-window model
 *    behaves exactly as it did.
 * 2. **Neither tier starves the other.** Each gets a share of the room; whichever needs
 *    less hands the remainder back, so the split costs nothing when only one is large.
 * 3. **The search is exact, not estimated** — see {@link largestFittingCount}.
 *
 * A focused request is not allocated at all: `focus` selects by relevance, and the
 * timeline path already renders the focus neighbourhood in full regardless of any cap.
 *
 * @param room - Tokens left for the two grounding tiers after everything else is paid.
 * @returns The per-tier allowances, floored at the historical constants.
 */
export function allocateGroundingSlice(
  project: Project,
  assetKinds: ReadonlyMap<string, string | undefined>,
  room: number,
  focus?: FocusRange,
  retrieval?: RetrievalQuery,
): GroundingAllocation {
  const timeline = project.timeline;
  const maxClips = timeline.tracks.reduce((n, track) => Math.max(n, track.clips.length), 0);
  const totalWords = project.transcript.length;
  if (room <= 0) {
    return { maxClipsPerLayer: MIN_CLIPS_PER_LAYER, maxTranscriptWords: MIN_TRANSCRIPT_WORDS };
  }
  // Rule 2, first half: the timeline gets its guaranteed share, or everything the
  // transcript does not need — whichever is larger. A project with little or no dialogue
  // must not have half the room reserved for a tier that will not spend it.
  // With retrieval wired (Phase 2) a selection is a BIAS, not a boundary — the request
  // still gets whatever room it can use, and the ranker decides what fills it. Only the
  // pre-Phase-2 focus path is pinned to the floor, because there the selection really did
  // bound what could be shown.
  const bounded = focus !== undefined && retrieval === undefined;
  const transcriptNeed = bounded
    ? 0
    : estimateTokens(summarizeTranscript(project, undefined, totalWords, retrieval));
  const timelineRoom = Math.max(
    Math.floor(room * TIMELINE_SHARE_OF_GROUNDING_ROOM),
    room - transcriptNeed,
  );
  const maxClipsPerLayer = bounded
    ? MIN_CLIPS_PER_LAYER
    : largestFittingCount(MIN_CLIPS_PER_LAYER, maxClips, timelineRoom, (count) =>
        summarizeTimeline(timeline, assetKinds, focus, count, retrieval),
      );
  // Rule 2, second half, symmetrically: the transcript gets everything the timeline did
  // not actually spend, measured on the real render rather than on its allowance.
  const spentOnTimeline = estimateTokens(
    summarizeTimeline(timeline, assetKinds, focus, maxClipsPerLayer, retrieval),
  );
  const transcriptRoom = Math.max(0, room - spentOnTimeline);
  const maxTranscriptWords = bounded
    ? MIN_TRANSCRIPT_WORDS
    : largestFittingCount(MIN_TRANSCRIPT_WORDS, totalWords, transcriptRoom, (count) =>
        // The REAL renderer, so the "…(truncated)" marker and the declared-omission tail
        // are priced too. Probing with a hand-rolled approximation is how an allocation
        // comes back a few tokens over and the budgeter drops the whole tier it was sizing.
        summarizeTranscript(project, undefined, count, retrieval),
      );
  return { maxClipsPerLayer, maxTranscriptWords };
}

/**
 * What the MODEL is told about a tier that did not fit (P2.3).
 *
 * A dropped tier already reaches the UI and the manifest as an omitted section with a
 * reason (ADR 0080). The model was told nothing — so a run whose transcript tier was
 * trimmed reasoned as though the project has no dialogue, which is not a smaller answer
 * but a wrong one.
 *
 * Each line names what is missing AND the call that returns it, which is the standard
 * `clearedWithHandle` was written to establish: a marker that offers a re-read with no
 * address to read from is an apology, not an instruction.
 */
const TIER_RECOVERY: Partial<Record<ContextTier, string>> = {
  transcript: 'the dialogue — read any window with get_transcript',
  timeline: 'the timeline arrangement — read it with get_timeline_summary or get_clips',
  skills: 'the skills manifest — load a playbook by name with load_skill',
  memory: 'the project memory and session notes — this project may have preferences you cannot see',
  history: 'earlier turns of this conversation',
  pinned: 'the entities the user pinned',
  selection: "the user's current selection — ask before assuming an edit is project-wide",
};

/** Render the declared-omission block, or '' when everything fit. */
export function summarizeDroppedTiers(dropped: readonly ContextTier[]): string {
  const lines = dropped
    .map((tier) => TIER_RECOVERY[tier])
    .filter((line): line is string => line !== undefined)
    .map((line) => `- ${line}`);
  if (lines.length === 0) return '';
  return [
    'NOT IN THIS PROMPT (it did not fit, so do not treat its absence as absence from the',
    'project):',
    ...lines,
  ].join('\n');
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
  // Mandatory blocks (never dropped): the structured STATE block (P1.3 — project facts,
  // selection, playhead, revision in a fixed key order) + platform. The user request is
  // appended last, always.
  const header = renderStateBlock({
    project,
    ...(input.projectRevision === undefined ? {} : { projectRevision: input.projectRevision }),
    ...(selection ? { selection } : {}),
    ...(input.interaction ? { interaction: input.interaction } : {}),
  });
  const mandatory: string[] = [header];
  if (targetPlatform) mandatory.push(`Target platform: ${targetPlatform}`);

  // Droppable, priority-tiered blocks, in their display order. The timeline and
  // transcript tiers are index-slice RETRIEVALS (K2.2), not whole-document dumps:
  // - timeline: when a selection exists it is scoped to it (B3, clips near the
  //   selection in full, the rest collapsed); otherwise each layer's listing is bounded
  //   to the allocation below so the slice never grows unboundedly with the timeline.
  // - transcript: when a selection exists it is a relevance window (the dialogue around
  //   the selection) drawn from the semantic index, not the transcript head.
  //
  // The FIXED blocks are built first, because the two grounding tiers are allocated out
  // of what is left after them (P1.3): their sizes are a budget decision, not a
  // compile-time constant, and the budget is only knowable once everything else is
  // priced. They are spliced back into their display positions below, so the assembled
  // message text is byte-identical to what this order has always produced.
  // The selected range and playhead live in the STATE block above; the interaction
  // summary carries only what the block does not (clip/track/effect/keyframe ids,
  // source monitor).
  const fixed: TieredBlock[] = [];
  if (input.interaction) {
    fixed.push({
      tier: 'selection',
      label: 'editor interaction state',
      text: summarizeEditorInteraction(input.interaction),
    });
  }
  if (input.pinned && input.pinned.length > 0) {
    fixed.push({ tier: 'pinned', label: 'pinned context', text: summarizePinned(input.pinned) });
  }
  const memory = summarizeScopedMemory(readMemory(project), input.userMemory);
  if (memory)
    fixed.push({
      tier: 'memory',
      label: 'project memory',
      text: `Project memory (honour these preferences):\n${memory}`,
    });
  // The narrative memory tier (B6.3) rides alongside the typed preferences above,
  // under the same `memory` tier — they are one concern to the budgeter, and both
  // yield together when the request's own material needs the room.
  const referencesBlock = summarizeReferences(input.references ?? []);
  if (referencesBlock !== '') {
    fixed.push({ tier: 'pinned', label: 'references', text: referencesBlock });
  }
  if (input.sessionContext && input.sessionContext.trim() !== '') {
    fixed.push({
      tier: 'memory',
      label: 'session context',
      text: `What we have learned on this project so far:\n${input.sessionContext.trim()}`,
    });
  }
  if (input.skills && input.skills.length > 0) {
    const manifest = summarizeSkillsManifest(input.skills);
    if (manifest) fixed.push({ tier: 'skills', label: 'skills manifest', text: manifest });
  }

  const history = boundedHistory(input.history);
  const dropped = new Set<ContextTier>();

  // Cost of the current selection of tiers + mandatory + prompt + system + history.
  const promptBlock = `User request:\n${userPrompt}`;

  // The two grounding tiers grow into whatever the rest of the prompt leaves (P1.3).
  // Everything above is already priced; the visual status and footage map are counted
  // here too, because they ride the timeline tier and are not the assembler's to size.
  const visualStatus = input.visualStatus?.trim() ?? '';
  const footageMap = input.footageMap?.trim() ?? '';
  // Priced here for the same reason: it rides the timeline tier and must not eat the
  // grounding slice that the transcript and clip retrievals are sized from.
  const sourceMedia = summarizeSourceMedia(project);
  const spentElsewhere = [
    SYSTEM_PROMPT,
    ...mandatory,
    ...fixed.map((b) => b.text),
    visualStatus,
    footageMap,
    sourceMedia,
    promptBlock,
    ...history.map((m) => m.content),
  ].reduce((sum, text) => sum + estimateTokens(text), 0);
  // P2.2: what this turn is about, read from pinned entities, the selection and the
  // request's own words, with a declared precedence. Pure — no model call, no I/O.
  const retrieval = deriveRetrievalQuery({
    userPrompt,
    ...(selection ? { selection } : {}),
    ...(input.pinned ? { pinned: input.pinned } : {}),
  });
  const allocation = allocateGroundingSlice(
    project,
    assetKinds,
    budget - spentElsewhere,
    selection,
    retrieval,
  );

  const tiered: TieredBlock[] = [
    {
      tier: 'timeline',
      label: 'timeline summary',
      text: summarizeTimeline(
        project.timeline,
        assetKinds,
        selection,
        allocation.maxClipsPerLayer,
        retrieval,
      ),
    },
  ];
  // The bin sits directly under the timeline summary: together they are "what has been
  // placed" and "what there is to place", which is the pair a montage reasons over.
  const mediaBin = summarizeMediaBin(project);
  if (mediaBin !== '') {
    tiered.push({ tier: 'timeline', label: 'media bin', text: mediaBin });
  }
  // Source facts (file, dimensions, orientation vs the sequence) ride with the bin: they
  // are what the model otherwise re-derives with recall/describe calls (P1.3a).
  if (sourceMedia !== '') {
    tiered.push({ tier: 'timeline', label: 'source media', text: sourceMedia });
  }
  // The visual-index status line (MI6.2) sits with the timeline it describes, so the
  // model reads "what it can see" right next to "what is on the timeline".
  if (visualStatus !== '') {
    tiered.push({ tier: 'timeline', label: 'visual index status', text: visualStatus });
  }
  // The footage map (FI3.3) sits right after the visual status: it is the time-ordered
  // structural digest of what is IN the footage, the map the model consults before
  // planning cuts/zooms/reframes on long or unfamiliar material.
  if (footageMap !== '') {
    tiered.push({ tier: 'timeline', label: 'footage map', text: footageMap });
  }
  if (project.transcript.length > 0) {
    tiered.push({
      tier: 'transcript',
      label: 'transcript slice',
      text: summarizeTranscript(project, selection, allocation.maxTranscriptWords, retrieval),
    });
  }
  tiered.push(...fixed);
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

  const omissionBlock = summarizeDroppedTiers([...dropped]);
  const keptTiers = tiered.filter((b) => !dropped.has(b.tier));
  const keptBlocks = keptTiers.map((b) => b.text);
  const keptHistory = dropped.has('history') ? [] : history;
  const userContent = [
    ...mandatoryOrdered(header, keptBlocks, mandatory),
    ...(omissionBlock === '' ? [] : [omissionBlock]),
    promptBlock,
  ].join('\n\n');
  // The run-stability split (P1.3). The timeline tier is the only thing here that a turn
  // can change, so everything else — including the platform line and the request — is
  // prefix a provider can cache for the whole run.
  //
  // `promptBlock` belongs in `stable`, and used to be in `volatile` against the sentence
  // directly above. The editor's request does not change between turns of a run, so
  // sitting below the agent loop's cache boundary bought nothing and cost the whole
  // request at full price on every turn. It is not a rounding error on a long brief: a
  // captured run (`f1d5285e`) carried a 2,672-token spec and re-billed it uncached on
  // every model call of the run, which is precisely the "why is my prompt on every
  // request" the manifest kept showing and nothing explained.
  //
  // The omission block rides with the timeline instead, because it is the one thing here
  // that genuinely re-renders: which tiers had to be dropped is a function of the budget
  // this turn, and the timeline growing is what moves it.
  const volatileBlocks = keptTiers.filter((b) => b.tier === 'timeline').map((b) => b.text);
  const stableBlocks = keptTiers.filter((b) => b.tier !== 'timeline').map((b) => b.text);
  const split: ContextSplit = {
    stable: [header, ...stableBlocks, ...mandatory.filter((m) => m !== header), promptBlock].join(
      '\n\n',
    ),
    volatile: [...volatileBlocks, ...(omissionBlock === '' ? [] : [omissionBlock])].join('\n\n'),
  };

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
    split,
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
