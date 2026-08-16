"""Preview/render parity for generated tracks and masks (closure plan C4).

A tracked edit that only exists as keyframes in the project file is not a
tracked edit. These tests render the real compositor and inspect the resulting
pixels, so "the track was applied" means the picture actually moved.

Each positive case is paired with a negative control: the same measurement is
compared against a plausible but wrong expectation, which must fail. Without
that pairing a test proves only that *something* happened, not that the right
thing did.
"""

from __future__ import annotations

import io
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.timeline.models import Project

WIDTH, HEIGHT = 320, 240
CLIP_SECONDS = 2.0
# The overlay is half the frame wide, so its edges are unambiguous after JPEG.
OVERLAY_SIZE = "160x120"


#: The overlay is held well inside the frame so its centroid is never clipped by
#: the frame edge — a clipped centroid would under-report the real travel and
#: quietly weaken every assertion below.
OVERLAY_SCALE = 0.3


def _project(
    overlay_keyframes: list[dict[str, Any]], *, hold_scale: bool = True
) -> Project:
    """A blue background with a small green overlay animated by ``overlay_keyframes``."""
    return Project.model_validate(
        {
            "id": "p_track_parity",
            "name": "Track parity",
            "fps": 30,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                {"id": "bg", "path": "bg.mp4", "kind": "video"},
                {"id": "fg", "path": "fg.mp4", "kind": "video"},
            ],
            "timeline": {
                # Track 0 is the FRONT layer in this compositor (compiler.py:
                # "back→front means last track first, track 0 (front) last"), so
                # the overlay must come first or the background would hide it.
                "tracks": [
                    {
                        "id": "v1",
                        "type": "video",
                        "clips": [
                            {
                                "id": "overlay",
                                "assetId": "fg",
                                "trackId": "v1",
                                "start": 0.0,
                                "end": CLIP_SECONDS,
                                "sourceStart": 0.0,
                                "sourceEnd": CLIP_SECONDS,
                                "keyframes": [
                                    *(_scale_keyframes() if hold_scale else []),
                                    *overlay_keyframes,
                                ],
                            }
                        ],
                    },
                    {
                        "id": "v2",
                        "type": "video",
                        "clips": [
                            {
                                "id": "background",
                                "assetId": "bg",
                                "trackId": "v2",
                                "start": 0.0,
                                "end": CLIP_SECONDS,
                                "sourceStart": 0.0,
                                "sourceEnd": CLIP_SECONDS,
                            }
                        ],
                    },
                ]
            },
        }
    )


def _scale_keyframes() -> list[dict[str, Any]]:
    return [
        {
            "id": "ks0",
            "property": "scale",
            "time": 0.0,
            "value": OVERLAY_SCALE,
            "easing": "linear",
        },
    ]


def _follow_keyframes(start_x: float, end_x: float) -> list[dict[str, Any]]:
    """The x points `planTrackFollow` emits, in the engine's keyframe form."""
    return [
        {"id": "kx0", "property": "x", "time": 0.0, "value": start_x, "easing": "linear"},
        {
            "id": "kx1",
            "property": "x",
            "time": CLIP_SECONDS,
            "value": end_x,
            "easing": "linear",
        },
    ]


@pytest.fixture
def media(media_factory: Callable[..., Path], tmp_project_dir: Path) -> Path:
    for name, color, size in (
        ("bg.mp4", "blue", f"{WIDTH}x{HEIGHT}"),
        ("fg.mp4", "green", OVERLAY_SIZE),
    ):
        source = media_factory(name, seconds=CLIP_SECONDS, with_audio=False, color=color, size=size)
        (tmp_project_dir / name).write_bytes(source.read_bytes())
    return tmp_project_dir


