"""BR3.14: memory ceiling on physical footprint, window watchdog, progressive output and resume."""

from __future__ import annotations

import sys

import pytest

from framepilot_smart_mask.memory import MemoryGovernor, physical_footprint_bytes
from framepilot_smart_mask.protocol import ProtocolError
from framepilot_smart_mask.runtime import CancellationFlag


@pytest.mark.skipif(
    sys.platform not in ("darwin", "linux"),
    reason="footprint probe covered on macOS and Linux here",
)
def test_footprint_probe_reads_this_process() -> None:
    footprint = physical_footprint_bytes()
    assert 10 * 2**20 < footprint < 64 * 2**30


def test_ceiling_breach_cancels_with_a_typed_failure() -> None:
    samples = iter([1_000, 5_000, 9_000])
    flag = CancellationFlag()
    governor = MemoryGovernor(8_000, flag, probe=lambda: next(samples))
    assert governor.sample() is False and governor.sample() is False
    assert governor.sample() is True
    assert governor.breach == "memory_ceiling" and governor.peak_bytes == 9_000
    with pytest.raises(ProtocolError) as caught:
        flag.raise_if_cancelled()
    assert caught.value.code == "internal_error" and "memory" in caught.value.detail
    assert governor.report() == {
        "ceilingBytes": 8_000,
        "peakFootprintBytes": 9_000,
        "breach": "memory_ceiling",
    }


def test_window_deadline_breach_and_reset() -> None:
    now = [0.0]
    flag = CancellationFlag()
    governor = MemoryGovernor(10**12, flag, probe=lambda: 1, clock=lambda: now[0])
    governor.window_started(10)
    now[0] = 600 + 90 * 10 - 1
    assert governor.sample() is False
    governor.window_finished()
    now[0] = 10**6
    assert governor.sample() is False, "no deadline between windows"
    governor.window_started(1)
    now[0] += 10**4
    assert governor.sample() is True and governor.breach == "window_timeout"


def test_governor_thread_samples_until_stopped() -> None:
    import time

    calls = []
    flag = CancellationFlag()
    with MemoryGovernor(10**12, flag, probe=lambda: calls.append(1) or 1, interval=0.01):
        time.sleep(0.08)
    count = len(calls)
    time.sleep(0.05)
    assert count >= 3 and len(calls) == count and not flag.is_cancelled()


def test_windows_are_encoded_and_checkpointed_as_they_finish(tmp_path) -> None:  # type: ignore[no-untyped-def]
    import json
    import shutil

    np = pytest.importorskip("numpy")
    pytest.importorskip("cv2")
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    from pipeline_harness import make_clip, request_for, run_job, square_frames

    clip = tmp_path / "clip.mkv"
    make_clip(clip, square_frames(30))
    staging = tmp_path / "staging"
    (staging / "inputs").mkdir(parents=True)
    finished_during_run: list[list[str]] = []

    class Watch(list):
        def append(self, item: tuple) -> None:
            super().append(item)
            if item[0] == "decode" and item[1] == 1:
                windows = staging / "windows"
                finished_during_run.append(
                    sorted(p.parent.name for p in windows.glob("*/done.json"))
                    if windows.exists()
                    else []
                )

    box = {"x": 10 / 160, "y": 30 / 90, "width": 24 / 160, "height": 24 / 90}
    outcome = run_job(
        request_for(clip, staging, 30, [{"kind": "box", "pts": 0, "box": box}]), progress=Watch()
    )
    assert finished_during_run == [[], ["1"], ["1", "2"]], (
        "each window is on disk before the next one decodes"
    )
    assert not (staging / "windows").exists() and not (staging / "scratch").exists()
    assert outcome.artifact.frame_count == 30
    del np, json


def test_an_accelerator_fallback_is_reported_in_the_result_backend(tmp_path) -> None:  # type: ignore[no-untyped-def]
    pytest.importorskip("onnxruntime")
    from framepilot_smart_mask.onnx_backend import OnnxModelProvider

    provider = OnnxModelProvider(tmp_path)
    provider._chosen.update({"sam": "cpu", "birefnet": "directml"})
    provider._fallbacks.append(
        {
            "model": "birefnet_hr_matting_1024.fp16s.onnx",
            "from": "directml",
            "to": "cpu",
            "reason": "accelerator out of memory",
        }
    )
    assert provider.backend_label.endswith(":birefnet=directml:sam=cpu:fallback=directml")
    assert len(provider.backend_label) <= 128
    assert provider.provider_report()["fallbacks"][0]["reason"] == "accelerator out of memory"
