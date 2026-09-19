"""The key colour-chart vectors are exactly what the engine produces (MK6.3).

``tests/fixtures/mask-key/charts.json`` is the engine's side of the plan-06 gate. The preview is
measured against it on the CPU (``key-mask.test.ts``) and on a real GPU (the ``mask-key-parity``
Playwright spec), so a stale file would quietly weaken both. Regenerate with
``pnpm key-mask:vectors``.
"""

from __future__ import annotations

import json

from tests import key_mask_vectors as vectors


def test_stored_vectors_match_the_engine() -> None:
    stored = (vectors.FIXTURE_DIR / "charts.json").read_text(encoding="utf-8")
    fresh = json.dumps(vectors.document(), indent=1, ensure_ascii=False) + "\n"
    assert fresh == stored


def test_the_charts_cover_both_matrices_and_both_ranges() -> None:
    labels = {f"{chart['matrix']}/{chart['range']}" for chart in vectors.encodings()}
    assert labels == {"bt601/full", "bt601/limited", "bt709/full", "bt709/limited"}


def test_the_masks_cover_every_model_and_the_edge_controls() -> None:
    models = {mask["model"] for mask in vectors.MASKS}
    assert models == {"hsl", "rgb", "luma", "3d"}
    assert any(mask.get("shadowRetention") for mask in vectors.MASKS)
    assert any(mask.get("finesse") for mask in vectors.MASKS)
    assert any(mask.get("invert") for mask in vectors.MASKS)
    # A wrapping hue range is the case an axis-aligned implementation gets wrong.
    assert any(
        entry["low"] > entry["high"] for mask in vectors.MASKS for entry in mask.get("ranges", [])
    )


def test_limited_range_loses_the_codes_it_cannot_carry() -> None:
    """The point of generating through an encoding: the colours differ per range."""
    full = next(c for c in vectors.encodings() if c["range"] == "full" and c["matrix"] == "bt709")
    limited = next(
        c for c in vectors.encodings() if c["range"] == "limited" and c["matrix"] == "bt709"
    )
    assert full["colours"] != limited["colours"]
