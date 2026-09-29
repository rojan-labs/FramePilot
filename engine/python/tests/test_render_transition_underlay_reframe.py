"""A transition's under-layer draws its shot as that shot draws itself (AL40).

Harness run 16: a portrait edit of 16:9 footage, every shot reframed to fill the frame by
``reframe_pan`` (``x``/``y``/``scale`` keyframes, no crop). At each transition the shot on the
other side of the cut, borrowed as an under-layer, was placed WITHOUT its keyframes: fitted, so
letterboxed, and its black bars showed through the incoming picture for the whole ramp (219 of
320 rows black at the first frame of a 0.6 s luma fade). The fix reads the neighbour's reframe on
its own clip clock carried across the cut, so it holds its last keyframe past its out-point and
its first before its in-point.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Project

#: A quarter of the 1080x1920 project: keyframed x/y are project pixels, so a smaller target
#: also exercises their conversion, as the run-16 frame grabs did.
_TARGET = frame_target(270, 480, 30)
#: The scale that makes a fitted 16:9 picture fill a 9:16 frame's height: 1920 / (1080 * 9/16).
_FILL = 1920 / 607.5
#: A row this dark on average is a letterbox bar, not picture (the run-16 measure).
_BLACK_ROW_LUMA = 8.0
_RAMP_START = 1.0
_RAMP_SECONDS = 0.5
_RAMP_SAMPLES = (1.0, 1.1, 1.25, 1.4)
#: Outside the ramp: the transition must change nothing here.
_OUTSIDE_SAMPLES = (0.5, 0.95, 1.6, 1.9)


def _source(ffmpeg_bin: str, path: Path, colour: str, stripe: str) -> None:
    """A static 16:9 picture with a stripe at its left edge, so a placement shift shows."""
    graph = f"color=c={colour}:s=320x180:r=30:d=2,drawbox=x=0:y=0:w=80:h=180:color={stripe}:t=fill"
    subprocess.run(
        [ffmpeg_bin, "-y", "-f", "lavfi", "-i", graph, "-pix_fmt", "yuv420p", str(path)],
        check=True,
        capture_output=True,
    )


def _reframe(
    clip_id: str, pan: tuple[float, float], x_from: float, x_to: float
) -> list[dict[str, Any]]:
    """``reframe_pan``'s shape: a fill scale held flat, and x panned over ``pan`` (clip seconds)."""
    return [
        {"id": f"{clip_id}_s0", "time": 0.0, "property": "scale", "value": _FILL},
        {"id": f"{clip_id}_s1", "time": 1.0, "property": "scale", "value": _FILL},
        {
            "id": f"{clip_id}_x0",
            "time": pan[0],
            "property": "x",
            "value": x_from,
            "easing": "ease-in-out",
        },
        {"id": f"{clip_id}_x1", "time": pan[1], "property": "x", "value": x_to},
    ]


def _project(kind: str | None, role: str) -> Project:
    """Two reframed shots cut at 1.0 s, with ``kind`` after the cut (``in``) or before (``out``).

    The outgoing pan settles at 0.5 s and the incoming one starts at 0.5 s, so an under-layer
    in either direction reads a held keyframe: past the outgoing's last, before the incoming's
    first.
    """
    outgoing: dict[str, Any] = {
        "id": "c0",
        "assetId": "a0",
        "trackId": "v",
        "start": 0.0,
        "end": 1.0,
        "sourceStart": 0.0,
        "sourceEnd": 1.0,
        "effects": [],
        "keyframes": _reframe("c0", (0.0, 0.5), 150.0, -200.0),
    }
    incoming: dict[str, Any] = {
        "id": "c1",
        "assetId": "a1",
        "trackId": "v",
        "start": 1.0,
        "end": 2.0,
        "sourceStart": 0.5,
        "sourceEnd": 1.5,
        "effects": [],
        "keyframes": _reframe("c1", (0.5, 1.0), 250.0, -250.0),
    }
    if kind is not None and role == "in":
        incoming["effects"] = [
            {
                "id": "c1__transition",
                "type": "transition",
                "params": {"kind": kind, "durationSeconds": _RAMP_SECONDS, "fromClipId": "c0"},
                "keyframes": [],
            }
        ]
    if kind is not None and role == "out":
        outgoing["effects"] = [
            {
                "id": "c0__transition_out",
                "type": "transition_out",
                "params": {
                    "kind": kind,
                    "durationSeconds": _RAMP_SECONDS,
                    "toClipId": "c1",
                    "alignment": "end",
                },
                "keyframes": [],
            }
        ]
    return Project.model_validate(
        {
            "id": "p",
            "name": "AL40",
            "fps": 30,
            "resolution": {"width": 1080, "height": 1920},
            "assets": [
                {"id": "a0", "path": "out.mp4", "kind": "video"},
                {"id": "a1", "path": "in.mp4", "kind": "video"},
            ],
            "timeline": {"tracks": [{"id": "v", "type": "video", "clips": [outgoing, incoming]}]},
        }
    )


