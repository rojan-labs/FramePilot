"""The channel-strip vectors are what the export's filtergraph produces.

``tests/fixtures/audio-mix/strips.json`` is ffmpeg's side of the preview/export channel-strip
gate; ``channel-strip.test.ts`` and the ``audio-strip-parity`` Playwright spec hold the monitor to
it. Regenerated here through this machine's ffmpeg and compared within the gate's own tolerance,
because the stored file may have been written by a different ffmpeg build whose float32 biquads
round differently. Regenerate with ``pnpm audio-mix:vectors``.
"""

from __future__ import annotations

import json

import numpy as np

from tests import audio_strip_vectors as vectors

#: The gate's tolerance (-80 dBFS): an ffmpeg build difference is far below it, a changed filter
#: string or DSP is far above it.
TOLERANCE = 1e-4


def test_stored_vectors_match_this_ffmpeg() -> None:
    stored = json.loads(vectors.FIXTURE.read_text(encoding="utf-8"))
    fresh = vectors.document()
    assert [case["filter"] for case in fresh["cases"]] == [
        case["filter"] for case in stored["cases"]
    ]
    for new, old in zip(fresh["cases"], stored["cases"], strict=True):
        assert new["normalizeGainDb"] == old["normalizeGainDb"], new["name"]
        for channel in ("left", "right"):
            error = np.max(np.abs(np.asarray(new[channel]) - np.asarray(old[channel])))
            assert error <= TOLERANCE, (new["name"], channel, error)
    for new, old in zip(fresh["downmix"], stored["downmix"], strict=True):
        assert new["channels"] == old["channels"]
        for side in ("left", "right"):
            # A 16-bit reading: each weight is known to about 1/29 000.
            assert np.max(np.abs(np.asarray(new[side]) - np.asarray(old[side]))) < 1e-4
    for new, old in zip(fresh["impulses"], stored["impulses"], strict=True):
        assert new["filter"] == old["filter"]
        assert np.max(np.abs(np.asarray(new["response"]) - np.asarray(old["response"]))) < 1e-9


def test_the_strips_cover_every_processor_and_band_kind() -> None:
    params = [params for _, params in vectors.STRIPS]
    assert any(p.get("normalize") for p in params)
    assert any("dynamics" in p for p in params)
    kinds = {band["kind"] for p in params for band in p.get("eq", {}).get("bands", [])}
    assert kinds == {"low-shelf", "peaking", "high-shelf", "high-pass", "low-pass"}