def _overlay_centre_x(project: Project, base: Path, time_seconds: float) -> float:
    """Horizontal centroid, in pixels, of the green overlay in a rendered frame."""
    pytest.importorskip("PIL")
    import numpy as np
    from PIL import Image

    grabbed = grab_frame(project, base, time_seconds, max_dimension=WIDTH, image_format="png")
    frame = np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("RGB")).astype(int)
    # Green overlay against a blue background: green dominant, blue is not.
    green = (frame[..., 1] > frame[..., 2] + 30) & (frame[..., 1] > frame[..., 0] + 30)
    assert green.any(), "the overlay was not visible in the rendered frame at all"
    columns = np.nonzero(green.any(axis=0))[0]
    return float((columns.min() + columns.max()) / 2)


def test_a_generated_track_moves_real_pixels(media: Path) -> None:
    """The whole point: follow keyframes must move the picture, not just the file."""
    shift = 60.0
    project = _project(_follow_keyframes(0.0, shift))

    start = _overlay_centre_x(project, media, 0.0)
    end = _overlay_centre_x(project, media, CLIP_SECONDS - 1e-3)

    assert end - start == pytest.approx(shift, abs=4.0), (
        "the rendered overlay did not travel the distance the track asked for"
    )


def test_a_wrong_trajectory_fails_the_same_measurement(media: Path) -> None:
    """Negative control: the measurement must reject a plausible wrong answer."""
    project = _project(_follow_keyframes(0.0, 60.0))

    start = _overlay_centre_x(project, media, 0.0)
    end = _overlay_centre_x(project, media, CLIP_SECONDS - 1e-3)

    travelled = end - start
    # The mirrored trajectory is exactly as plausible as the real one on paper.
    assert travelled != pytest.approx(-60.0, abs=4.0)
    # So is "the overlay never moved".
    assert travelled != pytest.approx(0.0, abs=4.0)


def test_a_static_clip_stays_put(media: Path) -> None:
    """Control for the measurement itself: no keyframes must mean no movement."""
    project = _project([])

    start = _overlay_centre_x(project, media, 0.0)
    end = _overlay_centre_x(project, media, CLIP_SECONDS - 1e-3)

    assert end - start == pytest.approx(0.0, abs=1.0)


def test_the_render_follows_the_track_continuously(media: Path) -> None:
    """Mid-track frames must land in between, not jump at the ends."""
    project = _project(_follow_keyframes(0.0, 80.0))

    start = _overlay_centre_x(project, media, 0.0)
    middle = _overlay_centre_x(project, media, CLIP_SECONDS / 2)
    end = _overlay_centre_x(project, media, CLIP_SECONDS - 1e-3)

    assert start < middle < end
    assert middle - start == pytest.approx(end - middle, abs=6.0)


def _overlay_pixel_count(project: Project, base: Path, time_seconds: float) -> int:
    """How many pixels of the green overlay are visible in a rendered frame."""
    pytest.importorskip("PIL")
    import numpy as np
    from PIL import Image

    grabbed = grab_frame(project, base, time_seconds, max_dimension=WIDTH, image_format="png")
    frame = np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("RGB")).astype(int)
    green = (frame[..., 1] > frame[..., 2] + 30) & (frame[..., 1] > frame[..., 0] + 30)
    return int(green.sum())


def _property_keyframes(name: str, start: float, end: float) -> list[dict[str, Any]]:
    return [
        {"id": f"{name}0", "property": name, "time": 0.0, "value": start, "easing": "linear"},
        {
            "id": f"{name}1",
            "property": name,
            "time": CLIP_SECONDS,
            "value": end,
            "easing": "linear",
        },
    ]


def test_scale_changes_how_many_pixels_the_clip_covers(media: Path) -> None:
    """Scale is a claim about area; area is what the measurement checks."""
    # `hold_scale=False`: the fixture's own constant scale keyframe would sit at
    # the same time as this one, and a duplicate keyframe silently wins.
    project = _project(_property_keyframes("scale", 0.2, 0.4), hold_scale=False)

    small = _overlay_pixel_count(project, media, 0.0)
    large = _overlay_pixel_count(project, media, CLIP_SECONDS - 1e-3)

    assert small > 0
    # Doubling the linear scale quadruples area; allow for edge antialiasing.
    assert large > small * 3


