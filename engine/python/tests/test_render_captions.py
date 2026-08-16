"""Tests for caption burn-in rasterization (plan 3.3).

These exercise the pure module — no MoviePy, no render — covering text
reconstruction from a transcript and deterministic image rasterization.
"""

from __future__ import annotations

import numpy as np
import pytest

from framepilot_engine.render.captions import (
    caption_style_is_animated,
    caption_text_for_range,
    caption_words_for_range,
    render_caption_image,
    resolve_caption_cue,
)
from framepilot_engine.timeline.models import (
    CaptionCue,
    CaptionHighlight,
    CaptionStyle,
    Clip,
    TranscriptWord,
)


def _words(*pairs: tuple[str, float, float]) -> list[TranscriptWord]:
    return [TranscriptWord(word=w, start=s, end=e) for (w, s, e) in pairs]


# --- caption_text_for_range --------------------------------------------------


def test_text_for_range_joins_overlapping_words() -> None:
    transcript = _words(("hello", 0.0, 0.5), ("there", 0.5, 1.0), ("world", 1.0, 1.5))
    assert caption_text_for_range(transcript, 0.0, 1.0) == "hello there"


def test_text_for_range_includes_partial_overlap() -> None:
    # "there" spans 0.5-1.0; a range of 0.9-1.2 still overlaps it and "world".
    transcript = _words(("hello", 0.0, 0.5), ("there", 0.5, 1.0), ("world", 1.0, 1.5))
    assert caption_text_for_range(transcript, 0.9, 1.2) == "there world"


def test_text_for_range_empty_when_no_overlap() -> None:
    transcript = _words(("hello", 0.0, 0.5))
    assert caption_text_for_range(transcript, 2.0, 3.0) == ""
    assert caption_text_for_range([], 0.0, 1.0) == ""


# --- render_caption_image ----------------------------------------------------


def test_render_caption_image_shape_and_dtype() -> None:
    image = render_caption_image("hello world", 1080, 1920)
    assert image.ndim == 3
    assert image.shape[2] == 4  # RGBA
    assert image.dtype == np.uint8
    # The translucent box fills the image, so plenty of pixels are non-transparent.
    assert int(image[:, :, 3].max()) > 0


def test_render_caption_image_is_deterministic() -> None:
    a = render_caption_image("framepilot ships", 1080, 1920)
    b = render_caption_image("framepilot ships", 1080, 1920)
    assert np.array_equal(a, b)


def test_render_caption_image_wraps_long_text_to_more_rows() -> None:
    short = render_caption_image("hi", 480, 480)
    long = render_caption_image("the quick brown fox jumps over the lazy dog twice", 480, 480)
    # Wrapping a long caption onto multiple lines makes the box taller.
    assert long.shape[0] > short.shape[0]
    # ...and it never exceeds the frame width bound.
    assert long.shape[1] <= 480


def test_render_caption_image_rejects_empty_text() -> None:
    with pytest.raises(ValueError, match="empty caption"):
        render_caption_image("   ", 1080, 1920)


# --- schema v5: styled + word-highlight rendering ----------------------------


def test_unstyled_caption_matches_baseline_exactly() -> None:
    """A caption with no ``captionStyle`` at all is untouched by the v5 path."""
    baseline = render_caption_image("hello there", 1080, 1920)
    explicit_none = render_caption_image("hello there", 1080, 1920, style=None)
    assert np.array_equal(baseline, explicit_none)


def test_styled_caption_applies_text_color_and_outline() -> None:
    # Pure red text on a fully transparent box (no preset) makes it easy to
    # assert the exact color appears somewhere in the rendered pixels.
    style = CaptionStyle.model_validate(
        {"textColor": "#ff0000", "outlineColor": "#00ff00", "outlineWidth": 3}
    )
    image = render_caption_image("HELLO", 480, 480, style=style)
    pixels = image.reshape(-1, 4)
    # The requested red fill color appears (allowing alpha to vary from AA).
    assert np.any((pixels[:, 0] == 255) & (pixels[:, 1] == 0) & (pixels[:, 2] == 0))
    # The requested green outline color appears too (real Pillow stroke).
    assert np.any((pixels[:, 0] == 0) & (pixels[:, 1] == 255) & (pixels[:, 2] == 0))


def test_styled_caption_template_id_maps_to_catalog_style() -> None:
    # 'impact' (caption template catalog, ADR 0069) resolves to the catalog's
    # yellow (#ffd60a) text color when no explicit textColor overrides it.
    style = CaptionStyle.model_validate({"templateId": "impact"})
    image = render_caption_image("HYPE", 480, 480, style=style)
    pixels = image.reshape(-1, 4)
    assert np.any((pixels[:, 0] == 255) & (pixels[:, 1] == 214) & (pixels[:, 2] == 10))


