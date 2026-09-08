"""Identity clustering and its persistence: stable ids, preserved names, one space.

Three things break the moment this is wrong, and none of them fail loudly:

1. **An id that renumbers.** ``person_03`` is printed into the model's context and stored
   in the per-asset digest, which is compared byte-wise across runs. Numbering by cluster
   size, or by iteration order, would make every digest stale whenever one more shot was
   labelled — with no fact having changed.
2. **A human's name lost to a re-cluster.** ``label`` is the only human-authored value in
   the ledger. A model's re-cluster must never overwrite it.
3. **Two identity spaces mixed.** A centroid built by one pack compared against a face
   embedded by another produces confident nonsense.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from framepilot_engine.brain.entities import (
    IDENTITY_COSINE_THRESHOLD,
    FaceObservation,
    cluster_faces,
    entity_number,
    next_entity_id,
    seed_from_centroid,
)
from framepilot_engine.brain.models import EntityRow
from framepilot_engine.brain.store import BrainStore

ALICE = (1.0, 0.0, 0.0)
ALICE_TILTED = (0.95, 0.31, 0.0)
BOB = (0.0, 1.0, 0.0)
CAROL = (0.0, 0.0, 1.0)
LOCAL = "framepilot/siglip2-base-patch16-224-onnx"


def fixed_clock() -> Callable[[], datetime]:
    state = {"now": datetime(2026, 9, 7, 12, 0, 0, tzinfo=UTC)}

    def _clock() -> datetime:
        current = state["now"]
        state["now"] = current + timedelta(seconds=1)
        return current

    return _clock


@pytest.fixture
def store(tmp_path: Path) -> Iterator[BrainStore]:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as s:
        yield s


def face(
    asset: str, shot: int, vector: tuple[float, ...], existing: str | None = None
) -> FaceObservation:
    return FaceObservation(asset_id=asset, shot_index=shot, vector=vector, existing_id=existing)


class TestClustering:
    def test_the_same_face_across_shots_is_one_person(self) -> None:
        clusters = cluster_faces(
            [face("a", 0, ALICE), face("a", 4, ALICE_TILTED), face("b", 2, ALICE)]
        )
        assert len(clusters) == 1
        assert clusters[0].id == "person_01"
        assert clusters[0].shot_count == 3

    def test_different_faces_are_different_people(self) -> None:
        clusters = cluster_faces([face("a", 0, ALICE), face("a", 1, BOB), face("a", 2, CAROL)])
        assert [cluster.id for cluster in clusters] == [
            "person_01",
            "person_02",
            "person_03",
        ]

    def test_ids_follow_first_appearance_not_cluster_size(self) -> None:
        # Bob appears once, first. Alice appears three times, later. Bob is person_01.
        clusters = cluster_faces(
            [
                face("a", 0, BOB),
                face("a", 1, ALICE),
                face("a", 2, ALICE),
                face("b", 0, ALICE),
            ]
        )
        by_id = {cluster.id: cluster for cluster in clusters}
        assert by_id["person_01"].shot_count == 1
        assert by_id["person_02"].shot_count == 3

    def test_input_order_does_not_change_the_answer(self) -> None:
        observations = [face("b", 1, ALICE), face("a", 0, BOB), face("a", 3, ALICE)]
        forward = cluster_faces(observations)
        backward = cluster_faces(list(reversed(observations)))
        assert [(c.id, sorted(c.members)) for c in forward] == [
            (c.id, sorted(c.members)) for c in backward
        ]

    def test_a_single_link_chain_holds_a_person_together(self) -> None:
        # Two profiles that do not match each other both match the front-on shot.
        left = (0.643, 0.766, 0.0)
        right = (0.643, -0.766, 0.0)
        assert len(cluster_faces([face("a", 0, left), face("a", 1, right)])) == 2
        assert (
            len(cluster_faces([face("a", 0, left), face("a", 1, ALICE), face("a", 2, right)])) == 1
        )

    def test_the_centroid_is_unit_length(self) -> None:
        [cluster] = cluster_faces([face("a", 0, ALICE), face("a", 1, ALICE_TILTED)])
        assert sum(value * value for value in cluster.centroid) == pytest.approx(1.0)

    def test_no_faces_is_no_clusters(self) -> None:
        assert cluster_faces([]) == []

    def test_a_threshold_outside_cosine_range_is_refused(self) -> None:
        with pytest.raises(ValueError, match=r"\[-1, 1\]"):
            cluster_faces([face("a", 0, ALICE)], threshold=1.5)

    def test_the_threshold_is_the_documented_sface_one(self) -> None:
        assert pytest.approx(0.363) == IDENTITY_COSINE_THRESHOLD


class TestIncrementalIdentity:
    def test_a_seeded_centroid_keeps_its_id_for_a_new_matching_face(self) -> None:
        clusters = cluster_faces(
            [seed_from_centroid("person_07", ALICE), face("z", 3, ALICE_TILTED)]
        )
        assert [cluster.id for cluster in clusters] == ["person_07"]
        # The seed is not a shot: it stands in for shots already counted elsewhere.
        assert clusters[0].members == (("z", 3),)

    def test_a_new_face_that_matches_nobody_takes_the_next_free_number(self) -> None:
        clusters = cluster_faces([seed_from_centroid("person_01", ALICE), face("z", 0, BOB)])
        assert sorted(cluster.id for cluster in clusters) == ["person_01", "person_02"]

    def test_a_face_that_bridges_two_stored_people_keeps_the_older_id(self) -> None:
        # Merging must not invent a third id: the survivor keeps the lower number, and
        # therefore the human label attached to it.
        bridge = (0.92, 0.38, 0.0)
        clusters = cluster_faces(
            [
                seed_from_centroid("person_02", ALICE),
                seed_from_centroid("person_05", (1.0, 1.0, 0.0)),
                face("z", 0, bridge),
            ]
        )
        assert [cluster.id for cluster in clusters] == ["person_02"]

    def test_entity_number_and_next_id_round_trip(self) -> None:
        assert entity_number("person_12") == 12
        assert entity_number("Marcus") is None
        assert next_entity_id("person", ["person_01", "person_03"]) == "person_02"


class TestEntityStore:
    def _row(self, identifier: str, *, count: int = 2, label: str | None = None) -> EntityRow:
        return EntityRow(
            id=identifier,
            kind="person",
            label=label,
            centroid=[1.0, 0.0],
            dim=2,
            model=LOCAL,
            shot_count=count,
        )

    def test_round_trips_a_cluster(self, store: BrainStore) -> None:
        store.upsert_entities([self._row("person_01")], model=LOCAL)
        [stored] = store.list_entities(model=LOCAL)
        assert stored.id == "person_01"
        assert stored.centroid == pytest.approx([1.0, 0.0])
        assert stored.shot_count == 2

    def test_a_recluster_never_overwrites_a_human_name(self, store: BrainStore) -> None:
        store.upsert_entities([self._row("person_01")], model=LOCAL)
        store.set_entity_label("person_01", "Marcus")
        store.upsert_entities([self._row("person_01", count=9)], model=LOCAL)
        [stored] = store.list_entities(model=LOCAL)
        assert stored.label == "Marcus"
        assert stored.shot_count == 9

    def test_a_recluster_drops_people_who_no_longer_have_faces(self, store: BrainStore) -> None:
        store.upsert_entities([self._row("person_01"), self._row("person_02")], model=LOCAL)
        store.upsert_entities([self._row("person_01")], model=LOCAL)
        assert [row.id for row in store.list_entities(model=LOCAL)] == ["person_01"]

    def test_another_model_s_clusters_are_untouched(self, store: BrainStore) -> None:
        other = "nvidia/llama-nemotron-embed-vl-1b-v2"
        store.upsert_entities([self._row("person_01")], model=other)
        store.upsert_entities([], model=LOCAL)
        assert [row.id for row in store.list_entities(model=other)] == ["person_01"]

    def test_setting_a_label_on_an_unknown_entity_reports_it(self, store: BrainStore) -> None:
        assert store.set_entity_label("person_99", "Nobody") is False
