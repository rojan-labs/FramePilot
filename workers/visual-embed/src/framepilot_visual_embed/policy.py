"""What this pack will and will not claim.

Pure over its inputs: similarities in, labels out. The backend produces vectors; every
decision about what those vectors *mean* is made here, where it can be tested without a
model file.

The honesty rules, and why each exists:

- **A group is scored or it is absent.** There is no "unknown" label and no zero-probability
  placeholder. The ledger stores ``None`` for a group nobody scored, and the digest counts
  coverage from that; a fabricated low-confidence label would be counted as coverage.
- **``p`` is a softmax over ONE group.** "Close-up" and "kitchen" are answers to different
  questions and must never share probability mass, or every label's confidence would drop
  as the bank grew.
- **The worker does not gate on ``p``.** ``LABEL_MIN_P`` lives in the engine's ledger
  renderer, where the printing rule is. A worker that dropped low-confidence labels would
  make "we did not look" and "we looked and were unsure" indistinguishable downstream.
- **No face is invented.** ``faces`` is the count the detector returned, and an empty frame
  reports zero rather than a shot with a nominal person in it.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterator, Sequence
from typing import Final

from .backend import MediaUnreadableError, Vector, VisualEmbedBackend
from .prompt_bank import PROMPT_GROUPS, best_label
from .protocol import ConfidentLabel, EmbedRequest, ProtocolError, ShotEmbedding

#: Divisor applied to cosine similarity before the softmax. 0.01 is the contrastive
#: convention (a learned logit scale near 100), and it is the number the accuracy targets
#: in ``plan/visual-understanding/05`` must be measured at. It is a STARTING calibration,
#: not a measured one: no weight has been run through this pack yet, so nothing here
#: claims a probability is well calibrated — only that it is computed consistently.
LABEL_TEMPERATURE: Final = 0.01

#: Frames decoded and embedded per backend call. The request is already bounded to 64
#: shots; this keeps peak resident memory to a batch of decoded frames rather than all of
#: them, which is what makes a 4K asset survivable on an 8 GB machine.
EMBED_BATCH: Final = 8


class ShotUnreadableError(Exception):
    """A requested keyframe could not be decoded, so the shot has no honest answer."""


def cosine(left: Vector, right: Vector) -> float:
    """Cosine similarity of two vectors.

    Computed from magnitudes rather than assuming unit length, because a backend bug that
    returned unnormalised vectors would otherwise show up as confidently wrong labels
    instead of as an obviously wrong similarity.

    :raises ValueError: If the vectors have different lengths — two spaces being compared
        is never a rounding problem.
    """
    if len(left) != len(right):
        raise ValueError(f"cannot compare a {len(left)}-d vector with a {len(right)}-d one")
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)


def label_image(
    image_vector: Vector,
    prompt_vectors: Sequence[Vector],
    *,
    temperature: float = LABEL_TEMPERATURE,
) -> dict[str, ConfidentLabel]:
    """Zero-shot label one image against the whole prompt bank.

    ``prompt_vectors`` is in :func:`~framepilot_visual_embed.prompt_bank.all_prompts`
    order — the bank's stable total order is the contract that lets this be a flat list
    instead of a nested structure that could be assembled wrongly.

    :returns: One :class:`ConfidentLabel` per group, keyed by the ledger's field name.
    :raises ValueError: If the vector count does not match the bank.
    """
    expected = sum(len(group.labels) for group in PROMPT_GROUPS)
    if len(prompt_vectors) != expected:
        raise ValueError(
            f"prompt bank has {expected} phrases but {len(prompt_vectors)} vectors were given"
        )
    labels: dict[str, ConfidentLabel] = {}
    offset = 0
    for group in PROMPT_GROUPS:
        window = prompt_vectors[offset : offset + len(group.labels)]
        offset += len(group.labels)
        scores = [cosine(image_vector, prompt) / temperature for prompt in window]
        value, probability = best_label(group.name, scores)
        labels[group.name] = ConfidentLabel(value=value, p=probability)
    return labels


def _batched(items: Sequence[object], size: int) -> Iterator[tuple[int, int]]:
    for start in range(0, len(items), size):
        yield start, min(start + size, len(items))


def embed_shots(
    request: EmbedRequest,
    backend: VisualEmbedBackend,
    prompt_vectors: Sequence[Vector],
    *,
    should_cancel: Callable[[], bool] = lambda: False,
) -> Iterator[ShotEmbedding]:
    """Embed, label and count faces for every shot of one request, in batches.

    Yields in request order (which :func:`~framepilot_visual_embed.protocol.parse_input_line`
    already sorted by source time), so the caller can report progress as it goes.

    :raises ProtocolError: ``cancelled`` when the host cancels mid-run, or
        ``media_unreadable`` when a requested keyframe cannot be decoded. A shot that
        cannot be decoded fails the request rather than being dropped: the host asked
        about a specific shot list and a short answer would read as coverage.
    """
    shots = request.shots
    for start, end in _batched(shots, EMBED_BATCH):
        if should_cancel():
            raise ProtocolError("cancelled", "visual embedding cancelled by the host.")
        window = shots[start:end]
        try:
            frames = backend.decode_keyframes(
                request.media.absolute_path, [shot.keyframe_t for shot in window]
            )
        except MediaUnreadableError as error:
            raise ProtocolError("media_unreadable", str(error)) from error
        if len(frames) != len(window):
            raise ProtocolError(
                "media_unreadable",
                f"decoder returned {len(frames)} frames for {len(window)} keyframes.",
            )
        vectors = backend.encode_images(frames)
        if len(vectors) != len(window):
            raise ProtocolError(
                "internal_error", "the image tower returned the wrong number of vectors."
            )
        for shot, frame, vector in zip(window, frames, vectors, strict=True):
            face_vectors = list(backend.detect_and_embed_faces(frame))
            yield ShotEmbedding(
                shot_index=shot.shot_index,
                vector=vector,
                labels=label_image(vector, prompt_vectors),
                faces=len(face_vectors),
                face_vectors=face_vectors,
            )
