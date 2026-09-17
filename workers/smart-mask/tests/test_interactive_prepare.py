"""BR3.13: warm segment_frame with an embedding LRU; prepare cache keyed by digest, EP, OS, runtime."""

from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path
from typing import Any

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")
pytest.importorskip("PIL")

from fakes import truth  # noqa: E402
from pipeline_harness import FakeProvider, make_clip, square_frames  # noqa: E402

from framepilot_smart_mask.backend import AcceleratorOutOfMemoryError  # noqa: E402
from framepilot_smart_mask.interactive import (  # noqa: E402
    EmbeddingLRU,
    FrameKey,
    InteractiveSegmenter,
    preview_dimensions,
)
from framepilot_smart_mask.prepare import CompiledModelCache, cache_key  # noqa: E402
from framepilot_smart_mask.protocol import (  # noqa: E402
    ProtocolError,
    SegmentFrameRequest,
    parse_input_line,
)
from framepilot_smart_mask.runtime import CancellationFlag  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def request(clip: Path, pts: int, **parameters: Any) -> SegmentFrameRequest:
    message = {
        "type": "request", "protocolVersion": 1, "requestId": "seg", "projectRevision": 1,
        "media": {"handleId": "m", "assetId": "a", "absolutePath": str(clip), "sourceStartSeconds": 0.0,
                  "sourceEndSeconds": 1.0, "fps": 24.0, "firstFrame": 0, "lastFrameExclusive": 1},
        "capability": "subject.segment_frame", "parameters": {"pts": pts, "previewHeight": 180, **parameters},
    }  # fmt: skip
    parsed = parse_input_line(json.dumps(message))
    assert isinstance(parsed, SegmentFrameRequest)
    return parsed


def decode_png(encoded: str) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_UNCHANGED)


@needs_ffmpeg
def test_click_hover_and_box_reuse_one_embedding(tmp_path: Path) -> None:
    from framepilot_smart_mask.media import FfmpegTools, verify_tools

    clip = tmp_path / "clip.mkv"
    make_clip(clip, square_frames(8))
    tools = FfmpegTools(*verify_tools({"FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG": "1"}))
    provider = FakeProvider()
    segmenter = InteractiveSegmenter(provider, tools)
    pts = tools.probe(str(clip)).pts
    x = (10 + 3 * 2 + 12) / 160
    click = segmenter.segment(
        request(clip, pts[3], points=[{"x": x, "y": 42 / 90, "label": "include"}]),
        CancellationFlag(),
    )
    hover = segmenter.segment(
        request(clip, pts[3], hoverPoint={"x": x, "y": 42 / 90}), CancellationFlag()
    )
    box = segmenter.segment(
        request(
            clip, pts[3], box={"x": 16 / 160, "y": 30 / 90, "width": 24 / 160, "height": 24 / 90}
        ),
        CancellationFlag(),
    )
    assert segmenter.cache.misses == 1 and segmenter.cache.hits == 2, (
        "one image encode for three requests"
    )
    assert provider.sam_opens == 1
    expected = (
        cv2.resize(truth(8)[3].astype(np.uint8) * 255, (160, 90), interpolation=cv2.INTER_AREA)
        > 127
    )
    for outcome in (click, hover, box):
        mask = decode_png(outcome.mask_png_base64)
        assert mask.shape == (outcome.height, outcome.width) == (90, 160)
        assert (
            np.logical_and(mask > 127, expected).sum() / np.logical_or(mask > 127, expected).sum()
            > 0.8
        )
        assert 0.0 <= outcome.score <= 1.0
    with pytest.raises(ProtocolError, match="not a decoded frame"):
        segmenter.segment(
            request(clip, pts[3] + 1, hoverPoint={"x": 0.5, "y": 0.5}), CancellationFlag()
        )


def test_embedding_lru_is_bounded() -> None:
    from framepilot_smart_mask.backend import ImageFeatures

    def features() -> ImageFeatures:
        return ImageFeatures(*(np.zeros(1000, np.float32) for _ in range(4)))  # 16 KB each

    cache = EmbeddingLRU(max_bytes=40_000)
    for pts in range(5):
        cache.put(FrameKey("clip", 1, 1, pts), features())
    assert cache.bytes <= 40_000 and len(cache) == 2
    assert (
        cache.get(FrameKey("clip", 1, 1, 0)) is None
        and cache.get(FrameKey("clip", 1, 1, 4)) is not None
    )
    assert cache.get(FrameKey("clip", 1, 2, 4)) is None, "a changed file is a different key"


