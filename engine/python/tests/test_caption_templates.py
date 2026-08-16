"""Tests for the caption template catalog mirror (schema v10, ADR 0069).

Guards the cross-language contract: the packaged ``caption_templates.json``
must be byte-identical to the TS-generated artifact, every entry must parse as
a ``CaptionStyle``, and ``resolve_caption_style`` must mirror the TS
``resolveCaptionStyle`` precedence cases exercised in
``packages/timeline-schema/src/caption-templates.test.ts``.
"""

from __future__ import annotations

from pathlib import Path

from framepilot_engine.render.caption_templates import (
    default_template_id,
    get_caption_template,
    layer_caption_style,
    load_catalog,
    resolve_caption_style,
)
from framepilot_engine.timeline.models import CaptionStyle

_ENGINE_COPY = (
    Path(__file__).resolve().parents[1] / "framepilot_engine" / "render" / "caption_templates.json"
)
_TS_ARTIFACT = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "timeline-schema"
    / "schema"
    / "caption-templates.json"
)

_ALL_CATEGORIES = {
    "one-word",
    "phrase",
    "karaoke",
    "build",
    "boxed",
    "editorial",
    "aesthetic",
    "cinematic",
}


def test_engine_catalog_is_byte_identical_to_ts_artifact() -> None:
    """The packaged copy must never drift from the TS-generated artifact.

    Both files are written by ``pnpm schema:generate``; a mismatch means one
    side was edited by hand or the generator wasn't re-run.
    """
    assert _ENGINE_COPY.read_bytes() == _TS_ARTIFACT.read_bytes()


def test_catalog_loads_with_reference_size_and_categories() -> None:
    catalog = load_catalog()
    assert len(catalog) >= 40
    assert {t.category for t in catalog.values()} == _ALL_CATEGORIES
    for template in catalog.values():
        assert isinstance(template.style, CaptionStyle)
        assert template.style.template_id is None
        if template.style.display == "active-word":
            assert template.suggested_words_per_line == 1
        else:
            assert template.suggested_words_per_line > 1


def test_default_template_exists() -> None:
    assert get_caption_template(default_template_id()) is not None


def test_resolve_none_is_empty_style() -> None:
    resolved = resolve_caption_style(None)
    assert resolved == CaptionStyle()


def test_resolve_without_template_id_keeps_explicit_fields() -> None:
    style = CaptionStyle.model_validate({"textColor": "#ff0000", "fontScale": 2})
    resolved = resolve_caption_style(style)
    assert resolved.text_color == "#ff0000"
    assert resolved.font_scale == 2
    assert resolved.font_family is None


def test_resolve_fills_unset_fields_from_template() -> None:
    resolved = resolve_caption_style(CaptionStyle.model_validate({"templateId": "karaoke"}))
    template = get_caption_template("karaoke")
    assert template is not None
    assert resolved == template.style


def test_resolve_explicit_fields_win_with_field_level_merge() -> None:
    resolved = resolve_caption_style(
        CaptionStyle.model_validate(
            {
                "templateId": "karaoke",
                "textColor": "#123456",
                "highlight": {"enabled": False},
            }
        )
    )
    assert resolved.text_color == "#123456"
    # An explicit nested object replaces the template's wholesale.
    assert resolved.highlight is not None
    assert resolved.highlight.enabled is False
    assert resolved.highlight.color is None
    # Untouched fields still come from the template.
    template = get_caption_template("karaoke")
    assert template is not None
    assert resolved.font_weight == template.style.font_weight


def test_resolve_unknown_template_id_keeps_explicit_fields() -> None:
    resolved = resolve_caption_style(
        CaptionStyle.model_validate({"templateId": "nope", "textColor": "#123456"})
    )
    assert resolved.text_color == "#123456"
    assert resolved.template_id is None


def test_resolve_never_returns_a_template_id() -> None:
    resolved = resolve_caption_style(CaptionStyle.model_validate({"templateId": "karaoke"}))
    assert resolved.template_id is None


# --- track-level caption style (schema v11, ADR 0071) ----------------------
# Mirrors the TS `layerCaptionStyle` / `resolveCaptionStyle` v11 cases in
# packages/timeline-schema/src/caption-templates.test.ts one for one.


def test_layer_returns_clip_override_without_a_track_default() -> None:
    layered = layer_caption_style(None, CaptionStyle.model_validate({"textColor": "#fff"}))
    assert layered is not None
    assert layered.text_color == "#fff"


def test_layer_returns_track_default_when_clip_overrides_nothing() -> None:
    layered = layer_caption_style(CaptionStyle.model_validate({"templateId": "karaoke"}), None)
    assert layered is not None
    assert layered.template_id == "karaoke"


def test_layer_returns_none_when_neither_side_has_a_style() -> None:
    assert layer_caption_style(None, None) is None


def test_layer_lets_the_clip_win_field_by_field() -> None:
    layered = layer_caption_style(
        CaptionStyle.model_validate(
            {"templateId": "karaoke", "textColor": "#ffffff", "fontScale": 1}
        ),
        CaptionStyle.model_validate({"textColor": "#ffd84d"}),
    )
    assert layered is not None
    assert layered.text_color == "#ffd84d"
    assert layered.template_id == "karaoke"
    assert layered.font_scale == 1


def test_layer_lets_one_cue_adopt_a_different_template_than_its_track() -> None:
    layered = layer_caption_style(
        CaptionStyle.model_validate({"templateId": "karaoke"}),
        CaptionStyle.model_validate({"templateId": "boxed"}),
    )
    assert layered is not None
    assert layered.template_id == "boxed"


def test_resolve_uses_the_track_template_for_an_unstyled_cue() -> None:
    """What makes a track-wide restyle work: the cue itself carries no style."""
    resolved = resolve_caption_style(None, CaptionStyle.model_validate({"templateId": "karaoke"}))
    template = get_caption_template("karaoke")
    assert template is not None
    assert resolved.font_weight == template.style.font_weight


def test_resolve_applies_clip_over_track_over_template() -> None:
    resolved = resolve_caption_style(
        CaptionStyle.model_validate({"textColor": "#ffd84d"}),
        CaptionStyle.model_validate({"templateId": "karaoke", "fontScale": 1.4}),
    )
    template = get_caption_template("karaoke")
    assert template is not None
    assert resolved.text_color == "#ffd84d"  # clip wins
    assert resolved.font_scale == 1.4  # track fills what the clip left unset
    assert resolved.font_weight == template.style.font_weight  # template fills the rest


def test_resolve_without_a_track_default_behaves_as_v10() -> None:
    style = CaptionStyle.model_validate({"templateId": "karaoke"})
    assert resolve_caption_style(style) == resolve_caption_style(style, None)


def test_resolve_carries_accent_keywords_through(  # schema v11 field
) -> None:
    """`accent.mode: 'keywords'` was dead in v10 for want of this list."""
    resolved = resolve_caption_style(
        CaptionStyle.model_validate(
            {"accent": {"mode": "keywords", "keywords": ["viral", "growth"]}}
        )
    )
    assert resolved.accent is not None
    assert resolved.accent.keywords == ["viral", "growth"]
