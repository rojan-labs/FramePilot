/**
 * @framepilot/ai-sdk/kernel/recipe-leaves — the deterministic leaf executors
 * (plan/AGENT-NATIVE-COMPLETION-PLAN.md P1.2/P2.1).
 *
 * A recipe's Task DAG (from {@link compileRecipe}) is made of two kinds of node:
 *  - a **host_tool** leaf (`analyze_silence`, …) the {@link EffectRuntime} runs against
 *    the engine sidecar — real media analysis, executed elsewhere; and
 *  - **pure** leaves (`synth_ripple_deletes`, `assemble_patch`, `verify`) that turn the
 *    analysis data into validated, reversible `editor-core` operations with **zero model
 *    calls** and no I/O.
 *
 * This module is those pure leaves — the "recipe *is* a plan" deterministic core (§8.2).
 * Each leaf is a pure function of `(project, args, upstream results)` → a
 * {@link RecipeTaskOutput}, so a recipe run is replayable and table-testable. The
 * {@link RecipeExecutor} owns scheduling and event emission; this module owns the
 * timeline-editing semantics.
 */
import {
  type AnyOperation,
  type CaptionSegmentConfig,
  type DerivedCue,
  applyProjectPatch,
  buildTimelineMap,
  captionSegmentConfig,
  deriveCaptionCues,
  presetForWordsPerLine,
  punchInKeyframes,
} from '@framepilot/editor-core';
import type { Clip, Project } from '@framepilot/timeline-schema';
import {
  DEFAULT_CAPTION_TEMPLATE_ID,
  getCaptionTemplate,
} from '@framepilot/timeline-schema/caption-templates';
import { createLogger, type Seconds } from '@framepilot/shared-types';
import { type EditResult, assembleEdit } from '../assemble.js';
import { type CritiqueOptions, type CritiqueReport, critique } from '../critic.js';
import type { TargetPlatform } from '../context-builder.js';
import type { TaskId } from './task-graph.js';

const log = createLogger('ai-sdk:kernel:recipe-leaves');
const ASSEMBLY_VALIDATION_ISSUE_LIMIT = 8;

/**
 * The normalized output of one recipe task, stored by the executor and read by
 * downstream leaves via {@link LeafContext.upstream}. A host_tool task contributes
 * `data`; a synthesis leaf contributes `operations`; the assemble leaf contributes a
 * validated `edit`; the verify leaf contributes a `verdict`.
 */
export interface RecipeTaskOutput {
  /** Raw host-tool result payload (e.g. `{ ranges: [...] }` from `analyze_silence`). */
  readonly data?: unknown;
  /** An intermediate analysis value a downstream leaf reads (e.g. caption cues, hook time). */
  readonly value?: unknown;
  /** Operations a synthesis leaf produced (fed into `assemble_patch`). */
  readonly operations?: readonly AnyOperation[];
  /** The assembled, validated (when applicable) patch — drives the terminal diff. */
  readonly edit?: EditResult;
  /** A verify leaf's verdict. */
  readonly verdict?: { readonly ok: boolean; readonly summary: string };
  /**
   * The real technical-safety battery's full report (P11.5), when the `verify` leaf ran
   * it — i.e. whenever it had a validated patch to check. Additive: only the `verify`
   * leaf sets this; every other leaf's output is unaffected. Lets a caller (or a test,
   * P11.6) inspect exactly which checks ran, not just the folded `verdict.ok`.
   */
  readonly critique?: CritiqueReport;
  /** One-line human summary for the task's card. */
  readonly summary?: string;
  /** A `host_tool` leaf failed specifically because no analysis engine is connected. */
  readonly engineUnavailable?: boolean;
  /** The recipe referenced a leaf this executor does not implement. */
  readonly unsupported?: boolean;
}

