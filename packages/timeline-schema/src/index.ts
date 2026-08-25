/**
 * @framepilot/timeline-schema — Zod schemas + inferred types for the FramePilot
 * project/timeline data model (PRD §11).
 *
 * These are pure data-shape definitions (no behavior). They are the single source
 * of truth for the timeline structure and must be kept in sync with the Python
 * Pydantic schemas via the shared JSON Schema (see {@link buildProjectJsonSchema}
 * and `schema/project.schema.json`).
 *
 * Implemented in plan/PLAN.md Phase 1.1 (Timeline schema).
 *
 * WHY `zod/v4`: it ships the native `z.toJSONSchema` exporter (zod 3.25+ bundles
 * the v4 API under this subpath without a separate dependency), which lets us
 * derive the cross-language contract from this single source of truth instead of
 * hand-maintaining a parallel JSON Schema.
 */
import { z } from 'zod/v4';

/**
 * Bump on any breaking change to the schema. A migration is required before the
 * schema can change in a way that invalidates existing `project.fp.json` files.
 */
export const SCHEMA_VERSION = 20 as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const ResolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * Track kinds supported by the editor (PRD §11.2).
 *
 * `effect` (schema v13) is an **adjustment lane**: it carries no clips and no
 * asset, only time-ranged {@link EffectLayerSchema} entries that restyle
 * whatever picture is composited *beneath* them. See ADR 0088.
 */
export const TrackTypeSchema = z.enum(['video', 'audio', 'caption', 'overlay', 'effect']);

/**
 * What a sound track *is* in the mix (schema v17).
 *
 * Roles are the difference between "lower track a3" and "duck the music under the dialogue".
 * They must be authored — by the editor in the UI, or by an explicit instruction — and are
 * deliberately NOT inferred from file names, track names, or content heuristics: a track called
 * "music" can hold a voice-over, and acting on that guess silently mixes the wrong thing.
 * Absent means unknown, which is honest and stays honest until someone says otherwise.
 */
export const AudioRoleSchema = z.enum(['dialogue', 'music', 'sfx']);
export type AudioRole = z.infer<typeof AudioRoleSchema>;

/**
 * One immutable logical Capability Pack release used by this project (schema v19).
 *
 * The pin is intentionally platform-neutral. `releaseDigest` identifies the signed
 * cross-platform release record; that record selects a different verified artifact on
 * macOS arm64 and Windows x64. Persisting a macOS artifact digest here would make the
 * project impossible to reopen correctly on Windows.
 */
export const CapabilityPackPinSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/),
  /** SHA-256 of the canonical signed release record, not a platform artifact. */
  releaseDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Registry capability ids this project actually consumed from the release. */
  capabilities: z.array(z.string().min(1).max(160)).min(1).max(64),
  /** Whether missing bytes prevent render, further editing, or only re-analysis. */
  requiredFor: z.enum(['render', 'edit', 'analysis']),
});

/**
 * One word-level transcript entry with timestamps (PRD §6.2).
 *
 * Declared here among the primitives — ahead of the caption section — because
 * {@link CaptionCueSchema} embeds a list of these, and a caption cue lives on
 * {@link ClipSchema}. Zod builds its schema graph eagerly at module evaluation,
 * so a referenced schema must already exist; this shape has no dependencies of
 * its own, which makes "primitives" its natural home.
 */
