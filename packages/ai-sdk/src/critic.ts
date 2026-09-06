/**
 * @framepilot/ai-sdk/critic — the deterministic Critic / Review agent (PRD §8.6).
 *
 * After the agent edits (or at any time the user asks "review this edit"), the
 * Critic runs a fixed battery of checks over the resulting project and reports
 * what passed, what is worth a warning, and what is an outright failure. It is
 * the agent's *self-check* (plan/PLAN.md Phase 7) and a standalone review tool.
 *
 * ## Why this is pure and deterministic (no LLM)
 *
 * A reviewer must be trustworthy and reproducible — the same project must always
 * yield the same verdict, and a misbehaving model must never be able to talk the
 * Critic into approving a broken edit. So every check here is plain code over the
 * timeline. Two checks (black frames, audio clipping) genuinely require pixels and
 * samples that only the Python render engine can produce; for those the Critic
 * accepts an optional {@link RenderValidationInput} (the result of the existing
 * `validate_render` pass on an auto preview render) and reports `skipped` when no
 * render was run rather than fabricating a pass (build-order honesty, AGENTS.md).
 */
import {
  CAPTION_ASSET_ID,
  TEXT_OVERLAY_ASSET_ID,
  buildTimelineMap,
  listEditBoundaries,
  mapTranscript,
  speechAssetIdsFor,
} from '@framepilot/editor-core';
import type { Clip, Effect, Project, Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';
import {
  COVERAGE_LABEL,
  mentionsUnreadableShotCount,
  type CoverageTreatment,
} from './acceptance.js';
import type { TargetPlatform } from './context-builder.js';
import type { TemporalReviewReport } from './temporal-review.js';
import { hiddenPictureClips } from './domain-tools/picture-layers.js';
import { frameToSeconds, secondsToFrame } from './frame-time.js';
import { overflowingWords } from './overlay-fit.js';
import type { VisionReviewReport } from './vision-review.js';

/** Outcome of a single Critic check. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

/** The fixed set of checks the Critic runs, mirroring PRD §8.6. */
export type CheckId =
  | 'request_match'
  | 'picture_present'
  | 'picture_coverage'
  | 'hidden_picture'
  | 'duration_target'
  | 'shot_count'
  | 'shot_length_target'
  | 'reframe_coverage'
  | 'treatment_coverage'
  | 'caption_alignment'
  | 'safe_area'
  | 'audio_clipping'
  | 'black_frames'
  | 'temporal_evidence'
  | 'vision_review'
  | 'missing_assets'
  | 'export_settings'
  | 'transcript_reliable'
  // Editorial checks (context-management Phase 4). Everything above answers "is the
  // deliverable well-formed?"; these answer "is this a good cut?".
  | 'jump_cut'
  | 'word_severed'
  | 'dead_air'
  | 'transition_fit'
  | 'audio_slam'
  | 'shot_rhythm';

/** One check's verdict + a human-readable explanation. */
export interface CriticCheck {
  readonly id: CheckId;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** The Critic's full report. `ok` is false when any check failed. */
export interface CritiqueReport {
  readonly checks: readonly CriticCheck[];
  /** True when no check has status `fail` (warnings do not block). */
  readonly ok: boolean;
  /** One-line headline summarising the verdict. */
  readonly summary: string;
}

/**
 * Render-derived facts the Critic cannot compute from the timeline alone. These
 * come from the Python `validate_render` pass over an auto preview render. When
 * absent, the pixel/sample checks report `skipped` (not `pass`).
 */
export interface RenderValidationInput {
  /** True if the render validator flagged (near-)black frames. */
  readonly hasBlackFrames?: boolean;
  /** True if the render validator flagged audio clipping (peak ≈ 0 dBFS). */
  readonly audioClipping?: boolean;
}

export interface CritiqueOptions {
  /** The user's original request, used for the request-match heuristic. */
  readonly userPrompt?: string;
  /** Whether the agent run produced any applied changes (request-match input). */
  readonly producedChanges?: boolean;
  /** Target output duration in seconds (e.g. a 45s Reel), if the goal stated one. */
  readonly durationTargetSeconds?: number;
  /** Allowed deviation from {@link durationTargetSeconds}. Defaults to 2s. */
  readonly durationToleranceSeconds?: number;
  /**
   * Fewest distinct shots the request asked for ("use at least 20 moments"), if it named a
   * number. Read deterministically from the prompt by `acceptance.ts`.
   */
  readonly minShotCount?: number;
  /**
   * The editor's request, verbatim, when the caller has it.
   *
   * Used only to tell "the brief asked for no shot count" apart from "the brief asked for one
   * and the reader could not see it" — a distinction that was invisible in the run record and
   * hid a reader bug through four rounds of gap analysis.
   */
  readonly request?: string;
  /**
   * Median picture-clip length, in seconds, that the cut is expected to hold.
   *
   * Not read from the prompt: nobody types "median shot 1.2 seconds". It comes from a
   * MEASURED reference the editor attached (`references/directives.ts`), which is the whole
   * point of measuring one — "make it feel like this" is otherwise a vibe no check can
   * settle, and the run finds out it missed only when the editor watches it.
   */
  readonly medianShotTargetSeconds?: number;
  /** Allowed deviation from {@link medianShotTargetSeconds}; the reference's own spread. */
  readonly medianShotToleranceSeconds?: number;
  /** Which reference set the target, so the check names it rather than asserting a number. */
  readonly medianShotSource?: string;
  /**
   * Treatments the request demanded of EVERY clip ("every clip reframed", "grade across
   * clips"), read deterministically from the prompt by `acceptance.ts`.
   */
  readonly coverage?: readonly CoverageTreatment[];
  /** Target platform, used to sanity-check export aspect ratio/orientation. */
  readonly targetPlatform?: TargetPlatform;
  /** Results of an auto preview render's validation, if one was run. */
  readonly render?: RenderValidationInput;
  /** Typed temporal/perceptual evidence report for command-critical windows. */
  readonly temporal?: TemporalReviewReport;
  /**
   * Semantic objectives judged by looking, for the questions no measurement
   * settles. Additive only: it can fail a review that measured clean, and can
   * never pass one that did not.
   */
  readonly vision?: VisionReviewReport;
  /**
   * Silence the run already measured, with the evidence handle it is filed under (P4.3).
   *
   * The critic is another consumer of the run's context, and it used to get a thinner view
   * than the planner did: a run that could see the whole transcript while planning saw
   * only the timeline while reviewing, and would approve cuts it would have rejected. This
   * is the channel for what the run LEARNED, and the handle rides along so a finding can
   * cite the turn it came from instead of asserting a number from nowhere.
   */
  readonly silences?: {
    readonly ranges: readonly { readonly start: number; readonly end: number }[];
    readonly handle?: string;
  };
}

/** Engine-provided sentinel asset ids that are valid without a project asset. */
const SYNTHETIC_ASSET_IDS = new Set<string>([TEXT_OVERLAY_ASSET_ID, CAPTION_ASSET_ID]);

const DEFAULT_DURATION_TOLERANCE = 2;

/** Safe-area inset (fraction of frame) overlays/captions should stay within. */
const SAFE_AREA_INSET = 0.1;

/** Platforms whose deliverable is vertical 9:16 (portrait). */
const VERTICAL_PLATFORMS: ReadonlySet<TargetPlatform> = new Set(['reels', 'tiktok', 'shorts']);

const round = (n: number): string => (Math.round(n * 1000) / 1000).toString();

/**
 * A figure that is explicitly PER-UNIT is a pacing spec, never a deliverable length.
 *
 * "0.3–0.6s per clip" is the shape every montage brief uses to describe cutting rhythm,
 * and reading it as the length of the finished video is not a near miss — it is off by
 * two orders of magnitude. Matched immediately after the number's unit.
 */
const PER_UNIT_QUALIFIER = /^\s*(?:\/|per\b|each\b|a |an )\s*(?:clip|shot|cut|frame|image|photo)/;

/**
 * Is the number that starts at `index` the far end of a RANGE ("0.3–0.6s")?
 *
 * A range states a spread the editor may work within; it does not name a target. Checked
 * by looking backwards for a dash of any flavour — ASCII hyphen, en dash, em dash — with
 * a number before it.
 */
function endsARange(text: string, index: number): boolean {
  return /\d\s*[-–—]\s*$/.test(text.slice(0, index));
}

/**
 * Read an explicit deliverable length from ordinary creator language.
 *
 * Deliberately conservative: a bare timestamp such as "cut at 30 seconds" is not a
 * duration target. A match must connect the number to a deliverable word (video,
 * montage, reel, short, timeline), an explicit length phrase ("make it … long"), or
 * the whole-output qualifiers "full"/"complete"/"entire".
 *
 * It was not conservative ENOUGH, and the gap failed a real run. The anchor list contains
 * verbs — `build`, `create`, `produce` — because that is how people ask ("build me a
 * 30-second reel"). But `build` is also a PACING PHASE, and a montage brief that wrote
 *
 *     ### BUILD
 *     Approximately:
 *     **0.3–0.6s per clip**
 *
 * matched the heading, skipped lazily past `0.3–`, and returned **0.6** as the length of a
 * fifty-clip montage. Run `f014f3ac` was then told "Timeline is 203.068s but the target is
 * 0.6s (off by 202.468s)" and reported itself failed for hitting a number nobody asked
 * for. Two structural guards close it, both of which read what the text actually says
 * rather than adding another anchor word: a per-unit figure is pacing
 * ({@link PER_UNIT_QUALIFIER}), and the far end of a range is not a target
 * ({@link endsARange}). Both generalise past this brief — every montage request describes
 * its rhythm this way.
 */
export function explicitDurationTargetSeconds(prompt: string): number | undefined {
  return explicitDurationTarget(prompt)?.seconds;
}

/**
 * A stated deliverable length, with the slack the request itself allowed.
 *
 * A brief that says "20–35 seconds" has not named one number and a tolerance nobody chose;
 * it has named an interval, and the honest target is its midpoint with the half-width as
 * the tolerance, so anything inside the stated range passes and nothing outside it does.
 */
export interface DurationTarget {
  readonly seconds: number;
  /** Half-width of a stated range. Absent when the request named a single length. */
  readonly toleranceSeconds?: number;
}

/**
 * Read an explicit deliverable length — a single length or a stated range.
 *
 * Ranges used to be dropped whole. {@link endsARange} exists to stop "0.3–0.6s per clip"
 * being read as a 0.6-second deliverable, and it did that by refusing the FAR end; the
 * near end was never matched in the first place, because in `20–35 seconds` only the far
 * number carries the unit. So a brief that stated its length as plainly as
 *
 *     **Duration:** Approximately 20–35 seconds
 *
 * yielded nothing at all. Run 4c9b5f82 delivered 10.0 seconds against it and
 * `duration_target` reported `skipped — no duration target was set`.
 *
 * Reading the range as an interval keeps the guard's actual intent (the far end alone is
 * never the target) while stopping the range from being silently discarded. `duration` and
 * `length` join the lead anchors for the same reason: that is the word the brief used, and
 * the deliverable noun sat ninety characters upstream under a `# FORMAT` heading.
 */
export function explicitDurationTarget(prompt: string): DurationTarget | undefined {
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  const unitValue = (value: string, unit: string): number => {
    const amount = Number(value);
    return /^m(?:in(?:ute)?s?)?$/.test(unit) ? amount * 60 : amount;
  };
  const units = '(s|sec|secs|second|seconds|m|min|mins|minute|minutes)';
  // `highlight`, `supercut`, `teaser` and `trailer` are deliverable nouns exactly as
  // `montage` and `reel` are — a request naming one has named the thing being made.
  // `best` carries the commonest idiom of all ("the best 60 seconds of this"), where the
  // deliverable is named by the length itself and no other anchor appears anywhere.
  const deliverables = 'video|montage|reel|short|timeline|highlight|supercut|teaser|trailer';
  const anchors =
    `full|complete|entire|${deliverables}|duration|length|runtime|run time|` +
    'make it|create|build|produce|export|best|' +
    // "Cut this down to 45 seconds" states a target as plainly as any phrasing here, and
    // was read as nothing. The OBJECT is what makes it safe to read: `this`, `it` or the
    // sequence itself is the whole deliverable, whereas "trim the first clip down to 5s"
    // is about one clip and must stay unread — which is why the bare preposition is not an
    // anchor on its own.
    `(?:cut|trim|shorten|tighten|bring|get)\\s+(?:this|it|the (?:${deliverables}))\\s+down to`;
  // A candidate survives only if it is neither the far end of a range nor qualified
  // per-clip. Scanning rather than taking the first hit: the brief that broke this had a
  // dozen pacing figures before any real length, and stopping at the first match would
  // still read one of them.
  const firstDeliverableLength = (
    pattern: RegExp,
    /** Index of the capture group holding the range's far end, when the pattern has one. */
    farGroup?: number,
  ): DurationTarget | undefined => {
    for (const match of normalized.matchAll(pattern)) {
      const value = match[1];
      const far = farGroup === undefined ? undefined : match[farGroup];
      const unit = match[farGroup === undefined ? 2 : farGroup + 1];
      if (value === undefined || unit === undefined) continue;
      // The capture's own offset, not a search for its text: an anchor phrase can contain
      // the same digits ("1080 x 1920 ... duration: 20-35 seconds"), and either a first- or
      // a last-match search picks the wrong one on some brief.
      const numberAt = match.indices?.[1]?.[0] ?? match.index + match[0].lastIndexOf(value);
      if (endsARange(normalized, numberAt)) continue;
      if (PER_UNIT_QUALIFIER.test(normalized.slice(match.index + match[0].length))) continue;
      const near = unitValue(value, unit);
      if (far === undefined) return { seconds: near };
      const end = unitValue(far, unit);
      // A malformed or degenerate range is one number stated twice; take it as one.
      if (!(end > near)) return { seconds: near };
      return { seconds: (near + end) / 2, toleranceSeconds: (end - near) / 2 };
    }
    return undefined;
  };
  // Ranges first: `20-35 seconds` also matches the single-length pattern at `35`, and that
  // match is the far end — the one reading the guard exists to refuse.
  const leadingRange = firstDeliverableLength(
    new RegExp(
      `\\b(?:${anchors})\\b.{0,40}?\\b(\\d+(?:\\.\\d+)?)\\s*(?:-|–|—|to)\\s*(\\d+(?:\\.\\d+)?)\\s*${units}\\b`,
      'gd',
    ),
    2,
  );
  if (leadingRange !== undefined) return leadingRange;
  const leading = firstDeliverableLength(
    new RegExp(`\\b(?:${anchors})\\b.{0,40}?\\b(\\d+(?:\\.\\d+)?)\\s*${units}\\b`, 'gd'),
  );
  if (leading !== undefined) return leading;
  const trailingRange = firstDeliverableLength(
    new RegExp(
      `\\b(\\d+(?:\\.\\d+)?)\\s*(?:-|–|—|to)\\s*(\\d+(?:\\.\\d+)?)\\s*[- ]?${units}\\b` +
        `.{0,28}?\\b(?:${deliverables}|long)\\b`,
      'gd',
    ),
    2,
  );
  if (trailingRange !== undefined) return trailingRange;
  return firstDeliverableLength(
    new RegExp(
      `\\b(\\d+(?:\\.\\d+)?)\\s*[- ]?${units}\\b.{0,28}?\\b(?:${deliverables}|long)\\b`,
      'gd',
    ),
  );
}

const allClips = (timeline: Timeline): readonly Clip[] =>
  timeline.tracks.flatMap((track) => track.clips);

// Layers are type-agnostic (Phase 2, ADR 0032): a clip's role is derived from its
// content — text overlays and captions are recognised by their synthetic asset ids
// (imported above), never by their layer's advisory type.
const isCaptionClip = (clip: Clip): boolean => clip.assetId === CAPTION_ASSET_ID;
const isOverlayClip = (clip: Clip): boolean =>
  clip.assetId === TEXT_OVERLAY_ASSET_ID || clip.assetId === CAPTION_ASSET_ID;

/** Every caption clip on the timeline, by clip kind (not by layer type). */
const captionClips = (timeline: Timeline): readonly Clip[] =>
  allClips(timeline).filter(isCaptionClip);

/** Every text-overlay or caption clip, by clip kind (not by layer type). */
const overlayOrCaptionClips = (timeline: Timeline): readonly Clip[] =>
  allClips(timeline).filter(isOverlayClip);

/**
 * Every clip that puts something ON THE SCREEN.
 *
 * Overlays and captions are excluded because they sit over the picture rather than being
 * it. **Audio is excluded because it is not picture** — which sounds too obvious to state
 * until you see what its absence did.
 *
 * Three checks derived "picture" as "not an overlay", which silently counted the music
 * bed. In run `f014f3ac` a fifty-clip montage request ended with exactly one clip on the
 * timeline — the track it had just downloaded — and `picture_present`, the check written
 * for precisely this failure (ADR 0144), reported **pass: 1 picture clip on the
 * timeline**. The one check that exists to say "there is no film here" was satisfied by a
 * sound file. `treatment_coverage` then told the run its audio clip was missing its
 * reframe ("own reframe: 0 of 1 clips"), which is not a sentence about anything.
 *
 * An asset the project does not list is treated as picture: a missing asset is
 * `checkMissingAssets`'s finding to report, and guessing "audio" here would hide a broken
 * reference behind a skipped check.
 */
function pictureClips(project: Project): readonly Clip[] {
  const audioAssetIds = new Set(
    project.assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.id),
  );
  return allClips(project.timeline).filter(
    (clip) => !isOverlayClip(clip) && !audioAssetIds.has(clip.assetId),
  );
}

/** End time of the latest clip on the timeline (0 for an empty timeline). */
export function timelineDuration(timeline: Timeline): number {
  return allClips(timeline).reduce((max, clip) => Math.max(max, clip.end), 0);
}

/**
 * Length of the actual media program — the latest video/audio clip end. Captions
 * and overlays sit *over* this content, so they must not define (or exceed) it.
 * Falls back to the full timeline duration when there is no video/audio content.
 */
function contentDuration(timeline: Timeline): number {
  // The media "program" is every clip that is NOT a text/caption overlay — those
  // sit *over* the content. Deriving by clip kind keeps this correct now that any
  // kind may live on any layer (Phase 2, ADR 0032).
  const content = allClips(timeline).filter((clip) => !isOverlayClip(clip));
  if (content.length === 0) return timelineDuration(timeline);
  return content.reduce((max, clip) => Math.max(max, clip.end), 0);
}

const check = (id: CheckId, label: string, status: CheckStatus, detail: string): CriticCheck => ({
  id,
  label,
  status,
  detail,
});

// ---------------------------------------------------------------------------
// Individual checks (one function each — single responsibility)
// ---------------------------------------------------------------------------

/** Did the agent actually do something in response to the request? */
function checkRequestMatch(options: CritiqueOptions): CriticCheck {
  if (options.producedChanges === false) {
    return check(
      'request_match',
      'Matches request',
      'warn',
      'The agent produced no timeline changes for the request — nothing to review.',
    );
  }
  return check(
    'request_match',
    'Matches request',
    'pass',
    'The agent produced edits in response to the request.',
  );
}

/** Is the output duration close to the stated target (e.g. a 45s Reel)? */
/**
 * Is there anything to look at?
 *
 * The check this battery did not have. Run e30c1fe9 finished a "30-second vertical Reel"
 * as fifteen text overlays over an empty video track: no footage, no stills, nothing but
 * type on black. Every check here passed or skipped — `duration_target` most of all,
 * because it measures the LATEST clip end and a stack of overlays is 30 seconds long by
 * that measure. The perceptual reviewer then reported the one real fact fifteen times, as
 * "unexpected black frames" at fifteen edit boundaries, which reads as a defect in the
 * cuts rather than an absence of a film.
 *
 * Overlay and caption clips are excluded deliberately: they sit OVER the picture, and a
 * timeline made only of them has no picture. Warn rather than fail when the run was not
 * asked for a visual deliverable — an audio-only or caption-only pass is a legitimate
 * thing to ask for, and this check must not fail it.
 */
function checkPicturePresent(project: Project, options: CritiqueOptions): CriticCheck {
  const timeline = project.timeline;
  const picture = pictureClips(project);
  if (picture.length > 0) {
    return check(
      'picture_present',
      'The edit has picture',
      'pass',
      `${String(picture.length)} picture clip${picture.length === 1 ? '' : 's'} on the timeline.`,
    );
  }
  const clips = allClips(timeline);
  if (clips.length === 0) {
    return check(
      'picture_present',
      'The edit has picture',
      'skipped',
      'The timeline is empty, so there is nothing to judge.',
    );
  }
  // WHICH kind of nothing, because the remedy is different and the wrong sentence sends the
  // editor after the wrong thing. This counted EVERY clip as an overlay, so in run
  // `ea8e46ec` — a music bed on an audio track and no picture at all — the panel reported
  // "1 overlay/caption clip … the whole thing renders as text on black", naming a caption
  // that did not exist and text that was never placed.
  const overlays = clips.filter((clip) => isOverlayClip(clip)).length;
  const detail =
    overlays > 0
      ? `The timeline has ${String(overlays)} overlay/caption clip${overlays === 1 ? '' : 's'} ` +
        'and no picture under them, so the whole thing renders as text on black. Place ' +
        'footage, a still, or a stock clip before this is a video.'
      : 'The timeline has sound but no picture at all, so it renders as a black frame for ' +
        'its whole length. Place footage, stills, or a stock clip on a video track before ' +
        'this is a video.';
  return check(
    'picture_present',
    'The edit has picture',
    requestWantsPicture(options) ? 'fail' : 'warn',
    detail,
  );
}

/**
 * Did someone ask for a film, as opposed to an audio-only or caption-only pass?
 *
 * A visual target — a platform, a duration, a shot count — means they did. Without one,
 * the picture checks warn rather than fail: an audio pass is a legitimate thing to ask
 * for and must not be failed for having no picture.
 */
function requestWantsPicture(options: CritiqueOptions): boolean {
  return (
    options.targetPlatform !== undefined ||
    options.durationTargetSeconds !== undefined ||
    options.minShotCount !== undefined
  );
}

/**
 * The ids of assets measured (schema v21) as wider than they are tall.
 *
 * A set built ONCE per check rather than a lookup per clip: the Critic runs at the end of
 * every agent run, and a per-clip `assets.find` is O(clips × assets) — the exact shape
 * `critic-scale.test.ts` exists to keep out.
 *
 * An unmeasured asset is absent by design. Absent dimensions mean unknown, and treating
 * unknown as landscape would fail runs over a shape nobody probed.
 */
function landscapeAssetIds(project: Project): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const asset of project.assets) {
    const { width, height } = asset.media ?? {};
    if (typeof width === 'number' && typeof height === 'number' && width > height) {
      ids.add(asset.id);
    }
  }
  return ids;
}

