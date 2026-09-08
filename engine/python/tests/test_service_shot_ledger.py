"""Service tests for the keyless tier-0 shot ledger (ADR 0175, plan VU1.4).

The defect these cover, measured: across ten recorded golden runs the agent never
called a footage surface once, because on a default install nothing is ever indexed —
``/brain/visual/index`` resolved an embedder, found no key, and returned
``available=True`` having done nothing at all. Tier 0 needs no key, no model and no
network, so that early return was the bug.

``measure_asset`` (the single ffmpeg decode) is monkeypatched at the service seam, the
same pattern ``test_service_visual_index.py`` uses for the embedder and the frame
decode; every brain write is real SQLite.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.shot_stats import ShotStats
from framepilot_engine.brain.ledger_models import TIER0_VERSION
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.twelvelabs import TaskStatus, TwelveLabsClientResolution
from framepilot_engine.config import Settings
from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

# --- Fixtures -------------------------------------------------------------------


def _video_probe(duration: float = 12.0) -> dict[str, Any]:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=duration,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


def _stats(shot_index: int, t0: float, t1: float) -> ShotStats:
    """One shot's tier-0 measurements, with the fields the ledger actually reads varied."""
    return ShotStats(
        shot_index=shot_index,
        t0=t0,
        t1=t1,
        keyframe_t=(t0 + t1) / 2,
        luma_mean=0.4 + 0.1 * shot_index,
        luma_std=0.18,
        luma_p10=0.08,
        luma_p90=0.86,
        u_mean=124.1,
        v_mean=133.8,
        sat_mean=0.31,
        warmth=0.14,
        contrast_idx=0.62,
        si=41.2,
        ti=1.0,
        motion_class="static",
        cut_score=0.31,
        black=False,
        freeze=False,
        sharpness=0.71,
    )


def _seed_assets(root: Path, media_dir: Path, count: int = 2) -> list[str]:
    """Real files inside the sandbox plus their brain rows, so path resolution runs."""
    ids: list[str] = []
    with open_brain(root, "p1") as store:
        for n in range(count):
            asset_id = f"a{n}"
            (media_dir / f"{asset_id}.mp4").write_bytes(b"\x00\x00fake\x00\x00")
            store.upsert_asset(
                asset_id,
                path=f"{asset_id}.mp4",
                content_sha256=f"sha-{asset_id}",
                probe=_video_probe(),
            )
            ids.append(asset_id)
    return ids


def _client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    measure: Any = None,
    calls: list[Path] | None = None,
    with_key: bool = False,
) -> TestClient:
    """A sandboxed client with the tier-0 decode faked and, by default, NO keys at all.

    ``calls`` records the media paths the decode was asked for, which is how the resume
    tests tell "measured once" from "measured again".
    """
    recorded = calls if calls is not None else []

    def _measure(path: Path, **kw: Any) -> list[ShotStats]:
        recorded.append(path)
        return [_stats(0, 0.0, 6.0), _stats(1, 6.0, 12.0)]

    monkeypatch.setattr(service_module, "measure_asset", measure or _measure)
    return TestClient(
        create_app(
            Settings(
                projects_root=tmp_path,
                nvidia_embeddings_keys="key-abc" if with_key else None,
            )
        )
    )


def _index(client: TestClient, **body: Any) -> Any:
    return client.post("/brain/visual/index", json={"projectId": "p1", **body}).json()


def _drain(client: TestClient, **body: Any) -> Any:
    """Post slices until the job is done, returning the LAST response."""
    body_out = _index(client, **body)
    for _ in range(20):
        if body_out.get("done") or body_out.get("jobId") is None:
            break
        body_out = _index(client, jobId=body_out["jobId"], **body)
    return body_out


# --- Tier 0 runs with no key ----------------------------------------------------


def test_keyless_index_writes_measured_shots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The defect, directly: no key anywhere, and the ledger fills up regardless."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root)
    client = _client(root, monkeypatch)

    body = _drain(client)

    assert body["available"] is True and body["done"] is True
    with open_brain(root, "p1") as store:
        shots = store.list_shots(["a0", "a1"])
        coverage = store.tier_coverage(["a0", "a1"])
    assert len(shots) == 4
    assert {s.asset_id for s in shots} == {"a0", "a1"}
    assert all(s.measured is not None for s in shots)
    assert all(s.measured.tier0_version == TIER0_VERSION for s in shots if s.measured)
    assert (coverage.measured, coverage.labelled, coverage.described) == (4, 0, 0)


def test_keyless_index_reports_measured_coverage_and_names_skipped_tiers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing key is a skipped TIER, reported in `tiers`, not a job that did nothing."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    client = _client(root, monkeypatch)

    body = _drain(client)

    assert body["coverage"] == {"measured": 2, "labelled": 0, "described": 0, "total": 2}
    assert body["tiers"]["measured"] == "ok"
    assert body["tiers"]["labelled"] == "skipped: no_api_key"
    assert body["tiers"]["described"].startswith("skipped:")
    # `reason` is the paced loop's TERMINAL signal, so a skipped tier must never land in
    # it — the host stops re-posting on any reason at all. Skips live in `tiers`.
    assert body["reason"] is None
    assert body["items"][0]["ok"] is True
    assert body["items"][0]["tiers"]["measured"] == "ok"


