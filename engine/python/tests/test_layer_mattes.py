"""Track mattes and text as a mask (MK8.2): the ``layer`` mask kind in the export.

Unit tests pin the mapping (where a clip's pixel lands on the frame) and the channels; the
compile tests render real timelines — video inside text, a luma matte from another clip, a whole
track as the matte, a scaled target — and check the picture, including that the matte source is
never drawn itself.
"""

from __future__ import annotations

import itertools
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render.compiler import CompileError, compile_timeline
from framepilot_engine.render.frame_plan import frame_plan_at
from framepilot_engine.render.layer_mattes import (
    LayerMatteFrame,
    LayerMatteRefusal,
    PicturePlacement,
    assert_layer_sources,
    matte_channel,
    sample_positions,
    sampled_channel,
)
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Project
from framepilot_engine.timeline.synthetic_assets import CAPTION_ASSET_ID, SHAPE_ASSET_ID
from tests.matte_fixtures import write_source

WIDTH, HEIGHT, FPS = 96, 72, 30
SECONDS = 0.4
RED = (220, 30, 30)
BLUE = (20, 40, 210)


# --- Mapping and channels -------------------------------------------------------------------


def test_an_unscaled_picture_reads_the_frame_pixel_under_each_pixel() -> None:
    xi, yi, valid = sample_positions(PicturePlacement(8, 6, 8, 6, 0.0, 3, -2), 20, 10)
    assert xi[0].tolist() == list(range(3, 11))
    assert yi[:, 0].tolist() == [-2, -1, 0, 1, 2, 3]
    assert valid[:2].sum() == 0 and bool(valid[2:].all())


def test_a_resized_picture_reads_where_its_pixel_centres_land() -> None:
    xi, yi, _ = sample_positions(PicturePlacement(4, 2, 8, 4, 0.0, 0, 0), 8, 4)
    # Centre 0.5 of a 4-wide raster lands at 1.0 of an 8-wide one: pixel 1, then 3, 5, 7.
    assert xi[0].tolist() == [1, 3, 5, 7]
    assert yi[:, 0].tolist() == [1, 3]


def test_a_rotated_picture_turns_counter_clockwise_about_its_centre() -> None:
    placement = PicturePlacement(10, 10, 10, 10, 90.0, 0, 0)
    xi, yi, _ = sample_positions(placement, 10, 10)
    # PIL's counter-clockwise quarter turn: the top-right corner goes to the top-left.
    assert (int(xi[0, 9]), int(yi[0, 9])) == (0, 0)
    # The top-left goes to the bottom-left.
    assert (int(xi[0, 0]), int(yi[0, 0])) == (0, 9)


def test_channels_read_alpha_and_luma_over_black_and_invert_after_sampling() -> None:
    rgb = np.zeros((2, 2, 3), dtype=np.uint8)
    rgb[0, 0] = (255, 255, 255)
    rgb[0, 1] = (255, 0, 0)
    alpha = np.array([[1.0, 0.5], [0.0, 1.0]])
    frame = LayerMatteFrame(rgb=rgb, alpha=alpha)
    assert matte_channel(frame, "alpha").tolist() == alpha.tolist()
    luma = matte_channel(frame, "luma")
    assert luma[0, 0] == pytest.approx(1.0)
    assert luma[0, 1] == pytest.approx(0.2126 * 0.5)
    assert luma[1, 1] == 0.0
    # Off the frame there is nothing: 0, and 1 once inverted.
    outside = PicturePlacement(2, 2, 2, 2, 0.0, 5, 5)
    assert sampled_channel(frame, "alpha", outside).tolist() == [[0.0, 0.0], [0.0, 0.0]]
    assert sampled_channel(frame, "inverted-alpha", outside).tolist() == [[1.0, 1.0], [1.0, 1.0]]


# --- Compiled timelines ---------------------------------------------------------------------


def _solid(colour: tuple[int, int, int]) -> list[np.ndarray]:
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    frame[:, :] = colour
    return [frame.copy() for _ in range(round(SECONDS * FPS))]


def _ramp() -> list[np.ndarray]:
    """A left-to-right grey ramp, black at the left edge, white at the right."""
    level = np.round(np.linspace(0, 255, WIDTH)).astype(np.uint8)
    frame = np.repeat(np.repeat(level[None, :, None], HEIGHT, axis=0), 3, axis=2)
    return [frame.copy() for _ in range(round(SECONDS * FPS))]


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root: Path = tmp_path_factory.mktemp("layer-mattes")
    write_source(root / "red.mkv", _solid(RED), fps=str(FPS))
    write_source(root / "blue.mkv", _solid(BLUE), fps=str(FPS))
    write_source(root / "ramp.mkv", _ramp(), fps=str(FPS))
    return root


