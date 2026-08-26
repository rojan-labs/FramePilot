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
import { CAPTION_ASSET_ID, TEXT_OVERLAY_ASSET_ID } from '@framepilot/editor-core';
import type { Clip, Effect, Project, Timeline } from '@framepilot/timeline-schema';
import { COVERAGE_LABEL, type CoverageTreatment } from './acceptance.js';
import type { TargetPlatform } from './context-builder.js';
import type { TemporalReviewReport } from './temporal-review.js';
import type { VisionReviewReport } from './vision-review.js';

/** Outcome of a single Critic check. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

/** The fixed set of checks the Critic runs, mirroring PRD §8.6. */
export type CheckId =
  | 'request_match'
  | 'picture_present'
  | 'duration_target'
  | 'shot_count'
  | 'reframe_coverage'
  | 'treatment_coverage'
  | 'caption_alignment'
  | 'safe_area'
  | 'audio_clipping'
  | 'black_frames'
  | 'temporal_evidence'
  | 'vision_review'
  | 'missing_assets'
  | 'export_settings';

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
 * Read an explicit deliverable length from ordinary creator language.
 *
 * Deliberately conservative: a bare timestamp such as "cut at 30 seconds" is not a
 * duration target. A match must connect the number to a deliverable word (video,
 * montage, reel, short, timeline), an explicit length phrase ("make it … long"), or
 * the whole-output qualifiers "full"/"complete"/"entire".
 */
