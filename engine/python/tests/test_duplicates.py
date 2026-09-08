"""Near-duplicate detection: the multi-index bucket that replaced the pairwise scan.

The property that matters is EXACTNESS, not speed. Multi-index hashing is only worth
having if it finds exactly what an all-pairs scan would find; a faster answer that misses
a repeated take is worse than the slow one it replaced. So the central test here compares
the bucketed result against brute force on random hashes, at the real threshold.

The second thing at stake is stability: group numbers and duplicate links are printed into
the model's context and stored in a digest that is compared byte-wise between runs.
"""

from __future__ import annotations

import random

import pytest

from framepilot_engine.analysis.visual_sampler import DEFAULT_HAMMING_THRESHOLD, hamming
from framepilot_engine.brain.duplicates import HASH_BITS, duplicate_groups, duplicate_of


def flip(value: int, bits: int, *, start: int = 0) -> int:
    """``value`` with ``bits`` specific bits flipped, so distances are exact, not random."""
    for offset in range(bits):
        value ^= 1 << ((start + offset * 7) % HASH_BITS)
    return value


def brute_force(items: list[tuple[str, int]], threshold: int) -> set[frozenset[str]]:
    """All-pairs grouping — the thing the bucket must agree with."""
    parent = {key: key for key, _ in items}

    def find(key: str) -> str:
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    for i, (left_key, left) in enumerate(items):
        for right_key, right in items[i + 1 :]:
            if hamming(left, right) <= threshold:
                parent[find(left_key)] = find(right_key)
    groups: dict[str, set[str]] = {}
    for key, _ in items:
        groups.setdefault(find(key), set()).add(key)
    return {frozenset(members) for members in groups.values() if len(members) > 1}


class TestExactness:
    def test_it_finds_what_an_all_pairs_scan_finds(self) -> None:
        rng = random.Random(20260907)
        items: list[tuple[str, int]] = []
        for index in range(120):
            base = rng.getrandbits(HASH_BITS)
            items.append((f"h{index}", base))
            # Deliberately seed near-duplicates at every distance around the threshold,
            # so the comparison exercises the boundary rather than only random pairs.
            if index % 4 == 0:
                items.append((f"h{index}n", flip(base, rng.randint(0, 9), start=index)))
        groups = duplicate_groups(items)
        clustered: dict[int, set[str]] = {}
        for key, number in groups.items():
            clustered.setdefault(number, set()).add(key)
        assert {frozenset(members) for members in clustered.values()} == brute_force(
            items, DEFAULT_HAMMING_THRESHOLD
        )

    @pytest.mark.parametrize("distance", [0, 1, 5, 6])
    def test_pairs_at_or_under_the_threshold_group(self, distance: int) -> None:
        base = 0xDEADBEEFCAFEF00D
        groups = duplicate_groups([("a", base), ("b", flip(base, distance))])
        assert groups == {"a": 1, "b": 1}

    @pytest.mark.parametrize("distance", [7, 12, 30])
    def test_pairs_past_the_threshold_do_not_group(self, distance: int) -> None:
        base = 0xDEADBEEFCAFEF00D
        assert duplicate_groups([("a", base), ("b", flip(base, distance))]) == {}

    def test_transitive_chains_group_even_across_the_bar(self) -> None:
        # A~B and B~C, with A and C nine bits apart: union-find puts all three together,
        # which is what "these are all the same take" means.
        base = 0
        middle = flip(base, 5)
        far = flip(middle, 4, start=40)
        assert hamming(base, far) > DEFAULT_HAMMING_THRESHOLD
        assert duplicate_groups([("a", base), ("b", middle), ("c", far)]) == {
            "a": 1,
            "b": 1,
            "c": 1,
        }


class TestStability:
    def test_singletons_get_no_group(self) -> None:
        assert duplicate_groups([("a", 0x0000_0000_0000_00FF), ("b", 0xFFFF_FFFF_FFFF_FF00)]) == {}

    def test_groups_are_numbered_by_first_appearance(self) -> None:
        base_a, base_b = 0, 0xFFFF_FFFF_0000_0000
        groups = duplicate_groups([("a1", base_a), ("b1", base_b), ("a2", base_a), ("b2", base_b)])
        assert groups == {"a1": 1, "a2": 1, "b1": 2, "b2": 2}

    def test_an_empty_or_single_input_is_answered_not_raised(self) -> None:
        assert duplicate_groups([]) == {}
        assert duplicate_groups([("only", 7)]) == {}

    def test_a_negative_threshold_is_refused(self) -> None:
        with pytest.raises(ValueError, match="cannot be negative"):
            duplicate_groups([("a", 1)], threshold=-1)


class TestDuplicateOf:
    def test_every_repeat_points_at_the_first_take_not_its_neighbour(self) -> None:
        # A chain of takes must all point at take one, or "duplicateOf" would have to be
        # followed transitively to be read — and could cycle.
        base = 0
        items = [("t1", base), ("t2", flip(base, 3)), ("t3", flip(base, 5, start=20))]
        assert duplicate_of(items) == {"t2": "t1", "t3": "t1"}

    def test_the_first_take_points_at_nothing(self) -> None:
        assert "t1" not in duplicate_of([("t1", 0), ("t2", 0)])

    def test_unrelated_shots_have_no_link(self) -> None:
        assert duplicate_of([("a", 0), ("b", (1 << 64) - 1)]) == {}

    def test_a_threshold_of_the_whole_hash_width_still_answers(self) -> None:
        # The degenerate case the pigeonhole split cannot exploit; it must not silently
        # produce nothing.
        assert duplicate_of([("a", 0), ("b", (1 << 64) - 1)], threshold=HASH_BITS) == {"b": "a"}
