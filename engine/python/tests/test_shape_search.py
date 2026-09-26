"""The engine's shape search is TypeScript's (plan/elements EL5.6).

``search_elements`` runs in either runtime; both must find the same shapes in the same order. The
table is written by ``packages/timeline-schema/src/shape-search.test.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.shape_catalog import search_shapes

REPO = Path(__file__).resolve().parents[3]
CASES: list[dict[str, Any]] = json.loads(
    (REPO / "tests" / "fixtures" / "shape-search.json").read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: f"{case['query']!r}/{case['scope']}")
def test_finds_what_typescript_finds(case: dict[str, Any]) -> None:
    hits, total = search_shapes(case["query"], case["scope"], case["limit"])
    assert [hit.preset_id for hit in hits] == case["ids"]
    assert total == case["total"]