def test_keyless_index_journals_tiers_on_the_outcome_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tier that never ran outlives the response that reported it."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    client = _client(root, monkeypatch)

    _drain(client)

    with open_brain(root, "p1") as store:
        rows = store.list_analysis("a0", kind="visual:outcome")
    assert rows and rows[0].result["tiers"]["measured"] == "ok"
    assert rows[0].result["tiers"]["labelled"].startswith("skipped:")


def test_digest_is_rebuilt_alongside_the_shots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    client = _client(root, monkeypatch)

    _drain(client)

    with open_brain(root, "p1") as store:
        digests = store.get_asset_digests(["a0"])
    assert len(digests) == 1
    assert digests[0].shot_count == 2
    assert digests[0].duration_s == 12.0
    assert digests[0].coverage.measured == 2


# --- Idempotence and invalidation -----------------------------------------------


def test_rerunning_resumes_without_remeasuring(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tier 0 is paid once per content hash; a second job must not decode again."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    calls: list[Path] = []
    client = _client(root, monkeypatch, calls=calls)

    _drain(client)
    first = len(calls)
    _drain(client)

    assert first == 1
    assert len(calls) == 1
    with open_brain(root, "p1") as store:
        assert len(store.list_shots(["a0"])) == 2


def test_changed_content_hash_remeasures_and_drops_the_stale_shots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Re-encoded bytes keep the asset id but are, to the ledger, different footage."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    calls: list[Path] = []
    client = _client(root, monkeypatch, calls=calls)
    _drain(client)

    with open_brain(root, "p1") as store:
        store.upsert_asset("a0", path="a0.mp4", content_sha256="sha-changed", probe=_video_probe())
    _drain(client)

    assert len(calls) == 2
    with open_brain(root, "p1") as store:
        shots = store.list_shots(["a0"])
    assert len(shots) == 2
    assert {s.content_hash for s in shots} == {"sha-changed"}


def test_measurement_failure_fails_only_that_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One undecodable file must never block the assets behind it."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=2)

    def _measure(path: Path, **kw: Any) -> list[ShotStats]:
        if path.name == "a0.mp4":
            raise FFmpegError("ffmpeg exited 1: moov atom not found")
        return [_stats(0, 0.0, 12.0)]

    client = _client(root, monkeypatch, measure=_measure)
    body = _drain(client)

    assert body["done"] is True
    with open_brain(root, "p1") as store:
        assert {s.asset_id for s in store.list_shots(["a0", "a1"])} == {"a1"}
    failed = [i for i in body["items"] if not i["ok"]]
    assert len(failed) == 1
    assert failed[0]["assetId"] == "a0"
    assert failed[0]["tiers"]["measured"].startswith("failed:")


# --- The tiers field ------------------------------------------------------------


def test_tiers_measured_only_skips_the_other_two(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A key IS configured; asking for measured alone must not resolve an embedder."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    resolved: list[str | None] = []

    def _never(keys: str | None = None) -> Any:
        resolved.append(keys)
        raise AssertionError("the embedder must not be resolved for tiers=['measured']")

    monkeypatch.setattr(service_module, "resolve_visual_embedder", _never)
    client = _client(root, monkeypatch, with_key=True)

    body = _drain(client, tiers=["measured"])

    assert resolved == []
    assert body["tiers"]["labelled"] == "skipped: tier not requested"
    assert body["tiers"]["described"] == "skipped: tier not requested"
    assert body["coverage"]["measured"] == 2


def test_unknown_tier_is_rejected_at_the_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    client = _client(root, monkeypatch)
    response = client.post(
        "/brain/visual/index", json={"projectId": "p1", "tiers": ["measured", "guessed"]}
    )
    assert response.status_code == 422


# --- GET /brain/shots -----------------------------------------------------------


def test_shots_route_pages_with_a_cursor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=2)
    client = _client(root, monkeypatch)
    _drain(client)

    first = client.get("/brain/shots", params={"projectId": "p1", "limit": 3}).json()
    assert first["available"] is True
    assert len(first["shots"]) == 3
    assert first["nextCursor"] is not None
    assert first["coverage"] == {"measured": 4, "labelled": 0, "described": 0, "total": 4}
    assert len(first["digests"]) == 2

    second = client.get(
        "/brain/shots",
        params={"projectId": "p1", "limit": 3, "after": first["nextCursor"]},
    ).json()
    assert len(second["shots"]) == 1
    assert second["nextCursor"] is None
    # Digests are page-independent aggregates; they ride the first page only.
    assert second["digests"] == []
    keys = [(s["assetId"], s["shotIndex"]) for s in [*first["shots"], *second["shots"]]]
    assert keys == [("a0", 0), ("a0", 1), ("a1", 0), ("a1", 1)]


def test_shots_route_filters_by_asset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=2)
    client = _client(root, monkeypatch)
    _drain(client)

    body = client.get("/brain/shots", params={"projectId": "p1", "assetIds": ["a1"]}).json()

    assert {s["assetId"] for s in body["shots"]} == {"a1"}
    assert body["coverage"]["total"] == 2