/**
 * The ids of PICTURE assets whose pixel dimensions nobody probed.
 *
 * Built for the same reason and in the same shape as {@link landscapeAssetIds}: one pass
 * over the bin, not a `find` per clip (see `critic-scale.test.ts`).
 *
 * Audio is excluded — it has no shape, so its absence is not a gap.
 */
function unmeasuredAssetIds(project: Project): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const asset of project.assets) {
    if (asset.kind === 'audio') continue;
    const { width, height } = asset.media ?? {};
    if (typeof width !== 'number' || typeof height !== 'number') ids.add(asset.id);
  }
  return ids;
}

/**
 * Picture whose measured aspect does not match the output frame's.
 *
 * The remainder after the landscape case: a 4:5 still in a 9:16 sequence is portrait, is
 * measured, and still renders with bars, because `_place_video_clip` fits whatever aspect
 * it is given. It is not FAILED like the landscape case — padding a 4:5 photo is a real
 * editorial choice, and a run that made it should not be stopped — but it must not be
 * reported as reframing that was checked and found correct either.
 */
function aspectMismatchClipIds(project: Project, picture: readonly Clip[]): readonly string[] {
  const target = project.resolution.width / project.resolution.height;
  const aspects = new Map<string, number>();
  for (const asset of project.assets) {
    const { width, height } = asset.media ?? {};
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      aspects.set(asset.id, width / height);
    }
  }
  return picture
    .filter((clip) => {
      const aspect = aspects.get(clip.assetId);
      return aspect !== undefined && Math.abs(aspect - target) > 1e-3;
    })
    .map((clip) => clip.id);
}

/**
 * Picture clips whose MEASURED source is already no wider than the frame, so they fill it
 * with no crop at all. Unmeasured sources are deliberately absent: "we cannot see the
 * shape" is not "the shape is fine".
 */
function fillsFrameUncroppedClipIds(
  project: Project,
  picture: readonly Clip[],
): ReadonlySet<string> {
  const target = project.resolution.width / project.resolution.height;
  const aspects = new Map<string, number>();
  for (const asset of project.assets) {
    const { width, height } = asset.media ?? {};
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      aspects.set(asset.id, width / height);
    }
  }
  const ids = new Set<string>();
  for (const clip of picture) {
    const aspect = aspects.get(clip.assetId);
    if (aspect !== undefined && aspect - target <= 1e-3) ids.add(clip.id);
  }
  return ids;
}

/**
 * The picture clips that genuinely NEED a cover crop to fill the frame.
 *
 * The criterion is "fills the frame", not "carries a crop", and the two are not the same
 * clip set. `add_clip`'s placer crops only a source WIDER than the frame
 * (`coverCropForFrame` returns undefined for anything as narrow or narrower — padding a 4:5
 * still into 9:16 is an editorial choice it will not make silently), so a source shot at
 * the sequence's own shape is correctly left bare. Asking instead whether every clip has a
 * crop failed a run for the one clip that needed none.
 *
 * Unmeasured sources are excluded here and handled by the `warn` branch above: absent
 * dimensions mean unknown, never "fine".
 */
