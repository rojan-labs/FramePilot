"""Timeline data model (PRD §11).

WHY real (not stubbed): these are pure data shapes that mirror the TS
``timeline-schema``. Making them concrete pydantic models lets the rest of the
engine — operations, render, validation — be typed against a real structure and
lets tests round-trip ``project.fp.json`` today. The *IO* (atomic read/write) is
deferred to Phase 1 (plan 1.1) and raises ``NotImplementedError``.

Schema versioning: ``Project.version`` is bumped only alongside a migration
(plan 1.1) — never break the format without one.
"""

from __future__ import annotations

import json
import os
import tempfile
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

# Mirrors the TS ``SCHEMA_VERSION`` (packages/timeline-schema). It is the
# *envelope* version written at the top of ``project.fp.json`` as
# ``schemaVersion`` — distinct from ``Project.version`` (the user-facing project
# revision). The Python engine reads the current format and does NOT migrate
# older files; migrations live on the TS side, run when the editor opens a file.
#
# MUST equal the TS ``SCHEMA_VERSION`` (packages/timeline-schema/src/index.ts).
# v4 added the Track ``locked``/``hidden``/``muted`` flags; v5 added
# ``Clip.captionStyle``; v6 added ``Clip.speed``; v7 added ``Clip.crop``; v8
# added ``Clip.blendMode`` (already modelled below); v9 added project
# ``markers``; v10 rewrote ``Clip.captionStyle`` around the caption template
# catalog (``templateId`` + display/emphasis/entrance/accent vocabulary,
# ADR 0069); v12 made the transcript explicitly source-relative and added
# ``Timeline.revision``; v13 added the ``effect`` track type and
# ``Track.effectLayers`` (ADR 0088); v14 added optional bezier ``handles`` on
# ``Keyframe``, where ABSENT keeps the hardcoded smoothstep so v13 projects render
# byte-identically (ADR 0089); v17 added the optional ``Track.role`` mix role
# (dialogue/music/sfx), which is never back-filled because guessing a role from a
# track name silently mixes the wrong thing; v18 added project ``angleGroups``
# (synced multicam cameras), which are likewise never inferred from folders or
# file names; v19 added optional project ``capabilityPacks`` with immutable logical
# release pins for on-demand runtimes/models; v20 added optional ``Asset.source``
# (provider provenance: licence, credit line, creator) — the engine never *uses*
# it, because provenance cannot affect a render, but it must round-trip it rather
# than silently strip the one record of a crediting obligation (ADR 0138); the
# engine rejects any file whose envelope version exceeds this.
SCHEMA_VERSION = 21


class ProjectFileError(Exception):
    """Raised when a ``project.fp.json`` cannot be read or is an unsupported version."""


class TrackType(StrEnum):
    """Kinds of timeline tracks (PRD §11.2).

    ``EFFECT`` (schema v13, ADR 0088) is an adjustment lane: it carries no clips
    and no asset, only time-ranged :class:`EffectLayer` entries that restyle
    whatever picture is composited *beneath* the lane.
    """

    VIDEO = "video"
    AUDIO = "audio"
    CAPTION = "caption"
    OVERLAY = "overlay"
    EFFECT = "effect"


class AudioRole(StrEnum):
    """What a sound track *is* in the mix (schema v17).

    Roles are the difference between "lower track a3" and "duck the music under the dialogue".
    They must be authored, never inferred from a track or file name: a track called "music" can
    hold a voice-over, and acting on that guess silently mixes the wrong thing. Absent ⇒ unknown.
    """

    DIALOGUE = "dialogue"
    MUSIC = "music"
    SFX = "sfx"


class TranscriptWord(BaseModel):
    """A word-level transcript entry with timestamps (PRD §6.2).

    The field is named ``word`` to mirror the TS ``TranscriptWordSchema`` — the
    single source of truth for the cross-language contract.

    Declared here, ahead of the caption models, because :class:`CaptionCue`
    embeds a list of these and a cue lives on :class:`Clip` (schema v11) — the
    same reordering the TS schema needed for the same reason.
    """

    word: str
    start: float
    end: float
    asset_id: str | None = Field(
        default=None,
        alias="assetId",
        description=(
            "The asset these timestamps belong to (schema v12). Through v11 the "
            "project transcript was one flat, unattributed list, which is only "
            "unambiguous for a single-asset project. Absent means 'whichever asset "
            "is being mapped' — the v11 behavior — so existing files stay valid."
        ),
    )
    confidence: float | None = Field(
        default=None, description="ASR confidence in [0,1], when reported (schema v12)."
    )
    speaker: str | None = Field(
        default=None, description="Diarized speaker label, when reported (schema v12)."
    )

    model_config = {"populate_by_name": True}


