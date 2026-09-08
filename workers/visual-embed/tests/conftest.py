"""Shared fakes for the Visual Embed worker suite.

Everything here exists so the whole worker — protocol, prompt bank, policy, runtime,
packing — can be proved with NO onnxruntime, NO tokenizer, NO OpenCV and NO weight file.
The scripted backend below is the only thing standing in for the real one, and the
boundary it implements is the same :class:`VisualEmbedBackend` protocol
``onnx_backend.OnnxVisualEmbedBackend`` implements.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import pytest

from framepilot_visual_embed.backend import (
    Frame,
    MediaUnreadableError,
    Vector,
)
from framepilot_visual_embed.prompt_bank import PROMPT_GROUPS, all_prompts

DIM = 8
FACE_DIM = 4


def unit(*components: float) -> list[float]:
    """A unit-length vector padded to :data:`DIM`, so cosines are dot products."""
    values = list(components) + [0.0] * (DIM - len(components))
    norm = math.sqrt(sum(value * value for value in values)) or 1.0
    return [value / norm for value in values]


class FakeBackend:
    """A scripted backend with an interpretable geometry.

    Each prompt gets a basis-like vector derived from its position, and an image is simply
    *declared* to sit on one of them. That makes the label a fact about the test rather
    than about a model: "this image is exactly the MCU prompt" must produce ``MCU``, and if
    it ever does not, the failure is in the policy layer, which is the only thing under
    test here.
    """

    name = "fake"
    image_dim = DIM
    face_dim = FACE_DIM

    def __init__(
        self,
        *,
        image_vectors: dict[float, Vector] | None = None,
        faces_per_frame: int = 0,
        unreadable_at: float | None = None,
    ) -> None:
        self._image_vectors = image_vectors or {}
        self._faces_per_frame = faces_per_frame
        self._unreadable_at = unreadable_at
        self.decoded: list[float] = []
        self.text_calls: list[list[str]] = []

    @property
    def model_digests(self) -> dict[str, str]:
        return {"fake.onnx": "a" * 64}

    def decode_keyframes(self, path: str, timestamps: Sequence[float]) -> Sequence[Frame]:
        frames: list[Frame] = []
        for timestamp in timestamps:
            if self._unreadable_at is not None and timestamp == self._unreadable_at:
                raise MediaUnreadableError(f"no frame at {timestamp}")
            self.decoded.append(timestamp)
            frames.append({"t": timestamp, "path": path})
        return frames

    def encode_images(self, frames: Sequence[Frame]) -> Sequence[Vector]:
        return [self._image_vectors.get(frame["t"], unit(1.0)) for frame in frames]

    def encode_texts(self, texts: Sequence[str]) -> Sequence[Vector]:
        self.text_calls.append(list(texts))
        return [prompt_vector(text) for text in texts]

    def detect_and_embed_faces(self, frame: Frame) -> Sequence[Vector]:
        return [[1.0, 0.0, 0.0, float(index)] for index in range(self._faces_per_frame)]


def prompt_vector(text: str) -> list[float]:
    """A deterministic pseudo-basis vector for one phrase, spread over :data:`DIM`."""
    index = all_prompts().index(text) if text in all_prompts() else 0
    angle = (index + 1) * math.pi / (len(all_prompts()) + 1)
    return unit(math.cos(angle), math.sin(angle), math.cos(2 * angle))


def prompt_vectors() -> list[list[float]]:
    return [prompt_vector(prompt) for prompt in all_prompts()]


def vector_for(group_name: str, label: str) -> list[float]:
    """The exact prompt vector a shot must carry to be labelled ``label``."""
    group = next(item for item in PROMPT_GROUPS if item.name == group_name)
    return prompt_vector(group.prompts[group.labels.index(label)])


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend()
