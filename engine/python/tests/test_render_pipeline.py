"""Tests for the render driver and lifecycle (plan 2.2)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.pipeline import (
    RenderOptions,
    RenderState,
    _apply_master_audio_pass,
    export_video,
    render,
    render_preview,
    resolve_preset,
)
from framepilot_engine.render.presets import REELS, YOUTUBE
from framepilot_engine.timeline.models import Project


def _video_project(asset_path: str = "clip.mp4", *, seconds: float = 1.0) -> Project:
    """A one-video-track project (no audio) referencing ``asset_path``."""
    return Project.model_validate(
        {
            "id": "p1",
            "name": "T",
            "fps": 30,
            "assets": [{"id": "a1", "path": asset_path, "kind": "video"}],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c1",
                                "assetId": "a1",
                                "trackId": "v",
                                "start": 0.0,
                                "end": seconds,
                                "sourceStart": 0.0,
                                "sourceEnd": seconds,
                            }
                        ],
                    }
                ]
            },
        }
    )


def _place_asset(media_factory: Callable[..., Path], base: Path, name: str, **kw: Any) -> None:
    """Generate a clip and copy it into the project sandbox as ``name``."""
    src = media_factory(name, **kw)
    (base / name).write_bytes(src.read_bytes())


# --- preset resolution -------------------------------------------------------


def test_resolve_preset_defaults_to_reels() -> None:
    assert resolve_preset(RenderOptions()) is REELS


def test_resolve_preset_known() -> None:
    assert resolve_preset(RenderOptions(preset_id="youtube")) is YOUTUBE


def test_resolve_preset_unknown_raises() -> None:
    with pytest.raises(ValueError, match="Unknown preset"):
        resolve_preset(RenderOptions(preset_id="nope"))


# --- failure paths (no real encode needed) -----------------------------------


def test_render_missing_asset_fails(tmp_project_dir: Path) -> None:
    job = render(_video_project("gone.mp4"), RenderOptions(), base_dir=tmp_project_dir)
    assert job.state == RenderState.FAILED
    assert job.error is not None and "assets" in job.error
    assert job.output_path is None


def test_render_empty_timeline_fails(tmp_project_dir: Path) -> None:
    empty = Project.model_validate(
        {"id": "p", "name": "T", "assets": [], "timeline": {"tracks": []}}
    )
    job = render(empty, RenderOptions(), base_dir=tmp_project_dir)
    assert job.state == RenderState.FAILED
    assert job.error is not None and "empty timeline" in job.error


def test_render_output_path_traversal_fails(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    _place_asset(media_factory, tmp_project_dir, "clip.mp4", seconds=1.0, with_audio=False)
    job = render(
        _video_project(),
        RenderOptions(output_path="../escape.mp4"),
        base_dir=tmp_project_dir,
    )
    assert job.state == RenderState.FAILED
    assert job.error is not None and "escapes sandbox" in job.error


# --- real end-to-end renders -------------------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_export_video_completes_and_validates(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    _place_asset(media_factory, tmp_project_dir, "clip.mp4", seconds=1.0, with_audio=False)
    job = export_video(_video_project(), base_dir=tmp_project_dir, job_id="job-1")

    assert job.id == "job-1"
    assert job.state == RenderState.COMPLETED, job.error
    assert job.progress == 1.0
    assert job.output_path is not None and Path(job.output_path).is_file()
    assert job.validation is not None and job.validation.ok


@pytest.mark.usefixtures("require_ffprobe")
def test_render_respects_explicit_output_path(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    _place_asset(media_factory, tmp_project_dir, "clip.mp4", seconds=1.0, with_audio=False)
    job = render(
        _video_project(),
        RenderOptions(output_path="out/final.mp4"),
        base_dir=tmp_project_dir,
    )
    assert job.state == RenderState.COMPLETED, job.error
    assert job.output_path == str(tmp_project_dir / "out" / "final.mp4")


@pytest.mark.usefixtures("require_ffprobe")
def test_preview_is_downscaled(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    _place_asset(media_factory, tmp_project_dir, "clip.mp4", seconds=1.0, with_audio=False)
    job = render_preview(_video_project(), base_dir=tmp_project_dir)
    assert job.state == RenderState.COMPLETED, job.error
    # Preview halves the Reels frame (1080x1920 → 540x960).
    from framepilot_engine.media.probe import inspect_media

    assert job.output_path is not None
    info = inspect_media(Path(job.output_path))
    assert info.width == 540 and info.height == 960


@pytest.mark.usefixtures("require_ffprobe")
def test_render_output_frame_matches_source_color(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """Golden-media check (frame content within tolerance, plan 2.3).

    Renders a known solid-red source and asserts a sampled output frame is red.
    A color-with-tolerance assertion is used instead of an exact frame hash so
    the test is robust to ffmpeg/codec version differences across machines while
    still proving the compile→encode pipeline preserves pixels deterministically.
    """
    import numpy as np
    from moviepy import VideoFileClip

    _place_asset(
        media_factory, tmp_project_dir, "clip.mp4", seconds=1.0, with_audio=False, color="red"
    )
    job = export_video(_video_project(), base_dir=tmp_project_dir)
    assert job.state == RenderState.COMPLETED, job.error

    assert job.output_path is not None
    with VideoFileClip(job.output_path) as clip:
        frame = np.asarray(clip.get_frame(0.5), dtype=float)  # (H, W, 3) RGB
    # Sample the frame centre, where the letterbox-fit clip sits (the edges are
    # intentionally black bars from fitting a 4:3 source into a 9:16 frame).
    height, width, _ = frame.shape
    center = frame[height // 2, width // 2]
    assert center[0] > 180  # red channel dominant
    assert center[1] < 80 and center[2] < 80  # green/blue near zero


@pytest.mark.usefixtures("require_ffprobe")
def test_render_fails_validation_on_black_output(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    _place_asset(
        media_factory, tmp_project_dir, "clip.mp4", seconds=1.0, with_audio=False, color="black"
    )
    job = export_video(_video_project(), base_dir=tmp_project_dir)

    assert job.state == RenderState.FAILED
    assert job.validation is not None and not job.validation.ok
    assert job.error is not None and "black_frames" in job.error


# --- master-bus audio pass (plan Phase 6 sound) ------------------------------


def test_render_options_audio_defaults() -> None:
    opts = RenderOptions()
    assert opts.denoise is False and opts.loudness is None and opts.limiter is False
    assert opts.eq is None and opts.compression is None


def test_master_audio_pass_threads_eq_and_compression(tmp_path: Path, monkeypatch: Any) -> None:
    seen: dict[str, Any] = {}

    def fake_apply(src: Path, dst: Path, filter_str: str, **kwargs: Any) -> None:
        seen["filter"] = filter_str
        dst.write_bytes(b"filtered")

    monkeypatch.setattr("framepilot_engine.render.pipeline.apply_master_audio", fake_apply)
    output = tmp_path / "out.mp4"
    output.write_bytes(b"original")
    _apply_master_audio_pass(
        output, REELS, RenderOptions(eq="voice-clarity", compression="voice")
    )
    assert "equalizer" in seen["filter"] and "acompressor" in seen["filter"]
    assert output.read_bytes() == b"filtered"


def test_master_audio_pass_noop_without_options(tmp_path: Path, monkeypatch: Any) -> None:
    called = False

    def spy(*args: Any, **kwargs: Any) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr("framepilot_engine.render.pipeline.apply_master_audio", spy)
    output = tmp_path / "out.mp4"
    output.write_bytes(b"original")
    _apply_master_audio_pass(output, REELS, RenderOptions())
    assert called is False
    assert output.read_bytes() == b"original"  # untouched


def test_master_audio_pass_filters_and_replaces(tmp_path: Path, monkeypatch: Any) -> None:
    seen: dict[str, Any] = {}

    def fake_apply(src: Path, dst: Path, filter_str: str, **kwargs: Any) -> None:
        seen["filter"] = filter_str
        dst.write_bytes(b"filtered")  # simulate ffmpeg producing the temp output

    monkeypatch.setattr("framepilot_engine.render.pipeline.apply_master_audio", fake_apply)
    output = tmp_path / "out.mp4"
    output.write_bytes(b"original")
    _apply_master_audio_pass(output, REELS, RenderOptions(loudness="social", denoise=True))
    assert "loudnorm" in seen["filter"] and "afftdn" in seen["filter"]
    assert output.read_bytes() == b"filtered"  # temp atomically replaced the output