def test_opacity_actually_dissolves_the_clip(media: Path) -> None:
    project = _project(_property_keyframes("opacity", 1.0, 0.0))

    opaque = _overlay_pixel_count(project, media, 0.0)
    faded = _overlay_pixel_count(project, media, CLIP_SECONDS - 1e-3)

    assert opaque > 0
    # Fully faded out, the green test can no longer find the overlay at all.
    assert faded < opaque // 4


def test_a_wrong_scale_direction_fails_the_same_measurement(media: Path) -> None:
    """Negative control: shrinking must not read as growing."""
    project = _project(_property_keyframes("scale", 0.4, 0.2), hold_scale=False)

    first = _overlay_pixel_count(project, media, 0.0)
    last = _overlay_pixel_count(project, media, CLIP_SECONDS - 1e-3)

    assert last < first


def _overlay_bounds(project: Project, base: Path, time_seconds: float) -> tuple[int, int, int, int]:
    """Bounding box of the green overlay: (left, right, top, bottom) in pixels."""
    pytest.importorskip("PIL")
    import numpy as np
    from PIL import Image

    grabbed = grab_frame(project, base, time_seconds, max_dimension=WIDTH, image_format="png")
    frame = np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("RGB")).astype(int)
    green = (frame[..., 1] > frame[..., 2] + 30) & (frame[..., 1] > frame[..., 0] + 30)
    assert green.any(), "the overlay was not visible at all"
    columns = np.nonzero(green.any(axis=0))[0]
    rows = np.nonzero(green.any(axis=1))[0]
    return int(columns.min()), int(columns.max()), int(rows.min()), int(rows.max())


def test_rotation_actually_turns_the_picture(media: Path) -> None:
    """Rotation is measured as a change in shape, not in bounding-box extent.

    The compiler rotates with ``expand=False`` so the frame size stays constant
    for its centering maths, which means a turned rectangle cannot grow its box —
    its corners are clipped instead. Measuring extent would therefore report "no
    rotation" for a render that genuinely rotated, so the visible area is what is
    measured: turning a rectangle inside a fixed box loses corner pixels.
    """
    project = _project(_property_keyframes("rotation", 0.0, 45.0))

    upright = _overlay_pixel_count(project, media, 0.0)
    turned = _overlay_pixel_count(project, media, CLIP_SECONDS - 1e-3)

    assert upright > 0
    assert turned < upright * 0.9, "the render did not actually turn the picture"


def test_no_rotation_leaves_the_shape_alone(media: Path) -> None:
    """Control: the same measurement must not report a turn that never happened."""
    project = _project(_property_keyframes("rotation", 0.0, 0.0))

    first = _overlay_pixel_count(project, media, 0.0)
    last = _overlay_pixel_count(project, media, CLIP_SECONDS - 1e-3)

    assert last == pytest.approx(first, rel=0.02)


def _eased_keyframes(easing: str) -> list[dict[str, Any]]:
    return [
        {"id": "e0", "property": "x", "time": 0.0, "value": 0.0, "easing": easing},
        {"id": "e1", "property": "x", "time": CLIP_SECONDS, "value": 80.0, "easing": easing},
    ]


def test_easing_changes_the_path_not_just_the_endpoints(media: Path) -> None:
    """Easing is a claim about the middle of a move, so the middle is measured."""
    linear = _project(_eased_keyframes("linear"))
    eased = _project(_eased_keyframes("ease-in-out"))

    quarter = CLIP_SECONDS / 4
    linear_quarter = _overlay_centre_x(linear, media, quarter)
    eased_quarter = _overlay_centre_x(eased, media, quarter)

    # Ease-in-out starts slowly, so a quarter of the way through it must still be
    # behind the linear move — while both land in the same place at the end.
    assert eased_quarter < linear_quarter - 2
    assert _overlay_centre_x(eased, media, CLIP_SECONDS - 1e-3) == pytest.approx(
        _overlay_centre_x(linear, media, CLIP_SECONDS - 1e-3), abs=4.0
    )


