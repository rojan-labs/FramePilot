"""Tests for the timeline data model and round-tripping (PRD §11)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from framepilot_engine.effects.keyframes import Easing
from framepilot_engine.render.presets import EXPORT_PRESETS
from framepilot_engine.timeline.models import (
    SCHEMA_VERSION,
    Angle,
    AngleGroup,
    AudioRole,
    Clip,
    Project,
    ProjectFile,
    ProjectFileError,
    Timeline,
    Track,
    TrackType,
)


def test_project_round_trip(sample_project_dict: dict[str, Any]) -> None:
    project = Project.model_validate(sample_project_dict)
    assert project.id == "project_001"
    assert project.resolution.width == 1920
    assert isinstance(project.timeline, Timeline)
    assert project.timeline.tracks[0].type == TrackType.VIDEO

    dumped = project.model_dump(by_alias=True)
    assert dumped["aiMemory"] == {}
    # Re-validating the dump must yield an equivalent project (round-trip).
    assert Project.model_validate(dumped) == project


def test_clip_alias_round_trip(sample_clip_dict: dict[str, Any]) -> None:
    clip = Clip.model_validate(sample_clip_dict)
    assert clip.asset_id == "asset_001"
    assert clip.source_start == 4.0
    assert clip.model_dump(by_alias=True)["sourceStart"] == 4.0


def test_export_presets_constants() -> None:
    assert {"reels", "tiktok", "shorts", "youtube", "square"} == set(EXPORT_PRESETS)
    assert EXPORT_PRESETS["reels"].width == 1080
    assert EXPORT_PRESETS["reels"].height == 1920
    assert EXPORT_PRESETS["youtube"].width == 1920
    assert EXPORT_PRESETS["youtube"].height == 1080


def test_easing_enum_members() -> None:
    assert {e.value for e in Easing} == {
        "linear",
        "ease-in",
        "ease-out",
        "ease-in-out",
        "hold",
        "bezier",
    }


def test_project_file_save_load_round_trip(
    sample_project_dict: dict[str, Any], tmp_path: Path
) -> None:
    project = Project.model_validate(sample_project_dict)
    dest = tmp_path / "demo.project.fp.json"

    ProjectFile.save(project, dest)
    loaded = ProjectFile.load(dest)

    assert loaded == project
    # The on-disk document carries the schema envelope at the top level.
    on_disk = json.loads(dest.read_text())
    assert on_disk["schemaVersion"] == SCHEMA_VERSION
    assert on_disk["id"] == "project_001"


def test_project_file_save_is_atomic_overwrite(
    sample_project_dict: dict[str, Any], tmp_path: Path
) -> None:
    dest = tmp_path / "demo.project.fp.json"
    project = Project.model_validate(sample_project_dict)
    ProjectFile.save(project, dest)

    project.name = "Renamed"
    ProjectFile.save(project, dest)

    assert ProjectFile.load(dest).name == "Renamed"
    # No leftover temp files from the atomic write.
    assert list(tmp_path.glob(".fp-*.tmp")) == []


def test_project_file_save_creates_parent_dirs(
    sample_project_dict: dict[str, Any], tmp_path: Path
) -> None:
    dest = tmp_path / "nested" / "dir" / "demo.project.fp.json"
    ProjectFile.save(Project.model_validate(sample_project_dict), dest)
    assert dest.is_file()


def test_load_missing_schema_version_assumes_current(
    sample_project_dict: dict[str, Any], tmp_path: Path
) -> None:
    dest = tmp_path / "p.json"
    dest.write_text(json.dumps(sample_project_dict))  # no schemaVersion key
    assert ProjectFile.load(dest).id == "project_001"


def test_load_rejects_newer_schema_version(
    sample_project_dict: dict[str, Any], tmp_path: Path
) -> None:
    dest = tmp_path / "p.json"
    dest.write_text(json.dumps({"schemaVersion": SCHEMA_VERSION + 1, **sample_project_dict}))
    with pytest.raises(ProjectFileError, match="supports up to"):
        ProjectFile.load(dest)


def test_load_rejects_older_schema_version(
    sample_project_dict: dict[str, Any], tmp_path: Path
) -> None:
    dest = tmp_path / "p.json"
    dest.write_text(json.dumps({"schemaVersion": SCHEMA_VERSION - 1, **sample_project_dict}))
    with pytest.raises(ProjectFileError, match="migrate"):
        ProjectFile.load(dest)


def test_load_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ProjectFileError, match="Cannot read"):
        ProjectFile.load(tmp_path / "nope.json")


def test_load_invalid_json_raises(tmp_path: Path) -> None:
    dest = tmp_path / "bad.json"
    dest.write_text("{not json")
    with pytest.raises(ProjectFileError, match="not valid JSON"):
        ProjectFile.load(dest)


def test_save_cleans_up_temp_on_write_failure(
    sample_project_dict: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Force the write to fail after the temp file is created (fsync raises).
    def boom(_fd: int) -> None:
        raise OSError("disk full")

    monkeypatch.setattr("framepilot_engine.timeline.models.os.fsync", boom)
    dest = tmp_path / "demo.project.fp.json"

    with pytest.raises(ProjectFileError, match="Cannot write"):
        ProjectFile.save(Project.model_validate(sample_project_dict), dest)

    assert not dest.exists()
    assert list(tmp_path.glob(".fp-*.tmp")) == []  # temp file was cleaned up


def test_audio_role_is_authored_never_defaulted() -> None:
    """A track's mix role (schema v17) is unknown until someone authors it.

    Guessing a role from a track or file name is the failure this guards: a lane called
    "music" routinely holds a voice-over, and ducking the wrong thing is silent and wrong.
    """
    unlabelled = Track.model_validate({"id": "music", "type": "audio", "clips": []})
    assert unlabelled.role is None

    labelled = Track.model_validate({"id": "a1", "type": "audio", "role": "dialogue", "clips": []})
    assert labelled.role is AudioRole.DIALOGUE
    # Round-trips under the camelCase wire contract without inventing a value.
    assert labelled.model_dump(by_alias=True, exclude_defaults=True)["role"] == "dialogue"
    assert "role" not in unlabelled.model_dump(by_alias=True, exclude_defaults=True)


def test_angle_sync_offset_is_authored_never_defaulted() -> None:
    """An angle's sync offset (schema v18) is unknown until someone authors it.

    Zero is not a safe default here: it asserts the cameras started rolling together,
    which makes every switch land on a different moment than the editor saw. Absent must
    stay absent so the switch compiler can refuse instead of cutting confidently wrong.
    """
    unsynced = Angle.model_validate({"id": "a2", "assetId": "cam_b"})
    assert unsynced.sync_offset_seconds is None
    assert "syncOffsetSeconds" not in unsynced.model_dump(by_alias=True, exclude_defaults=True)

    synced = Angle.model_validate({"id": "a2", "assetId": "cam_b", "syncOffsetSeconds": 12.4})
    assert synced.sync_offset_seconds == 12.4

    # A negative offset is legal: group zero can precede the start of a later camera.
    group = AngleGroup.model_validate(
        {
            "id": "grp",
            "angles": [
                {"id": "a1", "assetId": "cam_a", "syncOffsetSeconds": -3.0},
                {"id": "a2", "assetId": "cam_b", "syncOffsetSeconds": 12.4},
            ],
        }
    )
    assert [a.asset_id for a in group.angles] == ["cam_a", "cam_b"]
    assert group.name is None


def test_project_angle_groups_round_trip_under_camel_case() -> None:
    """``angleGroups`` survives the wire contract, and absence stays absence."""
    bare = Project.model_validate({"id": "p", "name": "P"})
    assert bare.angle_groups == []

    project = Project.model_validate(
        {
            "id": "p",
            "name": "P",
            "angleGroups": [
                {
                    "id": "grp",
                    "name": "Interview",
                    "angles": [
                        {"id": "a1", "name": "Wide", "assetId": "cam_a", "syncOffsetSeconds": 0.0},
                        {"id": "a2", "assetId": "cam_b", "syncOffsetSeconds": 12.4},
                    ],
                }
            ],
        }
    )
    dumped = project.model_dump(by_alias=True)["angleGroups"][0]
    assert dumped["angles"][1]["syncOffsetSeconds"] == 12.4
    assert dumped["angles"][1]["assetId"] == "cam_b"


def test_project_capability_pack_pins_round_trip_under_camel_case() -> None:
    """Logical release pins survive TS/Python transport without becoming platform artifacts."""
    project = Project.model_validate(
        {
            "id": "p",
            "name": "P",
            "capabilityPacks": [
                {
                    "id": "framepilot.subject-intelligence",
                    "version": "1.2.0",
                    "releaseDigest": "a" * 64,
                    "capabilities": ["tracking.face", "tracking.segmentation"],
                    "requiredFor": "analysis",
                }
            ],
        }
    )
    pin = project.capability_packs[0] if project.capability_packs is not None else None
    assert pin is not None
    assert pin.required_for == "analysis"
    dumped = project.model_dump(by_alias=True)["capabilityPacks"][0]
    assert dumped["releaseDigest"] == "a" * 64
    assert "platform" not in dumped


def test_audio_role_rejects_an_unknown_role() -> None:
    with pytest.raises(ValidationError):
        Track.model_validate({"id": "a1", "type": "audio", "role": "narration", "clips": []})