export const TranscriptWordSchema = z.object({
  word: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  /**
   * The asset these timestamps belong to (schema v12).
   *
   * WHY it is required for correctness and yet optional in the shape: through
   * v11 {@link ProjectSchema.transcript} was one flat, unattributed word list,
   * which is only unambiguous for a single-asset project. Adding the attribution
   * is what makes `transcript` meaningful once a project has two camera files —
   * without it, "19.2s" names two different moments and the mapper cannot know
   * which. Absent ⇒ "belongs to whichever asset is being mapped", which is the
   * v11 behavior and keeps every existing project file valid.
   *
   * **Nullable, not merely optional** — the same contract `AssetMedia` already
   * documents: the Python engine models these as `str | None` and
   * `model_dump(by_alias=True)` serializes an absent value as JSON `null`, not an
   * omitted key. A bare `.optional()` would reject a live engine transcript and
   * fail the whole project parse.
   *
   * @see docs/adr/0076-canonical-timeline-mapping.md
   */
  assetId: z.string().nullish(),
  /** ASR confidence in `[0,1]`, when the provider reports one (schema v12). */
  confidence: z.number().min(0).max(1).nullish(),
  /** Diarized speaker label, when the provider reports one (schema v12). */
  speaker: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Keyframe / Effect (PRD §11.4)
// ---------------------------------------------------------------------------

/**
 * One bezier control point, normalised to the segment it shapes (schema v14,
 * ADR 0089).
 *
 * `x` is progress along the segment and is clamped to `[0, 1]` — an x outside that
 * makes the curve non-monotonic in time, which means the property would travel
 * backwards mid-segment. `y` is deliberately **unbounded**: overshoot (y > 1) and
 * anticipation (y < 0) are the whole reason to reach for a custom curve, and every
 * animation tool allows them.
 */
export const BezierHandleSchema = z.tuple([z.number().min(0).max(1), z.number()]);

export const KeyframeSchema = z.object({
  id: z.string(),
  /** Time of the keyframe, in seconds, relative to the clip/effect. */
  time: z.number().nonnegative(),
  /** Animated property name (e.g. "scale", "opacity", "x"). */
  property: z.string(),
  /** Property value at this keyframe. */
  value: z.number(),
  easing: z
    .enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier'])
    .default('linear'),
  /**
   * Custom bezier control points (schema v14, ADR 0089).
   *
   * Only meaningful when `easing === 'bezier'`. A segment `a → b` is shaped by
   * **`a.handles.out` and `b.handles.in`** — the same two-sided convention CSS
   * `cubic-bezier()` and every animation tool use, which is why a handle lives on
   * the keyframe rather than on the segment.
   *
   * **Absent means today's hardcoded smoothstep** (`3t² − 2t³`), so every v13
   * project renders byte-identically after the migration. It is not "absent means
   * linear" and not "absent means some default bezier": either would silently change
   * existing animations.
   */
  handles: z
    .object({
      /** Outgoing control point — shapes the segment INTO the next keyframe. */
      out: BezierHandleSchema,
      /** Incoming control point — shapes the segment FROM the previous keyframe. */
      in: BezierHandleSchema,
    })
    .optional(),
});

/**
 * One control point on a clip's **speed curve** (schema v15, ADR 0090).
 *
 * **`sourceTime` is clip-relative SOURCE seconds, not timeline seconds** — the
 * single most important thing about this shape. A ramp exists precisely because
 * timeline time is the *integral* of the rate over source time; anchoring a point
 * in timeline time would make every point move whenever an earlier one changed,
 * so editing the first point of a ramp would silently drag the rest of the curve.
 *
 * `rate` must be **strictly positive**. Zero (freeze) and negative (reverse) are
 * expressed by the constant `Clip.speed`, not by a curve: the whole
 * source-time-anchored model depends on source time advancing monotonically, and a
 * rate that reaches or crosses zero makes the timeline↔source mapping
 * non-invertible in exactly the way this anchoring was chosen to avoid. See
 * ADR 0090 for why that is a scope line rather than an oversight.
 *
 * `easing` shapes the rate curve **into the next point**, matching how
 * `Keyframe.easing` works, so the two curve systems read the same way.
 */
export const SpeedPointSchema = z.object({
  id: z.string(),
  /** Clip-relative source seconds (0 = the clip's `sourceStart`). */
  sourceTime: z.number().nonnegative(),
  /** Playback rate at this point. Strictly positive — see the schema docs. */
  rate: z.number().positive(),
  /** Curve from this point into the next. */
  easing: z
    .enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier'])
    .default('linear'),
});

export const EffectSchema = z.object({
  id: z.string(),
  type: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  keyframes: z.array(KeyframeSchema).default([]),
});

// ---------------------------------------------------------------------------
// Effect layers (schema v13, ADR 0088)
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of frame transforms the renderers implement.
 *
 * This is the extensibility contract that makes the effect catalog pure data,
 * exactly as {@link CaptionEmphasisSchema} does for captions: the Python
 * compiler and the WebGL preview branch **only** on these kinds — never on a
 * catalog effect id. Adding a catalog entry that reuses an existing kind with
 * new params costs zero renderer changes; adding a *kind* is a deliberate
 * two-sided implementation (numpy pass + GLSL pass + parity test).
 *
 * Grouped by the family each kind serves. Kinds are intentionally primitive —
 * "Retro Fade" and "Faded Polaroid" are both `film-fade` with different params,
 * which is what keeps a 50+ entry catalog honest instead of 50 near-duplicate
 * shaders.
 */
export const EffectRenderKindSchema = z.enum([
  // Blur & focus
  'blur-gaussian',
  'blur-directional',
  'blur-radial',
  'tilt-shift',
  // Glow & bloom
  'bloom',
  'glow-diffuse',
  'halation',
  // Light leaks & lens
  'light-leak',
  'lens-flare',
  'vignette',
  // Film & cinematic / retro
  'film-fade',
  'film-curve',
  // VHS / camcorder / analog
  'analog-vhs',
  'scanlines',
  'tape-dropout',
  // Chromatic & colour separation
  'chroma-shift',
  'rgb-split',
  // Glitch & digital distortion
  'glitch-block',
  'datamosh',
  'pixel-sort',
  // Shake, impact & motion
  'shake',
  'zoom-punch',
  'whip-pan',
  // Dreamy & soft
  'soft-focus',
  // Distortion & warp
  'fisheye',
  'barrel-warp',
  'ripple',
  // Pixel, mosaic & halftone
  'mosaic',
  'halftone',
  'dither',
  // Noise, grain, dust & scratches
  'grain',
  'dust-scratches',
  // Party, neon & energetic
  'neon-edge',
  'strobe-color',
  // Comic & stylised
  'posterize',
  'sketch',
  // Edge, outline & highlight
  'edge-outline',
  // Flash, strobe & flicker
  'flash',
  'flicker',
  // Split-screen & mirrored
  'mirror',
  'kaleidoscope',
]);

/**
 * One time-ranged effect instance on an `effect` track (schema v13).
 *
 * NOT a {@link ClipSchema}: an effect layer has no asset, no source in/out, no
 * speed and no crop — modelling it as a clip would have forced a sentinel
 * `assetId` past the validator's "every clip resolves to an asset" rule and
 * given every effect a meaningless source range. It is its own shape, and
 * `effect` tracks carry {@link TrackSchema.effectLayers} instead of clips.
 *
 * Semantics: for `[start, end)` this layer's {@link kind} is applied to the
 * frame composited from every **visible track beneath** its own track. Layers
 * compose predictably — within a track in `start` order, then track by track
 * bottom-up — so a stack of two effect tracks is a deterministic pipeline.
 */
export const EffectLayerSchema = z
  .object({
    id: z.string(),
    /**
     * The catalog entry this layer came from
     * (`packages/timeline-schema/src/effect-catalog.ts`). Presentation only —
     * it drives the panel's "applied" marker and the inspector's control set.
     * **No renderer may branch on it**; {@link kind} is the render contract.
     */
    effectId: z.string(),
    /** The frame transform to run. The renderers' only dispatch key. */
    kind: EffectRenderKindSchema,
    /** Timeline-relative start, seconds. */
    start: z.number().nonnegative(),
    /** Timeline-relative end, seconds. */
    end: z.number().nonnegative(),
    /**
     * Kind-specific parameters, validated against the catalog's param
     * descriptors by the patch validator (not here — Zod cannot know the
     * catalog without a circular import, and the validator is where every other
     * cross-referencing timeline rule already lives).
     */
    params: z.record(z.string(), z.number()).default({}),
    /**
     * Master strength in `[0,1]`, applied by every kind as a linear mix between
     * the untouched frame and the fully-affected frame. Absent ≡ 1.
     *
     * WHY every effect gets this for free: it is the one control users reach for
     * first ("less of that"), and defining it as a mix means each renderer
     * implements its look once at full strength and gets dial-back behaviour
     * without per-kind code.
     */
    intensity: z.number().min(0).max(1).optional(),
    /**
     * Temporarily bypassed: kept on the timeline (and in the file) but skipped
     * by preview and render alike. Optional/absent ≡ enabled, so the field only
     * ever appears once a user has actually toggled it off.
     */
    disabled: z.boolean().optional(),
    /** Per-layer property animation, same vocabulary as clips. */
    keyframes: z.array(KeyframeSchema).default([]),
  })
  .refine((layer) => layer.end > layer.start, {
    message: 'Effect layer end must be greater than start (no negative/zero duration).',
    path: ['end'],
  });

// ---------------------------------------------------------------------------
// Caption style (PRD §6.x caption styling, schema v10 — template-based)
// ---------------------------------------------------------------------------

/** Where the caption block anchors vertically in the frame. */
export const CaptionPositionSchema = z.enum(['top', 'middle', 'bottom']);

/**
 * How the caption clip's words are grouped on screen over time:
 * - `phrase`: the whole line is visible for the clip's duration (Karaoke/
 *   Phrase/Boxed/Editorial families).
 * - `active-word`: only the currently spoken word is shown, large (Punchline/
 *   Beast/Impact/Stamp — the "one word" family).
 * - `cumulative`: words appear as they are spoken and stay (Hormozi/
 *   Typewriter/Slide — the "build" family).
 */
export const CaptionDisplayModeSchema = z.enum(['phrase', 'active-word', 'cumulative']);

/**
 * Active-word emphasis vocabulary. Renderers (Python engine + web preview)
 * interpret ONLY these closed enum values — never template ids — which is what
 * keeps the template catalog pure data (see
 * `packages/timeline-schema/src/caption-templates.ts`).
 */
export const CaptionEmphasisSchema = z.enum([
  'none',
  'color',
  'pop',
  'karaoke-fill',
  'background',
  'glow',
  'underline',
  'pulse',
]);

/** Entrance animation for a caption line (or per word when `animation.perWord`). */
export const CaptionEntranceSchema = z.enum([
  'none',
  'fade',
  'slide-up',
  'zoom',
  'bounce',
  'typewriter',
]);

/**
 * Word-highlight configuration for a caption clip. Structured (not a free-form
 * params bag) because both the Python renderer and the web-editor preview need
 * to read/write these fields without stringly-typed lookups — see
 * `docs/adr/0045-caption-style-schema-v5.md` and the v10 revision in
 * `docs/adr/0069-caption-template-schema-v10.md`.
 */
export const CaptionHighlightSchema = z.object({
  /** Whether the active spoken word is highlighted at all. Default: false. */
  enabled: z.boolean().optional(),
  /** Highlight color for the active word's text (any CSS color string). */
  color: z.string().min(1).optional(),
  /** How the highlight animates onto the active word. Default: 'none'. */
  animation: CaptionEmphasisSchema.optional(),
  /** Chip color painted behind the active word (emphasis `background`). */
  background: z.string().min(1).optional(),
  /** Scale factor for `pop`/`pulse` emphasis. Default: 1.18. */
  scale: z.number().positive().optional(),
});

/**
 * Background chip behind the whole caption line. Radius/padding are fractions
 * of the resolved font size so the chip scales with the text at any output
 * resolution. A fully transparent `color` (e.g. `#00000000`) means "no chip".
 */
export const CaptionBackgroundSchema = z.object({
  color: z.string().min(1),
  /** Corner radius, as a fraction of font size. */
  radius: z.number().nonnegative().optional(),
  /** Horizontal padding, as a fraction of font size. */
  paddingX: z.number().nonnegative().optional(),
  /** Vertical padding, as a fraction of font size. */
  paddingY: z.number().nonnegative().optional(),
});

/**
 * Drop shadow / glow behind the caption text. `blur` is a fraction of font
 * size; zero offsets with a non-zero blur reads as a glow.
 */
export const CaptionShadowSchema = z.object({
  color: z.string().min(1),
  blur: z.number().nonnegative(),
  offsetX: z.number(),
  offsetY: z.number(),
});

/**
 * Entrance / exit / loop animation for the caption line. Durations and periods
 * are in seconds, relative to the clip (per-word start times when `perWord`).
 */
export const CaptionAnimationSchema = z.object({
  in: z.object({ type: CaptionEntranceSchema, duration: z.number().positive() }).optional(),
  out: z.object({ type: z.enum(['none', 'fade']), duration: z.number().positive() }).optional(),
  loop: z.object({ type: z.enum(['pulse', 'wave']), period: z.number().positive() }).optional(),
  /** Stagger the entrance per word (Cascade/Kinetic/Slide-style builds). */
  perWord: z.boolean().optional(),
});

/**
 * Deterministic accent-word styling for mixed-size / mixed-font looks (e.g. a
 * script "viral" inside a sans line). Selection must be deterministic so the
 * engine render and the web preview always pick the same word.
 */
export const CaptionAccentSchema = z.object({
  mode: z.enum(['none', 'last-word', 'longest-word', 'keywords']),
  fontFamily: z.string().min(1).optional(),
  /** Size multiplier relative to the line's font size. */
  fontScale: z.number().positive().optional(),
  color: z.string().min(1).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  /**
   * The words `mode: 'keywords'` accents, compared punctuation-insensitively and
   * case-insensitively against each caption word (schema v11).
   *
   * WHY this field exists: `'keywords'` shipped in the v10 accent vocabulary with
   * **no keyword source anywhere**, so both renderers had to treat it as a no-op
   * (`captionPreview.ts`: "has no engine-side keyword source yet and selects
   * nothing"; `render/captions.py` the same). The editor's keyword chips were
   * therefore preview-only and never reached an export. Persisting the list here
   * makes the enum value it was always meant to drive actually render, and keeps
   * emphasis a property of the caption — not of whichever panel is open.
   */
  keywords: z.array(z.string().min(1)).optional(),
});

/**
 * Rich, persisted caption style (schema v10 — template-based; v5 introduced
 * the field, ADR 0045; v10 rewrote it around the template catalog, ADR 0069).
 * Meaningful only on caption-kind clips (created via `add_caption_layer`,
 * `assetId === '__caption__'`), but modeled as an optional {@link ClipSchema}
 * field — like {@link Clip.keyframes} — rather than nested inside the caption
 * `Effect`'s free-form `params`, so the renderer and editor UI can read/write
 * it with full typed field access instead of unpacking an untyped record.
 *
 * Resolution: `templateId` names a `CAPTION_TEMPLATE_CATALOG` entry whose
 * style fills every field left unset here; explicit fields are user overrides
 * and always win (`resolveCaptionStyle`). All fields optional so an unstyled
 * clip keeps the baseline pre-v5 rendering.
 */
export const CaptionStyleSchema = z.object({
  /** Id of the caption template this style is based on (catalog entry). */
  templateId: z.string().min(1).optional(),
  /** How words are grouped on screen over time. Default: 'phrase'. */
  display: CaptionDisplayModeSchema.optional(),
  /** CSS-style font family name (e.g. "Inter", "Archivo Black"). */
  fontFamily: z.string().min(1).optional(),
  /** Font weight, 100–900. Rendered from per-weight font files. */
  fontWeight: z.number().int().min(100).max(900).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  textTransform: z.enum(['none', 'uppercase', 'lowercase']).optional(),
  /** Extra letter spacing, as a fraction of font size (em). */
  letterSpacing: z.number().optional(),
  /** Font size multiplier relative to the caption track's base size. */
  fontScale: z.number().positive().optional(),
  /** Caption text color (any CSS color string). */
  textColor: z.string().min(1).optional(),
  /** Text outline/stroke color (any CSS color string). */
  outlineColor: z.string().min(1).optional(),
  /** Text outline/stroke width, in the same units as font size. */
  outlineWidth: z.number().nonnegative().optional(),
  /** Vertical anchor for the caption block. Default: 'bottom'. */
  position: CaptionPositionSchema.optional(),
  /** Freeform horizontal centre, as a percentage of the video frame. */
  xPercent: z.number().min(0).max(100).optional(),
  /** Freeform vertical centre, as a percentage of the video frame. */
  yPercent: z.number().min(0).max(100).optional(),
  /** Caption block rotation in degrees, clockwise in the UI/render contract. */
  rotation: z.number().finite().optional(),
  /** Maximum caption block width as a percentage of the video frame. */
  maxWidthPercent: z.number().min(5).max(100).optional(),
  /** Authored line alignment inside the caption block. */
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  /** Unitless line-height multiplier. */
  lineHeight: z.number().min(0.7).max(3).optional(),
  /** Keep the caption centre inside the title-safe 10% inset. Default: true. */
  safeArea: z.boolean().optional(),
  /** Background chip behind the whole line. */
  background: CaptionBackgroundSchema.optional(),
  /** Drop shadow / glow behind the text. */
  shadow: CaptionShadowSchema.optional(),
  /** Active-word highlight configuration (karaoke-style emphasis). */
  highlight: CaptionHighlightSchema.optional(),
  /** Entrance / exit / loop animation. */
  animation: CaptionAnimationSchema.optional(),
  /** Accent-word styling for mixed-size/mixed-font looks. */
  accent: CaptionAccentSchema.optional(),
});

// ---------------------------------------------------------------------------
// Caption cue (schema v11 — the caption's OWN text, ADR 0071)
// ---------------------------------------------------------------------------

/**
 * The text a caption clip displays, and the word timings that drive its
 * karaoke/build animation (schema v11, ADR 0071).
 *
 * WHY this exists — the v10 model had no cue text at all. A caption clip stored
 * only a time range, and every consumer independently re-derived its words from
 * {@link ProjectSchema.transcript}. That had four consequences, all of which this
 * field fixes:
 *
 * 1. **Caption text could not be edited.** Fixing one ASR error, rewording a
 *    line, or censoring a word was impossible without rewriting the project
 *    transcript — which changes every other cue over the same words.
 * 2. **The derivations drifted.** `CaptionEditor` matched words by *start
 *    containment* while the preview and the Python renderer matched by *overlap*,
 *    so the caption list showed different text than the export produced for any
 *    word straddling a cue boundary.
 * 3. **Trimming footage silently rewrote captions,** because cue content was a
 *    function of the live transcript rather than of the cue.
 * 4. **Line breaks were unexpressible** — wrapping was whatever the renderer's
 *    greedy fill happened to do.
 *
 * `words` is the cue's own copy of its timings, not a pointer into the project
 * transcript: a cue must keep animating correctly after the transcript is
 * re-run, re-timed, or replaced. `text` is authoritative for what is *displayed*
 * and may legitimately differ from `words.map(w => w.word).join(' ')` (an edited
 * line, a manual `\n`, a redaction) — renderers draw `text` and use `words` only
 * to time emphasis, matching by position (see `alignCueWords`).
 *
 * **Backward compatibility:** absent ⇒ derive from the project transcript by
 * overlap, exactly as v10 did. A v10 project renders byte-identically until it is
 * re-captioned or a cue is edited.
 */
export const CaptionCueSchema = z.object({
  /**
   * The displayed text. `\n` is an explicit, author-controlled line break;
   * renderers wrap the remaining runs to the safe area as before.
   */
  text: z.string(),
  /**
   * Per-word timings for emphasis (karaoke fill, active-word, cumulative build),
   * in absolute timeline seconds like the project transcript. Empty is valid — a
   * hand-typed cue has no word timing, and renderers fall back to showing the
   * whole line for the clip's duration.
   */
  words: z.array(TranscriptWordSchema).default([]),
  /**
   * The {@link TimelineSchema.revision} this cue's timing was derived from
   * (schema v12).
   *
   * A cue's `start`/`end`/`words` are only meaningful against the sequence timing
   * that produced them. When the timeline's revision has moved past this value,
   * the cue is **stale**: it may still be correct (the edit was elsewhere), but
   * nothing may assume so — it has to be remapped or regenerated. Absent ⇒
   * "provenance unknown", which is how every pre-v12 cue is treated: shown, but
   * never claimed to be verified.
   *
   * @see docs/adr/0076-canonical-timeline-mapping.md
   */
  derivedFromRevision: z.number().int().nonnegative().optional(),
  /**
   * The asset-relative range this cue's words came from, and via which clip
   * (schema v12) — the cue's provenance in the source, kept alongside the
   * sequence timing in `words`.
   *
   * WHY keep both: sequence time is what renders, source time is what survives an
   * edit. Holding the source range means a cue can be *remapped* after a later
   * trim or reorder instead of being regenerated from scratch, and means
   * verification can prove a caption references retained footage rather than
   * deleted footage. Absent on hand-typed cues, which have no source.
   */
  source: z
    .object({
      assetId: z.string(),
      clipId: z.string(),
      start: z.number().nonnegative(),
      end: z.number().nonnegative(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Crop rect (schema v7, H1.2 crop/reframe slice)
// ---------------------------------------------------------------------------

/**
 * Axis-aligned crop rect, as fractions (0..1) of the clip's **source** frame —
 * the same "frame fractions" convention `editor-core`'s `MaskBounds` already
 * uses for `add_mask`/`track_object` (see `docs/adr/0047-clip-crop-schema-v7.md`).
 * `x`/`y` are the top-left corner; `width`/`height` extend from it. The rect
 * must stay within the source frame (`x + width <= 1`, `y + height <= 1`) and
 * have a positive width/height — enforced here via `.refine()` (mirrors how
 * `ClipSchema` itself refines its own always-true structural invariants),
 * since "stays within the unit frame" is an invariant of the rect's own shape,
 * not a whole-clip one.
 */
export const CropRectSchema = z
  .object({
    /** Left edge, as a fraction (0..1) of the source frame width. */
    x: z.number().min(0),
    /** Top edge, as a fraction (0..1) of the source frame height. */
    y: z.number().min(0),
    /** Crop width, as a fraction (0, 1] of the source frame width. */
    width: z.number().positive(),
    /** Crop height, as a fraction (0, 1] of the source frame height. */
    height: z.number().positive(),
  })
  .refine((r) => r.x + r.width <= 1 + 1e-9, {
    message: 'Crop rect right edge (x + width) must not exceed 1 (the source frame width).',
    path: ['width'],
  })
  .refine((r) => r.y + r.height <= 1 + 1e-9, {
    message: 'Crop rect bottom edge (y + height) must not exceed 1 (the source frame height).',
    path: ['height'],
  });

// ---------------------------------------------------------------------------
// Blend mode (schema v8, H1.2 compositing slice)
// ---------------------------------------------------------------------------

/**
 * Standard compositing blend modes a clip can be composited with against the
 * layers beneath it. This is the subset of the well-known CSS
 * `mix-blend-mode` / Photoshop blend-mode vocabulary that Pillow's
 * `ImageChops` (and equivalent simple per-pixel-arithmetic implementations
 * MoviePy/Pillow can realistically composite) can deliver without a bespoke
 * blend kernel per mode — see `docs/adr/0048-clip-blend-mode-schema-v8.md` for
 * the full rationale and the modes deliberately left out (e.g. `hue`/
 * `saturation`/`color`/`luminosity`, which require HSL-space blending, not
 * simple per-channel arithmetic).
 */
export const BlendModeSchema = z.enum([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
]);

// ---------------------------------------------------------------------------
// Clip (PRD §11.3)
// ---------------------------------------------------------------------------

export const ClipSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    trackId: z.string(),
    /** Timeline-relative start, seconds. */
    start: z.number().nonnegative(),
    /** Timeline-relative end, seconds. */
    end: z.number().nonnegative(),
    /** In-point within the source asset, seconds. */
    sourceStart: z.number().nonnegative(),
    /** Out-point within the source asset, seconds. */
    sourceEnd: z.number().nonnegative(),
    effects: z.array(EffectSchema).default([]),
    keyframes: z.array(KeyframeSchema).default([]),
    /**
     * Rich, persisted caption style (schema v5; template-based since v10).
     * A *per-cue override*: it wins over the owning track's
     * {@link TrackSchema.captionStyle} default, which in turn wins over the
     * template catalog. See {@link CaptionStyleSchema}.
     */
    captionStyle: CaptionStyleSchema.optional(),
    /**
     * The caption's own text + word timings (schema v11). Meaningful only on
     * caption-kind clips; absent ⇒ derive from the project transcript by overlap
     * (the v10 behavior). See {@link CaptionCueSchema}.
     */
    captionCue: CaptionCueSchema.optional(),
    /**
     * Constant playback rate (schema v6, speed/time-remap). `1` (or absent) is
     * today's behavior: timeline duration == source duration. A `speed` != 1
     * decouples them — `sourceStart`/`sourceEnd` keep meaning "the asset range
     * this clip consumes" and the timeline duration is *derived*:
     * `end - start === (sourceEnd - sourceStart) / speed`. E.g. `speed: 2` (2x)
     * consumes the same footage in half the timeline time; `speed: 0.5`
     * (slow-mo) stretches it to twice the timeline time. Must be positive;
     * enforced clip-internally by the patch validator (see
     * `docs/adr/0046-clip-speed-schema-v6.md`), not here (Zod `.refine()` on the
     * whole clip is intentionally reserved for the always-true structural
     * invariants already established by this schema).
     *
     * **Widened in schema v15 (ADR 0090)** from `.positive()` to any finite
     * number, so the two cases ADR 0046 could not express become legal:
     *
     * - `0` — **freeze frame.** A single held source frame. The duration
     *   invariant does not apply (dividing by zero has no answer); the clip's
     *   timeline span is whatever it was set to, and the source range names the
     *   frame that is held.
     * - `< 0` — **reverse.** The source range is consumed backwards, which still
     *   takes positive timeline time, so the invariant uses the magnitude:
     *   `end - start === (sourceEnd - sourceStart) / |speed|`.
     *
     * Overridden entirely by {@link SpeedPointSchema | speedRamp} when that is
     * present and non-empty.
     */
    speed: z.number().finite().optional(),
    /**
     * A **speed curve** (schema v15, ADR 0090): playback rate as a function of
     * source time, overriding the constant {@link speed} when present and
     * non-empty. Absent or empty ⇒ constant speed, which is exactly a v14
     * project's behaviour, so the migration is a pure passthrough.
     *
     * The timeline duration is the *integral* of the reciprocal rate over the
     * clip's source span — see `editor-core/src/speed-curve.ts` and its Python
     * mirror, which are the only two places that arithmetic exists.
     */
    speedRamp: z.array(SpeedPointSchema).optional(),
    /**
     * Crop rect (schema v7), as fractions of the source frame. Optional; absent
     * = uncropped (today's behavior — the full source frame is used). See
     * {@link CropRectSchema} and `docs/adr/0047-clip-crop-schema-v7.md`.
     */
    crop: CropRectSchema.optional(),
    /**
     * Compositing blend mode (schema v8). Optional; absent (or `'normal'`) is
     * today's default compositing behavior — no change. Meaningful only when
     * there is content beneath this clip to blend against (i.e. a clip on a
     * non-base track, such as `overlay`), the same conceptual scope as
     * `AddMaskOp`/`TrackObjectOp`'s effects — but, like `crop`/`speed` before
     * it, not restricted at the schema level since the field lives on `Clip`
     * generically. See {@link BlendModeSchema} and
     * `docs/adr/0048-clip-blend-mode-schema-v8.md`.
     */
    blendMode: BlendModeSchema.optional(),
  })
  .refine((clip) => clip.end > clip.start, {
    message: 'Clip end must be greater than start (no negative/zero duration).',
    path: ['end'],
  })
  .refine((clip) => clip.sourceEnd > clip.sourceStart, {
    message: 'Clip sourceEnd must be greater than sourceStart.',
    path: ['sourceEnd'],
  });

// ---------------------------------------------------------------------------
// Track / Timeline (PRD §11.2)
// ---------------------------------------------------------------------------

export const TrackSchema = z.object({
  id: z.string(),
  type: TrackTypeSchema,
  clips: z.array(ClipSchema).default([]),
  /**
   * Track is locked: the editor refuses clip edits (move/trim/split/drop) on it.
   * Editing affordance only — has no effect on the render. Optional/absent ≡ false
   * so existing v3 tracks stay valid unchanged (schema v4).
   */
  locked: z.boolean().optional(),
  /**
   * Track is hidden: its picture/overlays are dropped from the preview AND the
   * render (a hidden video/overlay/caption track contributes nothing). Audio is
   * governed by {@link TrackSchema.muted}, not this. Optional/absent ≡ false (v4).
   */
  hidden: z.boolean().optional(),
  /**
   * Track is muted: its audio is silenced in the render. Visual tracks ignore it
   * (use {@link TrackSchema.hidden} to drop their picture). Optional/absent ≡ false (v4).
   */
  muted: z.boolean().optional(),
  /**
   * This track's role in the mix (schema v17): dialogue, music, or sfx.
   *
   * Meaningful on `audio` tracks; harmless elsewhere. Optional/absent ≡ unknown role, so every
   * pre-v17 project stays valid unchanged and nothing is retroactively labelled. Never infer this
   * from a track or file name — see {@link AudioRoleSchema}.
   */
  role: AudioRoleSchema.optional(),
  /**
   * The caption look for **every cue on this track** (schema v11, ADR 0071) —
   * "the project's caption style", which is how editors actually think about it
   * and how AutoCut/CapCut/Premiere all model it.
   *
   * WHY track-level: in v10 style lived only on the clip, so restyling a
   * finished caption set meant one `set_caption_style` per cue — a 400-operation
   * patch to change a colour, and no way to express "this project's captions look
   * like *this*". A per-cue {@link ClipSchema.captionStyle} is still honoured and
   * still wins, so hand-tuned single cues survive a track-wide restyle.
   *
   * Resolution order: clip override → track default → template catalog.
   * Meaningful on `caption` tracks; harmless elsewhere (nothing reads it), the
   * same permissive posture `captionStyle` already takes on `Clip`.
   */
  captionStyle: CaptionStyleSchema.optional(),
  /**
   * Time-ranged effect layers on an `effect` track (schema v13, ADR 0088).
   *
   * WHY a sibling of `clips` rather than a reuse of it: see
   * {@link EffectLayerSchema}.
   *
   * WHY `.optional()` and not `.default([])` — deliberate, and the opposite of
   * what `clips` does. A default makes the field REQUIRED on the parsed type,
   * which would force `effectLayers: []` into every `Track` literal in the
   * codebase (216 type errors across 29 files, nearly all unrelated test
   * fixtures) and would write `"effectLayers": []` into every track of every
   * saved file. Optional keeps a v12 project byte-identical through a
   * round-trip and matches the posture every other additive `Track` field
   * already takes (`captionStyle`, `locked`, `hidden`, `muted`).
   *
   * The cost of optional is that a reader can forget the empty case, so
   * **never read this field directly** — go through {@link effectLayersOf},
   * which is the sanctioned accessor every renderer and selector uses.
   */
  effectLayers: z.array(EffectLayerSchema).optional(),
});

export const TimelineSchema = z.object({
  tracks: z.array(TrackSchema).default([]),
  /**
   * Monotonic counter, bumped by every operation that changes sequence timing
   * (schema v12).
   *
   * WHY: derived work — captions above all — is only valid against the timing it
   * was computed from. A ripple delete, trim, move, reorder or speed change
   * silently invalidates every caption cue, and before v12 there was no way to
   * *detect* that: the cues still existed, still had plausible times, and every
   * consumer happily drew them at the wrong moment. Stamping the revision a cue
   * was derived from (see {@link CaptionCueSchema.derivedFromRevision}) turns
   * "these captions are stale" from an assumption into a comparison.
   *
   * Structural only: styling, muting, or renaming a track does not bump it, so
   * restyling captions does not mark them stale.
   *
   * Optional rather than defaulted, matching `locked`/`hidden`/`muted`: absent ≡
   * `0` ("never structurally edited"), which is the correct reading of every
   * pre-v12 project and keeps existing timeline literals valid. Read it through
   * `buildTimelineMap`, which normalises the absence away.
   */
  revision: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Asset / Transcript (lightweight for now; expand in Phase 1.1 / Phase 2.1)
// ---------------------------------------------------------------------------

/**
 * Read-only, engine-derived media for an asset (waveform peaks, thumbnails,
 * proxy). The Python engine produces these (`media/waveform.py`, `media/derive.py`)
 * and the desktop import path persists them so the timeline can draw real
 * waveforms/thumbnails instead of skeletons. The renderer only ever *reads* this —
 * media is never computed in the browser (render-vs-preview rule). All fields are
 * optional so an asset without derived media is still valid.
 */
/**
 * Read-only, engine-derived media. **All fields are nullable**, not just optional:
 * the Python engine derives them with Pydantic (`str | None`, `list[…] | None`) and
 * `model_dump(by_alias=True)` serializes an absent value as JSON **`null`**, not an
 * omitted key. So a live engine payload — and any project file already written by
 * the engine — carries `thumbnailPaths: null`, `media: null`, etc. `.nullable()`
 * makes "null == absent" an explicit part of the cross-language contract (it mirrors
 * the Pydantic `| None` exactly); readers already treat null/undefined alike via
 * optional chaining. A bare `.optional()` here would reject the engine's null and
 * fail the whole project parse.
 */
export const AssetMediaSchema = z.object({
  /** Project-relative path to a generated low-res proxy media file. */
  proxyPath: z.string().nullish(),
  /** Downsampled, normalized (0..1) waveform peaks for timeline rendering. */
  peaks: z.array(z.number()).nullish(),
  /** Waveform sampling rate (peak buckets per second) for time-accurate drawing. */
  peaksPerSecond: z.number().positive().nullish(),
  /** Project-relative paths to generated thumbnail images, time-ordered. */
  thumbnailPaths: z.array(z.string()).nullish(),
});

/**
 * Where an asset came from, and what using it obliges (schema v20).
 *
 * Only assets fetched from a third-party provider carry this — a file the user
 * dragged in has no provenance to record, and never will, so the field is
 * **optional** rather than defaulted (same shape decision as `capabilityPacks`
 * in v19).
 *
 * This exists because a licence badge shown at search time cannot discharge an
 * obligation that lands at publish time. Weeks after choosing a track the user
 * needs to know *which* of four beds needed crediting, *to whom*, and under
 * *which* licence. If the only record of that were a chip in a panel they
 * closed, the product would have walked them into a licence violation quietly.
 * So the credit is persisted with the project and read back by the Credits view
 * (`plan/3rd-party-sourcing/README.md` §D2, ADR 0138).
 *
 * Nullable, not merely optional, for the same cross-language reason as
 * {@link AssetMediaSchema}: the Python engine round-trips projects through
 * Pydantic and serializes an absent value as JSON `null`.
 */
export const AssetSourceSchema = z.object({
  /** Provider roster name, e.g. `'openverse'`. */
  provider: z.string().min(1),
  /** Provider-local id. Download dedupe, and "find this again" later. */
  remoteId: z.string().min(1),
  /** Licence identifier verbatim from the provider, e.g. `'cc-by'` / `'cc0'`. */
  license: z.string().min(1),
  /** Canonical licence text URL, so the user can read the actual terms. */
  licenseUrl: z.string().nullish(),
  /**
   * TRUE when the licence obliges the end user to credit someone. Stored rather
   * than derived from {@link AssetSourceSchema.license}: licence vocabularies
   * differ per provider and change over time, and a project written today must
   * still know what it agreed to then.
   */
  attributionRequired: z.boolean(),
  /**
   * The ready-to-paste credit line. Openverse supplies this directly; other
   * providers' adapters assemble it. This is the field that makes the
   * obligation survivable — everything else is metadata about it.
   */
  attribution: z.string().nullish(),
  creator: z.string().nullish(),
  creatorUrl: z.string().nullish(),
  /** Landing page for the item on the provider. */
  sourceUrl: z.string().nullish(),
  /** ISO-8601. What the terms were understood to be, and when. */
  fetchedAt: z.string(),
});

export const AssetSchema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.enum(['video', 'audio', 'image']).default('video'),
  durationSeconds: z.number().nonnegative().optional(),
  /** Engine-derived, read-only media handles (peaks/thumbnails/proxy). Nullable:
   *  the engine serializes an asset with no derived media as `media: null`. */
  media: AssetMediaSchema.nullish(),
  /**
   * Media-bin folder this asset belongs to, or omitted/undefined for the bin
   * root. References a {@link FolderSchema} id (PRD §11.1, schema v3). Foldering
   * is organizational only — it never affects the timeline or render.
   */
  folderId: z.string().optional(),
  /**
   * Provenance for a provider-sourced asset: licence, credit line, and where it
   * came from (schema v20). Absent for every user-imported file — that is the
   * correct reading, not missing data.
   */
  source: AssetSourceSchema.nullish(),
});

// ---------------------------------------------------------------------------
// Folder (media-bin organization, schema v3)
// ---------------------------------------------------------------------------

/**
 * A media-bin folder. Folders form a tree via {@link FolderSchema.parentId}
 * (`null` = root level), Finder/Explorer-style. They group {@link AssetSchema}s
 * for browsing only and have no effect on the timeline or render — moving an
 * asset between folders does not touch its clips. Cycle-freedom is enforced by
 * the editor-core patch validator, not the shape, so the schema stays declarative.
 */
export const FolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Parent folder id, or `null` for a top-level (root) folder. */
  parentId: z.string().nullable().default(null),
});

/**
 * `TranscriptWordSchema` is declared up in the "Primitives" section (it is a leaf
 * shape that {@link CaptionCueSchema} — and therefore {@link ClipSchema} — must be
 * able to reference), and re-exported here only so this file still reads in its
 * original order.
 */

// ---------------------------------------------------------------------------
// Marker / chapter (schema v9, H1.2 markers/chapters slice)
// ---------------------------------------------------------------------------

/**
 * A single point-in-time marker on the project timeline (PRD §11.1, plan
 * `FRAMEPILOT-AI-PRODUCT-PLAN.md` C21 "markers/chapters"). Lives at
 * {@link Project.markers} — project-scoped, not per-track — because a marker is
 * a global timeline position (a scrub-bar landmark / potential chapter point),
 * the same scope {@link Project.transcript} already occupies, not an
 * attribute of any one clip or track.
 *
 * One shape covers both "marker" and "chapter": an unlabeled marker is just a
 * `{ id, time }` (what pressing "M" at the playhead produces today, minus
 * persistence); a chapter is the same shape with a `label` (and optionally a
 * `color` for the scrub-bar UI) filled in later. See
 * `docs/adr/0049-markers-chapters-schema-v9.md` for why one array beats two
 * parallel concepts.
 */
export const MarkerSchema = z.object({
  id: z.string(),
  /** Position on the project timeline, in seconds. */
  time: z.number().nonnegative(),
  /** Optional title, promoting a bare marker to a named "chapter" point. */
  label: z.string().min(1).optional(),
  /** Optional display color (any CSS color string) for the scrub-bar UI. */
  color: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Camera angles / multicam (schema v18)
// ---------------------------------------------------------------------------

/**
 * One camera in a synced multicam group (schema v18).
 *
 * `syncOffsetSeconds` is the timestamp **in this angle's own media** that lines up
 * with group time zero, so the two directions are:
 *
 * ```text
 * groupTime  = sourceTime - angle.syncOffsetSeconds
 * sourceTime = groupTime  + angle.syncOffsetSeconds
 * ```
 *
 * That is the whole point of a group: switching cameras at a sequence position must
 * show the same *instant* from a different lens, and only a per-angle offset can
 * convert between two recordings that started rolling at different times.
 *
 * WHY the offset is optional rather than defaulting to `0`: a default of zero is not
 * a neutral value, it is the claim "every camera started together" — which silently
 * cuts to the wrong moment and looks like a real edit. Absent means unsynced, and an
 * unsynced angle is refused with the missing offset named as the fix. Offsets are
 * authored by the editor or by an explicit instruction and are never derived from
 * waveforms, timecode, or file times (ADR 0112, same rule as {@link AudioRoleSchema}).
 */
export const AngleSchema = z.object({
  id: z.string(),
  /** Optional display name for the angle ("Wide", "Cam B"). */
  name: z.string().min(1).optional(),
  /** The {@link AssetSchema} this camera recorded. */
  assetId: z.string(),
  /**
   * Source timestamp in this angle's media corresponding to group time zero.
   * Absent = not yet synced; may be negative when group zero precedes the media.
   */
  syncOffsetSeconds: z.number().finite().optional(),
});

/**
 * A set of cameras that recorded the same moment (schema v18).
 *
 * Lives at {@link Project.angleGroups} — project-scoped like {@link MarkerSchema},
 * because a group describes the *footage*, not any one clip or track, and must
 * outlive every timeline arrangement built from it.
 *
 * Membership is **derived, not stored**: a clip is showing angle A when its
 * `assetId` is A's `assetId`. That deliberately avoids a per-clip angle field,
 * which would be a second copy of the same fact and could drift out of agreement
 * with the media the clip actually points at. The cost is that one asset must not
 * appear in two groups; a clip whose asset is ambiguous is refused rather than
 * resolved by picking a group.
 */
export const AngleGroupSchema = z
  .object({
    id: z.string(),
    /** Optional display name for the group ("Interview", "Two-camera A/B"). */
    name: z.string().min(1).optional(),
    /** The cameras in this group. Two is the minimum that can be switched between. */
    angles: z.array(AngleSchema).min(2),
  })
  .refine((group) => new Set(group.angles.map((a) => a.id)).size === group.angles.length, {
    message: 'angle ids must be unique within a group',
    path: ['angles'],
  })
  .refine(
    (group) => new Set(group.angles.map((a) => a.assetId)).size === group.angles.length,
    // Two angles on one asset would make "which angle is this clip?" unanswerable
    // from the clip's media alone, which is exactly what derived membership relies on.
    { message: 'each angle must reference a distinct asset', path: ['angles'] },
  );

// ---------------------------------------------------------------------------
// Project (PRD §11.1)
// ---------------------------------------------------------------------------

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  fps: z.number().positive(),
  resolution: ResolutionSchema,
  assets: z.array(AssetSchema).default([]),
  /** Media-bin folder tree (schema v3). Organizational only; see {@link FolderSchema}. */
  folders: z.array(FolderSchema).default([]),
  timeline: TimelineSchema,
  transcript: z.array(TranscriptWordSchema).default([]),
  /**
   * Project-level markers/chapters (schema v9). Optional/absent-defaults-to-
   * empty-array so v8 projects migrate cleanly. See {@link MarkerSchema} and
   * `docs/adr/0049-markers-chapters-schema-v9.md`.
   */
  markers: z.array(MarkerSchema).default([]),
  /**
   * Synced camera groups for multicam switching (schema v18). Optional/absent-
   * defaults-to-empty-array so v17 projects load unchanged. See
   * {@link AngleGroupSchema} and `docs/adr/0112-camera-angle-groups-schema-v18.md`.
   */
  angleGroups: z.array(AngleGroupSchema).default([]),
  /**
   * Exact logical Capability Pack releases used by the project (schema v19).
   *
   * Optional rather than defaulted so adding the field does not force every in-memory
   * Project literal to materialize an empty array. Once a pack is used the host writes
   * the pin through the ordinary validated project-patch authority.
   */
  capabilityPacks: z
    .array(CapabilityPackPinSchema)
    .max(128)
    .refine(
      (pins) => new Set(pins.map((pin) => pin.id)).size === pins.length,
      'capability pack ids must be unique within a project',
    )
    .optional(),
  /** Free-form project memory (PRD §8.7). Typed in Phase 4.1. */
  aiMemory: z.record(z.string(), z.unknown()).default({}),
  /** Applied patch history (PRD §8.4). Typed against editor-core in Phase 1.3. */
  history: z.array(z.unknown()).default([]),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Resolution = z.infer<typeof ResolutionSchema>;
export type TrackType = z.infer<typeof TrackTypeSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
export type SpeedPoint = z.infer<typeof SpeedPointSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type EffectRenderKind = z.infer<typeof EffectRenderKindSchema>;
export type EffectLayer = z.infer<typeof EffectLayerSchema>;
export type CaptionPosition = z.infer<typeof CaptionPositionSchema>;
export type CaptionDisplayMode = z.infer<typeof CaptionDisplayModeSchema>;
export type CaptionEmphasis = z.infer<typeof CaptionEmphasisSchema>;
export type CaptionEntrance = z.infer<typeof CaptionEntranceSchema>;
export type CaptionHighlight = z.infer<typeof CaptionHighlightSchema>;
export type CaptionBackground = z.infer<typeof CaptionBackgroundSchema>;
export type CaptionShadow = z.infer<typeof CaptionShadowSchema>;
export type CaptionAnimation = z.infer<typeof CaptionAnimationSchema>;
export type CaptionAccent = z.infer<typeof CaptionAccentSchema>;
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;
export type CaptionCue = z.infer<typeof CaptionCueSchema>;
export type CropRect = z.infer<typeof CropRectSchema>;
export type BlendMode = z.infer<typeof BlendModeSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type AssetMedia = z.infer<typeof AssetMediaSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Folder = z.infer<typeof FolderSchema>;
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Angle = z.infer<typeof AngleSchema>;
export type AngleGroup = z.infer<typeof AngleGroupSchema>;
export type CapabilityPackPin = z.infer<typeof CapabilityPackPinSchema>;
export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------------------
// Effect-layer accessors (schema v13, ADR 0088)
// ---------------------------------------------------------------------------

/** No-allocation empty result, so the hot render path never churns garbage. */
const NO_EFFECT_LAYERS: readonly EffectLayer[] = [];

/**
 * The sanctioned way to read {@link TrackSchema.effectLayers}.
 *
 * The field is optional (see its doc comment for why), so every consumer would
 * otherwise need `?? []` — and one forgotten fallback silently drops a user's
 * effects from a render. Funnelling all reads through here makes that
 * impossible, and gives the render/preview paths a stable empty array.
 */
export function effectLayersOf(track: Track): readonly EffectLayer[] {
  return track.effectLayers ?? NO_EFFECT_LAYERS;
}

/** Whether this track is an adjustment lane (carries effects, never clips). */
export function isEffectTrack(track: Track): boolean {
  return track.type === 'effect';
}

/**
 * Effect layers that are live at `time`, in the order they must be applied.
 *
 * Ordering is the whole contract for "multiple effects combine predictably":
 * tracks are composited bottom-up, so a layer on a lower track runs FIRST and a
 * layer above it receives that already-affected frame. Within one track, layers
 * run in `start` order. Both renderers must walk this exact sequence, which is
 * why the sequencing lives here rather than being re-derived in each of them.
 *
 * `disabled` layers are skipped, and the end bound is exclusive so two abutting
 * layers never both fire on the boundary frame.
 */
export function activeEffectLayersAt(
  timeline: Timeline,
  time: number,
): readonly { readonly track: Track; readonly layer: EffectLayer }[] {
  const out: { track: Track; layer: EffectLayer }[] = [];
  // Bottom-up: `tracks[0]` is the visual front, so the LAST track is composited
  // first and its effects apply before anything above it.
  for (let i = timeline.tracks.length - 1; i >= 0; i -= 1) {
    const track = timeline.tracks[i];
    if (track === undefined || track.hidden === true) continue;
    const layers = effectLayersOf(track)
      .filter((l) => l.disabled !== true && time >= l.start && time < l.end)
      .sort((a, b) => a.start - b.start);
    for (const layer of layers) out.push({ track, layer });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate an unknown value as a {@link Project}.
 *
 * @param input - Untrusted value (e.g. parsed `project.fp.json`).
 * @returns A fully-typed, validated `Project`.
 * @throws ZodError when the input does not match the schema.
 */
export const parseProject = (input: unknown): Project => ProjectSchema.parse(input);

/**
 * Safe variant of {@link parseProject} that never throws.
 *
 * @param input - Untrusted value.
 * @returns Zod `SafeParseReturnType` with `.success` discriminant.
 */
export const safeParseProject = (input: unknown) => ProjectSchema.safeParse(input);

// ---------------------------------------------------------------------------
// JSON Schema export — the cross-language contract (Phase 1.1)
// ---------------------------------------------------------------------------

/**
 * Build the canonical JSON Schema for a {@link Project} from the Zod source of
 * truth.
 *
 * This is the **shared contract** the Python Pydantic models mirror: the
 * committed `schema/project.schema.json` is generated from this function, a TS
 * test guards against drift (generated must equal committed), and a Python test
 * asserts the Pydantic field set matches the schema. Changing the Zod schema
 * without regenerating the file — or without mirroring it in Pydantic — fails CI.
 *
 * `.refine()` constraints (e.g. "end > start") are intentionally not expressible
 * in JSON Schema and are dropped here; those invariants are enforced by the
 * patch validator (PRD §8.5), not the data-shape contract.
 *
 * @returns A draft-2020-12 JSON Schema object for the project document.
 */
export const buildProjectJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(ProjectSchema) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Re-exports — pure (browser-safe) helpers. Node-only file IO is at `./file`.
// ---------------------------------------------------------------------------

export * from './migrations.js';
export * from './serialization.js';
