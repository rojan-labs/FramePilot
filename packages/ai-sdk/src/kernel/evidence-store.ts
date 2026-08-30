/**
 * @framepilot/ai-sdk/kernel/evidence-store — raw payloads, held apart from task memory
 * (plan/AGENT-TASK-MEMORY.md §3.4, proposed ADR 0075).
 *
 * ## Why this replaces the read memo
 *
 * The old per-run `readCache` held every read's payload and then refused to give it
 * back: a cache hit returned the note *"this is already in your context; act on it
 * rather than reading it again"* and routed the data to the UI's details popup. It was
 * not in the model's context — compaction had cleared it two turns earlier with
 * "re-read if needed". The run invited a re-read and answered it with nothing, and the
 * only way out was to vary the window, which is exactly the research spin ADR 0074
 * observed.
 *
 * The store fixes the half of that deadlock it owns: **a hit always returns the data.**
 * It is a memo (never pay twice for the same read) AND a retrieval surface (the payload
 * stays reachable by handle for the rest of the run), rather than a memo that treats
 * having-seen-it as equivalent to having-it.
 *
 * ## Invalidation is driven by what actually changed
 *
 * Not by a blanket `clear()` on every applied patch. `Project.transcript` carries its own
 * word timings and is rewritten only by `set_transcript`; ripple deletes and trims leave
 * it alone. So a cut invalidates the *arrangement* — clip ids, positions, gaps — and
 * nothing about the words that were spoken. Discarding the transcript because a cut
 * landed is what made the run pay for its reconnaissance over and over.
 */
import type { OperationType, ProjectOperationType } from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import type { FactScope } from './working-state.js';
import { type ToolEvidenceScope, classifyTool, factScopeOf } from '../tool-classification.js';
import { getTool } from '../tool-registry.js';

const log = createLogger('ai-sdk:kernel:evidence-store');

/** Characters of payload rendered into a model-facing preview before truncation. */
export const EVIDENCE_PREVIEW_CHARS = 900;

/**
 * Characters returned by an explicit {@link EvidenceStore.recall}, which asked for more.
 *
 * WHY it is this large. ADR 0128 gave `recall` an `offset` so nothing stored is
 * unreachable, which fixed correctness and left the economics wrong: at 4,000 characters
 * a real read takes several round trips, and a round trip is a whole model turn. A
 * caption run spent six of its nine turns paging one 27 KB transcript back out of the
 * store, then hit the convergence guard with no edit applied. Reachable-in-principle is
 * not the same as affordable.
 *
 * 16,000 characters (~4,000 tokens) returns essentially every real read whole in one
 * call, and the offset remains for the genuinely large ones. The cost is bounded and
 * transient: a recall's result rides in the action-log note, whose payload
 * `compactAgentLog` clears after two turns (`orchestrator.ts#AGENT_LOG_PAYLOAD_FRESH`), so it occupies
 * the prompt for two turns rather than the run. Against a million-token window that is a
 * rounding error; against six wasted turns it is the whole difference.
 */
export const EVIDENCE_RECALL_CHARS = 16_000;

/**
 * Every operation type a patch can carry. Imported from the engine's own union rather
 * than restated, so the sets below are checked against the real operations: renaming or
 * removing one in `editor-core` fails this file's typecheck instead of silently turning a
 * cache policy into a lie.
 */
type AppliedOperationType = OperationType | ProjectOperationType;

/** The operation type that rewrites the transcript (see `project-operations.ts`). */
const TRANSCRIPT_OPERATION = 'set_transcript';

/**
 * Operation types that change the media bin. Asset-derived evidence (`list_assets`)
 * survives every cut but not these — adding, removing, or refiling an asset is what makes
 * a bin listing wrong.
 *
 * This was `['add_asset', 'manage_assets']`. `manage_assets` is a TOOL name and never
 * appears among applied operation types, and the real removal/refiling ops were missing
 * entirely — so a `remove_asset` left a bin listing in the store that named an asset the
 * project no longer had. Folder ops count too: `list_assets` reports where each asset is
 * filed.
 */
const ASSET_OPERATIONS: ReadonlySet<string> = new Set<AppliedOperationType>([
  'add_asset',
  'remove_asset',
  'move_asset',
  'restore_assets',
  'create_folder',
  'rename_folder',
  'move_folder',
  'delete_folder',
  'restore_folders',
]);

/**
 * What a `timeline_dependent` payload can go stale AGAINST.
 *
 * `picture` — how a rendered frame at a given time LOOKS.
 * `structure` — the track/clip listing: ids, positions, track set, counts.
 *
 * The split exists because one operation changes only the second, and it is the one an
 * agent applies most casually.
 */
type TimelineFacet = 'picture' | 'structure';

