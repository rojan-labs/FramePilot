"""``subject.segment_frame``: click-to-mask and hover highlight against a warm worker.

The warm process keeps the SAM graphs loaded and caches each frame's image embedding in a
bounded LRU keyed by (media file identity, pts), so hovering over the same frame or adding a
second click costs one decoder call (≈ 70 ms on the CPU EP, BR0.7) instead of an image encode
(≈ 5 s). Nothing here writes project state: the result is a preview-resolution PNG the host
turns into a hover highlight or the first frame of an AI Object mask.
"""

from __future__ import annotations

import base64
import logging
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import cv2
import numpy as np

from .backend import ImageFeatures, ModelProvider, SamModules, VideoInfo
from .protocol import MAX_PREVIEW_HEIGHT, ProtocolError, SegmentFrameRequest
from .runtime import CancellationFlag, SegmentFrameOutcome
from .tracker import PointPrompt, SamTracker, preprocess, video_logits

_log = logging.getLogger(__name__)

DEFAULT_CACHE_BYTES: Final = 512 * 1024 * 1024
MAX_PROBES: Final = 16


@dataclass(frozen=True, slots=True)
class FrameKey:
    path: str
    size: int
    mtime_ns: int
    pts: int


class EmbeddingLRU:
    """Image embeddings by frame, bounded in bytes."""

    def __init__(self, max_bytes: int = DEFAULT_CACHE_BYTES) -> None:
        self.max_bytes = max_bytes
        self._entries: OrderedDict[FrameKey, ImageFeatures] = OrderedDict()
        self._bytes = 0
        self.hits = 0
        self.misses = 0

    @property
    def bytes(self) -> int:
        return self._bytes

    def get(self, key: FrameKey) -> ImageFeatures | None:
        found = self._entries.get(key)
        if found is None:
            self.misses += 1
            return None
        self._entries.move_to_end(key)
        self.hits += 1
        return found

    def put(self, key: FrameKey, features: ImageFeatures) -> None:
        if features.nbytes > self.max_bytes:
            return
        if key in self._entries:
            self._bytes -= self._entries.pop(key).nbytes
        self._entries[key] = features
        self._bytes += features.nbytes
        while self._bytes > self.max_bytes:
            _, evicted = self._entries.popitem(last=False)
            self._bytes -= evicted.nbytes

    def __len__(self) -> int:
        return len(self._entries)


def preview_dimensions(width: int, height: int, preview_height: int) -> tuple[int, int]:
    target_h = max(1, min(preview_height, height, MAX_PREVIEW_HEIGHT))
    target_w = max(1, round(width * target_h / height))
    return target_w, target_h


class InteractiveSegmenter:
    def __init__(
        self, provider: ModelProvider, media: Any, cache_bytes: int = DEFAULT_CACHE_BYTES
    ) -> None:
        self.provider = provider
        self.media = media
        self.cache = EmbeddingLRU(cache_bytes)
        self._sam: SamModules | None = None
        self._probes: OrderedDict[tuple[str, int, int], VideoInfo] = OrderedDict()

    def _modules(self) -> SamModules:
        if self._sam is None:
            self._sam = self.provider.open_sam()
        return self._sam

    def _probe(self, path: str) -> tuple[VideoInfo, int, int]:
        stat = Path(path).stat()
        key = (path, stat.st_size, stat.st_mtime_ns)
        info = self._probes.get(key)
        if info is None:
            info = self.media.probe(path)
            self._probes[key] = info
            while len(self._probes) > MAX_PROBES:
                self._probes.popitem(last=False)
        return info, stat.st_size, stat.st_mtime_ns

    def segment(
        self, request: SegmentFrameRequest, cancellation: CancellationFlag
    ) -> SegmentFrameOutcome:
        path = request.media.absolute_path
        try:
            info, size, mtime = self._probe(path)
        except OSError as error:
            raise ProtocolError("media_unreadable", "The media file could not be read.") from error
        try:
            index = info.pts.index(request.pts)
        except ValueError as error:
            raise ProtocolError(
                "invalid_request", "The requested pts is not a decoded frame of this media."
            ) from error
        width, height = info.display_size
        key = FrameKey(path, size, mtime, request.pts)
        cancellation.raise_if_cancelled()
        features = self.cache.get(key)
        sam = self._modules()
        if features is None:
            frame = next(iter(self.media.frames(path, info, index, 1)))
            features = sam.encode_image(preprocess(frame))
            self.cache.put(key, features)
        cancellation.raise_if_cancelled()
        prompt = _prompt(request)
        tracker = SamTracker(sam, lambda _index: features)
        output = tracker.condition(0, prompt)
        logits = video_logits(output.low_res, height, width)
        preview_w, preview_h = preview_dimensions(width, height, request.preview_height)
        mask = np.where(logits > 0, 255, 0).astype(np.uint8)
        if output.score <= 0:
            mask[:] = 0
        small = cv2.resize(mask, (preview_w, preview_h), interpolation=cv2.INTER_AREA)
        ok, encoded = cv2.imencode(".png", small)
        if not ok:
            raise ProtocolError("internal_error", "The preview mask could not be encoded.")
        score = output.iou if output.score > 0 else 0.0
        return SegmentFrameOutcome(
            pts=request.pts,
            width=preview_w,
            height=preview_h,
            mask_png_base64=base64.b64encode(encoded.tobytes()).decode("ascii"),
            score=float(min(max(score, 0.0), 1.0)),
        )

    def close(self) -> None:
        if self._sam is not None:
            self._sam.close()
            self._sam = None


def _prompt(request: SegmentFrameRequest) -> PointPrompt:
    coords: list[tuple[float, float]] = []
    labels: list[int] = []
    if request.box is not None:
        box = request.box
        coords += [(box.x, box.y), (box.x + box.width, box.y + box.height)]
        labels += [2, 3]
    for point in request.points:
        coords.append((point.x, point.y))
        labels.append(1 if point.label == "include" else 0)
    if not coords and request.hover_point is not None:
        coords.append((request.hover_point.x, request.hover_point.y))
        labels.append(1)
    return PointPrompt(coords=tuple(coords), labels=tuple(labels))


__all__ = ["EmbeddingLRU", "FrameKey", "InteractiveSegmenter", "preview_dimensions"]
