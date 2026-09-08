"""The local tier-1 arm: shot embeddings and labels from an installed Capability Pack.

WHY THIS EXISTS AT ALL (ADR 0175): tier 1 shipped only as a hosted, key-gated arm, so a
default install had no labels — no shot size, no subject, no duplicates, no people. The
local pack removes the key from the price of perception. It is preferred over the hosted
NVIDIA arm whenever it is installed, for three reasons that are all about correctness
rather than cost: it needs no key, no frame leaves the machine, and its vectors live in a
space the same pack can embed a text query into, so ``search_visual`` can actually search
what was indexed.

The two spaces never mix. Every row this arm writes carries :data:`LOCAL_MODEL_ID`, and
``visual_vectors`` is keyed by model, so a project indexed by one arm is never searched
with the other's query vector. That rule already existed for NVIDIA; this arm obeys it
rather than being exempted from it.

Everything here is a thin, typed translation over
:mod:`framepilot_engine.brain.pack_worker`: build a bounded request, run it, decode the
packed vectors, and refuse anything that does not answer the question that was asked.
"""

from __future__ import annotations

import base64
import logging
import struct
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final

from framepilot_engine.analysis.prompt_bank import PROMPT_BANK_VERSION
from framepilot_engine.brain.ledger_models import Confident
from framepilot_engine.brain.pack_worker import (
    Launcher,
    PackHandle,
    PackWorkerError,
    default_launcher,
    run_pack_request,
)

_log = logging.getLogger(__name__)

__all__ = [
    "CAPABILITY_EMBED",
    "CAPABILITY_TEXT",
    "LOCAL_MODEL_ID",
    "LOCAL_PACK_ID",
    "MAX_SHOTS_PER_REQUEST",
    "LocalVisualEmbedClient",
    "ShotLabelling",
    "unpack_fp16",
]

LOCAL_PACK_ID: Final = "framepilot.visual-embed"
CAPABILITY_EMBED: Final = "visual.embed"
CAPABILITY_TEXT: Final = "visual.text"

#: The local vector space's id, stored on every ``visual_spans``/``visual_vectors`` row.
#: Deliberately NOT the same shape as the NVIDIA model id: a glance at a row must say
#: which arm produced it.
LOCAL_MODEL_ID: Final = "framepilot/siglip2-base-patch16-224-onnx"

#: Matches ``CAPABILITY_PACK_WORKER_MAX_SHOTS``. Requests are chunked to it.
MAX_SHOTS_PER_REQUEST: Final = 64

#: The ledger fields a pack may fill. A group outside this set is a protocol violation,
#: not something to store under a name nothing reads.
LABEL_GROUPS: Final = ("shotSize", "subjectKind", "setting", "screenContent")


def unpack_fp16(packed: str) -> list[float]:
    """Decode a base64 fp16 vector from a worker result.

    :raises PackWorkerError: If the payload is not base64 or not whole halves. Treated as
        a protocol violation rather than a value error: a vector that cannot be decoded
        came from a worker that is not speaking the contract.
    """
    try:
        raw = base64.b64decode(packed, validate=True)
    except (ValueError, TypeError) as error:
        raise PackWorkerError("pack returned a vector that is not base64.") from error
    if not raw or len(raw) % 2 != 0:
        raise PackWorkerError("pack returned a vector that is not whole fp16 components.")
    return list(struct.unpack(f"<{len(raw) // 2}e", raw))


@dataclass(frozen=True, slots=True)
class ShotLabelling:
    """One shot's tier-1 product, in the ledger's own vocabulary."""

    shot_index: int
    vector: list[float]
    labels: dict[str, Confident]
    faces: int
    face_vectors: list[list[float]]