def _clip(clip_id: str, asset: str, track: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": clip_id,
        "assetId": asset,
        "trackId": track,
        "start": 0.0,
        "end": SECONDS,
        "sourceStart": 0.0,
        "sourceEnd": SECONDS,
        "effects": [],
        **extra,
    }


def _text(clip_id: str, track: str, text: str = "HI") -> dict[str, Any]:
    return {
        "id": clip_id,
        "assetId": "__text__",
        "trackId": track,
        "start": 0.0,
        "end": SECONDS,
        "sourceStart": 0.0,
        "sourceEnd": SECONDS,
        "effects": [
            {
                "id": f"{clip_id}__t",
                "type": "text",
                "params": {"text": text, "fontSize": 60, "color": "#ffffff", "bold": True},
            }
        ],
    }


def _layer(source: dict[str, str], channel: str = "alpha", **extra: Any) -> dict[str, Any]:
    return {"kind": "layer", "id": "tm", "source": source, "channel": channel, **extra}


def _project(tracks: list[dict[str, Any]]) -> Project:
    return Project.model_validate(
        {
            "id": "layer-mattes",
            "name": "layer mattes",
            "fps": FPS,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                {
                    "id": name,
                    "path": f"{name}.mkv",
                    "kind": "video",
                    "media": {"width": WIDTH, "height": HEIGHT},
                }
                for name in ("red", "blue", "ramp")
            ],
            "timeline": {"tracks": tracks},
        }
    )


def _render(project: Project, root: Path, t: float = 0.2) -> np.ndarray:
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], root)
    composite = compile_timeline(project, index, frame_target(WIDTH, HEIGHT, FPS))
    try:
        return np.asarray(composite.get_frame(t), dtype=np.int64)
    finally:
        close_clip_tree(composite)


def _is(pixel: np.ndarray, colour: tuple[int, int, int]) -> bool:
    return bool(np.abs(pixel - np.array(colour)).max() <= 3)


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize("title_lane", ["video", "overlay"])
def test_video_inside_text_shows_the_clip_only_through_the_letters(
    media: Path, title_lane: str
) -> None:
    # AL31a: a title made by add_text_layer sits on an OVERLAY lane; it is as much a picture as
    # one parked on a video lane, and the export used to refuse it as "a track with no picture".
    project = _project(
        [
            {"id": "titles", "type": title_lane, "clips": [_text("title", "titles")]},
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    _clip("fill", "red", "v1", masks=[_layer({"kind": "clip", "clipId": "title"})])
                ],
            },
            {"id": "v2", "type": "video", "clips": [_clip("base", "blue", "v2")]},
        ]
    )
    frame = _render(project, media)
    reds = sum(_is(frame[y, x], RED) for y in range(HEIGHT) for x in range(WIDTH))
    blues = sum(_is(frame[y, x], BLUE) for y in range(HEIGHT) for x in range(WIDTH))
    whites = int((frame.min(axis=2) > 200).sum())
    # The letters show the red clip, the rest the blue base, and the title itself is not drawn.
    assert reds > 150, reds
    assert blues > WIDTH * HEIGHT // 2, blues
    assert whites == 0
    # The frame plan says the same: the title is a matte, not a composited layer.
    plan = frame_plan_at(project, 0.2, target=(WIDTH, HEIGHT)).to_json()
    title = next(layer for layer in plan["layers"] if layer["clipId"] == "title")
    assert title["matteOnly"] is True
    fill = next(layer for layer in plan["layers"] if layer["clipId"] == "fill")
    assert fill["mask"]["layers"][0]["layer"] == {
        "source": {"kind": "clip", "clipId": "title"},
        "channel": "alpha",
    }
    assert "matteOnly" not in fill


@pytest.mark.usefixtures("require_ffprobe")
def test_a_luma_matte_from_a_track_ramps_the_clip_in_and_inverted_ramps_it_out(
    media: Path,
) -> None:
    def project(channel: str) -> Project:
        return _project(
            [
                {"id": "matte", "type": "video", "clips": [_clip("ramp", "ramp", "matte")]},
                {
                    "id": "v1",
                    "type": "video",
                    "clips": [
                        _clip(
                            "fill",
                            "red",
                            "v1",
                            masks=[_layer({"kind": "track", "trackId": "matte"}, channel)],
                        )
                    ],
                },
                {"id": "v2", "type": "video", "clips": [_clip("base", "blue", "v2")]},
            ]
        )

    luma = _render(project("luma"), media)
    inverted = _render(project("inverted-luma"), media)
    row = HEIGHT // 2
    # Left (black matte): the blue base; right (white matte): the red clip. Inverted: reversed.
    assert _is(luma[row, 1], BLUE) and _is(luma[row, WIDTH - 2], RED)
    assert _is(inverted[row, 1], RED) and _is(inverted[row, WIDTH - 2], BLUE)
    # In between, red rises monotonically with the ramp's luma.
    reds = luma[row, :, 0]
    assert all(b >= a - 1 for a, b in itertools.pairwise(reds))


