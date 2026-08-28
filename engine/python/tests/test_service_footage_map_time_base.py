"""A footage map must say which clock its times are on.

`map_footage` documents "timeline seconds", but the projection needs a project
document to project THROUGH. The per-run context read sent none, so
`project_span_to_timeline` returned nothing and every chapter silently fell back to
source seconds — under a timeline label. On a single-asset project starting at 0 the
two coincide, which is how it survived; on any multi-asset project the model was
reading boundaries that do not exist on the timeline.

These tests pin the response's own statement of its clock, and the separate case of an
asset that is in the map but not on the timeline (a photo still in the bin), whose rows
stay on the other clock no matter what the response as a whole says.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from framepilot_engine.analysis.visual_sampler import SAMPLER_VERSION
from framepilot_engine.brain.models import VisualSpanRow
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.visual_embed import MODEL_ID
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app


def _probe(name: str) -> dict[str, Any]:
    return MediaInfo(
        path=f"/{name}",
        duration_seconds=60.0,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


def _seed(root: Path) -> None:
    """Two assets, each with one indexed span at 0-10s of its OWN footage."""
    with open_brain(root, "p1") as store:
        for asset_id in ("asset_a", "asset_b"):
            store.upsert_asset(
                asset_id,
                path=f"{asset_id}.mp4",
                content_sha256=f"sha-{asset_id}",
                probe=_probe(asset_id),
            )
            store.upsert_visual_spans(
                [
                    VisualSpanRow(
                        asset_id=asset_id,
                        model=MODEL_ID,
                        sampler_version=SAMPLER_VERSION,
                        t0=0.0,
                        t1=10.0,
                        scene_index=0,
                        keyframe_t=0.0,
                        phash=1,
                        content_hash=f"sha-{asset_id}",
                        frame_count=1,
                    )
                ]
            )


def _project(place_b: bool) -> dict[str, Any]:
    """`asset_a` sits at timeline 0-10; `asset_b` is placed at 30-40, or left in the bin."""
    clips = [
        {
            "id": "c1",
            "assetId": "asset_a",
            "trackId": "t1",
            "start": 0.0,
            "end": 10.0,
            "sourceStart": 0.0,
            "sourceEnd": 10.0,
        }
    ]
    if place_b:
        clips.append(
            {
                "id": "c2",
                "assetId": "asset_b",
                "trackId": "t1",
                "start": 30.0,
                "end": 40.0,
                "sourceStart": 0.0,
                "sourceEnd": 10.0,
            }
        )
    return {
        "id": "p1",
        "name": "Demo",
        "timeline": {"tracks": [{"id": "t1", "type": "video", "clips": clips}]},
    }


def _client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(Settings(projects_root=tmp_path)))


def _map(client: TestClient, **body: Any) -> Any:
    return client.post("/brain/visual/footage-map", json={"projectId": "p1", **body}).json()


def test_without_a_project_the_map_says_it_is_asset_time(tmp_path: Path) -> None:
    """The exact shape of the per-run context read before this was fixed."""
    _seed(tmp_path)
    body = _map(_client(tmp_path))
    assert body["available"] is True
    assert body["timeBase"] == "asset"
    # And the times really are source seconds — both assets start at 0.
    assert sorted(c["t0"] for c in body["chapters"]) == [0.0, 0.0]


def test_with_a_project_the_map_says_it_is_timeline_time_and_projects(tmp_path: Path) -> None:
    _seed(tmp_path)
    body = _map(_client(tmp_path), project=_project(place_b=True))
    assert body["timeBase"] == "timeline"
    assert body["unplacedAssets"] == []
    by_asset = {c["assetId"]: (c["t0"], c["t1"]) for c in body["chapters"]}
    assert by_asset["asset_a"] == (0.0, 10.0)
    # The whole point: asset_b's own 0-10s lands at 30-40s on the timeline.
    assert by_asset["asset_b"] == (30.0, 40.0)


def test_asset_time_is_honoured_even_when_a_project_is_supplied(tmp_path: Path) -> None:
    _seed(tmp_path)
    body = _map(_client(tmp_path), project=_project(place_b=True), assetTime=True)
    assert body["timeBase"] == "asset"
    assert {c["t0"] for c in body["chapters"]} == {0.0}


def test_an_asset_not_on_the_timeline_is_named_rather_than_silently_mixed(
    tmp_path: Path,
) -> None:
    """A photo still in the bin cannot be projected; its rows stay on the other clock."""
    _seed(tmp_path)
    body = _map(_client(tmp_path), project=_project(place_b=False))
    assert body["timeBase"] == "timeline"
    assert body["unplacedAssets"] == ["asset_b"]
    by_asset = {c["assetId"]: c["t0"] for c in body["chapters"]}
    assert by_asset["asset_a"] == 0.0
    # Still its own source seconds — and the response says so rather than pretending.
    assert by_asset["asset_b"] == 0.0


def test_an_unindexed_project_still_states_its_clock(tmp_path: Path) -> None:
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("asset_a", path="a.mp4", content_sha256="sha", probe=_probe("a.mp4"))
    body = _map(_client(tmp_path), project=_project(place_b=False))
    assert body["reason"] == "not_indexed"
    assert body["timeBase"] == "timeline"


def test_the_map_reports_how_much_of_the_project_it_was_built_from(tmp_path: Path) -> None:
    """A map is usable long before preparation finishes — say so, or a partial map
    reads as the whole of the footage and the agent concludes there is nothing else."""
    _seed(tmp_path)
    with open_brain(tmp_path, "p1") as store:
        # A third asset the index has not reached yet.
        store.upsert_asset(
            "asset_c", path="asset_c.mp4", content_sha256="sha-c", probe=_probe("asset_c")
        )
    body = _map(_client(tmp_path), project=_project(place_b=True))
    assert body["coverage"] == {"prepared": 2, "total": 3}


def test_coverage_is_reported_even_when_nothing_is_indexed(tmp_path: Path) -> None:
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("asset_a", path="a.mp4", content_sha256="sha", probe=_probe("a.mp4"))
    body = _map(_client(tmp_path), project=_project(place_b=False))
    assert body["reason"] == "not_indexed"
    assert body["coverage"] == {"prepared": 0, "total": 1}