def test_shots_route_accepts_comma_joined_asset_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The host client joins the ids with commas; a repeat-only route would read one."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=2)
    client = _client(root, monkeypatch)
    _drain(client)

    body = client.get("/brain/shots", params={"projectId": "p1", "assetIds": "a0,a1"}).json()

    assert {s["assetId"] for s in body["shots"]} == {"a0", "a1"}
    assert body["coverage"]["total"] == 4


def test_shots_route_caps_the_page(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A caller asking for the library gets a bounded page, not the library."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    client = _client(root, monkeypatch)
    _drain(client)

    body = client.get("/brain/shots", params={"projectId": "p1", "limit": 10_000}).json()

    assert body["available"] is True
    # Two shots exist, so the cap shows up as an exhausted page rather than a full one.
    assert len(body["shots"]) == 2 and body["nextCursor"] is None
    assert service_module.MAX_LEDGER_PAGE == 5000


def test_shots_route_unavailable_without_projects_root(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings()))
    body = client.get("/brain/shots", params={"projectId": "p1"}).json()
    assert body["available"] is False and "sandbox root" in body["reason"]
    assert body["shots"] == [] and body["coverage"]["total"] == 0


def test_shots_route_rejects_a_forged_cursor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cursor arrives from a query string; a malformed one is untrusted input."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    client = _client(root, monkeypatch)
    _drain(client)

    body = client.get("/brain/shots", params={"projectId": "p1", "after": "a0:7"}).json()

    assert body["available"] is False and "cursor" in body["reason"]


def test_shots_route_is_empty_but_available_before_any_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    client = _client(root, monkeypatch)

    body = client.get("/brain/shots", params={"projectId": "p1"}).json()

    assert body["available"] is True and body["shots"] == []
    assert body["coverage"] == {"measured": 0, "labelled": 0, "described": 0, "total": 0}


# --- Status ---------------------------------------------------------------------


def test_status_reports_ledger_coverage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    client = _client(root, monkeypatch)
    _drain(client)

    body = client.get("/brain/visual/status", params={"projectId": "p1"}).json()

    assert body["available"] is True
    assert body["coverage"] == {"measured": 2, "labelled": 0, "described": 0, "total": 2}


# --- The TwelveLabs arm ---------------------------------------------------------


class _FakeTL:
    """Only the calls the index slice makes."""

    def create_index(self, name: str) -> str:
        return "idx-1"

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        return "task-1"

    def get_task(self, task_id: str) -> TaskStatus:
        return TaskStatus(task_id, "ready", "video-xyz")


def test_twelvelabs_arm_still_runs_tier_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tier 0 is the floor under every backend, hosted included."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=1)
    monkeypatch.setattr(
        service_module,
        "resolve_twelvelabs",
        lambda key=None: TwelveLabsClientResolution(client=_FakeTL()),  # type: ignore[arg-type]
    )
    calls: list[Path] = []

    def _measure(path: Path, **kw: Any) -> list[ShotStats]:
        calls.append(path)
        return [_stats(0, 0.0, 12.0)]

    monkeypatch.setattr(service_module, "measure_asset", _measure)
    client = TestClient(create_app(Settings(projects_root=root, twelvelabs_api_key="tl-key")))

    body = _drain(client)

    assert body["done"] is True
    assert len(calls) == 1
    with open_brain(root, "p1") as store:
        shots = store.list_shots(["a0"])
    assert len(shots) == 1 and shots[0].measured is not None
    assert body["tiers"]["measured"] == "ok"
    assert body["coverage"]["measured"] == 1


# --- Worklist priority ----------------------------------------------------------


def _project_doc(asset_id: str) -> dict[str, Any]:
    return {
        "id": "p1",
        "name": "Demo",
        "timeline": {
            "tracks": [
                {
                    "id": "t1",
                    "type": "video",
                    "clips": [
                        {
                            "id": "c1",
                            "trackId": "t1",
                            "assetId": asset_id,
                            "start": 0.0,
                            "end": 2.0,
                            "sourceIn": 0.0,
                            "sourceOut": 2.0,
                        }
                    ],
                }
            ]
        },
    }


@pytest.mark.parametrize(
    ("priority", "expected_first"),
    [("timeline", "a1"), ("bin", "a0"), ("all", "a0")],
)
def test_priority_orders_a_new_jobs_worklist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    priority: str,
    expected_first: str,
) -> None:
    """Indexing is paced, so the ORDER decides what the agent can see first."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed_assets(root, root, count=2)
    calls: list[Path] = []
    client = _client(root, monkeypatch, calls=calls)

    body = _index(
        client,
        priority=priority,
        project=_project_doc("a1"),
        maxAssets=1,
    )

    assert body["cursor"] == 1
    assert calls[0].name == f"{expected_first}.mp4"
