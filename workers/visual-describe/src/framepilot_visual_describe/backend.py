"""The injectable inference backend boundary.

Everything that needs OpenCV, a llama.cpp binary or a model file lives behind this
protocol, so the *policy* — which frames a shot is described from, what a loose answer is
normalised to, what order results come out in, what a failure means — is pure Python and
fully unit testable with a scripted backend. ``llama_backend.py`` is the real one and is
imported lazily, only when a worker actually runs.

This is the same split Visual Embed draws, and it is what lets this pack be complete and
reviewable before a single weight file exists: adding the weights swaps one module and
changes nothing above it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

#: An opaque decoded frame. Only the backend interprets it.
Frame = Any


class MediaUnreadableError(Exception):
    """The approved media handle could not be opened or decoded."""


class BackendUnavailableError(Exception):
    """The inference runtime itself is missing or refuses to run on this hardware."""


class ModelUnavailableError(Exception):
    """A pinned model or runtime file is missing, unreadable, or fails its digest check."""


class DescribeFailedError(Exception):
    """The model ran but produced nothing readable for this shot.

    Distinct from :class:`MediaUnreadableError` on purpose: one is a fact about the
    footage, the other about the model, and a caller deciding whether to retry needs to
    know which.
    """


@runtime_checkable
class DescribeBackend(Protocol):
    @property
    def name(self) -> str:
        """Stable backend identity reported in the handshake and every result."""

    @property
    def model_id(self) -> str:
        """The producing model's id, stored on every ledger row this pack writes."""

    @property
    def model_digests(self) -> dict[str, str]:
        """sha256 of each loaded model/runtime file, for evidence lineage."""

    def decode_keyframes(self, path: str, timestamps: Sequence[float]) -> Sequence[Frame]:
        """Decode exactly one frame per timestamp, in the order given.

        :raises MediaUnreadableError: If the file cannot be opened, or a timestamp cannot
            be decoded. A missing frame is never silently replaced by its neighbour: the
            description would then be of a picture the host did not ask about.
        """

    def describe(self, frames: Sequence[Frame], schema: Mapping[str, Any]) -> Mapping[str, Any]:
        """Describe one shot from its frames, constrained to ``schema``.

        The schema is passed in rather than compiled in because it IS the contract with
        the engine: a backend that answered a schema of its own choosing would produce
        rows the ledger cannot read.

        :returns: The model's JSON object, unnormalised — the policy layer owns
            vocabulary and bounds.
        :raises DescribeFailedError: If the model produced no parseable object.
        """
