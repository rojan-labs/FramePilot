"""Real inference on real pixels. Pack build job only.

Every test here is marked ``decoded_media`` and skipped by the default addopts, because it
needs the ``cv`` extra AND the pinned weights. Until the weights are fetched and pinned it
cannot pass, and it must not be made to look as though it did: there is no fake backend in
this file on purpose.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.decoded_media


def test_the_real_backend_loads_and_embeds() -> None:
    from framepilot_visual_embed.onnx_backend import OnnxVisualEmbedBackend
    from framepilot_visual_embed.prompt_bank import all_prompts

    backend = OnnxVisualEmbedBackend()
    vectors = backend.encode_texts(list(all_prompts()))
    assert len(vectors) == len(all_prompts())
    assert all(len(vector) == backend.image_dim for vector in vectors)


def test_a_close_up_photograph_labels_closer_than_a_landscape() -> None:
    """The first real accuracy signal, and the reason it is not asserted anywhere else.

    The plan's targets (shot size >= 75% exact, >= 95% within one step) are measured
    against the VU0.2 hand-labelled fixtures, not here. This is the smoke test that the
    towers are wired the right way round; it must be replaced by the labelled-fixture
    evaluation before any accuracy claim is made.
    """
    pytest.skip("needs the VU0.2 labelled fixtures; see plan/visual-understanding/06")
