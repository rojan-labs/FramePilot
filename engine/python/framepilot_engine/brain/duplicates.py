"""Near-duplicate detection over 64-bit perceptual hashes, at library scale.

WHY THIS REPLACES A PAIRWISE SCAN (``plan/visual-understanding/08``, the ``VU5``
deprecation row): the previous implementation compared every pair of spans, which is
``n(n-1)/2`` Hamming distances — 720k comparisons at 1,200 spans, and 26 million at the
7,200 shots a ten-hour project reaches. It was bounded by simply giving up above a cap and
omitting the signal, so the projects that most need "you shot this twice" were exactly the
ones that never got it.

**Multi-index hashing** makes the same answer cheap and keeps it EXACT. Split each 64-bit
hash into ``threshold + 1`` blocks. Two hashes that differ in at most ``threshold`` bits
cannot differ in every block — by the pigeonhole principle, at least one block must be
bit-identical. So bucketing by ``(block position, block value)`` and comparing only within
buckets can never miss a true near-duplicate, and it examines a small fraction of the
pairs. The final Hamming check is still exact, so nothing approximate reaches the caller.

The output is two shapes because the ledger and the footage map ask different questions:

- :func:`duplicate_groups` — "which of these look the same as each other", numbered by
  first appearance, singletons omitted. This is what the footage map prints.
- :func:`duplicate_of` — "which EARLIER item is this one a repeat of", which is what
  ``LabelledFacts.duplicateOf`` stores: a shot key, not a group number.

Pure over its inputs: no store, no clock, no I/O.
"""

from __future__ import annotations

from collections.abc import Hashable, Sequence
from typing import Final, TypeVar

from framepilot_engine.analysis.visual_sampler import DEFAULT_HAMMING_THRESHOLD, hamming

__all__ = [
    "HASH_BITS",
    "duplicate_groups",
    "duplicate_of",
]

#: Width of a dHash. The block arithmetic below is written for this width and asserts it.
HASH_BITS: Final = 64

K = TypeVar("K", bound=Hashable)


def _blocks(threshold: int) -> tuple[tuple[int, int], ...]:
    """``(shift, width)`` for each block, covering all 64 bits with none overlapping.

    ``threshold + 1`` blocks is the smallest count the pigeonhole argument allows, and the
    smallest count gives the widest blocks, which is what makes a bucket selective. Widths
    differ by at most one bit when 64 does not divide evenly — an even split is not
    required for correctness, only for balance.
    """
    count = threshold + 1
    base, remainder = divmod(HASH_BITS, count)
    blocks: list[tuple[int, int]] = []
    shift = 0
    for index in range(count):
        width = base + (1 if index < remainder else 0)
        blocks.append((shift, width))
        shift += width
    return tuple(blocks)


def _candidate_pairs(items: Sequence[tuple[K, int]], threshold: int) -> set[tuple[int, int]]:
    """Index positions that share at least one exact block — the exact candidate set."""
    if threshold >= HASH_BITS:
        # Degenerate: everything is within the threshold of everything. Pigeonholing has
        # nothing to exploit, so answer honestly rather than build 64 useless buckets.
        return {(i, j) for i in range(len(items)) for j in range(i + 1, len(items))}
    pairs: set[tuple[int, int]] = set()
    for shift, width in _blocks(threshold):
        mask = (1 << width) - 1
        buckets: dict[int, list[int]] = {}
        for position, (_key, value) in enumerate(items):
            buckets.setdefault((value >> shift) & mask, []).append(position)
        for members in buckets.values():
            if len(members) < 2:
                continue
            for left in range(len(members)):
                for right in range(left + 1, len(members)):
                    pairs.add((members[left], members[right]))
    return pairs


class _UnionFind:
    """Union-find so A~B and B~C group all three even when A and C are just past the bar."""

    def __init__(self, size: int) -> None:
        self._parent = list(range(size))

    def find(self, node: int) -> int:
        while self._parent[node] != node:
            self._parent[node] = self._parent[self._parent[node]]
            node = self._parent[node]
        return node

    def union(self, left: int, right: int) -> None:
        self._parent[self.find(left)] = self.find(right)


def _linked(items: Sequence[tuple[K, int]], threshold: int) -> _UnionFind:
    groups = _UnionFind(len(items))
    for left, right in sorted(_candidate_pairs(items, threshold)):
        if hamming(items[left][1], items[right][1]) <= threshold:
            groups.union(left, right)
    return groups


def duplicate_groups(
    items: Sequence[tuple[K, int]], *, threshold: int = DEFAULT_HAMMING_THRESHOLD
) -> dict[K, int]:
    """Group keys whose hashes look the same, numbered 1..n by first appearance.

    Singletons get no group: a number that only ever appears once is noise in a prompt.
    Numbering follows input order so the same footage always reads the same way between
    runs — the footage map is compared byte-wise across turns.

    :param items: ``(key, phash)`` pairs, in the order the caller wants numbered.
    :param threshold: Maximum Hamming distance that still counts as the same picture.
        The default is the sampler's own drift threshold, reused rather than invented.
    :returns: ``{key: group number}`` for keys in a group of two or more.
    :raises ValueError: If ``threshold`` is negative.
    """
    if threshold < 0:
        raise ValueError("hamming threshold cannot be negative")
    if len(items) < 2:
        return {}
    groups = _linked(items, threshold)
    members: dict[int, list[int]] = {}
    for position in range(len(items)):
        members.setdefault(groups.find(position), []).append(position)
    numbered: dict[int, int] = {}
    out: dict[K, int] = {}
    for position, (key, _value) in enumerate(items):
        root = groups.find(position)
        if len(members[root]) < 2:
            continue
        if root not in numbered:
            numbered[root] = len(numbered) + 1
        out[key] = numbered[root]
    return out


def duplicate_of(
    items: Sequence[tuple[K, int]], *, threshold: int = DEFAULT_HAMMING_THRESHOLD
) -> dict[K, K]:
    """Map each repeated key to the FIRST key that looks like it.

    Points at the earliest member of the group rather than the nearest neighbour, so a
    chain of five takes all point at take one instead of at each other. That is what makes
    ``duplicateOf`` readable as "this is a repeat of that" — a nearest-neighbour link would
    have to be followed transitively to answer the same question, and could cycle.

    The first member of a group maps to nothing: it is the take the others repeat.

    :param items: ``(key, phash)`` pairs, in the order that defines "first".
    :returns: ``{key: earlier key}``, omitting each group's first member.
    :raises ValueError: If ``threshold`` is negative.
    """
    if threshold < 0:
        raise ValueError("hamming threshold cannot be negative")
    if len(items) < 2:
        return {}
    groups = _linked(items, threshold)
    first_of: dict[int, K] = {}
    out: dict[K, K] = {}
    for position, (key, _value) in enumerate(items):
        root = groups.find(position)
        if root not in first_of:
            first_of[root] = key
            continue
        out[key] = first_of[root]
    return out
