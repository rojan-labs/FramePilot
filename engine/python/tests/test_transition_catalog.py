"""The engine's copy of the transition catalog must not drift from the TS source.

``transition_catalog.json`` is generated from ``transition-catalog.ts`` and copied
here by ``pnpm schema:generate``. Nothing stops the two from parting company except
this test and its TS-side twin — and a catalog that differs across the two
renderers is a transition that previews as one thing and exports as another.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from framepilot_engine.render import transition_catalog as catalog

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_ARTIFACT = REPO_ROOT / "packages" / "timeline-schema" / "schema" / "transition-catalog.json"
ENGINE_ARTIFACT = (
    REPO_ROOT / "engine" / "python" / "framepilot_engine" / "render" / "transition_catalog.json"
)


def test_engine_copy_is_byte_identical_to_the_typescript_artifact() -> None:
    assert ENGINE_ARTIFACT.read_text(encoding="utf-8") == TS_ARTIFACT.read_text(encoding="utf-8")


def test_catalog_loads_every_entry() -> None:
    raw = json.loads(ENGINE_ARTIFACT.read_text(encoding="utf-8"))
    loaded = catalog.load_catalog()
    assert len(loaded.transitions) == len(raw["transitions"])
    assert len(loaded.params) == len(raw["params"])


def test_every_entry_names_a_kind_with_declared_params() -> None:
    for entry in catalog.load_catalog().transitions.values():
        assert catalog.params_for_kind(entry.render_kind), entry.id


def test_every_entry_only_overrides_params_its_kind_declares() -> None:
    for entry in catalog.load_catalog().transitions.values():
        declared = {p.name for p in catalog.params_for_kind(entry.render_kind)}
        assert set(entry.params) <= declared, entry.id


def test_resolve_params_layers_defaults_under_overrides() -> None:
    resolved = catalog.resolve_params("flash")
    assert resolved["red"] == pytest.approx(1.0)
    assert resolved["blend"] == pytest.approx(1.0)
    # A param the entry never mentions still comes back at the kind default.
    assert "hold" in resolved


def test_clamp_drops_unknown_names_and_bounds_the_rest() -> None:
    clamped = catalog.clamp_params("mosaic", {"blockPx": 9999, "nonsense": 3})
    assert clamped["blockPx"] == pytest.approx(160.0)
    assert "nonsense" not in clamped


def test_clamp_ignores_values_that_are_not_numbers() -> None:
    default = catalog.default_params("mosaic")["blockPx"]
    assert catalog.clamp_params("mosaic", {"blockPx": "wide"})["blockPx"] == default
    assert catalog.clamp_params("mosaic", {"blockPx": float("nan")})["blockPx"] == default


def test_unknown_kind_answers_empty_rather_than_raising() -> None:
    # A project from a newer build must degrade, not abort a render.
    assert catalog.params_for_kind("teleport") == ()
    assert catalog.default_params("teleport") == {}
    assert catalog.get_transition("teleport") is None
    assert catalog.resolve_params("teleport") == {}


def test_apply_path_is_declared_for_every_kind() -> None:
    for kind in catalog.known_kinds():
        assert catalog.apply_path(kind) in {"geometry", "mask", "frame"}


def test_directions_use_one_vocabulary() -> None:
    for kind in catalog.known_kinds():
        for direction in catalog.directions_for_kind(kind):
            assert direction in {"left", "right", "up", "down", "in", "out"}