def test_preview_dimensions() -> None:
    assert preview_dimensions(1920, 1080, 360) == (640, 360)
    assert preview_dimensions(160, 90, 1080) == (160, 90)


def test_cache_key_changes_with_every_input() -> None:
    base = cache_key("d" * 64, "cpu", "1.30.0", "Darwin-25.2", "arm64")
    variants = [
        cache_key("e" * 64, "cpu", "1.30.0", "Darwin-25.2", "arm64"),
        cache_key("d" * 64, "coreml", "1.30.0", "Darwin-25.2", "arm64"),
        cache_key("d" * 64, "cpu", "1.31.0", "Darwin-25.2", "arm64"),
        cache_key("d" * 64, "cpu", "1.30.0", "Darwin-26.0", "arm64"),
        cache_key("d" * 64, "cpu", "1.30.0", "Darwin-25.2", "x86_64"),
    ]
    assert base not in variants and len(set(variants)) == len(variants)


def test_cpu_graph_is_prepared_once_and_a_damaged_cache_is_rebuilt(tmp_path: Path) -> None:
    source = tmp_path / "model.onnx"
    source.write_bytes(b"source graph")
    built: list[Path | None] = []
    loaded: list[Path] = []

    def build(save_to: Path | None) -> str:
        built.append(save_to)
        if save_to is not None:
            save_to.write_bytes(b"optimised graph")
        return "built"

    def load(path: Path) -> str:
        loaded.append(path)
        return "loaded"

    cache = CompiledModelCache(tmp_path / "cache", "1.30.0")
    assert cache.cpu_graph("m", "d" * 64, source, build, load) == "built"
    assert cache.cpu_graph("m", "d" * 64, source, build, load) == "loaded"
    assert cache.report.misses == ["m"] and cache.report.hits == ["m"]
    cached = loaded[0]
    cached.write_bytes(b"corrupted")
    assert cache.cpu_graph("m", "d" * 64, source, build, load) == "built"
    assert cache.report.discarded == ["m"]
    uncached = CompiledModelCache(None, "1.30.0")
    assert uncached.cpu_graph(
        "m", "d" * 64, source, build, load
    ) == "built" and uncached.report.uncached == ["m"]
    coreml = cache.coreml_directory("encoder", "d" * 64)
    assert coreml is not None and coreml.is_dir()


def test_accelerator_oom_falls_back_to_cpu_once_and_is_recorded(tmp_path: Path) -> None:
    from framepilot_smart_mask.onnx_backend import GuardedSession

    class Session:
        def __init__(self, provider: str, fail: bool) -> None:
            self.provider = provider
            self.fail = fail

        def run(self, _outputs: Any, feeds: dict[str, Any]) -> list[Any]:
            if self.fail:
                raise RuntimeError("DmlExecutionProvider: 887A0005 out of memory")
            return [self.provider]

    fallbacks: list[dict[str, str]] = []
    created: list[str] = []

    def factory(provider: str) -> Session:
        created.append(provider)
        return Session(provider, fail=provider != "cpu")

    session = GuardedSession(tmp_path / "m.onnx", "birefnet", "directml", fallbacks.append, factory)  # type: ignore[arg-type]
    assert session.run({"image": np.zeros(1)}) == ["cpu"]
    assert created == ["directml", "cpu"] and session.provider == "cpu"
    assert fallbacks == [
        {"model": "m.onnx", "from": "directml", "to": "cpu", "reason": "accelerator out of memory"}
    ]

    cpu_only = GuardedSession(
        tmp_path / "m.onnx", "birefnet", "cpu", fallbacks.append, lambda p: Session(p, fail=True)
    )  # type: ignore[arg-type]
    with pytest.raises(AcceleratorOutOfMemoryError):
        cpu_only.run({"image": np.zeros(1)})
