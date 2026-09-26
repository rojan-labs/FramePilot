"""The PX5 Scale fixture's elements variant (plan/elements 02 §9, EL6b).

``scale-elements`` is ``scale-plain`` plus 20 sticker layers over the footage, the case the
elements performance budget names: some outlined, some turning. The sticker files are the
curated ones every build ships, copied beside the sources.
"""

from __future__ import annotations

from pathlib import Path

from tests.px5_scale_fixture import (
    ELEMENT_LAYERS,
    VARIANTS,
    scale_project,
    write_elements,
)

ARTIFACT = {"key": "k", "path": "p"}


def test_the_elements_variant_is_the_plain_row_plus_twenty_sticker_layers() -> None:
    plain = scale_project(12, ARTIFACT, "scale-plain")
    elements = scale_project(12, ARTIFACT, "scale-elements")
    assert "scale-elements" in VARIANTS
    added = [track for track in elements["timeline"]["tracks"] if track["id"].startswith("el-")]
    assert len(added) == ELEMENT_LAYERS == 20
    # Every other track is the plain row's, unchanged, and the title still draws on top.
    rest = [track for track in elements["timeline"]["tracks"] if not track["id"].startswith("el-")]
    assert rest == plain["timeline"]["tracks"]
    assert elements["timeline"]["tracks"][0]["id"] == "words"
    # Each layer is a sticker for the whole row, over the footage: an image asset with element
    # provenance, in the Elements folder.
    stickers = {asset["id"]: asset for asset in elements["assets"] if asset["kind"] == "image"}
    assert len(stickers) == ELEMENT_LAYERS
    for track in added:
        (clip,) = track["clips"]
        asset = stickers[clip["assetId"]]
        assert asset["source"]["provider"] == "fluent-emoji"
        assert asset["path"].startswith("media/elements/fluent3d/")
        assert (clip["start"], clip["end"]) == (0.0, 12.0)
    outlined = [
        t for t in added if any(e["type"] == "edge_style" for e in t["clips"][0]["effects"])
    ]
    turning = [
        t for t in added if any(k["property"] == "rotation" for k in t["clips"][0]["keyframes"])
    ]
    assert len(outlined) == 5
    assert len(turning) == 5


def test_the_sticker_files_are_the_ones_every_build_ships(tmp_path: Path) -> None:
    written = write_elements(tmp_path)
    assert len(written) == ELEMENT_LAYERS
    for relative in written:
        copied = tmp_path / relative
        shipped = (
            Path(__file__).resolve().parents[3]
            / "apps"
            / "web-editor"
            / "public"
            / "elements"
            / "stickers"
            / "full"
            / copied.name
        )
        assert copied.read_bytes() == shipped.read_bytes()