def _project_with_grade(params: dict[str, Any]) -> Project:
    """The same fixture, with a colour grade on the overlay clip."""
    project = _project([])
    overlay = project.timeline.tracks[0].clips[0]
    overlay.effects = [
        type(overlay).model_fields["effects"].annotation.__args__[0].model_validate(  # type: ignore[union-attr]
            {"id": "grade", "type": "color_grade", "params": params}
        )
    ]
    return project


def _overlay_channel_means(project: Project, base: Path, time_seconds: float) -> tuple[float, ...]:
    """Mean R/G/B of the overlay region in a rendered frame."""
    pytest.importorskip("PIL")
    import numpy as np
    from PIL import Image

    grabbed = grab_frame(project, base, time_seconds, max_dimension=WIDTH, image_format="png")
    frame = np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("RGB")).astype(float)
    # The overlay covers the centre; sample it rather than the background so the
    # measurement reads the graded clip and not the untouched layer beneath it.
    centre = frame[
        HEIGHT // 2 - 10 : HEIGHT // 2 + 10,
        WIDTH // 2 - 10 : WIDTH // 2 + 10,
    ]
    return tuple(float(centre[..., channel].mean()) for channel in range(3))


def test_exposure_actually_changes_rendered_levels(media: Path) -> None:
    """A grade is a claim about pixel values, so pixel values are what is read."""
    flat = _overlay_channel_means(_project_with_grade({}), media, 0.5)
    lifted = _overlay_channel_means(_project_with_grade({"exposure": 0.4}), media, 0.5)

    assert sum(lifted) > sum(flat) + 10, "the grade did not reach the rendered pixels"


def test_a_darkening_grade_does_not_read_as_a_lift(media: Path) -> None:
    """Negative control: the same measurement must reject the opposite claim."""
    flat = _overlay_channel_means(_project_with_grade({}), media, 0.5)
    darkened = _overlay_channel_means(_project_with_grade({"exposure": -0.4}), media, 0.5)

    assert sum(darkened) < sum(flat) - 10


def test_saturation_pulls_the_channels_together(media: Path) -> None:
    """Saturation is a relationship between channels, not overall brightness.

    Note the fixture constraint this exposed: the overlay is pure green, so a
    *temperature* grade cannot be measured on it at all — warming scales the red
    and blue channels, and scaling zero leaves zero. A test written against it
    would have read "the grade did nothing" for a perfectly working grade.
    Saturation moves the channels this patch actually has.
    """
    flat = _overlay_channel_means(_project_with_grade({}), media, 0.5)
    desaturated = _overlay_channel_means(_project_with_grade({"saturation": -0.9}), media, 0.5)

    def spread(means: tuple[float, ...]) -> float:
        return max(means) - min(means)

    assert spread(desaturated) < spread(flat) - 5, "desaturation did not reach the pixels"


def test_an_identity_grade_changes_nothing(media: Path) -> None:
    """Control for the measurement itself."""
    first = _overlay_channel_means(_project_with_grade({}), media, 0.5)
    second = _overlay_channel_means(_project_with_grade({"exposure": 0.0}), media, 0.5)

    for left, right in zip(first, second, strict=True):
        assert left == pytest.approx(right, abs=1.0)


def test_a_grade_touches_only_the_clip_it_is_on(media: Path) -> None:
    """Scope isolation: grading the overlay must not grade the layer beneath it.

    A grade that leaked onto other layers would still pass every "the grade
    reached the pixels" check, because the graded clip does change. The
    background is therefore measured too, and must be untouched.
    """
    pytest.importorskip("PIL")
    import numpy as np
    from PIL import Image

    def background_mean(project: Project) -> float:
        grabbed = grab_frame(project, media, 0.5, max_dimension=WIDTH, image_format="png")
        frame = np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("RGB")).astype(float)
        # A corner the scaled-down overlay never covers.
        return float(frame[0:12, 0:12].mean())

    flat = background_mean(_project_with_grade({}))
    graded = background_mean(_project_with_grade({"exposure": 0.6}))

    assert graded == pytest.approx(flat, abs=1.0), "the grade leaked onto another layer"
