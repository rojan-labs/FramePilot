"""Byte-for-byte mirror of the engine's zero-shot prompt bank.

The canonical module is
``engine/python/framepilot_engine/analysis/prompt_bank.py``. It is duplicated here for
the same reason ``protocol.py`` duplicates the TypeScript worker contract: a Capability
Pack is a separate signed artifact with no import path into the engine, and a pack that
reached into ``framepilot_engine`` would couple its ABI to the frozen sidecar (ADR 0114).

Everything below the docstring is identical to the engine's copy, and
``engine/python/tests/test_prompt_bank.py`` fails if the two ever disagree — on the
version, the labels, the phrasing or the digest.

The worker OWNS these phrases at run time: a request carries only
``promptBankVersion``, and a version this module does not speak is refused as
``invalid_request`` rather than answered against sentences nobody chose.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

__all__ = [
    "PROMPT_BANK",
    "PROMPT_BANK_VERSION",
    "PROMPT_GROUPS",
    "PROMPT_TEMPLATE",
    "PromptGroup",
    "all_prompts",
    "bank_digest",
    "best_label",
    "group_named",
    "prompt_index",
    "softmax",
]

#: Bumped when any phrase, label or group below changes. Participates in
#: ``TIER1_VERSION``; see this module's docstring.
PROMPT_BANK_VERSION: Final = 1

#: Every phrase is phrased as a photograph, because the image tower was trained on
#: photograph captions and a bare noun ("office") sits nowhere near a picture of one.
PROMPT_TEMPLATE: Final = "a photo of {}"


@dataclass(frozen=True, slots=True)
class PromptGroup:
    """One closed label set and the sentences that stand for its labels.

    ``name`` is the ledger field the group fills (the ``LabelledFacts`` alias, so the two
    cannot drift by casing). ``labels`` and ``descriptors`` are parallel and equal length;
    a softmax runs over the group's own scores only, so "this is a close-up" and "this is
    a kitchen" never compete for the same probability mass.
    """

    name: str
    labels: tuple[str, ...]
    descriptors: tuple[str, ...]

    def __post_init__(self) -> None:
        if len(self.labels) != len(self.descriptors):
            raise ValueError(f"prompt group {self.name} has unpaired labels and descriptors")
        if len(set(self.labels)) != len(self.labels):
            raise ValueError(f"prompt group {self.name} repeats a label")

    @property
    def prompts(self) -> tuple[str, ...]:
        """The group's phrases, in label order."""
        return tuple(PROMPT_TEMPLATE.format(d) for d in self.descriptors)


_SHOT_SIZE = PromptGroup(
    name="shotSize",
    labels=("EWS", "WS", "MWS", "MS", "MCU", "CU", "ECU"),
    descriptors=(
        "an extreme wide shot with a tiny figure in a vast landscape",
        "a wide shot showing a person's whole body and their surroundings",
        "a medium wide shot of a person framed from the knees up",
        "a medium shot of a person framed from the waist up",
        "a medium close-up of a person framed from the chest up",
        "a close-up of a person's face filling the frame",
        "an extreme close-up of an eye or a mouth filling the frame",
    ),
)

_SUBJECT_KIND = PromptGroup(
    name="subjectKind",
    labels=(
        "person",
        "people",
        "object",
        "place",
        "screen",
        "text",
        "animal",
        "food",
        "vehicle",
        "none",
    ),
    descriptors=(
        "a single person",
        "a group of people together",
        "a single object on its own",
        "an empty place with nobody in it",
        "a computer or phone screen",
        "a page of written text",
        "an animal",
        "a plate of food",
        "a vehicle",
        "an abstract texture with no clear subject",
    ),
)

_SETTING = PromptGroup(
    name="setting",
    labels=(
        "room",
        "office",
        "kitchen",
        "bedroom",
        "living-room",
        "bathroom",
        "restaurant",
        "classroom",
        "shop",
        "gym",
        "studio",
        "stage",
        "car-interior",
        "street",
        "park",
        "forest",
        "beach",
        "mountains",
        "field",
        "aerial",
    ),
    descriptors=(
        "a plain indoor room",
        "an office with desks and computers",
        "a kitchen",
        "a bedroom",
        "a living room with a sofa",
        "a bathroom",
        "a restaurant or cafe",
        "a classroom or lecture hall",
        "a shop or store interior",
        "a gym",
        "a studio with a plain backdrop",
        "a stage or concert venue",
        "the inside of a car",
        "a city street",
        "a park or garden",
        "a forest",
        "a beach or coastline",
        "mountains",
        "an open field in the countryside",
        "an aerial view from high above the ground",
    ),
)