class CaptionCueSource(BaseModel):
    """Where a cue's words came from in the source (schema v12, ADR 0076).

    Sequence time is what renders; source time is what survives an edit. Holding
    both means a cue can be *remapped* after a later trim or reorder instead of
    regenerated, and means verification can prove a caption references retained
    footage rather than deleted footage.
    """

    asset_id: str = Field(alias="assetId")
    clip_id: str = Field(alias="clipId")
    start: float
    end: float

    model_config = {"populate_by_name": True}


class BezierHandles(BaseModel):
    """A keyframe's outgoing/incoming bezier control points (schema v14, ADR 0089).

    Mirrors the TS ``KeyframeSchema.handles``. A segment ``a -> b`` is shaped by
    ``a.handles.out`` and ``b.handles.in`` — the same two-sided convention CSS
    ``cubic-bezier()`` uses, which is why a handle lives on the keyframe rather
    than on the segment.

    ``x`` is clamped to ``[0, 1]`` (an x outside it makes the curve non-monotonic in
    time, so the property would travel backwards mid-segment); ``y`` is deliberately
    unbounded, because overshoot and anticipation are the point of a custom curve.
    """

    model_config = {"populate_by_name": True}

    out: tuple[float, float]
    #: ``in`` is a Python keyword, so the field is named ``in_`` and aliased.
    in_: tuple[float, float] = Field(alias="in")


class SpeedPoint(BaseModel):
    """One control point on a clip's speed curve (schema v15, ADR 0090).

    Mirrors the TS ``SpeedPointSchema``. ``source_time`` is clip-relative **source**
    seconds, not timeline seconds — the single most important thing about this
    shape. A ramp exists precisely because timeline time is the *integral* of the
    rate over source time; anchoring a point in timeline time would make every point
    move whenever an earlier one changed.

    ``rate`` is strictly positive. Zero (freeze) and negative (reverse) live on the
    constant ``Clip.speed`` instead: the source-time-anchored model depends on
    source time advancing monotonically, and a rate reaching or crossing zero makes
    the mapping non-invertible in exactly the way this anchoring avoids.
    """

    model_config = {"populate_by_name": True}

    id: str = Field(description="Stable identifier, unique within its clip.")
    source_time: float = Field(
        alias="sourceTime",
        description="Clip-relative SOURCE seconds (0 = the clip's sourceStart).",
    )
    rate: float = Field(description="Playback rate at this point; strictly positive.")
    easing: str = Field(default="linear", description="Curve from this point into the next.")


class Keyframe(BaseModel):
    """A single animated value at a point in time (PRD §6.3, §11.4).

    ``easing`` names an easing curve from
    :class:`framepilot_engine.effects.keyframes.Easing`; it is stored as a string
    here to keep the data model dependency-free. Mirrors the TS ``KeyframeSchema``
    (see ``packages/timeline-schema``): the cross-language contract requires an
    ``id`` on every keyframe.
    """

    id: str = Field(description="Stable identifier, unique within its clip/effect.")
    time: float = Field(description="Time of the keyframe in seconds (clip-relative).")
    property: str = Field(description="Animated property, e.g. 'scale' or 'opacity'.")
    value: float = Field(description="Property value at this keyframe.")
    easing: str = Field(default="linear", description="Easing curve name into the next keyframe.")
    handles: BezierHandles | None = Field(
        default=None,
        description=(
            "Custom bezier control points (schema v14, ADR 0089). Only meaningful "
            "when easing == 'bezier'. ABSENT means the hardcoded smoothstep, so v13 "
            "projects evaluate identically."
        ),
    )


class Effect(BaseModel):
    """An effect applied to a clip (PRD §11.4)."""

    id: str
    type: str = Field(description="Effect type, e.g. 'transform' or 'color_grade'.")
    params: dict[str, Any] = Field(default_factory=dict)
    keyframes: list[Keyframe] = Field(default_factory=list)


