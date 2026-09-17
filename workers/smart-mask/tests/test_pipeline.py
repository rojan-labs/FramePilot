"""BR3.8: the whole job with scripted models — host verification, locks, brushes, partial re-runs."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")
pytest.importorskip("PIL")
pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

from fakes import truth  # noqa: E402
from pipeline_harness import (  # noqa: E402
    FakeProvider,
    host_verify,
    make_clip,
    request_for,
    run_job,
    square_frames,
)

from framepilot_smart_mask.pipeline import affected_ranges  # noqa: E402

BOX = {"x": 10 / 160, "y": 30 / 90, "width": 24 / 160, "height": 24 / 90}
COUNT = 30


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.logical_and(a, b).sum() / max(np.logical_or(a, b).sum(), 1))


@pytest.fixture
def clip(tmp_path: Path) -> Path:
    path = tmp_path / "clip.mkv"
    make_clip(path, square_frames(COUNT))
    return path


def staging_dir(tmp_path: Path, name: str = "staging") -> Path:
    directory = tmp_path / name
    directory.mkdir()
    (directory / "inputs").mkdir()
    return directory


def test_a_box_prompt_produces_a_host_verifiable_matte_across_windows(
    tmp_path: Path, clip: Path
) -> None:
    staging = staging_dir(tmp_path)
    provider = FakeProvider()
    events: list = []
    outcome = run_job(
        request_for(clip, staging, COUNT, [{"kind": "box", "pts": 0, "box": BOX}]),
        provider,
        progress=events,
    )
    matte = host_verify(staging, outcome, clip, 0, COUNT)
    expected = truth(COUNT)
    assert min(iou(matte[i] >= 128, expected[i]) for i in range(COUNT)) > 0.9
    assert outcome.summary.verified_frames + outcome.summary.flagged_frames == COUNT
    assert provider.max_open == 1, "SAM and BiRefNet are never loaded together"
    report = json.loads((staging / "report.json").read_text())
    assert len(report["frames"]) == COUNT and report["job"]["tile"]["size"] == 64
    assert report["job"]["windows"] == {"frames": 16, "overlap": 6}
    phases = {phase for phase, _, _ in events}
    assert {
        "prepare",
        "decode",
        "segment",
        "refine",
        "consensus",
        "matte",
        "stabilise",
        "verify",
        "encode",
    } <= phases


def test_locked_frames_are_bit_identical_and_brush_pixels_forced(
    tmp_path: Path, clip: Path
) -> None:
    staging = staging_dir(tmp_path)
    inputs = staging / "inputs"
    probe_staging = staging_dir(tmp_path, "probe")
    base = run_job(
        request_for(
            clip,
            probe_staging,
            COUNT,
            [{"kind": "box", "pts": 0, "box": BOX}],
            files=["matte.mkv", "frames.json"],
        )
    )
    pts = json.loads((probe_staging / "frames.json").read_text())["pts"]
    lock = np.zeros((90, 160), np.uint8)
    lock[30:54, 10 + 12 * 2 : 34 + 12 * 2] = 255
    lock[40, 40] = 77  # fractional value survives
    brush = np.full((90, 160), 128, np.uint8)
    brush[0:5, 0:5] = 255
    brush[35:40, 10 + 20 * 2 : 20 + 20 * 2] = 0
    (inputs / "locked").mkdir()
    (inputs / "corrections").mkdir()
    cv2.imwrite(str(inputs / "locked" / f"{pts[12]}.png"), lock)
    cv2.imwrite(str(inputs / "corrections" / f"{pts[20]}.png"), brush)
    request = request_for(
        clip, staging, COUNT,
        [
            {"kind": "box", "pts": pts[0], "box": BOX},
            {"kind": "lock", "pts": pts[12], "file": f"locked/{pts[12]}.png"},
            {"kind": "brush", "pts": pts[20], "file": f"corrections/{pts[20]}.png"},
        ],
        inputs={"handleId": "in", "absolutePath": str(inputs), "files": [f"locked/{pts[12]}.png", f"corrections/{pts[20]}.png"]},
    )  # fmt: skip
    outcome = run_job(request)
    matte = host_verify(staging, outcome, clip, 0, COUNT)
    assert np.array_equal(matte[12], lock)
    assert (matte[20][0:5, 0:5] == 255).all() and (matte[20][35:40, 50:60] == 0).all()
    assert outcome.summary.locked_frames == 1
    del base


def test_a_partial_rerun_reuses_unaffected_frames_bit_for_bit(tmp_path: Path, clip: Path) -> None:
    count = 60
    long_clip = tmp_path / "long.mkv"
    make_clip(long_clip, square_frames(count, step=1))
    first = staging_dir(tmp_path, "first")
    outcome = run_job(
        request_for(
            long_clip,
            first,
            count,
            [{"kind": "box", "pts": 0, "box": BOX}],
            files=["matte.mkv", "frames.json", "foreground.mkv"],
        )
    )
    first_matte = host_verify(first, outcome, long_clip, 0, count)
    pts = json.loads((first / "frames.json").read_text())["pts"]

    second = staging_dir(tmp_path, "second")
    previous = second / "inputs" / "previous"
    previous.mkdir()
    shutil.copyfile(first / "matte.mkv", previous / "matte.mkv")
    shutil.copyfile(first / "frames.json", previous / "frames.json")
    keep = np.full((90, 160), 128, np.uint8)
    keep[70:80, 140:150] = 255  # a correction the first matte does not satisfy
    (second / "inputs" / "corrections").mkdir()
    cv2.imwrite(str(second / "inputs" / "corrections" / f"{pts[55]}.png"), keep)
    request = request_for(
        long_clip, second, count,
        [
            {"kind": "box", "pts": pts[0], "box": BOX},
            {"kind": "brush", "pts": pts[55], "file": f"corrections/{pts[55]}.png"},
        ],
        inputs={"handleId": "in", "absolutePath": str(second / "inputs"),
                "files": ["previous/matte.mkv", "previous/frames.json", f"corrections/{pts[55]}.png"]},
        previous="c" * 64, files=["matte.mkv", "frames.json", "report.json"],
    )  # fmt: skip
    from framepilot_smart_mask.pipeline import PipelineConfig

    config = PipelineConfig(
        window_frames=16,
        window_overlap=6,
        embedding_ram_bytes=64 * 2**20,
        matting_tile=64,
        affect_radius=10,
    )
    rerun = run_job(request, config=config)
    second_matte = host_verify(second, rerun, long_clip, 0, count)
    reused = [f["reused"] for f in json.loads((second / "report.json").read_text())["frames"]]
    unaffected = [i for i, flag in enumerate(reused) if flag]
    assert unaffected and all(np.array_equal(second_matte[i], first_matte[i]) for i in unaffected)
    assert (second_matte[55][70:80, 140:150] == 255).all()


def test_affected_ranges_merge_and_clip() -> None:
    assert affected_ranges([5, 100, 130], 200, radius=20) == [(0, 26), (80, 151)]
    assert affected_ranges([], 10) == []


def test_resume_reuses_finished_windows(tmp_path: Path, clip: Path) -> None:
    from framepilot_smart_mask.protocol import ProtocolError
    from framepilot_smart_mask.runtime import CancellationFlag

    staging = staging_dir(tmp_path)
    request = request_for(clip, staging, COUNT, [{"kind": "box", "pts": 0, "box": BOX}])
    flag = CancellationFlag()
    events: list = []

    class StopAfterFirstWindow(list):
        def append(self, item: tuple) -> None:
            super().append(item)
            if item[0] == "encode" and item[1] == item[2] and item[2] > 1:
                flag.cancel()

    with pytest.raises(ProtocolError) as caught:
        run_job(request, cancellation=flag, progress=StopAfterFirstWindow())
    assert caught.value.code == "cancelled"
    assert (staging / "windows" / "1" / "done.json").is_file(), (
        "the finished window survives the crash"
    )
    provider = FakeProvider()
    outcome = run_job(request, provider, progress=events)
    assert any(phase == "encode" for phase, _, _ in events)
    host_verify(staging, outcome, clip, 0, COUNT)
    uninterrupted = staging_dir(tmp_path, "clean")
    clean = run_job(
        request_for(clip, uninterrupted, COUNT, [{"kind": "box", "pts": 0, "box": BOX}])
    )
    assert (staging / "matte.mkv").read_bytes() == (uninterrupted / "matte.mkv").read_bytes(), (
        "identical to an uninterrupted run"
    )
    del clean
