"""The one definition of synthetic asset ids and clip kind (plan/elements EL3).

The table in ``tests/fixtures/clip-kind.json`` is shared with
``packages/editor-core/src/synthetic-assets.test.ts``, so both runtimes answer every row the same
way. The guard below fails when a sentinel id is spelled, copied or compared outside
``timeline/synthetic_assets.py``: adding a synthetic kind must be a change to one module.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.timeline.synthetic_assets import (
    CAPTION_ASSET_ID,
    SYNTHETIC_ASSET_IDS,
    TEXT_OVERLAY_ASSET_ID,
    clip_render_kind,
    has_time_based_source,
    is_synthetic_asset_id,
    lane_type_for_kind,
    synthetic_clip_kind,
)

ENGINE = Path(__file__).resolve().parents[1] / "framepilot_engine"
REPO = Path(__file__).resolve().parents[3]
HOME = ENGINE / "timeline" / "synthetic_assets.py"
CASES: list[dict[str, Any]] = json.loads(
    (REPO / "tests" / "fixtures" / "clip-kind.json").read_text()
)["cases"]


class _Clip:
    def __init__(self, asset_id: str) -> None:
        self.asset_id = asset_id


@pytest.mark.parametrize("row", CASES, ids=lambda row: f"{row['assetId']}-{row['assetKind']}")
def test_every_row_agrees_with_the_typescript_twin(row: dict[str, Any]) -> None:
    kind = clip_render_kind(row["assetId"], row["assetKind"])
    assert kind == row["kind"]
    assert is_synthetic_asset_id(row["assetId"]) is row["synthetic"]
    assert has_time_based_source(_Clip(row["assetId"])) is row["hasTimeBasedSource"]
    assert lane_type_for_kind(kind) == row["laneType"]


def test_names_what_each_synthetic_id_draws() -> None:
    assert synthetic_clip_kind(TEXT_OVERLAY_ASSET_ID) == "text"
    assert synthetic_clip_kind(CAPTION_ASSET_ID) == "caption"
    assert synthetic_clip_kind("cam-a") is None


def test_keeps_the_persisted_sentinel_values() -> None:
    # Saved projects hold these strings; changing one orphans every title or caption in them.
    assert sorted(SYNTHETIC_ASSET_IDS) == ["__caption__", "__text__"]


_NAMES = r"(?:TEXT_OVERLAY_ASSET_ID|CAPTION_ASSET_ID|TEXT_ASSET_ID)"
_GUARDS = {
    "spells a sentinel id": re.compile(r"""["'`]__(?:text|caption)__["'`]"""),
    "keeps its own copy of a sentinel constant": re.compile(rf"^\s*{_NAMES}\s*(?::[^=]*)?=[^=]"),
    "compares against a sentinel directly": re.compile(
        rf"[!=]=\s*{_NAMES}\b|\b{_NAMES}\s*[!=]=|\bin\s*\(\s*{_NAMES}"
    ),
}


@pytest.mark.parametrize("rule", sorted(_GUARDS))
def test_no_engine_module_decides_synthetic_ids_itself(rule: str) -> None:
    pattern = _GUARDS[rule]
    offenders = [
        f"{path.relative_to(ENGINE)}:{number}"
        for path in sorted(ENGINE.rglob("*.py"))
        if path != HOME
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if pattern.search(line)
    ]
    assert offenders == [], f"a module {rule}; ask timeline/synthetic_assets.py instead"