/** What a pure leaf is handed: the working project, its args, and upstream outputs. */
export interface LeafContext {
  readonly project: Project;
  readonly args: Readonly<Record<string, unknown>>;
  /** The recipe's human rationale, recorded on the assembled patch. */
  readonly reason: string;
  /**
   * The patch the run has assembled so far (from an upstream `assemble_patch` task),
   * threaded by the executor so a `verify` leaf can self-check it without a `from` ref.
   */
  readonly runEdit?: EditResult;
  /** Read a completed upstream task's normalized output by id (`undefined` if absent). */
  upstream(id: TaskId): RecipeTaskOutput | undefined;
}

/** A pure, deterministic recipe leaf. Throws {@link RecipeLeafError} on bad input. */
export type RecipeLeaf = (ctx: LeafContext) => RecipeTaskOutput;

/** Registry of pure leaves by effect name (the executor dispatches `analysis`/`patch`/`verify`). */
export type RecipeLeafRegistry = Readonly<Record<string, RecipeLeaf>>;

/** A recipe leaf received input it cannot honestly turn into an edit (never fabricates one). */
export class RecipeLeafError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeLeafError';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** One time span read from an analysis result (seconds). */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Read the `{ start, end }` spans out of a host-tool analysis payload. `analyze_silence`
 * returns `{ ranges: [{ start, end, duration }] }`; we accept `ranges` (silence) and only
 * keep well-formed, positive-length spans so a malformed row can never synthesize a
 * negative-length delete.
 */