class EffectLayer(BaseModel):
    """One time-ranged effect instance on an ``effect`` track (schema v13, ADR 0088).

    Mirrors the TS ``EffectLayerSchema``. NOT a :class:`Clip`: an effect layer has
    no asset, no source in/out, no speed and no crop — for ``[start, end)`` its
    ``kind`` is applied to the frame composited from every visible track beneath
    its own.

    ``kind`` is the renderers' ONLY dispatch key; ``effect_id`` names the catalog
    entry the layer came from and exists for presentation/attribution only. The
    compiler must never branch on it — that is the contract that keeps
    ``render/effect_catalog.json`` pure data (the same rule caption templates
    follow, ADR 0069).
    """

    id: str
    effect_id: str = Field(
        alias="effectId",
        description="Catalog entry id. Presentation only — never dispatch on it.",
    )
    kind: str = Field(
        description=(
            "Frame transform to run, from the closed ``EffectRenderKind`` "
            "vocabulary. Validated against the shipped catalog, not this field."
        )
    )
    start: float = Field(description="Timeline-relative start, seconds.")
    end: float = Field(description="Timeline-relative end, seconds.")
    params: dict[str, float] = Field(default_factory=dict)
    intensity: float | None = Field(
        default=None,
        description=(
            "Master strength in [0,1] — a linear mix between the untouched frame "
            "and the fully-affected frame. Absent means 1 (full strength)."
        ),
    )
    disabled: bool | None = Field(
        default=None,
        description="Bypassed: kept in the file but skipped by preview and render alike.",
    )
    keyframes: list[Keyframe] = Field(default_factory=list)

    model_config = {"populate_by_name": True}

    @property
    def is_active(self) -> bool:
        """Whether this layer contributes to the render at all."""
        return self.disabled is not True and self.end > self.start

    def covers(self, time: float) -> bool:
        """Whether ``time`` falls in this layer's range.

        End-exclusive, matching the TS ``activeEffectLayersAt``: two abutting
        layers must never both fire on the boundary frame.
        """
        return self.start <= time < self.end

    @property
    def strength(self) -> float:
        """Resolved master strength, with the absent-means-full-strength default."""
        return 1.0 if self.intensity is None else self.intensity


class CaptionHighlight(BaseModel):
    """Per-word emphasis config for a styled caption clip (schema v10).

    Mirrors the TS ``CaptionStyleSchema.highlight`` nested object. All fields
    optional: an absent ``enabled`` means "no per-word highlight" (baseline
    rendering), matching the TS ``.optional()`` semantics.
    """

    enabled: bool | None = Field(default=None)
    color: str | None = Field(default=None)
    animation: str | None = Field(
        default=None,
        description=(
            "Emphasis enum: 'none' | 'color' | 'pop' | 'karaoke-fill' | "
            "'background' | 'glow' | 'underline' | 'pulse'."
        ),
    )
    background: str | None = Field(default=None, description="Chip color behind the active word.")
    scale: float | None = Field(default=None, description="Scale factor for pop/pulse emphasis.")

    model_config = {"populate_by_name": True}


class CaptionBackground(BaseModel):
    """Background chip behind the whole caption line (schema v10).

    Mirrors the TS ``CaptionBackgroundSchema``; radius/padding are fractions of
    the resolved font size. A fully transparent color means "no chip".
    """

    color: str
    radius: float | None = Field(default=None)
    padding_x: float | None = Field(default=None, alias="paddingX")
    padding_y: float | None = Field(default=None, alias="paddingY")

    model_config = {"populate_by_name": True}


class CaptionShadow(BaseModel):
    """Drop shadow / glow behind caption text (schema v10).

    Mirrors the TS ``CaptionShadowSchema``; ``blur`` is a fraction of font
    size; zero offsets with non-zero blur reads as a glow.
    """

    color: str
    blur: float
    offset_x: float = Field(alias="offsetX")
    offset_y: float = Field(alias="offsetY")

    model_config = {"populate_by_name": True}


class CaptionAnimationPhase(BaseModel):
    """One entrance/exit/loop phase of a caption animation (schema v10).

    ``type`` holds the entrance enum for ``in``, ``'none' | 'fade'`` for
    ``out`` and ``'pulse' | 'wave'`` for ``loop``; ``duration`` doubles as the
    loop period, in seconds — mirroring the TS ``CaptionAnimationSchema``
    nested objects (whose ``loop`` field is named ``period``; see
    ``model_config`` aliasing on :class:`CaptionAnimation`).
    """

    type: str
    duration: float | None = Field(default=None)
    period: float | None = Field(default=None)

    model_config = {"populate_by_name": True}


class CaptionAnimation(BaseModel):
    """Entrance / exit / loop animation for a caption line (schema v10).

    Mirrors the TS ``CaptionAnimationSchema``. ``in`` is a Python keyword, so
    the field is ``in_`` with an alias.
    """

    in_: CaptionAnimationPhase | None = Field(default=None, alias="in")
    out: CaptionAnimationPhase | None = Field(default=None)
    loop: CaptionAnimationPhase | None = Field(default=None)
    per_word: bool | None = Field(default=None, alias="perWord")

    model_config = {"populate_by_name": True}


class CaptionAccent(BaseModel):
    """Deterministic accent-word styling for mixed-size looks (schema v10).

    Mirrors the TS ``CaptionAccentSchema``; selection (``mode``) must be
    deterministic so engine render and web preview pick the same word.
    """

    mode: str = Field(description="One of 'none' | 'last-word' | 'longest-word' | 'keywords'.")
    font_family: str | None = Field(default=None, alias="fontFamily")
    font_scale: float | None = Field(default=None, alias="fontScale")
    color: str | None = Field(default=None)
    font_style: str | None = Field(default=None, alias="fontStyle")
    keywords: list[str] | None = Field(
        default=None,
        description=(
            "Words that ``mode='keywords'`` accents, matched case- and "
            "punctuation-insensitively (schema v11). Before v11 there was no "
            "keyword source at all, so this renderer treated 'keywords' as a "
            "no-op; the editor's keyword chips never reached an export."
        ),
    )

    model_config = {"populate_by_name": True}


