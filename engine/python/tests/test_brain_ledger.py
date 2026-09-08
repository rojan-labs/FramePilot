"""The shot ledger's persistence layer (ADR 0175, plan/visual-understanding VU1.3).

What is actually at stake here, and therefore what these tests are about:

1. **A tier written must not disturb the other two.** The whole three-column schema
   exists so a model swap re-runs one tier. If ``upsert_shots`` clobbered a sibling
   column, the cost model in ADR 0175 would be wrong by a factor of three and nothing
   would fail loudly.
2. **Absence must stay distinguishable from emptiness.** NULL means "this tier has not
   run". A default-shaped row would tell the agent the footage was examined.
3. **Invalidation must be exact.** A changed ``content_hash`` drops the asset's shots; a
   bumped ``tierN_version`` nulls one column and nothing else.
4. **Paging must be total.** The cursor walks ``(asset_id, shot_index)``; a skipped or
   repeated shot is a silently wrong ledger, not a crash.

No media, no ffmpeg, no network: every input here is a constructed model.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from framepilot_engine.analysis.shot_stats import ShotStats
from framepilot_engine.brain import migrations as brain_migrations
from framepilot_engine.brain.ledger_models import (
    TIER0_VERSION,
    AssetDigest,
    Confident,
    DescribedFacts,
    EntityRef,
    LabelledFacts,
    MotionClass,
    ShotRecord,
)
from framepilot_engine.brain.ledger_store import (
    LOW_SHARPNESS,
    coverage_of,
    digest_from_shots,
    shots_from_stats,
)
from framepilot_engine.brain.migrations import SCHEMA_VERSION, current_version
from framepilot_engine.brain.store import BrainError, BrainStore, shot_cursor

ASSET = "a1"
HASH = "sha-v1"


def fixed_clock(step_seconds: float = 1.0) -> Callable[[], datetime]:
    """A deterministic clock that advances by ``step_seconds`` per call."""
    state = {"now": datetime(2026, 9, 7, 12, 0, 0, tzinfo=UTC)}

    def _clock() -> datetime:
        current = state["now"]
        state["now"] = current + timedelta(seconds=step_seconds)
        return current

    return _clock


@pytest.fixture
def store(tmp_path: Path) -> Iterator[BrainStore]:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as s:
        s.upsert_asset(ASSET, path="media/clip.mp4", content_sha256=HASH)
        s.upsert_asset("a2", path="media/other.mp4", content_sha256="sha-a2")
        yield s


# --- builders -----------------------------------------------------------------------


def _stats(
    index: int,
    *,
    t0: float | None = None,
    motion_class: str = "static",
    sharpness: float = 0.8,
    black: bool = False,
    freeze: bool = False,
    luma_mean: float = 0.5,
    warmth: float = 0.1,
    split_of: bool = False,
) -> ShotStats:
    start = float(index) if t0 is None else t0
    return ShotStats(
        shot_index=index,
        t0=start,
        t1=start + 2.0,
        keyframe_t=start + 0.5,
        split_of=split_of,
        luma_mean=luma_mean,
        luma_std=0.18,
        luma_p10=0.08,
        luma_p90=0.86,
        u_mean=124.1,
        v_mean=133.8,
        sat_mean=0.31,
        warmth=warmth,
        contrast_idx=0.62,
        si=41.2,
        ti=1.5,
        motion_class=motion_class,
        cut_score=0.31,
        black=black,
        freeze=freeze,
        sharpness=sharpness,
    )


def _measured_rows(
    *stats: ShotStats, asset_id: str = ASSET, content_hash: str = HASH
) -> list[ShotRecord]:
    return shots_from_stats(
        asset_id, content_hash, stats, phashes={s.shot_index: "9f2c" for s in stats}
    )


def _labelled(
    row: ShotRecord,
    *,
    version: int = 1,
    shot_size: tuple[str, float] = ("MS", 0.81),
    entities: list[EntityRef] | None = None,
) -> ShotRecord:
    """A geometry-only copy of ``row`` carrying only tier 1 — what the pack would write."""
    return ShotRecord(
        asset_id=row.asset_id,
        content_hash=row.content_hash,
        shot_index=row.shot_index,
        t0=row.t0,
        t1=row.t1,
        keyframe_t=row.keyframe_t,
        split_of=row.split_of,
        labelled=LabelledFacts(
            tier1_version=version,
            model="siglip2-base-patch16-224",
            shot_size=Confident(value=shot_size[0], p=shot_size[1]),
            setting=Confident(value="indoor-office", p=0.72),
            faces=1,
            entities=entities or [EntityRef(id="person_03", kind="person", p=0.88)],
        ),
    )


def _described(
    row: ShotRecord, *, version: int = 1, summary: str = "A man at a desk."
) -> ShotRecord:
    return ShotRecord(
        asset_id=row.asset_id,
        content_hash=row.content_hash,
        shot_index=row.shot_index,
        t0=row.t0,
        t1=row.t1,
        keyframe_t=row.keyframe_t,
        split_of=row.split_of,
        described=DescribedFacts(tier2_version=version, model="smolvlm2-2.2b-q4", summary=summary),
    )


# --- migration v4 -------------------------------------------------------------------


def test_schema_version_is_four() -> None:
    assert SCHEMA_VERSION == 4


def test_fresh_create_has_ledger_tables_at_version_four(tmp_path: Path) -> None:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as s:
        assert current_version(s._conn) == 4
        objects = {
            r[0]
            for r in s._conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"
            )
        }
    assert {"shots", "entities", "asset_digest", "shots_by_time"} <= objects


def test_v3_to_v4_upgrade_preserves_existing_data(tmp_path: Path) -> None:
    """A real v3 file upgrades in place: the visual index survives, the ledger appears.

    Forward from a v3 file rather than from a fresh create, because the failure this
    guards is a migration that only works on an empty database — which every fresh-create
    test would pass.
    """
    path = tmp_path / "brain.sqlite"
    conn = sqlite3.connect(path)
    for step in range(3):
        brain_migrations.MIGRATIONS[step](conn)
    conn.execute("PRAGMA user_version = 3")
    conn.execute(
        "INSERT INTO assets (id, path, created_at, updated_at) VALUES ('a1', 'a.mp4', 't', 't')"
    )
    conn.execute(
        "INSERT INTO visual_spans (asset_id, model, sampler_version, t0, t1, scene_index,"
        " keyframe_t, phash, content_hash, frame_count, created_at)"
        " VALUES ('a1', 'nvidia/test', 1, 0.0, 1.0, 0, 0.5, '7', 'sha-v1', 1, 't')"
    )
    conn.commit()
    conn.close()

    with BrainStore.open(path, clock=fixed_clock()) as s:
        assert current_version(s._conn) == 4
        asset = s.get_asset("a1")
        assert asset is not None and asset.path == "a.mp4"
        assert len(s.list_visual_spans("a1")) == 1
        assert s.list_shots(["a1"]) == []
        assert s.tier_coverage(["a1"]).total == 0


def test_ledger_rows_cascade_with_their_asset(store: BrainStore) -> None:
    """Deleting the asset takes the derived ledger with it (ADR 0058 invariant 1)."""
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0)))
    store.upsert_asset_digest(
        digest_from_shots(ASSET, HASH, store.list_shots([ASSET]), duration_s=2.0)
    )
    with store._conn:
        store._conn.execute("DELETE FROM assets WHERE id = ?", (ASSET,))
    assert store.list_shots([ASSET]) == []
    assert store.get_asset_digests([ASSET]) == []


# --- upsert_shots / list_shots -------------------------------------------------------


def test_measured_round_trips_through_sqlite(store: BrainStore) -> None:
    written = store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0), _stats(1)))
    assert written == 2
    shots = store.list_shots([ASSET])
    assert [s.shot_index for s in shots] == [0, 1]
    first = shots[0]
    assert first.measured is not None
    assert first.measured.tier0_version == TIER0_VERSION
    assert first.measured.luma.p90 == 0.86
    assert first.measured.motion.motion_class is MotionClass.STATIC
    assert first.measured.phash == "9f2c"
    # A silent asset has no loudness, and that stays None rather than becoming 0 LUFS.
    assert first.measured.loudness_lufs is None
    assert first.labelled is None and first.described is None


def test_split_of_survives_the_round_trip(store: BrainStore) -> None:
    """A duration split is not an edit point, and a policy can only know that if the
    flag survives storage — SQLite has no boolean type."""
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0, split_of=True)))
    assert store.list_shots([ASSET])[0].split_of is True


def test_each_tier_is_written_without_disturbing_the_others(store: BrainStore) -> None:
    """The point of the schema: three writes, three columns, no collateral damage."""
    base = _measured_rows(_stats(0))[0]
    store.upsert_shots(ASSET, HASH, "measured", [base])
    store.upsert_shots(ASSET, HASH, "labelled", [_labelled(base)])
    store.upsert_shots(ASSET, HASH, "described", [_described(base)])

    shot = store.list_shots([ASSET])[0]
    assert shot.measured is not None and shot.measured.sharpness == 0.8
    assert shot.labelled is not None and shot.labelled.shot_size is not None
    assert shot.labelled.shot_size.value == "MS"
    assert shot.described is not None and shot.described.summary == "A man at a desk."

    # And re-running one tier still leaves the other two standing.
    store.upsert_shots(ASSET, HASH, "described", [_described(base, summary="A woman at a desk.")])
    shot = store.list_shots([ASSET])[0]
    assert shot.described is not None and shot.described.summary == "A woman at a desk."
    assert shot.measured is not None and shot.labelled is not None


def test_only_tier_zero_may_move_shot_geometry(store: BrainStore) -> None:
    """Boundaries are measured, not guessed: a tier-1 row carrying wrong times must not
    silently retime the shot for every reader of the ledger."""
    base = _measured_rows(_stats(0))[0]
    store.upsert_shots(ASSET, HASH, "measured", [base])
    drifted = _labelled(base)
    drifted = drifted.model_copy(update={"t0": 99.0, "t1": 123.0, "keyframe_t": 100.0})
    store.upsert_shots(ASSET, HASH, "labelled", [drifted])

    shot = store.list_shots([ASSET])[0]
    assert (shot.t0, shot.t1, shot.keyframe_t) == (base.t0, base.t1, base.keyframe_t)

    # Tier 0 re-measuring the same shot DOES move it — it owns the boundary.
    remeasured = _measured_rows(_stats(0, t0=5.0))[0]
    store.upsert_shots(ASSET, HASH, "measured", [remeasured])
    assert store.list_shots([ASSET])[0].t0 == 5.0


def test_upsert_shots_rejects_a_row_from_another_asset(store: BrainStore) -> None:
    stray = _measured_rows(_stats(0), asset_id="a2", content_hash="sha-a2")
    with pytest.raises(BrainError, match="does not belong to the batch key"):
        store.upsert_shots(ASSET, HASH, "measured", stray)
    assert store.list_shots([ASSET, "a2"]) == []


def test_upsert_shots_rejects_a_row_from_another_content_hash(store: BrainStore) -> None:
    with pytest.raises(BrainError, match="does not belong to the batch key"):
        store.upsert_shots(
            ASSET, HASH, "measured", _measured_rows(_stats(0), content_hash="sha-v2")
        )


def test_unknown_tier_is_an_error_not_a_silent_no_op(store: BrainStore) -> None:
    with pytest.raises(BrainError, match="unknown ledger tier"):
        store.upsert_shots(ASSET, HASH, "descibed", _measured_rows(_stats(0)))  # type: ignore[arg-type]
    with pytest.raises(BrainError, match="unknown ledger tier"):
        store.existing_shot_tier_keys(ASSET, HASH, "labeled", 1)  # type: ignore[arg-type]


def test_upsert_shots_with_no_rows_is_a_no_op(store: BrainStore) -> None:
    """An asset with no detected shots is a legitimate outcome, not a failure."""
    assert store.upsert_shots(ASSET, HASH, "measured", []) == 0
    assert store.list_shots([ASSET]) == []


def test_list_shots_without_asset_ids_returns_nothing(store: BrainStore) -> None:
    """The dangerous default would be "no filter means the whole library"."""
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0)))
    assert store.list_shots([]) == []
    assert store.list_shots([ASSET], limit=0) == []


def test_list_shots_pages_over_every_shot_exactly_once(store: BrainStore) -> None:
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(*[_stats(i) for i in range(5)]))
    store.upsert_shots(
        "a2",
        "sha-a2",
        "measured",
        _measured_rows(*[_stats(i) for i in range(3)], asset_id="a2", content_hash="sha-a2"),
    )

    seen: list[tuple[str, int]] = []
    cursor: str | None = None
    while True:
        page = store.list_shots([ASSET, "a2"], limit=3, after=cursor)
        if not page:
            break
        seen += [(s.asset_id, s.shot_index) for s in page]
        cursor = shot_cursor(page[-1])

    assert seen == [(ASSET, i) for i in range(5)] + [("a2", i) for i in range(3)]


def test_list_shots_rejects_a_malformed_cursor(store: BrainStore) -> None:
    """Cursors arrive from an HTTP query string, so a bad one is input, not a bug."""
    for bad in ("not-json", "{}", "[1, 2]", '["a1"]', '["a1", true]'):
        with pytest.raises(BrainError, match="invalid shot cursor"):
            store.list_shots([ASSET], after=bad)


# --- resume key ----------------------------------------------------------------------


def test_existing_shot_tier_keys_reports_only_current_work(store: BrainStore) -> None:
    rows = _measured_rows(_stats(0), _stats(1), _stats(2))
    store.upsert_shots(ASSET, HASH, "measured", rows)
    store.upsert_shots(ASSET, HASH, "labelled", [_labelled(rows[0])])

    assert store.existing_shot_tier_keys(ASSET, HASH, "measured", TIER0_VERSION) == {0, 1, 2}
    # Only shot 0 has been labelled; 1 and 2 are still to do.
    assert store.existing_shot_tier_keys(ASSET, HASH, "labelled", 1) == {0}
    # Nothing has been described at all.
    assert store.existing_shot_tier_keys(ASSET, HASH, "described", 1) == set()
    # A newer model version has produced nothing yet, so the whole tier is to do.
    assert store.existing_shot_tier_keys(ASSET, HASH, "labelled", 2) == set()
    # Different bytes are different footage.
    assert store.existing_shot_tier_keys(ASSET, "sha-v2", "measured", TIER0_VERSION) == set()


# --- invalidation --------------------------------------------------------------------


def test_changed_content_hash_drops_the_stale_shots_and_digest(store: BrainStore) -> None:
    store.upsert_shots(
        ASSET,
        "sha-old",
        "measured",
        _measured_rows(_stats(0), _stats(1), content_hash="sha-old"),
    )
    store.upsert_asset_digest(
        digest_from_shots(ASSET, "sha-old", store.list_shots([ASSET]), duration_s=4.0)
    )
    assert len(store.list_shots([ASSET])) == 2

    # The file was re-encoded: same asset id, different bytes.
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0), _stats(1)))
    assert store.drop_stale_shots(ASSET, HASH) == 2

    remaining = store.list_shots([ASSET])
    assert {s.content_hash for s in remaining} == {HASH}
    assert store.get_asset_digests([ASSET]) == []


def test_drop_stale_shots_keeps_everything_when_nothing_changed(store: BrainStore) -> None:
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0)))
    store.upsert_asset_digest(
        digest_from_shots(ASSET, HASH, store.list_shots([ASSET]), duration_s=2.0)
    )
    assert store.drop_stale_shots(ASSET, HASH) == 0
    assert len(store.list_shots([ASSET])) == 1
    assert len(store.get_asset_digests([ASSET])) == 1


def test_bumped_tier_version_nulls_only_that_column(store: BrainStore) -> None:
    """A model swap must cost one tier, not three — this is that promise, measured."""
    base = _measured_rows(_stats(0))[0]
    store.upsert_shots(ASSET, HASH, "measured", [base])
    store.upsert_shots(ASSET, HASH, "labelled", [_labelled(base, version=1)])
    store.upsert_shots(ASSET, HASH, "described", [_described(base)])

    assert store.clear_stale_shot_tier("labelled", 2) == 1

    shot = store.list_shots([ASSET])[0]
    assert shot.labelled is None
    assert shot.measured is not None and shot.described is not None
    assert (shot.t0, shot.t1) == (base.t0, base.t1)
    # And the tier now reports as entirely to-do at the new version.
    assert store.existing_shot_tier_keys(ASSET, HASH, "labelled", 2) == set()
    assert store.tier_coverage([ASSET]) == coverage_of([shot])


def test_clear_stale_shot_tier_keeps_current_versions_and_scopes_to_one_asset(
    store: BrainStore,
) -> None:
    base = _measured_rows(_stats(0))[0]
    store.upsert_shots(ASSET, HASH, "measured", [base])
    store.upsert_shots(ASSET, HASH, "labelled", [_labelled(base, version=2)])
    other = _measured_rows(_stats(0), asset_id="a2", content_hash="sha-a2")[0]
    store.upsert_shots("a2", "sha-a2", "measured", [other])
    store.upsert_shots("a2", "sha-a2", "labelled", [_labelled(other, version=1)])

    # Nothing is stale at version 2 for a1; a2's version-1 row is, but is out of scope.
    assert store.clear_stale_shot_tier("labelled", 2, asset_id=ASSET) == 0
    assert store.list_shots(["a2"])[0].labelled is not None

    assert store.clear_stale_shot_tier("labelled", 2, asset_id="a2") == 1
    assert store.list_shots(["a2"])[0].labelled is None
    assert store.list_shots([ASSET])[0].labelled is not None


def test_delete_shots_for_asset_removes_every_hash_and_the_digest(store: BrainStore) -> None:
    store.upsert_shots(
        ASSET, "sha-old", "measured", _measured_rows(_stats(0), content_hash="sha-old")
    )
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0)))
    store.upsert_asset_digest(
        digest_from_shots(ASSET, HASH, store.list_shots([ASSET]), duration_s=2.0)
    )
    store.upsert_shots(
        "a2", "sha-a2", "measured", _measured_rows(_stats(0), asset_id="a2", content_hash="sha-a2")
    )

    assert store.delete_shots_for_asset(ASSET) == 2
    assert store.list_shots([ASSET]) == []
    assert store.get_asset_digests([ASSET]) == []
    assert len(store.list_shots(["a2"])) == 1


# --- digests and coverage ------------------------------------------------------------


def test_asset_digest_round_trips_and_updates_in_place(store: BrainStore) -> None:
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0), _stats(1)))
    digest = digest_from_shots(
        ASSET, HASH, store.list_shots([ASSET]), duration_s=4.0, has_speech=True
    )
    store.upsert_asset_digest(digest)
    store.upsert_asset_digest(digest)  # idempotent: one row per asset, not per write

    stored = store.get_asset_digests([ASSET])
    assert len(stored) == 1
    assert stored[0] == digest
    assert stored[0].has_speech is True


def test_get_asset_digests_omits_assets_that_have_none(store: BrainStore) -> None:
    """Omitted, not defaulted: an empty digest would claim the footage was examined."""
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0)))
    store.upsert_asset_digest(
        digest_from_shots(ASSET, HASH, store.list_shots([ASSET]), duration_s=2.0)
    )
    assert [d.asset_id for d in store.get_asset_digests([ASSET, "a2"])] == [ASSET]
    assert store.get_asset_digests([]) == []


def test_tier_coverage_counts_each_column_independently(store: BrainStore) -> None:
    rows = _measured_rows(_stats(0), _stats(1), _stats(2))
    store.upsert_shots(ASSET, HASH, "measured", rows)
    store.upsert_shots(ASSET, HASH, "described", [_described(rows[0])])

    coverage = store.tier_coverage([ASSET])
    assert (coverage.measured, coverage.labelled, coverage.described, coverage.total) == (
        3,
        0,
        1,
        3,
    )
    # No assets asked about means no coverage claimed.
    assert store.tier_coverage([]).total == 0


# --- ledger_store: stats → rows ------------------------------------------------------


def test_shots_from_stats_normalises_into_ledger_units() -> None:
    rows = shots_from_stats(
        ASSET,
        HASH,
        [_stats(0), _stats(1)],
        phashes={0: "9f2c"},
        loudness_lufs={0: -18.2},
    )
    assert [r.shot_index for r in rows] == [0, 1]
    assert rows[0].measured is not None and rows[1].measured is not None
    assert rows[0].measured.chroma.u_mean == 124.1
    assert rows[0].measured.loudness_lufs == -18.2
    assert rows[0].measured.phash == "9f2c"
    # A shot whose keyframe was never hashed says so, rather than sharing a fake value
    # that would make it a duplicate of every other unhashed shot.
    assert rows[1].measured.phash is None
    assert rows[1].measured.loudness_lufs is None


def test_shots_from_stats_rejects_a_motion_class_outside_the_vocabulary() -> None:
    """The enum is the contract with the TS mirror; an unknown word must not reach it."""
    with pytest.raises(ValueError, match="wobbly"):
        shots_from_stats(ASSET, HASH, [_stats(0, motion_class="wobbly")])


# --- ledger_store: digest ------------------------------------------------------------


def test_digest_of_an_asset_with_no_shots_is_empty_not_absent() -> None:
    digest = digest_from_shots(ASSET, HASH, [], duration_s=0.0)
    assert digest.shot_count == 0
    assert digest.median_shot_s == 0.0
    assert digest.exposure_range is None and digest.warmth_range is None
    assert digest.motion_mix == {} and digest.shot_size_mix == {}
    assert digest.low_quality_shots == []
    assert digest.coverage.total == 0


def test_digest_of_a_single_shot_collapses_its_ranges() -> None:
    rows = _measured_rows(_stats(0, luma_mean=0.42, warmth=0.14))
    digest = digest_from_shots(ASSET, HASH, rows, duration_s=2.0)
    assert digest.shot_count == 1
    assert digest.median_shot_s == 2.0
    assert digest.exposure_range == (0.42, 0.42)
    assert digest.warmth_range == (0.14, 0.14)
    assert digest.motion_mix == {"static": 1.0}


def test_digest_aggregates_ranges_mixes_and_median_length() -> None:
    rows = _measured_rows(
        _stats(0, luma_mean=0.20, warmth=-0.30, motion_class="static"),
        _stats(1, luma_mean=0.55, warmth=0.10, motion_class="handheld"),
        _stats(2, luma_mean=0.80, warmth=0.40, motion_class="handheld"),
    )
    digest = digest_from_shots(ASSET, HASH, rows, duration_s=6.0)
    assert digest.exposure_range == (0.20, 0.80)
    assert digest.warmth_range == (-0.30, 0.40)
    assert digest.motion_mix == {"handheld": 0.667, "static": 0.333}
    assert digest.median_shot_s == 2.0
    assert digest.coverage.measured == 3 and digest.coverage.labelled == 0


def test_digest_flags_black_frozen_and_soft_shots() -> None:
    rows = _measured_rows(
        _stats(0, sharpness=0.9),
        _stats(1, black=True),
        _stats(2, freeze=True),
        _stats(3, sharpness=LOW_SHARPNESS),
    )
    digest = digest_from_shots(ASSET, HASH, rows, duration_s=8.0)
    assert digest.low_quality_shots == [1, 2, 3]


def test_digest_ignores_labels_the_clip_row_would_refuse_to_print() -> None:
    """One threshold for the digest and the row: the agent must never be summarised with
    a label it will never see spelled out."""
    base = _measured_rows(_stats(0), _stats(1))
    confident = _labelled(base[0], shot_size=("MS", 0.81))
    unsure = _labelled(base[1], shot_size=("CU", 0.31))
    digest = digest_from_shots(ASSET, HASH, [confident, unsure], duration_s=4.0)
    assert digest.shot_size_mix == {"MS": 1.0}
    assert digest.coverage.labelled == 2


def test_digest_orders_people_by_how_often_they_appear() -> None:
    base = _measured_rows(_stats(0), _stats(1), _stats(2))
    marcus = EntityRef(id="person_01", kind="person", p=0.9)
    ada = EntityRef(id="person_02", kind="person", p=0.9)
    unsure = EntityRef(id="person_09", kind="person", p=0.2)
    kitchen = EntityRef(id="setting_04", kind="setting", p=0.9)
    rows = [
        _labelled(base[0], entities=[marcus, ada, kitchen]),
        _labelled(base[1], entities=[marcus, unsure]),
        _labelled(base[2], entities=[marcus]),
    ]
    digest = digest_from_shots(ASSET, HASH, rows, duration_s=6.0)
    assert digest.people == ["person_01", "person_02"]


def test_digest_serialises_to_the_camelCase_wire_shape(store: BrainStore) -> None:
    """The digest crosses to TypeScript verbatim, so the stored bytes are the wire."""
    store.upsert_shots(ASSET, HASH, "measured", _measured_rows(_stats(0)))
    digest = digest_from_shots(ASSET, HASH, store.list_shots([ASSET]), duration_s=2.0)
    store.upsert_asset_digest(digest)
    raw = json.loads(
        store._conn.execute(
            "SELECT digest FROM asset_digest WHERE asset_id = ?", (ASSET,)
        ).fetchone()[0]
    )
    assert {"assetId", "contentHash", "shotCount", "medianShotS", "lowQualityShots"} <= set(raw)
    assert AssetDigest.model_validate(raw) == digest