function needsCoverCropClipIds(project: Project, picture: readonly Clip[]): readonly string[] {
  const target = project.resolution.width / project.resolution.height;
  const aspects = new Map<string, number>();
  for (const asset of project.assets) {
    const { width, height } = asset.media ?? {};
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      aspects.set(asset.id, width / height);
    }
  }
  return picture
    .filter((clip) => {
      const aspect = aspects.get(clip.assetId);
      // Same comparison as `coverCropForFrame`, tolerance included, so the check and the
      // placer cannot disagree about which clips are supposed to end up cropped.
      return aspect !== undefined && aspect - target > 1e-3;
    })
    .map((clip) => clip.id);
}

/** Up to three ids and then a count, the phrasing every naming detail here uses. */
function namedIds(ids: readonly string[]): string {
  const named = ids.slice(0, 3);
  const rest = ids.length - named.length;
  return `${named.join(', ')}${rest > 0 ? `, plus ${String(rest)} more` : ''}`;
}

/** A merged, ascending list of the spans picture occupies. */
function pictureSpans(project: Project): readonly { start: number; end: number }[] {
  const sorted = [...pictureClips(project)]
    .map((clip) => ({ start: clip.start, end: clip.end }))
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/**
 * Gaps of at least a second, past which a hole in the picture reads as a missing shot
 * rather than a deliberate beat of black. Same threshold and same reasoning as
 * {@link DEAD_AIR_FRAMES}, stated in frames because every editorial threshold here is.
 */
const PICTURE_GAP_FRAMES = 30;

/**
 * A hole at the END of the programme is measured in single frames, not seconds.
 *
 * {@link PICTURE_GAP_FRAMES} is right in the middle of a piece: a few frames of black
 * between two shots is a beat, and reporting it would bury the real defects. It is wrong at
 * the end, because the last frame is not a beat — it is what the viewer is left looking at,
 * and a video that finishes on black finishes wrong however briefly.
 *
 * The distinction is not theoretical. Run `25e06a6f` laid the picture down to frame 1493
 * (the talking head's real 49.783s, snapped) and the music bed to frame 1494 (49.8s, the
 * rounded figure every summary of that asset prints). One frame apart. `picture_coverage`
 * passed — 1 frame is not 30 — so the only thing that caught it was the perceptual
 * reviewer, twice, as `Program ending is black (frame 1493)`: a symptom with no cause and
 * no fix attached. The run spent two correction attempts on it and gave up, concluding it
 * was "likely a render or transition-model defect rather than something this edit can fix".
 * It was neither. It was one frame of sound past the end of the picture, which is exactly
 * what this check's own sentence tells an editor how to fix.
 */
const PROGRAMME_TAIL_FRAMES = 1;

/**
 * How much black at the end of the programme counts, in seconds at this project's rate.
 *
 * One function, because {@link checkPictureCoverage} and {@link repairTrailingSoundOverrun}
 * have to agree: a check that reports what its own repair declines to fix hands the run a
 * finding it cannot act on, which is the shape of defect that turns a run into a loop.
 */
function programmeTailThreshold(fps: number): number {
  // A whole frame, less a hair for the float noise of a quantised boundary — two clips that
  // genuinely end together differ by nanoseconds, and that is not a black frame.
  return PROGRAMME_TAIL_FRAMES / fps - 1e-6;
}

/**
 * Does picture actually cover the programme?
 *
 * `picture_present` (ADR 0144) asks whether ANY picture exists and is satisfied by one
 * clip. Run 4c9b5f82 satisfied it with ten: a 36.1-second music bed with pictures over
 * only its first 10.0 seconds, so 72% of the programme rendered as black with music
 * playing. Every check in this battery passed or skipped, the run reported `completed`,
 * and the only trace of the defect was the perceptual reviewer reporting the two black
 * frames that happened to fall inside its ±2-frame window around the final cut — as a
 * defect in that cut, rather than as the absence of 26 seconds of film.
 *
 * The programme is measured by {@link contentDuration} — picture AND sound, because a
 * music bed that outruns the picture is exactly the case this catches. Overlays are
 * excluded on both sides: they sit over the picture and cannot stand in for it.
 *
 * Deterministic and render-free, so unlike the perceptual reviewer it can be consulted
 * BEFORE a run is allowed to call itself complete.
 */
function checkPictureCoverage(project: Project, options: CritiqueOptions): CriticCheck {
  const spans = pictureSpans(project);
  if (spans.length === 0) {
    // `picture_present` owns "there is no picture at all" and says it better; a second
    // check repeating it would double-count one defect.
    return check(
      'picture_coverage',
      'Picture covers the programme',
      'skipped',
      'No picture clips, so there is no coverage to measure.',
    );
  }
  const programme = contentDuration(project.timeline);
  if (!(programme > 0)) {
    return check(
      'picture_coverage',
      'Picture covers the programme',
      'skipped',
      'The programme has no duration to cover.',
    );
  }
  const fps = Number.isFinite(project.fps) && project.fps > 0 ? project.fps : 30;
  const threshold = PICTURE_GAP_FRAMES / fps;
  const tailThreshold = programmeTailThreshold(fps);
  const holes: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start - cursor >= threshold) holes.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (programme - cursor >= tailThreshold) holes.push({ start: cursor, end: programme });
  const covered = spans.reduce(
    (total, span) => total + (Math.min(span.end, programme) - Math.min(span.start, programme)),
    0,
  );
  if (holes.length === 0) {
    return check(
      'picture_coverage',
      'Picture covers the programme',
      'pass',
      `Picture covers ${round(covered)}s of the ${round(programme)}s programme.`,
    );
  }
  const uncovered = holes.reduce((total, hole) => total + (hole.end - hole.start), 0);
  const where = holes
    .slice(0, 3)
    .map((hole) => `${round(hole.start)}s–${round(hole.end)}s`)
    .join(', ');
  const detail =
    `${round(uncovered)}s of the ${round(programme)}s programme has no picture under it ` +
    `(${where}${holes.length > 3 ? ', …' : ''}) — that renders as black. ` +
    'Extend the picture to the end of the programme, or trim the sound back to the ' +
    'picture, so every moment that plays has something on screen.';
  return check(
    'picture_coverage',
    'Picture covers the programme',
    requestWantsPicture(options) ? 'fail' : 'warn',
    detail,
  );
}

/**
 * Is any picture on this timeline buried where nobody will ever see it?
 *
 * ## Why this exists
 *
 * `picture_coverage` asks whether every moment of the programme has SOMETHING under it.
 * It cannot see the opposite defect: too much picture, stacked, with most of it behind
 * the rest. Run `137d8fd0` finished a sixty-second highlight with 25 tracks and 48
 * picture clips, of which 37 — including every clip of the main riding track — were
 * covered end to end by the layers in front of them. Every check in this battery passed.
 * Every one of the thirteen lifts that produced it was reported as `completed`.
 *
 * ADR 0169 lifts a legal full-frame placement in front of the picture it covers, which is
 * what a cutaway IS; `createPicturePlacer` now refuses the lift that buries another
 * cutaway whole. This is the same question asked of a project that already has the
 * defect, wherever it came from.
 *
 * ## Why it warns and never fails
 *
 * Buried picture can be inherited from the project the run was handed, and an inherited
 * defect is an advisory — failing the run for it would judge a delta the run did not make.
 * The remedy is an editorial decision (which copy survives), so the detail names the
 * clips and leaves the choice.
 */
function checkHiddenPicture(project: Project): CriticCheck {
  const label = 'No picture is buried';
  if (pictureClips(project).length === 0) {
    return check('hidden_picture', label, 'skipped', 'No picture clips, so nothing can be buried.');
  }
  const hidden = hiddenPictureClips(project);
  if (hidden.length === 0) {
    return check('hidden_picture', label, 'pass', 'Every picture clip is visible somewhere.');
  }
  const assetPath = new Map(project.assets.map((asset) => [asset.id, asset.path]));
  const named = hidden
    .slice(0, 3)
    .map((clip) => {
      const path = assetPath.get(clip.assetId);
      const file = path === undefined ? clip.assetId : (path.split('/').pop() ?? path);
      return `"${file}" on ${clip.trackId} (${round(clip.start)}s–${round(clip.end)}s)`;
    })
    .join(', ');
  return check(
    'hidden_picture',
    label,
    'warn',
    `${String(hidden.length)} picture clip${hidden.length === 1 ? ' is' : 's are'} completely ` +
      `covered by the layers in front of ${hidden.length === 1 ? 'it' : 'them'} and ` +
      `${hidden.length === 1 ? 'is' : 'are'} never seen: ${named}` +
      `${hidden.length > 3 ? ', …' : ''}. Remove them, or move them where they show.`,
  );
}

/**
 * The one repair for a picture-coverage failure that needs no judgement: trim the sound
 * back to where the picture stops.
 *
 * ## Why this is deterministic rather than a model call
 *
 * `checkPictureCoverage` reports a HOLE, and most holes need an editorial decision — what
 * picture goes in the gap. One shape does not: a programme whose picture ends and whose
 * SOUND keeps running past it. There is nothing to decide there. Either the bed was placed
 * at its full length before the picture was built (which is what run `fc10301a` did on
 * turn five, laying a 47.8-second track under a cut that reached 24.079s), or the picture
 * was trimmed and the bed was not. Both are the same repair, and the check's own detail
 * text already names it: "trim the sound back to the picture".
 *
 * Asking a model to make this edit is worse than making it: it costs a large-model call,
 * it can decline (run `fc10301a`'s repair pass produced nothing), and it can propose
 * something else entirely. The Critic knows the two numbers.
 *
 * ## What it refuses to touch
 *
 * - **An interior hole.** Picture that stops and starts again needs picture, not a trim,
 *   and shortening the bed would not close it.
 * - **A request that did not ask for a film.** `requestWantsPicture` is false for an
 *   audio-only or caption-only pass, where sound outrunning picture is the deliverable.
 * - **Sound that ends inside the picture.** Nothing to trim.
 * - **A clip whose trim would invert it.** A bed starting after the picture ends cannot be
 *   trimmed back into a valid range, so it is left for a human.
 *
 * The operations it returns are ordinary `trim_clip`s: validated, frame-quantized and
 * invertible like any other edit, and they appear in the run's diff as a repair turn.
 *
 * @param project - The project as the self-check found it.
 * @param options - The same critique options the checks were run with.
 * @returns Trim operations closing the trailing hole, or `[]` when this is not that shape.
 */
export function repairTrailingSoundOverrun(
  project: Project,
  options: CritiqueOptions,
): readonly AnyOperation[] {
  if (!requestWantsPicture(options)) return [];
  const spans = pictureSpans(project);
  if (spans.length === 0) return [];
  const programme = contentDuration(project.timeline);
  const fps = Number.isFinite(project.fps) && project.fps > 0 ? project.fps : 30;
  const threshold = PICTURE_GAP_FRAMES / fps;
  // The picture must be CONTINUOUS to its end: an interior hole is a different defect and
  // trimming the sound would leave it exactly where it was.
  let cursor = 0;
  for (const span of spans) {
    if (span.start - cursor >= threshold) return [];
    cursor = Math.max(cursor, span.end);
  }
  // The SAME tail rule the check reports on. These used to be one shared constant, and the
  // sharing was the point: a check that reports a black final frame while its repair holds
  // out for a whole second of them leaves the run a finding it cannot act on.
  if (programme - cursor < programmeTailThreshold(fps)) return [];
  const pictureEnd = cursor;
  const audioAssetIds = new Set(
    project.assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.id),
  );
  const overrunning = allClips(project.timeline).filter(
    (clip) => !isOverlayClip(clip) && audioAssetIds.has(clip.assetId) && clip.end > pictureEnd,
  );
  // Every clip past the picture must be sound. If any picture clip ends beyond
  // `pictureEnd` the span merge above was wrong, and if something else runs past it this
  // is not the shape this repair is for.
  if (overrunning.length === 0) return [];
  return overrunning.flatMap((clip) =>
    // A bed that starts at or after the picture ends cannot be trimmed into a valid range.
    // Removing it outright is a bigger decision than this repair is allowed to make.
    clip.start >= pictureEnd
      ? []
      : [{ type: 'trim_clip' as const, clipId: clip.id, start: clip.start, end: pictureEnd }],
  );
}

function checkDurationTarget(timeline: Timeline, options: CritiqueOptions): CriticCheck {
  const target = options.durationTargetSeconds;
  if (target === undefined) {
    return check('duration_target', 'Duration on target', 'skipped', 'No duration target was set.');
  }
  const actual = timelineDuration(timeline);
  const tolerance = options.durationToleranceSeconds ?? DEFAULT_DURATION_TOLERANCE;
  const delta = Math.abs(actual - target);
  if (delta <= tolerance) {
    // Say which duration this is when the two differ. A 30-second stack of text overlays
    // over an empty video track measures 30 seconds by the timeline's latest clip end,
    // and reporting a bare "Timeline is 30s (target 30s)" launders "there is no picture"
    // into a pass. `picture_present` is what actually judges that; this line stops the
    // duration check from quietly contradicting it.
    // NOT `contentDuration`: that falls back to the whole timeline when there is no
    // picture or sound, which is exactly the case this caveat exists to name.
    const content = allClips(timeline)
      .filter((clip) => !isOverlayClip(clip))
      .reduce((max, clip) => Math.max(max, clip.end), 0);
    const caveat =
      actual - content > tolerance
        ? ` Only ${round(content)}s of that is picture or sound — the rest is overlay.`
        : '';
    return check(
      'duration_target',
      'Duration on target',
      'pass',
      `Timeline is ${round(actual)}s (target ${round(target)}s, within ±${round(tolerance)}s).${caveat}`,
    );
  }
  return check(
    'duration_target',
    'Duration on target',
    'fail',
    `Timeline is ${round(actual)}s but the target is ${round(target)}s (off by ${round(delta)}s).`,
  );
}