def test_styled_caption_position_top_places_box_near_frame_top() -> None:
    style = CaptionStyle.model_validate({"position": "top"})
    image = render_caption_image("hi", 480, 480, style=style)
    # Non-transparent content is concentrated near the top rows of the box
    # itself; verified indirectly via the compiler's placement in
    # test_render_compiler.py. Here we just confirm the styled path renders
    # a non-empty image and doesn't crash for each position value.
    assert image.shape[2] == 4
    assert int(image[:, :, 3].max()) > 0


def test_caption_style_is_animated_requires_enabled_and_animation() -> None:
    assert not caption_style_is_animated(None)
    assert not caption_style_is_animated(CaptionStyle.model_validate({}))
    disabled = CaptionStyle.model_validate({"highlight": {"enabled": False, "animation": "pop"}})
    assert not caption_style_is_animated(disabled)
    none_anim = CaptionStyle.model_validate({"highlight": {"enabled": True, "animation": "none"}})
    assert not caption_style_is_animated(none_anim)
    karaoke = CaptionStyle.model_validate(
        {"highlight": {"enabled": True, "animation": "karaoke-fill"}}
    )
    assert caption_style_is_animated(karaoke)
    pop = CaptionStyle.model_validate({"highlight": {"enabled": True, "animation": "pop"}})
    assert caption_style_is_animated(pop)


def _highlight_words() -> list[TranscriptWord]:
    return _words(("one", 0.0, 0.5), ("two", 0.5, 1.0), ("three", 1.0, 1.5))


def test_caption_words_for_range_returns_word_objects() -> None:
    transcript = _highlight_words()
    words = caption_words_for_range(transcript, 0.0, 1.5)
    assert [w.word for w in words] == ["one", "two", "three"]


def test_karaoke_fill_highlights_active_word_differently_at_frame_time() -> None:
    style = CaptionStyle.model_validate(
        {
            "textColor": "#ffffff",
            "highlight": {"enabled": True, "color": "#ff0000", "animation": "karaoke-fill"},
        }
    )
    words = _highlight_words()
    text = " ".join(w.word for w in words)

    # At t=0.75 ("two" is active: 0.5<=0.75<1.0), some pixels must be pure red
    # (the karaoke fill color) — absent when nothing is active/highlighted.
    active_frame = render_caption_image(
        text, 480, 480, style=style, words=words, frame_time=0.75
    )
    active_pixels = active_frame.reshape(-1, 4)
    assert np.any(
        (active_pixels[:, 0] == 255) & (active_pixels[:, 1] == 0) & (active_pixels[:, 2] == 0)
    )

    # Long before any word starts, nothing is active — no red fill pixels.
    idle_frame = render_caption_image(
        text, 480, 480, style=style, words=words, frame_time=-1.0
    )
    idle_pixels = idle_frame.reshape(-1, 4)
    assert not np.any(
        (idle_pixels[:, 0] == 255) & (idle_pixels[:, 1] == 0) & (idle_pixels[:, 2] == 0)
    )


def test_pop_animation_differs_between_active_and_other_frames() -> None:
    style = CaptionStyle.model_validate(
        {"highlight": {"enabled": True, "color": "#00ff00", "animation": "pop"}}
    )
    words = _highlight_words()
    text = " ".join(w.word for w in words)

    at_active = render_caption_image(text, 480, 480, style=style, words=words, frame_time=0.25)
    at_other = render_caption_image(text, 480, 480, style=style, words=words, frame_time=1.25)

    # Different words are "popped" at each sampled time, so the frames differ.
    assert not np.array_equal(at_active, at_other)
    # The active-word frame contains the pop highlight color somewhere.
    pixels = at_active.reshape(-1, 4)
    assert np.any((pixels[:, 0] == 0) & (pixels[:, 1] == 255) & (pixels[:, 2] == 0))


def test_caption_highlight_model_round_trips_animation_values() -> None:
    for animation in ("none", "pop", "karaoke-fill"):
        highlight = CaptionHighlight.model_validate({"enabled": True, "animation": animation})
        assert highlight.animation == animation


# --- resolve_caption_cue (schema v11, ADR 0071) ------------------------------
# Mirrors the TS `resolveCaptionCue` tests in
# packages/editor-core/src/captions/cue.test.ts — the two must not drift.


def _caption_clip(start: float, end: float, cue: CaptionCue | None = None) -> Clip:
    return Clip.model_validate(
        {
            "id": "cap_a",
            "assetId": "__caption__",
            "trackId": "caption_1",
            "start": start,
            "end": end,
            "sourceStart": 0,
            "sourceEnd": end - start,
            "effects": [],
            "keyframes": [],
            **({"captionCue": cue.model_dump(by_alias=True)} if cue is not None else {}),
        }
    )


def test_resolve_cue_prefers_the_clip_own_text() -> None:
    transcript = _words(("we", 0.0, 0.4), ("shipped", 0.4, 1.0))
    cue = CaptionCue.model_validate({"text": "something else", "words": []})
    resolved = resolve_caption_cue(_caption_clip(0, 1, cue), transcript)
    assert resolved.text == "something else"


