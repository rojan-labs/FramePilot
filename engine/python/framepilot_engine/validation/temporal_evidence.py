"""Acquire revision-bound temporal evidence from the deterministic render path.

Perceptual evidence is intentionally bounded, while technical colour scopes are measured from a
captionless full-resolution composition so resize/caption pixels cannot change legal-range data.
Every rendered result carries the exact composition identity that produced it. A caller-supplied
cancellation predicate is checked between expensive units of work.
"""

from __future__ import annotations

import logging
import math
import tempfile
import wave
from collections.abc import Callable, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Annotated, Literal, Protocol, cast

import numpy as np
import numpy.typing as npt
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from framepilot_engine.analysis.loudness import measure_loudness
from framepilot_engine.effects.keyframes import evaluate_keyframes
from framepilot_engine.media.assets import AssetIndex, index_assets
from framepilot_engine.render.color import skin_qualifier_mask
from framepilot_engine.render.compiler import compile_timeline, timeline_duration
from framepilot_engine.render.composition_cache import (
    COMPOSITION_CACHE as COMPOSITION_CACHE,
)
from framepilot_engine.render.composition_cache import composition_key
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Clip, Effect, Project, TrackType

_log = logging.getLogger(__name__)

TEMPORAL_EVIDENCE_VERSION: Literal[1] = 1
MAX_REQUESTS = 64
MAX_WINDOW_FRAMES = 300
MAX_RENDERED_FRAMES = 400
_FRAME_CHANNELS = 3
REVIEW_MAX_DIMENSION = 960
MAX_RESIDENT_FRAME_BYTES = 512 * 1024 * 1024
_BLACK_LUMA_THRESHOLD = 0.10
_AUDIO_SAMPLE_RATE = 48_000
_AUDIO_CHUNK_SAMPLES = 32_768
_MIN_DBFS = -120.0
CancelCheck = Callable[[], bool]


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.title() for part in tail)


class _ContractModel(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True, extra="forbid")


class _RequestBase(_ContractModel):
    schema_version: Literal[1]
    request_id: str = Field(min_length=1, max_length=256)
    project_revision: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=512)


class FrameEvidenceRequest(_RequestBase):
    kind: Literal["frame"]
    at_frame: int = Field(ge=0)
    metrics: list[Literal["luma", "black_ratio", "perceptual_hash"]] = Field(min_length=1)


class _WindowRequest(_RequestBase):
    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=0)

    @model_validator(mode="after")
    def _valid_window(self) -> _WindowRequest:
        width = self.end_frame - self.start_frame
        if width <= 0:
            raise ValueError("endFrame must be greater than startFrame")
        if width > MAX_WINDOW_FRAMES:
            raise ValueError(f"evidence windows may span at most {MAX_WINDOW_FRAMES} frames")
        return self


class RangeEvidenceRequest(_WindowRequest):
    kind: Literal["range"]
    sample_every_frames: int = Field(gt=0)
    checks: list[Literal["black_frames", "flash_frames"]] = Field(min_length=1)


class ComparisonEvidenceRequest(_RequestBase):
    kind: Literal["comparison"]
    left_frame: int = Field(ge=0)
    right_frame: int = Field(ge=0)
    check: Literal["transition_continuity", "shot_match"]
    max_difference: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _different_frames(self) -> ComparisonEvidenceRequest:
        if self.left_frame == self.right_frame:
            raise ValueError("comparison frames must differ")
        return self


class ScopeEvidenceRequest(_WindowRequest):
    kind: Literal["scope"]
    channels: list[
        Literal[
            "luma",
            "red",
            "green",
            "blue",
            "saturation",
            "skin_red",
            "skin_green",
            "skin_blue",
        ]
    ] = Field(min_length=1)
    legal_min: float
    legal_max: float

    @model_validator(mode="after")
    def _valid_legal_range(self) -> ScopeEvidenceRequest:
        if self.legal_max <= self.legal_min:
            raise ValueError("legalMax must be greater than legalMin")
        return self