export function explicitDurationTargetSeconds(prompt: string): number | undefined {
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  const unitValue = (value: string, unit: string): number => {
    const amount = Number(value);
    return /^m(?:in(?:ute)?s?)?$/.test(unit) ? amount * 60 : amount;
  };
  const units = '(s|sec|secs|second|seconds|m|min|mins|minute|minutes)';
  const leading = new RegExp(
    `\\b(?:full|complete|entire|video|montage|reel|short|timeline|make it|create|build|produce|export)\\b.{0,40}?\\b(\\d+(?:\\.\\d+)?)\\s*${units}\\b`,
  ).exec(normalized);
  if (leading?.[1] && leading[2]) return unitValue(leading[1], leading[2]);
  const trailing = new RegExp(
    `\\b(\\d+(?:\\.\\d+)?)\\s*[- ]?${units}\\b.{0,28}?\\b(?:video|montage|reel|short|timeline|long)\\b`,
  ).exec(normalized);
  if (trailing?.[1] && trailing[2]) return unitValue(trailing[1], trailing[2]);
  return undefined;
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
function checkPicturePresent(timeline: Timeline, options: CritiqueOptions): CriticCheck {
  const picture = allClips(timeline).filter((clip) => !isOverlayClip(clip));
  if (picture.length > 0) {
    return check(
      'picture_present',
      'The edit has picture',
      'pass',
      `${String(picture.length)} picture clip${picture.length === 1 ? '' : 's'} on the timeline.`,
    );
  }
  const overlays = allClips(timeline).length;
  if (overlays === 0) {
    return check(
      'picture_present',
      'The edit has picture',
      'skipped',
      'The timeline is empty, so there is nothing to judge.',
    );
  }
  const detail =
    `The timeline has ${String(overlays)} overlay/caption clip${overlays === 1 ? '' : 's'} and ` +
    'no picture under them, so the whole thing renders as text on black. Place footage, a ' +
    'still, or a stock clip before this is a video.';
  // A visual target — a platform, a duration, a shot count — means someone asked for a
  // film. Failing then is the honest verdict; without one, say it and let the run decide.
  const wantsPicture =
    options.targetPlatform !== undefined ||
    options.durationTargetSeconds !== undefined ||
    options.minShotCount !== undefined;
  return check('picture_present', 'The edit has picture', wantsPicture ? 'fail' : 'warn', detail);
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
function checkShotCount(timeline: Timeline, options: CritiqueOptions): CriticCheck {
  const target = options.minShotCount;
  if (target === undefined) {
    return check('shot_count', 'Shot count on target', 'skipped', 'No shot count was asked for.');
  }
  const shots = allClips(timeline).filter((clip) => !isOverlayClip(clip)).length;
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
function checkTreatmentCoverage(timeline: Timeline, options: CritiqueOptions): CriticCheck {
  const wanted = options.coverage ?? [];
  if (wanted.length === 0) {
    return check(
      'treatment_coverage',
      'Per-clip work is complete',
      'skipped',
      'The request asked for nothing of every clip.',
    );
  }
  const picture = allClips(timeline).filter((clip) => !isOverlayClip(clip));
  if (picture.length === 0) {
    return check('treatment_coverage', 'Per-clip work is complete', 'skipped', 'No picture clips.');
  }
  const shortfalls: string[] = [];
  for (const treatment of wanted) {
    const carried = picture.filter((clip) => clipCarries(clip, treatment)).length;
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
 * Asked as a consistency question rather than a geometry one, because the project does not
 * carry each asset's pixel dimensions: nobody deliberately reframes a fifth of a sequence, so
 * a MIX of reframed and unreframed picture is a defect regardless of what the sources are. A
 * sequence with no crops at all cannot be judged the same way — it may be a same-aspect edit
 * that needs none — so a portrait frame with nothing reframed is a warning, not a failure.
 */
function checkReframeCoverage(project: Project, timeline: Timeline): CriticCheck {
  const picture = allClips(timeline).filter((clip) => !isOverlayClip(clip));
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
    return check(
      'reframe_coverage',
      'Reframing is consistent',
      'warn',
      `No clip is reframed in a ${String(width)}x${String(height)} portrait frame — any ` +
        'landscape source will render with black bars. Crop each shot to fill the frame if ' +
        'that is not intended.',
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
  const missing = picture.filter((clip) => clip.crop === undefined);
  const named = missing.slice(0, 3).map((clip) => clip.id);
  const rest = missing.length - named.length;
  return check(
    'reframe_coverage',
    'Reframing is consistent',
    'fail',
    `${String(reframed.length)} of ${String(picture.length)} picture clips are reframed, so ` +
      `${String(missing.length)} will not match: ${named.join(', ')}` +
      `${rest > 0 ? `, plus ${String(rest)} more` : ''}.`,
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
 * Overlays/captions positioned by a normalized (0–1) x/y must stay inside the
 * safe-area inset. Clips with no explicit position are assumed centered (safe).
 */
function checkSafeArea(timeline: Timeline): CriticCheck {
  const overlayClips = overlayOrCaptionClips(timeline);
  const lo = SAFE_AREA_INSET;
  const hi = 1 - SAFE_AREA_INSET;
  const outside: string[] = [];
  let positioned = 0;
  for (const clip of overlayClips) {
    for (const effect of clip.effects) {
      const x = numParam(effect, 'x');
      const y = numParam(effect, 'y');
      if (x === undefined && y === undefined) continue;
      positioned += 1;
      if ((x !== undefined && (x < lo || x > hi)) || (y !== undefined && (y < lo || y > hi))) {
        outside.push(`${clip.id} at (${x ?? '—'}, ${y ?? '—'})`);
      }
    }
  }
  if (positioned === 0) {
    return check(
      'safe_area',
      'Overlays in safe area',
      'skipped',
      'No explicitly-positioned overlays/captions to check (centered layouts are safe).',
    );
  }
  if (outside.length > 0) {
    return check(
      'safe_area',
      'Overlays in safe area',
      'warn',
      `Outside the ${Math.round(SAFE_AREA_INSET * 100)}% safe area: ${outside.join(', ')}.`,
    );
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
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the full Critic battery over a project (PRD §8.6).
 *
 * @param project - The project to review (its timeline is the edited result).
 * @param options - Target/render context that informs the checks.
 * @returns A {@link CritiqueReport}; `ok` is false when any check failed.
 */
export function critique(project: Project, options: CritiqueOptions = {}): CritiqueReport {
  const timeline = project.timeline;
  const checks: CriticCheck[] = [
    checkRequestMatch(options),
    checkPicturePresent(timeline, options),
    checkDurationTarget(timeline, options),
    checkShotCount(timeline, options),
    checkReframeCoverage(project, timeline),
    checkTreatmentCoverage(timeline, options),
    checkCaptionAlignment(timeline),
    checkSafeArea(timeline),
    checkAudioClipping(options),
    checkBlackFrames(options),
    ...(options.temporal === undefined ? [] : [checkTemporalEvidence(options)]),
    ...(options.vision === undefined ? [] : [checkVisionReview(options)]),
    checkMissingAssets(project),
    checkExportSettings(project, options),
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
