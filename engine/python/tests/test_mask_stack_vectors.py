"""The preview mask stack vectors are exactly what the engine produces (MK3.2).

``tests/fixtures/mask-raster/legacy.json`` (Pillow ``gaussian-legacy`` bytes) and
``stack-clips.json`` (float64 digests of whole clips' stacks) are asserted byte for byte by the
TypeScript preview (``apps/web-editor/src/preview/masks``). This test keeps them honest: the
stored files must equal a fresh generation. Regenerate with ``pnpm mask-raster:vectors``.
"""

from __future__ import annotations

import pytest

from tests import mask_stack_vectors as vectors


@pytest.mark.parametrize("name", sorted(vectors.DOCUMENTS))
def test_stored_vectors_match_the_engine(name: str) -> None:
    stored = (vectors.FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8")
    assert vectors.serialize(vectors.DOCUMENTS[name]()) == stored


def test_the_vectors_cover_every_mode_legacy_and_effect_targets() -> None:
    ids = [case["id"] for case in vectors.STACK_CASES]
    for mode in ("add", "subtract", "intersect", "difference", "lighten", "darken"):
        assert f"stack/mode-{mode}" in ids
    assert any(case.get("effects") for case in vectors.STACK_CASES)
    assert len(vectors.LEGACY_CASES) >= 15
