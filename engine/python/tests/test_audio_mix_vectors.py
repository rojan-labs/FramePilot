"""The audio-mix vectors are exactly what the export applies.

``tests/fixtures/audio-mix/envelopes.json`` is the engine's side of the preview/export audio
mix gate. The preview's ``mix-envelope.ts`` is asserted against it, so a stale file would
quietly weaken that gate. Regenerate with ``pnpm audio-mix:vectors``.
"""

from __future__ import annotations

import json
import math
from typing import Any

from tests import audio_mix_vectors as vectors

#: The engine's numbers go through the platform's libm (`sin`, `pow`), whose last bit differs
#: between macOS and Linux; the TypeScript gate is 1e-9, so this is well inside it.
NUMERIC_TOLERANCE = 1e-12


def _assert_same(fresh: Any, stored: Any, where: str = "$") -> None:
    if isinstance(fresh, float) or isinstance(stored, float):
        assert math.isclose(fresh, stored, rel_tol=0.0, abs_tol=NUMERIC_TOLERANCE), where
    elif isinstance(fresh, dict):
        assert fresh.keys() == stored.keys(), where
        for key in fresh:
            _assert_same(fresh[key], stored[key], f"{where}.{key}")
    elif isinstance(fresh, list):
        assert len(fresh) == len(stored), where
        for index, (a, b) in enumerate(zip(fresh, stored, strict=True)):
            _assert_same(a, b, f"{where}[{index}]")
    else:
        assert fresh == stored, where


def test_stored_vectors_match_the_engine() -> None:
    stored = json.loads(vectors.FIXTURE.read_text(encoding="utf-8"))
    _assert_same(json.loads(vectors.serialize(vectors.document())), stored)


def test_the_cases_cover_every_part_of_the_envelope() -> None:
    effects = [effect for *_, effect, _ in vectors.CASES if effect is not None]
    params = [effect["params"] for effect in effects]
    assert any(p.get("muted") for p in params)
    assert {p.get("fadeCurve", "linear") for p in params if "fadeInSeconds" in p} == {
        "linear",
        "equal-power",
        "smooth",
    }
    assert any(p.get("duckUnderTrackId") == "speech" for p in params)
    easings = {k["easing"] for effect in effects for k in effect["keyframes"]}
    assert easings == {"linear", "ease-in", "ease-out", "ease-in-out", "hold", "bezier"}
    assert any("handles" in k for effect in effects for k in effect["keyframes"])


def test_a_duck_and_a_fade_really_move_the_gain() -> None:
    """Negative control: a vector file of constants would pass any implementation."""
    doc = vectors.document()
    by_name = {case["name"]: case for case in doc["cases"]}
    assert len(set(by_name["duck-under-speech"]["expected"])) > 3
    assert min(by_name["fades-linear"]["expected"]) == 0.0
    assert set(by_name["muted"]["expected"]) == {0.0}