def test_resolve_cue_falls_back_to_the_transcript_by_overlap() -> None:
    transcript = _words(("we", 0.0, 0.4), ("shipped", 0.4, 1.0), ("it", 1.0, 1.4))
    resolved = resolve_caption_cue(_caption_clip(0, 1), transcript)
    assert resolved.text == "we shipped"
    assert [w.word for w in resolved.words] == ["we", "shipped"]


def test_resolve_cue_honours_a_deliberately_blanked_cue() -> None:
    """A cleared caption must not reappear at export."""
    transcript = _words(("we", 0.0, 0.4))
    cue = CaptionCue.model_validate({"text": "", "words": []})
    assert resolve_caption_cue(_caption_clip(0, 1, cue), transcript).text == ""


def test_resolve_cue_is_independent_of_a_transcript_re_run() -> None:
    cue = CaptionCue.model_validate(
        {"text": "we shipped", "words": [{"word": "we", "start": 0, "end": 0.4}]}
    )
    clip = _caption_clip(0, 1, cue)
    before = resolve_caption_cue(clip, _words(("we", 0.0, 0.4)))
    after = resolve_caption_cue(clip, _words(("totally", 0.0, 1.0)))
    assert before == after


# --- author line breaks (schema v11) ----------------------------------------


def test_author_line_break_positions_are_recovered_from_the_text() -> None:
    from framepilot_engine.render.captions import _author_line_breaks

    # Token index 2 begins the second authored line.
    assert _author_line_breaks("we shipped\nit today") == frozenset({2})
    assert _author_line_breaks("no breaks here") == frozenset()
    # A leading/trailing newline creates no empty line to break at.
    assert _author_line_breaks("\nwe shipped") == frozenset()
    assert _author_line_breaks("we shipped\n") == frozenset()


def test_author_line_break_changes_the_rendered_layout() -> None:
    style = CaptionStyle.model_validate({"templateId": "minimal"})
    words = _words(("we", 0.0, 0.4), ("shipped", 0.4, 1.0))
    # Wide enough that greedy wrapping would keep one line; the explicit break
    # must still produce two.
    one_line = render_caption_image("we shipped", 1920, 1080, style=style, words=words)
    two_lines = render_caption_image("we\nshipped", 1920, 1080, style=style, words=words)
    assert two_lines.shape[0] > one_line.shape[0]


def test_caption_width_and_line_height_change_layout() -> None:
    words = _words(
        ("professional", 0.0, 0.3),
        ("captions", 0.3, 0.6),
        ("stay", 0.6, 0.9),
        ("readable", 0.9, 1.2),
    )
    wide = CaptionStyle.model_validate({"maxWidthPercent": 90, "lineHeight": 1.0})
    narrow = CaptionStyle.model_validate({"maxWidthPercent": 35, "lineHeight": 1.6})
    wide_image = render_caption_image(
        "professional captions stay readable", 720, 1280, style=wide, words=words
    )
    narrow_image = render_caption_image(
        "professional captions stay readable", 720, 1280, style=narrow, words=words
    )
    assert narrow_image.shape[0] > wide_image.shape[0]
    assert narrow_image.shape[1] < wide_image.shape[1]


def test_caption_alignment_changes_rendered_pixels_not_canvas_size() -> None:
    words = _words(("short", 0.0, 0.4), ("line", 0.4, 0.8), ("longest", 0.8, 1.2))
    left = CaptionStyle.model_validate({"textAlign": "left"})
    right = CaptionStyle.model_validate({"textAlign": "right"})
    left_image = render_caption_image("short\nline longest", 720, 1280, style=left, words=words)
    right_image = render_caption_image("short\nline longest", 720, 1280, style=right, words=words)
    assert left_image.shape == right_image.shape
    assert not np.array_equal(left_image, right_image)


def test_accent_keywords_change_the_rendered_pixels() -> None:
    """Schema v11: a persisted keyword list finally reaches the render."""
    words = _words(("go", 0.0, 0.5), ("viral", 0.5, 1.0))
    plain = CaptionStyle.model_validate(
        {"accent": {"mode": "keywords", "color": "#ff0000", "fontScale": 1.6}}
    )
    with_keywords = CaptionStyle.model_validate(
        {
            "accent": {
                "mode": "keywords",
                "keywords": ["viral"],
                "color": "#ff0000",
                "fontScale": 1.6,
            }
        }
    )
    without = render_caption_image("go viral", 480, 480, style=plain, words=words)
    accented = render_caption_image("go viral", 480, 480, style=with_keywords, words=words)
    assert not np.array_equal(without, accented)
    pixels = accented.reshape(-1, 4)
    assert np.any((pixels[:, 0] == 255) & (pixels[:, 1] == 0) & (pixels[:, 2] == 0))
