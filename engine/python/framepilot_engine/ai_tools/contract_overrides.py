"""Runtime contract hardening for the Python AI-tool mirror.

The persisted timeline models intentionally remain backward-compatible with old project
files. Agent input is a different trust boundary: it must be strict and match the TS
registry plus the renderer-backed semantic contract. This module installs strict input
models onto the already-built Python ``TOOL_REGISTRY`` without duplicating the registry.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from framepilot_engine.ai_tools.registry import (
    TOOL_REGISTRY,
    FilterStr,
    ToolSpec,
    caption_template_count,
)

_STRICT = ConfigDict(extra="forbid", populate_by_name=True)
_KEYFRAME_PROPERTIES = {"scale", "x", "y", "rotation", "opacity"}
_COLOR_RANGES: dict[str, tuple[float, float]] = {
    "exposure": (-5.0, 5.0),
    "contrast": (-1.0, 1.0),
    "saturation": (-1.0, 3.0),
    "temperature": (-1.0, 1.0),
    "tint": (-1.0, 1.0),
    "shadows": (-1.0, 1.0),
    "highlights": (-1.0, 1.0),
}


class _AddAssetArgs(BaseModel):
    model_config = _STRICT
    path: str
    # Defaults mirror the TS registry (`kind: z.enum([...]).default('video')`). A
    # documented default is not "healing invalid input" — omitting the argument is a
    # legal call on the TS side, so Python must accept it too or the same model call
    # succeeds in-app and 4xxs at the sidecar.
    kind: Literal["video", "audio", "image"] = "video"
    duration_seconds: float | None = Field(default=None, alias="durationSeconds", ge=0.0)
    folder_id: FilterStr = Field(default=None, alias="folderId")
    id: FilterStr = None


class _AddClipArgs(BaseModel):
    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    asset_id: str = Field(alias="assetId")
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)
    # TS: `sourceStart: seconds.default(0)` — omitting it starts at the asset head.
    source_start: float = Field(default=0.0, alias="sourceStart", ge=0.0)
    source_end: float | None = Field(default=None, alias="sourceEnd", ge=0.0)

    @model_validator(mode="after")
    def _ordered(self) -> _AddClipArgs:
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class _AddTrackArgs(BaseModel):
    model_config = _STRICT
    # TS: `type: z.enum([...]).default('overlay')` — the advisory role, not a content limit.
    type: Literal["video", "audio", "caption", "overlay"] = "overlay"
    at_index: int | None = Field(default=None, alias="atIndex", ge=0)
    id: FilterStr = None


class _WindowArgs(BaseModel):
    model_config = _STRICT
    start: float | None = Field(default=None, ge=0.0)
    end: float | None = Field(default=None, ge=0.0)

    @model_validator(mode="after")
    def _ordered(self) -> _WindowArgs:
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class _MapTimeArgs(BaseModel):
    model_config = _STRICT
    source_time: float | None = Field(default=None, alias="sourceTime", ge=0.0)
    asset_id: FilterStr = Field(default=None, alias="assetId")
    sequence_time: float | None = Field(default=None, alias="sequenceTime", ge=0.0)

    @model_validator(mode="after")
    def _one_domain(self) -> _MapTimeArgs:
        if self.source_time is not None and self.sequence_time is not None:
            raise ValueError("sourceTime and sequenceTime are mutually exclusive")
        if self.asset_id is not None and self.source_time is None:
            raise ValueError("assetId is only valid with sourceTime")
        return self


class _GetClipsArgs(_WindowArgs):
    track_id: FilterStr = Field(default=None, alias="trackId")
    offset: int | None = Field(default=None, ge=0)
    limit: int | None = Field(default=None, ge=1, le=200)


class _DiscoverEffectsArgs(BaseModel):
    model_config = _STRICT
    query: FilterStr = None
    category: FilterStr = None
    shelf: Literal["popular", "recommended"] | None = None
    limit: int | None = Field(default=None, gt=0, le=80)


class _DiscoverCaptionStylesArgs(BaseModel):
    model_config = _STRICT
    query: FilterStr = None
    category: (
        Literal[
            "one-word",
            "phrase",
            "karaoke",
            "build",
            "boxed",
            "editorial",
            "aesthetic",
            "cinematic",
        ]
        | None
    ) = None
    # Ceiling is the catalog's own size so one call can return the whole catalog; a lower
    # bound made the template ids past the cut unreachable, and set_track_caption_style
    # rejects an id the model was never shown.
    limit: int | None = Field(default=None, gt=0, le=caption_template_count())


class _ApplyEffectArgs(BaseModel):
    model_config = _STRICT
    effect_id: str = Field(alias="effectId")
    start_time: float = Field(alias="startTime", ge=0.0)
    end_time: float | None = Field(default=None, alias="endTime", gt=0.0)
    params: dict[str, float] | None = None
    intensity: float | None = Field(default=None, ge=0.0, le=1.0)
    track_id: FilterStr = Field(default=None, alias="trackId")

    @model_validator(mode="after")
    def _ordered(self) -> _ApplyEffectArgs:
        if self.end_time is not None and self.end_time <= self.start_time:
            raise ValueError("endTime must be greater than startTime")
        return self


class _MoveEffectArgs(BaseModel):
    model_config = _STRICT
    layer_id: str = Field(alias="layerId")
    to_start: float = Field(alias="toStart", ge=0.0)
    to_track_id: FilterStr = Field(default=None, alias="toTrackId")


class _ResizeEffectArgs(BaseModel):
    model_config = _STRICT
    layer_id: str = Field(alias="layerId")
    start: float = Field(ge=0.0)
    end: float = Field(gt=0.0)

    @model_validator(mode="after")
    def _ordered(self) -> _ResizeEffectArgs:
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class _AdjustEffectArgs(BaseModel):
    model_config = _STRICT
    layer_id: str = Field(alias="layerId")
    params: dict[str, float] | None = None
    intensity: float | None = Field(default=None, ge=0.0, le=1.0)


class _GetFrameArgs(BaseModel):
    model_config = _STRICT
    time_seconds: float = Field(alias="timeSeconds", ge=0.0)
    max_dimension: int | None = Field(default=None, alias="maxDimension", ge=128, le=1280)
    burn_captions: bool | None = Field(default=None, alias="burnCaptions")


class _KeyframeArg(BaseModel):
    model_config = _STRICT
    time: float = Field(ge=0.0)
    property: str
    value: float
    easing: Literal["linear", "ease-in", "ease-out", "ease-in-out", "hold", "bezier"] | None = None

    @model_validator(mode="after")
    def _renderer_contract(self) -> _KeyframeArg:
        if self.property not in _KEYFRAME_PROPERTIES:
            raise ValueError(f"unsupported keyframe property: {self.property}")
        if self.property == "scale" and self.value <= 0:
            raise ValueError("scale keyframes must be greater than zero")
        if self.property == "opacity" and not 0.0 <= self.value <= 1.0:
            raise ValueError("opacity keyframes must be within 0..1")
        return self


class _AddKeyframesArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    keyframes: list[_KeyframeArg] = Field(min_length=1)


class _PunchInArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    from_scale: float | None = Field(default=None, alias="fromScale", gt=0.0)
    to_scale: float | None = Field(default=None, alias="toScale", gt=0.0)
    easing: Literal["linear", "ease-in", "ease-out", "ease-in-out", "hold", "bezier"] | None = None
    start_time: float | None = Field(default=None, alias="startTime", ge=0.0)
    end_time: float | None = Field(default=None, alias="endTime", ge=0.0)

    @model_validator(mode="after")
    def _ordered(self) -> _PunchInArgs:
        if (
            self.start_time is not None
            and self.end_time is not None
            and self.end_time <= self.start_time
        ):
            raise ValueError("endTime must be greater than startTime")
        return self


class _ApplyColorGradeArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    type: Literal["color_grade", "lut", "transform"] | None = None
    params: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _renderer_contract(self) -> _ApplyColorGradeArgs:
        grade_type = self.type or "color_grade"
        params = self.params or {}
        if grade_type == "transform":
            raise ValueError("transform is not a color renderer operation; use color_grade or lut")
        if grade_type == "lut":
            path = params.get("path")
            if not isinstance(path, str) or not path.strip():
                raise ValueError("lut requires params.path")
            return self
        for name, value in params.items():
            contract = _COLOR_RANGES.get(name)
            if contract is None:
                raise ValueError(f"unknown color-grade parameter: {name}")
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"{name} must be numeric")
            low, high = contract
            if not low <= float(value) <= high:
                raise ValueError(f"{name} must be within {low}..{high}")
        return self


class _AdjustAudioArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    gain_db: float = Field(alias="gainDb")

    @field_validator("gain_db")
    @classmethod
    def _gain_range(cls, value: float) -> float:
        if not -120.0 <= value <= 24.0:
            raise ValueError("gainDb must be within -120..24 dB")
        return value


class _BoundsArg(BaseModel):
    model_config = _STRICT
    x: float = Field(ge=0.0)
    y: float = Field(ge=0.0)
    width: float = Field(ge=0.0)
    height: float = Field(ge=0.0)

    @model_validator(mode="after")
    def _inside_frame(self) -> _BoundsArg:
        if (
            self.x > 1
            or self.y > 1
            or self.width <= 0
            or self.width > 1
            or self.height <= 0
            or self.height > 1
        ):
            raise ValueError("region must use normalized 0..1 fractions with positive dimensions")
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("region must stay inside the normalized frame")
        return self


class _TrackObjectArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    target: Literal["face", "bounding_box", "object"]
    region: _BoundsArg | None = None
    engine: FilterStr = None


class _ManageAssetsArgs(BaseModel):
    model_config = _STRICT
    strategy: Literal["by-kind", "plan"] | None = None
    folders: list[dict[str, Any]] | None = None
    assignments: list[dict[str, Any]] | None = None

    @model_validator(mode="after")
    def _plan_has_content(self) -> _ManageAssetsArgs:
        if self.strategy == "plan" and not (self.folders or self.assignments):
            raise ValueError("strategy='plan' requires at least one folder or assignment")
        return self


class _StrictCropRect(BaseModel):
    model_config = _STRICT
    x: float = Field(ge=0.0)
    y: float = Field(ge=0.0)
    width: float = Field(gt=0.0)
    height: float = Field(gt=0.0)

    @model_validator(mode="after")
    def _contained(self) -> _StrictCropRect:
        if self.x + self.width > 1 + 1e-9 or self.y + self.height > 1 + 1e-9:
            raise ValueError("crop rect must stay inside the source frame")
        return self


class _CaptionHighlight(BaseModel):
    model_config = _STRICT
    enabled: bool | None = None
    color: str | None = Field(default=None, min_length=1)
    animation: (
        Literal[
            "none", "color", "pop", "karaoke-fill", "background", "glow", "underline", "pulse"
        ]
        | None
    ) = None
    background: str | None = Field(default=None, min_length=1)
    scale: float | None = Field(default=None, gt=0.0)


class _CaptionBackground(BaseModel):
    model_config = _STRICT
    color: str = Field(min_length=1)
    radius: float | None = Field(default=None, ge=0.0)
    padding_x: float | None = Field(default=None, alias="paddingX", ge=0.0)
    padding_y: float | None = Field(default=None, alias="paddingY", ge=0.0)


class _CaptionShadow(BaseModel):
    model_config = _STRICT
    color: str = Field(min_length=1)
    blur: float = Field(ge=0.0)
    offset_x: float = Field(alias="offsetX")
    offset_y: float = Field(alias="offsetY")


class _CaptionIn(BaseModel):
    model_config = _STRICT
    type: Literal["none", "fade", "slide-up", "zoom", "bounce", "typewriter"]
    duration: float = Field(gt=0.0)


class _CaptionOut(BaseModel):
    model_config = _STRICT
    type: Literal["none", "fade"]
    duration: float = Field(gt=0.0)


class _CaptionLoop(BaseModel):
    model_config = _STRICT
    type: Literal["pulse", "wave"]
    period: float = Field(gt=0.0)


class _CaptionAnimation(BaseModel):
    model_config = _STRICT
    in_: _CaptionIn | None = Field(default=None, alias="in")
    out: _CaptionOut | None = None
    loop: _CaptionLoop | None = None
    per_word: bool | None = Field(default=None, alias="perWord")


class _CaptionAccent(BaseModel):
    model_config = _STRICT
    mode: Literal["none", "last-word", "longest-word", "keywords"]
    font_family: str | None = Field(default=None, alias="fontFamily", min_length=1)
    font_scale: float | None = Field(default=None, alias="fontScale", gt=0.0)
    color: str | None = Field(default=None, min_length=1)
    font_style: Literal["normal", "italic"] | None = Field(default=None, alias="fontStyle")
    keywords: list[str] | None = None

    @field_validator("keywords")
    @classmethod
    def _non_blank_keywords(cls, values: list[str] | None) -> list[str] | None:
        if values is not None and any(not value for value in values):
            raise ValueError("accent keywords must be non-empty strings")
        return values


class _CaptionStyle(BaseModel):
    model_config = _STRICT
    template_id: str | None = Field(default=None, alias="templateId", min_length=1)
    display: Literal["phrase", "active-word", "cumulative"] | None = None
    font_family: str | None = Field(default=None, alias="fontFamily", min_length=1)
    font_weight: int | None = Field(default=None, alias="fontWeight", ge=100, le=900)
    font_style: Literal["normal", "italic"] | None = Field(default=None, alias="fontStyle")
    text_transform: Literal["none", "uppercase", "lowercase"] | None = Field(
        default=None, alias="textTransform"
    )
    letter_spacing: float | None = Field(default=None, alias="letterSpacing")
    font_scale: float | None = Field(default=None, alias="fontScale", gt=0.0)
    text_color: str | None = Field(default=None, alias="textColor", min_length=1)
    outline_color: str | None = Field(default=None, alias="outlineColor", min_length=1)
    outline_width: float | None = Field(default=None, alias="outlineWidth", ge=0.0)
    position: Literal["top", "middle", "bottom"] | None = None
    x_percent: float | None = Field(default=None, alias="xPercent", ge=0.0, le=100.0)
    y_percent: float | None = Field(default=None, alias="yPercent", ge=0.0, le=100.0)
    rotation: float | None = None
    max_width_percent: float | None = Field(default=None, alias="maxWidthPercent", ge=5.0, le=100.0)
    text_align: Literal["left", "center", "right"] | None = Field(default=None, alias="textAlign")
    line_height: float | None = Field(default=None, alias="lineHeight", ge=0.7, le=3.0)
    safe_area: bool | None = Field(default=None, alias="safeArea")
    background: _CaptionBackground | None = None
    shadow: _CaptionShadow | None = None
    highlight: _CaptionHighlight | None = None
    animation: _CaptionAnimation | None = None
    accent: _CaptionAccent | None = None


class _SetCaptionStyleArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    caption_style: _CaptionStyle | None = Field(alias="captionStyle")


class _SetTrackCaptionStyleArgs(BaseModel):
    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    caption_style: _CaptionStyle | None = Field(alias="captionStyle")


class _SetClipCropArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    crop: _StrictCropRect | None


class _AutoEmphasizeCaptionsArgs(BaseModel):
    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    keywords: list[str] = Field(min_length=1, max_length=12)
    style: _CaptionStyle | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$")
    font_scale: float | None = Field(default=None, alias="fontScale", ge=1.0, le=3.0)

    @field_validator("keywords")
    @classmethod
    def _keywords(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value for value in cleaned):
            raise ValueError("keywords must not be blank")
        normalized = [value.casefold() for value in cleaned]
        if len(set(normalized)) != len(normalized):
            raise ValueError("keywords must be unique")
        return cleaned


_MODEL_OVERRIDES: dict[str, type[BaseModel]] = {
    "add_asset": _AddAssetArgs,
    "add_clip": _AddClipArgs,
    "add_track": _AddTrackArgs,
    "get_transcript": _WindowArgs,
    "get_mapped_transcript": _WindowArgs,
    "get_clips": _GetClipsArgs,
    "map_time": _MapTimeArgs,
    "discover_effects": _DiscoverEffectsArgs,
    "discover_transitions": _DiscoverEffectsArgs,
    "discover_caption_styles": _DiscoverCaptionStylesArgs,
    "apply_effect": _ApplyEffectArgs,
    "move_effect": _MoveEffectArgs,
    "resize_effect": _ResizeEffectArgs,
    "adjust_effect": _AdjustEffectArgs,
    "get_frame": _GetFrameArgs,
    "add_keyframes": _AddKeyframesArgs,
    "punch_in": _PunchInArgs,
    "apply_color_grade": _ApplyColorGradeArgs,
    "adjust_audio": _AdjustAudioArgs,
    "track_object": _TrackObjectArgs,
    "manage_assets": _ManageAssetsArgs,
    "set_clip_crop": _SetClipCropArgs,
    "set_caption_style": _SetCaptionStyleArgs,
    "set_track_caption_style": _SetTrackCaptionStyleArgs,
    "auto_emphasize_captions": _AutoEmphasizeCaptionsArgs,
}


def install_python_tool_contracts(registry: dict[str, ToolSpec] = TOOL_REGISTRY) -> None:
    """Install strict models + derived schemas onto the shared registry in place.

    ``input_schema`` stays a faithful projection of ``input_model`` so the registry-wide
    "schema is derived from the model" invariant holds. Generator-idiom differences
    between Zod and Pydantic are reconciled in the parity comparison, not by rewriting
    what the registry advertises.
    """
    for name, model in _MODEL_OVERRIDES.items():
        spec = registry.get(name)
        if spec is None:
            continue
        spec.input_model = model
        spec.input_schema = model.model_json_schema(by_alias=True)
    transition = registry.get("add_transition")
    if transition is not None:
        transition.description = transition.description.replace(
            "list_transitions", "discover_transitions"
        )
