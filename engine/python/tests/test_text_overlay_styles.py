"""The text overlay style catalog the ``add_text_layer`` twin writes looks from.

A style is pure data the tool copies into the overlay's params, so the engine must read the
exact catalog the web editor and the TS tool publish: the packaged copy is byte-for-byte the
TS-generated one, and a style's params are its whole look plus its id, like
``textOverlayLookParams``.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PACKAGED = (
    Path(__file__).resolve().parents[1]
    / "framepilot_engine"
    / "ai_tools"
    / "text_overlay_styles.json"
)
GENERATED = REPO / "packages" / "timeline-schema" / "schema" / "text-overlay-styles.json"


def test_the_packaged_catalog_is_the_generated_one() -> None:
    assert PACKAGED.read_text(encoding="utf-8") == GENERATED.read_text(encoding="utf-8")


def test_the_catalog_names_its_default_style() -> None:
    data = json.loads(PACKAGED.read_text(encoding="utf-8"))
    assert data["defaultStyleId"] in {style["id"] for style in data["styles"]}
