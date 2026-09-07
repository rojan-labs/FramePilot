"""The local tier-1 arm end to end through ``/brain/visual/index`` (VU5.3).

What these cover is the WIRING, not the model: the pack is a scripted process, so nothing
here proves a label is correct. What it proves is that on a machine with the pack and no
key, an index slice measures and then LABELS — writing ``shots.labelled``, the local vector
space, identity clusters and duplicate links — which is the whole point of the phase. Ten
recorded golden runs never called a footage surface because a default install had no tier 1
at all (ADR 0175); a pack that resolved but wrote nothing would be the same defect wearing
a different hat.

The hosted NVIDIA arm is never resolved in any of these: no key is configured, and the
local pack wins even where one is.
"""

from __future__ import annotations

import base64
import json
import struct
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.prompt_bank import PROMPT_BANK_VERSION
from framepilot_engine.analysis.shot_stats import ShotStats
from framepilot_engine.brain.ledger_models import TIER1_VERSION
from framepilot_engine.brain.local_visual_embed import LOCAL_MODEL_ID, LocalVisualEmbedClient
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.visual_embed import MODEL_ID as HOSTED_MODEL_ID
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

DIM = 2
FACE = [0.0, 1.0]


def probe(duration: float = 12.0) -> dict[str, Any]:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=duration,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