class LocalVisualEmbedClient:
    """Runs the ``framepilot.visual-embed`` pack for one project's slices.

    One process per request (the protocol's own rule), so this object is a builder and a
    decoder rather than a connection. ``dim`` is captured from the first successful
    response and never hardcoded — the same discipline the NVIDIA client follows, and for
    the same reason: a model swap must not silently mix two spaces.
    """

    def __init__(self, handle: PackHandle, *, launch: Launcher = default_launcher) -> None:
        self._handle = handle
        self._launch = launch
        self._dim: int | None = None
        self._face_dim: int | None = None

    @property
    def model_id(self) -> str:
        return LOCAL_MODEL_ID

    @property
    def pack_id(self) -> str:
        return self._handle.pack_id

    @property
    def dim(self) -> int | None:
        return self._dim

    @property
    def face_dim(self) -> int | None:
        return self._face_dim

    def embed_query(self, text: str, *, request_id: str = "query") -> list[float]:
        """Embed one text query into the pack's shared image/text space.

        :raises PackWorkerError: On any worker failure. There is no fallback to the hosted
            arm here: a query embedded in NVIDIA's space cannot search local vectors, and
            answering with the wrong space would return confidently irrelevant footage.
        """
        [vector] = self.embed_queries([text], request_id=request_id)
        return vector

    def embed_queries(
        self, texts: Sequence[str], *, request_id: str = "query"
    ) -> list[list[float]]:
        """Embed up to :data:`MAX_SHOTS_PER_REQUEST` queries in one process."""
        if not texts:
            return []
        result = run_pack_request(
            self._handle,
            {
                "type": "request",
                "requestId": request_id,
                "projectRevision": 0,
                "capability": CAPABILITY_TEXT,
                "parameters": {"texts": list(texts)},
            },
            launch=self._launch,
        )
        vectors = [unpack_fp16(packed) for packed in self._vectors(result, "vectors")]
        self._capture_dim(int(result.get("dim", 0)), vectors)
        if len(vectors) != len(texts):
            raise PackWorkerError("pack returned the wrong number of query vectors.")
        return vectors

    def embed_shots(
        self,
        *,
        asset_id: str,
        media_path: str,
        shots: Sequence[tuple[int, float]],
        duration_seconds: float,
        fps: float,
        project_revision: int = 0,
    ) -> list[ShotLabelling]:
        """Embed and label a whole asset's shots, in bounded batches.

        The media handle spans the asset, and the worker decodes exactly one keyframe per
        shot — which is why the frame-count bound that applies to a frame-by-frame pack
        does not apply here.

        :param shots: ``(shot_index, keyframe_seconds)`` pairs. Keyframes must fall inside
            the asset; a keyframe outside the handle is refused by the worker rather than
            clamped, so a bad time fails loudly instead of labelling the wrong picture.
        :returns: One :class:`ShotLabelling` per input shot, in ``shot_index`` order.
        :raises PackWorkerError: On any worker failure or short answer.
        """
        if not shots:
            return []
        if duration_seconds <= 0.0 or fps <= 0.0:
            raise PackWorkerError(
                f"asset {asset_id} has no usable duration/fps for a media handle.",
                code="invalid_request",
            )
        out: list[ShotLabelling] = []
        for start in range(0, len(shots), MAX_SHOTS_PER_REQUEST):
            batch = list(shots[start : start + MAX_SHOTS_PER_REQUEST])
            result = run_pack_request(
                self._handle,
                {
                    "type": "request",
                    "requestId": f"embed:{asset_id}:{start}",
                    "projectRevision": project_revision,
                    "capability": CAPABILITY_EMBED,
                    "media": self._media(asset_id, media_path, duration_seconds, fps),
                    "parameters": {
                        "promptBankVersion": PROMPT_BANK_VERSION,
                        "shots": [
                            {"shotIndex": index, "keyframeT": keyframe} for index, keyframe in batch
                        ],
                    },
                },
                launch=self._launch,
            )
            decoded = self._decode(result, expected={index for index, _ in batch})
            out.extend(decoded)
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

    @staticmethod
    def _vectors(result: dict[str, Any], key: str) -> list[str]:
        raw = result.get(key)
        if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
            raise PackWorkerError(f"pack result is missing a usable '{key}' list.")
        return [str(item) for item in raw]

    def _capture_dim(self, declared: int, vectors: Sequence[Sequence[float]]) -> None:
        """Capture the space's dimension once, and refuse anything that disagrees later.

        Both the declared ``dim`` and the decoded length are checked, because a pack that
        declared one and packed another would otherwise write rows that read back as a
        different space than they claim to be.
        """
        for vector in vectors:
            if declared and len(vector) != declared:
                raise PackWorkerError(
                    f"pack declared dim {declared} but packed a {len(vector)}-d vector."
                )
        if not declared:
            raise PackWorkerError("pack result declared no embedding dimension.")
        if self._dim is None:
            self._dim = declared
            _log.info(
                "ACT local visual embed dim captured: model=%s dim=%d",
                LOCAL_MODEL_ID,
                declared,
            )
        elif self._dim != declared:
            raise PackWorkerError(
                f"pack changed its embedding dimension from {self._dim} to {declared}."
            )

    def _decode(self, result: dict[str, Any], *, expected: set[int]) -> list[ShotLabelling]:
        if int(result.get("promptBankVersion", -1)) != PROMPT_BANK_VERSION:
            raise PackWorkerError(
                f"pack answered against prompt bank v{result.get('promptBankVersion')}, "
                f"not v{PROMPT_BANK_VERSION}."
            )
        raw_shots = result.get("shots")
        if not isinstance(raw_shots, list) or not raw_shots:
            raise PackWorkerError("pack result carried no shots.")
        face_dim = result.get("faceDim")
        if isinstance(face_dim, int) and face_dim > 0:
            self._face_dim = face_dim
        out: list[ShotLabelling] = []
        vectors: list[list[float]] = []
        for entry in raw_shots:
            if not isinstance(entry, dict):
                raise PackWorkerError("pack returned a shot that is not an object.")
            index = entry.get("shotIndex")
            if not isinstance(index, int) or index not in expected:
                raise PackWorkerError(f"pack returned an unrequested shot {index!r}.")
            vector = unpack_fp16(str(entry.get("vector", "")))
            vectors.append(vector)
            out.append(
                ShotLabelling(
                    shot_index=index,
                    vector=vector,
                    labels=_labels(entry.get("labels")),
                    faces=int(entry.get("faces", 0)),
                    face_vectors=[
                        unpack_fp16(str(packed)) for packed in (entry.get("faceVectors") or [])
                    ],
                )
            )
        self._capture_dim(int(result.get("dim", 0)), vectors)
        returned = {shot.shot_index for shot in out}
        if returned != expected:
            # A short answer would be written as coverage for shots nobody looked at.
            raise PackWorkerError(
                f"pack answered {len(returned)} of {len(expected)} requested shots."
            )
        for shot in out:
            if shot.face_vectors and len(shot.face_vectors) != shot.faces:
                raise PackWorkerError("pack returned a face count its vectors disagree with.")
        return out


def _labels(raw: Any) -> dict[str, Confident]:
    """Translate the wire's label object into the ledger's ``Confident`` values.

    An absent group stays absent. There is no default: ``LabelledFacts`` stores ``None``
    for "this was not scored", and inventing a low-confidence value here would be counted
    as coverage by the digest.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise PackWorkerError("pack returned labels that are not an object.")
    out: dict[str, Confident] = {}
    for group, value in raw.items():
        if group not in LABEL_GROUPS:
            raise PackWorkerError(f"pack returned '{group}', which is not a ledger label group.")
        if not isinstance(value, dict) or "value" not in value or "p" not in value:
            raise PackWorkerError(f"pack returned a malformed label for '{group}'.")
        out[group] = Confident(value=str(value["value"]), p=float(value["p"]))
    return out
