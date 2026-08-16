"""Cross-language schema parity (plan Phase 1.1).

The TS Zod schema (``packages/timeline-schema``) is the single source of truth.
It is exported to the committed ``schema/project.schema.json`` contract, and the
Python Pydantic models in :mod:`framepilot_engine.timeline.models` must mirror
it. These tests fail if a field is added, removed, or renamed on one side but not
the other — the way the two language schemas would otherwise silently drift.

Only field *names* (serialization aliases) are compared, not types/optionality:
that is the contract-level guard. Value invariants (e.g. ``end > start``) are
``.refine()`` rules on the TS side and are enforced by the patch validator, not
the data-shape contract, so they are intentionally absent from the JSON Schema.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, cast

import pytest
from pydantic import BaseModel

from framepilot_engine.timeline.models import (
    SCHEMA_VERSION,
    Angle,
    AngleGroup,
    Asset,
    AssetMedia,
    CapabilityPackPin,
    CaptionAccent,
    CaptionAnimation,
    CaptionBackground,
    CaptionCue,
    CaptionHighlight,
    CaptionShadow,
    CaptionStyle,
    Clip,
    Effect,
    Folder,
    Keyframe,
    Project,
    Resolution,
    Timeline,
    Track,
    TranscriptWord,
)

# tests → python → engine → repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCHEMA_PATH = _REPO_ROOT / "packages" / "timeline-schema" / "schema" / "project.schema.json"
_TS_SCHEMA_INDEX = _REPO_ROOT / "packages" / "timeline-schema" / "src" / "index.ts"


def _ts_schema_version() -> int:
    """The ``SCHEMA_VERSION`` constant declared in the TS source of truth.

    Read straight from ``index.ts`` (not a build artifact) so the parity guard
    has no dependency on the package being built.
    """
    source = _TS_SCHEMA_INDEX.read_text(encoding="utf-8")
    match = re.search(r"SCHEMA_VERSION\s*=\s*(\d+)", source)
    assert match is not None, f"Could not find SCHEMA_VERSION in {_TS_SCHEMA_INDEX}"
    return int(match.group(1))


@pytest.fixture(scope="module")
def project_schema() -> dict[str, Any]:
    """The committed JSON Schema contract exported from the TS Zod source of truth."""
    return cast(dict[str, Any], json.loads(_SCHEMA_PATH.read_text(encoding="utf-8")))


def _schema_property_names(node: dict[str, Any]) -> set[str]:
    """Property names declared on a JSON Schema ``object`` node."""
    return set(node.get("properties", {}))


def _model_field_names(model: type[BaseModel]) -> set[str]:
    """Serialization names (alias when set, else field name) of a Pydantic model."""
    return {info.alias or name for name, info in model.model_fields.items()}


def _unwrap_nullable(node: dict[str, Any]) -> dict[str, Any]:
    """Unwrap a nullable ``anyOf: [<schema>, {type: null}]`` to its non-null branch.

    A `.nullish()` field (e.g. ``Asset.media`` — the engine serializes an absent
    value as ``null``, matching Pydantic ``| None``) is emitted as an ``anyOf`` of
    the real schema plus a null type. Parity is checked against the real schema.
    """
    variants = node.get("anyOf")
    if not variants:
        return node
    non_null = [v for v in variants if v.get("type") != "null"]
    return cast(dict[str, Any], non_null[0]) if non_null else node


def _object_node(parent: dict[str, Any], key: str) -> dict[str, Any]:
    """The object schema at ``parent.properties[key]`` (unwrapping nullable)."""
    return _unwrap_nullable(cast(dict[str, Any], parent["properties"][key]))


def _array_item_node(parent: dict[str, Any], key: str) -> dict[str, Any]:
    """The item object schema at ``parent.properties[key].items`` (an array)."""
    return cast(dict[str, Any], parent["properties"][key]["items"])


def test_schema_file_exists() -> None:
    assert _SCHEMA_PATH.is_file(), (
        f"Missing {_SCHEMA_PATH}. Run "
        "`pnpm --filter @framepilot/timeline-schema build && "
        "pnpm --filter @framepilot/timeline-schema schema:generate`."
    )


def test_schema_version_matches_ts() -> None:
    """The engine's envelope version MUST equal the TS source of truth.

    These two constants gate which ``project.fp.json`` files the engine accepts.
    If they drift (e.g. TS bumps to v4 for new Track flags but the engine still
    declares v3), every render/export of a freshly saved project fails with
    "schemaVersion N, but this engine supports up to N-1". The field-name parity
    tests below do NOT catch this, so this guard pins them together.
    """
    assert _ts_schema_version() == SCHEMA_VERSION


def test_project_fields_match(project_schema: dict[str, Any]) -> None:
    assert _schema_property_names(project_schema) == _model_field_names(Project)


def test_nested_object_fields_match(project_schema: dict[str, Any]) -> None:
    resolution = _object_node(project_schema, "resolution")
    assert _schema_property_names(resolution) == _model_field_names(Resolution)

    asset = _array_item_node(project_schema, "assets")
    assert _schema_property_names(asset) == _model_field_names(Asset)

    # Asset.media is a nested optional object — its fields must match too.
    asset_media = _object_node(asset, "media")
    assert _schema_property_names(asset_media) == _model_field_names(AssetMedia)

    folder = _array_item_node(project_schema, "folders")
    assert _schema_property_names(folder) == _model_field_names(Folder)

    transcript_word = _array_item_node(project_schema, "transcript")
    assert _schema_property_names(transcript_word) == _model_field_names(TranscriptWord)

    timeline = _object_node(project_schema, "timeline")
    assert _schema_property_names(timeline) == _model_field_names(Timeline)

    # Multicam (v18). The nested angle is checked as well as the group: the sync
    # offset is the field that decides WHICH FRAME a switch lands on, so a mirror
    # that silently dropped it would cut to the wrong moment rather than fail.
    angle_group = _array_item_node(project_schema, "angleGroups")
    assert _schema_property_names(angle_group) == _model_field_names(AngleGroup)
    assert _schema_property_names(_array_item_node(angle_group, "angles")) == _model_field_names(
        Angle
    )

    capability_pack = _array_item_node(project_schema, "capabilityPacks")
    assert _schema_property_names(capability_pack) == _model_field_names(CapabilityPackPin)


def test_timeline_descendant_fields_match(project_schema: dict[str, Any]) -> None:
    timeline = _object_node(project_schema, "timeline")
    track = _array_item_node(timeline, "tracks")
    assert _schema_property_names(track) == _model_field_names(Track)

    clip = _array_item_node(track, "clips")
    assert _schema_property_names(clip) == _model_field_names(Clip)

    effect = _array_item_node(clip, "effects")
    assert _schema_property_names(effect) == _model_field_names(Effect)

    # Keyframes appear both on clips and on effects; both must match the model.
    assert _schema_property_names(_array_item_node(clip, "keyframes")) == _model_field_names(
        Keyframe
    )
    assert _schema_property_names(_array_item_node(effect, "keyframes")) == _model_field_names(
        Keyframe
    )


def test_caption_style_fields_match(project_schema: dict[str, Any]) -> None:
    """The caption style tree must match field-for-field, at every nesting level.

    WHY the nested sub-objects are checked individually rather than just the
    top-level ``captionStyle``: ``accent.keywords`` (schema v11) is a leaf added
    two levels down. A top-level-only comparison would have passed while the
    renderer silently ignored a persisted keyword list — precisely the
    "``accent.mode: 'keywords'`` selects nothing" dead end v11 exists to fix.
    """
    timeline = _object_node(project_schema, "timeline")
    track = _array_item_node(timeline, "tracks")
    clip = _array_item_node(track, "clips")

    # captionStyle now hangs off BOTH the clip (per-cue override) and the track
    # (the set-wide default, v11) — the same shape in both places.
    for parent in (clip, track):
        style = _object_node(parent, "captionStyle")
        assert _schema_property_names(style) == _model_field_names(CaptionStyle)
        assert _schema_property_names(_object_node(style, "background")) == _model_field_names(
            CaptionBackground
        )
        assert _schema_property_names(_object_node(style, "shadow")) == _model_field_names(
            CaptionShadow
        )
        assert _schema_property_names(_object_node(style, "highlight")) == _model_field_names(
            CaptionHighlight
        )
        assert _schema_property_names(_object_node(style, "animation")) == _model_field_names(
            CaptionAnimation
        )
        assert _schema_property_names(_object_node(style, "accent")) == _model_field_names(
            CaptionAccent
        )


def test_caption_cue_fields_match(project_schema: dict[str, Any]) -> None:
    """A caption clip's own cue (schema v11) must mirror the TS contract."""
    timeline = _object_node(project_schema, "timeline")
    track = _array_item_node(timeline, "tracks")
    clip = _array_item_node(track, "clips")

    cue = _object_node(clip, "captionCue")
    assert _schema_property_names(cue) == _model_field_names(CaptionCue)
    # A cue's words are the same TranscriptWord shape as the project transcript's
    # — deliberately, so a cue can be built from the transcript and vice versa.
    assert _schema_property_names(_array_item_node(cue, "words")) == _model_field_names(
        TranscriptWord
    )
