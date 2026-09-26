"""The Lucide icons as shapes (plan/elements EL5.5).

``scripts/elements/build_icons.mjs`` writes the outlines twice — the schema package's copy and
the engine's — with Lucide's licence beside each, and the names alone into the TS validator. The
three must agree, the notice must travel with the data, and every icon the catalogue draws must
exist.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from framepilot_engine.render.shape_catalog import (
    ICON_PREFIX,
    load_shape_catalog,
    load_shape_icons,
    shape_descriptor,
)

REPO = Path(__file__).resolve().parents[3]
RENDER = Path(__file__).resolve().parents[1] / "framepilot_engine" / "render"
SCHEMA = REPO / "packages" / "timeline-schema" / "schema"
NAMES_MODULE = REPO / "packages" / "timeline-schema" / "src" / "shape-icon-names.ts"
PATH_COMMANDS = re.compile(r"^(?:[MLCZ]|-?\d+(?:\.\d+)?)(?: (?:[MLCZ]|-?\d+(?:\.\d+)?))*$")


def test_the_packaged_icons_are_the_generated_ones() -> None:
    packaged = (RENDER / "shape_icons.json").read_bytes()
    assert packaged == (SCHEMA / "shape-icons.json").read_bytes()


def test_the_lucide_licence_travels_with_both_copies() -> None:
    for directory in (RENDER, SCHEMA):
        licence = (directory / "LICENSE-lucide.txt").read_text(encoding="utf-8")
        assert "ISC License" in licence
        assert "Lucide Contributors" in licence
    source = json.loads((RENDER / "shape_icons.json").read_text(encoding="utf-8"))["source"]
    assert "LICENSE-lucide.txt" in source


def test_the_validator_names_are_the_icon_ids() -> None:
    module = NAMES_MODULE.read_text(encoding="utf-8")
    match = re.search(r"= '([^']*)'\.split", module)
    assert match is not None
    names = match.group(1).split(" ")
    assert [ICON_PREFIX + name for name in names] == list(load_shape_icons())
    assert len(names) > 1500


def test_every_outline_uses_only_the_commands_the_rasteriser_reads() -> None:
    for icon_id, descriptor in load_shape_icons().items():
        assert PATH_COMMANDS.match(str(descriptor.geometry["path"])), icon_id


def test_every_icon_the_catalogue_draws_exists() -> None:
    for descriptor in load_shape_catalog().values():
        if descriptor.generator == "path":
            assert isinstance(descriptor.geometry.get("path"), str), descriptor.id


def test_an_icon_id_resolves_to_a_path_box_shape() -> None:
    check = shape_descriptor("icon/check")
    assert check is not None
    assert (check.frame, check.generator, check.knobs) == ("box", "path", ())
    assert shape_descriptor("icon/not-an-icon") is None