class MotionEvidenceRequest(_WindowRequest):
    kind: Literal["motion"]
    target_id: str = Field(min_length=1, max_length=256)
    target_kind: Literal["clip_transform", "tracker", "mask"]
    property: str = Field(min_length=1, max_length=128)
    max_acceleration_per_frame: float | None = Field(default=None, ge=0)
    max_jitter_per_frame: float | None = Field(default=None, ge=0)
    require_inside_frame: bool = False


class AudioEvidenceRequest(_WindowRequest):
    kind: Literal["audio"]
    channels: Literal["mix", "dialogue", "music", "sfx"]
    max_peak_dbfs: float = Field(default=-0.1, le=0)
    max_boundary_jump_db: float = Field(default=12, ge=0)
    boundary_frame: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _valid_boundary(self) -> AudioEvidenceRequest:
        if self.boundary_frame is None:
            return self
        if not self.start_frame < self.boundary_frame < self.end_frame:
            raise ValueError("boundaryFrame must sit strictly inside the window")
        return self


class LoudnessEvidenceRequest(_WindowRequest):
    kind: Literal["loudness"]
    channels: Literal["mix", "dialogue", "music", "sfx"]
    target_lufs: float = Field(default=-14.0, le=0)
    tolerance_lu: float = Field(default=1.0, ge=0)


TemporalEvidenceRequest = Annotated[
    FrameEvidenceRequest
    | RangeEvidenceRequest
    | ComparisonEvidenceRequest
    | ScopeEvidenceRequest
    | MotionEvidenceRequest
    | AudioEvidenceRequest
    | LoudnessEvidenceRequest,
    Field(discriminator="kind"),
]


class FrameSample(_ContractModel):
    frame: int = Field(ge=0)
    luma: float = Field(ge=0, le=1)
    black_ratio: float = Field(ge=0, le=1)
    perceptual_hash: str | None = None


class ScopeSample(_ContractModel):
    frame: int = Field(ge=0)
    channel: str
    min: float
    max: float
    mean: float | None = None
    p10: float | None = None
    p50: float | None = None
    p90: float | None = None
    near_black_ratio: float | None = Field(default=None, ge=0, le=1)
    near_white_ratio: float | None = Field(default=None, ge=0, le=1)
    coverage_ratio: float | None = Field(default=None, ge=0, le=1)


class Point(_ContractModel):
    x: float
    y: float


class Bounds(_ContractModel):
    x: float
    y: float
    width: float
    height: float


class MotionSample(_ContractModel):
    frame: int = Field(ge=0)
    value: float | None = None
    point: Point | None = None
    bounds: Bounds | None = None


class AudioSample(_ContractModel):
    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=0)
    peak_dbfs: float
    rms_dbfs: float
    boundary_jump_db: float | None = Field(default=None, ge=0)


class LoudnessSample(_ContractModel):
    integrated_lufs: float
    loudness_range_lu: float | None = None
    true_peak_dbfs: float | None = None


class TemporalRenderSettings(_ContractModel):
    identity: str
    preset_id: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    fps: float = Field(gt=0)
    burn_captions: bool

    @model_validator(mode="after")
    def _identity_matches_settings(self) -> TemporalRenderSettings:
        expected = (
            f"{self.preset_id}:{self.width}x{self.height}@{self.fps:g}:"
            f"captions={str(self.burn_captions).lower()}"
        )
        if self.identity != expected:
            raise ValueError(f"identity must be {expected}")
        return self


class _ResultBase(_ContractModel):
    schema_version: Literal[1] = TEMPORAL_EVIDENCE_VERSION
    request_id: str
    project_revision: int = Field(ge=0)
    # Exact composition that produced this result. Motion is timeline/keyframe evidence and has
    # no render provenance, so it explicitly carries None.
    render_settings: TemporalRenderSettings | None = None


class FrameEvidenceResult(_ResultBase):
    kind: Literal["frame"] = "frame"
    sample: FrameSample


class RangeEvidenceResult(_ResultBase):
    kind: Literal["range"] = "range"
    samples: list[FrameSample]