/**
 * Did the cut use as many shots as the request asked for?
 *
 * The captured run was asked for "20+ different best moments" and delivered eight, and
 * nothing noticed: the run's only acceptance criterion was the request's own text, so no
 * check could be derived from it. Counted as picture clips — text/caption overlays are not
 * shots — because that is what an editor means by a shot count.
 */
function checkShotCount(project: Project, options: CritiqueOptions): CriticCheck {
  const target = options.minShotCount;
  if (target === undefined) {
    // A brief long enough to be a spec that names a number beside a clip noun, and still
    // yields no floor, is a READER failure worth surfacing — `skipped` alone is
    // indistinguishable from a brief that asked for nothing. Warn, never fail: `critique`
    // counts only `fail` toward `ok`, so a false alarm here cannot block a run that did the
    // work. See `acceptance.ts#mentionsUnreadableShotCount`.
    if (options.request !== undefined && mentionsUnreadableShotCount(options.request)) {
      return check(
        'shot_count',
        'Shot count on target',
        'warn',
        'The request mentions a clip count, but it could not be read as a requirement, so ' +
          'no shot-count check ran. Restate it as "at least N clips" to have it checked.',
      );
    }
    return check('shot_count', 'Shot count on target', 'skipped', 'No shot count was asked for.');
  }
  // Picture only. Counting `allClips` minus overlays let the music bed count as a shot —
  // the same derivation that made `picture_present` report "pass: 1 picture clip" on a
  // fifty-clip montage request whose timeline held nothing but its soundtrack.
  const shots = pictureClips(project).length;
  if (shots >= target) {
    return check(
      'shot_count',
      'Shot count on target',
      'pass',
      `The cut uses ${String(shots)} shots (at least ${String(target)} asked for).`,
    );
  }
  return check(
    'shot_count',
    'Shot count on target',
    'fail',
    `The cut uses ${String(shots)} shots but at least ${String(target)} were asked for.`,
  );
}

/** Fewest picture clips before a median shot length is a measurement rather than an accident. */
const SHOT_LENGTH_MIN_SHOTS = 3;

/**
 * Does the cut hold the shot length the attached reference actually runs at?
 *
 * The gap this closes: "make it feel like this fast-cut reel" was, until now, a sentence
 * the model read and nothing measured. The reference is analyzed into a median shot length
 * and a p10–p90 spread; this is the check that spends those numbers. It runs in
 * `wholeCutChecks`, so a run is told it is cutting at 4.1s against a 1.2s reference WHILE
 * it can still re-trim, not in the post-mortem.
 *
 * Median, not mean: one held establishing shot in a montage of forty drags a mean off the
 * pace the rest of the cut is holding, and would fail an edit that matches the reference
 * everywhere it counts.
 */
function checkShotLengthTarget(project: Project, options: CritiqueOptions): CriticCheck {
  const target = options.medianShotTargetSeconds;
  if (target === undefined || target <= 0) {
    return check(
      'shot_length_target',
      'Shot length matches the reference',
      'skipped',
      'No reference set a shot-length target.',
    );
  }
  const durations = pictureClipsInOrder(project.timeline)
    .map((clip) => clip.end - clip.start)
    .filter((duration) => duration > 0)
    .sort((left, right) => left - right);
  if (durations.length < SHOT_LENGTH_MIN_SHOTS) {
    return check(
      'shot_length_target',
      'Shot length matches the reference',
      'skipped',
      `${String(durations.length)} picture clip(s) — fewer than ${String(SHOT_LENGTH_MIN_SHOTS)}, which is too few to have a median.`,
    );
  }
  const median = durations[Math.floor(durations.length / 2)]!;
  const tolerance = options.medianShotToleranceSeconds ?? Math.max(0.5, target * 0.4);
  const from = options.medianShotSource ? ` (${options.medianShotSource})` : '';
  if (Math.abs(median - target) <= tolerance) {
    return check(
      'shot_length_target',
      'Shot length matches the reference',
      'pass',
      `Median shot is ${round(median)}s against the reference's ${round(target)}s${from}, within ±${round(tolerance)}s.`,
    );
  }
  const direction = median > target ? 'slower' : 'faster';
  return check(
    'shot_length_target',
    'Shot length matches the reference',
    'fail',
    `Median shot is ${round(median)}s but the reference runs ${round(target)}s${from} — the cut is ` +
      `${direction} than the reference by ${round(Math.abs(median - target))}s. Trim or extend the ` +
      'picture clips; do not add shots to move the median.',
  );
}

/** Does one clip carry the treatment the request demanded of every clip? */
function clipCarries(clip: Clip, treatment: CoverageTreatment): boolean {
  switch (treatment) {
    case 'crop':
      return clip.crop !== undefined;
    case 'grade':
      return clip.effects.some((effect) => effect.type === 'color_grade');
    case 'motion':
      return clip.keyframes.length > 0;
    case 'speed':
      return clip.speed !== undefined || (clip.speedRamp?.length ?? 0) > 0;
  }
}

/**
 * Did every clip get the treatment the request asked for every clip to have?
 *
 * The defect this closes: a brief demanding a reframe, a grade and a Ken Burns move on EVERY
 * clip was answered with one graded clip and one moved clip out of forty-seven, and every
 * criterion the run had — a duration and a shot count, both counts of the whole — was
 * satisfied. "All checks passed" over a cut that had been polished for two seconds and
 * abandoned. Coverage is the question those counts cannot ask.
 */
function checkTreatmentCoverage(project: Project, options: CritiqueOptions): CriticCheck {
  const wanted = options.coverage ?? [];
  if (wanted.length === 0) {
    return check(
      'treatment_coverage',
      'Per-clip work is complete',
      'skipped',
      'The request asked for nothing of every clip.',
    );
  }
  const picture = pictureClips(project);
  if (picture.length === 0) {
    return check('treatment_coverage', 'Per-clip work is complete', 'skipped', 'No picture clips.');
  }
  // A `crop` demand is the "fill the frame / no black bars" requirement (see the treatment
  // readers in `acceptance.ts`), not a creative punch-in — so a clip whose source is already
  // no wider than the frame SATISFIES it while carrying no crop, exactly as `add_clip`'s
  // placer intends. Counting the crop rather than the framing failed mixed-source cuts for
  // the one clip that needed nothing done to it. Unmeasured sources still need a crop: the
  // request was explicit, and an unverifiable shape is not a satisfied one.
  const alreadyFills = fillsFrameUncroppedClipIds(project, picture);
  const shortfalls: string[] = [];
  for (const treatment of wanted) {
    const carried = picture.filter(
      (clip) => clipCarries(clip, treatment) || (treatment === 'crop' && alreadyFills.has(clip.id)),
    ).length;
    if (carried < picture.length) {
      shortfalls.push(
        `${COVERAGE_LABEL[treatment]}: ${String(carried)} of ${String(picture.length)} clips`,
      );
    }
  }
  if (shortfalls.length === 0) {
    return check(
      'treatment_coverage',
      'Per-clip work is complete',
      'pass',
      `All ${String(picture.length)} picture clips carry every treatment the request asked for.`,
    );
  }
  return check(
    'treatment_coverage',
    'Per-clip work is complete',
    'fail',
    `The request asked for this on every clip, and it is not there yet — ${shortfalls.join('; ')}.`,
  );
}

/**
 * Is the reframing CONSISTENT across the picture — or is half the cut full-bleed and half of
 * it letterboxed?
 *
 * A crop is how a clip fills a frame whose aspect differs from its source's: the engine crops
 * and then scales the cropped picture to the canvas, so an uncropped 16:9 clip in a 9:16
 * sequence renders with black bars (`_place_video_clip` fits, it does not cover). Nothing
 * checked this, and two captured runs failed the same way — the editor asked for a full-bleed
 * vertical cut, the agent reframed the opening shots, stopped, and the run reported "All
 * checks passed" over a timeline that was 9 shots reframed and 38 not.
 *
 * Asked as a consistency question first, because a MIX of reframed and unreframed picture
 * is a defect regardless of what the sources are — nobody deliberately reframes a fifth of
 * a sequence.
 *
 * Where it CAN be asked as a geometry question, it now is. This check used to say "the
 * project does not carry each asset's pixel dimensions", and that was true until schema
 * v21 added them. When the sources are measured and a portrait sequence holds landscape
 * picture with no crop on it, black bars are not a risk to warn about — they are what the
 * render will produce, because `_place_video_clip` fits rather than covers. That is a
 * failure, and it names the clips.
 *
 * An unmeasured project still only warns — absent dimensions mean unknown, and failing a
 * run over a shape nobody measured would be worse than the gap it closes — but it now says
 * that the measurement is what is missing. The old warning read as a check that had run and
 * found the framing acceptable, which is how a pillarboxed talking head shipped under
 * `"passed": true` with one advisory line at the end of the run.
 */
function checkReframeCoverage(project: Project): CriticCheck {
  const picture = pictureClips(project);
  if (picture.length === 0) {
    return check('reframe_coverage', 'Reframing is consistent', 'skipped', 'No picture clips.');
  }
  const reframed = picture.filter((clip) => clip.crop !== undefined);
  const { width, height } = project.resolution;
  if (reframed.length === 0) {
    if (height <= width) {
      return check(
        'reframe_coverage',
        'Reframing is consistent',
        'skipped',
        'No clip is reframed, and the frame is not portrait.',
      );
    }
    // Measured landscape picture in a portrait frame, uncropped: not a risk, an outcome.
    const landscapeIds = landscapeAssetIds(project);
    const landscape = picture.filter((clip) => landscapeIds.has(clip.assetId));
    if (landscape.length > 0) {
      return check(
        'reframe_coverage',
        'Reframing is consistent',
        'fail',
        `${String(landscape.length)} of ${String(picture.length)} picture clips use a ` +
          `landscape source in a ${String(width)}x${String(height)} portrait frame with no ` +
          `crop, so they render with black bars: ` +
          `${namedIds(landscape.map((clip) => clip.id))}. Crop each to fill the frame.`,
      );
    }
    // Nothing measured, or not everything. The old text here — "any landscape source will
    // render with black bars … if that is not intended" — described a check that had run,
    // and it had not: with the dimensions absent this branch knows nothing about the
    // framing at all. A talking-head run read that warning at the very end of its work,
    // over a pillarboxed 1080x1920 export, under `"passed": true`. Say which of the two
    // situations this is.
    const unmeasuredIds = unmeasuredAssetIds(project);
    const unmeasured = picture.filter((clip) => unmeasuredIds.has(clip.assetId));
    if (unmeasured.length > 0) {
      return check(
        'reframe_coverage',
        'Reframing is consistent',
        'warn',
        `Not checked: ${String(unmeasured.length)} of ${String(picture.length)} picture ` +
          `clips use a source whose pixel dimensions were never measured, so whether they ` +
          `fill the ${String(width)}x${String(height)} portrait frame or letterbox in it is ` +
          `unknown — ${namedIds(unmeasured.map((clip) => clip.id))}. No clip is reframed. ` +
          'Look at a rendered frame before treating the framing as correct.',
      );
    }
    const mismatched = aspectMismatchClipIds(project, picture);
    if (mismatched.length > 0) {
      return check(
        'reframe_coverage',
        'Reframing is consistent',
        'warn',
        `${String(mismatched.length)} of ${String(picture.length)} picture clips use a ` +
          `measured source whose aspect differs from the ${String(width)}x${String(height)} ` +
          `frame, so they render with bars unless that is intended: ` +
          `${namedIds(mismatched)}. Crop them to fill the frame if it is not.`,
      );
    }
    return check(
      'reframe_coverage',
      'Reframing is consistent',
      'pass',
      `No clip needs reframing: every picture source is measured and matches the ` +
        `${String(width)}x${String(height)} frame.`,
    );
  }
  if (reframed.length === picture.length) {
    return check(
      'reframe_coverage',
      'Reframing is consistent',
      'pass',
      `All ${String(picture.length)} picture clips are reframed.`,
    );
  }
  // A clip with no crop is only MISSING one for one of two reasons, and "some clips carry a
  // crop and others do not" is neither of them. A partially reframed timeline is the normal
  // result of mixing sources: a montage pulling from a 4K landscape camera and a phone shot
  // vertically ends with the landscape clips cropped and the vertical one bare, and that is
  // correct. Reading "reframed" as "has a crop" failed exactly that montage over the one
  // clip that already filled the frame — thirty correct edits reported to the editor as a
  // run that could not finish.
  const uncropped = picture.filter((clip) => clip.crop === undefined);
  // 1. Measured wider than the frame: it will letterbox, whatever else is on the timeline.
  const needsCrop = new Set(needsCoverCropClipIds(project, picture));
  // 2. Unmeasured, but a SIBLING clip off the same asset is cropped. Nobody can measure the
  //    source, yet the run itself decided that source needs a crop to fill the frame, so the
  //    clips it skipped will letterbox next to the ones it fixed. This is the captured
  //    failure the check was written for: an agent reframed the opening shots and stopped.
  const croppedAssets = new Set(
    picture.filter((clip) => clip.crop !== undefined).map((clip) => clip.assetId),
  );
  const missing = uncropped
    .filter((clip) => needsCrop.has(clip.id) || croppedAssets.has(clip.assetId))
    .map((clip) => clip.id);
  if (missing.length === 0) {
    return check(
      'reframe_coverage',
      'Reframing is consistent',
      'pass',
      `${String(reframed.length)} of ${String(picture.length)} picture clips are reframed; ` +
        `the rest already fill the ${String(width)}x${String(height)} frame.`,
    );
  }
  // The count named is the number of clips that are WRONG, not the number already right:
  // it is the one an editor has to act on.
  return check(
    'reframe_coverage',
    'Reframing is consistent',
    'fail',
    `${String(missing.length)} of ${String(picture.length)} picture clips need a crop to fill ` +
      `the ${String(width)}x${String(height)} frame and have none, so they render with bars: ` +
      `${namedIds(missing)}. Crop each to fill the frame.`,
  );
}

