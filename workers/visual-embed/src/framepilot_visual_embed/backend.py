"""The injectable inference backend boundary.

Everything that needs onnxruntime, a tokenizer, OpenCV or a model file lives behind these
protocols, so the *policy* — how a similarity becomes a label, which faces count, what
order results come out in, how vectors are packed — is pure Python and fully unit testable
with a scripted backend. ``onnx_backend.py`` is the real one and is imported lazily, only
when a worker actually runs.

This is the same split Subject Intelligence draws, and it is what lets this pack be
complete and reviewable before a single weight file exists: adding the weights swaps one
module and changes nothing above it.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

#: An opaque decoded frame. Only the backend interprets it.
Frame = Any
#: An L2-normalised embedding. The policy layer assumes unit length and never re-normalises
#: — a backend that returned unnormalised vectors would make every cosine a dot product of
#: the wrong magnitude, which is a backend bug, not something to paper over here.
Vector = Sequence[float]


class MediaUnreadableError(Exception):
    """The approved media handle could not be opened or decoded."""


class BackendUnavailableError(Exception):
    """The inference runtime itself is missing or refuses to run on this hardware."""


class ModelUnavailableError(Exception):
    """A pinned model file is missing, unreadable, or fails its digest check."""


@runtime_checkable
class VisualEmbedBackend(Protocol):
    @property
    def name(self) -> str:
        """Stable backend identity reported in the handshake and every result."""

    @property
    def model_digests(self) -> dict[str, str]:
        """sha256 of each loaded model file, for evidence lineage."""

    @property
    def image_dim(self) -> int:
        """Dimension of the shared image/text space. Never hardcoded above this line."""

    @property
    def face_dim(self) -> int:
        """Dimension of the face identity space; a different space from ``image_dim``."""

    def decode_keyframes(self, path: str, timestamps: Sequence[float]) -> Sequence[Frame]:
        """Decode exactly one frame per timestamp, in the order given.

        :raises MediaUnreadableError: If the file cannot be opened, or a timestamp cannot
            be decoded. A missing frame is never silently replaced by its neighbour: the
            label would then describe a picture the host did not ask about.
        """

    def encode_images(self, frames: Sequence[Frame]) -> Sequence[Vector]: ...

    def encode_texts(self, texts: Sequence[str]) -> Sequence[Vector]: ...

    def detect_and_embed_faces(self, frame: Frame) -> Sequence[Vector]:
        """One identity vector per face found in ``frame``; empty when there is nobody.

        Detection and identity are one call because the identity model consumes the
        detector's aligned crop; splitting them would put the alignment geometry — the
        part most likely to be wrong — in the policy layer, where it cannot be checked
        against pixels.
        """