class ComparisonEvidenceResult(_ResultBase):
    kind: Literal["comparison"] = "comparison"
    left_frame: int
    right_frame: int
    difference: float = Field(ge=0, le=1)


class ScopeEvidenceResult(_ResultBase):
    kind: Literal["scope"] = "scope"
    samples: list[ScopeSample]


class MotionEvidenceResult(_ResultBase):
    kind: Literal["motion"] = "motion"
    samples: list[MotionSample]


class AudioEvidenceResult(_ResultBase):
    kind: Literal["audio"] = "audio"
    samples: list[AudioSample]


class LoudnessEvidenceResult(_ResultBase):
    kind: Literal["loudness"] = "loudness"
    sample: LoudnessSample


TemporalEvidenceResult = (
    FrameEvidenceResult
    | RangeEvidenceResult
    | ComparisonEvidenceResult
    | ScopeEvidenceResult
    | MotionEvidenceResult
    | AudioEvidenceResult
    | LoudnessEvidenceResult
)


class TemporalEvidenceBatch(_ContractModel):
    # Backward-compatible default only. Consumers must use per-result render_settings for lineage.
    render_settings: TemporalRenderSettings
    results: list[TemporalEvidenceResult]


class TemporalEvidenceError(RuntimeError):
    """Evidence cannot be acquired without violating the request contract."""


class TemporalEvidenceCancelled(TemporalEvidenceError):
    """The caller no longer needs this evidence batch."""


class _AudioLike(Protocol):
    def get_frame(self, time: npt.NDArray[np.float64]) -> object: ...


class _CompositionLike(Protocol):
    audio: _AudioLike | None

    def get_frame(self, time: float) -> object: ...

    def close(self) -> None: ...


def _check_cancelled(cancelled: CancelCheck | None) -> None:
    if cancelled is not None and cancelled():
        raise TemporalEvidenceCancelled("Temporal evidence acquisition was cancelled.")


def _settings(preset: ExportPreset, burn_captions: bool) -> TemporalRenderSettings:
    return TemporalRenderSettings(
        identity=(
            f"{preset.id}:{preset.width}x{preset.height}@{preset.fps}:"
            f"captions={str(burn_captions).lower()}"
        ),
        preset_id=preset.id,
        width=preset.width,
        height=preset.height,
        fps=preset.fps,
        burn_captions=burn_captions,
    )


def _dbfs(amplitude: float) -> float:
    if amplitude <= 0:
        return _MIN_DBFS
    return max(_MIN_DBFS, 20.0 * math.log10(amplitude))


def _frame_sample(frame_index: int, pixels: npt.NDArray[np.uint8]) -> FrameSample:
    rgb = pixels[..., :3] / 255.0
    luma_pixels = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    image = Image.fromarray(np.asarray(pixels[..., :3], dtype=np.uint8))
    grayscale = np.asarray(image.resize((9, 8)).convert("L"), dtype=np.uint8)
    hash_value = 0
    for row in grayscale:
        for left, right in pairwise(row):
            hash_value = (hash_value << 1) | int(left > right)
    return FrameSample(
        frame=frame_index,
        luma=float(np.mean(luma_pixels)),
        black_ratio=float(np.mean(luma_pixels <= _BLACK_LUMA_THRESHOLD)),
        perceptual_hash=str(hash_value),
    )


