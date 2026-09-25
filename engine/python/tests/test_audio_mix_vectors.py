"""The audio-mix vectors are exactly what the export applies.

``tests/fixtures/audio-mix/envelopes.json`` is the engine's side of the preview/export audio
mix gate. The preview's ``mix-envelope.ts`` is asserted against it, so a stale file would
quietly weaken that gate. Regenerate with ``pnpm audio-mix:vectors``.
"""

from __future__ import annotations

from tests import audio_mix_vectors as vectors


def test_stored_vectors_match_the_engine() -> None:
    stored = vectors.FIXTURE.read_text(encoding="utf-8")
    assert vectors.serialize(vectors.document()) == stored


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
