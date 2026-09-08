"""Captions attach to spans by TIME, not by index (VU6.3).

Captions used to be joined to spans by ``scene_index``, which was correct only while one
producer wrote both. Tier 2 now writes against the SHOT ledger while the hosted NVIDIA arm's
spans come from the SAMPLER, so the two index spaces number two different segmentations:
"index 7" is not the same moment in each. Matching by index would attach shot 7's
description to span 7 and report it as fact — a confident, invisible lie about the footage,
and the kind that looks right until you check the one place it is worst.

So these fixtures deliberately give the two sides DIFFERENT segmentations and check the LAST
span, where an index offset has accumulated the most.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from framepilot_engine.analysis.visual_sampler import SAMPLER_VERSION
from framepilot_engine.brain.models import VisualCaptionRow, VisualSpanRow
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.visual_embed import MODEL_ID
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

#: Four SAMPLER spans of 10s each over a 40s clip.
SPANS = [(0.0, 10.0), (10.0, 20.0), (20.0, 30.0), (30.0, 40.0)]
#: Six SHOT captions over the same 40s. Different count, different boundaries — which is
#: the whole point: `scene_index` 3 in one is nowhere near index 3 in the other.
CAPTIONS = [
    (0.0, 6.0, "a wide of the street"),
    (6.0, 13.0, "a man crossing"),
    (13.0, 19.0, "a shop front"),
    (19.0, 26.0, "the man again, closer"),
    (26.0, 34.0, "a bus passing"),
    (34.0, 40.0, "the street at dusk"),
]


def _probe() -> dict[str, Any]:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=40.0,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080)],
    ).model_dump(mode="json")


def _seed(root: Path) -> None:
    with open_brain(root, "p1") as store:
        store.upsert_asset("vid", path="clip.mp4", content_sha256="sha-vid", probe=_probe())
        store.upsert_visual_spans(
            [
                VisualSpanRow(
                    asset_id="vid",
                    content_hash="sha-vid",
                    model=MODEL_ID,
                    sampler_version=SAMPLER_VERSION,
                    t0=t0,
                    t1=t1,
                    scene_index=index,
                    keyframe_t=(t0 + t1) / 2,
                    phash=index + 1,
                    frame_count=int(t1 - t0),
                )
                for index, (t0, t1) in enumerate(SPANS)
            ]
        )
        store.upsert_visual_captions(
            [
                VisualCaptionRow(
                    asset_id="vid",
                    scene_index=index,
                    t0=t0,
                    t1=t1,
                    text=text,
                    model="test/vlm",
                )
                for index, (t0, t1, text) in enumerate(CAPTIONS)
            ]
        )


def _chapters(tmp_path: Path) -> list[dict[str, Any]]:
    _seed(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post("/brain/visual/footage-map", json={"projectId": "p1"}).json()
    assert body["available"] is True, body
    chapters: list[dict[str, Any]] = body["chapters"]
    return chapters


def test_each_span_gets_the_caption_that_actually_covers_it(tmp_path: Path) -> None:
    titles = [chapter["title"] for chapter in _chapters(tmp_path)]
    # Span 0 [0,10) overlaps "wide" by 6s and "man crossing" by 4s → the wide wins.
    # Span 1 [10,20) overlaps "man crossing" 3s, "shop front" 6s, "man again" 1s → shop.
    # Span 2 [20,30) overlaps "man again" 6s, "bus" 4s → the man again.
    # Span 3 [30,40) overlaps "bus" 4s, "dusk" 6s → dusk.
    assert titles == [
        "a wide of the street",
        "a shop front",
        "the man again, closer",
        "the street at dusk",
    ]


def test_the_LAST_span_is_where_index_matching_would_have_been_most_wrong(
    tmp_path: Path,
) -> None:
    # The check worth doing by hand, per the plan: drift is largest at the end. Span 3 is
    # the last of four; caption index 3 is "the man again, closer", which is on screen from
    # 19 to 26 — before this span even starts. Index matching would have titled the final
    # chapter with a shot that had already ended, and nothing downstream could tell.
    last = _chapters(tmp_path)[-1]
    assert last["title"] == "the street at dusk"
    assert last["title"] != CAPTIONS[3][2]


def test_a_caption_that_merely_abuts_a_span_is_not_attached_to_it(tmp_path: Path) -> None:
    # Touching is not covering. A zero-overlap match would let the caption for the NEXT
    # shot title this one, which is the same lie by a smaller margin.
    _seed(tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("vid2", path="b.mp4", content_sha256="sha-2", probe=_probe())
        store.upsert_visual_captions(
            [
                VisualCaptionRow(
                    asset_id="vid2",
                    scene_index=0,
                    t0=10.0,
                    t1=20.0,
                    text="the next shot entirely",
                    model="test/vlm",
                )
            ]
        )
        store.upsert_visual_spans(
            [
                VisualSpanRow(
                    asset_id="vid2",
                    content_hash="sha-2",
                    model=MODEL_ID,
                    sampler_version=SAMPLER_VERSION,
                    t0=0.0,
                    t1=10.0,
                    scene_index=0,
                    keyframe_t=5.0,
                    phash=99,
                    frame_count=10,
                )
            ]
        )
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post("/brain/visual/footage-map", json={"projectId": "p1"}).json()
    titles = {c["assetId"]: c.get("title") for c in body["chapters"]}
    assert titles.get("vid2") != "the next shot entirely"