def _scope_values(
    frame_index: int,
    pixels: npt.NDArray[np.uint8],
    channels: Sequence[str],
) -> list[ScopeSample]:
    rgb = pixels[..., :3] / 255.0
    values: dict[str, npt.NDArray[np.float64]] = {
        "red": rgb[..., 0],
        "green": rgb[..., 1],
        "blue": rgb[..., 2],
        "luma": rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722,
        "saturation": np.max(rgb, axis=2) - np.min(rgb, axis=2),
    }
    samples: list[ScopeSample] = []
    skin_mask: npt.NDArray[np.bool_] | None = None
    for channel in channels:
        coverage: float | None = None
        if channel.startswith("skin_"):
            if skin_mask is None:
                skin_mask = skin_qualifier_mask(rgb)
            coverage = float(np.mean(skin_mask))
            channel_values = values[channel.removeprefix("skin_")][skin_mask]
            if channel_values.size == 0:
                samples.append(
                    ScopeSample(
                        frame=frame_index, channel=channel, min=0.0, max=0.0, coverage_ratio=0.0
                    )
                )
                continue
        else:
            channel_values = values[channel]
        p10, p50, p90 = np.percentile(channel_values, [10, 50, 90])
        samples.append(
            ScopeSample(
                frame=frame_index,
                channel=channel,
                min=float(np.min(channel_values)),
                max=float(np.max(channel_values)),
                mean=float(np.mean(channel_values)),
                p10=float(p10),
                p50=float(p50),
                p90=float(p90),
                near_black_ratio=float(np.mean(channel_values <= 1.0 / 255.0)),
                near_white_ratio=float(np.mean(channel_values >= 254.0 / 255.0)),
                coverage_ratio=coverage,
            )
        )
    return samples


def _find_clip(project: Project, target_id: str) -> Clip:
    for track in project.timeline.tracks:
        for clip in track.clips:
            if clip.id == target_id:
                return clip
    raise TemporalEvidenceError(f"No clip {target_id!r} exists for motion evidence.")


def _find_effect(project: Project, target_id: str, kind: str) -> tuple[Clip, Effect]:
    expected_type = "object_track" if kind == "tracker" else "mask"
    for track in project.timeline.tracks:
        for clip in track.clips:
            for effect in clip.effects:
                if effect.id == target_id and effect.type == expected_type:
                    return clip, effect
    raise TemporalEvidenceError(f"No {kind} effect {target_id!r} exists for motion evidence.")


def _motion_samples(
    project: Project,
    request: MotionEvidenceRequest,
    cancelled: CancelCheck | None,
) -> list[MotionSample]:
    if request.target_kind == "clip_transform":
        clip = _find_clip(project, request.target_id)
        keyframes = clip.keyframes
    else:
        clip, effect = _find_effect(project, request.target_id, request.target_kind)
        keyframes = effect.keyframes
    samples: list[MotionSample] = []
    for frame_index in range(request.start_frame, request.end_frame):
        _check_cancelled(cancelled)
        time_seconds = frame_index / project.fps
        local_time = time_seconds - clip.start
        value = evaluate_keyframes(keyframes, request.property, local_time)
        x = evaluate_keyframes(keyframes, "x", local_time)
        y = evaluate_keyframes(keyframes, "y", local_time)
        width = evaluate_keyframes(keyframes, "width", local_time)
        height = evaluate_keyframes(keyframes, "height", local_time)
        point = Point(x=x, y=y) if x is not None and y is not None else None
        bounds = (
            Bounds(x=x, y=y, width=width, height=height)
            if x is not None and y is not None and width is not None and height is not None
            else None
        )
        samples.append(MotionSample(frame=frame_index, value=value, point=point, bounds=bounds))
    return samples


def _review_frame_size(width: int, height: int) -> tuple[int, int]:
    longest = max(width, height)
    if longest <= REVIEW_MAX_DIMENSION:
        return width, height
    scale = REVIEW_MAX_DIMENSION / longest
    return (
        max(2, round(width * scale / 2) * 2),
        max(2, round(height * scale / 2) * 2),
    )