_SCREEN_CONTENT = PromptGroup(
    name="screenContent",
    labels=(
        "talking-head",
        "b-roll",
        "screen-recording",
        "slides",
        "title-card",
        "graphic",
    ),
    descriptors=(
        "a person talking directly to the camera",
        "a candid scene filmed with nobody addressing the camera",
        "a screen recording of a computer application",
        "a presentation slide",
        "a title card with large text on a plain background",
        "a graphic illustration or chart",
    ),
)

#: Declaration order IS the wire order (see :func:`all_prompts`).
PROMPT_GROUPS: Final[tuple[PromptGroup, ...]] = (
    _SHOT_SIZE,
    _SUBJECT_KIND,
    _SETTING,
    _SCREEN_CONTENT,
)

PROMPT_BANK: Final[dict[str, PromptGroup]] = {group.name: group for group in PROMPT_GROUPS}


def group_named(name: str) -> PromptGroup:
    """One group by its ledger field name.

    :raises KeyError: If ``name`` is not a group of this bank. Deliberately not a
        ``None`` return: every caller here is code, not user input, and a silently
        missing group would drop a whole label column.
    """
    return PROMPT_BANK[name]


def all_prompts() -> tuple[str, ...]:
    """Every phrase, in a stable total order (group order, then label order).

    The index into this tuple is the text-vector cache key in the pack store. It is
    therefore append-*unsafe*: any change to the sequence must bump
    :data:`PROMPT_BANK_VERSION`, which is what :func:`bank_digest` exists to police.
    """
    return tuple(prompt for group in PROMPT_GROUPS for prompt in group.prompts)


def prompt_index(group_name: str, label: str) -> int:
    """Position of one group's label inside :func:`all_prompts`.

    :raises KeyError: If the group is unknown.
    :raises ValueError: If the group has no such label.
    """
    offset = 0
    for group in PROMPT_GROUPS:
        if group.name == group_name:
            return offset + group.labels.index(label)
        offset += len(group.labels)
    raise KeyError(group_name)


def bank_digest() -> str:
    """sha256 over the whole bank, phrase by phrase.

    A version number only invalidates what somebody remembered to bump. The digest is
    what a test compares, so an edited phrase under an unchanged version fails loudly
    instead of relabelling a library with a version that says nothing changed.
    """
    hasher = hashlib.sha256()
    hasher.update(f"{PROMPT_BANK_VERSION}\n".encode())
    for group in PROMPT_GROUPS:
        for label, prompt in zip(group.labels, group.prompts, strict=True):
            hasher.update(f"{group.name}\t{label}\t{prompt}\n".encode())
    return hasher.hexdigest()


def softmax(scores: Sequence[float], *, temperature: float = 1.0) -> tuple[float, ...]:
    """Numerically stable softmax over ONE group's similarity scores.

    Shifted by the maximum before exponentiating: cosine similarities are small, but the
    temperatures a contrastive model is calibrated at are not, and ``exp(100)`` overflows.

    :param scores: Similarities, one per label of a single group.
    :param temperature: Divisor applied before exponentiating; SigLIP-style logits arrive
        pre-scaled, so the default is a no-op.
    :returns: Probabilities summing to 1. An empty input returns empty rather than
        raising — a group can legitimately be absent from a partial response.
    :raises ValueError: If ``temperature`` is not positive.
    """
    if temperature <= 0.0:
        raise ValueError("softmax temperature must be positive")
    if not scores:
        return ()
    scaled = [score / temperature for score in scores]
    peak = max(scaled)
    exponentials = [math.exp(value - peak) for value in scaled]
    total = sum(exponentials)
    if total <= 0.0:  # pragma: no cover - unreachable while exp() is positive
        raise ValueError("softmax denominator collapsed to zero")
    return tuple(value / total for value in exponentials)


def best_label(group_name: str, scores: Sequence[float]) -> tuple[str, float]:
    """The winning label of one group and its probability.

    Ties break on label order, so the same scores always produce the same label — two
    runs over the same footage must not disagree because a dict iterated differently.

    :raises KeyError: If the group is unknown.
    :raises ValueError: If ``scores`` is not one score per label of the group.
    """
    group = group_named(group_name)
    if len(scores) != len(group.labels):
        raise ValueError(
            f"group {group_name} has {len(group.labels)} labels but {len(scores)} scores"
        )
    probabilities = softmax(scores)
    best = max(range(len(group.labels)), key=lambda i: (probabilities[i], -i))
    return group.labels[best], probabilities[best]