class CaptionStyle(BaseModel):
    """Rich, persisted caption style (schema v10, template-based).

    Mirrors the TS ``CaptionStyleSchema`` (``packages/timeline-schema``) 1:1 so
    a project styled via the editor renders identically at export time.
    ``template_id`` names a caption template catalog entry whose style fills
    every field left unset here; explicit fields always win (see
    :mod:`framepilot_engine.render.caption_templates`). All fields optional: a
    caption clip with no ``captionStyle`` at all keeps rendering via the
    pre-v5 baseline path (see :mod:`framepilot_engine.render.captions`).
    """

    template_id: str | None = Field(default=None, alias="templateId")
    display: str | None = Field(
        default=None,
        description="One of 'phrase' | 'active-word' | 'cumulative'.",
    )
    font_family: str | None = Field(default=None, alias="fontFamily")
    font_weight: int | None = Field(default=None, alias="fontWeight")
    font_style: str | None = Field(default=None, alias="fontStyle")
    text_transform: str | None = Field(default=None, alias="textTransform")
    letter_spacing: float | None = Field(default=None, alias="letterSpacing")
    font_scale: float | None = Field(default=None, alias="fontScale")
    text_color: str | None = Field(default=None, alias="textColor")
    outline_color: str | None = Field(default=None, alias="outlineColor")
    outline_width: float | None = Field(default=None, alias="outlineWidth")
    position: str | None = Field(default=None, description="One of 'top' | 'middle' | 'bottom'.")
    x_percent: float | None = Field(default=None, alias="xPercent")
    y_percent: float | None = Field(default=None, alias="yPercent")
    rotation: float | None = Field(default=None)
    max_width_percent: float | None = Field(default=None, alias="maxWidthPercent")
    text_align: str | None = Field(default=None, alias="textAlign")
    line_height: float | None = Field(default=None, alias="lineHeight")
    safe_area: bool | None = Field(default=None, alias="safeArea")
    background: CaptionBackground | None = Field(default=None)
    shadow: CaptionShadow | None = Field(default=None)
    highlight: CaptionHighlight | None = Field(default=None)
    animation: CaptionAnimation | None = Field(default=None)
    accent: CaptionAccent | None = Field(default=None)

    model_config = {"populate_by_name": True}


class CaptionCue(BaseModel):
    """A caption clip's own displayed text + word timings (schema v11, ADR 0071).

    Mirrors the TS ``CaptionCueSchema``. Before v11 a caption clip stored only a
    time range and every consumer re-derived its words from the project
    transcript — which made caption text uneditable and let this renderer and the
    editor disagree about which words a cue contained (overlap here vs. start
    containment in the caption list).

    ``text`` is authoritative for what is *drawn* and may legitimately differ
    from ``" ".join(w.word for w in words)`` (an edited line, an explicit ``\\n``,
    a redaction). ``words`` times the emphasis only, matched to ``text`` by
    position. ``None`` on a clip ⇒ derive from the project transcript by overlap,
    exactly as v10 did.
    """

    text: str = Field(description="Displayed text; '\\n' is an explicit line break.")
    words: list[TranscriptWord] = Field(
        default_factory=list,
        description=(
            "Per-word timings in absolute timeline seconds, for karaoke/build "
            "emphasis. Empty is valid: a hand-typed cue has no word timing and "
            "renders as a whole line for the clip's duration."
        ),
    )
    derived_from_revision: int | None = Field(
        default=None,
        alias="derivedFromRevision",
        description=(
            "The Timeline.revision this cue's timing was derived from (schema v12). "
            "When the timeline has moved past it the cue is STALE: it may still be "
            "correct, but nothing may assume so. Absent means provenance unknown, "
            "which is how every pre-v12 cue is treated — shown, never claimed "
            "verified."
        ),
    )
    source: CaptionCueSource | None = Field(
        default=None,
        description="The asset range and clip this cue's words came from (schema v12).",
    )

    model_config = {"populate_by_name": True}


class CropRect(BaseModel):
    """Axis-aligned crop rect, as fractions (0..1) of the clip's source frame (schema v7).

    Mirrors the TS ``CropRectSchema`` and the existing ``MaskBounds`` convention
    (:class:`framepilot_engine.timeline.operations.MaskBounds`) field-for-field —
    same names, same 0..1 frame-fraction range, same axis-aligned top-left-origin
    rect (see ``docs/adr/0047-clip-crop-schema-v7.md``). Defined here (not
    imported from ``operations``) to avoid a circular import: ``operations``
    already imports ``Clip`` from this module.

    Bounds (``x + width <= 1``, ``y + height <= 1``, positive width/height) are
    enforced by the TS Zod ``CropRectSchema.refine()`` that authors patches, not
    re-validated here — the same trust-boundary convention already used for
    ``Clip.speed``'s positivity (see that field's docstring) and for
    ``MaskBounds`` (no bounds check at all): the engine trusts a project file
    that already passed patch validation.
    """

    model_config = {"populate_by_name": True}
    x: float = 0.0
    y: float = 0.0
    width: float = 1.0
    height: float = 1.0


