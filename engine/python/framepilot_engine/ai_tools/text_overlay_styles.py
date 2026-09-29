"""Text overlay styles and bundled font families for the ``add_text_layer`` twin.

Loads ``text_overlay_styles.json``, the committed artifact generated from the canonical
TypeScript catalog (``packages/timeline-schema/src/text-overlay-styles.ts`` via
``pnpm schema:generate``). The engine defines no look of its own: a style is PURE DATA that
the tool writes into the overlay's ``text`` effect params, exactly as the web editor's
``textOverlayLookParams`` and the TS ``add_text_layer`` do. Nothing resolves a style id at
render time, which is why the artifact lives beside the tools and not in ``render/``.

``tests/test_text_overlay_styles.py`` guards byte-level drift against the TS-side artifact.
"""

from __future__ import annotations

import json
from functools import cache
from importlib import resources
from typing import Any

__all__ = [
    "bundled_font_families",
    "text_overlay_style_categories",
    "text_overlay_style_ids",
    "text_overlay_style_params",
    "weight_the_family_has",
]


@cache
def _styles() -> dict[str, dict[str, Any]]:
    """The packaged catalog's styles, keyed by id, in catalog order."""
    payload = (
        resources.files("framepilot_engine.ai_tools")
        .joinpath("text_overlay_styles.json")
        .read_text(encoding="utf-8")
    )
    styles = json.loads(payload).get("styles")
    if not isinstance(styles, list):  # pragma: no cover - corrupt artifact
        raise ValueError("text_overlay_styles.json: expected a 'styles' array")
    return {str(style["id"]): style for style in styles}


@cache
def text_overlay_style_categories() -> tuple[str, ...]:
    """Every style category id, in gallery order (the discovery tool's ``category`` enum)."""
    payload = (
        resources.files("framepilot_engine.ai_tools")
        .joinpath("text_overlay_styles.json")
        .read_text(encoding="utf-8")
    )
    categories = json.loads(payload).get("categories")
    if not isinstance(categories, list):  # pragma: no cover - corrupt artifact
        raise ValueError("text_overlay_styles.json: expected a 'categories' array")
    return tuple(str(category["id"]) for category in categories)


def text_overlay_style_ids() -> tuple[str, ...]:
    """Every style id, in catalog order (the TS ``add_text_layer`` ``style`` enum)."""
    return tuple(_styles())


def text_overlay_style_params(style_id: str) -> dict[str, Any]:
    """The params a style writes: its whole look plus ``templateId`` for provenance.

    Mirrors ``textOverlayLookParams`` (web editor) and the TS tool: the same keys, so a style
    applied through either host lands as the same patch. Raises ``KeyError`` for an unknown
    id; the argument schema has already refused one.
    """
    look: dict[str, Any] = _styles()[style_id]["look"]
    return {
        "fontFamily": look["fontFamily"],
        "fontWeight": look["fontWeight"],
        "color": look["color"],
        "fontSizePercent": look["fontSizePercent"],
        "align": look["align"],
        "boxWidthPercent": look["boxWidthPercent"],
        "xPercent": look["xPercent"],
        "yPercent": look["yPercent"],
        "background": look["background"],
        "typography": look["typography"],
        "templateId": style_id,
    }


@cache
def _font_manifest() -> dict[str, dict[str, Any]]:
    """The renderer's bundled font manifest (generated from the caption font catalog)."""
    payload = (
        resources.files("framepilot_engine.render")
        .joinpath("fonts", "manifest.json")
        .read_text(encoding="utf-8")
    )
    families = json.loads(payload).get("families")
    if not isinstance(families, dict):  # pragma: no cover - corrupt artifact
        raise ValueError("fonts/manifest.json: expected a 'families' object")
    return families


def bundled_font_families() -> tuple[str, ...]:
    """The families the renderer bundles (the TS ``bundledFontFamily`` enum)."""
    return tuple(_font_manifest())


def weight_the_family_has(family: object, weight: object) -> object:
    """``weight`` held inside a bundled ``family``'s range (TS ``weightTheFamilyHas``).

    A family named over a style carries the style's weight with it, and neither renderer
    synthesises a weight the file lacks, so the param is made to say what is drawn. Anything
    that is not a bundled family and an integer weight is returned unchanged.
    """
    entry = _font_manifest().get(family) if isinstance(family, str) else None
    if entry is None or not isinstance(weight, int) or isinstance(weight, bool):
        return weight
    return min(int(entry["maxWeight"]), max(int(entry["minWeight"]), weight))


#: A plain text overlay's look in caption terms (TS ``PLAIN_TEXT_OVERLAY_TYPOGRAPHY``): the fixed
#: black stroke of a twelfth of the size (16/12 sixteenths) and a square box padded by two
#: strokes. A typography arg on an overlay with no typography starts from this, as the
#: Inspector's first edit does, so writing one field does not also drop the stroke.
PLAIN_TEXT_OVERLAY_TYPOGRAPHY: dict[str, Any] = {
    "outlineColor": "#000000",
    "outlineWidth": 16 / 12,
    "background": {"radius": 0, "paddingX": 1 / 6, "paddingY": 1 / 6},
}

#: The family a typed overlay is drawn in when none is stored (``render/text_overlay.py``).
_TYPED_DEFAULT_FAMILY = "Inter"


def italic_font_families() -> tuple[str, ...]:
    """The bundled families that ship an italic file: the only ones either renderer slants."""
    return tuple(
        family
        for family, entry in _font_manifest().items()
        if isinstance(entry.get("italicFile"), str)
    )


def italic_refusal(font_style: object, family: object) -> str | None:
    """Why an explicit italic would draw upright (TS ``assertItalicIsDrawn``), else ``None``."""
    if font_style != "italic":
        return None
    drawn_in = family if isinstance(family, str) else _TYPED_DEFAULT_FAMILY
    italic = italic_font_families()
    if drawn_in in italic:
        return None
    return (
        f'{drawn_in} ships no italic, so fontStyle "italic" would draw upright in the preview '
        f"and the export alike. Pass fontFamily as one that has an italic: {', '.join(italic)}."
    )


def with_typography_args(typography: object, fields: dict[str, Any]) -> dict[str, Any]:
    """``typography`` with each typography arg over its one field (TS ``withTypographyArgs``).

    ``shadow: "none"`` removes the shadow; no typography yet starts from
    :data:`PLAIN_TEXT_OVERLAY_TYPOGRAPHY`.
    """
    base = dict(PLAIN_TEXT_OVERLAY_TYPOGRAPHY if not isinstance(typography, dict) else typography)
    shadow = fields.get("shadow")
    base.update({key: value for key, value in fields.items() if key != "shadow"})
    if shadow == "none":
        base.pop("shadow", None)
    elif shadow is not None:
        base["shadow"] = shadow
    return base
