"""Render job model and lifecycle (PRD §9.3, plan 2.2).

WHY: rendering is deterministic and runs as a tracked job that moves through a
fixed lifecycle (PRD §9.3) and whose output is **always validated** before it is
reported complete (PRD §9.4). This module owns the job shape, the lifecycle
state machine, and the synchronous render driver that ties together the
compiler (:mod:`framepilot_engine.render.compiler`), the encoder (MoviePy/
FFmpeg), and render validation.

Scope (Phase 2): :func:`render` runs synchronously and drives every state. The
*background queue* with mid-encode cancellation/resume (PRD §18.3) is a thin
layer over this driver and is tracked as a follow-up — the lifecycle states and
the cancellation seam (:class:`RenderOptions.timeout_seconds`) are already here.
"""

from __future__ import annotations

import uuid
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from framepilot_engine.audio.filters import apply_master_audio, build_master_filter
from framepilot_engine.media.assets import index_assets
from framepilot_engine.render.compiler import compile_timeline, expected_render, timeline_duration
from framepilot_engine.render.presets import EXPORT_PRESETS, REELS, ExportPreset
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.safety import resolve_within
from framepilot_engine.timeline.models import Project
from framepilot_engine.validation.render_validation import (
    CheckStatus,
    ValidationReport,
    validate_render,
)

# Preview renders downscale by this factor for speed (PRD §9.2 fast preview).
_PREVIEW_SCALE = 0.5


class RenderError(RuntimeError):
    """A render failed at a specific lifecycle stage (asset prep, encode, validate)."""


class RenderState(StrEnum):
    """Render job lifecycle states (PRD §9.3)."""

    QUEUED = "queued"
    PREPARING_ASSETS = "preparing_assets"
    RENDERING_FRAMES = "rendering_frames"
    ENCODING = "encoding"
    VALIDATING_OUTPUT = "validating_output"
    COMPLETED = "completed"
    FAILED = "failed"


class RenderOptions(BaseModel):
    """Options controlling a render (preview vs final, preset, output path)."""

    preset_id: str | None = Field(default=None, description="Export preset id (render.presets).")
    output_path: str | None = Field(default=None, description="Destination file path.")
    preview: bool = Field(default=False, description="Fast low-res preview vs final export.")
    burn_captions: bool = Field(
        default=False, description="Burn caption-track text into the output (plan 3.3)."
    )
    denoise: bool = Field(default=False, description="Master-bus broadband de-noise (afftdn).")
    eq: str | None = Field(
        default=None,
        description="EQ preset: flat|warm|bright|voice-clarity (chained equalizer bands).",
    )
    compression: str | None = Field(
        default=None, description="Compression preset: voice (acompressor)."
    )
    loudness: str | None = Field(
        default=None, description="Loudness preset: social|podcast|broadcast (loudnorm)."
    )
    limiter: bool = Field(default=False, description="Master-bus brick-wall limiter (alimiter).")
    timeout_seconds: int | None = Field(default=None, description="Hard timeout override.")


class RenderJob(BaseModel):
    """A unit of render work tracked through its lifecycle (PRD §9.3)."""

    id: str
    project_id: str
    state: RenderState = RenderState.QUEUED
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    output_path: str | None = None
    error: str | None = None
    validation: ValidationReport | None = None


def resolve_preset(opts: RenderOptions) -> ExportPreset:
    """Resolve the export preset for ``opts``, defaulting to vertical Reels.

    :param opts: Render options.
    :returns: The chosen :class:`ExportPreset`.
    :raises ValueError: If ``preset_id`` is set but unknown.
    """
    if opts.preset_id is None:
        return REELS
    try:
        return EXPORT_PRESETS[opts.preset_id]
    except KeyError as exc:
        raise ValueError(
            f"Unknown preset {opts.preset_id!r}. Known: {sorted(EXPORT_PRESETS)}."
        ) from exc


def _preview_preset(preset: ExportPreset) -> ExportPreset:
    """Derive a fast, downscaled preview preset from ``preset`` (even dimensions)."""

    def even(value: int) -> int:
        scaled = int(value * _PREVIEW_SCALE)
        return scaled if scaled % 2 == 0 else scaled + 1  # H.264 needs even dims

    return preset.model_copy(update={"width": even(preset.width), "height": even(preset.height)})


def _default_output_path(base_dir: Path, project: Project, preset: ExportPreset) -> Path:
    """Default export destination inside the project sandbox: ``exports/<id>.<ext>``."""
    return base_dir / "exports" / f"{project.id}.{preset.container}"