class BlendMode(StrEnum):
    """Compositing blend mode a clip can be composited with (schema v8).

    Mirrors the TS ``BlendModeSchema`` (``packages/timeline-schema``) field for
    field. This is the subset of the CSS/Photoshop ``mix-blend-mode``
    vocabulary expressible as simple per-channel arithmetic on two aligned RGB
    frames (no HSL round-trip) — see
    ``docs/adr/0048-clip-blend-mode-schema-v8.md`` for the "why this subset"
    rationale and :mod:`framepilot_engine.render.blend` for the render-time
    formulas.
    """

    NORMAL = "normal"
    MULTIPLY = "multiply"
    SCREEN = "screen"
    OVERLAY = "overlay"
    DARKEN = "darken"
    LIGHTEN = "lighten"
    COLOR_DODGE = "color-dodge"
    COLOR_BURN = "color-burn"
    HARD_LIGHT = "hard-light"
    SOFT_LIGHT = "soft-light"
    DIFFERENCE = "difference"
    EXCLUSION = "exclusion"


class Clip(BaseModel):
    """A placed segment of an asset on a track (PRD §11.3).

    ``start``/``end`` are timeline positions; ``source_start``/``source_end`` are
    in/out points within the source asset. Serialized with camelCase aliases to
    match the cross-language schema (``sourceStart`` etc.).
    """

    id: str
    asset_id: str = Field(alias="assetId")
    track_id: str = Field(alias="trackId")
    start: float = Field(description="Timeline start (seconds).")
    end: float = Field(description="Timeline end (seconds).")
    source_start: float = Field(default=0.0, alias="sourceStart")
    source_end: float | None = Field(default=None, alias="sourceEnd")
    effects: list[Effect] = Field(default_factory=list)
    keyframes: list[Keyframe] = Field(default_factory=list)
    caption_style: CaptionStyle | None = Field(
        default=None,
        alias="captionStyle",
        description=(
            "Per-cue style OVERRIDE. Wins over the owning track's "
            "``captionStyle`` default (schema v11), which wins over the template "
            "catalog."
        ),
    )
    caption_cue: CaptionCue | None = Field(
        default=None,
        alias="captionCue",
        description=(
            "The caption's own text + word timings (schema v11). Absent ⇒ derive "
            "from the project transcript by overlap, the v10 behavior. See "
            "`docs/adr/0071-caption-cue-and-track-style-schema-v11.md`."
        ),
    )
    speed: float | None = Field(
        default=None,
        description=(
            "Constant playback rate (schema v6, widened in v15). Absent or `1` is "
            "today's behavior: timeline duration equals source duration. A `speed` "
            "!= 1 changes the timeline duration derived from the source window per "
            "the invariant `end - start == (sourceEnd - sourceStart) / |speed|`. "
            "Schema v15 (ADR 0090) widened this from strictly positive: `0` is a "
            "freeze frame (a held source frame, for which no duration is derivable "
            "and so none is wrong) and a negative value consumes the source range "
            "backwards. Overridden entirely by `speedRamp` when that is present."
        ),
    )
    speed_ramp: list[SpeedPoint] | None = Field(
        default=None,
        alias="speedRamp",
        description=(
            "A speed CURVE (schema v15, ADR 0090): playback rate as a function of "
            "SOURCE time, overriding the constant `speed` when present and non-empty. "
            "Absent or empty is exactly the constant-rate case, so a v14 project "
            "renders byte-identically. The timeline duration is the integral of the "
            "reciprocal rate over the clip's source span — see "
            "`framepilot_engine.effects.speed_curve`, which with its TypeScript "
            "mirror is the only place that arithmetic exists."
        ),
    )
    crop: CropRect | None = Field(
        default=None,
        description=(
            "Crop window into the source frame (schema v7), as fractions of the "
            "source frame. Absent means uncropped: the full source frame is used, "
            "today's behavior. See `docs/adr/0047-clip-crop-schema-v7.md`."
        ),
    )
    blend_mode: BlendMode | None = Field(
        default=None,
        alias="blendMode",
        description=(
            "Compositing blend mode against whatever is beneath this clip (schema "
            "v8). Absent or `'normal'` is today's behavior: plain alpha-over "
            "compositing. Meaningful only when there is content composited "
            "beneath this clip (e.g. an overlay-track clip above a base video "
            "track) — a clip with nothing beneath it renders unchanged, a "
            "documented no-op, not enforced by this model (see "
            "`docs/adr/0048-clip-blend-mode-schema-v8.md`)."
        ),
    )

    model_config = {"populate_by_name": True}


