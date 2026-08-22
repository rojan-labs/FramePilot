"""Tests for the timeline → MoviePy compiler (plan 2.2)."""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render.compiler import (
    CompileError,
    _audio_gain_factor,
    _caption_position,
    _open_source_reader,
    _subclipped_source,
    clip_kind,
    compile_timeline,
    expected_render,
    has_audio_content,
    has_video_content,
    timeline_duration,
    unsupported_animated_properties,
    unsupported_track_types,
)
from framepilot_engine.render.presets import REELS
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import CaptionStyle, Clip, Effect, Project


def test_caption_free_position_respects_safe_area() -> None:
    style = CaptionStyle.model_validate({"xPercent": 2, "yPercent": 98, "safeArea": True})
    # The centre clamps to 10%/90%, then the box itself remains inside frame.
    assert _caption_position(style, 1000, 1000, 100, 80, 50) == (50, 860)


def test_caption_free_position_can_use_the_full_frame() -> None:
    style = CaptionStyle.model_validate({"xPercent": 5, "yPercent": 95, "safeArea": False})
    assert _caption_position(style, 1000, 1000, 100, 100, 50) == (0, 900)


def _project(tracks: list[dict[str, Any]], assets: list[dict[str, Any]] | None = None) -> Project:
    return Project.model_validate(
        {
            "id": "p1",
            "name": "T",
            "fps": 30,
            "assets": assets or [],
            "timeline": {"tracks": tracks},
        }
    )


def _clip(
    clip_id: str,
    track_id: str,
    start: float,
    end: float,
    asset: str = "a1",
    speed: float | None = None,
    source_end: float | None = None,
    crop: dict[str, float] | None = None,
    blend_mode: str | None = None,
) -> dict[str, Any]:
    clip: dict[str, Any] = {
        "id": clip_id,
        "assetId": asset,
        "trackId": track_id,
        "start": start,
        "end": end,
        "sourceStart": 0.0,
        "sourceEnd": source_end if source_end is not None else end - start,
    }
    if speed is not None:
        clip["speed"] = speed
    if crop is not None:
        clip["crop"] = crop
    if blend_mode is not None:
        clip["blendMode"] = blend_mode
    return clip


# --- pure helpers ------------------------------------------------------------


class _FakeSource:
    """Stand-in for a loaded MoviePy clip that records the subclip window and
    mimics its ``end_time <= duration`` guard."""

    def __init__(self, duration: float) -> None:
        self.duration = duration
        self.calls: list[tuple[float, float | None]] = []

    def subclipped(self, start: float, end: float | None) -> _FakeSource:
        if end is not None and end > self.duration:
            raise ValueError(
                f"end_time ({end:.02f}) should be smaller or equal to the clip's "
                f"duration ({self.duration:.02f})."
            )
        self.calls.append((start, end))
        return self


def _clip_model(source_start: float, source_end: float) -> Clip:
    return Clip.model_validate(
        {
            "id": "c1",
            "assetId": "a1",
            "trackId": "v",
            "start": 0.0,
            "end": source_end - source_start,
            "sourceStart": source_start,
            "sourceEnd": source_end,
        }
    )


def test_subclipped_source_clamps_out_point_past_decoded_duration() -> None:
    # source_end (16.93) marginally exceeds the decoded duration (16.9299) — a
    # container-vs-frame-accurate mismatch that must not abort the render.
    source = _FakeSource(duration=16.9299)
    result = _subclipped_source(source, _clip_model(0.0, 16.93))
    assert result is source
    # Out-point collapses to None ("to the end") rather than the overflowing value.
    assert source.calls == [(0.0, None)]


def test_subclipped_source_keeps_a_genuinely_shorter_window() -> None:
    source = _FakeSource(duration=20.0)
    _subclipped_source(source, _clip_model(2.0, 8.0))
    assert source.calls == [(2.0, 8.0)]


def test_timeline_duration_empty_is_zero() -> None:
    assert timeline_duration(_project([]).timeline) == 0.0


def test_timeline_duration_is_latest_end() -> None:
    project = _project(
        [
            {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 2), _clip("c2", "v", 2, 5)]},
            {"id": "a", "type": "audio", "clips": [_clip("c3", "a", 0, 3)]},
        ]
    )
    assert timeline_duration(project.timeline) == 5.0


# Asset kinds drive clip classification now (Phase 2, ADR 0032): a clip is video/
# audio/image by its asset's kind, text/caption by its synthetic asset id.
_MEDIA_ASSETS = [
    {"id": "vid", "path": "v.mp4", "kind": "video"},
    {"id": "aud", "path": "a.mp3", "kind": "audio"},
    {"id": "img", "path": "p.png", "kind": "image"},
]


def _kinds(project: Project) -> dict[str, str | None]:
    return {a.id: a.kind for a in project.assets}


@pytest.mark.parametrize(
    ("asset_id", "asset_kinds", "expected"),
    [
        ("__text__", {}, "text"),
        ("__caption__", {}, "caption"),
        ("aud", {"aud": "audio"}, "audio"),
        ("img", {"img": "image"}, "image"),
        ("vid", {"vid": "video"}, "video"),
        ("unknown", {}, "video"),  # unknown assets default to video (picture)
    ],
)
def test_clip_kind_derivation(
    asset_id: str, asset_kinds: dict[str, str | None], expected: str
) -> None:
    assert clip_kind(_clip_model_for(asset_id), asset_kinds) == expected


def _clip_model_for(asset_id: str) -> Clip:
    return Clip.model_validate(
        {
            "id": "c1",
            "assetId": asset_id,
            "trackId": "t",
            "start": 0.0,
            "end": 1.0,
            "sourceStart": 0.0,
            "sourceEnd": 1.0,
        }
    )


def test_content_flags() -> None:
    project = _project(
        [
            {"id": "L1", "type": "video", "clips": [_clip("c1", "L1", 0, 2, "vid")]},
            {"id": "L2", "type": "audio", "clips": []},
        ],
        assets=_MEDIA_ASSETS,
    )
    kinds = _kinds(project)
    assert has_video_content(project.timeline, kinds)
    assert not has_audio_content(project.timeline, kinds)


def test_content_flags_route_by_clip_kind_not_layer_type() -> None:
    # An audio clip counts as audio content even on a layer whose advisory type is
    # 'video', and an image counts as a picture — classification is by clip kind.
    project = _project(
        [
            {"id": "L1", "type": "video", "clips": [_clip("c1", "L1", 0, 2, "aud")]},
            {"id": "L2", "type": "video", "clips": [_clip("c2", "L2", 0, 2, "img")]},
        ],
        assets=_MEDIA_ASSETS,
    )
    kinds = _kinds(project)
    assert has_audio_content(project.timeline, kinds)  # audio clip on a 'video' layer
    assert has_video_content(project.timeline, kinds)  # image counts as a picture


def test_content_flags_respect_hidden_and_muted() -> None:
    # A hidden picture layer and a muted audio layer contribute no stream.
    project = _project(
        [
            {
                "id": "L1",
                "type": "video",
                "clips": [_clip("c1", "L1", 0, 2, "vid")],
                "hidden": True,
            },
            {
                "id": "L2",
                "type": "audio",
                "clips": [_clip("c2", "L2", 0, 2, "aud")],
                "muted": True,
            },
        ],
        assets=_MEDIA_ASSETS,
    )
    kinds = _kinds(project)
    assert not has_video_content(project.timeline, kinds)
    assert not has_audio_content(project.timeline, kinds)
    # Without the flags the same content does count.
    visible = _project(
        [
            {"id": "L1", "type": "video", "clips": [_clip("c1", "L1", 0, 2, "vid")]},
            {"id": "L2", "type": "audio", "clips": [_clip("c2", "L2", 0, 2, "aud")]},
        ],
        assets=_MEDIA_ASSETS,
    )
    vkinds = _kinds(visible)
    assert has_video_content(visible.timeline, vkinds)
    assert has_audio_content(visible.timeline, vkinds)


def test_unsupported_track_types_lists_nonempty_deferred() -> None:
    # Caption clips carry the synthetic '__caption__' id; a video clip renders.
    project = _project(
        [
            {"id": "L1", "type": "video", "clips": [_clip("c1", "L1", 0, 2, "vid")]},
            {"id": "L2", "type": "caption", "clips": [_clip("c2", "L2", 0, 2, "__caption__")]},
            {"id": "L3", "type": "overlay", "clips": []},  # empty → not reported
        ],
        assets=_MEDIA_ASSETS,
    )
    assert unsupported_track_types(project.timeline, _kinds(project)) == ["caption"]


def test_unsupported_track_types_excludes_captions_when_burning() -> None:
    project = _project(
        [
            {"id": "L1", "type": "video", "clips": [_clip("c1", "L1", 0, 2, "vid")]},
            {"id": "L2", "type": "caption", "clips": [_clip("c2", "L2", 0, 2, "__caption__")]},
            {"id": "L3", "type": "overlay", "clips": [_clip("c3", "L3", 0, 2, "__text__")]},
        ],
        assets=_MEDIA_ASSETS,
    )
    kinds = _kinds(project)
    # Text overlays render unconditionally; only the caption stays deferred unless burned.
    assert unsupported_track_types(project.timeline, kinds, burn_captions=True) == []
    assert unsupported_track_types(project.timeline, kinds, burn_captions=False) == ["caption"]