def _representative_frames(start: int, end: int) -> list[int]:
    return sorted({start, (start + end - 1) // 2, end - 1})


def _role_isolated_project(project: Project, role: str) -> Project:
    isolated = project.model_copy(deep=True)
    labelled = 0
    for track in isolated.timeline.tracks:
        if track.type is not TrackType.AUDIO:
            track.muted = True
            continue
        if track.role is not None and track.role.value == role:
            labelled += 1
        else:
            track.muted = True
    if labelled == 0:
        raise TemporalEvidenceError(
            f"No track is labelled {role!r}, so that role cannot be measured. Roles are authored, "
            "never inferred from track names; label the track or request mix evidence instead."
        )
    return isolated


def _audio_frames(
    composition: _CompositionLike,
    start_seconds: float,
    end_seconds: float,
    cancelled: CancelCheck | None,
) -> npt.NDArray[np.float64]:
    if composition.audio is None:
        raise TemporalEvidenceError("The compiled timeline has no audio for audio evidence.")
    count = max(2, math.ceil((end_seconds - start_seconds) * _AUDIO_SAMPLE_RATE))
    times = np.linspace(start_seconds, end_seconds, count, endpoint=False, dtype=np.float64)
    chunks: list[npt.NDArray[np.float64]] = []
    for offset in range(0, times.size, _AUDIO_CHUNK_SAMPLES):
        _check_cancelled(cancelled)
        block = np.asarray(
            composition.audio.get_frame(times[offset : offset + _AUDIO_CHUNK_SAMPLES]),
            dtype=np.float64,
        )
        chunks.append(block if block.ndim > 1 else block[:, np.newaxis])
    samples = np.concatenate(chunks) if chunks else np.empty((0, 1), dtype=np.float64)
    if samples.size == 0:
        raise TemporalEvidenceError("The compiled timeline returned no audio samples.")
    return samples


def _window_wav(
    composition: _CompositionLike,
    start_frame: int,
    end_frame: int,
    fps: int,
    destination: Path,
    cancelled: CancelCheck | None,
) -> None:
    samples = _audio_frames(composition, start_frame / fps, end_frame / fps, cancelled)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(destination), "wb") as handle:
        handle.setnchannels(pcm.shape[1])
        handle.setsampwidth(2)
        handle.setframerate(_AUDIO_SAMPLE_RATE)
        handle.writeframes(pcm.tobytes())


def _loudness_sample(
    composition: _CompositionLike,
    request: LoudnessEvidenceRequest,
    fps: int,
    cancelled: CancelCheck | None,
) -> LoudnessSample:
    with tempfile.TemporaryDirectory(prefix="fp-loudness-") as directory:
        wav = Path(directory) / "window.wav"
        _window_wav(composition, request.start_frame, request.end_frame, fps, wav, cancelled)
        _check_cancelled(cancelled)
        analysis = measure_loudness(wav)
    if analysis is None:
        raise TemporalEvidenceError("ebur128 reported no loudness summary for the window.")
    return LoudnessSample(
        integrated_lufs=analysis.integrated_lufs,
        loudness_range_lu=analysis.loudness_range_lu,
        true_peak_dbfs=analysis.true_peak_dbfs,
    )


def _audio_sample(
    composition: _CompositionLike,
    request: AudioEvidenceRequest,
    fps: int,
    cancelled: CancelCheck | None,
) -> AudioSample:
    samples = _audio_frames(
        composition, request.start_frame / fps, request.end_frame / fps, cancelled
    )
    amplitudes = np.abs(samples)
    peak = float(np.max(amplitudes))
    rms = float(np.sqrt(np.mean(np.square(samples))))
    return AudioSample(
        start_frame=request.start_frame,
        end_frame=request.end_frame,
        peak_dbfs=_dbfs(peak),
        rms_dbfs=_dbfs(rms),
        boundary_jump_db=_boundary_jump_db(samples, request),
    )


def _boundary_jump_db(
    samples: npt.NDArray[np.float64], request: AudioEvidenceRequest
) -> float | None:
    boundary = request.boundary_frame
    if boundary is None:
        return None
    span = request.end_frame - request.start_frame
    split = round(samples.shape[0] * (boundary - request.start_frame) / span)
    split = min(max(split, 1), samples.shape[0] - 1)
    before_rms = float(np.sqrt(np.mean(np.square(samples[:split]))))
    after_rms = float(np.sqrt(np.mean(np.square(samples[split:]))))
    return abs(_dbfs(before_rms) - _dbfs(after_rms))


@dataclass(frozen=True)
class _FramePlan:
    sample_frames: frozenset[int]
    comparison_frames: frozenset[int]


def _plan_visual_frames(requests: Sequence[TemporalEvidenceRequest]) -> _FramePlan:
    sample_frames: set[int] = set()
    comparison_frames: set[int] = set()
    for request in requests:
        if isinstance(request, FrameEvidenceRequest):
            sample_frames.add(request.at_frame)
        elif isinstance(request, RangeEvidenceRequest):
            sample_frames.update(
                range(request.start_frame, request.end_frame, request.sample_every_frames)
            )
        elif isinstance(request, ComparisonEvidenceRequest):
            comparison_frames.update((request.left_frame, request.right_frame))
    return _FramePlan(
        sample_frames=frozenset(sample_frames),
        comparison_frames=frozenset(comparison_frames),
    )


def _ordinary_visual_frames(requests: Sequence[TemporalEvidenceRequest]) -> set[int]:
    plan = _plan_visual_frames(requests)
    return set(plan.sample_frames | plan.comparison_frames)


def _scope_plan(requests: Sequence[TemporalEvidenceRequest]) -> dict[int, set[tuple[str, ...]]]:
    scope_channels: dict[int, set[tuple[str, ...]]] = {}
    for request in requests:
        if not isinstance(request, ScopeEvidenceRequest):
            continue
        channels = tuple(request.channels)
        for frame_index in _representative_frames(request.start_frame, request.end_frame):
            scope_channels.setdefault(frame_index, set()).add(channels)
    return scope_channels


def _validate_requests(project: Project, requests: Sequence[TemporalEvidenceRequest]) -> int:
    if not requests:
        raise TemporalEvidenceError("At least one temporal evidence request is required.")
    if len(requests) > MAX_REQUESTS:
        raise TemporalEvidenceError(f"At most {MAX_REQUESTS} evidence requests are allowed.")
    request_ids = [request.request_id for request in requests]
    if len(set(request_ids)) != len(request_ids):
        raise TemporalEvidenceError("Temporal evidence request ids must be unique.")
    revisions = {request.project_revision for request in requests}
    if len(revisions) != 1:
        raise TemporalEvidenceError("Temporal evidence requests must target one revision.")
    project_revision = project.timeline.revision or 0
    if revisions != {project_revision}:
        requested = next(iter(revisions))
        raise TemporalEvidenceError(
            f"Requested revision {requested} does not match project revision {project_revision}."
        )
    duration_frames = math.ceil(timeline_duration(project.timeline) * project.fps)
    for request in requests:
        requested_end = (
            request.at_frame + 1
            if isinstance(request, FrameEvidenceRequest)
            else max(request.left_frame, request.right_frame) + 1
            if isinstance(request, ComparisonEvidenceRequest)
            else request.end_frame
        )
        if requested_end > duration_frames:
            raise TemporalEvidenceError(
                f"Request {request.request_id!r} reaches frame {requested_end - 1}, "
                f"but the timeline ends at frame {max(0, duration_frames - 1)}."
            )
    return project_revision


def _borrow_programme(
    stack: ExitStack,
    project: Project,
    base_dir: Path,
    assets: AssetIndex,
    preset: ExportPreset,
    *,
    burn_captions: bool,
    max_decode_dimension: int | None,
) -> _CompositionLike:
    def build() -> _CompositionLike:
        return cast(
            _CompositionLike,
            compile_timeline(
                project,
                assets,
                preset,
                burn_captions=burn_captions,
                max_decode_dimension=max_decode_dimension,
            ),
        )

    return cast(
        _CompositionLike,
        stack.enter_context(
            COMPOSITION_CACHE.borrow(
                composition_key(
                    project,
                    base_dir,
                    preset,
                    burn_captions=burn_captions,
                    max_decode_dimension=max_decode_dimension,
                ),
                build,
            )
        ),
    )


def acquire_temporal_evidence(
    project: Project,
    base_dir: Path,
    requests: Sequence[TemporalEvidenceRequest],
    cancelled: CancelCheck | None = None,
) -> TemporalEvidenceBatch:
    """Acquire one bounded evidence batch, aborting cooperatively when no longer needed."""
    _check_cancelled(cancelled)
    project_revision = _validate_requests(project, requests)
    plan = _plan_visual_frames(requests)
    ordinary_frames = _ordinary_visual_frames(requests)
    scope_plan = _scope_plan(requests)
    scope_frames = set(scope_plan)
    if len(ordinary_frames | scope_frames) > MAX_RENDERED_FRAMES:
        raise TemporalEvidenceError(
            f"A batch may render at most {MAX_RENDERED_FRAMES} distinct frames."
        )

    review_width, review_height = _review_frame_size(
        project.resolution.width, project.resolution.height
    )
    resident_bytes = len(plan.comparison_frames) * review_width * review_height * _FRAME_CHANNELS
    if resident_bytes > MAX_RESIDENT_FRAME_BYTES:
        raise TemporalEvidenceError(
            f"This batch would hold {resident_bytes // (1024 * 1024)} MB of comparison "
            f"frames at {review_width}x{review_height}; the limit "
            f"is {MAX_RESIDENT_FRAME_BYTES // (1024 * 1024)} MB. Ask for fewer comparisons."
        )

    ordinary_preset = ExportPreset(
        id="temporal-evidence",
        label="Temporal evidence",
        width=review_width,
        height=review_height,
        fps=project.fps,
    )
    scope_preset = ExportPreset(
        id="temporal-scope",
        label="Temporal technical scope",
        width=project.resolution.width,
        height=project.resolution.height,
        fps=project.fps,
    )
    ordinary_settings = _settings(ordinary_preset, True)
    scope_settings = _settings(scope_preset, False)
    role_settings = _settings(ordinary_preset, False)
    render_settings = (
        ordinary_settings
        if ordinary_frames
        or any(isinstance(r, AudioEvidenceRequest | LoudnessEvidenceRequest) for r in requests)
        else scope_settings
    )

    assets: AssetIndex | None = None
    programme: _CompositionLike | None = None
    scope_composition: _CompositionLike | None = None
    role_compositions: dict[str, _CompositionLike] = {}
    frame_cache: dict[int, npt.NDArray[np.uint8]] = {}
    frame_samples: dict[int, FrameSample] = {}
    scope_cache: dict[tuple[int, tuple[str, ...]], list[ScopeSample]] = {}
    results: list[TemporalEvidenceResult] = []
    borrowed = ExitStack()
    scope_borrowed = ExitStack()

    try:
        needs_programme = bool(ordinary_frames) or any(
            isinstance(request, AudioEvidenceRequest | LoudnessEvidenceRequest)
            for request in requests
        )
        if needs_programme or scope_frames:
            _check_cancelled(cancelled)
            assets = index_assets(
                [asset.model_dump() for asset in project.assets], base_dir=base_dir
            )

        if needs_programme:
            assert assets is not None
            _check_cancelled(cancelled)
            programme = _borrow_programme(
                borrowed,
                project,
                base_dir,
                assets,
                ordinary_preset,
                burn_captions=True,
                max_decode_dimension=REVIEW_MAX_DIMENSION,
            )
            try:
                for frame_index in sorted(ordinary_frames):
                    _check_cancelled(cancelled)
                    pixels = np.asarray(programme.get_frame(frame_index / project.fps))
                    if pixels.dtype != np.uint8:
                        pixels = pixels.astype(np.uint8)
                    if frame_index in plan.sample_frames:
                        frame_samples[frame_index] = _frame_sample(frame_index, pixels)
                    if frame_index in plan.comparison_frames:
                        frame_cache[frame_index] = pixels
            except TemporalEvidenceCancelled:
                raise
            except Exception as exc:
                raise TemporalEvidenceError(
                    f"Could not compile or sample temporal evidence: {exc}"
                ) from exc

        if scope_frames:
            assert assets is not None
            _check_cancelled(cancelled)
            try:
                scope_composition = _borrow_programme(
                    scope_borrowed,
                    project,
                    base_dir,
                    assets,
                    scope_preset,
                    burn_captions=False,
                    max_decode_dimension=None,
                )
                for frame_index in sorted(scope_frames):
                    _check_cancelled(cancelled)
                    pixels = np.asarray(scope_composition.get_frame(frame_index / project.fps))
                    if pixels.dtype != np.uint8:
                        pixels = pixels.astype(np.uint8)
                    for channels in scope_plan.get(frame_index, ()):
                        scope_cache[frame_index, channels] = _scope_values(
                            frame_index, pixels, channels
                        )
            except TemporalEvidenceCancelled:
                raise
            except Exception as exc:
                raise TemporalEvidenceError(
                    f"Could not compile or sample technical scope evidence: {exc}"
                ) from exc

        for request in requests:
            _check_cancelled(cancelled)
            common = {"request_id": request.request_id, "project_revision": project_revision}
            if isinstance(request, FrameEvidenceRequest):
                results.append(
                    FrameEvidenceResult(
                        **common,
                        render_settings=ordinary_settings,
                        sample=frame_samples[request.at_frame],
                    )
                )
            elif isinstance(request, RangeEvidenceRequest):
                frames = range(request.start_frame, request.end_frame, request.sample_every_frames)
                results.append(
                    RangeEvidenceResult(
                        **common,
                        render_settings=ordinary_settings,
                        samples=[frame_samples[frame_index] for frame_index in frames],
                    )
                )
            elif isinstance(request, ComparisonEvidenceRequest):
                left = frame_cache[request.left_frame][..., :3] / 255.0
                right = frame_cache[request.right_frame][..., :3] / 255.0
                results.append(
                    ComparisonEvidenceResult(
                        **common,
                        render_settings=ordinary_settings,
                        left_frame=request.left_frame,
                        right_frame=request.right_frame,
                        difference=float(np.mean(np.abs(left - right))),
                    )
                )
            elif isinstance(request, ScopeEvidenceRequest):
                samples: list[ScopeSample] = []
                channels = tuple(request.channels)
                for frame_index in _representative_frames(request.start_frame, request.end_frame):
                    samples.extend(scope_cache[frame_index, channels])
                results.append(
                    ScopeEvidenceResult(
                        **common,
                        render_settings=scope_settings,
                        samples=samples,
                    )
                )
            elif isinstance(request, MotionEvidenceRequest):
                results.append(
                    MotionEvidenceResult(
                        **common,
                        render_settings=None,
                        samples=_motion_samples(project, request, cancelled),
                    )
                )
            else:
                if programme is None:
                    raise TemporalEvidenceError("Audio evidence requires a compiled timeline.")
                if request.channels == "mix":
                    source = programme
                    audio_settings = ordinary_settings
                else:
                    if request.channels not in role_compositions:
                        _check_cancelled(cancelled)
                        if assets is None:
                            raise TemporalEvidenceError("Role evidence requires indexed assets.")
                        role_compositions[request.channels] = cast(
                            _CompositionLike,
                            compile_timeline(
                                _role_isolated_project(project, request.channels),
                                assets,
                                ordinary_preset,
                                burn_captions=False,
                                max_decode_dimension=REVIEW_MAX_DIMENSION,
                            ),
                        )
                    source = role_compositions[request.channels]
                    audio_settings = role_settings
                if isinstance(request, LoudnessEvidenceRequest):
                    results.append(
                        LoudnessEvidenceResult(
                            **common,
                            render_settings=audio_settings,
                            sample=_loudness_sample(source, request, project.fps, cancelled),
                        )
                    )
                else:
                    results.append(
                        AudioEvidenceResult(
                            **common,
                            render_settings=audio_settings,
                            samples=[_audio_sample(source, request, project.fps, cancelled)],
                        )
                    )
    finally:
        for isolated in role_compositions.values():
            close_clip_tree(isolated)
        scope_borrowed.close()
        borrowed.close()

    _log.info(
        "ACT temporal evidence acquired: revision=%d requests=%d review_frames=%d scope_frames=%d",
        project_revision,
        len(requests),
        len(ordinary_frames),
        len(scope_frames),
    )
    return TemporalEvidenceBatch(render_settings=render_settings, results=results)
