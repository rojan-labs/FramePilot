"""Identity clusters: turning loose face vectors into stable ``person_NN`` ids.

WHY (ADR 0175 / ``plan/visual-understanding`` VU5.3): "the host is in 86 shots" is the
fact that makes a footage digest worth reading, and it cannot come from a per-shot face
count. It needs the same person recognised across shots, with an id that does not change
between runs — because the id is printed into the model's context and stored in the
per-asset digest, which is compared byte-wise across turns.

The clustering rules, and why each is what it is:

- **Agglomerative, single-link, one fixed cosine threshold.** Not k-means: nobody knows k,
  and a wrong k silently merges two people or splits one. Single-link over a threshold
  answers the only question being asked — "is this the same face?" — with one number that
  can be calibrated against labelled fixtures and printed.
- **Ids by FIRST APPEARANCE, never by cluster size.** ``person_01`` is whoever the ledger
  saw first, in ``(asset_id, shot_index)`` order. Numbering by size would renumber the
  whole cast the moment one more shot was labelled, and every stored digest would go stale
  without a single fact having changed.
- **Existing ids are preserved on re-cluster.** A cluster that contains any face from an
  existing entity keeps that entity's id (the lowest-numbered one, when a re-cluster merges
  two). New clusters take the next free number. The human-authored ``label``
  ("person_03" → "Marcus") lives on the entity row, so renumbering would rename a person.
- **The centroid is the mean of the cluster's vectors, re-normalised.** It is stored so an
  incremental pass can match new faces against it without re-reading every member.

Pure over its inputs: no store, no clock, no I/O. The store writes what this returns.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

__all__ = [
    "ENTITY_ID_PATTERN",
    "IDENTITY_COSINE_THRESHOLD",
    "SEED_SHOT_INDEX",
    "FaceObservation",
    "IdentityCluster",
    "cluster_faces",
    "entity_number",
    "next_entity_id",
    "seed_from_centroid",
]

#: Cosine similarity at or above which two face vectors are the same person.
#:
#: 0.363 is SFace's own published verification threshold (the value OpenCV Zoo documents
#: for ``FaceRecognizerSF`` cosine matching), reused rather than invented. It is a
#: STARTING calibration for this codebase: no face has been embedded by this pack yet, so
#: nothing here claims a measured precision or recall. VU5.4's labelled fixtures are what
#: confirm or move it.
IDENTITY_COSINE_THRESHOLD: Final = 0.363

#: ``person_03``. Zero-padded to two digits so ids sort lexicographically for a cast of
#: under a hundred, which is every project that has ever reached this code.
ENTITY_ID_PATTERN: Final = re.compile(r"^(?P<kind>person|setting)_(?P<number>\d{2,})$")

#: Shot index of a SEED observation — an existing cluster's stored centroid, fed back in
#: so an incremental pass can attach new faces to people it has already met. Negative so
#: it can never collide with a real shot, and so seeds sort before every real observation
#: and keep their first-appearance priority when ids are handed out.
SEED_SHOT_INDEX: Final = -1


@dataclass(frozen=True, slots=True)
class FaceObservation:
    """One face vector, and where it was seen.

    ``asset_id``/``shot_index`` are not decoration: they are the total order that makes
    "first appearance" a fact rather than whatever order the caller happened to build its
    list in.
    """

    asset_id: str
    shot_index: int
    vector: tuple[float, ...]
    #: Entity id this face already belongs to, when re-clustering an existing project.
    existing_id: str | None = None

    @property
    def order(self) -> tuple[str, int]:
        return (self.asset_id, self.shot_index)


@dataclass(frozen=True, slots=True)
class IdentityCluster:
    """One person, as the ledger will store them."""

    id: str
    centroid: tuple[float, ...]
    #: ``(asset_id, shot_index)`` of every face in the cluster, in first-appearance order.
    members: tuple[tuple[str, int], ...]

    @property
    def shot_count(self) -> int:
        """How many distinct NEW shots this person appears in.

        Distinct shots, not faces: two detections of the same person in one frame is one
        appearance, and counting them twice would make a crowd scene look like a lead.
        Seeds are excluded from ``members`` entirely, so on an incremental pass this counts
        only what this pass added — the caller adds the stored count.
        """
        return len(set(self.members))


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right):
        raise ValueError(f"cannot compare a {len(left)}-d vector with a {len(right)}-d one")
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)


def entity_number(entity_id: str) -> int | None:
    """The numeric part of an entity id, or ``None`` if it is not one of ours.

    Human-renamed entities keep their generated id; the label is a separate column. So an
    unparseable id here means a foreign id, not a renamed person.
    """
    match = ENTITY_ID_PATTERN.match(entity_id)
    return int(match.group("number")) if match else None


def next_entity_id(kind: str, taken: Sequence[str]) -> str:
    """The lowest unused id of ``kind``, formatted ``person_07``."""
    used = {number for number in (entity_number(item) for item in taken) if number is not None}
    number = 1
    while number in used:
        number += 1
    return f"{kind}_{number:02d}"


def seed_from_centroid(entity_id: str, centroid: Sequence[float]) -> FaceObservation:
    """Feed an existing cluster's stored centroid back in as a seed observation.

    This is what makes re-clustering incremental without re-reading every face ever seen:
    the centroid stands in for the whole cluster, so a new face that matches it joins that
    person and keeps their id — and their human-authored label. The stored centroid is an
    approximation of its members, so the merged centroid this produces is a running mean
    rather than an exact one; that is the price of not keeping every vector, and it is
    stated rather than hidden.
    """
    return FaceObservation(
        asset_id="",
        shot_index=SEED_SHOT_INDEX,
        vector=tuple(centroid),
        existing_id=entity_id,
    )


def _centroid(vectors: Sequence[Sequence[float]]) -> tuple[float, ...]:
    """Mean of the members, re-normalised to unit length.

    Re-normalised because every downstream comparison is a cosine: an un-normalised
    centroid still gives the right cosine, but it stores a magnitude that means nothing and
    invites somebody to compare it as a distance later.
    """
    dimension = len(vectors[0])
    summed = [0.0] * dimension
    for vector in vectors:
        if len(vector) != dimension:
            raise ValueError("cannot average vectors of different dimensions")
        for index, value in enumerate(vector):
            summed[index] += value
    norm = math.sqrt(sum(value * value for value in summed))
    if norm == 0.0:
        return tuple(summed)
    return tuple(value / norm for value in summed)


def cluster_faces(
    observations: Sequence[FaceObservation],
    *,
    kind: str = "person",
    threshold: float = IDENTITY_COSINE_THRESHOLD,
) -> list[IdentityCluster]:
    """Agglomerate face vectors into stable identity clusters.

    Single-link agglomeration: two faces within ``threshold`` join the same cluster, and
    joining is transitive, so a person seen at three angles links through the middle one
    even when the two extremes do not match directly. That is the correct failure
    direction here — a missed link splits one person into two entities, which reads as a
    smaller cast, while a false link merges two people, which puts words in somebody's
    mouth.

    :param observations: Every face of the project, in any order. Ordering is imposed
        internally by ``(asset_id, shot_index)`` so the result does not depend on it.
    :param kind: Entity kind for generated ids (``person`` or ``setting``).
    :param threshold: Cosine at or above which two faces are the same identity.
    :returns: Clusters in first-appearance order. Ids reuse existing ones where a cluster
        contains a previously-identified face.
    :raises ValueError: If two observations carry different vector dimensions, or the
        threshold is outside ``[-1, 1]``.
    """
    if not -1.0 <= threshold <= 1.0:
        raise ValueError("cosine threshold must lie in [-1, 1]")
    if not observations:
        return []
    ordered = sorted(observations, key=lambda item: (item.order, item.existing_id or ""))
    parent = list(range(len(ordered)))

    def find(node: int) -> int:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for left in range(len(ordered)):
        for right in range(left + 1, len(ordered)):
            if find(left) == find(right):
                continue
            if _cosine(ordered[left].vector, ordered[right].vector) >= threshold:
                parent[find(left)] = find(right)

    members: dict[int, list[int]] = {}
    for position in range(len(ordered)):
        members.setdefault(find(position), []).append(position)

    # Roots in first-appearance order: the cluster whose earliest member comes first is
    # numbered first.
    roots = sorted(members, key=lambda root: members[root][0])
    assigned: list[str] = [
        observation.existing_id for observation in ordered if observation.existing_id is not None
    ]
    clusters: list[IdentityCluster] = []
    claimed: set[str] = set()
    for root in roots:
        positions = members[root]
        # An existing id wins, and the lowest-numbered one wins a merge: when a re-cluster
        # joins person_02 and person_05, the survivors' shots are person_02's, which keeps
        # the older id (and its human label) rather than inventing a third.
        seen: set[str] = {
            identifier
            for position in positions
            if (identifier := ordered[position].existing_id) is not None
        }
        existing = sorted(
            seen,
            key=lambda item: (entity_number(item) is None, entity_number(item) or 0, item),
        )
        identifier = next(
            (item for item in existing if item not in claimed),
            next_entity_id(kind, [*assigned, *claimed]),
        )
        claimed.add(identifier)
        clusters.append(
            IdentityCluster(
                id=identifier,
                centroid=_centroid([ordered[position].vector for position in positions]),
                members=tuple(
                    ordered[position].order
                    for position in positions
                    if ordered[position].shot_index != SEED_SHOT_INDEX
                ),
            )
        )
    return clusters
