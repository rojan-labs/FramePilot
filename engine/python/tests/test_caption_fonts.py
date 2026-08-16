"""Cross-runtime caption font catalog and bundled-asset parity."""

from __future__ import annotations

import json
from pathlib import Path

from framepilot_engine.render.captions import _bundled_font_path, _load_font

_ENGINE_DIR = Path(__file__).resolve().parents[1] / "framepilot_engine" / "render" / "fonts"
_TS_ARTIFACT = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "timeline-schema"
    / "schema"
    / "caption-fonts.json"
)


def test_every_catalog_font_resolves_to_a_bundled_face() -> None:
    catalog = json.loads(_TS_ARTIFACT.read_text(encoding="utf-8"))
    assert len(catalog["fonts"]) >= 20
    for font in catalog["fonts"]:
        resolved = _bundled_font_path(font["family"], 700, False)
        assert resolved is not None
        path, _variable = resolved
        assert Path(path).is_file()
        assert Path(path).stat().st_size > 1_000


def test_representative_new_faces_load_in_the_rasterizer() -> None:
    for family in ("Montserrat", "Bebas Neue", "Playfair Display", "Pacifico"):
        font = _load_font(family, 32, 700, False)
        assert font.getbbox("FramePilot captions") is not None


def test_manifest_contains_exactly_the_catalog_families() -> None:
    catalog = json.loads(_TS_ARTIFACT.read_text(encoding="utf-8"))
    manifest = json.loads((_ENGINE_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert set(manifest["families"]) == {font["family"] for font in catalog["fonts"]}
