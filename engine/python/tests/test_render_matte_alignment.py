"""Frame alignment gate for exported mattes (BR2.4, plan 06: 100 %).

Every source frame writes its own number into the picture's left half; every matte frame writes
ITS number into the alpha of the right half (over a white picture). An exported frame therefore
shows both numbers, and the gate is that they are equal on every exported frame: through a
source-range offset, a source whose timestamps start at 1.5 s, constant speed, reverse and a speed
ramp. A matte one frame off on any exported frame fails.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.effects.speed_curve import clip_timeline_duration
from framepilot_engine.media.assets import index_assets
from framepilot_engine.media.ffmpeg import find_ffprobe
from framepilot_engine.render.compiler import CompileError, compile_timeline
from framepilot_engine.render.mattes import MATTE_REMEDIES, MatteRefusalCode
from framepilot_engine.render.pipeline import plain_render_error
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Clip, Project
from tests import matte_fixtures as fx

pytestmark = pytest.mark.usefixtures("require_ffprobe")

FPS = 30
FRAMES = 24
HALF = fx.WIDTH // 2


def _level(index: int) -> int:
    return 12 + 9 * index


def _decode(value: float) -> int:
    return round((value - 12.0) / 9.0)


def _pictures() -> list[np.ndarray]:
    frames = []
    for k in range(FRAMES):
        frame = np.full((fx.HEIGHT, fx.WIDTH, 3), 255, dtype=np.uint8)
        frame[:, :HALF] = _level(k)
        frames.append(frame)
    return frames


def _mattes() -> list[np.ndarray]:
    frames = []
    for k in range(FRAMES):
        alpha = np.full((fx.HEIGHT, fx.WIDTH), 255, dtype=np.uint8)
        alpha[:, HALF:] = _level(k)
        frames.append(alpha)
    return frames


def _setup(root: Path, *, ts_offset: float = 0.0, pts: list[int] | None = None) -> dict[str, Any]:
    fx.write_source(root / "src.mkv", _pictures(), ts_offset=ts_offset)
    origin = round(ts_offset * FPS)
    return fx.write_artifact(
        root,
        pts=pts if pts is not None else [origin + k for k in range(FRAMES)],
        time_base=(1, FPS),
        origin_pts=origin,
        mattes=_mattes(),
        ts_offset=ts_offset,
    )


def _project(artifact: dict[str, Any], **clip: Any) -> Project:
    fields: dict[str, Any] = {
        "id": "c",
        "assetId": "a",
        "trackId": "v",
        "start": 0.0,
        "end": 1.0,
        "sourceStart": 0.0,
        "sourceEnd": 0.5,
        "masks": [fx.matte_mask("m", artifact, decontaminate=False)],
        **clip,
    }
    if "end" not in clip:
        duration = clip_timeline_duration(Clip.model_validate(fields))
        fields["end"] = fields["start"] + (
            duration
            if duration is not None
            else (fields["sourceEnd"] - fields["sourceStart"]) / abs(fields.get("speed", 1.0))
        )
    return Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "fps": FPS,
            "resolution": {"width": fx.WIDTH, "height": fx.HEIGHT},
            "assets": [
                {
                    "id": "a",
                    "path": "src.mkv",
                    "kind": "video",
                    "media": {"width": fx.WIDTH, "height": fx.HEIGHT},
                }
            ],
            "timeline": {"tracks": [{"id": "v", "type": "video", "clips": [fields]}]},
        }
    )


def _identities(project: Project, root: Path) -> list[tuple[int, int]]:
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], root)
    composite = compile_timeline(project, index, frame_target(fx.WIDTH, fx.HEIGHT, FPS))
    clip = project.timeline.tracks[0].clips[0]
    pairs: list[tuple[int, int]] = []
    try:
        k = 0
        while k / FPS < clip.end:
            frame = np.asarray(composite.get_frame(k / FPS), dtype=np.float64)
            pairs.append((_decode(frame[:, :HALF, 0].mean()), _decode(frame[:, HALF:, 0].mean())))
            k += 1
    finally:
        close_clip_tree(composite)
    return pairs


def _assert_aligned(pairs: list[tuple[int, int]]) -> None:
    misaligned = [(i, pair) for i, pair in enumerate(pairs) if pair[0] != pair[1]]
    assert not misaligned, (
        f"{len(misaligned)}/{len(pairs)} exported frames misaligned: {misaligned}"
    )
    assert len({picture for picture, _ in pairs}) > 1, "the clip must move through frames"


@pytest.mark.parametrize(
    ("case", "clip"),
    [
        ("offset", {"sourceStart": 0.2, "sourceEnd": 0.6}),
        ("double-speed", {"sourceStart": 0.1, "sourceEnd": 0.7, "speed": 2.0}),
        ("reverse", {"sourceStart": 0.1, "sourceEnd": 0.5, "speed": -1.0}),
        (
            "speed-ramp",
            {
                "sourceStart": 0.1,
                "sourceEnd": 0.7,
                "speedRamp": [
                    {"id": "p0", "sourceTime": 0.0, "rate": 0.5, "easing": "ease-in-out"},
                    {"id": "p1", "sourceTime": 0.6, "rate": 2.0},
                ],
            },
        ),
    ],
)
def test_every_exported_frame_uses_its_own_matte_frame(
    tmp_path: Path, case: str, clip: dict[str, Any]
) -> None:
    artifact = _setup(tmp_path)
    pairs = _identities(_project(artifact, **clip), tmp_path)
    _assert_aligned(pairs)


def test_source_with_non_zero_start_pts_stays_aligned(tmp_path: Path) -> None:
    """Timestamps start at 1.5 s (as after an edit list): asset second 0 is still frame 0."""
    artifact = _setup(tmp_path, ts_offset=1.5)
    probe = subprocess.run(
        [
            find_ffprobe(),
            "-v",
            "error",
            "-show_entries",
            "format=start_time",
            "-of",
            "json",
            str(tmp_path / "src.mkv"),
        ],
        capture_output=True,
        check=True,
        timeout=60,
    )
    assert float(json.loads(probe.stdout)["format"]["start_time"]) == pytest.approx(1.5)
    pairs = _identities(_project(artifact, sourceStart=0.3, sourceEnd=0.7), tmp_path)
    _assert_aligned(pairs)
    assert pairs[0] == (9, 9)


def test_artifact_starting_mid_source_aligns_by_first_frame(tmp_path: Path) -> None:
    """A matte covering source frames 6..17 only: frame numbers, not matte indices, match."""
    fx.write_source(tmp_path / "src.mkv", _pictures())
    artifact = fx.write_artifact(
        tmp_path,
        pts=list(range(6, 18)),
        time_base=(1, FPS),
        first_frame=6,
        mattes=_mattes()[6:18],
    )
    pairs = _identities(_project(artifact, sourceStart=0.2, sourceEnd=0.6), tmp_path)
    _assert_aligned(pairs)
    assert pairs[0] == (6, 6)


def test_variable_frame_rate_source_refuses_instead_of_sliding(tmp_path: Path) -> None:
    pts = [k * 3 + (1 if k % 4 == 3 else 0) for k in range(FRAMES)]
    artifact = _setup(tmp_path, pts=pts)
    artifact["coverage"] = {"sourceStart": 0.0, "sourceEnd": 0.8}
    project = _project(artifact, sourceStart=0.0, sourceEnd=0.5)
    document = json.loads(json.dumps(project.model_dump(by_alias=True)))
    document["timeline"]["tracks"][0]["clips"][0]["masks"][0]["artifact"]["files"] = [
        {"name": entry["name"], "sha256": entry["sha256"]} for entry in artifact["files"]
    ]
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], tmp_path)
    frames_json = tmp_path / ".framepilot-derived/mattes" / fx.KEY / "frames.json"
    stored = json.loads(frames_json.read_text(encoding="utf-8"))
    stored["timeBase"] = [1, FPS * 3]
    frames_json.write_text(json.dumps(stored), encoding="utf-8")
    for entry in document["timeline"]["tracks"][0]["clips"][0]["masks"][0]["artifact"]["files"]:
        if entry["name"] == "frames.json":
            entry["sha256"] = fx.sha256(frames_json)
    with pytest.raises(CompileError) as caught:
        compile_timeline(
            Project.model_validate(document), index, frame_target(fx.WIDTH, fx.HEIGHT, FPS)
        )
    assert (
        plain_render_error(caught.value)
        == (MATTE_REMEDIES[MatteRefusalCode.VARIABLE_FRAME_RATE][1])
    )
