"""Tests for the data-driven caption template interpreter (schema v10, ADR 0069).

Primitive-level coverage: one test per enum value of the display / emphasis /
entrance / loop / accent vocabularies (the closed sets both renderers
interpret), plus the canvas-size invariant the compiler's per-frame MoviePy
clips depend on, plus a determinism smoke over the ENTIRE template catalog.

Following the repo's caption-test precedent these are behavioral pixel
assertions + in-run byte determinism, not committed golden PNGs (Pillow
version bumps would invalidate binary goldens for legitimate reasons).
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.caption_templates import load_catalog
from framepilot_engine.render.captions import (
    caption_style_is_animated,
    render_caption_image,
)
from framepilot_engine.timeline.models import CaptionStyle, TranscriptWord

# Four words spanning t=0..4s, one second each.
_WORDS = [
    TranscriptWord(word="this", start=0.0, end=1.0),
    TranscriptWord(word="goes", start=1.0, end=2.0),
    TranscriptWord(word="really", start=2.0, end=3.0),
    TranscriptWord(word="viral", start=3.0, end=4.0),
]
_TEXT = "this goes really viral"


def _style(**overrides: object) -> CaptionStyle:
    return CaptionStyle.model_validate(overrides)


def _render(style: CaptionStyle, frame_time: float) -> np.ndarray:
    return render_caption_image(_TEXT, 480, 480, style=style, words=_WORDS, frame_time=frame_time)


def _has_color(image: np.ndarray, rgb: tuple[int, int, int]) -> bool:
    pixels = image.reshape(-1, 4)
    r, g, b = rgb
    return bool(
        np.any((pixels[:, 0] == r) & (pixels[:, 1] == g) & (pixels[:, 2] == b) & (pixels[:, 3] > 0))
    )


def _ink(image: np.ndarray) -> int:
    """Count of non-transparent pixels."""
    return int(np.count_nonzero(image[:, :, 3]))


# --- display modes -----------------------------------------------------------


def test_display_phrase_is_stable_without_emphasis() -> None:
    style = _style(display="phrase", textColor="#ff0000")
    assert not caption_style_is_animated(style)
    a = _render(style, 0.5)
    b = _render(style, 3.5)
    assert np.array_equal(a, b)


def test_display_active_word_shows_one_word_at_a_time() -> None:
    style = _style(display="active-word", textColor="#ffffff")
    assert caption_style_is_animated(style)
    first = _render(style, 0.5)
    last = _render(style, 3.5)
    assert first.shape == last.shape  # canvas-size invariant
    assert not np.array_equal(first, last)
    # A single word carries far less ink than the whole phrase.
    phrase = _render(_style(display="phrase", textColor="#ffffff"), 0.5)
    assert _ink(first) < _ink(phrase)


def test_display_active_word_holds_last_spoken_word_through_gaps() -> None:
    words = [
        TranscriptWord(word="hello", start=0.0, end=1.0),
        TranscriptWord(word="there", start=2.0, end=3.0),
    ]
    style = _style(display="active-word")
    in_gap = render_caption_image("hello there", 480, 480, style=style, words=words, frame_time=1.5)
    while_spoken = render_caption_image(
        "hello there", 480, 480, style=style, words=words, frame_time=0.5
    )
    assert np.array_equal(in_gap, while_spoken)


def test_display_active_word_before_first_word_shows_first_word() -> None:
    words = [TranscriptWord(word="late", start=2.0, end=3.0)]
    image = render_caption_image(
        "late", 480, 480, style=_style(display="active-word"), words=words, frame_time=0.0
    )
    assert _ink(image) > 0


def test_display_cumulative_grows_over_time() -> None:
    style = _style(display="cumulative")
    early = _render(style, 0.5)
    late = _render(style, 3.5)
    assert early.shape == late.shape
    assert _ink(early) < _ink(late)


def test_display_cumulative_empty_before_first_word() -> None:
    words = [TranscriptWord(word="late", start=2.0, end=3.0)]
    image = render_caption_image(
        "late", 480, 480, style=_style(display="cumulative"), words=words, frame_time=0.0
    )
    assert _ink(image) == 0


def test_display_modes_fall_back_to_phrase_without_matching_words() -> None:
    # words do not match the token count → phrase behavior (all words shown).
    style = _style(display="active-word")
    image = render_caption_image(_TEXT, 480, 480, style=style, words=[], frame_time=0.5)
    phrase = render_caption_image(
        _TEXT, 480, 480, style=_style(display="phrase"), words=[], frame_time=0.5
    )
    assert _ink(image) == _ink(phrase)


# --- emphasis vocabulary -----------------------------------------------------


def _emphasis_style(animation: str, **extra: object) -> CaptionStyle:
    return _style(
        textColor="#ffffff",
        highlight={"enabled": True, "color": "#ff0000", "animation": animation, **extra},
    )


def test_emphasis_color_recolors_only_the_active_word() -> None:
    style = _emphasis_style("color")
    assert caption_style_is_animated(style)
    active = _render(style, 0.5)
    assert _has_color(active, (255, 0, 0))
    # Between-clip idle time (before any word): no red anywhere.
    idle = _render(style, -1.0)
    assert not _has_color(idle, (255, 0, 0))


def test_emphasis_pop_scales_the_active_word() -> None:
    style = _emphasis_style("pop", scale=1.5)
    active = _render(style, 0.5)
    idle = _render(style, -1.0)
    assert active.shape == idle.shape
    assert not np.array_equal(active, idle)
    assert _has_color(active, (255, 0, 0))


def test_emphasis_karaoke_fill_progresses_within_the_word() -> None:
    style = _emphasis_style("karaoke-fill")
    early = _render(style, 0.1)
    late = _render(style, 0.9)
    assert early.shape == late.shape
    # The fill sweeps left→right: more red late in the word.
    red_early = int(np.count_nonzero((early[:, :, 0] == 255) & (early[:, :, 2] == 0)))
    red_late = int(np.count_nonzero((late[:, :, 0] == 255) & (late[:, :, 2] == 0)))
    assert red_late > red_early


def test_emphasis_background_draws_a_chip_behind_the_active_word() -> None:
    style = _emphasis_style("background", background="#00ff00")
    active = _render(style, 0.5)
    assert _has_color(active, (0, 255, 0))
    idle = _render(style, -1.0)
    assert not _has_color(idle, (0, 255, 0))


def test_emphasis_glow_adds_soft_pixels_around_the_active_word() -> None:
    style = _emphasis_style("glow")
    active = _render(style, 0.5)
    idle = _render(style, -1.0)
    # Glow blurs outward: strictly more inked pixels when active.
    assert _ink(active) > _ink(idle)


def test_emphasis_underline_draws_a_bar_under_the_active_word() -> None:
    style = _emphasis_style("underline")
    active = _render(style, 0.5)
    idle = _render(style, -1.0)
    assert _has_color(active, (255, 0, 0))
    assert not np.array_equal(active, idle)


def test_emphasis_pulse_varies_within_the_active_word() -> None:
    style = _emphasis_style("pulse", scale=1.6)
    a = _render(style, 0.15)
    b = _render(style, 0.45)
    assert a.shape == b.shape
    assert not np.array_equal(a, b)


def test_upcoming_words_are_dimmed_in_phrase_display() -> None:
    style = _emphasis_style("color")
    image = _render(style, 0.5)
    alphas = image[:, :, 3]
    inked = alphas[alphas > 0]
    # Both full-strength (spoken/active) and dimmed (upcoming) alpha exist.
    assert int(inked.max()) == 255
    assert int(inked.min()) < 200


# --- entrances / loops -------------------------------------------------------


def _entrance_style(kind: str, per_word: bool = False) -> CaptionStyle:
    return _style(
        textColor="#ffffff",
        animation={"in": {"type": kind, "duration": 0.4}, "perWord": per_word},
    )


def test_entrance_fade_ramps_alpha() -> None:
    style = _entrance_style("fade")
    assert caption_style_is_animated(style)
    early = _render(style, 0.1)
    settled = _render(style, 1.0)
    assert early.shape == settled.shape
    assert int(early[:, :, 3].max()) < int(settled[:, :, 3].max())


def test_entrance_slide_up_shifts_content_down_early() -> None:
    style = _entrance_style("slide-up")
    early = _render(style, 0.1)
    settled = _render(style, 1.0)
    rows_early = np.nonzero(early[:, :, 3].any(axis=1))[0]
    rows_settled = np.nonzero(settled[:, :, 3].any(axis=1))[0]
    assert rows_early[0] > rows_settled[0]


def test_entrance_zoom_starts_smaller() -> None:
    style = _entrance_style("zoom")
    early = _render(style, 0.05)
    settled = _render(style, 1.0)
    assert early.shape == settled.shape
    cols_early = np.nonzero(early[:, :, 3].any(axis=0))[0]
    cols_settled = np.nonzero(settled[:, :, 3].any(axis=0))[0]
    assert (cols_early[-1] - cols_early[0]) < (cols_settled[-1] - cols_settled[0])


def test_entrance_bounce_overshoots_then_settles() -> None:
    style = _entrance_style("bounce")
    mid = _render(style, 0.2)
    settled = _render(style, 2.0)
    assert mid.shape == settled.shape
    assert not np.array_equal(mid, settled)


def test_entrance_typewriter_reveals_characters_per_word() -> None:
    style = _entrance_style("typewriter", per_word=True)
    early = _render(style, 0.05)
    later = _render(style, 3.9)
    assert early.shape == later.shape
    assert _ink(early) < _ink(later)


def test_per_word_entrance_staggers_words() -> None:
    style = _entrance_style("slide-up", per_word=True)
    during_second_word = _render(style, 1.1)
    settled = _render(style, 3.9)
    assert during_second_word.shape == settled.shape
    assert not np.array_equal(during_second_word, settled)


def test_loop_pulse_varies_over_time_forever() -> None:
    style = _style(textColor="#ffffff", animation={"loop": {"type": "pulse", "period": 1.0}})
    assert caption_style_is_animated(style)
    a = _render(style, 0.25)
    b = _render(style, 0.75)
    assert a.shape == b.shape
    assert not np.array_equal(a, b)


def test_loop_wave_bobs_words_out_of_phase() -> None:
    style = _style(textColor="#ffffff", animation={"loop": {"type": "wave", "period": 1.0}})
    a = _render(style, 0.0)
    b = _render(style, 0.5)
    assert a.shape == b.shape
    assert not np.array_equal(a, b)


# --- accent words ------------------------------------------------------------


def test_accent_last_word_recolors_the_final_word() -> None:
    style = _style(
        textColor="#ffffff", accent={"mode": "last-word", "color": "#00ff00", "fontScale": 1.5}
    )
    image = _render(style, 0.5)
    assert _has_color(image, (0, 255, 0))
    assert _has_color(image, (255, 255, 255))


def test_accent_longest_word_targets_the_longest_token() -> None:
    style = _style(textColor="#ffffff", accent={"mode": "longest-word", "color": "#00ff00"})
    image = _render(style, 0.5)  # "really" is the longest token
    assert _has_color(image, (0, 255, 0))


def test_accent_keywords_without_keyword_source_is_no_accent() -> None:
    plain = _style(textColor="#ffffff")
    keyword = _style(textColor="#ffffff", accent={"mode": "keywords", "color": "#00ff00"})
    assert np.array_equal(_render(plain, 0.5), _render(keyword, 0.5))


# --- typography / decor ------------------------------------------------------


def test_text_transform_uppercase_changes_glyphs() -> None:
    upper = _render(_style(textTransform="uppercase"), 0.5)
    plain = _render(_style(), 0.5)
    assert not np.array_equal(upper, plain)


def test_letter_spacing_widens_the_line() -> None:
    spaced = _render(_style(letterSpacing=0.3), 0.5)
    plain = _render(_style(), 0.5)
    assert spaced.shape[1] > plain.shape[1]


def test_font_weight_bold_changes_rendering_with_bundled_variable_font() -> None:
    light = _render(_style(fontFamily="Inter", fontWeight=300), 0.5)
    black = _render(_style(fontFamily="Inter", fontWeight=900), 0.5)
    assert _ink(black) > _ink(light)


def test_line_background_chip_and_radius_render() -> None:
    style = _style(background={"color": "#0000ff", "radius": 0.4, "paddingX": 0.5, "paddingY": 0.5})
    image = _render(style, 0.5)
    assert _has_color(image, (0, 0, 255))


def test_shadow_renders_offset_tinted_pixels() -> None:
    style = _style(
        textColor="#ffffff",
        shadow={"color": "#ff00ff", "blur": 0.2, "offsetX": 0.1, "offsetY": 0.1},
    )
    image = _render(style, 0.5)
    pixels = image.reshape(-1, 4)
    # Blurred shadow pixels carry the shadow hue (magenta-dominant channels).
    assert bool(np.any((pixels[:, 0] > 0) & (pixels[:, 1] == 0) & (pixels[:, 2] > 0)))


# --- catalog-wide determinism smoke -----------------------------------------


def test_every_catalog_template_renders_deterministically() -> None:
    for template_id in load_catalog():
        style = CaptionStyle.model_validate({"templateId": template_id})
        for frame_time in (0.5, 2.5):
            a = _render(style, frame_time)
            b = _render(style, frame_time)
            assert np.array_equal(a, b), f"{template_id} not deterministic at {frame_time}"
            assert a.shape[2] == 4
        # Canvas-size invariance across the clip for animated templates.
        assert _render(style, 0.5).shape == _render(style, 3.5).shape, template_id
        # Every template shows SOMETHING while a word is active.
        assert _ink(_render(style, 0.5)) > 0, f"{template_id} rendered empty"
        # And stays within a sane fraction of the frame.
        h, w, _ = _render(style, 0.5).shape
        assert w <= 480 * 2 and h <= 480, f"{template_id} canvas {w}x{h} oversized"


# --- edge branches -----------------------------------------------------------


def test_malformed_hex_color_falls_back_to_white() -> None:
    image = _render(_style(textColor="#zzzzzz"), 0.5)
    assert _has_color(image, (255, 255, 255))


def test_unknown_font_family_falls_back_to_default_font() -> None:
    image = _render(_style(fontFamily="No Such Font 9000"), 0.5)
    assert _ink(image) > 0


def test_accent_indices_of_empty_tokens_is_empty() -> None:
    from framepilot_engine.render.captions import _accent_indices

    assert _accent_indices([], "last-word") == frozenset()


def test_accent_indices_selects_deterministically() -> None:
    from framepilot_engine.render.captions import _accent_indices

    tokens = ["go", "really", "far", "now"]
    assert _accent_indices(tokens, "last-word") == frozenset({3})
    assert _accent_indices(tokens, "longest-word") == frozenset({1})
    assert _accent_indices(tokens, "none") == frozenset()
    assert _accent_indices(tokens, "not-a-mode") == frozenset()


def test_accent_indices_keywords_selects_every_match() -> None:
    """Schema v11: `keywords` mode finally has a list to compare against.

    Before v11 it was a documented no-op, so the editor's keyword chips never
    reached a render at all (ADR 0071). Matching mirrors the web preview's
    `bareToken`: case- and punctuation-insensitive.
    """
    from framepilot_engine.render.captions import _accent_indices

    tokens = ["Go", "now", "GO!"]
    assert _accent_indices(tokens, "keywords", ["go"]) == frozenset({0, 2})
    # No list, or a list of nothing but punctuation, selects nothing.
    assert _accent_indices(tokens, "keywords") == frozenset()
    assert _accent_indices(tokens, "keywords", ["!!"]) == frozenset()


def test_accent_indices_keywords_matches_a_spoken_phrase() -> None:
    """A multi-word keyword accents the whole run of words that speaks it.

    Emphasis is a unit of meaning, not of tokenization. Folding "stop scrolling"
    to one bare token matched nothing, so the phrase an editor most wants to hit
    could not be rendered at all. Mirrors `accentRunIndices` in the web preview.
    """
    from framepilot_engine.render.captions import _accent_indices

    tokens = ["make", "founders", "stop", "scrolling", "now"]
    assert _accent_indices(tokens, "keywords", ["stop scrolling"]) == frozenset({2, 3})
    # Punctuation and case fold the same way inside a phrase as outside it.
    assert _accent_indices(["Stop,", "SCROLLING!"], "keywords", ["stop scrolling"]) == frozenset(
        {0, 1}
    )
    # A phrase that is not spoken consecutively selects nothing.
    assert _accent_indices(["stop", "now", "scrolling"], "keywords", ["stop scrolling"]) == (
        frozenset()
    )


def test_accent_indices_prefers_the_longer_phrase() -> None:
    """A bare word must not claim part of a longer phrase and half-apply it."""
    from framepilot_engine.render.captions import _accent_indices

    tokens = ["stop", "scrolling", "and", "stop"]
    # Both keywords apply: the phrase covers 0-1, the bare word also hits 3.
    assert _accent_indices(tokens, "keywords", ["stop", "stop scrolling"]) == frozenset({0, 1, 3})


def test_shift_by_subpixel_is_identity() -> None:
    from PIL import Image

    from framepilot_engine.render.captions import _shift

    img = Image.new("RGBA", (4, 4), (1, 2, 3, 4))
    assert _shift(img, 0.2) is img


def test_loop_pulse_at_zero_phase_is_unscaled() -> None:
    style = _style(textColor="#ffffff", animation={"loop": {"type": "pulse", "period": 1.0}})
    pulsed = _render(style, 0.0)  # sin(0) == 0 → scale 1.0 (identity resize)
    plain = _render(_style(textColor="#ffffff"), 0.0)
    assert _ink(pulsed) == _ink(plain)
