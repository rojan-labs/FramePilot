"""Real inference on real pixels. Pack build job only.

Every test here is marked ``decoded_media`` and skipped by the default addopts, because it
needs the ``cv`` extra AND the pinned weights on disk. There is no fake backend in this
file on purpose: it is the only place that finds out what the real export actually does.

That earned its keep on 2026-09-07, the first time it ran against fetched weights: the
towers publish TWO outputs, and taking ``run(None, …)[0]`` had been reading
``last_hidden_state`` — the per-patch tokens, ``(batch, 196, 768)`` — instead of the
pooled embedding. No fake backend could have shown that.
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


def test_the_towers_embed_from_the_pooled_output_not_the_patch_tokens() -> None:
    """One vector per input, of the model's width — not one per image patch.

    The regression this pins: an export publishes `last_hidden_state` first and
    `pooler_output` second, so selecting by position silently returns a `(196, 768)` token
    grid per image. It still normalises, still has a plausible length, and produces a shot
    ledger of meaningless vectors.
    """
    import numpy

    from framepilot_visual_embed.onnx_backend import EMBEDDING_OUTPUT, OnnxVisualEmbedBackend

    backend = OnnxVisualEmbedBackend()
    frame = numpy.zeros((240, 320, 3), dtype=numpy.uint8)
    vectors = backend.encode_images([frame, frame])
    assert len(vectors) == 2
    assert all(len(vector) == backend.image_dim for vector in vectors)
    # Every element is a scalar — the failure mode was rows that were themselves arrays.
    assert all(isinstance(value, float) for value in vectors[0])
    # L2-normalised, which is what lets the policy layer treat a dot product as a cosine.
    assert numpy.isclose(numpy.linalg.norm(vectors[0]), 1.0, atol=1e-5)
    assert EMBEDDING_OUTPUT == "pooler_output"


def test_a_close_up_photograph_labels_closer_than_a_landscape() -> None:
    """The first real accuracy signal, and the reason it is not asserted anywhere else.

    The plan's targets (shot size >= 75% exact, >= 95% within one step) are measured
    against the VU0.2 hand-labelled fixtures, not here. This is the smoke test that the
    towers are wired the right way round; it must be replaced by the labelled-fixture
    evaluation before any accuracy claim is made.
    """
    pytest.skip("needs the VU0.2 labelled fixtures; see plan/visual-understanding/06")
