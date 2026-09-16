"""Drift guard for the frame-plan parity vectors (PX1.3), the Python half.

``tests/fixtures/frame-plan/*.json`` stores the engine's plans; ``frame-plan.parity.test.ts``
requires ``framePlanAt`` to reproduce them. This test requires the ENGINE still to produce
them, so a change to ``frame_plan.py`` (or to a compiler decision it shares) cannot land
without regenerating the vectors — which then fails the TypeScript side until it follows.
Regenerate with ``pnpm frame-plan:vectors``.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from tests.frame_plan_vectors import FIXTURE_DIR, fixture_files, regenerate

_AREAS = {"Alpha", "Colour", "Effects", "Geometry", "Layering", "Text", "Time", "Transitions"}


def _stored(name: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))
    return loaded


def test_vectors_cover_every_matrix_area_and_are_not_vacuous() -> None:
    documents = [_stored(path.name) for path in fixture_files()]
    assert {document["area"] for document in documents} == _AREAS
    cases = [case for document in documents for case in document["cases"]]
    # A fixture set that silently lost its cases would pass in both languages.
    assert len(cases) >= 40
    for case in cases:
        assert len(case.get("expected", [])) == len(case["samples"]), case["id"]
    layers = sum(len(plan["layers"]) for case in cases for plan in case["expected"])
    assert layers > 100


@pytest.mark.parametrize("name", [path.name for path in fixture_files()])
def test_stored_vectors_match_the_engine(name: str) -> None:
    stored = _stored(name)
    fresh = regenerate(FIXTURE_DIR / name)
    for stored_case, fresh_case in zip(stored["cases"], fresh["cases"], strict=True):
        assert fresh_case["expected"] == stored_case["expected"], (
            f"{name}:{stored_case['id']} drifted from the engine; run `pnpm frame-plan:vectors` "
            "and make packages/editor-core/src/frame-plan.ts agree."
        )