/** Captions must have positive duration and sit within the program length. */
function checkCaptionAlignment(timeline: Timeline): CriticCheck {
  const captions = captionClips(timeline);
  if (captions.length === 0) {
    return check('caption_alignment', 'Captions aligned', 'skipped', 'No caption clips present.');
  }
  // Clips are schema-validated (end > start), so the only misalignment a caption
  // can have is extending past the actual video/audio content it sits over.
  const programEnd = contentDuration(timeline);
  const problems = captions
    .filter((cap) => cap.end > programEnd + 1e-6)
    .map(
      (cap) =>
        `caption ${cap.id} ends at ${round(cap.end)}s, past program end ${round(programEnd)}s`,
    );
  if (problems.length > 0) {
    return check('caption_alignment', 'Captions aligned', 'fail', problems.join('; ') + '.');
  }
  return check(
    'caption_alignment',
    'Captions aligned',
    'pass',
    `${captions.length} caption(s) sit within the program and have positive duration.`,
  );
}

/** Read an effect param as a finite number, or undefined if absent/non-numeric. */
const numParam = (effect: Effect, key: string): number | undefined => {
  const value = effect.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/**
 * An overlay's centre as a fraction of the frame (0–1), or `undefined` when unpositioned.
 *
 * The whole product speaks `xPercent`/`yPercent` on a 0–100 scale: the schema declares
 * them (`index.ts`), `add_text_layer` writes them, the preview painter reads them
 * (`overlay-painter.ts`) and so does the renderer (`text_overlay.py`). This check read
 * `x` and `y` on a 0–1 scale — a vocabulary nothing in this product writes.
 *
 * So it never saw an overlay. `positioned` stayed 0 for every project and the answer was
 * always "No explicitly-positioned overlays/captions to check". Run `137d8fd0` placed its
 * title at `xPercent: 50, yPercent: 50` and was told there was nothing positioned to look
 * at; a title at `yPercent: 3` would have been told the same.
 *
 * The 0–1 keys are still read, after the percent ones, so a project written before the
 * vocabulary settled keeps whatever coverage it had.
 */
function overlayCentre(effect: Effect): { x?: number; y?: number } | undefined {
  const xPercent = numParam(effect, 'xPercent');
  const yPercent = numParam(effect, 'yPercent');
  if (xPercent !== undefined || yPercent !== undefined) {
    return {
      ...(xPercent === undefined ? {} : { x: xPercent / 100 }),
      ...(yPercent === undefined ? {} : { y: yPercent / 100 }),
    };
  }
  const x = numParam(effect, 'x');
  const y = numParam(effect, 'y');
  if (x === undefined && y === undefined) return undefined;
  return { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
}

/**
 * An overlay whose BOX leaves the frame, described, or `undefined`.
 *
 * Different from being outside the safe inset, and worse: this is not "close to the
 * edge", it is "part of this is not on screen". Both dimensions are plain arithmetic on
 * values the project already carries, so there is no glyph measurement here and no way
 * for it to produce a false alarm.
 *
 * `add_text_layer`'s own description invites the vertical case — "18+ is a headline that
 * dominates the frame" — and 18% of frame height centred at `yPercent: 5` puts nearly
 * half the glyph height above the top of the picture.
 *
 * NOT caught: a single word too wide to wrap. `wrap_lines` (and its preview twin) never
 * split mid-word by design, so an over-long word overruns its box, and knowing that needs
 * font metrics neither engine exposes here. This reports the geometry it can prove.
 */
function overlayOffFrame(clip: Clip, effect: Effect): string | undefined {
  const centre = overlayCentre(effect);
  if (centre === undefined) return undefined;
  const problems: string[] = [];
  const boxWidth = numParam(effect, 'boxWidthPercent');
  if (centre.x !== undefined && boxWidth !== undefined) {
    const half = boxWidth / 200;
    if (centre.x - half < -1e-9 || centre.x + half > 1 + 1e-9) {
      problems.push(`its ${boxWidth}%-wide box runs off the side`);
    }
  }
  const fontHeight = numParam(effect, 'fontSizePercent');
  if (centre.y !== undefined && fontHeight !== undefined) {
    const half = fontHeight / 200;
    if (centre.y - half < -1e-9 || centre.y + half > 1 + 1e-9) {
      problems.push(`its ${fontHeight}% glyph height runs off the top or bottom`);
    }
  }
  return problems.length > 0 ? `${clip.id} — ${problems.join(', ')}` : undefined;
}

/**
 * Overlays/captions must stay inside the safe-area inset, must not leave the frame, and
 * must not carry a word too wide to wrap. Clips with no explicit position are assumed
 * centered (safe) — but their text is still checked for fit, which position does not
 * affect and which is the one thing here that neither renderer will report on its own.
 */
function checkSafeArea(
  timeline: Timeline,
  resolution: { readonly width: number; readonly height: number },
): CriticCheck {
  const overlayClips = overlayOrCaptionClips(timeline);
  const lo = SAFE_AREA_INSET;
  const hi = 1 - SAFE_AREA_INSET;
  const outside: string[] = [];
  const clipped: string[] = [];
  const unwrappable: string[] = [];
  let positioned = 0;
  for (const clip of overlayClips) {
    for (const effect of clip.effects) {
      // Fit is independent of position, so it is judged before the centre test bails out
      // on a default-placed overlay. `overflowingWords` has no opinion unless the size and
      // the box width were both authored.
      const over = overflowingWords(effect.params, resolution)[0];
      if (over !== undefined) {
        unwrappable.push(
          `${clip.id} — "${over.word}" needs about ${String(over.requiredBoxWidthPercent)}% of ` +
            `the frame width at this text size and boxWidthPercent is ` +
            `${round(over.boxWidthPercent)}` +
            (over.requiredBoxWidthPercent > 100
              ? '; no box is wide enough, so the text size has to come down'
              : '; no line break can shorten one word'),
        );
      }
      const centre = overlayCentre(effect);
      if (centre === undefined) continue;
      positioned += 1;
      const { x, y } = centre;
      if ((x !== undefined && (x < lo || x > hi)) || (y !== undefined && (y < lo || y > hi))) {
        outside.push(
          `${clip.id} at (${x === undefined ? '—' : round(x)}, ${y === undefined ? '—' : round(y)})`,
        );
      }
      const off = overlayOffFrame(clip, effect);
      if (off !== undefined) clipped.push(off);
    }
  }
  if (positioned === 0 && unwrappable.length === 0) {
    return check(
      'safe_area',
      'Overlays in safe area',
      'skipped',
      'No explicitly-positioned overlays/captions to check (centered layouts are safe).',
    );
  }
  // Leaving the frame outranks being near its edge: one is clipped picture, the other is
  // a house style. Reported together when both are true, worst first.
  if (clipped.length > 0 || outside.length > 0 || unwrappable.length > 0) {
    const parts: string[] = [];
    if (clipped.length > 0) parts.push(`Off the frame — part of this will not be seen: ${clipped.join('; ')}.`);
    if (unwrappable.length > 0)
      parts.push(
        `Too wide for its box — this runs out the sides in the preview and the export ` +
          `alike: ${unwrappable.join('; ')}. Widen boxWidthPercent or reduce sizePercent.`,
      );
    if (outside.length > 0)
      parts.push(`Outside the ${Math.round(SAFE_AREA_INSET * 100)}% safe area: ${outside.join(', ')}.`);
    return check('safe_area', 'Overlays in safe area', 'warn', parts.join(' '));
  }
  return check(
    'safe_area',
    'Overlays in safe area',
    'pass',
    `${positioned} positioned overlay(s)/caption(s) are inside the safe area.`,
  );
}

/** Audio clipping comes from the render validator; skipped without a render. */
function checkAudioClipping(options: CritiqueOptions): CriticCheck {
  const render = options.render;
  if (!render || render.audioClipping === undefined) {
    return check(
      'audio_clipping',
      'No audio clipping',
      'skipped',
      'No preview render was validated; run a preview render to check audio levels.',
    );
  }
  return render.audioClipping
    ? check(
        'audio_clipping',
        'No audio clipping',
        'fail',
        'The render validator detected audio clipping (peak ≈ 0 dBFS).',
      )
    : check(
        'audio_clipping',
        'No audio clipping',
        'pass',
        'Render audio peaks are below clipping.',
      );
}

/** Black-frame detection comes from the render validator; skipped without one. */
function checkBlackFrames(options: CritiqueOptions): CriticCheck {
  const render = options.render;
  if (!render || render.hasBlackFrames === undefined) {
    return check(
      'black_frames',
      'No black frames',
      'skipped',
      'No preview render was validated; run a preview render to check for black frames.',
    );
  }
  return render.hasBlackFrames
    ? check(
        'black_frames',
        'No black frames',
        'fail',
        'The render validator detected (near-)black frames.',
      )
    : check('black_frames', 'No black frames', 'pass', 'No black frames in the validated render.');
}

/** Temporal evidence is a required pass when supplied; missing evidence remains explicit. */
function checkTemporalEvidence(options: CritiqueOptions): CriticCheck {
  const temporal = options.temporal;
  if (!temporal) {
    return check(
      'temporal_evidence',
      'Temporal evidence',
      'skipped',
      'No command-critical temporal evidence was requested for this review.',
    );
  }
  const failed = temporal.checks.filter((candidate) => candidate.status === 'fail');
  const skipped = temporal.checks.filter((candidate) => candidate.status === 'skipped');
  if (failed.length > 0 || skipped.length > 0) {
    const first = [...failed, ...skipped][0]!;
    return check(
      'temporal_evidence',
      'Temporal evidence',
      'fail',
      `${failed.length} temporal check(s) failed and ${skipped.length} lack evidence. ` +
        `${first.requestId}: ${first.issues[0] ?? 'No evidence.'}`,
    );
  }
  return check(
    'temporal_evidence',
    'Temporal evidence',
    'pass',
    `${temporal.checks.length} command-critical temporal check(s) passed at project revision ${temporal.projectRevision}.`,
  );
}

/**
 * Semantic objectives are a required pass when declared.
 *
 * An unverified objective fails rather than warns. Asking "is the subject still
 * framed?" and settling for "nobody could tell" would let the one question the
 * measurements could not answer be the one the gate waves through.
 */
function checkVisionReview(options: CritiqueOptions): CriticCheck {
  const vision = options.vision;
  if (!vision) {
    return check(
      'vision_review',
      'Vision review',
      'skipped',
      'No semantic objective needed a vision review.',
    );
  }
  const unresolved = vision.checks.filter((candidate) => candidate.status !== 'pass');
  if (unresolved.length > 0) {
    const first = unresolved[0]!;
    return check(
      'vision_review',
      'Vision review',
      'fail',
      `${unresolved.length} semantic objective(s) were not confirmed. ${first.objective}: ${first.reason}`,
    );
  }
  return check(
    'vision_review',
    'Vision review',
    'pass',
    `${vision.checks.length} semantic objective(s) confirmed at project revision ${vision.projectRevision}.`,
  );
}

/** Every clip must reference a known asset (or an engine sentinel asset). */
function checkMissingAssets(project: Project): CriticCheck {
  const known = new Set(project.assets.map((a) => a.id));
  const missing = new Set<string>();
  for (const clip of allClips(project.timeline)) {
    if (!known.has(clip.assetId) && !SYNTHETIC_ASSET_IDS.has(clip.assetId)) {
      missing.add(clip.assetId);
    }
  }
  if (missing.size > 0) {
    return check(
      'missing_assets',
      'No missing assets',
      'fail',
      `Clips reference unknown asset(s): ${[...missing].join(', ')}.`,
    );
  }
  return check('missing_assets', 'No missing assets', 'pass', 'All clips reference known assets.');
}

/** Sanity-check the project's aspect ratio/orientation against the platform. */
function checkExportSettings(project: Project, options: CritiqueOptions): CriticCheck {
  const platform = options.targetPlatform;
  if (platform === undefined) {
    return check('export_settings', 'Export settings', 'skipped', 'No target platform was set.');
  }
  const { width, height } = project.resolution;
  const isPortrait = height > width;
  const wantsPortrait = VERTICAL_PLATFORMS.has(platform);
  if (wantsPortrait && !isPortrait) {
    return check(
      'export_settings',
      'Export settings',
      'warn',
      `${platform} expects a vertical 9:16 frame but the project is ${width}x${height} (landscape).`,
    );
  }
  return check(
    'export_settings',
    'Export settings',
    'pass',
    `Project ${width}x${height} suits ${platform}.`,
  );
}

// ---------------------------------------------------------------------------
// Editorial checks (context-management Phase 4)
// ---------------------------------------------------------------------------
//
// Read the fourteen checks above as an editor. Every one of them answers "is the
// deliverable well-formed?" — the right length, the right aspect, no missing media, no
// clipping, nothing black. Not one answers "is this a good cut?"
//
// These do. The rules that keep them honest:
//
//  · **Every threshold is stated in FRAMES, with a written rationale.** "0.1 seconds"
//    means different things at 24 and 60fps, and a number tuned until a fixture passed is
//    not a standard. A frame grid exists to be stated in (ADR 0146).
//  · **Every check is computable from state the run already holds.** Anything needing a
//    render is `skipped` with a reason, exactly as `black_frames` is.
//  · **A check ships `warn` before it ships `fail`.** `warn` informs the model; `fail`
//    triggers the repair pass. Promoting one is a decision made after it has been seen
//    correct on real runs, not on the day it is written.
//  · **A check the agent cannot act on trains it to ignore the critic.** Each one either
//    names the tool that fixes it (and joins `FIXABLE_CHECKS`) or says plainly in its own
//    detail text that it is diagnostic.

/**
 * How much source a cut may skip before the two sides stop reading as the same shot.
 *
 * 60 frames — two seconds at 30fps. The rationale is the subject, not the number: over
 * less than about two seconds of removed footage a talking head has not visibly changed
 * pose, so the splice reads as the picture stuttering rather than as an edit. That is
 * exactly the range a silence-removal pass produces, which is why the check exists.
 *
 * Stated in frames because "two seconds" is 48 frames of motion at 24fps and 120 at 60.
 */
const JUMP_CUT_SOURCE_FRAMES = 60;

/**
 * Source continuity within this many frames is not a cut at all.
 *
 * A split with nothing removed leaves the footage running on across the seam: there is a
 * clip boundary but no visible edit, so calling it a jump cut would fire the check on
 * every `split_clip` the agent ever makes.
 */
const CONTIGUOUS_SOURCE_FRAMES = 1;

/**
 * Dead air at the head or tail worth reporting, in frames.
 *
 * 30 frames — one second at 30fps, and the point at which an opening stops reading as a
 * breath and starts reading as a mistake. Short-form is the north-star deliverable
 * (`product-discipline.mdc` §1) and a second of nothing at the top of a Reel is a second
 * of watch time spent on nothing.
 */
const DEAD_AIR_FRAMES = 30;

/** Fewest cuts before shot rhythm means anything. Three shots have no rhythm to have. */
const RHYTHM_MIN_SHOTS = 6;

/**
 * Below this coefficient of variation, shot lengths are machine-cut rather than paced.
 *
 * 0.15 means every shot is within roughly ±15% of the mean — "everything is 4.2 seconds",
 * which is what a fixed-interval cutter produces and what an editor never does. Above it
 * there is enough spread to be a choice. Diagnostic only: see the check's own detail.
 */
const RHYTHM_MIN_VARIATION = 0.15;

/** Fewest boundaries before "every cut is a hard butt cut on both" means anything. */
const SLAM_MIN_BOUNDARIES = 4;

/** Frames of offset that count as a real J/L relationship rather than float noise. */
const SLAM_OFFSET_FRAMES = 2;

/** A picture clip's span in source time, for the jump-cut comparison. */
interface SourceSpan {
  readonly assetId: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

/** The picture clips of a track, in timeline order. */
function pictureClipsInOrder(timeline: Timeline): readonly Clip[] {
  return allClips(timeline)
    .filter((clip) => !isOverlayClip(clip))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/**
 * Is that a jump cut?
 *
 * Two adjacent clips from the SAME asset at near-identical source times: the same shot cut
 * to itself, which reads as the picture stuttering rather than as an edit. It is the single
 * most common defect in a machine-assembled cut — every silence removal produces candidates
 * for it — and nothing in the battery looked for it.
 */
function checkJumpCut(project: Project, fps: number): CriticCheck {
  const boundaries = listEditBoundaries(project.timeline, project.assets);
  if (boundaries.length === 0) {
    return check('jump_cut', 'No jump cuts', 'skipped', 'No cuts in the sequence to judge.');
  }
  const byId = new Map<string, SourceSpan>();
  for (const clip of pictureClipsInOrder(project.timeline)) {
    byId.set(clip.id, {
      assetId: clip.assetId,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
    });
  }
  const window = JUMP_CUT_SOURCE_FRAMES / fps;
  const offenders = boundaries.filter((boundary) => {
    const from = byId.get(boundary.fromClipId);
    const to = byId.get(boundary.toClipId);
    if (!from || !to || from.assetId !== to.assetId) return false;
    const skipped = Math.abs(to.sourceStart - from.sourceEnd);
    // Contiguous source is an invisible seam, not a jump cut — see
    // CONTIGUOUS_SOURCE_FRAMES. Past that, the incoming clip resumes near enough to where
    // the outgoing one stopped that the framing has not changed: the same shot, spliced
    // to itself.
    if (skipped <= CONTIGUOUS_SOURCE_FRAMES / fps) return false;
    return skipped <= window;
  });
  if (offenders.length === 0) {
    return check(
      'jump_cut',
      'No jump cuts',
      'pass',
      `No cut joins one shot to itself (${boundaries.length} cut(s) checked).`,
    );
  }
  const where = offenders
    .slice(0, 4)
    .map((b) => `frame ${secondsToFrame(b.at, fps)} (${round(b.at)}s)`)
    .join(', ');
  return check(
    'jump_cut',
    'No jump cuts',
    'warn',
    `${offenders.length} cut(s) join the same shot to itself within ${JUMP_CUT_SOURCE_FRAMES} ` +
      `source frames — at ${where}${offenders.length > 4 ? ', …' : ''}. Cover one with a ` +
      'cutaway (add_stock), or extend one side past the match (trim_clip) so the framing ' +
      'has visibly changed across the cut.',
  );
}

/** Slack on the duration comparison in {@link unattributedSpeechAssets}, in seconds. */
const SPEECH_ASSET_TOLERANCE = 0.5;

/**
 * Which assets an **unattributed** transcript can be speaking over.
 *
 * ## WHY
 *
 * A transcript word with no `assetId` (schema ≤ v11, and every fixture in
 * `tests/fixtures/mission`) is treated as applying to any clip. On a single-asset project
 * that is right and is the behaviour this preserves. On a project that has since gained
 * *other* footage it is a fabrication, and it fabricates in the direction that fails runs:
 * `broll-first-20s` places b-roll over the first 20s of narration, and `word_severed`
 * judges the b-roll clip's own in and out points against the narration's words — reporting
 * a severed word on footage that contains no speech at all. The agent then spends its run
 * trying to move a cut away from a word that was never on that shot; the captured run
 * burned 19 model calls and $2.07 doing exactly that.
 *
 * The timeline already knows the answer without a schema change: an unattributed
 * transcript covers its own span, so it can only have come from an asset long enough to
 * contain it. On `mission-talk` that is the 528s narration and not the 9–40s b-roll. When
 * nothing qualifies — no durations known, or the transcript outruns every asset — the
 * result is `undefined` and the old any-clip reading stands, so no project loses coverage
 * it had.
 *
 * @returns The asset ids an unattributed word may be judged against, or `undefined` to
 *   mean "cannot narrow it — judge against everything", which is the pre-existing rule.
 */
function unattributedSpeechAssets(project: Project): ReadonlySet<string> | undefined {
  if (project.transcript.length === 0) return undefined;
  const spokenUntil = project.transcript.reduce((max, word) => Math.max(max, word.end), 0);
  const able = project.assets.filter(
    (asset) =>
      asset.kind !== 'image' &&
      asset.durationSeconds !== undefined &&
      asset.durationSeconds >= spokenUntil - SPEECH_ASSET_TOLERANCE,
  );
  return able.length === 0 ? undefined : new Set(able.map((asset) => asset.id));
}

/**
 * Did I cut through a word?
 *
 * A cut that lands strictly inside a word severs it, and no audio work afterwards puts the
 * consonant back.
 *
 * Measured in **source** time, against the clips' in/out points — not against the mapped
 * transcript, which is the obvious approach and the wrong one. `mapTranscript` has already
 * RESOLVED every straddle by the time it answers: a word the cut ran through is either
 * dropped or attributed to one side, so a severed word is precisely the word that no
 * longer straddles anything. Asking the mapped view about it finds nothing, every time.
 *
 * A word with no `assetId` (schema ≤ v11, or a single-asset project) applies to every
 * clip; an attributed one applies only to its own asset, so a two-camera project does not
 * report camera A's words as cut by camera B's edges.
 *
 * WHY the detected transcript loop is a parameter: `checkTranscriptReliable` already decided the transcript
 * is fabricated over a range, and this check has to agree with that decision rather than
 * re-litigate it. Run `137d8fd0` is what forced the point. Its transcript is 397
 * back-to-back repeats of "I'll try to follow you later." covering 91% of the recording;
 * `transcript_reliable` warned, in as many words, "do not select or cut on them" — and
 * then `word_severed` failed the run for cuts inside "follow" and "God.", which are two
 * of those words. Nobody said them. The run's repair pass looked at the failure, found
 * nothing to repair, and the whole edit — 416 applied changes — was reported as failed
 * on the strength of a word that does not exist.
 *
 * So a cut inside a hallucinated word is not a defect and is not counted. Real speech
 * outside the loop is still protected, which is the part that matters: this transcript's
 * first ~21s are genuine and cutting through those words is still wrong.
 */
function checkWordSevered(
  project: Project,
  fps: number,
  loop: TranscriptLoop | undefined,
): CriticCheck {
  if (project.transcript.length === 0) {
    return check(
      'word_severed',
      'No words cut through',
      'skipped',
      'This project has no transcript, so there are no word boundaries to protect.',
    );
  }
  const boundaries = listEditBoundaries(project.timeline, project.assets);
  if (boundaries.length === 0) {
    return check(
      'word_severed',
      'No words cut through',
      'skipped',
      'No cuts in the sequence to judge.',
    );
  }
  const byId = new Map(pictureClipsInOrder(project.timeline).map((clip) => [clip.id, clip]));
  const speechAssets = unattributedSpeechAssets(project);
  // Word frame spans are computed ONCE and searched, not recomputed per boundary. The
  // naive nested loop is O(boundaries x words) with a rate conversion inside it — on an
  // hour of footage that is a thousand cuts against nine thousand words on every review,
  // and the Critic runs at the end of every run.
  const inLoop = (word: TranscriptWord): boolean =>
    loop !== undefined && word.end > loop.startSeconds && word.start < loop.endSeconds;
  const real = project.transcript.filter((word) => !inLoop(word));
  const excluded = project.transcript.length - real.length;
  if (real.length === 0) {
    return check(
      'word_severed',
      'No words cut through',
      'skipped',
      'Every transcribed word falls inside a speech-recognition loop, so there are no ' +
        'real word boundaries to protect. Re-transcribe before trusting word timings.',
    );
  }
  const spans = real
    .map((word) => ({
      assetId: word.assetId,
      word: word.word,
      startFrame: secondsToFrame(word.start, fps),
      endFrame: secondsToFrame(word.end, fps),
    }))
    .sort((a, b) => a.startFrame - b.startFrame);
  // The longest word on the timeline, which is what bounds the backward walk below: no
  // word starting earlier than `frame - longestWord` can still be covering `frame`.
  // Bounding by a real quantity rather than stopping at the first non-covering word is
  // what makes the search correct when two words overlap at all — stopping early would
  // miss a long word that a short one is sitting inside.
  const longestWord = spans.reduce(
    (max, span) => Math.max(max, span.endFrame - span.startFrame),
    0,
  );

  /** The word a source instant falls strictly inside, for this clip's asset. */
  const severedWordAt = (clip: Clip | undefined, sourceSeconds: number): string | undefined => {
    if (!clip) return undefined;
    const frame = secondsToFrame(sourceSeconds, fps);
    // Binary search to the first word starting at or after `frame`…
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (spans[mid]!.startFrame < frame) low = mid + 1;
      else high = mid;
    }
    // …then walk back from the word before it. `low` can be `spans.length` — every word
    // starts before this cut, which is the ordinary case for a cut near the end — so the
    // first index to look at is the one BEFORE the bound, clamped.
    for (let i = Math.min(low, spans.length) - 1; i >= 0; i -= 1) {
      const span = spans[i]!;
      if (span.startFrame <= frame - longestWord) break;
      // STRICTLY inside. Landing on a word's first frame is cutting BEFORE it, and on the
      // frame its last one ends is cutting AFTER it — both are correct edits.
      if (span.startFrame >= frame || span.endFrame <= frame) continue;
      if (span.assetId !== undefined && span.assetId !== clip.assetId) continue;
      // An unattributed word is not automatically this clip's — see
      // `unattributedSpeechAssets`. B-roll is the case this exists for.
      if (span.assetId === undefined && speechAssets && !speechAssets.has(clip.assetId)) continue;
      return span.word;
    }
    return undefined;
  };

  const severed: { readonly frame: number; readonly word: string; readonly seconds: number }[] =
    [];
  for (const boundary of boundaries) {
    const from = byId.get(boundary.fromClipId);
    const to = byId.get(boundary.toClipId);
    // Both edges of the cut are real edit points: the outgoing clip may end mid-word, and
    // the incoming clip may begin mid-word, independently.
    const word =
      severedWordAt(from, from?.sourceEnd ?? 0) ?? severedWordAt(to, to?.sourceStart ?? 0);
    if (word !== undefined) {
      const frame = secondsToFrame(boundary.at, fps);
      severed.push({ frame, word, seconds: frameToSeconds(frame, fps) });
    }
  }
  const aside =
    excluded === 0
      ? ''
      : ` ${String(excluded)} word(s) were ignored as speech-recognition loop artefacts.`;
  if (severed.length === 0) {
    return check(
      'word_severed',
      'No words cut through',
      'pass',
      `Every cut lands between words (${boundaries.length} cut(s) against ${real.length} word(s)).${aside}`,
    );
  }
  const where = severed
    .slice(0, 4)
    .map((s) => `frame ${s.frame} = ${round(s.seconds)}s ("${s.word}")`)
    .join(', ');
  // A transcript that loops is not a transcript with a bad stretch in it — it is a
  // recording the recogniser could not hear speech in, and the words OUTSIDE the loop are
  // its guesses too. Run `cc907070` (a GoPro take of nothing but wind, "no dialogue
  // anywhere" in the brief) had 2,431 words of which 2,382 were the loop; the other 49 —
  // "Jake,", "try", "God." — were hallucinated over the same wind, and a cut inside one of
  // them FAILED the run and its 65 applied changes. So under a loop this is a warning: the
  // editor is told which cuts and why the words are suspect, and the run is not held to
  // word boundaries nobody can vouch for.
  if (loop !== undefined) {
    return check(
      'word_severed',
      'No words cut through',
      'warn',
      `${severed.length} cut(s) land inside a transcribed word: ${where}${
        severed.length > 4 ? ', …' : ''
      }. The transcript repeats one phrase over ${String(Math.round(loop.share * 100))}% ` +
        'of the recording — speech recognition looping over quiet audio — so the words ' +
        'outside the loop cannot be trusted either, and these cuts are not counted as ' +
        `defects. Re-transcribe before cutting on word timings.${aside}`,
    );
  }
  return check(
    'word_severed',
    'No words cut through',
    'fail',
    `${severed.length} cut(s) land inside a word: ${where}${severed.length > 4 ? ', …' : ''}. ` +
      'Move each boundary to the nearest word edge: read the word\'s startFrame/endFrame ' +
      'from get_mapped_transcript, then pass that frame DIVIDED BY the project frame rate ' +
      `(${String(fps)}) to trim_clip or split_clip — those take SECONDS, and a second ` +
      'between two frames is rounded to the nearest one, which is how a cut aimed at a ' +
      `word's edge lands inside it.${aside}`,
  );
}

/**
 * Is there dead air at the head or the tail?
 *
 * Measured against the DIALOGUE, not against silence detection: the mapped transcript is
 * already on the timeline and needs no analysis pass, so this check costs nothing and can
 * never be `skipped` for want of a render. A run that also gathered `analyze_silence`
 * evidence gets a sharper answer through {@link CritiqueOptions.silences}.
 */
function checkDeadAir(project: Project, fps: number, options: CritiqueOptions): CriticCheck {
  const mapped = mapTranscript(
    buildTimelineMap(project.timeline),
    project.transcript,
    // An unattributed word belonging to any asset means dead air is measured against the
    // b-roll clip's edges as readily as the narration's — the same fabrication
    // `word_severed` was fixed for in 5d0dbab.
    speechAssetIdsFor(project.assets, project.transcript),
  );
  if (mapped.words.length === 0) {
    return check(
      'dead_air',
      'No dead air at head or tail',
      'skipped',
      'No dialogue on the edited timeline, so there is no speech to measure silence against.',
    );
  }
  const duration = contentDuration(project.timeline);
  const first = Math.min(...mapped.words.map((w) => w.start));
  const last = Math.max(...mapped.words.map((w) => w.end));
  const headFrames = secondsToFrame(first, fps);
  const tailFrames = secondsToFrame(Math.max(0, duration - last), fps);
  const problems: string[] = [];
  if (headFrames >= DEAD_AIR_FRAMES) {
    problems.push(`${headFrames} frames (${round(first)}s) before the first word`);
  }
  if (tailFrames >= DEAD_AIR_FRAMES) {
    problems.push(`${tailFrames} frames (${round(duration - last)}s) after the last word`);
  }
  const cited = options.silences?.handle ? ` (from ${options.silences.handle})` : '';
  if (problems.length === 0) {
    return check(
      'dead_air',
      'No dead air at head or tail',
      'pass',
      `Speech starts at frame ${headFrames} and runs to ${round(last)}s of ${round(duration)}s${cited}.`,
    );
  }
  return check(
    'dead_air',
    'No dead air at head or tail',
    // `warn`, not `fail`: a hold at the tail can be a deliberate button, and this check has
    // not been watched on real runs yet. Promotion is a one-line change once it has.
    'warn',
    `Dead air: ${problems.join(' and ')}${cited}. The threshold is ${DEAD_AIR_FRAMES} frames — ` +
      'a second at 30fps, past which an opening reads as a mistake rather than a breath. ' +
      'ripple_delete the head/tail range.',
  );
}

/**
 * Does a transition fit the boundary it sits on?
 *
 * NOT the `handle_starved` check the plan specified. That check assumes a dissolve needs
 * source frames on both sides to overlap into, and **this renderer needs none**: it ramps
 * over the incoming clip's own first frames and borrows nothing from past the cut
 * (`edit-boundaries.ts` module note), so a transition never fails for want of footage. A
 * check for a condition the engine cannot produce would fire on nothing and teach the
 * model a rule that is false here.
 *
 * What IS real: a boundary carries at most half its shorter shot, and a request past that
 * is silently SHORTENED to fit rather than refused. So the model reports a half-second
 * dissolve the timeline never had. That is worth catching, and the fix is to ask for the
 * length that fits.
 */
function checkTransitionFit(project: Project, fps: number): CriticCheck {
  const boundaries = listEditBoundaries(project.timeline, project.assets);
  const byBoundary = new Map(boundaries.map((b) => [b.toClipId, b]));
  const overlong: string[] = [];
  let transitions = 0;
  for (const clip of allClips(project.timeline)) {
    // `effects` is required by the schema, but a critique must never become a crash — the
    // Critic is the thing that runs when an edit already went wrong, and a hand-built or
    // partially-migrated clip is exactly when it is most needed.
    for (const effect of clip.effects ?? []) {
      if (effect.type !== 'transition') continue;
      transitions += 1;
      const requested = Number(effect.params?.durationSeconds ?? 0);
      const boundary = byBoundary.get(clip.id);
      if (!boundary || !Number.isFinite(requested)) continue;
      if (requested > boundary.maxTransitionSeconds + 1 / fps) {
        overlong.push(
          `frame ${secondsToFrame(boundary.at, fps)}: asked for ${secondsToFrame(requested, fps)} ` +
            `frames, the cut carries ${secondsToFrame(boundary.maxTransitionSeconds, fps)}`,
        );
      }
    }
  }
  if (transitions === 0) {
    return check(
      'transition_fit',
      'Transitions fit their cuts',
      'skipped',
      'No transitions on the timeline.',
    );
  }
  if (overlong.length === 0) {
    return check(
      'transition_fit',
      'Transitions fit their cuts',
      'pass',
      `All ${transitions} transition(s) fit within half their shorter shot.`,
    );
  }
  return check(
    'transition_fit',
    'Transitions fit their cuts',
    'fail',
    `${overlong.length} transition(s) are longer than their boundary can carry — ` +
      `${overlong.slice(0, 3).join('; ')}. The engine shortens them silently, so what you ` +
      'described to the editor is not what the timeline has. Re-issue add_transition at the ' +
      'length list_edit_boundaries reports as maxTransitionFrames.',
  );
}

/**
 * Does the audio breathe across the cuts, or does it slam?
 *
 * Fails when EVERY picture cut is matched by an audio cut at the same instant and nothing
 * anywhere leads or trails — the signature of an assembly with no J or L cuts in it, which
 * is what an automated cut produces and what a human edit essentially never is.
 *
 * Report-only, deliberately. Its repair is `professional_edit` j_cut/l_cut, which requires
 * a live editor selection and the desktop app; a repair pass has neither, so promoting
 * this to `fail` would send the agent at a tool that must refuse it.
 */
function checkAudioSlam(project: Project, fps: number): CriticCheck {
  const tracks = project.timeline.tracks;
  const audioEdges = new Set<number>();
  for (const track of tracks) {
    if (track.type !== 'audio') continue;
    for (const clip of track.clips) {
      audioEdges.add(secondsToFrame(clip.start, fps));
      audioEdges.add(secondsToFrame(clip.end, fps));
    }
  }
  const boundaries = listEditBoundaries(project.timeline, project.assets);
  if (audioEdges.size === 0 || boundaries.length < SLAM_MIN_BOUNDARIES) {
    return check(
      'audio_slam',
      'Audio breathes across the cuts',
      'skipped',
      audioEdges.size === 0
        ? 'No separate audio layer, so picture and sound cannot be offset from each other.'
        : `Only ${boundaries.length} cut(s) — too few for "every cut" to mean anything.`,
    );
  }
  const offset = boundaries.filter((boundary) => {
    const frame = secondsToFrame(boundary.at, fps);
    // An audio edge more than a couple of frames away from every picture cut IS a J or L
    // relationship; one within a frame or two is the same cut on both. Probed as a set
    // membership over the tolerance window rather than scanned: the scan is
    // O(cuts x audio edges), and both grow with the length of the edit.
    for (let delta = -SLAM_OFFSET_FRAMES; delta <= SLAM_OFFSET_FRAMES; delta += 1) {
      if (audioEdges.has(frame + delta)) return false;
    }
    return true;
  });
  if (offset.length > 0) {
    return check(
      'audio_slam',
      'Audio breathes across the cuts',
      'pass',
      `${offset.length} of ${boundaries.length} cut(s) have sound and picture on different frames.`,
    );
  }
  return check(
    'audio_slam',
    'Audio breathes across the cuts',
    'warn',
    `All ${boundaries.length} cuts land on the same frame for picture and sound — no J or L ` +
      'cut anywhere. Sound that starts and stops exactly with the picture reads as an ' +
      'assembly rather than an edit. Diagnostic only here: the fix is professional_edit ' +
      'j_cut/l_cut, which needs a live selection in the desktop app and is not reachable ' +
      'from a repair pass.',
  );
}

/**
 * Do the shot lengths have a rhythm, or is everything 4.2 seconds?
 *
 * **Not repairable, and the detail text says so.** Pretending it were would produce random
 * re-trimming that satisfies a variance metric and looks worse — a check that optimises its
 * own number is worse than no check.
 */
function checkShotRhythm(project: Project, fps: number): CriticCheck {
  const durations = pictureClipsInOrder(project.timeline).map((clip) => clip.end - clip.start);
  if (durations.length < RHYTHM_MIN_SHOTS) {
    return check(
      'shot_rhythm',
      'Shot lengths have a rhythm',
      'skipped',
      `${durations.length} shot(s) — fewer than ${RHYTHM_MIN_SHOTS}, which is too few to have a rhythm.`,
    );
  }
  const mean = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  if (mean <= 0) {
    return check(
      'shot_rhythm',
      'Shot lengths have a rhythm',
      'skipped',
      'Shots have no measurable length.',
    );
  }
  const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;
  const variation = Math.sqrt(variance) / mean;
  if (variation >= RHYTHM_MIN_VARIATION) {
    return check(
      'shot_rhythm',
      'Shot lengths have a rhythm',
      'pass',
      `${durations.length} shots vary by ${Math.round(variation * 100)}% around ` +
        `${secondsToFrame(mean, fps)} frames.`,
    );
  }
  return check(
    'shot_rhythm',
    'Shot lengths have a rhythm',
    'warn',
    `${durations.length} shots are all within ${Math.round(variation * 100)}% of ` +
      `${secondsToFrame(mean, fps)} frames — machine-cut pacing, not chosen pacing. ` +
      'DIAGNOSTIC ONLY: do not re-trim to change this number. Vary shot length where the ' +
      'CONTENT asks for it, or leave it and say why.',
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the full Critic battery over a project (PRD §8.6).
 *
 * @param project - The project to review (its timeline is the edited result).
 * @param options - Target/render context that informs the checks.
 * @returns A {@link CritiqueReport}; `ok` is false when any check failed.
 */
/**
 * The acceptance checks that count the WHOLE cut — `picture_coverage`, `duration_target`,
 * `shot_count`, `shot_length_target`, `reframe_coverage`, `treatment_coverage` — run on
 * their own.
 *
 * Not every check belongs here. A jump cut or a severed word is a local defect the model
 * finds by looking at the seam; these five are properties of the finished thing that the
 * model cannot see from any one edit — how long it is, how many shots it has, whether
 * anything is under the sound, whether the treatment reached every clip. That is what
 * makes them worth telling a run about while it can still act on them.
 *
 * `standingAgainstAcceptance` is called on every prompt build — once per turn AND once per
 * retry attempt — and running the full battery to keep five of its twenty-odd results meant
 * the editorial passes (jump cut, severed word, dead air, shot rhythm) were re-walked every
 * clip of an hour-long project for nothing. `critic-scale.test.ts` measures that battery at
 * ~185ms clean and ~805ms under coverage, so a long-form run was paying seconds inside the
 * turn loop for a five-line block.
 *
 * `critique` composes the same function rather than repeating the calls, so the block a run
 * is shown in flight and the checks that judge it at the end can never come apart.
 */
function wholeCutChecks(project: Project, options: CritiqueOptions): CriticCheck[] {
  return [
    checkPictureCoverage(project, options),
    checkDurationTarget(project.timeline, options),
    checkShotCount(project, options),
    checkShotLengthTarget(project, options),
    checkReframeCoverage(project),
    checkTreatmentCoverage(project, options),
  ];
}

/**
 * Where the cut currently stands against what the request asked for, in the run's own
 * words — for a turn that is still running, not for the post-mortem.
 *
 * ## Why this is not just `critique`
 *
 * The checks below are pure and render-free, and `checkPictureCoverage`'s own docstring
 * says so: "unlike the perceptual reviewer it can be consulted BEFORE a run is allowed to
 * call itself complete." Nothing consulted it. `critique` ran once, in `runVerify`, at the
 * end.
 *
 * The cost of that: run `fc10301a` laid a 47.8-second music bed on turn five, two minutes
 * into a twelve-minute run, against a 27.5-second target. That single operation guaranteed
 * both of its terminal failures — the duration overshoot and 23.7 seconds of black — and
 * the run was told about neither until the budget was spent. Seventeen turns of
 * compounding, over two numbers that were computable the moment the bed landed.
 *
 * ## Why the wording is the check's own
 *
 * The detail text is reused verbatim rather than paraphrased, so what a run is told in
 * flight is exactly what it will be judged by. A shorter in-flight sentence would be a
 * second description of the same condition, and the two would drift.
 *
 * @param project - The working copy as it stands after the last applied patch.
 * @param options - The same critique options the final self-check will use.
 * @returns One line per unmet whole-cut condition; empty when the cut is on target.
 */
export function standingAgainstAcceptance(
  project: Project,
  options: CritiqueOptions = {},
): readonly string[] {
  return wholeCutChecks(project, options)
    .filter((c) => c.status === 'fail' || c.status === 'warn')
    .map((c) => c.detail);
}

/**
 * Checks that judge what the REQUEST asked for rather than the timeline's own health. A
 * failure here can never be "inherited" from the starting project: a 136-second timeline
 * fails a 30-second duration target before AND after a run that never shortened it, and
 * that is the run's failure, not the footage's.
 */
const REQUEST_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>([
  'request_match',
  'duration_target',
  'shot_count',
  'shot_length_target',
  'treatment_coverage',
  'temporal_evidence',
  'vision_review',
  'export_settings',
]);

/** How an inherited finding is worded, so the editor can tell it from one the run caused. */
export const INHERITED_PREFIX = 'Already so before this edit, not caused by it — ';

/**
 * Verification judges the DELTA, not the absolute state (goal.md Workstream A/D).
 *
 * A failing check that already failed on the project the run started from, with the
 * identical detail, describes something the footage had before the agent touched it —
 * five landscape sources in a portrait frame, a jump cut the user made last week. Failing
 * a correct edit for it costs a paid repair turn that cannot fix it (the repair pass is
 * scoped to the edit), and settles the run as `failed` over work that was right. Such
 * findings are carried as advisories: said, once, and not blocking. A request-derived
 * check (see {@link REQUEST_CHECKS}) is never excused this way, and neither is a health
 * check whose detail changed — that is a finding the edit touched.
 *
 * @param before - The critique of the project the run started from, same options.
 * @param after - The critique of the project the run produced.
 * @returns `after` with inherited failures downgraded to `warn`, and `ok`/`summary` recomputed.
 */
export function reconcileInheritedFailures(
  before: CritiqueReport,
  after: CritiqueReport,
): CritiqueReport {
  const priorFailures = new Map(
    before.checks.filter((c) => c.status === 'fail').map((c) => [c.id, c.detail] as const),
  );
  let inherited = 0;
  const checks = after.checks.map((check): CriticCheck => {
    if (check.status !== 'fail' || REQUEST_CHECKS.has(check.id)) return check;
    if (priorFailures.get(check.id) !== check.detail) return check;
    inherited += 1;
    return { ...check, status: 'warn', detail: `${INHERITED_PREFIX}${check.detail}` };
  });
  if (inherited === 0) return after;
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const ok = fails === 0;
  const tail = `${String(inherited)} inherited from the footage`;
  const summary = ok
    ? `Passed with ${String(warns)} warning(s) (${tail}).`
    : `${String(fails)} check(s) failed, ${String(warns)} warning(s) (${tail}).`;
  return { checks, ok, summary };
}

/** A stretch of transcript that is one phrase repeated — the ASR hallucination signature. */
export interface TranscriptLoop {
  /** The repeated phrase, as transcribed. */
  readonly phrase: string;
  /** How many times it repeats back to back. */
  readonly repeats: number;
  /** Seconds of the recording the repetition covers. */
  readonly seconds: number;
  /** That span as a share of the transcript's own span, 0..1. */
  readonly share: number;
  /** Source second the repetition starts at — the low edge of the unreliable stretch. */
  readonly startSeconds: number;
  /** Source second it ends at. Word timings in `[startSeconds, endSeconds]` mean nothing. */
  readonly endSeconds: number;
}

/** Repeats before a phrase is a hallucination rather than a chorus. */
const LOOP_MIN_REPEATS = 8;
/** …and the share of the transcript it must cover, so a real refrain is not flagged. */
const LOOP_MIN_SHARE = 0.5;

/**
 * Is this transcript mostly one phrase repeated — i.e. did ASR hallucinate?
 *
 * Whisper's best-known failure mode is a loop: over quiet or music-only audio it emits one
 * sentence again and again, with plausible timings, and nothing downstream can tell those
 * words from spoken ones. This function was written against `mission-podcast`, whose media
 * was then 2431 words of which 2384 — 92%, from 21.7s to 575.5s — were "I'll try to follow
 * you later." repeated 397 times over a clip whose real speech stopped around 30s. That
 * fixture has since been replaced (`speech-9min-c`), so the detector no longer fires on any
 * project in the repo; it stays because the failure it catches is whisper's, not that
 * fixture's, and the next quiet recording a user imports reproduces it exactly.
 *
 * That matters well beyond one fixture. The transcript is what grounds a highlight
 * selection, a silence pass and every caption, so a run that trusts a hallucinated one cuts
 * confidently on words nobody said, and every check that reads the transcript — `dead_air`,
 * `word_severed` — agrees with it. Detecting the loop is what lets the run say so instead.
 *
 * Deliberately conservative, because a chorus, a chant and a drill are all legitimately
 * repetitive: the phrase must repeat back to back at least {@link LOOP_MIN_REPEATS} times AND
 * cover at least half the transcript's span. Real speech does not do both.
 *
 * @param words - The transcript, in time order.
 * @returns The loop, or `undefined` when the transcript does not look fabricated.
 */
export function detectTranscriptLoop(words: readonly TranscriptWord[]): TranscriptLoop | undefined {
  if (words.length < LOOP_MIN_REPEATS * 2) return undefined;
  const span = words[words.length - 1]!.end - words[0]!.start;
  if (!(span > 0)) return undefined;
  const norm = (w: TranscriptWord): string => w.word.trim().toLowerCase();
  // Try each plausible phrase length, shortest first: the loop's period is unknown, and a
  // longer window would also match a multiple of the true one.
  for (let size = 1; size <= 12; size++) {
    for (let start = 0; start + size * LOOP_MIN_REPEATS <= words.length; start++) {
      const phrase = words
        .slice(start, start + size)
        .map(norm)
        .join(' ');
      if (!phrase) continue;
      let repeats = 1;
      let index = start + size;
      while (
        index + size <= words.length &&
        words
          .slice(index, index + size)
          .map(norm)
          .join(' ') === phrase
      ) {
        repeats++;
        index += size;
      }
      if (repeats < LOOP_MIN_REPEATS) continue;
      const seconds = words[index - 1]!.end - words[start]!.start;
      const share = seconds / span;
      if (share < LOOP_MIN_SHARE) continue;
      return {
        phrase: words
          .slice(start, start + size)
          .map((w) => w.word.trim())
          .join(' '),
        repeats,
        seconds,
        share,
        startSeconds: words[start]!.start,
        endSeconds: words[index - 1]!.end,
      };
    }
  }
  return undefined;
}

/** The transcript grounding every word-level edit is not obviously fabricated. */
function checkTranscriptReliable(project: Project, loop: TranscriptLoop | undefined): CriticCheck {
  const words = project.transcript;
  if (words.length === 0) {
    return check(
      'transcript_reliable',
      'Transcript looks real',
      'skipped',
      'No transcript to check.',
    );
  }
  if (loop === undefined) {
    return check(
      'transcript_reliable',
      'Transcript looks real',
      'pass',
      `${String(words.length)} transcribed word(s), no repetition loop.`,
    );
  }
  // A WARNING, never a failure. The transcript may be wrong but the edit built on it can
  // still be the best available, and failing the run would leave it with nothing to do —
  // whereas saying so lets it stop grounding cuts on words nobody said.
  return check(
    'transcript_reliable',
    'Transcript looks real',
    'warn',
    `The transcript repeats "${loop.phrase}" ${String(loop.repeats)} times back to back, ` +
      `covering ${round(loop.seconds)}s — ${String(Math.round(loop.share * 100))}% of it. That is ` +
      'the signature of speech recognition looping over quiet audio, not of speech. Treat ' +
      'word timings in that stretch as unreliable, and do not select or cut on them.',
  );
}

export function critique(project: Project, options: CritiqueOptions = {}): CritiqueReport {
  const timeline = project.timeline;
  // Every editorial threshold is stated in frames, so every editorial check needs the
  // project's rate. `Project.fps` is required by the schema; the guard is for a
  // hand-built fixture that lies about it, which must not turn a review into a crash.
  const fps = Number.isFinite(project.fps) && project.fps > 0 ? project.fps : 30;
  // Detected ONCE and shared: `transcript_reliable` reports the loop and `word_severed`
  // has to honour the same verdict, and the scan is quadratic in the transcript.
  const loop = detectTranscriptLoop(project.transcript);
  const checks: CriticCheck[] = [
    checkRequestMatch(options),
    checkPicturePresent(project, options),
    ...wholeCutChecks(project, options),
    checkHiddenPicture(project),
    checkCaptionAlignment(timeline),
    checkSafeArea(timeline, project.resolution),
    checkAudioClipping(options),
    checkBlackFrames(options),
    ...(options.temporal === undefined ? [] : [checkTemporalEvidence(options)]),
    ...(options.vision === undefined ? [] : [checkVisionReview(options)]),
    checkMissingAssets(project),
    checkExportSettings(project, options),
    checkTranscriptReliable(project, loop),
    // Editorial checks (Phase 4) — "is this a good cut?", after "is it well-formed?".
    checkJumpCut(project, fps),
    checkWordSevered(project, fps, loop),
    checkDeadAir(project, fps, options),
    checkTransitionFit(project, fps),
    checkAudioSlam(project, fps),
    checkShotRhythm(project, fps),
  ];
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const ok = fails === 0;
  const summary = ok
    ? warns === 0
      ? 'All checks passed.'
      : `Passed with ${warns} warning(s).`
    : `${fails} check(s) failed${warns > 0 ? `, ${warns} warning(s)` : ''}.`;
  return { checks, ok, summary };
}