def stats(shot_index: int, t0: float, t1: float) -> ShotStats:
    return ShotStats(
        shot_index=shot_index,
        t0=t0,
        t1=t1,
        keyframe_t=(t0 + t1) / 2,
        luma_mean=0.4,
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


def packed(vector: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(vector)}e", *vector)).decode("ascii")


class ScriptedPack:
    """Answers every ``visual.embed`` request for whatever shots it was asked about."""

    def __init__(self, *, faces: int = 0) -> None:
        self.faces = faces
        self.requests: list[dict[str, Any]] = []
        self.returncode: int | None = 0

    def __call__(self, _handle: Any) -> ScriptedPack:
        return self

    def kill(self) -> None:  # pragma: no cover - no timeout path in these tests
        pass

    def communicate(
        self, input: str | None = None, timeout: float | None = None
    ) -> tuple[str, str]:
        request = json.loads(input or "{}")
        self.requests.append(request)
        shots = request["parameters"]["shots"]
        return (
            json.dumps(
                {
                    "type": "result",
                    "protocolVersion": 1,
                    "requestId": request["requestId"],
                    "projectRevision": request["projectRevision"],
                    "capability": "visual.embed",
                    "backend": "scripted",
                    "modelDigests": {},
                    "promptBankVersion": PROMPT_BANK_VERSION,
                    "dim": DIM,
                    "faceDim": len(FACE),
                    "shots": [
                        {
                            "shotIndex": shot["shotIndex"],
                            "vector": packed([1.0, 0.0]),
                            "labels": {
                                "shotSize": {"value": "MS", "p": 0.83},
                                "subjectKind": {"value": "person", "p": 0.71},
                            },
                            "faces": self.faces,
                            "faceVectors": [packed(FACE)] * self.faces,
                        }
                        for shot in shots
                    ],
                }
            )
            + "\n",
            "",
        )


@pytest.fixture
def entrypoint(tmp_path: Path) -> Path:
    path = tmp_path / "framepilot-visual-embed"
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    return path


def pack_handle(entrypoint: Path) -> str:
    return json.dumps(
        {
            "packId": "framepilot.visual-embed",
            "version": "1.0.0",
            "releaseDigest": "a" * 64,
            "entrypoint": str(entrypoint),
            "capabilities": ["visual.embed", "visual.text"],
        }
    )


def build(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    entrypoint: Path,
    *,
    process: ScriptedPack,
    phashes: dict[str, list[str]] | None = None,
) -> TestClient:
    """A sandboxed client with a real brain, a faked tier-0 decode and a scripted pack."""
    media = tmp_path / "p1"
    media.mkdir(parents=True, exist_ok=True)
    hashes = phashes or {}
    with open_brain(tmp_path, "p1") as store:
        for asset_id in ("a0", "a1"):
            (media / f"{asset_id}.mp4").write_bytes(b"\x00\x00fake\x00\x00")
            store.upsert_asset(
                asset_id, path=f"{asset_id}.mp4", content_sha256=f"sha-{asset_id}", probe=probe()
            )

    def measure(path: Path, **_kw: Any) -> list[ShotStats]:
        return [stats(0, 0.0, 6.0), stats(1, 6.0, 12.0)]

    monkeypatch.setattr(service_module, "measure_asset", measure)
    monkeypatch.setattr(service_module, "_sha256_file", lambda path: "sha-file")
    # Tier 0's phash comes from the sampler's JPEG pass, which does not run here, so the
    # ledger rows are seeded with hashes directly where a test needs duplicate detection.
    monkeypatch.setattr(
        service_module,
        "shots_from_stats",
        lambda asset_id, content_hash, stat_rows, **_kw: _with_phashes(
            asset_id, content_hash, stat_rows, hashes
        ),
    )
    monkeypatch.setattr(LocalVisualEmbedClient, "__init__", _patched_init(process))
    return TestClient(create_app(Settings(projects_root=tmp_path)))


def _with_phashes(
    asset_id: str, content_hash: str, stat_rows: Any, hashes: dict[str, list[str]]
) -> Any:
    """Tier-0 rows carrying a keyframe hash where a test asked for one.

    The real phash comes from the sampler's JPEG pass, which is not part of the statistics
    decode and does not run here; a test that wants duplicate detection supplies it.
    """
    from framepilot_engine.brain.ledger_store import shots_from_stats as real

    per_asset = hashes.get(asset_id)
    return real(
        asset_id,
        content_hash,
        stat_rows,
        phashes={index: value for index, value in enumerate(per_asset)} if per_asset else None,
    )


def _patched_init(process: ScriptedPack) -> Any:
    from framepilot_engine.brain.local_visual_embed import LocalVisualEmbedClient

    original = LocalVisualEmbedClient.__init__

    def __init__(self: Any, handle: Any, **_kw: Any) -> None:
        original(self, handle, launch=process)

    return __init__


def index(client: TestClient, entrypoint: Path, **body: Any) -> Any:
    return client.post(
        "/brain/visual/index",
        json={"projectId": "p1", "visualEmbedPack": pack_handle(entrypoint), **body},
    ).json()


class TestLocalTierOne:
    def test_a_keyless_machine_with_the_pack_measures_and_labels(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entrypoint: Path
    ) -> None:
        process = ScriptedPack()
        client = build(tmp_path, monkeypatch, entrypoint, process=process)
        body = index(client, entrypoint, assetIds=["a0"], maxAssets=4)
        assert body["available"] is True
        assert body["tiers"]["labelled"] == "ok"
        assert body["coverage"]["labelled"] == 2
        with open_brain(tmp_path, "p1") as store:
            shots = store.list_shots(["a0"])
        assert [shot.labelled.model for shot in shots if shot.labelled] == [LOCAL_MODEL_ID] * 2
        first = shots[0].labelled
        assert first is not None
        assert first.tier1_version == TIER1_VERSION
        assert first.shot_size is not None and first.shot_size.value == "MS"
        assert first.subject_kind is not None and first.subject_kind.value == "person"
        # The two groups the scripted pack did not score stay absent, not defaulted:
        # "not scored" and "scored as nothing" are different facts.
        assert first.setting is None
        assert first.screen_content is None

    def test_vectors_land_in_the_local_space_and_never_nvidia_s(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entrypoint: Path
    ) -> None:
        client = build(tmp_path, monkeypatch, entrypoint, process=ScriptedPack())
        index(client, entrypoint, assetIds=["a0"], maxAssets=4)
        with open_brain(tmp_path, "p1") as store:
            local = store.list_visual_vectors(model=LOCAL_MODEL_ID)
            hosted = store.list_visual_vectors(model=HOSTED_MODEL_ID)
            spans = store.list_visual_spans(model=LOCAL_MODEL_ID)
        assert len(local) == 2
        assert all(vector.dim == DIM for vector in local)
        assert hosted == []
        assert [span.scene_index for span in spans] == [0, 1]

    def test_the_request_names_the_engine_s_bank_and_the_measured_keyframes(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entrypoint: Path
    ) -> None:
        process = ScriptedPack()
        client = build(tmp_path, monkeypatch, entrypoint, process=process)
        index(client, entrypoint, assetIds=["a0"], maxAssets=4)
        [request] = [r for r in process.requests if r["capability"] == "visual.embed"]
        assert request["parameters"]["promptBankVersion"] == PROMPT_BANK_VERSION
        assert [shot["keyframeT"] for shot in request["parameters"]["shots"]] == [3.0, 9.0]

    def test_a_second_slice_resumes_rather_than_relabelling(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entrypoint: Path
    ) -> None:
        process = ScriptedPack()
        client = build(tmp_path, monkeypatch, entrypoint, process=process)
        index(client, entrypoint, assetIds=["a0"], maxAssets=4)
        before = len(process.requests)
        index(client, entrypoint, assetIds=["a0"], maxAssets=4)
        assert len(process.requests) == before

    def test_faces_become_stable_person_ids_and_a_stored_centroid(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entrypoint: Path
    ) -> None:
        client = build(tmp_path, monkeypatch, entrypoint, process=ScriptedPack(faces=1))
        index(client, entrypoint, assetIds=["a0"], maxAssets=4)
        with open_brain(tmp_path, "p1") as store:
            shots = store.list_shots(["a0"])
            entities = store.list_entities(model=LOCAL_MODEL_ID)
        assert [entity.id for entity in entities] == ["person_01"]
        assert entities[0].shot_count == 2
        assert entities[0].centroid == pytest.approx(FACE, abs=1e-3)
        for shot in shots:
            assert shot.labelled is not None
            assert [ref.id for ref in shot.labelled.entities] == ["person_01"]

    def test_identical_keyframes_are_linked_as_repeated_takes(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entrypoint: Path
    ) -> None:
        same = str(0xDEADBEEFCAFEF00D)
        other = str(0x0123456789ABCDEF)
        client = build(
            tmp_path,
            monkeypatch,
            entrypoint,
            process=ScriptedPack(),
            phashes={"a0": [same, other], "a1": [same, other]},
        )
        index(client, entrypoint, assetIds=["a0", "a1"], maxAssets=4)
        with open_brain(tmp_path, "p1") as store:
            shots = {
                f"{shot.asset_id}#{shot.shot_index}": shot
                for shot in store.list_shots(["a0", "a1"])
            }
        links = {
            key: shot.labelled.duplicate_of
            for key, shot in shots.items()
            if shot.labelled is not None
        }
        # Every repeat points at the FIRST take, across assets, and the first points at
        # nothing.
        assert links == {
            "a0#0": None,
            "a0#1": None,
            "a1#0": "a0#0",
            "a1#1": "a0#1",
        }

    def test_a_malformed_handle_is_no_pack_not_a_failed_slice(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entrypoint: Path
    ) -> None:
        client = build(tmp_path, monkeypatch, entrypoint, process=ScriptedPack())
        body = client.post(
            "/brain/visual/index",
            json={"projectId": "p1", "visualEmbedPack": "{oops", "assetIds": ["a0"]},
        ).json()
        assert body["available"] is True
        assert body["tiers"]["measured"] == "ok"
        assert body["tiers"]["labelled"].startswith("skipped:")
        with open_brain(tmp_path, "p1") as store:
            assert store.tier_coverage(["a0"]).measured == 2