def render(
    project: Project,
    opts: RenderOptions,
    *,
    base_dir: Path,
    job_id: str | None = None,
) -> RenderJob:
    """Compile ``project`` and render it according to ``opts``, then validate it.

    Drives the full lifecycle (PRD §9.3); the output is automatically validated
    (PRD §9.4) and the job is only ``COMPLETED`` if validation passes. All paths
    (assets and output) are sandboxed to ``base_dir``.

    :param project: The project whose timeline to render.
    :param opts: Render options (preview/final, preset, output, timeout).
    :param base_dir: The project directory; sandbox root for assets and output.
    :param job_id: Optional stable job id (a uuid4 is generated when omitted).
    :returns: A :class:`RenderJob`; ``state`` is ``COMPLETED`` or ``FAILED``.
    """
    job = RenderJob(id=job_id or uuid.uuid4().hex, project_id=project.id)

    try:
        preset = resolve_preset(opts)
        if opts.preview:
            preset = _preview_preset(preset)

        # --- Resolve output path inside the sandbox ---------------------------
        if opts.output_path is not None:
            output = resolve_within(base_dir, opts.output_path)
        else:
            output = _default_output_path(base_dir, project, preset)
        output.parent.mkdir(parents=True, exist_ok=True)

        # --- preparing_assets -------------------------------------------------
        job.state = RenderState.PREPARING_ASSETS
        # ``index_assets`` reads plain mappings (id/path/kind); dump the typed
        # Asset models to that shape via their camelCase aliases.
        asset_index = index_assets(
            [asset.model_dump(by_alias=True) for asset in project.assets], base_dir
        )
        if asset_index.missing:
            missing = ", ".join(e.asset_id for e in asset_index.missing)
            raise RenderError(f"Cannot render: unusable assets [{missing}].")

        if timeline_duration(project.timeline) <= 0:
            raise RenderError("Cannot render an empty timeline (zero duration).")

        # --- rendering_frames + encoding -------------------------------------
        job.state = RenderState.RENDERING_FRAMES
        _encode(project, asset_index, preset, output, job, burn_captions=opts.burn_captions)

        # --- master-bus audio pass (optional, deterministic ffmpeg filter) ----
        _apply_master_audio_pass(output, preset, opts)

        # --- validating_output ------------------------------------------------
        job.state = RenderState.VALIDATING_OUTPUT
        report = validate_render(
            output,
            expected_render(project, preset),
            timeout=float(opts.timeout_seconds) if opts.timeout_seconds else None,
        )
        job.validation = report
        job.output_path = str(output)

        if not report.ok:
            failed = ", ".join(
                c.name for c in report.checks if c.status == CheckStatus.FAIL
            )
            raise RenderError(f"Render produced an invalid output (failed checks: {failed}).")

        job.state = RenderState.COMPLETED
        job.progress = 1.0
    except Exception as exc:  # any stage failure is reported as a FAILED job, not raised
        job.state = RenderState.FAILED
        job.error = str(exc)

    return job


def _encode(
    project: Project,
    asset_index: Any,
    preset: ExportPreset,
    output: Path,
    job: RenderJob,
    *,
    burn_captions: bool = False,
) -> None:
    """Compile + write the composition to ``output`` (frames then FFmpeg encode)."""
    composite = compile_timeline(project, asset_index, preset, burn_captions=burn_captions)
    try:
        job.state = RenderState.ENCODING
        composite.write_videofile(
            str(output),
            codec=preset.video_codec,
            audio_codec=preset.audio_codec,
            fps=preset.fps or project.fps,
            logger=None,  # silence MoviePy's stdout progress bar
        )
    finally:
        # Release the underlying FFmpeg readers/writers deterministically. The
        # composite's own close() spares the clips it composites, so the whole
        # tree is torn down (see render.resources).
        close_clip_tree(composite)


def _apply_master_audio_pass(output: Path, preset: ExportPreset, opts: RenderOptions) -> None:
    """Apply the optional master-bus audio filter to the rendered file in place.

    Builds the ffmpeg ``-af`` chain from the render options (de-noise / EQ /
    compression / loudness / limiter); when empty this is a no-op. The filtered
    result is written to a sibling temp file then atomically replaces the output,
    so a failure leaves the original render untouched. Runs before validation, so
    the validated file is the final delivered audio.
    """
    filter_str = build_master_filter(
        denoise=opts.denoise,
        eq=opts.eq,
        compression=opts.compression,
        loudness=opts.loudness,
        limiter=opts.limiter,
    )
    if filter_str is None:
        return
    tmp = output.with_suffix(output.suffix + ".master.tmp")
    apply_master_audio(output, tmp, filter_str, audio_codec=preset.audio_codec)
    tmp.replace(output)


def render_preview(
    project: Project,
    *,
    base_dir: Path,
    preset_id: str | None = None,
    output_path: str | None = None,
    burn_captions: bool = False,
    job_id: str | None = None,
) -> RenderJob:
    """Render a fast, downscaled preview (PRD §9.2). Thin wrapper over :func:`render`."""
    opts = RenderOptions(
        preset_id=preset_id, output_path=output_path, preview=True, burn_captions=burn_captions
    )
    return render(project, opts, base_dir=base_dir, job_id=job_id)


def export_video(
    project: Project,
    *,
    base_dir: Path,
    preset_id: str | None = None,
    output_path: str | None = None,
    burn_captions: bool = False,
    job_id: str | None = None,
) -> RenderJob:
    """Render a final, full-resolution export (PRD §9.3). Thin wrapper over :func:`render`."""
    opts = RenderOptions(
        preset_id=preset_id, output_path=output_path, preview=False, burn_captions=burn_captions
    )
    return render(project, opts, base_dir=base_dir, job_id=job_id)