const BOTH_FACETS: readonly TimelineFacet[] = ['picture', 'structure'];

/**
 * Operations that change the timeline's SHAPE without changing any rendered frame.
 *
 * `add_layer` creates a track. An empty track composites to nothing, so every frame of
 * the sequence renders identically before and after — but the track listing changes, so
 * `get_timeline`/`get_timeline_summary` evidence must still go.
 *
 * WHY this matters: `invalidate` used to drop EVERY `timeline_dependent` entry on ANY
 * applied patch, and `get_frame` is `timeline_dependent`. In one three-minute run the
 * agent added three empty tracks and paid three extra frame renders (~1.2s each, plus the
 * model turn around them) for pictures that had not changed by a single pixel.
 *
 * The caveat, stated because the type alone cannot express it: `AddLayerOp` may carry seed
 * `clips`. Only `invertOperation` (the undo of a `remove_layer`) builds one that way, and
 * undo does not route through this store; every forward producer in the repo creates an
 * empty layer and pairs content with an `add_clip` in the SAME patch, whose presence marks
 * the batch as picture-changing anyway.
 */
const STRUCTURE_ONLY_OPERATIONS: ReadonlySet<string> = new Set<AppliedOperationType>(['add_layer']);

/**
 * Operations that touch neither the picture nor the timeline listing.
 *
 * `set_ai_memory` writes `project.aiMemory` — the editor's durable preferences, injected
 * straight into the prompt and returned by no read tool. A run that records a preference
 * mid-edit was throwing away its entire reconnaissance to do it.
 */
const TIMELINE_INERT_OPERATIONS: ReadonlySet<string> = new Set<AppliedOperationType>([
  'set_ai_memory',
]);

/**
 * Which facets an applied operation can change.
 *
 * An operation type this file does not recognise — a new one in `editor-core`, or a
 * string from a caller outside this repo — changes EVERYTHING. Cache-hit rate is worth
 * nothing next to a stale frame shown to a model as the current state of the edit, so the
 * default is the expensive one and a new operation has to be classified deliberately to
 * become cheap.
 */
function facetsChangedBy(operationType: string): readonly TimelineFacet[] {
  if (TIMELINE_INERT_OPERATIONS.has(operationType)) return [];
  if (STRUCTURE_ONLY_OPERATIONS.has(operationType)) return ['structure'];
  return BOTH_FACETS;
}

/**
 * Reads whose payload is a rendered picture and nothing else. `get_frame` takes a
 * timeline TIME and returns the composited still at it — it names no clip and no track,
 * so nothing about the listing can make it wrong.
 *
 * Every other `timeline_dependent` read is assumed to depend on both facets, which is the
 * conservative direction: worst case it is re-read.
 */
const PICTURE_ONLY_READS: ReadonlySet<string> = new Set(['get_frame']);

/** Which facets a stored payload's correctness rests on. */
function facetsNeededBy(source: string): readonly TimelineFacet[] {
  return PICTURE_ONLY_READS.has(source) ? ['picture'] : BOTH_FACETS;
}

/**
 * How a tool's result behaves across project revisions.
 *
 * The allowlist that used to live here has moved to `tool-classification.ts`, which
 * covers every registered tool and is parity-tested against `TOOL_REGISTRY`. This one had
 * silently omitted `detect_beats`, `index_media`, `describe_footage`, `find_similar` and
 * `list_assets`, so all five were evicted on every applied patch and the run paid to
 * recompute them after each cut.
 *
 * Returns the binary {@link FactScope} the rest of the run speaks; {@link scopeOf} keeps
 * the finer-grained store-level scope for invalidation.
 */
export function evidenceScopeFor(toolName: string): FactScope {
  return factScopeOf(scopeOf(toolName));
}

/** The store-level scope, which distinguishes asset/transcript dependence. */
function scopeOf(toolName: string): ToolEvidenceScope {
  return classifyTool(toolName, getTool(toolName)?.kind).scope;
}

/** One stored payload plus everything needed to cite, recall, or invalidate it. */
export interface EvidenceEntry {
  /** Stable handle the model can pass to `recall_evidence`. */
  readonly id: string;
  /** The memo key (tool + exact arguments) this was stored under. */
  readonly key: string;
  /** Tool that produced it. */
  readonly source: string;
  /** The short human label for the call ("Reading the transcript 22.5–22.7s"). */
  readonly descriptor: string;
  readonly scope: FactScope;
  /** The full, untruncated result. */
  readonly data: unknown;
}

