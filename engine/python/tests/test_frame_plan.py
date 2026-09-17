"""The frame plan describes what ``compile_timeline`` composites (PX1.1).

Two kinds of test. The behaviour tests pin the export decisions the plan has to state —
z-order across picture, text and caption layers, hidden tracks, under-layers, still-image
quirks. The time-chain test runs the compiler's own ``_subclipped_source``/``_apply_speed``
MoviePy chain on a clip that records the source time it is asked for, and requires the
plan's source time to be the SAME float: the plan is not allowed to approximate the export.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.compiler import _apply_speed, _subclipped_source
from framepilot_engine.render.frame_plan import (
    FramePlanError,
    frame_plan_at,
    mask_source_time,
    source_frame_index,
    underlay_material,
    video_source_time,
)
from framepilot_engine.timeline.models import Clip, Project

_FPS = 30.0
_ASSET_SECONDS = 20.0


def _clip(clip_id: str, track: str, start: float, end: float, **extra: Any) -> dict[str, Any]:
    source_start = float(extra.pop("sourceStart", start))
    fields: dict[str, Any] = {
        "id": clip_id,
        "assetId": extra.pop("assetId", "land"),
        "trackId": track,
        "start": start,
        "end": end,
        "sourceStart": source_start,
        "sourceEnd": source_start + (end - start),
        "effects": [],
        "keyframes": [],
    }
    fields.update(extra)
    return fields


def _text(clip_id: str, track: str, start: float, end: float, text: str) -> dict[str, Any]:
    return _clip(
        clip_id,
        track,
        start,
        end,
        assetId="__text__",
        sourceStart=0.0,
        effects=[{"id": f"{clip_id}__t", "type": "text", "params": {"text": text}}],
    )


def _project(tracks: list[dict[str, Any]], **extra: Any) -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "fps": 30,
            "resolution": {"width": 1280, "height": 720},
            "assets": [
                {
                    "id": "land",
                    "path": "land.mp4",
                    "kind": "video",
                    "durationSeconds": _ASSET_SECONDS,
                    "media": {"width": 1920, "height": 1080},
                },
                {
                    "id": "png",
                    "path": "still.png",
                    "kind": "image",
                    "media": {"width": 800, "height": 600},
                },
                {"id": "music", "path": "m.wav", "kind": "audio", "durationSeconds": 10.0},
            ],
            "timeline": {"tracks": tracks},
            **extra,
        }
    )


def _ids(project: Project, t: float, **kwargs: Any) -> list[tuple[str, str, str | None]]:
    plan = frame_plan_at(project, t, **kwargs)
    return [(layer.kind, layer.role, layer.clip_id) for layer in plan.layers]


def test_text_between_pictures_is_composited_in_its_track_position() -> None:
    project = _project(
        [
            {"id": "front", "type": "video", "clips": [_clip("f", "front", 0, 4)]},
            {"id": "words", "type": "overlay", "clips": [_text("t", "words", 0, 4, "Hi")]},
            {"id": "back", "type": "video", "clips": [_clip("b", "back", 0, 4)]},
        ]
    )
    # Back to front: the text sits UNDER the front picture, which is what the export draws.
    assert _ids(project, 1.0) == [
        ("picture", "clip", "b"),
        ("text", "clip", "t"),
        ("picture", "clip", "f"),
    ]


def test_hidden_tracks_and_gaps_contribute_nothing() -> None:
    project = _project(
        [
            {"id": "front", "type": "video", "hidden": True, "clips": [_clip("f", "front", 0, 4)]},
            {"id": "back", "type": "video", "clips": [_clip("b", "back", 1, 2)]},
        ]
    )
    assert _ids(project, 1.5) == [("picture", "clip", "b")]
    # End-exclusive, like MoviePy's `is_playing`.
    assert _ids(project, 2.0) == []
    assert _ids(project, 0.5) == []


def test_burned_captions_sit_above_every_track_in_caption_track_list_order() -> None:
    def caption(clip_id: str, track: str, text: str) -> dict[str, Any]:
        return _clip(
            clip_id,
            track,
            0,
            4,
            assetId="__caption__",
            sourceStart=0.0,
            captionCue={"text": text, "words": []},
        )

    project = _project(
        [
            {"id": "c1", "type": "caption", "clips": [caption("k1", "c1", "one")]},
            {"id": "v", "type": "video", "clips": [_clip("p", "v", 0, 4)]},
            {"id": "c2", "type": "caption", "clips": [caption("k2", "c2", "two")]},
        ]
    )
    assert _ids(project, 1.0, burn_captions=True) == [
        ("picture", "clip", "p"),
        ("caption", "clip", "k1"),
        ("caption", "clip", "k2"),
    ]
    assert _ids(project, 1.0) == [("picture", "clip", "p")]


def test_a_still_image_ignores_its_crop_and_opacity_as_the_export_does() -> None:
    still = _clip(
        "s",
        "v",
        0,
        4,
        assetId="png",
        sourceStart=0.0,
        crop={"x": 0.0, "y": 0.0, "width": 0.5, "height": 0.5},
        keyframes=[{"id": "o", "time": 0, "property": "opacity", "value": 0.25}],
    )
    plan = frame_plan_at(_project([{"id": "v", "type": "video", "clips": [still]}]), 1.0)
    (layer,) = plan.layers
    assert layer.crop is None
    assert layer.opacity == 1.0
    assert layer.geometry is not None
    # Fitted from the UNCROPPED 800x600 source into 1280x720.
    assert layer.geometry.base_scale == pytest.approx(720 / 600)


def test_transition_under_layer_precedes_the_clip_and_reads_the_neighbours_handle() -> None:
    incoming = _clip(
        "b",
        "v",
        2,
        4,
        sourceStart=8.0,
        effects=[
            {
                "id": "b__transition",
                "type": "transition",
                "params": {"kind": "glitch", "durationSeconds": 0.5, "fromClipId": "a"},
            }
        ],
    )
    project = _project(
        [{"id": "v", "type": "video", "clips": [_clip("a", "v", 0, 2, sourceStart=3.0), incoming]}]
    )
    plan = frame_plan_at(project, 2.25, source_fps={"land": _FPS})
    underlay, clip = plan.layers
    assert (underlay.role, underlay.clip_id, underlay.for_clip_id) == ("underlay", "a", "b")
    assert underlay.source is not None
    # `a` ends at source 5.0, so the ramp shows what follows it: 5.0 + 0.25.
    assert underlay.source.time == 0.25 + 5.0
    assert clip.transitions[0].to_json() == {
        "role": "in",
        "kind": "glitch",
        "path": "catalog",
        "renderKind": "glitch",
        "progress": 0.5,
        "eased": clip.transitions[0].eased,
    }


def test_an_under_layer_with_no_handle_holds_the_edge_frame() -> None:
    neighbour = Clip.model_validate(_clip("a", "v", 0, 2, sourceStart=18.0))
    material = underlay_material(neighbour, "in", (2.0, 2.5), _ASSET_SECONDS)
    assert material.mode == "hold"
    assert material.edge_time == pytest.approx(_ASSET_SECONDS - 1e-3)


def test_audio_only_timeline_gets_the_compilers_black_stand_in() -> None:
    project = _project(
        [{"id": "a", "type": "audio", "clips": [_clip("m", "a", 0, 3, assetId="music")]}]
    )
    assert _ids(project, 1.0) == [("solid", "clip", None)]
    assert _ids(project, 3.0) == []


def test_frame_effects_follow_the_timeline_apply_order() -> None:
    def lane(track_id: str, layer_id: str) -> dict[str, Any]:
        return {
            "id": track_id,
            "type": "effect",
            "clips": [],
            "effectLayers": [
                {
                    "id": layer_id,
                    "effectId": "soft-veil",
                    "kind": "blur-gaussian",
                    "start": 0,
                    "end": 4,
                    "params": {"radius": 4},
                }
            ],
        }

    project = _project(
        [
            lane("top", "fx-top"),
            {"id": "v", "type": "video", "clips": [_clip("p", "v", 0, 4)]},
            lane("bottom", "fx-bottom"),
        ]
    )
    plan = frame_plan_at(project, 1.0)
    assert [entry["layerId"] for entry in plan.frame_effects] == ["fx-bottom", "fx-top"]


def test_a_non_finite_time_is_refused() -> None:
    with pytest.raises(FramePlanError):
        frame_plan_at(_project([]), float("nan"))


def test_frame_index_matches_moviepys_reader_rule() -> None:
    assert source_frame_index(1.0, 30.0) == 30
    # 2.9999999 * 30 is a hair under 90; MoviePy's nudge rounds it to frame 90.
    assert source_frame_index(2.9999999999, 30.0) == 90
    assert source_frame_index(None, 30.0) is None


def test_variable_rate_frame_index_is_the_last_pts_at_or_before_the_time() -> None:
    times = [0.0, 0.04, 0.1, 0.25]
    assert source_frame_index(0.0, 30.0, times) == 0
    assert source_frame_index(0.0999995, 30.0, times) == 2
    assert source_frame_index(0.2, None, times) == 2
    assert source_frame_index(9.0, 30.0, times) == 3
    assert source_frame_index(-1.0, 30.0, times) == 0


# ---------------------------------------------------------------------------
# The plan's source time is the export's source time, float for float
# ---------------------------------------------------------------------------


def _recording_source(requested: list[float]) -> Any:
    from moviepy import VideoClip

    def frame(t: float) -> np.ndarray:
        requested.append(t)
        return np.zeros((2, 2, 3), dtype=np.uint8)

    clip = VideoClip(frame_function=frame).with_duration(_ASSET_SECONDS)
    clip.fps = _FPS
    return clip


_RAMP = [
    {"id": "p0", "sourceTime": 0.0, "rate": 1.0, "easing": "ease-in-out"},
    {"id": "p1", "sourceTime": 1.0, "rate": 3.0},
]


@pytest.mark.parametrize(
    ("speed", "span", "ramp"),
    [
        (None, 2.0, None),
        (1.0, 2.0, None),
        (0.5, 1.0, None),
        (2.0, 4.0, None),
        (0.0, 0.5, None),
        (-1.0, 2.0, None),
        (-2.0, 4.0, None),
        (None, 2.0, _RAMP),
    ],
)
def test_source_time_is_what_the_compilers_time_chain_asks_the_reader_for(
    speed: float | None, span: float, ramp: list[dict[str, Any]] | None
) -> None:
    fields = _clip("c", "v", 0.0, 2.0, sourceStart=3.37)
    fields["sourceEnd"] = 3.37 + span
    if speed is not None:
        fields["speed"] = speed
    if ramp is not None:
        fields["speedRamp"] = ramp
    clip = Clip.model_validate(fields)
    for local in (0.0, 0.1, 0.5, 1.25, 1.9):
        requested: list[float] = []
        chained = _apply_speed(_subclipped_source(_recording_source(requested), clip), clip)
        chained.get_frame(local)
        expected = video_source_time(clip, local, _FPS, _ASSET_SECONDS)
        assert requested[-1] == expected, (speed, ramp is not None, local)


def _rect_mask(mask_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": mask_id,
        "kind": "rectangle",
        "cx": 960,
        "cy": 540,
        "width": 400,
        "height": 300,
        **extra,
    }


def test_plan_carries_the_enabled_v22_mask_stack_in_order() -> None:
    masks = [
        _rect_mask("top", mode="add"),
        _rect_mask("off", enabled=False),
        _rect_mask("grade", mode="subtract", target={"kind": "effect", "effectId": "g1"}),
    ]
    project = _project(
        [{"id": "v", "type": "video", "clips": [_clip("c", "v", 0.0, 4.0, masks=masks)]}]
    )
    layer = frame_plan_at(project, 1.0).layers[0]
    assert layer.mask is not None
    assert [entry["id"] for entry in layer.mask["layers"]] == ["top", "grade"]
    assert layer.mask["layers"][1]["target"] == {"kind": "effect", "effectId": "g1"}
    assert layer.mask["sourceTime"] == 1.0


def test_a_clip_whose_masks_are_all_disabled_plans_unmasked() -> None:
    clip = _clip("c", "v", 0.0, 4.0, masks=[_rect_mask("off", enabled=False)])
    project = _project([{"id": "v", "type": "video", "clips": [clip]}])
    assert frame_plan_at(project, 1.0).layers[0].mask is None


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"speed": 2.0, "end": 2.0},
        {"speed": -1.0},
        {"speed": 0.0},
        {"speedRamp": _RAMP},
    ],
)
def test_mask_source_time_is_the_compilers_mask_clock(extra: dict[str, Any]) -> None:
    from framepilot_engine.render.masks import clip_source_clock

    fields = dict(extra)
    end = float(fields.pop("end", 4.0))
    raw = _clip("c", "v", 0.0, end, sourceStart=2.0, **fields)
    raw["sourceEnd"] = 6.0
    clip = Clip.model_validate(raw)
    clock = clip_source_clock(clip)
    for local in (0.0, 0.25, 1.5):
        assert mask_source_time(clip, local) == clock(local)
