"""Behavioral parity fixture shared with TypeScript editor-core.

Each runtime applies the same typed operation to the same timeline and asserts the
same observable result. Adding a mirrored operation to one runtime should add a case
here rather than relying on two independent unit-test descriptions.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from framepilot_engine.timeline.models import Clip, Timeline, Track
from framepilot_engine.timeline.operations import Operation, apply_operation

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "editor-core"
    / "test"
    / "fixtures"
    / "cross-runtime-operation-behavior.json"
)
_ADAPTER: TypeAdapter[Operation] = TypeAdapter(Operation)


def _load() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    return data


def _find_clip(timeline: Timeline, clip_id: str) -> tuple[Track, Clip] | None:
    for track in timeline.tracks:
        for clip in track.clips:
            if clip.id == clip_id:
                return track, clip
    return None


def test_cross_runtime_operation_behavior_fixture() -> None:
    fixture = _load()
    initial = Timeline.model_validate(fixture["timeline"])

    for behavior in fixture["cases"]:
        operation = _ADAPTER.validate_python(behavior["operation"])
        timeline = apply_operation(initial, operation)
        expected = behavior["expect"]

        if "clipIds" in expected:
            track = next(track for track in timeline.tracks if track.id == expected["trackId"])
            assert [clip.id for clip in track.clips] == expected["clipIds"], behavior["name"]
            if "boundary" in expected:
                assert track.clips[0].end == expected["boundary"]
                assert track.clips[1].start == expected["boundary"]
            continue

        if "clipId" in expected:
            located = _find_clip(timeline, expected["clipId"])
            assert located is not None, behavior["name"]
            track, clip = located
            if "trackId" in expected:
                assert track.id == expected["trackId"]
            for fixture_key, attribute in (
                ("start", "start"),
                ("end", "end"),
                ("sourceStart", "source_start"),
                ("sourceEnd", "source_end"),
                ("speed", "speed"),
                ("crop", "crop"),
                ("blendMode", "blend_mode"),
            ):
                if fixture_key not in expected:
                    continue
                actual = getattr(clip, attribute)
                if hasattr(actual, "model_dump"):
                    actual = actual.model_dump(by_alias=True)
                assert actual == expected[fixture_key], (behavior["name"], fixture_key)

            if "effectType" in expected:
                effect = next(
                    effect for effect in clip.effects if effect.type == expected["effectType"]
                )
                for key in (
                    "text",
                    "shape",
                    "feather",
                    "opacity",
                    "gainDb",
                    "fadeInSeconds",
                    "muted",
                    "kind",
                    "durationSeconds",
                    "fromClipId",
                    "eq",
                    "dynamics",
                ):
                    if key in expected:
                        assert effect.params.get(key) == expected[key], (behavior["name"], key)
                if "keyframes" in expected:
                    assert [
                        keyframe.model_dump(by_alias=True, exclude_none=True)
                        for keyframe in effect.keyframes
                    ] == expected["keyframes"], behavior["name"]
            continue

        if "trackId" in expected:
            track = next(track for track in timeline.tracks if track.id == expected["trackId"])
            if "locked" in expected:
                assert track.locked == expected["locked"]
            if "muted" in expected:
                assert track.muted == expected["muted"]
            if "trackType" in expected:
                assert track.type == expected["trackType"], behavior["name"]
            if "trackIndex" in expected:
                assert timeline.tracks.index(track) == expected["trackIndex"], behavior["name"]
            # The mix role, which is what ``duck_roles`` and the role-based
            # ducking controller read. A runtime that drops it on the way in
            # produces a bed nothing can find.
            if "role" in expected:
                assert track.role is not None and track.role.value == expected["role"], (
                    behavior["name"]
                )