class Track(BaseModel):
    """An ordered lane of clips of a single type (PRD §11.2).

    ``locked``/``hidden``/``muted`` are track-level flags (schema v4). ``locked`` is
    an editor affordance only (no render effect). ``hidden`` drops a visual track's
    picture/overlays from the render; ``muted`` silences a track's audio.
    """

    id: str
    type: TrackType
    clips: list[Clip] = Field(default_factory=list)
    locked: bool = Field(default=False, description="Editor lock; no render effect.")
    hidden: bool = Field(default=False, description="Drop this track's picture from the render.")
    muted: bool = Field(default=False, description="Silence this track's audio in the render.")
    role: AudioRole | None = Field(
        default=None,
        description=(
            "This track's role in the mix (schema v17): dialogue, music, or sfx. Meaningful on "
            "audio tracks; harmless elsewhere. Absent ⇒ unknown role, which is what every "
            "pre-v17 project has. Never inferred from a track or file name."
        ),
    )
    caption_style: CaptionStyle | None = Field(
        default=None,
        alias="captionStyle",
        description=(
            "The caption look for every cue on this track (schema v11) — 'the "
            "project's caption style'. A clip's own ``captionStyle`` still wins, "
            "so hand-tuned cues survive a track-wide restyle. Absent ⇒ each cue "
            "resolves against the template catalog alone, the v10 behavior."
        ),
    )
    effect_layers: list[EffectLayer] = Field(
        default_factory=list,
        alias="effectLayers",
        description=(
            "Time-ranged effect layers on an ``effect`` track (schema v13). "
            "Meaningful on effect tracks; harmless elsewhere. The TS side models "
            "this as optional so a v12 file round-trips byte-identically; an "
            "empty list here is the same thing, and ``exclude_defaults`` on dump "
            "keeps the key out of serialized v12-shaped tracks."
        ),
    )

    model_config = {"populate_by_name": True}

    @property
    def is_effect_lane(self) -> bool:
        """Whether this track is an adjustment lane (carries effects, never clips)."""
        return self.type is TrackType.EFFECT

    def active_effect_layers_at(self, time: float) -> list[EffectLayer]:
        """This track's live layers at ``time``, in apply order (by ``start``).

        A hidden track contributes nothing — consistent with ``hidden`` dropping a
        visual track's picture from the render.
        """
        if self.hidden:
            return []
        return sorted(
            (layer for layer in self.effect_layers if layer.is_active and layer.covers(time)),
            key=lambda layer: layer.start,
        )


class Timeline(BaseModel):
    """The full multi-track timeline (PRD §11.2)."""

    tracks: list[Track] = Field(default_factory=list)
    revision: int | None = Field(
        default=None,
        description=(
            "Monotonic counter bumped by every operation that changes sequence "
            "timing (schema v12). Derived work — captions above all — is only valid "
            "against the timing it was computed from, and before v12 there was no "
            "way to DETECT that a ripple delete had invalidated it. Structural "
            "only: styling or muting does not bump it. Absent means 0."
        ),
    )

    def active_effect_layers_at(self, time: float) -> list[tuple[Track, EffectLayer]]:
        """Every live effect layer at ``time``, in the exact order to apply them.

        THE ordering contract (schema v13, ADR 0088), and it must stay identical
        to the TS ``activeEffectLayersAt`` — the two renderers walking different
        sequences is precisely how preview and render would drift apart on a
        stacked effect.

        ``tracks[0]`` is the visual FRONT, so iteration runs back-to-front: a
        layer on a lower track applies first, and a layer above it receives the
        already-affected frame. Within one track, layers apply in ``start`` order.
        """
        out: list[tuple[Track, EffectLayer]] = []
        for track in reversed(self.tracks):
            for layer in track.active_effect_layers_at(time):
                out.append((track, layer))
        return out


class Resolution(BaseModel):
    """Project output resolution in pixels (PRD §11.1)."""

    width: int = 1920
    height: int = 1080