@pytest.mark.usefixtures("require_ffprobe")
def test_a_scaled_target_reads_the_matte_where_its_pixels_land(media: Path) -> None:
    project = _project(
        [
            {"id": "matte", "type": "video", "clips": [_clip("ramp", "ramp", "matte")]},
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    _clip(
                        "fill",
                        "red",
                        "v1",
                        keyframes=[
                            {"id": "s", "time": 0.0, "property": "scale", "value": 0.5},
                            {"id": "x", "time": 0.0, "property": "x", "value": 20},
                        ],
                        masks=[_layer({"kind": "clip", "clipId": "ramp"}, "luma")],
                    )
                ],
            },
            {"id": "v2", "type": "video", "clips": [_clip("base", "blue", "v2")]},
        ]
    )
    frame = _render(project, media)
    row = HEIGHT // 2
    # The half-size clip spans x 44..91; its opacity at each frame column is the ramp's luma
    # AT THAT COLUMN, not at the clip's own local column.
    for x in (50, 70, 88):
        expected = (x + 0.5) / WIDTH  # the ramp's level at column x, as a fraction
        red = frame[row, x, 0]
        mixed = BLUE[0] + (RED[0] - BLUE[0]) * expected
        assert abs(red - mixed) <= 8, (x, red, mixed)


def _growing(prop: str) -> list[dict[str, Any]]:
    return [
        {"id": "g0", "time": 0.0, "property": prop, "value": 0.4},
        {"id": "g1", "time": SECONDS, "property": prop, "value": 1.0},
    ]


def _through_window(window: dict[str, Any], lane: str = "video") -> Project:
    """A red clip cut by ``window`` (alpha, on a ``lane``-type track) over a blue base."""
    return _project(
        [
            {"id": "matte", "type": lane, "clips": [window]},
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    _clip("fill", "red", "v1", masks=[_layer({"kind": "clip", "clipId": "window"})])
                ],
            },
            {"id": "v2", "type": "video", "clips": [_clip("base", "blue", "v2")]},
        ]
    )


