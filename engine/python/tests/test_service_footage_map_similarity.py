"""Chapters that look the same must say so.

The two situations where a montage repeats itself are a photo dump of one moment and
a multi-take shoot, and nothing in the index told the model which of its candidates
were the same picture twice. Every span already stores the dHash of its keyframe
(`visual_spans.phash`), computed at index time and read by nothing for this — so the
signal costs no extra analysis.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from framepilot_engine.analysis.visual_sampler import DEFAULT_HAMMING_THRESHOLD, SAMPLER_VERSION
from framepilot_engine.brain.models import VisualSpanRow
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.visual_embed import MODEL_ID
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

#: A base hash and three relatives: one a bit-flip away (the same photo), one far away.
BASE = 0xF0F0F0F0F0F0F0F0
NEAR = BASE ^ 0b1  # 1 bit apart — well inside the threshold
NEARER = BASE ^ 0b11  # 2 bits apart
FAR = 0x0F0F0F0F0F0F0F0F  # every bit differs


def _image_probe(name: str) -> dict[str, Any]:
    return MediaInfo(
        path=f"/{name}",
        duration_seconds=0.04,
        format_name="image2",
        streams=[StreamInfo(index=0, codec_type="video", width=1200, height=1600)],
    ).model_dump(mode="json")


def _seed(root: Path, hashes: dict[str, int]) -> None:
    with open_brain(root, "p1") as store:
        for asset_id, phash in hashes.items():
            store.upsert_asset(
                asset_id,
                path=f"{asset_id}.jpg",
                content_sha256=f"sha-{asset_id}",
                probe=_image_probe(f"{asset_id}.jpg"),
            )
            store.upsert_visual_spans(
                [
                    VisualSpanRow(
                        asset_id=asset_id,
                        model=MODEL_ID,
                        sampler_version=SAMPLER_VERSION,
                        t0=0.0,
                        t1=0.0,
                        scene_index=0,
                        keyframe_t=0.0,
                        phash=phash,
                        content_hash=f"sha-{asset_id}",
                        frame_count=1,
                    )
                ]
            )


def _map(root: Path) -> Any:
    client = TestClient(create_app(Settings(projects_root=root)))
    return client.post(
        "/brain/visual/footage-map", json={"projectId": "p1", "assetTime": True}
    ).json()


def test_near_duplicate_photos_share_a_group(tmp_path: Path) -> None:
    _seed(tmp_path, {"photo_a": BASE, "photo_b": NEAR, "photo_c": FAR})
    groups = {c["assetId"]: c["similarGroup"] for c in _map(tmp_path)["chapters"]}
    assert groups["photo_a"] == groups["photo_b"]
    assert groups["photo_a"] is not None
    # The one that looks like nothing else carries no number: a group of one is noise.
    assert groups["photo_c"] is None


def test_similarity_is_transitive_across_a_burst(tmp_path: Path) -> None:
    """A~B and B~C put all three together, even if A and C straddle the threshold."""
    _seed(tmp_path, {"a": BASE, "b": NEAR, "c": NEARER})
    groups = {c["assetId"]: c["similarGroup"] for c in _map(tmp_path)["chapters"]}
    assert len({groups["a"], groups["b"], groups["c"]}) == 1
    assert groups["a"] is not None


def test_distinct_bursts_get_distinct_groups(tmp_path: Path) -> None:
    _seed(tmp_path, {"a1": BASE, "a2": NEAR, "b1": FAR, "b2": FAR ^ 0b1})
    groups = {c["assetId"]: c["similarGroup"] for c in _map(tmp_path)["chapters"]}
    assert groups["a1"] == groups["a2"]
    assert groups["b1"] == groups["b2"]
    assert groups["a1"] != groups["b1"]


def test_a_project_with_nothing_alike_carries_no_marks(tmp_path: Path) -> None:
    _seed(tmp_path, {"a": BASE, "b": FAR})
    assert all(c["similarGroup"] is None for c in _map(tmp_path)["chapters"])


def test_the_threshold_is_the_samplers_own(tmp_path: Path) -> None:
    """Reused, not invented: the same distance the sampler calls 'same content'."""
    just_outside = BASE ^ ((1 << (DEFAULT_HAMMING_THRESHOLD + 1)) - 1)
    _seed(tmp_path, {"a": BASE, "b": just_outside})
    assert all(c["similarGroup"] is None for c in _map(tmp_path)["chapters"])