/** Render a payload as the text the model reads. Objects become compact JSON. */
function render(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

/**
 * The records a payload is a list OF, for {@link EvidenceStore.recall}'s filter.
 *
 * A recall used to split its payload on newlines. `JSON.stringify` emits none, so every
 * object payload was one single "line": a query either matched the whole blob (returning
 * it truncated at {@link EVIDENCE_RECALL_CHARS}, i.e. the same head the preview already
 * showed) or matched nothing at all. The one read this mattered most for is the timeline
 * map — a 42-clip project serialises to ~8.8 KB, so `recall_evidence` handed back the
 * first ~18 clips however narrowly it was asked, and a run trying to check clip 30's
 * source in-point could not get there by any query.
 *
 * So a payload that IS a list — a bare array, or an object with array-valued properties
 * (`{ spans, duration, revision }`, `{ clips, total, hasMore }`) — is filtered by RECORD.
 * Anything else keeps the line split, which is right for prose.
 *
 * WHY every array and not just a lone one: the previous `arrays.length === 1` guard meant
 * a payload with TWO record lists fell back to the single-line JSON path, where the only
 * matchable "part" is the entire blob. That covered the two reads a caption run depends
 * on — `discover_caption_styles` (`fonts` + `templates` + `compositionFields`) and
 * `get_mapped_transcript` (`words` + `runs`) — so every query against them reported no
 * match. Flattening all of them cannot drop half a payload the way *picking* one would,
 * because nothing is excluded; each record is still rendered whole, and {@link
 * EvidenceStore.recall} falls back to the line split when no record matches, so a query
 * aimed at a scalar sibling field still lands.
 */
function recordsOf(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object' || data === null) return undefined;
  const arrays = Object.values(data as Record<string, unknown>).filter((value): value is unknown[] =>
    Array.isArray(value),
  );
  return arrays.length > 0 ? arrays.flat() : undefined;
}

/**
 * Rank `parts` against a query, keeping only those that match something.
 *
 * The old filter tested `part.includes(wholeQuery)`: one literal substring. Models do not
 * write queries that way — they write keyword bags ("captionStyle track layer_caption_4
 * style"), which can only match if that exact 47-character string appears inside a single
 * record. It never does, so a correct query returned "no match" and the run's only
 * retrieval surface looked empty. Scoring instead of filtering keeps the precise case
 * best (a full-phrase hit outranks everything) while still answering the keyword bag.
 */
function rank(parts: readonly unknown[], phrase: string, terms: readonly string[]): string[] {
  const scored = parts
    .map((part) => {
      const text = render(part);
      const haystack = text.toLowerCase();
      // A whole-phrase hit is worth more than any number of scattered term hits, so an
      // exact query still sorts to the top of a keyword-shaped result.
      const exact = haystack.includes(phrase) ? terms.length + 1 : 0;
      const hits = terms.filter((term) => haystack.includes(term)).length;
      return { text, score: exact + hits };
    })
    .filter((entry) => entry.score > 0);
  // Stable by construction: equal scores keep payload order, so a recall is reproducible.
  return scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.text);
}

/**
 * Return the `limit` characters of `text` starting at `from`, naming the next offset when
 * more remains.
 *
 * WHY an offset exists at all: `recall` used to answer every unqueried call with
 * `text.slice(0, EVIDENCE_RECALL_CHARS)`. For any payload larger than that the tail was
 * unreachable by ANY argument — a run that recalled the caption-style catalog three times
 * received the identical head, cut mid-template, each time. Truncation the caller cannot
 * page past is the same deadlock as a memo that refuses to return its data.
 */
function page(text: string, from: number, limit: number, id: string): string {
  if (from > 0 && from >= text.length) {
    return `Offset ${from} is past the end of ${id}, which holds ${text.length} characters.`;
  }
  const slice = text.slice(from, from + limit);
  const end = from + slice.length;
  if (end >= text.length) return slice;
  return `${slice}… (truncated at ${end} of ${text.length} characters — call recall_evidence with "${id}" and offset ${end} for the next part)`;
}

