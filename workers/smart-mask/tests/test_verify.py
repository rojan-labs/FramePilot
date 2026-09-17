"""BR3.7: verification checks, review ranges, and report.json."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("cv2")

from fakes import square_frames, truth  # noqa: E402

from framepilot_smart_mask.flow import flow as dis_flow  # noqa: E402
from framepilot_smart_mask.flow import gray  # noqa: E402
from framepilot_smart_mask.protocol import MAX_REVIEW_RANGES  # noqa: E402
from framepilot_smart_mask.report import build_report, write_report  # noqa: E402
from framepilot_smart_mask.verify import (  # noqa: E402
    Thresholds,
    flag_frames,
    frame_signals,
    primary_reason,
    review_ranges,
)

GOOD = {
    "samPairIoU": 1.0,
    "samBirefnetIoU": 1.0,
    "hardDisagreementFraction": 0.0,
    "bandFraction": 0.1,
    "estimates": 4.0,
}


def signals_for(
    alphas: list[np.ndarray], frames: np.ndarray, scores: list[dict] | None = None
) -> list[dict]:
    grays = [gray(frame) for frame in frames]
    bands = [np.zeros(alpha.shape, bool) for alpha in alphas]
    cache: dict[tuple[int, int], np.ndarray] = {}

    def flow(source: int, target: int) -> np.ndarray:
        if (source, target) not in cache:
            cache[(source, target)] = dis_flow(grays[source], grays[target])
        return cache[(source, target)]

    scores = scores or [GOOD] * len(alphas)
    return [
        frame_signals(i, alphas, grays, flow, scores[i], (5.0, 5.0), bands)
        for i in range(len(alphas))
    ]


def test_a_correct_clip_is_verified() -> None:
    frames = square_frames(10)
    alphas = [np.where(mask, 255, 0).astype(np.uint8) for mask in truth(10)]
    flags = flag_frames(signals_for(alphas, frames), Thresholds(), locked=set())
    assert flags == [[] for _ in range(10)]


def test_a_dropped_frame_and_a_disagreement_are_flagged_with_reasons() -> None:
    frames = square_frames(10)
    alphas = [np.where(mask, 255, 0).astype(np.uint8) for mask in truth(10)]
    alphas[4] = np.zeros_like(alphas[4])  # subject lost on one frame
    alphas[7][60:80, 100:140] = 255  # an extra island
    scores = [GOOD] * 10
    scores[2] = {**GOOD, "samPairIoU": 0.7}
    flags = flag_frames(signals_for(alphas, frames, scores), Thresholds(), locked={7})
    assert "h" in flags[4] and primary_reason(flags[4]) == "subject_lost"
    assert "e" in flags[2] and primary_reason(flags[2]) == "estimates_disagree"
    assert flags[7] == [], "a locked frame is editor-approved"
    unlocked = flag_frames(signals_for(alphas, frames, scores), Thresholds(), locked=set())
    assert "b" in unlocked[7] and primary_reason(unlocked[7]) == "new_region"


def test_a_frame_without_a_measurement_is_never_verified() -> None:
    frames = square_frames(4)
    alphas = [np.where(mask, 255, 0).astype(np.uint8) for mask in truth(4)]
    scores = [GOOD] * 4
    scores[1] = {"samPairIoU": float("nan")}
    flags = flag_frames(signals_for(alphas, frames, scores), Thresholds(), locked=set())
    assert "u" in flags[1]


def test_object_score_contradiction_is_occlusion() -> None:
    frames = square_frames(4)
    alphas = [np.where(mask, 255, 0).astype(np.uint8) for mask in truth(4)]
    signals = signals_for(alphas, frames)
    signals[2]["fwdScore"] = -3.0
    assert primary_reason(flag_frames(signals, Thresholds(), set())[2]) == "occlusion"


def test_ranges_merge_by_reason_and_stay_under_the_bound() -> None:
    pts = list(range(0, 1000, 10))
    flags = [[] for _ in pts]
    flags[1] = flags[2] = flags[3] = ["e"]
    flags[4] = ["h"]
    flags[9] = ["a", "e"]
    ranges = review_ranges(flags, pts)
    assert [(r.start_pts, r.end_pts, r.reason) for r in ranges] == [
        (10, 30, "estimates_disagree"),
        (40, 40, "subject_lost"),
        (90, 90, "flow_inconsistent"),
    ]
    many = [["e"] if i % 2 else [] for i in range(2 * MAX_REVIEW_RANGES + 10)]
    bounded = review_ranges(many, list(range(len(many))))
    assert len(bounded) <= MAX_REVIEW_RANGES
    covered = {i for r in bounded for i in range(r.start_pts, r.end_pts + 1)}
    assert all(i in covered for i, checks in enumerate(many) if checks), (
        "merging never drops a flagged frame"
    )


def test_report_is_compact_and_has_no_nan(tmp_path: Path) -> None:
    report = build_report(
        frames=[{"pts": 0, "score": float("nan"), "checks": ["e"]}],
        job={"thresholds": Thresholds().as_json()},
    )
    path = tmp_path / "report.json"
    write_report(path, report)
    parsed = json.loads(path.read_text())
    assert parsed["frames"][0]["score"] is None
    assert parsed["job"]["thresholds"]["version"] == "br0-attempt-4"
    assert b"NaN" not in path.read_bytes() and b", " not in path.read_bytes()