function readSpans(data: unknown): Span[] {
  const record = (data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(record.ranges) ? record.ranges : [];
  const spans: Span[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    if (typeof r.start === 'number' && typeof r.end === 'number' && r.end > r.start) {
      spans.push({ start: r.start, end: r.end });
    }
  }
  return spans;
}

/**
 * Resolve the track a track-scoped edit targets: an explicit `track` arg wins, else the
 * first track that actually has clips (silence/pacing edits are meaningless on an empty
 * track), else the first track. Throws when the timeline has no track at all.
 */
function resolveTargetTrackId(project: Project, arg: unknown): string {
  const tracks = project.timeline.tracks;
  if (typeof arg === 'string' && arg.length > 0) {
    const named = tracks.find((t) => t.id === arg);
    if (!named) throw new RecipeLeafError(`No track "${arg}" in the timeline.`);
    return named.id;
  }
  const withClips = tracks.find((t) => t.clips.length > 0);
  if (withClips) return withClips.id;
  const first = tracks[0];
  if (!first) throw new RecipeLeafError('The timeline has no track to edit.');
  return first.id;
}

/** Read the upstream task named by `args.from`, or throw a specific error. */
function requireUpstream(ctx: LeafContext, argName = 'from'): RecipeTaskOutput {
  const id = ctx.args[argName];
  if (typeof id !== 'string') {
    throw new RecipeLeafError(`Leaf is missing its "${argName}" upstream reference.`);
  }
  const output = ctx.upstream(id);
  if (!output) throw new RecipeLeafError(`Upstream task "${id}" produced no result.`);
  return output;
}

// ---------------------------------------------------------------------------
// remove_silence leaves (P1)
// ---------------------------------------------------------------------------

/**
 * `synth_ripple_deletes`: turn detected silent ranges into ripple-delete operations on
 * the target track. **Ordered latest-first** — each ripple-delete closes its gap and
 * shifts later content left, so applying earlier deletes first would invalidate the
 * timeline coordinates of the later ones. Sorting by descending start keeps every op's
 * `[start, end)` valid against the same original timeline the ranges were measured on.
 */
const synthRippleDeletes: RecipeLeaf = (ctx) => {
  const spans = readSpans(requireUpstream(ctx).data);
  const trackId = resolveTargetTrackId(ctx.project, ctx.args.track);
  const operations: AnyOperation[] = [...spans]
    .sort((a, b) => b.start - a.start)
    .map((s) => ({
      type: 'ripple_delete',
      trackId,
      start: s.start as Seconds,
      end: s.end as Seconds,
    }));
  const n = operations.length;
  return { operations, summary: `Synthesized ${n} ripple delete${n === 1 ? '' : 's'}` };
};

/**
 * `assemble_patch`: bundle an upstream leaf's operations into one validated, reversible
 * {@link EditResult} (the single patch-assembly path, {@link assembleEdit}). No mutation —
 * the executor's caller applies the validated patch. An upstream that produced no
 * operations yields an empty (valid, no-op) edit, which the caller reports honestly as
 * "nothing to change" rather than a fabricated success.
 */
const assemblePatch: RecipeLeaf = (ctx) => {
  const from = ctx.args.from;
  const ids = typeof from === 'string' ? [from] : Array.isArray(from) ? from : [];
  if (ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
    throw new RecipeLeafError('Leaf is missing its "from" upstream reference.');
  }
  const operations = ids.flatMap((id) => {
    const output = ctx.upstream(String(id));
    if (!output) throw new RecipeLeafError(`Upstream task "${String(id)}" produced no result.`);
    return output.operations ?? [];
  });
  const edit = assembleEdit(ctx.project, [...operations], ctx.reason);
  const n = operations.length;
  log.action('assemble_patch → assembled', { operations: n, valid: edit.validation.valid });
  const summary = edit.validation.valid
    ? `Assembled patch with ${n} operation${n === 1 ? '' : 's'}`
    : (() => {
        const errors = edit.validation.issues.filter((issue) => issue.severity === 'error');
        const shown = errors
          .slice(0, ASSEMBLY_VALIDATION_ISSUE_LIMIT)
          .map((issue) => issue.message);
        const omitted = errors.length - shown.length;
        return `Patch validation failed: ${shown.join('; ')}${
          omitted > 0 ? `; plus ${String(omitted)} more error(s)` : ''
        }`;
      })();
  return { edit, operations, summary };
};

/** Platforms {@link CritiqueOptions.targetPlatform} recognises (mirrors `context-builder.ts`). */
const TARGET_PLATFORMS: ReadonlySet<string> = new Set([
  'reels',
  'tiktok',
  'shorts',
  'linkedin',
  'x',
]);

/** Read a `verify` step's optional `durationTargetSeconds`/`targetPlatform` args (both
 *  honestly absent unless a caller — recipe or Planner-authored plan — actually set
 *  them; an absent/malformed value just widens the corresponding check to `skipped`,
 *  never a fabricated target). */
function critiqueArgsFrom(
  args: LeafContext['args'],
): Pick<CritiqueOptions, 'durationTargetSeconds' | 'targetPlatform'> {
  const duration = args.durationTargetSeconds;
  const platform = args.targetPlatform;
  return {
    ...(typeof duration === 'number' ? { durationTargetSeconds: duration } : {}),
    ...(typeof platform === 'string' && TARGET_PLATFORMS.has(platform)
      ? { targetPlatform: platform as TargetPlatform }
      : {}),
  };
}

/**
 * `verify`: the shared self-check every recipe **and** the live planner path (P11.5,
 * the planner path defaults to this same `RECIPE_LEAVES` registry unchanged) run
 * before a patch is offered for review. Two tiers, both honest:
 *
 *  1. **Structural** — the assembled patch must have validated against the working
 *     timeline; an invalid/fabricated edit fails here immediately, before the battery
 *     ever runs (mirrors the pre-P11.5 behavior exactly).
 *  2. **Technical** — once structurally valid, run the SAME deterministic
 *     `critique()` battery (`critic.ts`) the sequential agent path already runs on
 *     every turn (`orchestrator.ts`'s `critiqueOptions`/`critique` calls) — not just
 *     patch validity. This is technical safety only (request_match, duration_target,
 *     caption_alignment, safe_area, missing_assets, export_settings, and the
 *     render-gated pixel checks, which stay `skipped` here since a recipe/planner run
 *     has no preview render to check against) — never an aesthetic/"is this good"
 *     judgement, which stays the editor's call (P8.5 preview-first review).
 *
 * Does not re-run media analysis or render a preview (that would violate the
 * render-vs-preview rule inside a pure leaf); the render-gated checks degrade
 * honestly to `skipped` exactly as they do on every other path with no render yet.
 */
const verify: RecipeLeaf = (ctx) => {
  const goal = typeof ctx.args.goal === 'string' ? ctx.args.goal : 'goal';
  const edit = findAssembledEdit(ctx);
  if (!edit) {
    // No patch upstream (e.g. an export recipe): nothing to structurally verify here.
    log.action('verify → no patch upstream, verified trivially', { goal });
    return { verdict: { ok: true, summary: `Verified: ${goal}` }, summary: `Verified: ${goal}` };
  }
  if (!edit.validation.valid) {
    const summary = `Verification failed: patch did not validate (${goal})`;
    log.warn('verify → patch failed structural validation', { goal });
    return { verdict: { ok: false, summary }, summary };
  }
  const working = applyProjectPatch(ctx.project, edit.patch);
  const options: CritiqueOptions = {
    userPrompt: ctx.reason,
    producedChanges: edit.patch.operations.length > 0,
    ...critiqueArgsFrom(ctx.args),
  };
  const report = critique(working, options);
  const summary = report.ok
    ? `Verified: ${goal} (${report.summary})`
    : `Verification failed: ${report.summary} (${goal})`;
  log.action('verify → verdict', { goal, ok: report.ok });
  return { verdict: { ok: report.ok, summary }, summary, critique: report };
};

/** Find the assembled {@link EditResult} the verify task self-checks. */
function findAssembledEdit(ctx: LeafContext): EditResult | undefined {
  // An explicit `from` wins; otherwise use the edit the executor threaded in.
  const from = ctx.args.from;
  if (typeof from === 'string') return ctx.upstream(from)?.edit;
  return ctx.runEdit;
}

// ---------------------------------------------------------------------------
// add_captions leaves (P2) — transcript → caption layers
// ---------------------------------------------------------------------------

/**
 * The segmentation config for a caption template: the catalog's
 * `suggestedWordsPerLine` (1 for the one-word family) picks the preset, so
 * generated cues match the template's intended grouping. An unknown or absent
 * template falls back to the segmenter's own default.
 */
function segmentConfigFor(templateId: unknown): CaptionSegmentConfig {
  const suggested =
    typeof templateId === 'string'
      ? getCaptionTemplate(templateId)?.suggestedWordsPerLine
      : undefined;
  return suggested === undefined
    ? captionSegmentConfig()
    : captionSegmentConfig(presetForWordsPerLine(suggested));
}

/**
 * `transcript_cues`: derive caption cues from the transcript **and the edited
 * timeline**.
 *
 * Delegates to the SHARED derivation in editor-core (ADR 0071 for segmentation,
 * ADR 0076 for the mapping), so this and the Captions panel cannot disagree.
 *
 * This leaf used to pass `project.transcript` straight to the segmenter, which
 * meant the cues carried **source** timestamps: correct on an unedited timeline,
 * and wrong from the first cut onward on any edited one. Since `add_captions`
 * runs *after* the structural edit in every recipe that has one, that was the
 * common case, not the edge case — captions landed at the times the words were
 * spoken in the camera file rather than the times they play in the sequence.
 *
 * Still pure and deterministic: the transcript and the timeline are both already
 * in the project doc, so captions need no model and no engine.
 */
const transcriptCues: RecipeLeaf = (ctx) => {
  const map = buildTimelineMap(ctx.project.timeline);
  const cues = deriveCaptionCues(
    map,
    ctx.project.transcript,
    segmentConfigFor(ctx.args.templateId),
  );
  return { value: cues, summary: `Read ${cues.length} caption cue${cues.length === 1 ? '' : 's'}` };
};

/** Resolve a caption/overlay track for captions; throw honestly when none exists. */
function resolveCaptionTrack(project: Project): { id: string; clips: readonly Clip[] } {
  const track = project.timeline.tracks.find((t) => t.type === 'caption' || t.type === 'overlay');
  if (!track) {
    throw new RecipeLeafError(
      'No caption or overlay track to add captions to — add one to the timeline first.',
    );
  }
  return { id: track.id, clips: track.clips };
}

/**
 * True when a clip's id matches this leaf's own `caption_<trackId>_<startMs>`
 * stamping convention (see {@link clearExistingCaptions}) — i.e. it was
 * synthesized by a prior `synth_caption_layer` run on this track, not placed
 * there by anything else.
 */
function isCaptionClip(trackId: string, clip: Clip): boolean {
  return clip.id.startsWith(`caption_${trackId}_`);
}

/**
 * Clear the caption set already on the track, so a regeneration replaces it
 * rather than colliding with it.
 *
 * Caption clip ids are derived from the cue's start time
 * (`caption_<trackId>_<startMs>`), which makes them stable across regenerations
 * of the same transcript — the property that lets a re-run be recognizable
 * instead of duplicative. The cost is that `insertClip` rejects an id that is
 * already on the track, so asking for captions a second time (a different
 * template, a re-transcribe, a changed cut) threw `duplicate_clip` on the first
 * cue and took the whole patch down with it. Since the segmentation config
 * changes with the template, the second set is not even the same cues, so
 * skipping the collisions would leave two segmentations interleaved.
 *
 * `resolveCaptionTrack` accepts an `overlay`-type track as a fallback when a
 * project has no dedicated caption track — the same track type other tools
 * default new tracks to for logos/watermarks/graphics. Clearing by the whole
 * track's clip extent would delete that unrelated content too, so this only
 * ever considers clips that carry the `caption_<trackId>_` id stamp: one
 * non-rippling `delete_range` per caption clip's own span, each inverting to a
 * `restore_clips` — so "add captions again" stays one undo away from the
 * previous set without touching anything else sharing the track.
 */
function clearExistingCaptions(trackId: string, clips: readonly Clip[]): AnyOperation[] {
  return clips
    .filter((clip) => isCaptionClip(trackId, clip))
    .map((clip) => ({ type: 'delete_range', trackId, start: clip.start, end: clip.end }) as const);
}

/**
 * `synth_caption_layer`: lay the upstream cues onto the caption track.
 *
 * Per cue, an `add_caption_layer` plus a `set_caption_cue` carrying the cue's own
 * text and word timings (schema v11, ADR 0071) — so an AI-generated caption is
 * editable afterwards exactly like a hand-made one, and does not silently change
 * when the transcript is re-run.
 *
 * The template is stamped ONCE as the track default (`set_track_caption_style`)
 * rather than per cue: a 400-cue project was previously 400 style operations, and
 * the track default is what lets the user restyle the whole set in one move.
 * `args.templateId` is used when it names a real catalog entry; an unknown id
 * falls back rather than failing the recipe.
 */
const synthCaptionLayer: RecipeLeaf = (ctx) => {
  const cues = (requireUpstream(ctx).value as DerivedCue[] | undefined) ?? [];
  const { id: trackId, clips: existing } = resolveCaptionTrack(ctx.project);
  const requested = ctx.args.templateId;
  const templateId =
    typeof requested === 'string' && getCaptionTemplate(requested) !== undefined
      ? requested
      : DEFAULT_CAPTION_TEMPLATE_ID;
  // No cues ⇒ no operations at all, not even the track style: styling a caption
  // set that does not exist would make an empty transcript produce a non-empty
  // patch, which reads as "something happened" when nothing did. Deliberately
  // this does NOT clear the existing captions either — an empty transcript is a
  // reason to leave the user's caption set alone, not to delete it.
  if (cues.length === 0) {
    return { operations: [], summary: 'Synthesized 0 caption layers' };
  }
  const cleared = clearExistingCaptions(trackId, existing);
  const operations: AnyOperation[] = [
    ...cleared,
    { type: 'set_track_caption_style', trackId, captionStyle: { templateId } },
    ...cues.flatMap((cue) => {
      // Start-time-derived id: stable across regenerations of the same
      // transcript, and unique within one run since cues never overlap.
      const clipId = `caption_${trackId}_${Math.round(cue.start * 1000)}`;
      return [
        {
          type: 'add_caption_layer' as const,
          trackId,
          start: cue.start as Seconds,
          end: cue.end as Seconds,
          clipId,
        },
        {
          type: 'set_caption_cue' as const,
          clipId,
          captionCue: {
            text: cue.text,
            words: [...cue.words],
            // Provenance, so a later structural edit makes this cue detectably
            // stale instead of silently wrong (ADR 0076).
            derivedFromRevision: cue.revision,
            source: {
              assetId: cue.assetId,
              clipId: cue.clipId,
              start: cue.sourceStart,
              end: cue.sourceEnd,
            },
          },
        },
      ];
    }),
  ];
  const n = cues.length;
  const replaced = cleared.length > 0 ? `, replacing ${cleared.length}` : '';
  return {
    operations,
    summary: `Synthesized ${n} caption layer${n === 1 ? '' : 's'} (${templateId})${replaced}`,
  };
};

// ---------------------------------------------------------------------------
// improve_pacing leaves (P2) — tighten by cutting detected dead air
// ---------------------------------------------------------------------------

/**
 * `diagnose_pacing`: a pure diagnostic pass. Today it forwards the target range so the
 * synthesis step can scope its work; richer transcript-driven slow-segment detection is a
 * later refinement. Kept as its own node so the DAG shape (a parallel fan-in with the
 * silence analysis) matches the design and can grow without a recompile.
 */
const diagnosePacing: RecipeLeaf = (ctx) => ({
  value: { range: ctx.args.range ?? null },
  summary: 'Diagnosed pacing',
});

/**
 * `synth_pacing_ops`: tighten pacing by ripple-deleting the detected silent gaps (the
 * honest, deterministic core of "improve pacing" — cut the dead air). Reads the silence
 * ranges from whichever upstream (the `analyze_silence` host tool) carried them, and
 * emits latest-first ripple deletes just like `synth_ripple_deletes`.
 */
const synthPacingOps: RecipeLeaf = (ctx) => {
  const from = ctx.args.from;
  const ids = Array.isArray(from) ? from : typeof from === 'string' ? [from] : [];
  let spans: Span[] = [];
  for (const id of ids) {
    const up = ctx.upstream(String(id));
    if (up?.data !== undefined) {
      spans = readSpans(up.data);
      break;
    }
  }
  const trackId = resolveTargetTrackId(ctx.project, ctx.args.track);
  const operations: AnyOperation[] = [...spans]
    .sort((a, b) => b.start - a.start)
    .map((s) => ({
      type: 'ripple_delete',
      trackId,
      start: s.start as Seconds,
      end: s.end as Seconds,
    }));
  const n = operations.length;
  return { operations, summary: `Tightened pacing: ${n} cut${n === 1 ? '' : 's'}` };
};

// ---------------------------------------------------------------------------
// add_hook leaves (P2) — open on the hook by cutting the dead lead-in
// ---------------------------------------------------------------------------

/** Dead lead-in (s) below which the opening already lands on the hook (no edit). */
const HOOK_LEAD_IN_THRESHOLD = 0.3;

/**
 * `find_hook`: the deterministic "strongest hook" heuristic — open on the first spoken
 * word. Returns where the dead lead-in before speech ends (0 when the transcript is empty
 * or speech starts immediately). A model-scored hook is a later refinement (kept honest:
 * this is a defensible, reversible open-on-the-first-word, not a fabricated judgement).
 */
const findHook: RecipeLeaf = (ctx) => {
  const first = ctx.project.transcript[0];
  const leadInEnd = first ? first.start : 0;
  return {
    value: { leadInEnd },
    summary:
      leadInEnd > HOOK_LEAD_IN_THRESHOLD
        ? `Hook (first word) starts at ${leadInEnd.toFixed(2)}s`
        : 'Already opens on the hook',
  };
};

/** `synth_hook_restructure`: ripple-delete the dead lead-in so the video opens on the hook. */
const synthHookRestructure: RecipeLeaf = (ctx) => {
  const leadInEnd =
    (requireUpstream(ctx).value as { leadInEnd?: number } | undefined)?.leadInEnd ?? 0;
  const trackId = resolveTargetTrackId(ctx.project, ctx.args.track);
  const operations: AnyOperation[] =
    leadInEnd > HOOK_LEAD_IN_THRESHOLD
      ? [{ type: 'ripple_delete', trackId, start: 0 as Seconds, end: leadInEnd as Seconds }]
      : [];
  return {
    operations,
    summary:
      operations.length > 0
        ? `Trimmed ${leadInEnd.toFixed(2)}s dead lead-in`
        : 'No dead lead-in to trim',
  };
};

// ---------------------------------------------------------------------------
// punch_in leaf (P2) — animated zoom on the target clip
// ---------------------------------------------------------------------------

/** Resolve the clip a punch-in targets: an explicit clip id, else the first clip. */
function resolveTargetClip(
  project: Project,
  target: unknown,
): { clipId: string; duration: number } {
  const named = typeof target === 'string' && target !== 'selection' ? target : undefined;
  for (const track of project.timeline.tracks) {
    const clip = named ? track.clips.find((c) => c.id === named) : track.clips[0];
    if (clip) return { clipId: clip.id, duration: clip.end - clip.start };
  }
  throw new RecipeLeafError(
    named ? `No clip "${named}" to punch in.` : 'No clip on the timeline to punch in.',
  );
}

/** `synth_punch_in`: an `add_keyframes` scale ramp (reusing the shared `punchInKeyframes`). */
const synthPunchIn: RecipeLeaf = (ctx) => {
  const { clipId, duration } = resolveTargetClip(ctx.project, ctx.args.target);
  const zoom = typeof ctx.args.zoom === 'number' ? ctx.args.zoom : 1.2;
  const keyframes = punchInKeyframes({
    idPrefix: `punch_${clipId}`,
    startTime: 0 as Seconds,
    endTime: duration as Seconds,
    toScale: zoom,
  });
  return {
    operations: [{ type: 'add_keyframes', clipId, keyframes }],
    summary: `Punch-in ${zoom}× on ${clipId}`,
  };
};

// ---------------------------------------------------------------------------
// filler_cleanup leaves (H1.4) — Descript-style "remove filler words and
// tighten awkward pauses", entirely off the project's own word-level
// transcript. Zero model calls: a fixed, honest filler-word lexicon plus the
// same gap-computation shape as `transcriptToCues`.
// ---------------------------------------------------------------------------

/**
 * The fixed filler-word lexicon (case-insensitive, punctuation-stripped exact match
 * against a single transcript word). Deliberately **excludes** "like" and multi-word
 * fillers such as "you know": "like" is an extremely overloaded real word (comparison,
 * similarity, the verb "to like"), and a 0-model recipe has no judgement to tell a filler
 * "like" from a meaningful one — silently cutting a meaningful word would violate the
 * honesty rule (a wrong-but-silent edit is worse than a smaller, honest one). Multi-word
 * phrases would need consecutive-word matching the single-word spans below don't support
 * yet; left out rather than special-cased.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set(['um', 'uh', 'erm', 'er', 'hmm']);

/** Lowercase and strip punctuation so "Um," / "UH!" / "erm" all match the lexicon. */
function normalizeFillerWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Gap between words (s) past which a pause reads as "awkward" rather than natural speech
 * rhythm.
 *
 * This used to borrow the caption segmenter's single hard-coded 0.8s gap. Caption
 * segmentation is now preset-driven (`CAPTION_SEGMENT_PRESETS` — 0.55s for
 * short-form, 0.7s for subtitles), so there is no single caption gap left to
 * borrow, and pacing should not silently change with the user's caption preset
 * anyway. Keeps the original 0.8s value and states its own rationale: eight
 * tenths of a second of dead air between words is noticeable to a viewer without
 * catching the ordinary breaths that make speech sound human.
 */
const AWKWARD_PAUSE_SECONDS = 0.8;

/**
 * The pause length (s) an awkward gap is tightened *down to*, not deleted to zero. A hard
 * cut to 0s reads as an unnatural jump-cut; ~0.25s keeps a natural breath/beat while
 * removing the dead air.
 */
const TIGHTENED_PAUSE_SECONDS = 0.25;

/**
 * `detect_filler_cleanup`: scan the project's transcript for filler-word spans and
 * awkward-pause spans (pure, reads `project.transcript` directly — no host tool, same as
 * `find_hook`). An empty transcript is reported honestly (zero of each, not an error) —
 * matching how `transcript_cues`/`find_hook` degrade when no transcript exists yet.
 */
const detectFillerCleanup: RecipeLeaf = (ctx) => {
  const words = ctx.project.transcript;
  const fillerSpans: Span[] = [];
  for (const w of words) {
    if (FILLER_WORDS.has(normalizeFillerWord(w.word))) {
      fillerSpans.push({ start: w.start, end: w.end });
    }
  }
  const pauseSpans: Span[] = [];
  let prevEnd: number | null = null;
  for (const w of words) {
    if (prevEnd !== null && w.start - prevEnd > AWKWARD_PAUSE_SECONDS) {
      pauseSpans.push({ start: prevEnd + TIGHTENED_PAUSE_SECONDS, end: w.start });
    }
    prevEnd = w.end;
  }
  const summary =
    words.length === 0
      ? 'No transcript yet — nothing to clean up'
      : `Found ${fillerSpans.length} filler word${fillerSpans.length === 1 ? '' : 's'} and ` +
        `${pauseSpans.length} awkward pause${pauseSpans.length === 1 ? '' : 's'}`;
  return { value: { fillerSpans, pauseSpans }, summary };
};

/**
 * `synth_filler_deletes`: turn the detected filler-word spans and tightened-pause spans
 * into one **latest-first** ripple-delete sequence, exactly like `synth_ripple_deletes` —
 * both kinds of cut share the same track and timeline coordinates, so they must be ordered
 * together (not filler-then-pause) to keep every op's `[start, end)` valid.
 */
const synthFillerDeletes: RecipeLeaf = (ctx) => {
  const detected = requireUpstream(ctx).value as
    | { fillerSpans?: Span[]; pauseSpans?: Span[] }
    | undefined;
  const spans = [...(detected?.fillerSpans ?? []), ...(detected?.pauseSpans ?? [])];
  const trackId = resolveTargetTrackId(ctx.project, ctx.args.track);
  const operations: AnyOperation[] = [...spans]
    .sort((a, b) => b.start - a.start)
    .map((s) => ({
      type: 'ripple_delete',
      trackId,
      start: s.start as Seconds,
      end: s.end as Seconds,
    }));
  const n = operations.length;
  return {
    operations,
    summary: `Cleaned up ${n} filler word${n === 1 ? '' : 's'}/pause${n === 1 ? '' : 's'}`,
  };
};

/**
 * The pure leaves the {@link RecipeExecutor} can dispatch. P1 shipped the `remove_silence`
 * spine; P2 adds the synthesis leaves for `add_captions`, `improve_pacing`, `add_hook`, and
 * `punch_in`. (`export_reels` is a render, not a patch — the caller routes it to the Export
 * flow rather than a leaf here.) H1.4 adds `filler_cleanup`. All share the one executor +
 * the single `assemble_patch` + `verify` tail.
 */
export const RECIPE_LEAVES: RecipeLeafRegistry = {
  // remove_silence
  synth_ripple_deletes: synthRippleDeletes,
  // add_captions
  transcript_cues: transcriptCues,
  synth_caption_layer: synthCaptionLayer,
  // improve_pacing
  diagnose_pacing: diagnosePacing,
  synth_pacing_ops: synthPacingOps,
  // add_hook
  find_hook: findHook,
  synth_hook_restructure: synthHookRestructure,
  // punch_in
  synth_punch_in: synthPunchIn,
  // filler_cleanup
  detect_filler_cleanup: detectFillerCleanup,
  synth_filler_deletes: synthFillerDeletes,
  // shared tail
  assemble_patch: assemblePatch,
  verify,
};
