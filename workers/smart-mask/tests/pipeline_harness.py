"""End-to-end harness: the real pipeline, scripted models, real ffmpeg, host-style checks."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from fakes import FakeSam, square_frames

from framepilot_smart_mask.media import FfmpegTools, verify_tools
from framepilot_smart_mask.pipeline import MatteJob, PipelineConfig, ToolPaths
from framepilot_smart_mask.protocol import MatteOutcome, MatteRequest, parse_input_line
from framepilot_smart_mask.runtime import CancellationFlag
from framepilot_smart_mask.sandbox import sha256_file

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
ALL_FILES = [
    "matte.mkv",
    "frames.json",
    "foreground.mkv",
    "preview.webm",
    "foreground.preview.webm",
    "report.json",
]


@dataclass
class ColourMatting:
    tile: int = 64
    provider: str = "cpu"

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        red = rgb[..., 0].astype(np.float32) - rgb[..., 1].astype(np.float32)
        return np.clip(red / 150.0, 0.0, 1.0)

    def close(self) -> None:
        pass


@dataclass
class FakeProvider:
    tiles: tuple[int, ...] = (64,)
    sam_opens: int = 0
    matting_opens: int = 0
    open_now: set[str] = field(default_factory=set)
    max_open: int = 0

    backend_label: str = "fake-onnx:sam=cpu:birefnet=cpu"

    @property
    def model_digests(self) -> dict[str, str]:
        return {"fake.onnx": "0" * 63 + "1"}

    @property
    def matting_tiles(self) -> tuple[int, ...]:
        return self.tiles

    def _opened(self, name: str, model: Any) -> Any:
        self.open_now.add(name)
        self.max_open = max(self.max_open, len(self.open_now))
        close = model.close

        def closing() -> None:
            self.open_now.discard(name)
            close()

        model.close = closing
        return model

    def open_sam(self) -> FakeSam:
        self.sam_opens += 1
        return self._opened("sam", FakeSam())

    def open_matting(self, tile: int) -> ColourMatting:
        self.matting_opens += 1
        return self._opened("matting", ColourMatting(tile=tile))

    def fallbacks(self) -> list[dict[str, str]]:
        return []

    def provider_report(self) -> dict[str, Any]:
        return {"chosen": {"sam": "cpu", "birefnet": "cpu"}, "skipped": {}, "fallbacks": []}


def make_clip(path: Path, frames: np.ndarray, rate: int = 24) -> None:
    _count, height, width, _ = frames.shape
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", str(rate),
         "-i", "-", "-c:v", "ffv1", str(path)],
        input=frames.tobytes(), check=True,
    )  # fmt: skip


def request_for(
    clip: Path, staging: Path, count: int, prompts: list[dict[str, Any]], *, inputs: dict[str, Any] | None = None,
    previous: str | None = None, first: int = 0, files: list[str] | None = None,
) -> MatteRequest:  # fmt: skip
    parameters: dict[str, Any] = {
        "output": {
            "handleId": "out",
            "absolutePath": str(staging),
            "allowedFiles": files or ALL_FILES,
            "maxBytes": 10**9,
        },
        "prompts": prompts,
        "previewHeight": 180,
    }
    if inputs is not None:
        parameters["inputs"] = inputs
    if previous is not None:
        parameters["previousArtifact"] = previous
    message = {
        "type": "request", "protocolVersion": 1, "requestId": "job-1", "projectRevision": 1,
        "media": {"handleId": "m", "assetId": "a", "absolutePath": str(clip), "sourceStartSeconds": 0.0,
                  "sourceEndSeconds": 10.0, "fps": 24.0, "firstFrame": first, "lastFrameExclusive": first + count},
        "capability": "subject.matte", "parameters": parameters,
    }  # fmt: skip
    parsed = parse_input_line(json.dumps(message))
    assert isinstance(parsed, MatteRequest)
    return parsed


def run_job(request: MatteRequest, provider: FakeProvider | None = None, config: PipelineConfig | None = None,
            cancellation: CancellationFlag | None = None, progress: list | None = None) -> MatteOutcome:  # fmt: skip
    ffmpeg, ffprobe, report = verify_tools({"FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG": "1"})
    events = progress if progress is not None else []

    def sink(
        phase: str,
        completed: int,
        total: int,
        *,
        round_number: int | None = None,
        detail: str | None = None,
    ) -> None:
        events.append((phase, completed, total))

    job = MatteJob(
        request,
        provider=provider or FakeProvider(),
        media=FfmpegTools(ffmpeg, ffprobe, report),
        tools=ToolPaths(
            str(ffmpeg), str(ffprobe), {"licence": report.licence, "approved": report.approved}
        ),
        config=config
        or PipelineConfig(
            window_frames=16, window_overlap=6, embedding_ram_bytes=64 * 2**20, matting_tile=64
        ),
        progress=sink,  # type: ignore[arg-type]
        cancellation=cancellation or CancellationFlag(),
    )
    return job.run()


def host_verify(
    staging: Path, outcome: MatteOutcome, clip: Path, first: int, count: int
) -> np.ndarray:
    """The checks of apps/desktop/electron/capability-packs/matte-verify.ts, in Python."""
    claimed = {file.name: file for file in outcome.artifact.files}
    entries = {entry.name for entry in staging.iterdir()}
    assert entries - {"inputs"} == set(claimed), f"undeclared or missing files: {entries}"
    for name, file in claimed.items():
        assert (staging / name).stat().st_size == file.bytes
        assert sha256_file(staging / name) == file.sha256
    frames = json.loads((staging / "frames.json").read_text())
    assert set(frames) == {"version", "timeBase", "originPts", "firstFrame", "pts"}
    listed = subprocess.run(
        [
            FFPROBE,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts,flags",
            "-of",
            "json",
            str(clip),
        ],
        capture_output=True,
        check=True,
    ).stdout
    source_pts = sorted(
        int(p["pts"]) for p in json.loads(listed)["packets"] if "D" not in p.get("flags", "")
    )
    assert frames["pts"] == source_pts[first : first + count]
    assert frames["originPts"] == source_pts[0] and frames["firstFrame"] == first
    assert outcome.artifact.frame_count == count and outcome.artifact.first_pts == frames["pts"][0]
    for name in ("matte.mkv", "foreground.mkv", "preview.webm", "foreground.preview.webm"):
        if name not in claimed:
            continue
        probe = json.loads(
            subprocess.run(
                [
                    FFPROBE,
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-count_packets",
                    "-show_entries",
                    "stream=width,height,pix_fmt,nb_read_packets",
                    "-of",
                    "json",
                    str(staging / name),
                ],
                capture_output=True,
                check=True,
            ).stdout
        )["streams"][0]
        assert int(probe["nb_read_packets"]) == count, name
        if name.endswith(".mkv"):
            assert (probe["width"], probe["height"]) == (
                outcome.artifact.width,
                outcome.artifact.height,
            )
            assert probe["pix_fmt"] in (
                {"gray", "gray16le"}
                if name == "matte.mkv"
                else {"gbrp", "bgr0", "rgb24", "bgra", "rgba", "0rgb"}
            )
    width, height = outcome.artifact.width, outcome.artifact.height
    raw = subprocess.run(
        [
            FFMPEG,
            "-v",
            "error",
            "-i",
            str(staging / "matte.mkv"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(count, height, width)


__all__ = ["FakeProvider", "host_verify", "make_clip", "request_for", "run_job", "square_frames"]
