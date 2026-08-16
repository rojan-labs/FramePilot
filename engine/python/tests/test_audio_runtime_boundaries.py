from __future__ import annotations

import numpy as np

from framepilot_engine.audio.filters import build_clip_filter
from framepilot_engine.audio.mixing import automation_envelope, sample_envelope
from framepilot_engine.timeline.models import Keyframe


def test_clip_filtergraph_keeps_channel_strip_order() -> None:
    graph = build_clip_filter(
        normalize_gain_db=-2.0,
        eq_bands=[
            {
                "kind": "peaking",
                "frequencyHz": 1200.0,
                "gainDb": 3.0,
                "q": 0.7,
            }
        ],
        dynamics={
            "thresholdDb": -18.0,
            "ratio": 3.0,
            "attackMs": 10.0,
            "releaseMs": 100.0,
            "makeupGainDb": 2.0,
        },
    )

    assert graph is not None
    parts = graph.split(",")
    assert parts[0].startswith("volume=")
    assert parts[1].startswith("equalizer=")
    assert parts[2].startswith("acompressor=")


def test_automation_envelope_is_segment_vectorized_and_endpoint_exact() -> None:
    lane = [
        Keyframe(id="k0", time=0.0, property="gainDb", value=-12.0, easing="linear"),
        Keyframe(id="k1", time=1.0, property="gainDb", value=0.0, easing="linear"),
        Keyframe(id="k2", time=2.0, property="gainDb", value=-6.0, easing="linear"),
    ]

    envelope = automation_envelope(lane, "gainDb", 2.0, resolution=0.25)
    assert envelope is not None
    times, values = envelope

    measured = sample_envelope(np.asarray([0.0, 1.0, 2.0]), times, values)
    expected = np.asarray([10 ** (-12 / 20), 1.0, 10 ** (-6 / 20)])
    np.testing.assert_allclose(measured, expected, rtol=1e-10, atol=1e-10)
