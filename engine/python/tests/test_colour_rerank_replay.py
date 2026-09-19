"""AM2.7: the colour re-ranker's committed numbers, re-derived in CI without the SigLIP weights.

Three checks, each against the files ``tests/colour_rerank_replay.py`` wrote:

* the report's AM2.6 / AM2.7 numbers follow from the replay file (real SigLIP cosines plus the
  committed measurements), and the AM2.7 rule meets every AM5 gate on every set;
* the frozen thresholds are the fit on the calibration sets, rounded as the shipped constants;
* the synthetic crops, regenerated from their seeds (identical pixels, checked by digest), encoded
  and decoded again on THIS machine's ffmpeg, measure as committed — same class for every crop —
  and the rule still takes the same decisions with the fresh measurements.
"""

from __future__ import annotations

import json
import shutil
from typing import Any

import pytest

from tests import colour_rerank_replay as replay


def _load(path: Any) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


@pytest.fixture(scope="module")
def committed() -> dict[str, Any]:
    return _load(replay.REPLAY_FILE)


def test_the_report_follows_from_the_replay_file(committed: dict[str, Any]) -> None:
    report = _load(replay.REPORT_FILE)["am2.7"]["sets"]
    assert replay.replay_report(committed) == report


def test_the_measured_rule_meets_every_ai_masking_gate(committed: dict[str, Any]) -> None:
    for name, scored in replay.replay_report(committed).items():
        gates = scored["am2.7"]["gates"]
        assert all(gate["pass"] for gate in gates.values()), (name, gates)
        assert scored["am2.7"]["misses"] == [], name


def test_the_frozen_thresholds_are_the_calibration_fit(committed: dict[str, Any]) -> None:
    samples = [
        (crop["colour"], entry["crops"][crop["id"]]["measurement"])
        for entry in committed["sets"].values()
        if entry["role"] == "calibration"
        for frame in entry["frames"]
        for crop in frame["crops"]
    ]
    fit = replay.fit_thresholds(samples)
    assert _same(fit, committed["thresholds"]["fit"])
    assert replay.frozen_from_fit(fit) == committed["thresholds"]["frozen"]


def _same(left: Any, right: Any) -> bool:
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(
            _same(a, b) for a, b in zip(left, right, strict=True)
        )
    if isinstance(left, float):
        return left == pytest.approx(right, abs=1e-9)
    return bool(left == right)


def test_the_held_out_set_was_not_calibrated_on(committed: dict[str, Any]) -> None:
    roles = {name: entry["role"] for name, entry in committed["sets"].items()}
    assert roles["heldOut-424242"] == "heldOut"
    assert sum(role == "heldOut" for role in roles.values()) == 1


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg with libx264")
@pytest.mark.parametrize(("name", "role", "seed"), replay.SYNTHETIC_SETS)
def test_regenerated_crops_measure_as_committed(
    committed: dict[str, Any], name: str, role: str, seed: int
) -> None:
    entry = committed["sets"][name]
    assert entry["role"] == role
    fresh = replay.measure_synthetic(seed)
    assert fresh.digest == entry["sceneDigest"], "the scene generator no longer draws these crops"
    thresholds = committed["thresholds"]["frozen"]
    for crop_id, value in entry["crops"].items():
        was, now = value["measurement"], fresh.measurements[crop_id]
        assert now is not None, crop_id
        assert abs(now["neutralShare"] - was["neutralShare"]) <= replay.SHARE_TOLERANCE, crop_id
        if was["neutralLightness"] is not None and now["neutralLightness"] is not None:
            drift = abs(now["neutralLightness"] - was["neutralLightness"])
            assert drift <= replay.LIGHTNESS_TOLERANCE, crop_id
        assert replay.measured_class(now, thresholds) == replay.measured_class(was, thresholds), (
            crop_id
        )
    cosines = {crop_id: value["cosines"] for crop_id, value in entry["crops"].items()}
    rescored = replay.score_set(entry["frames"], cosines, fresh.measurements, thresholds, "am2.7")
    assert rescored == replay.replay_report(committed)[name]["am2.7"]
