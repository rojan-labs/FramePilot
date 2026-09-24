"""See-through letters and frosted-glass caption chips (schema v24, ADR 0185).

Behavioural pixel assertions, like the rest of the caption suite: what shows through
a translucent letter, what a frosted chip does to the picture behind it, and that
every style without the new fields renders exactly as before.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.captions import render_caption_image, render_caption_raster
from framepilot_engine.render.compiler import _caption_layers, _composite_captions
from framepilot_engine.timeline.models import SCHEMA_VERSION, CaptionStyle, Project, TranscriptWord

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

_FRAME = 720
_WORDS = [
    TranscriptWord(word="HOLLOW", start=0.0, end=1.0),
    TranscriptWord(word="GLASS", start=1.0, end=2.0),
]
_TEXT = "HOLLOW GLASS"

WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
MAGENTA = (255, 0, 255)


def _style(**fields: object) -> CaptionStyle:
    return CaptionStyle.model_validate({"fontFamily": "Archivo Black", **fields})


def _render(style: CaptionStyle, frame_time: float = 0.5) -> np.ndarray:
    return render_caption_image(
        _TEXT, _FRAME, _FRAME, style=style, words=_WORDS, frame_time=frame_time
    )


def _where(image: np.ndarray, rgb: tuple[int, int, int]) -> np.ndarray:
    """Fully opaque pixels of exactly ``rgb``."""
    r, g, b = rgb
    return np.asarray(
        (image[:, :, 0] == r)
        & (image[:, :, 1] == g)
        & (image[:, :, 2] == b)
        & (image[:, :, 3] == 255)
    )


# --- see-through letters -------------------------------------------------------------


def test_absent_or_full_opacity_renders_exactly_as_before() -> None:
    base = {"textColor": "#ffffff", "outlineColor": "#000000", "outlineWidth": 2}
    assert np.array_equal(_render(_style(**base)), _render(_style(**base, textOpacity=1)))


def test_translucent_letters_keep_a_full_strength_outline_outside_them() -> None:
    base = {"textColor": "#ffffff", "outlineColor": "#000000", "outlineWidth": 2}
    solid = _render(_style(**base))
    seen_through = _render(_style(**base, textOpacity=0.3))
    assert solid.shape == seen_through.shape

    letters = _where(solid, WHITE)
    ring = _where(solid, BLACK)
    assert letters.sum() > 500 and ring.sum() > 500
    # Inside a letter: the fill colour at 30 % — the picture shows through it.
    assert np.all(seen_through[letters][:, :3] == 255)
    assert np.all(np.abs(seen_through[letters][:, 3].astype(int) - round(0.3 * 255)) <= 1)
    # The outline ring outside the letters is untouched: solid black.
    assert np.array_equal(seen_through[ring], solid[ring])


def test_hollow_letters_show_no_outline_or_shadow_inside_them() -> None:
    base: dict[str, Any] = {
        "textColor": "#ffffff",
        "outlineColor": "#000000",
        "outlineWidth": 1.5,
        "shadow": {"color": "#ff00ff", "blur": 0.2, "offsetX": 0.08, "offsetY": 0.08},
    }
    solid = _render(_style(**base))
    hollow = _render(_style(**base, textOpacity=0))
    letters = _where(solid, WHITE)
    # Nothing of the caption is left where the letters are: not the fill, not the
    # outline drawn under it, not the offset shadow that would sit behind it.
    assert np.all(hollow[letters][:, 3] == 0)
    # The shadow is still cast OUTSIDE the letters.
    magenta = (hollow[:, :, 0] > 150) & (hollow[:, :, 1] < 80) & (hollow[:, :, 2] > 150)
    assert (magenta & (hollow[:, :, 3] > 0)).sum() > 200
    # And the outline still reads.
    assert _where(hollow, BLACK).sum() > 500


def test_highlight_colours_are_see_through_too() -> None:
    highlight = {"enabled": True, "color": "#ff0000", "animation": "color"}
    solid = _render(_style(textColor="#ffffff", highlight=highlight), frame_time=0.5)
    image = _render(_style(textColor="#ffffff", highlight=highlight, textOpacity=0.5), 0.5)
    red = _where(solid, (255, 0, 0))  # the active word "HOLLOW", inside its letters
    assert red.sum() > 200
    assert np.all(image[red][:, 0] == 255)
    assert np.all(np.abs(image[red][:, 3].astype(int) - 128) <= 1)


def test_an_upcoming_words_outline_dims_with_the_word() -> None:
    # The preview dims the WHOLE word not yet spoken (CSS opacity on its span); the
    # export used to dim only the fill and keep a solid outline around it.
    style = _style(
        textColor="#ffffff",
        outlineColor="#000000",
        outlineWidth=2,
        highlight={"enabled": True, "color": "#ffffff", "animation": "color"},
    )
    image = _render(style, frame_time=0.5)  # "GLASS" is still to come
    # The right third of the line is "GLASS" alone (clear of "HOLLOW" and its outline).
    upcoming = image[:, int(image.shape[1] * 0.65) :]
    black = (upcoming[:, :, 0] == 0) & (upcoming[:, :, 1] == 0) & (upcoming[:, :, 2] == 0)
    outline_alpha = upcoming[:, :, 3][black & (upcoming[:, :, 3] > 0)]
    assert outline_alpha.size > 200
    assert int(outline_alpha.max()) <= round(0.6 * 255) + 1


# --- the glass edge -------------------------------------------------------------------


def test_border_is_drawn_inside_the_chip_without_resizing_it() -> None:
    chip = {"color": "#ffffff26", "radius": 0.3, "paddingX": 0.4, "paddingY": 0.2}
    plain = _render(_style(textColor="#ffffff", background=chip))
    edged = _render(
        _style(
            textColor="#ffffff",
            background={**chip, "borderColor": "#00ff00", "borderWidth": 1.5},
        )
    )
    assert plain.shape == edged.shape
    green = (edged[:, :, 0] == 0) & (edged[:, :, 1] == 255) & (edged[:, :, 2] == 0)
    assert green.sum() > 200
    # Inside the chip only: no green pixel where the plain chip drew nothing.
    assert not np.any(green & (plain[:, :, 3] == 0))


def test_a_border_needs_no_fill() -> None:
    edged = _render(
        _style(
            textColor="#ffffff",
            background={"color": "#00000000", "borderColor": "#00ff00", "borderWidth": 2},
        )
    )
    assert ((edged[:, :, 1] == 255) & (edged[:, :, 0] == 0)).sum() > 200


# --- frosted chips --------------------------------------------------------------------


def test_only_a_frosted_chip_carries_a_backdrop() -> None:
    flat = render_caption_raster(
        _TEXT, _FRAME, _FRAME, style=_style(background={"color": "#00000080"}), words=_WORDS
    )
    assert flat.backdrop is None

    frosted = render_caption_raster(
        _TEXT,
        _FRAME,
        _FRAME,
        style=_style(background={"color": "#ffffff26", "radius": 0, "blur": 0.3}),
        words=_WORDS,
    )
    assert frosted.backdrop is not None
    assert frosted.backdrop.shape == frosted.image.shape[:2]
    assert frosted.backdrop_sigma_px > 0
    # The backdrop is the chip: full inside it, empty in the margin around it.
    assert int(frosted.backdrop.max()) == 255
    assert frosted.backdrop[0, 0] == 0
    chip_rows = np.nonzero(frosted.backdrop.max(axis=1))[0]
    assert frosted.image[chip_rows[len(chip_rows) // 2], :, 3].max() > 0


def test_the_backdrop_follows_the_chip_through_a_fade_in() -> None:
    style = _style(
        background={"color": "#ffffff26", "blur": 0.3},
        animation={"in": {"type": "fade", "duration": 1.0}},
    )
    halfway = render_caption_raster(
        _TEXT, _FRAME, _FRAME, style=style, words=_WORDS, frame_time=0.5
    )
    assert halfway.backdrop is not None
    assert 100 <= int(halfway.backdrop.max()) <= 150


def _caption_project(style: dict[str, Any]) -> Project:
    return Project.model_validate(
        {
            "schemaVersion": SCHEMA_VERSION,
            "id": "glass",
            "name": "glass",
            "version": 1,
            "fps": 30,
            "resolution": {"width": 480, "height": 480},
            "assets": [],
            "folders": [],
            "timeline": {
                "tracks": [
                    {
                        "id": "captions",
                        "type": "caption",
                        "clips": [
                            {
                                "id": "cue",
                                "assetId": "__caption__",
                                "trackId": "captions",
                                "start": 0.0,
                                "end": 2.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 2.0,
                                "effects": [],
                                "keyframes": [],
                                "captionCue": {"text": "frosted glass", "words": []},
                                "captionStyle": style,
                            }
                        ],
                    }
                ]
            },
            "transcript": [],
            "markers": [],
            "aiMemory": {},
            "history": [],
        }
    )


def _checkerboard_clip() -> Any:
    from moviepy import VideoClip

    y, x = np.mgrid[0:480, 0:480]
    board = (((x // 6) + (y // 6)) % 2 * 255).astype(np.uint8)
    frame = np.repeat(board[:, :, None], 3, axis=2)
    return VideoClip(frame_function=lambda _t: frame).with_duration(2.0).with_fps(30)


def test_a_frosted_chip_blurs_the_picture_behind_it_and_nothing_else() -> None:
    base = _checkerboard_clip()
    original = np.asarray(base.get_frame(0.5), dtype=np.float64)
    captions = _caption_layers(
        _caption_project(
            {
                "fontFamily": "Inter",
                "textColor": "#ffffff00",  # letters invisible: judge the chip alone
                "background": {"color": "#ffffff00", "radius": 0, "blur": 0.3},
                "position": "middle",
            }
        ),
        (480, 480),
    )
    assert captions[0].backdrop is not None
    frame = np.asarray(_composite_captions(base, captions, 30).get_frame(0.5), dtype=np.float64)

    changed = np.abs(frame - original).max(axis=2) > 0
    rows, cols = np.nonzero(changed)
    assert rows.size > 0
    # Behind the chip the 6 px checkerboard is smoothed to grey...
    inside = frame[rows.min() + 4 : rows.max() - 4, cols.min() + 4 : cols.max() - 4]
    assert inside.std() < original.std() * 0.25
    # ...and everywhere else the picture is exactly what it was.
    untouched = np.ones(changed.shape, dtype=bool)
    untouched[rows.min() : rows.max() + 1, cols.min() : cols.max() + 1] = False
    assert np.array_equal(frame[untouched], original[untouched])


def test_captions_without_frost_keep_the_plain_composite_path() -> None:
    captions = _caption_layers(
        _caption_project({"fontFamily": "Inter", "background": {"color": "#000000b3"}}),
        (480, 480),
    )
    assert all(caption.backdrop is None for caption in captions)
