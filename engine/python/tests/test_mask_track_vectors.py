"""The transform-track vectors are exactly what the engine produces (MK7.1).

``tests/fixtures/mask-track/transforms.json`` is asserted byte for byte by the TypeScript side
(``apps/web-editor/src/preview/masks/mask-track.test.ts``). This test keeps it honest: the stored
file must equal a fresh generation. Regenerate with ``pnpm mask-track:vectors``.
"""

from __future__ import annotations

import pytest

from tests import mask_track_vectors as vectors


@pytest.mark.parametrize("name", sorted(vectors.DOCUMENTS))
def test_stored_vectors_match_the_engine(name: str) -> None:
    stored = (vectors.FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8")
    assert vectors.serialize(vectors.DOCUMENTS[name]()) == stored


def test_the_vectors_cover_every_method_and_both_ends_of_the_range() -> None:
    document = vectors.DOCUMENTS["transforms"]()
    assert set(document["tracks"]) == {"position", "similarity", "perspective", "shape"}
    for track in document["tracks"].values():
        assert track["method"] in {
            "position",
            "position-scale-rotation",
            "perspective",
            "point-cloud",
        }
    # The first and last case of every track are outside the tracked range, where the nearest
    # end has to hold rather than the mask jumping back to untracked geometry.
    for name in document["tracks"]:
        cases = [case for case in document["cases"] if case["track"] == name]
        assert cases[0]["frameIndex"] == 0
        assert cases[-1]["frameIndex"] == len(document["tracks"][name]["pts"]) - 1