class AssetMedia(BaseModel):
    """Read-only, engine-derived media handles for an asset (plan Phase 8).

    Mirrors the TS ``AssetMediaSchema``. Produced by the engine
    (``media/waveform.py``, ``media/derive.py``) and persisted so the timeline can
    draw real waveforms/thumbnails; the renderer only reads it (never computes media
    in the browser). All fields optional.
    """

    #: Source pixel dimensions, when the engine has probed them (schema v21).
    #:
    #: WHY: ``_place_video_clip`` FITS a clip into the frame — ``min(target_w/w,
    #: target_h/h)``, which is *contain* — so a landscape source in a portrait sequence
    #: renders with black bars unless the clip carries a crop. Nothing carried an asset's
    #: shape, so neither the agent nor ``checkReframeCoverage`` could tell which clips
    #: needed one. Absent means "not probed", never "square".
    width: int | None = Field(default=None)
    height: int | None = Field(default=None)
    proxy_path: str | None = Field(default=None, alias="proxyPath")
    peaks: list[float] | None = Field(default=None)
    peaks_per_second: float | None = Field(default=None, alias="peaksPerSecond")
    thumbnail_paths: list[str] | None = Field(default=None, alias="thumbnailPaths")

    model_config = {"populate_by_name": True}


class AssetSource(BaseModel):
    """Where a provider-sourced asset came from, and what crediting it obliges (v20).

    Mirrors the TS ``AssetSourceSchema``. The engine does not read a single field
    of this — provenance never affects a render. It is modelled here purely so a
    project round-tripped through the engine keeps it: a Pydantic model that
    dropped the field would silently erase the only durable record that a track
    needs crediting, which is the exact harm the field was added to prevent
    (ADR 0138, ``plan/3rd-party-sourcing`` §D2).

    Absent for every user-imported file — there is no provenance to record.
    """

    provider: str
    remote_id: str = Field(alias="remoteId")
    license: str
    license_url: str | None = Field(default=None, alias="licenseUrl")
    attribution_required: bool = Field(alias="attributionRequired")
    attribution: str | None = Field(default=None)
    creator: str | None = Field(default=None)
    creator_url: str | None = Field(default=None, alias="creatorUrl")
    source_url: str | None = Field(default=None, alias="sourceUrl")
    fetched_at: str = Field(alias="fetchedAt")

    model_config = {"populate_by_name": True}


class Asset(BaseModel):
    """A source media file referenced by the project (PRD §11.1).

    Mirrors the TS ``AssetSchema``; ``duration_seconds`` is serialized as
    ``durationSeconds`` to match the cross-language contract.
    """

    id: str
    path: str = Field(description="Declared path; resolved + sandboxed before any IO.")
    kind: str = Field(default="video", description="One of 'video' | 'audio' | 'image'.")
    duration_seconds: float | None = Field(default=None, alias="durationSeconds")
    media: AssetMedia | None = Field(default=None)
    folder_id: str | None = Field(default=None, alias="folderId")
    source: AssetSource | None = Field(default=None)

    model_config = {"populate_by_name": True}


class Folder(BaseModel):
    """A media-bin folder (schema v3).

    Mirrors the TS ``FolderSchema``. Folders form a tree via ``parent_id``
    (``None`` = root level) and group assets for browsing only — they never affect
    the timeline or render. Cycle-freedom is enforced by the editor-core patch
    validator, not the data shape.
    """

    id: str
    name: str
    parent_id: str | None = Field(default=None, alias="parentId")

    model_config = {"populate_by_name": True}


class Marker(BaseModel):
    """A single point-in-time marker on the project timeline (schema v9).

    Mirrors the TS ``MarkerSchema``. One shape covers both "marker" and
    "chapter": an unlabeled marker is just ``{id, time}``; a chapter is the
    same shape with ``label`` (and optionally ``color``) filled in.
    """

    id: str
    time: float
    label: str | None = Field(default=None)
    color: str | None = Field(default=None)

    model_config = {"populate_by_name": True}


class Angle(BaseModel):
    """One camera in a synced multicam group (schema v18).

    Mirrors the TS ``AngleSchema``. ``sync_offset_seconds`` is the timestamp in THIS
    angle's own media that lines up with group time zero::

        group_time  = source_time - sync_offset_seconds
        source_time = group_time  + sync_offset_seconds

    It is optional rather than defaulting to ``0.0`` because zero is not a neutral
    value — it is the claim "every camera started together", which silently cuts to
    the wrong moment. Absent ⇒ unsynced, and the switch is refused (ADR 0112).
    """

    id: str
    name: str | None = Field(default=None)
    asset_id: str = Field(alias="assetId")
    sync_offset_seconds: float | None = Field(default=None, alias="syncOffsetSeconds")

    model_config = {"populate_by_name": True}


class AngleGroup(BaseModel):
    """A set of cameras that recorded the same moment (schema v18).

    Mirrors the TS ``AngleGroupSchema``. Project-scoped like :class:`Marker`, because a
    group describes the footage rather than any one clip. Membership is DERIVED: a clip
    shows the angle whose ``asset_id`` it points at, so no per-clip angle field can drift
    away from the media actually being rendered. Uniqueness of angle ids/assets within a
    group is enforced by the TS schema; the switch compiler refuses an asset that resolves
    to more than one group instead of picking one.
    """

    id: str
    name: str | None = Field(default=None)
    angles: list[Angle] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class CapabilityPackPin(BaseModel):
    """One platform-neutral on-demand Capability Pack release pin (schema v19).

    ``release_digest`` identifies the signed cross-platform release record rather than a
    macOS/Windows artifact, so the same project remains portable between supported hosts.
    """

    id: str
    version: str
    release_digest: str = Field(alias="releaseDigest")
    capabilities: list[str]
    required_for: str = Field(alias="requiredFor")

    model_config = {"populate_by_name": True}