/** Cut `text` to `limit`, marking the cut so the model knows more is retrievable. */
function clip(text: string, limit: number, id: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (truncated — call recall_evidence with "${id}" for more)`;
}

/**
 * Per-run store of every payload the agent has gathered.
 *
 * Not a class for its own sake: the store owns identity allocation and invalidation
 * policy together, and both must stay consistent with each other across the two agent
 * loops and the repair pass, which all thread the same instance.
 */
export class EvidenceStore {
  private readonly byKey = new Map<string, EvidenceEntry>();
  private readonly byId = new Map<string, EvidenceEntry>();
  private counter = 0;

  /** Everything currently held, in insertion order. */
  public entries(): readonly EvidenceEntry[] {
    return [...this.byKey.values()];
  }

  public size(): number {
    return this.byKey.size;
  }

  /** The entry stored for an exact call, if the run has already made it. */
  public lookup(key: string): EvidenceEntry | undefined {
    return this.byKey.get(key);
  }

  public byHandle(id: string): EvidenceEntry | undefined {
    return this.byId.get(id);
  }

  /**
   * Store a fresh result. Re-storing the same key returns the existing entry unchanged,
   * so a handle the model has already been given never silently changes meaning.
   */
  public put(args: {
    readonly key: string;
    readonly source: string;
    readonly descriptor: string;
    readonly data: unknown;
  }): EvidenceEntry {
    const existing = this.byKey.get(args.key);
    if (existing) return existing;
    this.counter += 1;
    const entry: EvidenceEntry = {
      id: `ev_${this.counter}`,
      key: args.key,
      source: args.source,
      descriptor: args.descriptor,
      scope: evidenceScopeFor(args.source),
      data: args.data,
    };
    this.byKey.set(entry.key, entry);
    this.byId.set(entry.id, entry);
    return entry;
  }

  /**
   * The model-facing preview of an entry — what a read (fresh or memoized) puts in the
   * action log. Always carries real content plus the handle, which is the property the
   * old memo violated.
   */
  public preview(entry: EvidenceEntry): string {
    return clip(render(entry.data), EVIDENCE_PREVIEW_CHARS, entry.id);
  }

  /**
   * Retrieve a stored payload, optionally narrowed by a free-text query and windowed by
   * `offset`. The query is a deterministic case-insensitive keyword match over records
   * (see {@link rank}) rather than a semantic search: the caller already knows which
   * handle it wants, and a deterministic filter is auditable and needs no model call.
   *
   * `offset` pages through a result larger than {@link EVIDENCE_RECALL_CHARS}; the
   * returned text names the next offset whenever more remains, so no part of a stored
   * payload is unreachable.
   *
   * Returns `undefined` for an unknown handle so the caller can say so honestly instead
   * of inventing an answer.
   */
  public recall(id: string, query?: string, offset?: number): string | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    const full = render(entry.data);
    const from = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset as number)) : 0;
    if (!query?.trim()) return page(full, from, EVIDENCE_RECALL_CHARS, id);

    const phrase = query.trim().toLowerCase();
    const terms = [...new Set(phrase.split(/\s+/).filter((term) => term.length > 0))];
    const lines = () => full.split('\n');
    const records = recordsOf(entry.data);
    // Records first; then the line split, which is both the prose path and the way a
    // query aimed at a scalar sibling ("matched", "revision") still finds its field.
    const hits = records ? rank(records, phrase, terms) : [];
    const matched = hits.length > 0 ? hits : rank(lines(), phrase, terms);
    if (matched.length === 0) {
      return `No part of ${id} (${entry.descriptor}) matches "${query.trim()}".`;
    }
    return page(matched.join('\n'), from, EVIDENCE_RECALL_CHARS, id);
  }

  /**
   * Invalidate what an applied patch actually changed, and nothing more (§3.7).
   *
   * `appliedOperationTypes` are the operation types that just landed, and every scope now
   * consults them. Timeline-dependent evidence goes when the patch changed a facet that
   * evidence rests on ({@link facetsChangedBy} vs {@link facetsNeededBy}); transcript- and
   * asset-derived evidence goes when the transcript was rewritten or the bin changed.
   * Returns how many entries were dropped, for the observability record.
   *
   * WHY the timeline arm reads the types at all: it used to drop every
   * `timeline_dependent` entry on ANY applied patch, which charged a re-render of an
   * unchanged frame to operations that cannot change one. An empty `appliedOperationTypes`
   * — a mutating tool that legitimately had nothing to do — now correctly invalidates
   * nothing, because nothing was applied.
   */
  public invalidate(appliedOperationTypes: readonly string[]): number {
    const transcriptRewritten = appliedOperationTypes.includes(TRANSCRIPT_OPERATION);
    const binChanged = appliedOperationTypes.some((type) => ASSET_OPERATIONS.has(type));
    const changedFacets = new Set(appliedOperationTypes.flatMap(facetsChangedBy));
    let dropped = 0;
    for (const entry of [...this.byKey.values()]) {
      const scope = scopeOf(entry.source);
      const stale =
        (scope === 'timeline_dependent' &&
          facetsNeededBy(entry.source).some((facet) => changedFacets.has(facet))) ||
        (transcriptRewritten && scope === 'transcript_dependent') ||
        (binChanged && scope === 'asset_dependent');
      if (!stale) continue;
      this.byKey.delete(entry.key);
      this.byId.delete(entry.id);
      dropped += 1;
    }
    if (dropped > 0) {
      // The facets are logged with the count because "why did my frame get re-rendered?"
      // is unanswerable from the count alone.
      log.debug('evidence invalidated', {
        dropped,
        kept: this.byKey.size,
        facets: [...changedFacets].join(','),
      });
    }
    return dropped;
  }
}