def test_unsupported_animated_properties_empty_now_opacity_renders() -> None:
    clip = _clip("c1", "v", 0, 2)
    clip["keyframes"] = [
        {"id": "k1", "time": 0.0, "property": "scale", "value": 1.0, "easing": "linear"},
        {"id": "k2", "time": 2.0, "property": "opacity", "value": 0.0, "easing": "linear"},
    ]
    project = _project([{"id": "v", "type": "video", "clips": [clip]}])
    # As of Phase 6 both scale and opacity render, so nothing is deferred.
    assert unsupported_animated_properties(project.timeline) == []


def test_unsupported_animated_properties_empty_without_keyframes() -> None:
    project = _project([{"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 2)]}])
    assert unsupported_animated_properties(project.timeline) == []


def test_expected_render_derives_streams_and_duration() -> None:
    project = _project(
        [
            {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 4, "vid")]},
            {"id": "a", "type": "audio", "clips": [_clip("c2", "a", 0, 4, "aud")]},
        ],
        assets=_MEDIA_ASSETS,
    )
    expected = expected_render(project, REELS)
    assert expected.duration_seconds == 4.0
    assert expected.expect_video and expected.expect_audio


# --- compile error paths (no real media needed) ------------------------------


def test_compile_unknown_asset_raises(tmp_project_dir: Path) -> None:
    project = _project([{"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 2)]}])
    index = index_assets([], tmp_project_dir)  # no assets indexed
    with pytest.raises(CompileError, match="unknown asset"):
        compile_timeline(project, index, REELS)


def test_compile_unusable_asset_raises(tmp_project_dir: Path) -> None:
    project = _project(
        [{"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 2)]}],
        assets=[{"id": "a1", "path": "missing.mp4"}],
    )
    index = index_assets([{"id": "a1", "path": "missing.mp4"}], tmp_project_dir)
    with pytest.raises(CompileError, match="unusable"):
        compile_timeline(project, index, REELS)


def test_compile_no_video_raises(tmp_project_dir: Path) -> None:
    project = _project([{"id": "a", "type": "audio", "clips": []}])
    index = index_assets([], tmp_project_dir)
    with pytest.raises(CompileError, match="no renderable video"):
        compile_timeline(project, index, REELS)


# --- real composition --------------------------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_audio_only_timeline_uses_black_canvas(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("tone.wav", seconds=1.0, with_video=False)
    (tmp_project_dir / "tone.wav").write_bytes(src.read_bytes())
    project = _project(
        [{"id": "a", "type": "audio", "clips": [_clip("c1", "a", 0, 1)]}],
        assets=[{"id": "a1", "path": "tone.wav", "kind": "audio"}],
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    composite = compile_timeline(project, index, REELS)
    try:
        assert tuple(composite.size) == (REELS.width, REELS.height)
        assert composite.duration == pytest.approx(1.0, abs=0.1)
        assert composite.audio is not None
        assert np.max(composite.get_frame(0.5)) == 0
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_real_video_sizes_to_preset(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False, size="640x480")
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project = _project(
        [{"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 1)]}],
        assets=[{"id": "a1", "path": "clip.mp4", "kind": "video"}],
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    composite = compile_timeline(project, index, REELS)
    try:
        assert tuple(composite.size) == (REELS.width, REELS.height)
        assert composite.duration == pytest.approx(1.0, abs=0.1)
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_no_speed_is_unchanged_duration(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """Regression guard: an unset ``speed`` renders exactly like before schema v6."""
    src = media_factory("clip.mp4", seconds=2.0, with_audio=True)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project = _project(
        [{"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 2)]}],
        assets=[{"id": "a1", "path": "clip.mp4", "kind": "video"}],
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    composite = compile_timeline(project, index, REELS)
    try:
        assert composite.duration == pytest.approx(2.0, abs=0.1)
        assert composite.audio is not None
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_2x_speed_time_compresses_the_clip(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A 2x-speed clip consumes 2s of source but renders into a 1s timeline span."""
    src = media_factory("clip.mp4", seconds=2.0, with_audio=True)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project = _project(
        [
            {
                "id": "v",
                "type": "video",
                "clips": [_clip("c1", "v", 0, 1, source_end=2.0, speed=2.0)],
            }
        ],
        assets=[{"id": "a1", "path": "clip.mp4", "kind": "video"}],
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    composite = compile_timeline(project, index, REELS)
    try:
        # 2s of source at 2x plays back in 1s — the derived timeline span.
        assert composite.duration == pytest.approx(1.0, abs=0.1)
        assert composite.audio is not None
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_half_speed_time_stretches_the_clip(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A 0.5x (slow-mo) clip consumes 1s of source but renders into a 2s span."""
    src = media_factory("clip.mp4", seconds=1.0, with_audio=True)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project = _project(
        [
            {
                "id": "v",
                "type": "video",
                "clips": [_clip("c1", "v", 0, 2, source_end=1.0, speed=0.5)],
            }
        ],
        assets=[{"id": "a1", "path": "clip.mp4", "kind": "video"}],
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    composite = compile_timeline(project, index, REELS)
    try:
        # 1s of source at 0.5x plays back in 2s — the derived timeline span.
        assert composite.duration == pytest.approx(2.0, abs=0.1)
        assert composite.audio is not None
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_standalone_audio_clip_respects_speed(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """An audio-only (kind ``audio``) clip is also time-remapped by ``speed``."""
    video_src = media_factory("v.mp4", seconds=1.0, with_audio=False)
    audio_src = media_factory("a.m4a", seconds=2.0, with_video=False)
    (tmp_project_dir / "v.mp4").write_bytes(video_src.read_bytes())
    (tmp_project_dir / "a.m4a").write_bytes(audio_src.read_bytes())

    project = _project(
        [
            {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 1, asset="a1")]},
            {
                "id": "a",
                "type": "audio",
                "clips": [_clip("c2", "a", 0, 1, asset="a2", source_end=2.0, speed=2.0)],
            },
        ],
        assets=[
            {"id": "a1", "path": "v.mp4", "kind": "video"},
            {"id": "a2", "path": "a.m4a", "kind": "audio"},
        ],
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    composite = compile_timeline(project, index, REELS)
    try:
        assert composite.audio is not None
        # The audio track's 2s clip at 2x fits into its 1s timeline span without
        # raising CompileError (the invariant-enforcement guard in _apply_speed).
        assert composite.duration == pytest.approx(1.0, abs=0.1)
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_speed_duration_mismatch_raises_compile_error(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A ``speed`` that doesn't line up with the timeline span fails loudly.

    The TS Zod schema enforces ``end - start == (sourceEnd - sourceStart) / speed``
    when a patch is authored, but Pydantic does not re-check that invariant on
    load (see ``Clip.speed``'s docstring) — so this constructs an inconsistent
    clip directly to exercise the defensive render-time guard in ``_apply_speed``.
    """
    src = media_factory("clip.mp4", seconds=2.0, with_audio=False)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    # 2s of source at 2x should render into 1s, but `end` here claims 1.9s.
    bad_clip = _clip("c1", "v", 0, 1.9, source_end=2.0, speed=2.0)
    project = _project(
        [{"id": "v", "type": "video", "clips": [bad_clip]}],
        assets=[{"id": "a1", "path": "clip.mp4", "kind": "video"}],
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    with pytest.raises(CompileError, match="speed"):
        compile_timeline(project, index, REELS)


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_video_audio_and_deferred_caption(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    # Video asset (a1) + audio-only asset (a2); a caption track is deferred.
    video_src = media_factory("v.mp4", seconds=1.0, with_audio=False)
    audio_src = media_factory("a.m4a", seconds=1.0, with_video=False)
    (tmp_project_dir / "v.mp4").write_bytes(video_src.read_bytes())
    (tmp_project_dir / "a.m4a").write_bytes(audio_src.read_bytes())

    project = _project(
        [
            {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 1, asset="a1")]},
            {"id": "a", "type": "audio", "clips": [_clip("c2", "a", 0, 1, asset="a2")]},
            # Caption track is valid but deferred to Phase 3.3 → skipped, not rendered.
            {
                "id": "cap",
                "type": "caption",
                "clips": [_clip("c3", "cap", 0, 1, asset="__caption__")],
            },
        ],
        assets=[
            {"id": "a1", "path": "v.mp4", "kind": "video"},
            {"id": "a2", "path": "a.m4a", "kind": "audio"},
        ],
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    composite = compile_timeline(project, index, REELS)
    try:
        assert composite.audio is not None  # audio track was composited in
        assert tuple(composite.size) == (REELS.width, REELS.height)
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_burns_captions_with_text_and_skips_empty(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("v.mp4", seconds=2.0, with_audio=False)
    (tmp_project_dir / "v.mp4").write_bytes(src.read_bytes())

    project = Project.model_validate(
        {
            "id": "p1",
            "name": "T",
            "fps": 30,
            "assets": [{"id": "a1", "path": "v.mp4", "kind": "video"}],
            "transcript": [{"word": "hi", "start": 0.0, "end": 0.5}],
            "timeline": {
                "tracks": [
                    {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 2, asset="a1")]},
                    {
                        "id": "cap",
                        "type": "caption",
                        "clips": [
                            # First clip overlaps the transcript → rendered.
                            _clip("cap1", "cap", 0.0, 0.6, asset="__caption__"),
                            # Second clip has no spoken word → skipped (no overlay).
                            _clip("cap2", "cap", 1.0, 1.6, asset="__caption__"),
                        ],
                    },
                ]
            },
        }
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    soft = compile_timeline(project, index, REELS, burn_captions=False)
    burned = compile_timeline(project, index, REELS, burn_captions=True)
    try:
        # Exactly one caption overlay was added (the empty caption was skipped).
        assert len(burned.clips) == len(soft.clips) + 1
    finally:
        soft.close()
        burned.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_burns_styled_caption_with_word_highlight(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A ``captionStyle`` with an active highlight animation compiles fine and
    samples to different pixels at different frame times (Phase v5 wiring)."""
    src = media_factory("v.mp4", seconds=2.0, with_audio=False)
    (tmp_project_dir / "v.mp4").write_bytes(src.read_bytes())

    project = Project.model_validate(
        {
            "id": "p1",
            "name": "T",
            "fps": 30,
            "assets": [{"id": "a1", "path": "v.mp4", "kind": "video"}],
            "transcript": [
                {"word": "one", "start": 0.0, "end": 0.5},
                {"word": "two", "start": 0.5, "end": 1.0},
            ],
            "timeline": {
                "tracks": [
                    {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 2, asset="a1")]},
                    {
                        "id": "cap",
                        "type": "caption",
                        "clips": [
                            {
                                "id": "cap1",
                                "assetId": "__caption__",
                                "trackId": "cap",
                                "start": 0.0,
                                "end": 1.0,
                                "captionStyle": {
                                    "textColor": "#ffffff",
                                    "highlight": {
                                        "enabled": True,
                                        "color": "#ff0000",
                                        "animation": "karaoke-fill",
                                    },
                                },
                            }
                        ],
                    },
                ]
            },
        }
    )
    index = index_assets(
        [asset.model_dump(by_alias=True) for asset in project.assets], tmp_project_dir
    )

    burned = compile_timeline(project, index, REELS, burn_captions=True)
    try:
        assert tuple(burned.size) == (REELS.width, REELS.height)
        frame_early = burned.get_frame(0.1)
        frame_late = burned.get_frame(0.7)
        # Two different words are highlighted at these two sampled times, so the
        # rendered composite differs — proves the per-frame animation is wired
        # into the actual MoviePy composite, not just the pure renderer.
        assert not np.array_equal(frame_early, frame_late)
    finally:
        burned.close()


# --- Phase 5: animated transform + audio gain --------------------------------


def _index(project: Project, root: Path) -> Any:
    return index_assets([a.model_dump(by_alias=True) for a in project.assets], root)


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_punch_in_scale(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A scale ramp (punch-in) zooms the clip so it fills more of the frame.

    A 640x480 red source letterboxes into the 9:16 frame with black bars. Ramping
    scale 1.0 → 2.0 makes the red fill more of the frame over time, so the mean
    frame brightness rises — a deterministic check that the keyframes are applied.
    """
    src = media_factory("zoom.mp4", seconds=1.0, with_audio=False, size="640x480")
    (tmp_project_dir / "zoom.mp4").write_bytes(src.read_bytes())

    clip = _clip("c1", "v", 0, 1, asset="a1")
    clip["keyframes"] = [
        {"id": "k0", "time": 0.0, "property": "scale", "value": 1.0, "easing": "linear"},
        {"id": "k1", "time": 1.0, "property": "scale", "value": 2.0, "easing": "linear"},
    ]
    project = _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": "zoom.mp4", "kind": "video"}],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        assert tuple(composite.size) == (REELS.width, REELS.height)
        start_mean = float(np.asarray(composite.get_frame(0.05)).mean())
        end_mean = float(np.asarray(composite.get_frame(0.95)).mean())
        assert end_mean > start_mean + 5.0, f"no zoom (start={start_mean}, end={end_mean})"
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_rotation(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A clip with rotation keyframes renders at the preset size (exercises the
    time-varying rotation path)."""
    src = media_factory("rot.mp4", seconds=1.0, with_audio=False, size="640x480")
    (tmp_project_dir / "rot.mp4").write_bytes(src.read_bytes())

    clip = _clip("c1", "v", 0, 1, asset="a1")
    clip["keyframes"] = [
        {"id": "r0", "time": 0.0, "property": "rotation", "value": 0.0, "easing": "linear"},
        {"id": "r1", "time": 1.0, "property": "rotation", "value": 90.0, "easing": "linear"},
    ]
    project = _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": "rot.mp4", "kind": "video"}],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        assert tuple(composite.size) == (REELS.width, REELS.height)
        # Both ends rasterize without error (the rotated lambda runs per frame).
        assert composite.get_frame(0.05).shape[2] == 3
        assert composite.get_frame(0.95).shape[2] == 3
    finally:
        composite.close()


def _split_color_media(path: Path, *, left: str, right: str, size: str = "320x240") -> None:
    """Write a video whose left half is ``left`` and right half is ``right``.

    Mirrors the direct-ffmpeg pattern already used in
    ``test_render_golden.py`` (bypassing ``media_factory``, which only makes
    solid-color frames) — a spatial split is the simplest deterministic way to
    prove a crop shows only the requested sub-region rather than the whole
    frame.
    """
    from framepilot_engine.media.ffmpeg import find_ffmpeg

    width, height = (int(part) for part in size.split("x"))
    half = width // 2
    filter_complex = (
        f"color=c={left}:s={half}x{height}[l];"
        f"color=c={right}:s={half}x{height}[r];"
        "[l][r]hstack=inputs=2[out]"
    )
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s={size}:d=1",
            "-filter_complex",
            filter_complex,
            "-map",
            "[out]",
            "-frames:v",
            "30",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_crop_shows_only_cropped_region(tmp_project_dir: Path) -> None:
    """A crop rect over the right half of a split-color source renders only that
    half — the left color never appears in the composited frame."""
    _split_color_media(tmp_project_dir / "split.mp4", left="red", right="blue")

    clip = _clip(
        "c1", "v", 0, 1, asset="a1", crop={"x": 0.5, "y": 0.0, "width": 0.5, "height": 1.0}
    )
    project = _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": "split.mp4", "kind": "video"}],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        frame = np.asarray(composite.get_frame(0.5))
        # Sample across the visible (non-letterbox-bar) width; every sampled
        # column should be blue-dominant (the right half), never red.
        h, w, _ = frame.shape
        row = frame[h // 2]
        visible_columns = [c for c in range(0, w, max(1, w // 20)) if row[c].sum() > 20]
        assert visible_columns, "expected at least one non-black sampled column"
        for col in visible_columns:
            pixel = row[col]
            assert int(pixel[2]) > int(pixel[0]) + 20, (
                f"column {col} should be blue-dominant (cropped to the right half), got {pixel}"
            )
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_crop_composes_with_transform_keyframe(tmp_project_dir: Path) -> None:
    """Crop combines cleanly with an existing scale keyframe (punch-in): the
    cropped-then-scaled frame renders without error and still only shows the
    cropped (blue) half, proving crop is applied before the transform, not
    dropped or overridden by it."""
    _split_color_media(tmp_project_dir / "split-zoom.mp4", left="red", right="blue")

    clip = _clip(
        "c1", "v", 0, 1, asset="a1", crop={"x": 0.5, "y": 0.0, "width": 0.5, "height": 1.0}
    )
    clip["keyframes"] = [
        {"id": "k0", "time": 0.0, "property": "scale", "value": 1.0, "easing": "linear"},
        {"id": "k1", "time": 1.0, "property": "scale", "value": 1.5, "easing": "linear"},
    ]
    project = _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": "split-zoom.mp4", "kind": "video"}],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        assert tuple(composite.size) == (REELS.width, REELS.height)
        for t in (0.05, 0.95):
            frame = np.asarray(composite.get_frame(t))
            h, w, _ = frame.shape
            centre = frame[h // 2, w // 2]
            assert int(centre[2]) > int(centre[0]), (
                f"t={t}: crop+scale should still show the cropped (blue) half, got {centre}"
            )
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_uncropped_clip_is_unchanged(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """Regression guard: a clip with no ``crop`` renders byte-identical to a
    second, otherwise-identical project — proving ``_apply_crop`` is a true
    no-op when ``crop`` is unset (today's pre-v7 behavior untouched)."""
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False, color="red", size="320x240")
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())

    def _render() -> np.ndarray:
        project = _project(
            [{"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 1, asset="a1")]}],
            assets=[{"id": "a1", "path": "clip.mp4", "kind": "video"}],
        )
        composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
        try:
            return np.asarray(composite.get_frame(0.5)).copy()
        finally:
            composite.close()

    first = _render()
    second = _render()
    assert np.array_equal(first, second), "uncropped render must be deterministic/unchanged"


def _kf_clip(*effects: Effect) -> Clip:
    return Clip(
        id="c",
        asset_id="a",
        track_id="a",
        start=0.0,
        end=1.0,
        source_start=0.0,
        source_end=1.0,
        effects=list(effects),
    )


def test_audio_gain_factor_from_effect() -> None:
    # 0 dB -> 1.0; -20 dB -> 0.1x; no effect -> 1.0 (pure, no MoviePy).
    assert _audio_gain_factor(_kf_clip()) == 1.0
    zero = Effect(id="g0", type="audio_gain", params={"gainDb": 0.0})
    assert _audio_gain_factor(_kf_clip(zero)) == pytest.approx(1.0)
    minus20 = Effect(id="g1", type="audio_gain", params={"gainDb": -20.0})
    assert _audio_gain_factor(_kf_clip(minus20)) == pytest.approx(0.1, rel=1e-3)


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_rectangle_mask(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A centred rectangle mask hides the clip outside the shape (renders black)."""
    src = media_factory("m.mp4", seconds=1.0, with_audio=False, color="red", size="320x240")
    (tmp_project_dir / "m.mp4").write_bytes(src.read_bytes())

    clip = _clip("c1", "v", 0, 1, asset="a1")
    clip["effects"] = [
        {
            "id": "c1__mask",
            "type": "mask",
            "params": {
                "shape": "rectangle",
                "bounds": {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5},
            },
            "keyframes": [],
        }
    ]
    project = _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": "m.mp4", "kind": "video"}],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        frame = np.asarray(composite.get_frame(0.5))
        h, w, _ = frame.shape
        centre = frame[h // 2, w // 2]
        edge = frame[h // 2, 20]  # inside the red letterbox horizontally, outside the mask
        assert int(centre.sum()) > 100, f"masked centre should show content, got {centre}"
        assert int(edge.sum()) < 40, f"outside the mask should be hidden, got {edge}"
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_animated_mask(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A mask with keyframes renders as a time-varying mask without error."""
    src = media_factory("am.mp4", seconds=1.0, with_audio=False, color="red", size="320x240")
    (tmp_project_dir / "am.mp4").write_bytes(src.read_bytes())

    clip = _clip("c1", "v", 0, 1, asset="a1")
    clip["effects"] = [
        {
            "id": "c1__mask",
            "type": "mask",
            "params": {
                "shape": "ellipse",
                "bounds": {"x": 0.0, "y": 0.25, "width": 0.5, "height": 0.5},
            },
            "keyframes": [
                {"id": "x0", "time": 0.0, "property": "x", "value": 0.0, "easing": "linear"},
                {"id": "x1", "time": 1.0, "property": "x", "value": 0.5, "easing": "linear"},
            ],
        }
    ]
    project = _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": "am.mp4", "kind": "video"}],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        assert tuple(composite.size) == (REELS.width, REELS.height)
        assert composite.get_frame(0.1).shape[2] == 3
        assert composite.get_frame(0.9).shape[2] == 3
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_color_grade(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A B&W color grade desaturates the render: a colored source becomes gray.

    A red source letterboxes into the frame; with ``saturation: -1`` the red box
    renders as gray, so its three channels equalize. Comparing the channel spread
    at the frame centre (inside the content) against the ungraded render is a
    deterministic check that the grade reaches the pixels.
    """
    src = media_factory("grade.mp4", seconds=1.0, with_audio=False, color="red", size="320x240")
    (tmp_project_dir / "grade.mp4").write_bytes(src.read_bytes())

    def project_with_grade(graded: bool) -> Project:
        clip = _clip("c1", "v", 0, 1, asset="a1")
        if graded:
            clip["effects"] = [
                {
                    "id": "c1__grade",
                    "type": "color_grade",
                    "params": {"saturation": -1.0},
                    "keyframes": [],
                }
            ]
        return _project(
            [{"id": "v", "type": "video", "clips": [clip]}],
            assets=[{"id": "a1", "path": "grade.mp4", "kind": "video"}],
        )

    plain = project_with_grade(False)
    graded = project_with_grade(True)
    plain_comp = compile_timeline(plain, _index(plain, tmp_project_dir), REELS)
    graded_comp = compile_timeline(graded, _index(graded, tmp_project_dir), REELS)
    try:
        h, w, _ = np.asarray(plain_comp.get_frame(0.5)).shape
        plain_centre = np.asarray(plain_comp.get_frame(0.5))[h // 2, w // 2].astype(int)
        graded_centre = np.asarray(graded_comp.get_frame(0.5))[h // 2, w // 2].astype(int)
        # Plain red has a wide channel spread; the B&W grade collapses it.
        assert int(plain_centre.max() - plain_centre.min()) > 60
        assert int(graded_centre.max() - graded_centre.min()) <= 2
    finally:
        plain_comp.close()
        graded_comp.close()


# A minimal 2x2x2 .cube LUT that inverts every channel (out = 1 - in). Red
# varies fastest per the .cube spec (see `parse_cube_lut`'s docstring).
_INVERT_CUBE = """
TITLE "invert"
LUT_3D_SIZE 2
1.0 1.0 1.0
0.0 1.0 1.0
1.0 0.0 1.0
0.0 0.0 1.0
1.0 1.0 0.0
0.0 1.0 0.0
1.0 0.0 0.0
0.0 0.0 0.0
"""


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_lut_from_sandboxed_cube_file(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A ``lut`` effect actually reaches the rendered pixels.

    Regression: an ``apply_color_grade`` patch with ``type: "lut"`` validated and
    applied to the timeline, but the compiler never loaded or applied the LUT
    file — an honesty-gap bug (an edit that "applies" but silently doesn't
    render). A pure-red source run through an inverting LUT should render as
    cyan (red channel low, green/blue channels high); comparing against the
    ungraded render is a deterministic proof the ``.cube`` file was loaded and
    actually applied to the frames, not just parsed.
    """
    src = media_factory("lut.mp4", seconds=1.0, with_audio=False, color="red", size="320x240")
    (tmp_project_dir / "lut.mp4").write_bytes(src.read_bytes())
    (tmp_project_dir / "invert.cube").write_text(_INVERT_CUBE)

    def project_with_lut(graded: bool) -> Project:
        clip = _clip("c1", "v", 0, 1, asset="a1")
        if graded:
            clip["effects"] = [
                {
                    "id": "c1__lut",
                    "type": "lut",
                    "params": {"path": "invert.cube"},
                    "keyframes": [],
                }
            ]
        return _project(
            [{"id": "v", "type": "video", "clips": [clip]}],
            assets=[{"id": "a1", "path": "lut.mp4", "kind": "video"}],
        )

    plain = project_with_lut(False)
    graded = project_with_lut(True)
    plain_comp = compile_timeline(plain, _index(plain, tmp_project_dir), REELS)
    graded_comp = compile_timeline(graded, _index(graded, tmp_project_dir), REELS)
    try:
        h, w, _ = np.asarray(plain_comp.get_frame(0.5)).shape
        plain_centre = np.asarray(plain_comp.get_frame(0.5))[h // 2, w // 2].astype(int)
        lut_centre = np.asarray(graded_comp.get_frame(0.5))[h // 2, w // 2].astype(int)
        # Plain red: high R, low G/B.
        assert plain_centre[0] > 150 and plain_centre[1] < 60 and plain_centre[2] < 60
        # Inverted: low R, high G/B (cyan) — the LUT was actually applied.
        assert lut_centre[0] < 60 and lut_centre[1] > 150 and lut_centre[2] > 150
    finally:
        plain_comp.close()
        graded_comp.close()


def _lut_error_project(clip_effects: list[dict[str, Any]]) -> Project:
    clip = _clip("c1", "v", 0, 1, asset="a1")
    clip["effects"] = clip_effects
    return _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": "lut_src.mp4", "kind": "video"}],
    )


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_lut_missing_path_param_raises(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("lut_src.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "lut_src.mp4").write_bytes(src.read_bytes())
    project = _lut_error_project([{"id": "c1__lut", "type": "lut", "params": {}, "keyframes": []}])
    index = _index(project, tmp_project_dir)
    with pytest.raises(CompileError, match="missing a string 'path'"):
        compile_timeline(project, index, REELS)


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_lut_path_escaping_sandbox_raises(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("lut_src.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "lut_src.mp4").write_bytes(src.read_bytes())
    project = _lut_error_project(
        [{"id": "c1__lut", "type": "lut", "params": {"path": "../outside.cube"}, "keyframes": []}]
    )
    index = _index(project, tmp_project_dir)
    with pytest.raises(CompileError, match="escapes the project sandbox"):
        compile_timeline(project, index, REELS)


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_lut_missing_file_raises(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("lut_src.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "lut_src.mp4").write_bytes(src.read_bytes())
    project = _lut_error_project(
        [{"id": "c1__lut", "type": "lut", "params": {"path": "nope.cube"}, "keyframes": []}]
    )
    index = _index(project, tmp_project_dir)
    with pytest.raises(CompileError, match="'lut' file not found"):
        compile_timeline(project, index, REELS)


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_lut_invalid_cube_raises(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("lut_src.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "lut_src.mp4").write_bytes(src.read_bytes())
    (tmp_project_dir / "bad.cube").write_text("LUT_1D_SIZE 2\n0 0 0\n1 1 1\n")
    project = _lut_error_project(
        [{"id": "c1__lut", "type": "lut", "params": {"path": "bad.cube"}, "keyframes": []}]
    )
    index = _index(project, tmp_project_dir)
    with pytest.raises(CompileError, match=r"invalid \.cube LUT"):
        compile_timeline(project, index, REELS)


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_audio_gain(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A clip with an ``audio_gain`` effect compiles with its volume scaled.

    The gain is applied at compile time (``with_volume_scaled``); MoviePy owns the
    per-sample math, so this asserts the gained audio composites in (the behaviour
    of the factor itself is unit-tested in :func:`test_audio_gain_factor_from_effect`).
    """
    video_src = media_factory("v.mp4", seconds=1.0, with_audio=False)
    audio_src = media_factory("a.m4a", seconds=1.0, with_video=False)
    (tmp_project_dir / "v.mp4").write_bytes(video_src.read_bytes())
    (tmp_project_dir / "a.m4a").write_bytes(audio_src.read_bytes())

    audio_clip = _clip("c2", "a", 0, 1, asset="a2")
    audio_clip["effects"] = [
        {"id": "c2__gain", "type": "audio_gain", "params": {"gainDb": -20.0}, "keyframes": []}
    ]
    project = _project(
        [
            {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 1, asset="a1")]},
            {"id": "a", "type": "audio", "clips": [audio_clip]},
        ],
        assets=[
            {"id": "a1", "path": "v.mp4", "kind": "video"},
            {"id": "a2", "path": "a.m4a", "kind": "audio"},
        ],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        assert composite.audio is not None  # gained audio was composited in
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_mixes_footage_audio_with_audio_track(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A video clip's footage audio MIXES with an audio-only track, not replaced.

    Regression: the compiler used to overwrite the composited footage audio with
    ``with_audio(CompositeAudioClip(audio_layers))`` where ``audio_layers`` held
    only audio-only clips — so a music track silently dropped the footage audio.
    Both must now land on one bus (two sources).
    """
    video_src = media_factory("v.mp4", seconds=1.0, with_audio=True)
    audio_src = media_factory("a.m4a", seconds=1.0, with_video=False)
    (tmp_project_dir / "v.mp4").write_bytes(video_src.read_bytes())
    (tmp_project_dir / "a.m4a").write_bytes(audio_src.read_bytes())

    project = _project(
        [
            {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 1, asset="a1")]},
            {"id": "a", "type": "audio", "clips": [_clip("c2", "a", 0, 1, asset="a2")]},
        ],
        assets=[
            {"id": "a1", "path": "v.mp4", "kind": "video"},
            {"id": "a2", "path": "a.m4a", "kind": "audio"},
        ],
    )
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        assert composite.audio is not None
        # Footage audio (1) + the music track (1) → both on the master bus.
        assert len(composite.audio.clips) == 2
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_muted_video_track_drops_footage_audio(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A muted picture track contributes no footage audio to the master bus."""
    video_src = media_factory("v.mp4", seconds=1.0, with_audio=True)
    audio_src = media_factory("a.m4a", seconds=1.0, with_video=False)
    (tmp_project_dir / "v.mp4").write_bytes(video_src.read_bytes())
    (tmp_project_dir / "a.m4a").write_bytes(audio_src.read_bytes())

    project = _project(
        [
            {
                "id": "v",
                "type": "video",
                "muted": True,
                "clips": [_clip("c1", "v", 0, 1, asset="a1")],
            },
            {"id": "a", "type": "audio", "clips": [_clip("c2", "a", 0, 1, asset="a2")]},
        ],
        assets=[
            {"id": "a1", "path": "v.mp4", "kind": "video"},
            {"id": "a2", "path": "a.m4a", "kind": "audio"},
        ],
    )
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        assert composite.audio is not None
        # Only the audio-only track survives; the muted video's footage is dropped.
        assert len(composite.audio.clips) == 1
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_renders_opacity_keyframes(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A clip fading its opacity 1→0 over black darkens the rendered frame.

    Opacity now composites via the clip mask (Phase 6). A red clip on a black
    background at opacity ~0 near the end is much darker than at full opacity.
    """
    src = media_factory("fade.mp4", seconds=1.0, with_audio=False, color="red", size="320x240")
    (tmp_project_dir / "fade.mp4").write_bytes(src.read_bytes())

    clip = _clip("c1", "v", 0, 1, asset="a1")
    clip["keyframes"] = [
        {"id": "o0", "time": 0.0, "property": "opacity", "value": 1.0, "easing": "linear"},
        {"id": "o1", "time": 1.0, "property": "opacity", "value": 0.0, "easing": "linear"},
    ]
    project = _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": "fade.mp4", "kind": "video"}],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        start = float(np.asarray(composite.get_frame(0.05)).mean())
        end = float(np.asarray(composite.get_frame(0.95)).mean())
        assert end < start - 5.0, f"opacity fade did not darken (start={start}, end={end})"
    finally:
        composite.close()


def _transition_project(
    tmp_project_dir: Path, media_factory: Callable[..., Path], kind: str
) -> Any:
    src = media_factory(f"{kind}.mp4", seconds=1.0, with_audio=False, color="red", size="320x240")
    (tmp_project_dir / f"{kind}.mp4").write_bytes(src.read_bytes())
    clip = _clip("c1", "v", 0, 1, asset="a1")
    clip["effects"] = [
        {
            "id": "c1__transition",
            "type": "transition",
            "params": {"kind": kind, "durationSeconds": 1.0, "fromClipId": "c0"},
            "keyframes": [],
        }
    ]
    return _project(
        [{"id": "v", "type": "video", "clips": [clip]}],
        assets=[{"id": "a1", "path": f"{kind}.mp4", "kind": "video"}],
    )


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize("kind", ["fade", "push", "zoom", "slide"])
def test_compile_eases_transition_in(
    kind: str, tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """fade/push/zoom/slide ease the incoming clip in, so an early frame differs from late.

    Each changes how much red is visible early on (opacity ramp, slide from
    off-frame, zoom-out), so the mean brightness early differs from the settled
    end — a deterministic check that the transition render path runs.
    """
    project = _transition_project(tmp_project_dir, media_factory, kind)
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        early = float(np.asarray(composite.get_frame(0.05)).mean())
        late = float(np.asarray(composite.get_frame(0.95)).mean())
        assert abs(late - early) > 1.0, f"{kind} transition had no visible effect"
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_blur_transition_renders(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A blur transition composites valid RGB frames (the blur pass runs per frame).

    A solid-color clip's mean is blur-invariant, so this asserts the path executes
    and produces a well-formed frame rather than a brightness change.
    """
    project = _transition_project(tmp_project_dir, media_factory, "blur")
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        assert tuple(composite.size) == (REELS.width, REELS.height)
        assert np.asarray(composite.get_frame(0.05)).shape[2] == 3
        assert np.asarray(composite.get_frame(0.95)).shape[2] == 3
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_wipe_transition_reveals_left_first(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A wipe reveals the incoming clip left→right: mid-transition the left half
    of the frame carries more of the clip than the right half; by the end the
    frame is (near-)fully revealed and left/right match again."""
    project = _transition_project(tmp_project_dir, media_factory, "wipe")
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        mid = np.asarray(composite.get_frame(0.5)).astype(np.float64)
        half = mid.shape[1] // 2
        left, right = float(mid[:, :half].mean()), float(mid[:, half:].mean())
        assert left > right + 1.0, f"wipe not left-first (left={left}, right={right})"
        late = np.asarray(composite.get_frame(0.98)).astype(np.float64)
        l_late = float(late[:, :half].mean())
        r_late = float(late[:, half:].mean())
        assert abs(l_late - r_late) < 1.0, "wipe did not finish revealing"
    finally:
        composite.close()


def _catalog_transition_project(
    tmp_project_dir: Path,
    media_factory: Callable[..., Path],
    kind: str,
    *,
    alignment: str | None = None,
) -> Any:
    """Two adjacent clips, from VISUALLY DIFFERENT media, with a catalog transition at the cut.

    Different colours on either side is what makes a transition observable at all: with one
    asset on both sides every frame of the ramp is the same picture, so neither "the pass did
    something" nor "the ramp reveals the outgoing shot" can be told apart from a black flash.
    Each source is twice the clip it feeds, so both clips have handle material for the ramp.
    """
    red = media_factory("cat_a.mp4", seconds=2.0, with_audio=False, color="red", size="320x240")
    blue = media_factory("cat_b.mp4", seconds=2.0, with_audio=False, color="blue", size="320x240")
    (tmp_project_dir / "cat_a.mp4").write_bytes(red.read_bytes())
    (tmp_project_dir / "cat_b.mp4").write_bytes(blue.read_bytes())
    first = _clip("c0", "v", 0, 1, asset="a1")
    second = _clip("c1", "v", 1, 2, asset="a2")
    second["sourceStart"] = 0.5
    second["sourceEnd"] = 1.5
    params: dict[str, Any] = {"kind": kind, "durationSeconds": 0.5, "fromClipId": "c0"}
    if alignment is not None:
        params["alignment"] = alignment
    second["effects"] = [
        {"id": "c1__transition", "type": "transition", "params": params, "keyframes": []}
    ]
    if alignment in {"centre", "end"}:
        first["effects"] = [
            {
                "id": "c0__transition_out",
                "type": "transition_out",
                "params": {
                    "kind": kind,
                    "durationSeconds": 0.5,
                    "toClipId": "c1",
                    "alignment": alignment,
                },
                "keyframes": [],
            }
        ]
    return _project(
        [{"id": "v", "type": "video", "clips": [first, second]}],
        assets=[
            {"id": "a1", "path": "cat_a.mp4", "kind": "video"},
            {"id": "a2", "path": "cat_b.mp4", "kind": "video"},
        ],
    )


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize("kind", ["glitch", "circular-wipe", "cube-rotate", "pixel-dissolve"])
def test_compile_renders_a_catalog_transition(
    kind: str, tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A catalog transition changes the picture mid-ramp and is gone by the end.

    The property that matters is the second half: a pass that never finishes
    leaves every shot after a transition permanently altered, which is invisible
    in a still and obvious in an export.
    """
    project = _catalog_transition_project(tmp_project_dir, media_factory, kind)
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        mid = np.asarray(composite.get_frame(1.2)).astype(np.float64)
        settled = np.asarray(composite.get_frame(1.9)).astype(np.float64)
        assert mid.shape[2] == 3
        # Compared per pixel, not by frame mean: two shots of similar brightness (red then
        # blue) average almost identically while looking nothing alike, so a mean-only check
        # reads a working transition as "did nothing".
        assert float(np.abs(mid - settled).mean()) > 1.0, f"{kind} did nothing"
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize(
    "kind", ["cross-dissolve", "glitch", "circular-wipe", "whip-pan-left", "pixel-dissolve"]
)
def test_a_transition_reveals_the_outgoing_shot_not_black(
    kind: str, tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """No frame of a transition ramp is black — the shot being left is underneath it.

    A transition is stamped on BUTT-JOINED clips, so during the incoming clip's reveal the
    outgoing clip has already ended. Without an under-layer the reveal composites against the
    background: a "cross dissolve" dissolved up from black and a whip pan whipped in over
    black, at every cut. The perceptual reviewer reported exactly that on a real run
    ("Unexpected black frame(s): 90, 91, 92" at each of seven cuts) and no edit the agent
    could propose would have fixed it.
    """
    project = _catalog_transition_project(tmp_project_dir, media_factory, kind)
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        # The cut is at 1.0s and the ramp is 0.5s long; sample its whole width, the first
        # frame included (that is the one that used to be fully black).
        for time in (1.0, 1.05, 1.15, 1.25, 1.35, 1.45):
            frame = np.asarray(composite.get_frame(time)).astype(np.float64)
            black_ratio = float((frame.max(axis=2) < 26).mean())
            assert black_ratio < 0.98, f"{kind} is black at {time}s (ratio {black_ratio})"
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_a_transition_ramp_shows_both_shots(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """Mid-dissolve carries some of BOTH shots, which is what a dissolve means.

    Stronger than "not black": it pins that the under-layer is the neighbour's real picture
    rather than any filler. Red on the way out, blue on the way in, so the mid-ramp frame must
    show measurable red AND measurable blue.
    """
    project = _catalog_transition_project(tmp_project_dir, media_factory, "cross-dissolve")
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        mid = np.asarray(composite.get_frame(1.25)).astype(np.float64)
        # Only the framed picture counts; the letterbox around it is legitimately black.
        lit = mid[mid.max(axis=2) > 26]
        assert lit.size > 0, "the mid-ramp frame is entirely black"
        assert float(lit[:, 0].mean()) > 8, "no red left from the outgoing shot"
        assert float(lit[:, 2].mean()) > 8, "no blue arrived from the incoming shot"
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_a_transition_holds_the_edge_frame_when_there_is_no_handle(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A neighbour cut to the very end of its asset still shows, held, under the ramp.

    Handle material is what a transition normally borrows. When there is none — the outgoing
    clip already plays to the last frame of its source — the alternative is not black: hold
    the edge frame. Under a fast ramp a held frame reads as continuous; black reads as a flash.
    """
    red = media_factory("edge_a.mp4", seconds=1.0, with_audio=False, color="red", size="320x240")
    blue = media_factory("edge_b.mp4", seconds=2.0, with_audio=False, color="blue", size="320x240")
    (tmp_project_dir / "edge_a.mp4").write_bytes(red.read_bytes())
    (tmp_project_dir / "edge_b.mp4").write_bytes(blue.read_bytes())
    # The outgoing clip consumes its whole 1s source, so it has no handle at all.
    first = _clip("c0", "v", 0, 1, asset="a1")
    first["sourceStart"] = 0.0
    first["sourceEnd"] = 1.0
    second = _clip("c1", "v", 1, 2, asset="a2")
    second["sourceStart"] = 0.5
    second["sourceEnd"] = 1.5
    second["effects"] = [
        {
            "id": "c1__transition",
            "type": "transition",
            "params": {"kind": "cross-dissolve", "durationSeconds": 0.4, "fromClipId": "c0"},
            "keyframes": [],
        }
    ]
    project = _project(
        [{"id": "v", "type": "video", "clips": [first, second]}],
        assets=[
            {"id": "a1", "path": "edge_a.mp4", "kind": "video"},
            {"id": "a2", "path": "edge_b.mp4", "kind": "video"},
        ],
    )
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        frame = np.asarray(composite.get_frame(1.05)).astype(np.float64)
        assert float((frame.max(axis=2) < 26).mean()) < 0.98, "the ramp is black"
        lit = frame[frame.max(axis=2) > 26]
        assert float(lit[:, 0].mean()) > 8, "the held outgoing frame is missing"
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_centre_alignment_ramps_the_outgoing_clip_too(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A centred transition starts BEFORE the cut.

    With start alignment (the historical placement) the frame just before the cut is the
    untouched outgoing shot; with centre alignment that same frame is already half-way into
    the incoming one. Asserted as "the picture differs", not "it is darker" — the ramp now has
    the neighbour's picture underneath rather than black, which was the whole defect.
    """
    started = _catalog_transition_project(tmp_project_dir, media_factory, "circular-wipe")
    centred = _catalog_transition_project(
        tmp_project_dir, media_factory, "circular-wipe", alignment="centre"
    )
    a = compile_timeline(started, _index(started, tmp_project_dir), REELS)
    b = compile_timeline(centred, _index(centred, tmp_project_dir), REELS)
    try:
        before_cut = 0.9
        start_aligned = np.asarray(a.get_frame(before_cut)).astype(np.float64)
        centre_aligned = np.asarray(b.get_frame(before_cut)).astype(np.float64)
        assert float(np.abs(start_aligned - centre_aligned).mean()) > 1.0
        # And neither is black: the pre-cut ramp reveals the shot arriving, not the ground.
        for frame in (start_aligned, centre_aligned):
            assert float((frame.max(axis=2) < 26).mean()) < 0.98
    finally:
        a.close()
        b.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_legacy_transition_keeps_its_original_render_path(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """The seven original kinds must not be rerouted through the pass pipeline.

    Their look is what every project made before the catalog already renders, and
    the general path resamples where the original does not. This asserts the
    routing decision itself, which is the part a picture comparison would not
    pin down.
    """
    from framepilot_engine.render.compiler import _uses_legacy_transition_path

    started = _catalog_transition_project(tmp_project_dir, media_factory, "cross-dissolve")
    clip = started.timeline.tracks[0].clips[1]
    assert _uses_legacy_transition_path(clip) is True

    catalogued = _catalog_transition_project(tmp_project_dir, media_factory, "glitch")
    assert _uses_legacy_transition_path(catalogued.timeline.tracks[0].clips[1]) is False

    # …but a legacy kind that is no longer start-aligned has to take the general
    # path, because the old one has no notion of a window sitting before the cut.
    realigned = _catalog_transition_project(
        tmp_project_dir, media_factory, "cross-dissolve", alignment="centre"
    )
    assert _uses_legacy_transition_path(realigned.timeline.tracks[0].clips[1]) is False


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_burns_in_text_overlay(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A text overlay clip (kind ``text``) actually appears in the render.

    Regression: the compiler used to skip clips whose asset id is ``__text__``
    entirely — the ``add_text_overlay`` op applied and validated but never
    rendered (an honesty-gap bug: an edit that "applies" but silently doesn't
    render). A solid dark-blue source has no white/near-white pixels; the text
    overlay's white, black-outlined glyphs are the only source of bright pixels
    around the frame centre, so diffing a small region around the centre (not a
    single pixel, which can land in a glyph gap) with vs. without the overlay is
    a deterministic proof the text was actually drawn (not just that compile
    didn't crash).
    """
    src = media_factory("bg.mp4", seconds=1.0, with_audio=False, color="0x00008B", size="320x240")
    (tmp_project_dir / "bg.mp4").write_bytes(src.read_bytes())

    def project_with_overlay(overlay: bool) -> Project:
        # Track order is z-order front→back (index 0 is the visual front, ADR
        # 0032), so the overlay track must come *before* the video track to
        # actually sit on top of it.
        tracks = []
        if overlay:
            text_clip = _clip("t1", "ov", 0, 1, "__text__")
            text_clip["effects"] = [
                {"id": "t1__text", "type": "text", "params": {"text": "HELLO"}, "keyframes": []}
            ]
            tracks.append({"id": "ov", "type": "overlay", "clips": [text_clip]})
        tracks.append({"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 1, "a1")]})
        return _project(tracks, assets=[{"id": "a1", "path": "bg.mp4", "kind": "video"}])

    plain = project_with_overlay(False)
    with_text = project_with_overlay(True)
    plain_comp = compile_timeline(plain, _index(plain, tmp_project_dir), REELS)
    text_comp = compile_timeline(with_text, _index(with_text, tmp_project_dir), REELS)
    try:
        plain_frame = np.asarray(plain_comp.get_frame(0.5), dtype=np.int64)
        text_frame = np.asarray(text_comp.get_frame(0.5), dtype=np.int64)
        h, w, _ = plain_frame.shape
        # A generous window around the centre — "HELLO" is centered on the frame,
        # so its glyphs (and their black outline) land inside this region.
        region = np.s_[h // 2 - 120 : h // 2 + 120, w // 2 - 240 : w // 2 + 240]
        plain_region = plain_frame[region]
        text_region = text_frame[region]
        # Dark-blue background: no near-white pixel in the region without the overlay.
        plain_max = int(plain_region.max())
        assert plain_max < 160, f"background unexpectedly bright: {plain_max}"
        # With the overlay, white text + its black outline diverge sharply from the
        # uniform dark-blue background across many pixels in the region.
        mean_abs_diff = float(np.abs(text_region - plain_region).mean())
        assert mean_abs_diff > 2.0, f"text overlay not visible near frame centre ({mean_abs_diff=})"
    finally:
        plain_comp.close()
        text_comp.close()


def test_unsupported_track_types_renders_text_unconditionally() -> None:
    """A ``text``-kind clip is never reported as deferred (it always burns in)."""
    project = _project(
        [{"id": "ov", "type": "overlay", "clips": [_clip("t1", "ov", 0, 1, "__text__")]}],
    )
    assert unsupported_track_types(project.timeline, {}) == []


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_audio_fade(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A fade-in ramps the audio: the first sample is quieter than the plateau.

    The time-varying envelope (mixing.fade_gain_at) is applied via MoviePy's audio
    ``transform``; sampling the composited audio at t≈0 vs the middle proves the
    ramp reaches the rendered samples.
    """
    video_src = media_factory("v.mp4", seconds=2.0, with_audio=False)
    audio_src = media_factory("a.m4a", seconds=2.0, with_video=False)
    (tmp_project_dir / "v.mp4").write_bytes(video_src.read_bytes())
    (tmp_project_dir / "a.m4a").write_bytes(audio_src.read_bytes())

    audio_clip = _clip("c2", "a", 0, 2, asset="a2")
    audio_clip["effects"] = [
        {
            "id": "c2__gain",
            "type": "audio_gain",
            "params": {"gainDb": 0.0, "fadeInSeconds": 1.0},
            "keyframes": [],
        }
    ]
    project = _project(
        [
            {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, 2, asset="a1")]},
            {"id": "a", "type": "audio", "clips": [audio_clip]},
        ],
        assets=[
            {"id": "a1", "path": "v.mp4", "kind": "video"},
            {"id": "a2", "path": "a.m4a", "kind": "audio"},
        ],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        # Peak over a window (robust to waveform phase): the fade-in window should
        # be much quieter than the full-gain plateau window.
        early = float(np.abs(composite.audio.get_frame(np.linspace(0.0, 0.2, 2000))).max())
        mid = float(np.abs(composite.audio.get_frame(np.linspace(1.3, 1.7, 2000))).max())
        assert early < 0.5 * mid, f"fade-in did not attenuate the start (early={early}, mid={mid})"
    finally:
        composite.close()


# --- blend mode (schema v8, plan H1.2f) --------------------------------------

# Exact RGB values (0-255) for the two solid-color test clips, chosen so no
# channel is exactly 0 or 1 (avoids every blend formula degenerating to the
# same boolean AND/OR result that pure primaries produce). Kept as named
# constants so the hand-computed expectations below read the same way twice.
_BASE_RGB = (128, 64, 32)  # (0.502, 0.251, 0.125) normalized
_BLEND_RGB = (64, 192, 128)  # (0.251, 0.753, 0.502) normalized

# Generous tolerance for a real ffmpeg yuv420p round-trip (RGB -> YUV -> RGB
# introduces a few units of rounding even for a spatially uniform color).
_PIXEL_TOLERANCE = 14


def _hex_color(rgb: tuple[int, int, int]) -> str:
    return "0x{:02x}{:02x}{:02x}".format(*rgb)


def _solid_color_media(path: Path, ffmpeg_bin: str, *, rgb: tuple[int, int, int]) -> None:
    """Write a 1s solid-color video at ``rgb`` (exact via ffmpeg's ``0xRRGGBB``)."""
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={_hex_color(rgb)}:s=64x64:r=30:d=1",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _blend_mode_project(
    tmp_project_dir: Path, ffmpeg_bin: str, *, blend_mode: str | None
) -> Project:
    """A base video-track clip (``_BASE_RGB``) with an overlay-track clip
    (``_BLEND_RGB``, front/track-0) composited on top, optionally carrying
    ``blend_mode``. Both clips are full-frame solid colors so the composited
    center pixel is exactly the blend result (no letterbox bars to sample past)."""
    _solid_color_media(tmp_project_dir / "base.mp4", ffmpeg_bin, rgb=_BASE_RGB)
    _solid_color_media(tmp_project_dir / "blend.mp4", ffmpeg_bin, rgb=_BLEND_RGB)

    overlay_clip = _clip("blend", "o", 0, 1, asset="blend", blend_mode=blend_mode)
    return _project(
        [
            # Track 0 = visual front (see compile_timeline's "Assemble z-order"
            # comment): this is the clip carrying blend_mode, composited onto
            # the base track beneath it.
            {"id": "o", "type": "overlay", "clips": [overlay_clip]},
            {"id": "v", "type": "video", "clips": [_clip("base", "v", 0, 1, asset="base")]},
        ],
        assets=[
            {"id": "base", "path": "base.mp4", "kind": "video"},
            {"id": "blend", "path": "blend.mp4", "kind": "video"},
        ],
    )


def _center_pixel(composite: Any) -> tuple[int, int, int]:
    frame = np.asarray(composite.get_frame(0.5))
    h, w, _ = frame.shape
    pixel = frame[h // 2, w // 2]
    return (int(pixel[0]), int(pixel[1]), int(pixel[2]))


def _assert_pixel_close(actual: tuple[int, int, int], expected: tuple[float, ...]) -> None:
    for channel, (got, want) in enumerate(zip(actual, expected, strict=True)):
        assert abs(got - want) <= _PIXEL_TOLERANCE, (
            f"channel {channel}: got {got}, expected ~{want:.1f} "
            f"(actual pixel {actual}, expected {expected})"
        )


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_multiply_blend_mode_matches_hand_computed_pixels(
    tmp_project_dir: Path, ffmpeg_bin: str
) -> None:
    # multiply: a*b per channel (a=base, b=blend), normalized to 0-255.
    a = tuple(c / 255.0 for c in _BASE_RGB)
    b = tuple(c / 255.0 for c in _BLEND_RGB)
    expected = tuple(255.0 * ai * bi for ai, bi in zip(a, b, strict=True))

    project = _blend_mode_project(tmp_project_dir, ffmpeg_bin, blend_mode="multiply")
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        _assert_pixel_close(_center_pixel(composite), expected)
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_screen_blend_mode_matches_hand_computed_pixels(
    tmp_project_dir: Path, ffmpeg_bin: str
) -> None:
    # screen: 1-(1-a)(1-b) per channel.
    a = tuple(c / 255.0 for c in _BASE_RGB)
    b = tuple(c / 255.0 for c in _BLEND_RGB)
    expected = tuple(255.0 * (1.0 - (1.0 - ai) * (1.0 - bi)) for ai, bi in zip(a, b, strict=True))

    project = _blend_mode_project(tmp_project_dir, ffmpeg_bin, blend_mode="screen")
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        _assert_pixel_close(_center_pixel(composite), expected)
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_difference_blend_mode_matches_hand_computed_pixels(
    tmp_project_dir: Path, ffmpeg_bin: str
) -> None:
    # difference: |a-b| per channel.
    a = tuple(c / 255.0 for c in _BASE_RGB)
    b = tuple(c / 255.0 for c in _BLEND_RGB)
    expected = tuple(255.0 * abs(ai - bi) for ai, bi in zip(a, b, strict=True))

    project = _blend_mode_project(tmp_project_dir, ffmpeg_bin, blend_mode="difference")
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        _assert_pixel_close(_center_pixel(composite), expected)
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_darken_blend_mode_matches_hand_computed_pixels(
    tmp_project_dir: Path, ffmpeg_bin: str
) -> None:
    # darken: min(a, b) per channel.
    a = tuple(c / 255.0 for c in _BASE_RGB)
    b = tuple(c / 255.0 for c in _BLEND_RGB)
    expected = tuple(255.0 * min(ai, bi) for ai, bi in zip(a, b, strict=True))

    project = _blend_mode_project(tmp_project_dir, ffmpeg_bin, blend_mode="darken")
    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        _assert_pixel_close(_center_pixel(composite), expected)
    finally:
        composite.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_normal_blend_mode_is_byte_identical_to_absent(
    tmp_project_dir: Path, ffmpeg_bin: str
) -> None:
    """Regression guard: `'normal'`/absent both take the pre-v8 fast path and
    must render byte-identical composites."""
    absent = _blend_mode_project(tmp_project_dir, ffmpeg_bin, blend_mode=None)
    composite = compile_timeline(absent, _index(absent, tmp_project_dir), REELS)
    try:
        without_mode = np.asarray(composite.get_frame(0.5)).copy()
    finally:
        composite.close()

    normal = _blend_mode_project(tmp_project_dir, ffmpeg_bin, blend_mode="normal")
    composite = compile_timeline(normal, _index(normal, tmp_project_dir), REELS)
    try:
        with_normal = np.asarray(composite.get_frame(0.5)).copy()
    finally:
        composite.close()

    assert np.array_equal(without_mode, with_normal), (
        "'normal' must render identically to an absent blend_mode"
    )


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_base_track_blend_mode_is_a_noop_not_a_crash(
    tmp_project_dir: Path, ffmpeg_bin: str
) -> None:
    """A blend mode on the sole (base-track) clip has nothing beneath it to
    blend against — it must render its own color unchanged, not crash
    (ADR 0048's documented no-op scoping)."""
    _solid_color_media(tmp_project_dir / "solo.mp4", ffmpeg_bin, rgb=_BASE_RGB)
    project = _project(
        [
            {
                "id": "v",
                "type": "video",
                "clips": [_clip("c1", "v", 0, 1, asset="solo", blend_mode="multiply")],
            }
        ],
        assets=[{"id": "solo", "path": "solo.mp4", "kind": "video"}],
    )

    composite = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    try:
        expected = tuple(float(c) for c in _BASE_RGB)
        _assert_pixel_close(_center_pixel(composite), expected)
    finally:
        composite.close()


# --- channel strip: EQ, dynamics, automation ---------------------------------


def _strip_project(
    tmp_project_dir: Path, media_factory: Callable[..., Path], params: dict[str, Any], **extra: Any
) -> Project:
    """A one-video/one-audio project whose audio clip carries ``params``.

    The generated tone is a 440 Hz sine, which is what makes the EQ assertions
    below measurable: a filter either passes that frequency or it does not.
    """
    seconds = float(extra.pop("seconds", 2.0))
    video_src = media_factory("v.mp4", seconds=seconds, with_audio=False)
    audio_src = media_factory("a.m4a", seconds=seconds, with_video=False)
    (tmp_project_dir / "v.mp4").write_bytes(video_src.read_bytes())
    (tmp_project_dir / "a.m4a").write_bytes(audio_src.read_bytes())

    audio_clip = _clip("c2", "a", 0, seconds, asset="a2")
    audio_clip["effects"] = [
        {
            "id": "c2__gain",
            "type": "audio_gain",
            "params": params,
            "keyframes": extra.pop("keyframes", []),
        }
    ]
    return _project(
        [
            {"id": "v", "type": "video", "clips": [_clip("c1", "v", 0, seconds, asset="a1")]},
            {"id": "a", "type": "audio", "clips": [audio_clip]},
        ],
        assets=[
            {"id": "a1", "path": "v.mp4", "kind": "video"},
            {"id": "a2", "path": "a.m4a", "kind": "audio"},
        ],
    )


def _window_peak(composite: Any, start: float, end: float) -> float:
    return float(np.abs(composite.audio.get_frame(np.linspace(start, end, 4000))).max())


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_an_eq_that_removes_the_tone_it_is_aimed_at(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """A high-pass well above the tone must silence it in the RENDER, not just in a unit test.

    The unit tests prove the filter's shape; this proves the shape survives the
    compile — that the samples MoviePy hands the writer actually went through it.
    """
    project = _strip_project(
        tmp_project_dir,
        media_factory,
        {"gainDb": 0.0, "eq": {"bands": [{"kind": "high-pass", "frequencyHz": 4000}]}},
    )
    plain = _strip_project(tmp_project_dir, media_factory, {"gainDb": 0.0})

    filtered = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    unfiltered = compile_timeline(plain, _index(plain, tmp_project_dir), REELS)
    try:
        quiet = _window_peak(filtered, 0.5, 1.5)
        loud = _window_peak(unfiltered, 0.5, 1.5)
        assert loud > 0.05, "the fixture tone must be audible for the comparison to mean anything"
        assert quiet < 0.1 * loud, (
            f"high-pass did not remove the 440 Hz tone (got {quiet} vs {loud})"
        )
    finally:
        filtered.close()
        unfiltered.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_applies_compression_that_pulls_the_peak_down(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    project = _strip_project(
        tmp_project_dir,
        media_factory,
        {
            "gainDb": 0.0,
            "dynamics": {
                "thresholdDb": -30.0,
                "ratio": 8.0,
                "attackMs": 5.0,
                "releaseMs": 80.0,
            },
        },
    )
    plain = _strip_project(tmp_project_dir, media_factory, {"gainDb": 0.0})

    compressed = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    uncompressed = compile_timeline(plain, _index(plain, tmp_project_dir), REELS)
    try:
        # Well past the attack, so this measures the settled reduction.
        squashed = _window_peak(compressed, 1.0, 1.5)
        open_peak = _window_peak(uncompressed, 1.0, 1.5)
        assert squashed < 0.5 * open_peak
        # …and it is compression, not silence.
        assert squashed > 0.01
    finally:
        compressed.close()
        uncompressed.close()


@pytest.mark.usefixtures("require_ffprobe")
def test_compile_follows_a_gain_automation_lane(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """The rendered level tracks the authored lane, and the lane outranks static gain.

    ``gainDb`` says 0 while the lane says -40 at the start: if the fader read the
    static value the opening would be full level, and if it multiplied the two the
    end would be -40 rather than back at unity. Measuring both ends tells those
    three possibilities apart.
    """
    project = _strip_project(
        tmp_project_dir,
        media_factory,
        {"gainDb": 0.0},
        keyframes=[
            {"id": "k0", "time": 0.0, "property": "gainDb", "value": -40.0, "easing": "linear"},
            {"id": "k1", "time": 2.0, "property": "gainDb", "value": 0.0, "easing": "linear"},
        ],
    )
    plain = _strip_project(tmp_project_dir, media_factory, {"gainDb": 0.0})

    automated = compile_timeline(project, _index(project, tmp_project_dir), REELS)
    flat = compile_timeline(plain, _index(plain, tmp_project_dir), REELS)
    try:
        opening = _window_peak(automated, 0.0, 0.1)
        closing = _window_peak(automated, 1.9, 2.0)
        reference = _window_peak(flat, 1.9, 2.0)
        assert opening < 0.05 * closing, "the lane's -40 dB start did not reach the render"
        assert closing == pytest.approx(reference, rel=0.05), "the lane should end back at unity"
    finally:
        automated.close()
        flat.close()


class TestDecodeBudget:
    """A reader must never decode larger than the frame it feeds.

    Every reader here opens the ORIGINAL camera master, so without a budget the
    decoder produces UHD frames even when the composite they land in is 960 wide
    — the cost that made a review batch expensive upstream of every byte budget
    in `validation.temporal_evidence`.
    """

    def test_decodes_an_oversized_source_down_to_the_budget(
        self, media_factory: Callable[..., Path]
    ) -> None:
        from moviepy import VideoFileClip

        path = str(media_factory("big.mp4", size="640x480", with_audio=False))
        reader = _open_source_reader(VideoFileClip, path, 160)
        try:
            assert max(reader.size) == 160
            assert tuple(reader.size) == (160, 120)
            # The pixels really arrive at that size — the budget is applied in the
            # decoder, not by resizing after the expensive part is already paid.
            assert reader.get_frame(0).shape == (120, 160, 3)
        finally:
            reader.close()

    def test_never_upscales_a_source_smaller_than_the_budget(
        self, media_factory: Callable[..., Path]
    ) -> None:
        """Upscaling in the decoder would cost MORE than not budgeting at all."""
        from moviepy import VideoFileClip

        path = str(media_factory("small.mp4", size="320x240", with_audio=False))
        reader = _open_source_reader(VideoFileClip, path, 4000)
        try:
            assert tuple(reader.size) == (320, 240)
        finally:
            reader.close()

    def test_no_budget_decodes_natively(self, media_factory: Callable[..., Path]) -> None:
        """The export path passes None and must keep reading camera masters."""
        from moviepy import VideoFileClip

        path = str(media_factory("native.mp4", size="320x240", with_audio=False))
        reader = _open_source_reader(VideoFileClip, path, None)
        try:
            assert tuple(reader.size) == (320, 240)
        finally:
            reader.close()

    def test_closes_the_oversized_reader_it_replaces(
        self, media_factory: Callable[..., Path]
    ) -> None:
        """The probe reader's ffmpeg child must not outlive the decision to replace it.

        This function is the one place that opens a reader it then throws away,
        so a leak here would be invisible to the caller's `opened` tracking —
        it only ever sees what is returned.
        """
        from moviepy import VideoFileClip

        path = str(media_factory("probe.mp4", size="640x480", with_audio=False))
        opened: list[Any] = []

        class _Tracking(VideoFileClip):  # type: ignore[misc]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, **kwargs)
                opened.append(self)

        reader = _open_source_reader(_Tracking, path, 160)
        try:
            assert len(opened) == 2
            probe, kept = opened
            assert kept is reader
            # MoviePy drops the reader reference on close, after terminating its
            # ffmpeg child — so `None` here is the evidence the process is gone.
            assert probe.reader is None
        finally:
            reader.close()

    def test_a_budgeted_compile_produces_the_preset_frame(
        self,
        media_factory: Callable[..., Path],
        tmp_path: Path,
    ) -> None:
        """End to end: the composite is unchanged in shape by how its sources decode."""
        source = media_factory("clip.mp4", size="640x480", seconds=1.0, with_audio=False)
        (tmp_path / "clip.mp4").write_bytes(source.read_bytes())
        project = Project.model_validate(
            {
                "id": "p",
                "name": "Budgeted",
                "fps": 30,
                "resolution": {"width": 320, "height": 240},
                "assets": [{"id": "a", "path": "clip.mp4", "kind": "video"}],
                "timeline": {
                    "tracks": [
                        {
                            "id": "v",
                            "type": "video",
                            "clips": [
                                {
                                    "id": "c",
                                    "assetId": "a",
                                    "trackId": "v",
                                    "start": 0.0,
                                    "end": 1.0,
                                    "sourceStart": 0.0,
                                    "sourceEnd": 1.0,
                                }
                            ],
                        }
                    ]
                },
            }
        )
        index = index_assets(
            [asset.model_dump() for asset in project.assets], base_dir=tmp_path
        )
        preset = REELS.model_copy(update={"width": 160, "height": 120})
        composition = compile_timeline(project, index, preset, max_decode_dimension=160)
        try:
            assert composition.get_frame(0.0).shape == (120, 160, 3)
        finally:
            close_clip_tree(composition)