def _frames(project: Project, root: Path, times: tuple[float, ...]) -> list[np.ndarray]:
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], root)
    composite = compile_timeline(project, index, _TARGET)
    try:
        return [np.asarray(composite.get_frame(t)).copy() for t in times]
    finally:
        close_clip_tree(composite)


def _black_rows(frame: np.ndarray) -> int:
    luma = frame[..., :3].astype(np.float64) @ np.array([0.299, 0.587, 0.114])
    return int((luma.mean(axis=1) < _BLACK_ROW_LUMA).sum())


@pytest.fixture
def media_root(tmp_project_dir: Path, ffmpeg_bin: str) -> Path:
    _source(ffmpeg_bin, tmp_project_dir / "out.mp4", "red", "yellow")
    _source(ffmpeg_bin, tmp_project_dir / "in.mp4", "blue", "green")
    return tmp_project_dir


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize(
    ("kind", "role"),
    [
        ("luma-fade", "in"),
        ("cross-dissolve", "in"),
        ("whip-pan-up", "in"),
        ("light-leak", "in"),
        ("luma-fade", "out"),
    ],
)
def test_no_letterbox_shows_through_a_transition_between_reframed_shots(
    kind: str, role: str, media_root: Path
) -> None:
    """Both shots fill the frame, so no frame of the ramp has a black bar (run 16: 219 rows)."""
    # An end-aligned ramp runs over the last half second before the cut.
    ramp = (
        _RAMP_SAMPLES if role == "in" else tuple(round(t - _RAMP_SECONDS, 6) for t in _RAMP_SAMPLES)
    )
    frames = _frames(_project(kind, role), media_root, ramp)
    black = {t: _black_rows(frame) for t, frame in zip(ramp, frames, strict=True)}
    assert all(rows == 0 for rows in black.values()), f"{kind} ({role}) black rows: {black}"


@pytest.mark.usefixtures("require_ffprobe")
def test_the_under_layer_holds_the_outgoing_shots_last_framing(media_root: Path) -> None:
    """At the cut a dissolve has revealed none of the incoming shot, so the frame IS the
    under-layer, and it must be the outgoing shot exactly as its last frames drew it: the same
    fill and the pan held at its last keyframe (x = -200), not fitted and centred."""
    before_cut, at_cut = _frames(_project("cross-dissolve", "in"), media_root, (0.9, _RAMP_START))
    difference = np.abs(before_cut.astype(np.int16) - at_cut.astype(np.int16))
    assert float(difference.mean()) < 1.0, f"mean |diff| {float(difference.mean()):.2f}"


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize(("kind", "role"), [("luma-fade", "in"), ("cross-dissolve", "in")])
def test_a_transition_changes_no_frame_outside_its_ramp(
    kind: str, role: str, media_root: Path
) -> None:
    """Outside the ramp the transition, and its under-layer, change nothing: every frame there
    is byte-identical to the same cut with no transition at all."""
    plain = _frames(_project(None, role), media_root, _OUTSIDE_SAMPLES)
    with_transition = _frames(_project(kind, role), media_root, _OUTSIDE_SAMPLES)
    for t, expected, actual in zip(_OUTSIDE_SAMPLES, plain, with_transition, strict=True):
        assert np.array_equal(expected, actual), f"{kind} changed the frame at {t}s"
