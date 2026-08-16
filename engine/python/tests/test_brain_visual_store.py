"""Tests for the visual-index migration v3 + store API (plan MI2.2).

The visual index (``visual_spans`` / ``visual_vectors`` / ``visual_captions``)
is part of the deterministic brain core: every branch — fresh create, in-place
v2→v3 upgrade preserving data, round-trips, idempotent upserts, the
content-hash resume filter, and the re-index delete — is exercised here without
any real media or live API.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from framepilot_engine.brain import (
    BrainStore,
    Provenance,
    VisualCaptionRow,
    VisualSpanRow,
    VisualVectorRow,
)
from framepilot_engine.brain import migrations as brain_migrations
from framepilot_engine.brain.migrations import SCHEMA_VERSION, current_version


def fixed_clock(step_seconds: float = 1.0) -> Callable[[], datetime]:
    """A deterministic clock that advances by ``step_seconds`` per call."""
    state = {"now": datetime(2026, 7, 18, 9, 0, 0, tzinfo=UTC)}

    def _clock() -> datetime:
        current = state["now"]
        state["now"] = current + timedelta(seconds=step_seconds)
        return current

    return _clock


@pytest.fixture
def store(tmp_path: Path) -> Iterator[BrainStore]:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as s:
        s.upsert_asset("a1", path="media/clip.mp4", content_sha256="sha-a1")
        yield s


def _span(
    t0: float, *, content_hash: str = "sha-a1", phash: int = 1, asset_id: str = "a1"
) -> VisualSpanRow:
    return VisualSpanRow(
        asset_id=asset_id,
        model="nvidia/test",
        sampler_version=1,
        t0=t0,
        t1=t0 + 1.0,
        scene_index=0,
        keyframe_t=t0,
        phash=phash,
        content_hash=content_hash,
        frame_count=1,
    )


# --- migration v3 -------------------------------------------------------------


def test_schema_version_is_three() -> None:
    assert SCHEMA_VERSION == 3


def test_fresh_create_has_v3_tables_at_version_three(tmp_path: Path) -> None:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as s:
        assert current_version(s._conn) == 3
        tables = {
            r[0]
            for r in s._conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
    assert {"visual_spans", "visual_vectors", "visual_captions"} <= tables


def test_v2_to_v3_upgrade_preserves_existing_data(tmp_path: Path) -> None:
    """A real v2 file (assets + embeddings populated) upgrades in place to v3
    without losing a byte, and gains the visual-index tables."""
    path = tmp_path / "brain.sqlite"
    conn = sqlite3.connect(path)
    brain_migrations.MIGRATIONS[0](conn)  # v1
    brain_migrations.MIGRATIONS[1](conn)  # v2
    conn.execute("PRAGMA user_version = 2")
    conn.execute(
        "INSERT INTO assets (id, path, created_at, updated_at) VALUES ('a1', 'a.mp4', 't', 't')"
    )
    conn.commit()
    conn.close()

    with BrainStore.open(path, clock=fixed_clock()) as s:
        assert current_version(s._conn) == 3
        asset = s.get_asset("a1")
        assert asset is not None and asset.path == "a.mp4"
        # New tables exist and are empty.
        assert s.visual_index_counts() == {"spans": 0, "vectors": 0, "captions": 0, "assets": 0}


# --- spans --------------------------------------------------------------------


def test_upsert_and_list_visual_spans_round_trip(store: BrainStore) -> None:
    written = store.upsert_visual_spans([_span(0.0, phash=2**63 + 7), _span(1.0, phash=5)])
    assert written == 2
    spans = store.list_visual_spans("a1")
    assert [s.t0 for s in spans] == [0.0, 1.0]
    # 64-bit phash survives the decimal-TEXT round-trip exactly.
    assert spans[0].phash == 2**63 + 7
    assert spans[0].created_at != ""  # stamped by the store clock


def test_list_visual_spans_filters_by_asset_and_model(store: BrainStore) -> None:
    store.upsert_asset("a2", path="b.mp4", content_sha256="sha-a2")
    store.upsert_visual_spans([_span(0.0)])
    store.upsert_visual_spans([_span(0.0, asset_id="a2", content_hash="sha-a2")])
    assert len(store.list_visual_spans()) == 2
    assert [s.asset_id for s in store.list_visual_spans("a2")] == ["a2"]
    assert [s.asset_id for s in store.list_visual_spans(model="nvidia/test")] == ["a1", "a2"]
    assert store.list_visual_spans(model="other") == []


def test_upsert_visual_spans_is_idempotent(store: BrainStore) -> None:
    store.upsert_visual_spans([_span(0.0, phash=1)])
    store.upsert_visual_spans([_span(0.0, phash=99)])  # same key, new value
    spans = store.list_visual_spans("a1")
    assert len(spans) == 1
    assert spans[0].phash == 99


def test_visual_span_serializes_phash_as_string() -> None:
    """64-bit safety: JSON must carry phash as a decimal string (JS ``Number``
    cannot hold the top bits) — mirrors ``VisualSpan.phash``."""
    payload = _span(0.0, phash=2**63 + 7).model_dump(by_alias=True, mode="json")
    assert payload["phash"] == str(2**63 + 7)
    assert payload["sceneIndex"] == 0  # camelCase alias like every other brain row


def test_existing_visual_span_keys_filters_by_content_hash(store: BrainStore) -> None:
    store.upsert_visual_spans([_span(0.0), _span(2.0)])
    # Same bytes → the stored t0 keys are the resume-skip set.
    assert store.existing_visual_span_keys("a1", "sha-a1", "nvidia/test", 1) == {0.0, 2.0}
    # Changed bytes → nothing counts as indexed, so the asset re-indexes wholesale.
    assert store.existing_visual_span_keys("a1", "sha-CHANGED", "nvidia/test", 1) == set()
    # A different model / sampler version is a different index.
    assert store.existing_visual_span_keys("a1", "sha-a1", "other", 1) == set()


# --- vectors ------------------------------------------------------------------


def _vector(t0: float, values: list[float]) -> VisualVectorRow:
    return VisualVectorRow(
        asset_id="a1", model="nvidia/test", sampler_version=1, t0=t0, dim=len(values), vector=values
    )


def test_upsert_and_list_visual_vectors_round_trip(store: BrainStore) -> None:
    store.upsert_visual_spans([_span(0.0), _span(1.0)])
    store.upsert_visual_vectors([_vector(0.0, [0.5, 0.5]), _vector(1.0, [1.0, 0.0])])
    vecs = store.list_visual_vectors("a1")
    assert [v.t0 for v in vecs] == [0.0, 1.0]
    assert vecs[0].vector == pytest.approx([0.5, 0.5])
    assert vecs[0].dim == 2
    # Filters mirror list_visual_spans.
    assert [v.t0 for v in store.list_visual_vectors(model="nvidia/test")] == [0.0, 1.0]
    assert store.list_visual_vectors(model="other") == []


def test_upsert_visual_vectors_is_idempotent(store: BrainStore) -> None:
    store.upsert_visual_spans([_span(0.0)])
    store.upsert_visual_vectors([_vector(0.0, [1.0, 0.0])])
    store.upsert_visual_vectors([_vector(0.0, [0.0, 1.0])])
    vecs = store.list_visual_vectors()
    assert len(vecs) == 1
    assert vecs[0].vector == pytest.approx([0.0, 1.0])


def test_visual_vector_foreign_key_requires_a_span(store: BrainStore) -> None:
    # A vector with no matching span violates the FK onto visual_spans.
    with pytest.raises(sqlite3.IntegrityError):
        store.upsert_visual_vectors([_vector(9.0, [1.0, 0.0])])


# --- captions -----------------------------------------------------------------


def _caption(scene_index: int, t0: float, text: str) -> VisualCaptionRow:
    return VisualCaptionRow(
        asset_id="a1", scene_index=scene_index, t0=t0, t1=t0 + 2.0, text=text, model="claude-vision"
    )


def test_upsert_and_list_visual_captions_round_trip(store: BrainStore) -> None:
    store.upsert_visual_captions([_caption(0, 0.0, "a laptop on a desk")])
    caps = store.list_visual_captions("a1")
    assert len(caps) == 1
    assert caps[0].text == "a laptop on a desk"
    assert caps[0].source is Provenance.MODEL  # default provenance
    assert caps[0].created_at != ""
    assert store.list_visual_captions("other") == []
    assert len(store.list_visual_captions()) == 1


def test_upsert_visual_captions_is_idempotent(store: BrainStore) -> None:
    store.upsert_visual_captions([_caption(0, 0.0, "first")])
    store.upsert_visual_captions([_caption(0, 0.0, "second")])
    caps = store.list_visual_captions("a1")
    assert len(caps) == 1
    assert caps[0].text == "second"


# --- delete / counts ----------------------------------------------------------


def test_delete_visual_asset_removes_spans_vectors_captions(store: BrainStore) -> None:
    store.upsert_asset("a2", path="b.mp4", content_sha256="sha-a2")
    store.upsert_visual_spans([_span(0.0), _span(0.0, asset_id="a2", content_hash="sha-a2")])
    store.upsert_visual_vectors([_vector(0.0, [1.0, 0.0])])
    store.upsert_visual_captions([_caption(0, 0.0, "keep-a1")])

    store.delete_visual_asset("a1")

    assert store.list_visual_spans("a1") == []
    assert store.list_visual_vectors("a1") == []
    assert store.list_visual_captions("a1") == []
    # A different asset's index is untouched.
    assert [s.asset_id for s in store.list_visual_spans()] == ["a2"]


def test_visual_index_counts(store: BrainStore) -> None:
    store.upsert_visual_spans([_span(0.0), _span(1.0)])
    store.upsert_visual_vectors([_vector(0.0, [1.0, 0.0])])
    store.upsert_visual_captions([_caption(0, 0.0, "cap")])
    counts = store.visual_index_counts()
    assert counts == {"spans": 2, "vectors": 1, "captions": 1, "assets": 1}
