"""The local tier-2 arm: structured shot descriptions from an installed Capability Pack.

WHY THIS EXISTS AT ALL (ADR 0175 / plan VU6): tier 2 shipped only as a hosted, key-gated
arm that rode on the hosted EMBED pass — so a default install, and even a machine with the
local tier-1 pack, described nothing at all. The ``framepilot.visual-describe`` pack
removes the key from the price of a description: no key, no frame leaving the machine, and
the same structured object the hosted captioner produces.

Everything here is a thin, typed translation over
:mod:`framepilot_engine.brain.pack_worker`: build a bounded request, run it, funnel every
shot through :func:`~framepilot_engine.brain.described.parse_described`, and refuse
anything that does not answer the question that was asked.

The engine never discovers, installs or locates the pack — it is handed a host-verified
handle in the index request, the same channel the NVIDIA keys and the visual-embed handle
already arrive on.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final

from framepilot_engine.brain.described import DescribedParseError, parse_described
from framepilot_engine.brain.ledger_models import TIER2_VERSION, DescribedFacts
from framepilot_engine.brain.pack_worker import (
    Launcher,
    PackHandle,
    PackWorkerError,
    default_launcher,
    run_pack_request,
)

_log = logging.getLogger(__name__)

__all__ = [
    "CAPABILITY_DESCRIBE",
    "LOCAL_DESCRIBE_PACK_ID",
    "MAX_SHOTS_PER_REQUEST",
    "LocalVisualDescribeClient",
    "ShotDescription",
]

LOCAL_DESCRIBE_PACK_ID: Final = "framepilot.visual-describe"
CAPABILITY_DESCRIBE: Final = "visual.describe"

#: Matches ``CAPABILITY_PACK_WORKER_MAX_DESCRIBE_SHOTS``. Requests are chunked to it.
#: Much smaller than tier 1's 64 because a VLM call is seconds, not milliseconds — tier 2
#: is the slow tier and the batch size is where that is admitted.
MAX_SHOTS_PER_REQUEST: Final = 16


@dataclass(frozen=True, slots=True)
class ShotDescription:
    """One shot's tier-2 product, already in the ledger's own shape."""

    shot_index: int
    facts: DescribedFacts


class LocalVisualDescribeClient:
    """Runs the ``framepilot.visual-describe`` pack for one project's slices.

    One process per request (the protocol's own rule), so this object is a builder and a
    decoder rather than a connection. The producing ``model`` id is taken from the pack's
    own answer and never assumed here: a pack that fell back to its low-memory weights
    must be able to say so, and a row must always name the model that produced it.
    """

    def __init__(self, handle: PackHandle, *, launch: Launcher = default_launcher) -> None:
        self._handle = handle
        self._launch = launch
        self._model_id: str | None = None

    @property
    def pack_id(self) -> str:
        return self._handle.pack_id

    @property
    def model_id(self) -> str | None:
        """The model the pack last reported, or ``None`` before its first answer."""
        return self._model_id

    def describe_shots(
        self,
        *,
        asset_id: str,
        media_path: str,
        shots: Sequence[tuple[int, float, float]],
        duration_seconds: float,
        fps: float,
        project_revision: int = 0,
    ) -> list[ShotDescription]:
        """Describe a whole asset's shots, in bounded batches.

        :param shots: ``(shot_index, t0, t1)`` spans in ASSET seconds. A span outside the
            asset is refused by the worker rather than clamped, so a bad boundary fails
            loudly instead of describing the wrong picture.
        :returns: One :class:`ShotDescription` per input shot, in ``shot_index`` order.
        :raises PackWorkerError: On any worker failure, a short answer, or an answer the
            structured schema cannot be read out of.
        """
        if not shots:
            return []
        if duration_seconds <= 0.0 or fps <= 0.0:
            raise PackWorkerError(
                f"asset {asset_id} has no usable duration/fps for a media handle.",
                code="invalid_request",
            )
        out: list[ShotDescription] = []
        for start in range(0, len(shots), MAX_SHOTS_PER_REQUEST):
            batch = list(shots[start : start + MAX_SHOTS_PER_REQUEST])
            result = run_pack_request(
                self._handle,
                {
                    "type": "request",
                    "requestId": f"describe:{asset_id}:{start}",
                    "projectRevision": project_revision,
                    "capability": CAPABILITY_DESCRIBE,
                    "media": self._media(asset_id, media_path, duration_seconds, fps),
                    "parameters": {
                        "tier2Version": TIER2_VERSION,
                        "shots": [
                            {"shotIndex": index, "t0": t0, "t1": t1} for index, t0, t1 in batch
                        ],
                    },
                },
                launch=self._launch,
            )
            out.extend(self._decode(result, expected={index for index, _, _ in batch}))
        return sorted(out, key=lambda item: item.shot_index)

    # -- internals ------------------------------------------------------------------

    @staticmethod
    def _media(
        asset_id: str, media_path: str, duration_seconds: float, fps: float
    ) -> dict[str, Any]:
        return {
            "handleId": f"media-{asset_id}"[:256],
            "assetId": asset_id,
            "absolutePath": media_path,
            "sourceStartSeconds": 0.0,
            "sourceEndSeconds": duration_seconds,
            "fps": fps,
            "firstFrame": 0,
            "lastFrameExclusive": max(1, int(duration_seconds * fps)),
        }

    def _decode(self, result: dict[str, Any], *, expected: set[int]) -> list[ShotDescription]:
        if int(result.get("tier2Version", -1)) != TIER2_VERSION:
            raise PackWorkerError(
                f"pack answered against tier2 v{result.get('tier2Version')}, not v{TIER2_VERSION}."
            )
        model = result.get("model")
        if not isinstance(model, str) or not model:
            raise PackWorkerError("pack result named no producing model.")
        if self._model_id is None:
            self._model_id = model
            _log.info(
                "ACT local visual describe model captured: pack=%s model=%s",
                self._handle.pack_id,
                model,
            )
        raw_shots = result.get("shots")
        if not isinstance(raw_shots, list) or not raw_shots:
            raise PackWorkerError("pack result carried no shots.")
        out: list[ShotDescription] = []
        for entry in raw_shots:
            if not isinstance(entry, dict):
                raise PackWorkerError("pack returned a shot that is not an object.")
            index = entry.get("shotIndex")
            if not isinstance(index, int) or index not in expected:
                raise PackWorkerError(f"pack returned an unrequested shot {index!r}.")
            try:
                facts = parse_described(entry, model=model)
            except DescribedParseError as error:
                # A pack that cannot produce the schema it declared is not speaking the
                # contract, so this is a protocol failure rather than a soft "no caption".
                raise PackWorkerError(f"shot {index}: {error}") from error
            out.append(ShotDescription(shot_index=index, facts=facts))
        # A SHORT answer is legal; an answer naming shots nobody asked about is not.
        #
        # The per-entry check above already rejects an unrequested index, so what is left
        # here is a subset — the pack describing some of the batch and declining the rest,
        # which is what a featureless frame produces. Those shots get no `described` row at
        # all, which is "absent", not coverage; the reasoning this replaces ("a short answer
        # would be written as coverage for shots nobody looked at") had it backwards, and
        # rejecting the batch meant one blank frame denied tier 2 to up to fifteen
        # describable shots beside it. An EMPTY answer is still refused, by the check above.
        return out
