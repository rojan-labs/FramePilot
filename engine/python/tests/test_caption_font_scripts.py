"""The caption font catalog's ``scripts`` lists are measured from the font files.

The agent is told which scripts a family can draw (``discover_caption_styles``) and warned
when a caption's text needs one its font lacks. Both read the TypeScript catalog, so a list
that disagrees with the file would warn about nothing or stay silent over missing-glyph
boxes. This re-measures every bundled family from its ``cmap`` and compares.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from framepilot_engine.render.font_coverage import (
    FONTS_DIR,
    SCRIPT_CORES,
    SCRIPT_ORDER,
    cmap_codepoints,
    family_scripts,
    manifest_scripts,
    scripts_covered,
)

_TS_ARTIFACT = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "timeline-schema"
    / "schema"
    / "caption-fonts.json"
)


def _catalog() -> dict[str, object]:
    document: dict[str, object] = json.loads(_TS_ARTIFACT.read_text(encoding="utf-8"))
    return document


def test_the_catalog_lists_exactly_the_scripts_each_font_file_covers() -> None:
    fonts = _catalog()["fonts"]
    assert isinstance(fonts, list)
    declared = {font["family"]: font["scripts"] for font in fonts}
    assert declared == manifest_scripts()


def test_the_script_vocabulary_matches_the_typescript_catalog() -> None:
    assert list(SCRIPT_ORDER) == _catalog()["scripts"]
    assert set(SCRIPT_CORES) == set(SCRIPT_ORDER)


def test_the_run_that_needed_this() -> None:
    # Desktop run 001be135: Poppins carried the Hindi, Bebas Neue the accent — and Bebas
    # Neue has no Devanagari, so the accented words drew as missing-glyph boxes.
    measured = manifest_scripts()
    assert "devanagari" in measured["Poppins"]
    assert "devanagari" not in measured["Bebas Neue"]
    assert measured["Bebas Neue"][:1] == ["latin"]


def test_a_family_covers_only_what_every_one_of_its_files_covers(tmp_path: Path) -> None:
    regular = FONTS_DIR / "Rubik-Variable.ttf"
    latin_only = FONTS_DIR / "BebasNeue-Regular.ttf"
    assert "hebrew" in family_scripts([regular])
    assert "hebrew" not in family_scripts([regular, latin_only])
    with pytest.raises(ValueError, match="at least one file"):
        family_scripts([])


def test_a_script_needs_its_whole_core_alphabet() -> None:
    core = SCRIPT_CORES["devanagari"]
    assert "devanagari" in scripts_covered(frozenset(core))
    missing_one = frozenset(core - {min(core)})
    assert "devanagari" not in scripts_covered(missing_one)


def test_a_font_without_a_cmap_table_is_refused() -> None:
    # An sfnt header that declares one table, which is not a cmap.
    header = struct.pack(">IHHHH", 0x00010000, 1, 16, 0, 0)
    record = struct.pack(">4sIII", b"head", 0, 28, 0)
    with pytest.raises(ValueError, match="no cmap"):
        cmap_codepoints(header + record)


def test_a_truncated_font_is_refused() -> None:
    with pytest.raises(ValueError, match="truncated"):
        cmap_codepoints(b"\x00\x01\x00\x00")