def _red_columns(frame: np.ndarray) -> tuple[int, int] | None:
    reds = [x for x in range(WIDTH) if _is(frame[HEIGHT // 2, x], RED)]
    return (reds[0], reds[-1]) if reds else None


@pytest.mark.usefixtures("require_ffprobe")
def test_an_animated_matte_source_opens_the_clip_through_a_growing_window(media: Path) -> None:
    # The matte is the source as drawn at each instant, so the source's own keyframes move it:
    # a window that scales 0.4 -> 1.0 reveals the clip from a centre rectangle to the full frame
    # (the "shape-mask opener" the agent is told it can build from add_shape + mask_with_layer).
    # AL31: an opaque source's matte kept its first frame's size and slid off the middle row.
    project = _through_window(_clip("window", "blue", "matte", keyframes=_growing("scale")))
    spans = [_red_columns(_render(project, media, t=t)) for t in (0.0, 0.1, 0.2, 0.3)]
    widths = [0 if span is None else span[1] - span[0] for span in spans]
    assert widths == sorted(widths) and widths[0] < widths[-1], spans
    early = _render(project, media, t=0.0)
    late = _render(project, media, t=SECONDS - 1 / FPS)
    row, edge, centre = HEIGHT // 2, 6, WIDTH // 2
    assert _is(early[row, centre], RED) and _is(early[row, edge], BLUE)
    assert _is(late[row, centre], RED) and _is(late[row, edge], RED)


@pytest.mark.usefixtures("require_ffprobe")
def test_a_matte_source_stretching_wider_opens_the_clip_sideways(media: Path) -> None:
    # A stretch (scaleX) resizes the source per frame the same way a scale does.
    project = _through_window(_clip("window", "blue", "matte", keyframes=_growing("scaleX")))
    early = _render(project, media, t=0.0)
    late = _render(project, media, t=SECONDS - 1 / FPS)
    row, edge, centre = HEIGHT // 2, 6, WIDTH // 2
    assert _is(early[row, centre], RED) and _is(early[row, edge], BLUE)
    assert _is(early[2, centre], RED), "a horizontal stretch keeps the full height"
    assert _is(late[row, edge], RED) and _is(late[row, WIDTH - 1 - edge], RED)


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize("shape_lane", ["video", "overlay"])
def test_a_growing_shape_matte_opens_the_clip_with_it(media: Path, shape_lane: str) -> None:
    # The advertised case: a shape (drawn with its own alpha) growing on the matte track. On an
    # overlay lane it is exactly what add_shape makes (AL31a: that lane used to be refused).
    shape = {
        **_clip("window", SHAPE_ASSET_ID, "matte", keyframes=_growing("scale")),
        "effects": [
            {
                "id": "window__shape",
                "type": "shape",
                "params": {
                    "shape": "rounded-rect",
                    "x": 50,
                    "y": 50,
                    "width": 60,
                    "height": 40,
                    "fill": "#FFFFFF",
                    "stroke": None,
                    "strokeWidth": 1,
                    "strokeStyle": "solid",
                    "cornerRadius": 0,
                },
                "keyframes": [],
            }
        ],
    }
    project = _through_window(shape, shape_lane)
    early = _render(project, media, t=0.0)
    late = _render(project, media, t=SECONDS - 1 / FPS)
    # At full size the box spans columns 27-68 of the middle row; at 0.4 it is a centre sliver.
    row, centre, inside = HEIGHT // 2, WIDTH // 2, 30
    assert _is(early[row, centre], RED) and _is(early[row, inside], BLUE)
    assert _is(late[row, inside], RED) and _is(late[row, 6], BLUE)
    # The shape is only the matte: nowhere is it drawn white on its own.
    assert int((late.min(axis=2) > 200).sum()) == 0
    plan = frame_plan_at(project, 0.2, target=(WIDTH, HEIGHT)).to_json()
    window = next(layer for layer in plan["layers"] if layer["clipId"] == "window")
    assert window["matteOnly"] is True


def test_a_track_matte_that_loops_back_is_refused_before_rendering(media: Path) -> None:
    project = _project(
        [
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    _clip("a", "red", "v1", masks=[_layer({"kind": "clip", "clipId": "b"})]),
                ],
            },
            {
                "id": "v2",
                "type": "video",
                "clips": [
                    _clip("b", "blue", "v2", masks=[_layer({"kind": "clip", "clipId": "a"})]),
                ],
            },
        ]
    )
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], media)
    with pytest.raises(CompileError, match="lead back to it"):
        compile_timeline(project, index, frame_target(WIDTH, HEIGHT, FPS))


def _audio_project(source: dict[str, str]) -> Project:
    """A red clip whose track matte reads ``source``; a song on an audio lane, a caption cue."""
    return Project.model_validate(
        {
            "id": "layer-mattes-no-picture",
            "name": "no picture",
            "fps": FPS,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                {"id": "red", "path": "red.mkv", "kind": "video"},
                {"id": "song", "path": "song.wav", "kind": "audio"},
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "v1",
                        "type": "video",
                        "clips": [_clip("fill", "red", "v1", masks=[_layer(source)])],
                    },
                    {"id": "a1", "type": "audio", "clips": [_clip("song", "song", "a1")]},
                    # A song parked on a picture lane still draws nothing.
                    {"id": "o1", "type": "overlay", "clips": [_clip("stray", "song", "o1")]},
                    {
                        "id": "c1",
                        "type": "caption",
                        "clips": [_clip("cue", CAPTION_ASSET_ID, "c1")],
                    },
                ]
            },
        }
    )


@pytest.mark.parametrize(
    "source",
    [
        {"kind": "track", "trackId": "a1"},
        {"kind": "clip", "clipId": "song"},
        {"kind": "clip", "clipId": "stray"},
        {"kind": "clip", "clipId": "cue"},
        {"kind": "track", "trackId": "c1"},
    ],
    ids=["audio-track", "audio-clip", "audio-on-overlay", "caption-cue", "caption-track"],
)
def test_a_track_matte_reading_no_picture_is_refused_before_rendering(
    source: dict[str, str],
) -> None:
    # Audio draws nothing, and a caption cue is burned over the whole frame by its own pass, not
    # drawn in its lane's place, so neither can be a matte source; the remedy names what can.
    with pytest.raises(LayerMatteRefusal, match="no picture") as refused:
        assert_layer_sources(_audio_project(source))
    assert "video or overlay track" in str(refused.value)


def test_overlay_sources_pass_the_export_check() -> None:
    # The source check itself, without media: a title and a shape on overlay lanes are pictures.
    project = _project(
        [
            {"id": "titles", "type": "overlay", "clips": [_text("title", "titles")]},
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    _clip(
                        "fill", "red", "v1", masks=[_layer({"kind": "track", "trackId": "titles"})]
                    )
                ],
            },
        ]
    )
    assert_layer_sources(project)
