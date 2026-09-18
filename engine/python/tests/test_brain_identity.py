"""Face recognition is opt-in per project, and deletable in one action (P15, MD-7).

Recognising the same person across shots is biometric processing. ``plan/background-removal-ai``
12 P15 requires it to be off until the editor turns it on for THIS project, computed locally,
and removable in one action. These tests pin the store and the three routes the desktop uses.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from framepilot_engine.brain.ledger_models import (
    AssetDigest,
    Confident,
    EntityRef,
    LabelledFacts,
    ShotRecord,
)
from framepilot_engine.brain.models import EntityRow
from framepilot_engine.brain.store import BrainStore, open_brain
from framepilot_engine.config import Settings
from framepilot_engine.service import create_app

ASSET = "a1"
HASH = "sha-v1"
MODEL = "framepilot/siglip2-base-patch16-224-onnx"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[BrainStore]:
    with BrainStore.open(tmp_path / "brain.sqlite") as s:
        s.upsert_asset(ASSET, path="media/clip.mp4", content_sha256=HASH)
        yield s


def _seed_identities(store: BrainStore) -> None:
    """Two people and a place, named on two shots and in the asset's digest."""
    store.upsert_entities(
        [
            EntityRow(
                id="person_01", kind="person", centroid=[1.0, 0.0], dim=2, model=MODEL, shot_count=2
            ),
            EntityRow(
                id="person_02", kind="person", centroid=[0.0, 1.0], dim=2, model=MODEL, shot_count=1
            ),
            EntityRow(
                id="setting_01",
                kind="setting",
                centroid=[0.5, 0.5],
                dim=2,
                model=MODEL,
                shot_count=2,
            ),
        ],
        model=MODEL,
    )
    refs = [
        [
            EntityRef(id="person_01", kind="person", p=1.0),
            EntityRef(id="setting_01", kind="setting", p=1.0),
        ],
        [
            EntityRef(id="person_01", kind="person", p=1.0),
            EntityRef(id="person_02", kind="person", p=1.0),
        ],
    ]
    for index, entities in enumerate(refs):
        geometry = {
            "asset_id": ASSET,
            "content_hash": HASH,
            "shot_index": index,
            "t0": float(index),
            "t1": index + 1.0,
            "keyframe_t": index + 0.5,
        }
        store.upsert_shots(ASSET, HASH, "measured", [ShotRecord(**geometry)])
        store.upsert_shots(
            ASSET,
            HASH,
            "labelled",
            [
                ShotRecord(
                    **geometry,
                    labelled=LabelledFacts(
                        tier1_version=1,
                        model=MODEL,
                        shot_size=Confident(value="MS", p=0.8),
                        faces=len([ref for ref in entities if ref.kind == "person"]),
                        entities=entities,
                    ),
                )
            ],
        )
    store.upsert_asset_digest(
        AssetDigest(
            asset_id=ASSET,
            content_hash=HASH,
            duration_s=2.0,
            shot_count=2,
            median_shot_s=1.0,
            people=["person_01", "person_02"],
        )
    )


class TestConsent:
    def test_is_off_until_a_person_turns_it_on(self, store: BrainStore) -> None:
        assert store.face_recognition_consent() is False
        store.set_face_recognition_consent(True, actor="editor")
        assert store.face_recognition_consent() is True
        store.set_face_recognition_consent(False, actor="editor")
        assert store.face_recognition_consent() is False

    def test_is_recorded_as_a_human_decision_with_a_changelog(self, store: BrainStore) -> None:
        store.set_face_recognition_consent(True, actor="editor")
        (change,) = store.changelog("project", "project")
        assert change.field == "face_recognition_consent"
        assert change.new_value is True
        assert change.source.value == "human"


class TestDeletion:
    def test_removes_every_identity_in_one_call_and_keeps_what_is_not_one(
        self, store: BrainStore
    ) -> None:
        _seed_identities(store)
        store.set_face_recognition_consent(True, actor="editor")

        removed = store.delete_identity_data(actor="editor")

        assert (removed.people, removed.shots, removed.digests) == (2, 2, 1)
        assert store.list_entities(kind="person") == []
        # A place is not a person: it stays, on the entity table and on the shot.
        assert [row.id for row in store.list_entities()] == ["setting_01"]
        first, second = store.list_shots([ASSET])
        assert first.labelled is not None and second.labelled is not None
        assert [ref.id for ref in first.labelled.entities] == ["setting_01"]
        assert second.labelled.entities == []
        # The face COUNT says nothing about who: it survives, as does every other fact.
        assert second.labelled.faces == 2
        assert first.labelled.shot_size is not None and first.labelled.shot_size.value == "MS"
        (digest,) = store.get_asset_digests([ASSET])
        assert digest.people == []

    def test_withdraws_consent_with_the_data(self, store: BrainStore) -> None:
        store.set_face_recognition_consent(True, actor="editor")
        store.delete_identity_data(actor="editor")
        assert store.face_recognition_consent() is False

    def test_is_a_safe_no_op_on_a_project_that_knows_nobody(self, store: BrainStore) -> None:
        removed = store.delete_identity_data(actor="editor")
        assert (removed.people, removed.shots, removed.digests) == (0, 0, 0)


class TestRoutes:
    @pytest.fixture
    def client(self, tmp_path: Path) -> TestClient:
        return TestClient(create_app(Settings(projects_root=tmp_path)))

    def test_reports_off_and_nobody_for_a_fresh_project(self, client: TestClient) -> None:
        body = client.get("/brain/identity", params={"projectId": "p1"}).json()
        assert body == {
            "available": True,
            "reason": None,
            "consent": False,
            "people": 0,
            "deletedPeople": None,
            "deletedShots": None,
        }

    def test_opt_in_then_delete_in_one_action(self, client: TestClient, tmp_path: Path) -> None:
        on = client.post(
            "/brain/identity/consent", json={"projectId": "p1", "consent": True}
        ).json()
        assert on["consent"] is True
        with open_brain(tmp_path, "p1") as s:
            s.upsert_asset(ASSET, path="media/clip.mp4", content_sha256=HASH)
            _seed_identities(s)
        assert client.get("/brain/identity", params={"projectId": "p1"}).json()["people"] == 2

        deleted = client.post("/brain/identity/delete", json={"projectId": "p1"}).json()

        assert deleted["deletedPeople"] == 2
        assert deleted["deletedShots"] == 2
        assert deleted["people"] == 0
        assert deleted["consent"] is False

    def test_consent_is_per_project(self, client: TestClient) -> None:
        client.post("/brain/identity/consent", json={"projectId": "p1", "consent": True})
        assert client.get("/brain/identity", params={"projectId": "p2"}).json()["consent"] is False

    def test_refuses_a_consent_call_that_does_not_say_which(self, client: TestClient) -> None:
        assert client.post("/brain/identity/consent", json={"projectId": "p1"}).status_code == 422
        assert (
            client.post(
                "/brain/identity/consent", json={"projectId": "p1", "consent": True, "who": "x"}
            ).status_code
            == 422
        )

    def test_is_honestly_unavailable_without_a_sandbox_root(self) -> None:
        client = TestClient(create_app(Settings(projects_root=None)))
        body = client.get("/brain/identity", params={"projectId": "p1"}).json()
        assert body["available"] is False
        assert body["consent"] is False
        assert "FRAMEPILOT_PROJECTS_ROOT" in body["reason"]