class Project(BaseModel):
    """Top-level project document persisted as ``project.fp.json`` (PRD §11.1)."""

    id: str
    name: str
    version: int = 1
    fps: int = 30
    resolution: Resolution = Field(default_factory=Resolution)
    assets: list[Asset] = Field(default_factory=list)
    folders: list[Folder] = Field(default_factory=list)
    timeline: Timeline = Field(default_factory=Timeline)
    transcript: list[TranscriptWord] = Field(default_factory=list)
    markers: list[Marker] = Field(default_factory=list)
    angle_groups: list[AngleGroup] = Field(default_factory=list, alias="angleGroups")
    capability_packs: list[CapabilityPackPin] | None = Field(default=None, alias="capabilityPacks")
    ai_memory: dict[str, Any] = Field(default_factory=dict, alias="aiMemory")
    history: list[dict[str, Any]] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class ProjectFile:
    """Reader/writer for the ``project.fp.json`` format (plan 1.1).

    Saves MUST be atomic (write to a temp file in the same directory, then
    ``os.replace``) so a crash mid-save never corrupts the project (PRD §18.3).
    All paths MUST be resolved through
    :func:`framepilot_engine.safety.resolve_within` before touching disk.
    """

    @staticmethod
    def load(path: Path) -> Project:
        """Load and validate a project file.

        The ``schemaVersion`` envelope is checked before validation: a file
        written by a *newer* engine is rejected (we cannot know its shape), and
        an *older* file is rejected with guidance to open it in the editor (which
        owns migrations) — the render engine never silently migrates. Callers
        should sandbox-resolve ``path`` (see
        :func:`framepilot_engine.safety.resolve_within`) before calling.

        :param path: Path to a ``project.fp.json`` file.
        :returns: The parsed :class:`Project` (envelope stripped).
        :raises ProjectFileError: If the file is missing, not JSON, or an
            unsupported schema version.
        """
        try:
            raw_text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ProjectFileError(f"Cannot read project file {path}: {exc}") from exc

        try:
            raw: dict[str, Any] = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            raise ProjectFileError(f"Project file {path} is not valid JSON: {exc}") from exc

        envelope_version = raw.get("schemaVersion", SCHEMA_VERSION)
        if envelope_version > SCHEMA_VERSION:
            raise ProjectFileError(
                f"Project {path} has schemaVersion {envelope_version}, but this engine "
                f"supports up to {SCHEMA_VERSION}. Upgrade FramePilot to open it."
            )
        if envelope_version < SCHEMA_VERSION:
            raise ProjectFileError(
                f"Project {path} has schemaVersion {envelope_version} (current is "
                f"{SCHEMA_VERSION}). Open it in the FramePilot editor once to migrate "
                "it; the render engine does not migrate files."
            )

        # ``schemaVersion`` is an envelope field, not part of Project; drop it
        # before validation (Project would otherwise ignore the extra key).
        payload = {k: v for k, v in raw.items() if k != "schemaVersion"}
        return Project.model_validate(payload)

    @staticmethod
    def save(project: Project, path: Path) -> None:
        """Atomically write a project to disk with the schema envelope.

        Writes to a temp file in the *same directory* (so ``os.replace`` is an
        atomic same-filesystem rename), fsyncs it, then replaces the target — a
        crash mid-save therefore never corrupts an existing project (PRD §18.3).
        The output mirrors the TS serializer: ``{"schemaVersion": N, ...project}``.

        :param project: The project to persist.
        :param path: Destination ``project.fp.json`` path.
        :raises ProjectFileError: If the destination cannot be written.
        """
        document = {"schemaVersion": SCHEMA_VERSION, **project.model_dump(by_alias=True)}
        serialized = json.dumps(document, indent=2)

        directory = path.parent
        try:
            directory.mkdir(parents=True, exist_ok=True)
            # Temp file in the target dir keeps the final os.replace on one fs.
            fd, tmp_name = tempfile.mkstemp(dir=directory, prefix=".fp-", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(serialized)
                    handle.flush()
                    os.fsync(handle.fileno())
                Path(tmp_name).replace(path)  # atomic same-filesystem rename
            except BaseException:
                # Never leave a partial temp file behind on failure.
                Path(tmp_name).unlink(missing_ok=True)
                raise
        except OSError as exc:
            raise ProjectFileError(f"Cannot write project file {path}: {exc}") from exc
