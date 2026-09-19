"""PX5.5: what the export shows for a source whose frame rate is not the project's.

The export composites ``t = k / fps`` for every project frame ``k`` and reads, per clip, the
source frame ``_export_source_frames`` lists (the matte alignment check reads the same list).
The monitor's playback evaluates the frame plan at ``k / fps`` for the frame on screen
(``apps/web-editor/src/preview/clock/project-frame.ts``), so the two agree exactly when
``frame_plan_at(project, k / fps)`` names the same source frame as the export's list. This pins
that, on the ``mixed-frame-rates`` vector with its fast asset probed at 60 fps (a 60 fps source
in a 30 fps project: the export shows every other source frame) and at its own 30 and 24 fps.
The TypeScript half (``project-frame.test.ts``) holds ``framePlanAt`` at the snapped time to
the same numbers.
"""

from __future__ import annotations

import json
import math
from types import SimpleNamespace
from typing import Any

import pytest

from framepilot_engine.render.compiler import _export_source_frames
from framepilot_engine.render.frame_plan import frame_plan_at
from framepilot_engine.timeline.models import Project
from tests.frame_plan_vectors import FIXTURE_DIR


def _case() -> dict[str, Any]:
    document = json.loads((FIXTURE_DIR / "time.json").read_text(encoding="utf-8"))
    return next(case for case in document["cases"] if case["id"] == "mixed-frame-rates")


@pytest.mark.parametrize("land_fps", [60.0, 30.0, 24.0])
def test_the_export_reads_the_plan_at_each_project_frame_instant(land_fps: float) -> None:
    case = _case()
    project = Project.model_validate(case["project"])
    source_fps = {**case["probe"]["fps"], "land": land_fps}
    output_fps = float(project.fps)
    durations = {asset.id: asset.duration_seconds for asset in project.assets}
    for track in project.timeline.tracks:
        for clip in track.clips:
            reader = SimpleNamespace(reader=None)  # a constant-rate reader: MoviePy's rule
            exported = _export_source_frames(
                clip, reader, output_fps, source_fps[clip.asset_id], durations[clip.asset_id]
            )
            first = math.ceil(clip.start * output_fps - 1e-9)
            planned = []
            for k in range(first, first + len(exported)):
                plan = frame_plan_at(project, k / output_fps, source_fps=source_fps)
                layer = next(layer for layer in plan.layers if layer.clip_id == clip.id)
                assert layer.source is not None
                planned.append(layer.source.frame)
            assert planned == exported, clip.id


def test_a_60_fps_source_in_a_30_fps_project_exports_every_other_frame() -> None:
    case = _case()
    project = Project.model_validate(case["project"])
    clip = next(c for t in project.timeline.tracks for c in t.clips if c.asset_id == "land")
    frames = _export_source_frames(clip, SimpleNamespace(reader=None), 30.0, 60.0, 60.0)
    # c2 plays land from 1.0 s for 2 s: source frames 60, 62, ..., 178.
    assert frames == list(range(60, 180, 2))
