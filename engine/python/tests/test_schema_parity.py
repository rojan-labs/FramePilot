"""Cross-language schema parity (plan Phase 1.1).

The TS Zod schema (``packages/timeline-schema``) is the single source of truth.
It is exported to the committed ``schema/project.schema.json`` contract, and the
Python Pydantic models in :mod:`framepilot_engine.timeline.models` must mirror
it. These tests fail if a field is added, removed, or renamed on one side but not
the other — the way the two language schemas would otherwise silently drift.

Three things are compared, each closing a way the two sides drifted invisibly:

* field *names* (serialization aliases) on every model in the tree;
* *enum members*, for the closed vocabularies the two sides declare separately —
  a name-only comparison passes while one side gains a member the other cannot
  render;
* *nullability*, i.e. which fields the engine is entitled to emit as ``null``.
  The TS side types most optionals ``.optional()``, which accepts *absent* and
  REJECTS ``null``; only ``.nullish()`` fields accept both. That asymmetry is
  what let the writer emit 12 nulls the editor refused to open (see
  ``ProjectFile.save``), invisibly, for as long as only names were compared.

Value invariants (e.g. ``end > start``) are ``.refine()`` rules on the TS side
and are enforced by the patch validator, not the data-shape contract, so they are
intentionally absent from the JSON Schema and from these tests.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, cast

import pytest
from pydantic import BaseModel

from framepilot_engine.effects.keyframes import Easing
from framepilot_engine.render.effect_catalog import known_kinds
from framepilot_engine.timeline.models import (
    SCHEMA_VERSION,
    Angle,
    AngleGroup,
    Asset,
    AssetMedia,
    AssetSource,
    AudioRole,
    BezierHandles,
    BlendMode,
    CapabilityPackPin,
    CaptionAccent,
    CaptionAnimation,
    CaptionAnimationPhase,
    CaptionBackground,
    CaptionCue,
    CaptionCueSource,
    CaptionHighlight,
    CaptionShadow,
    CaptionStyle,
    Clip,
    CropRect,
    Effect,
    EffectLayer,
    Folder,
    Keyframe,
    Marker,
    Project,
    ProjectFile,
    Resolution,
    SpeedPoint,
    Timeline,
    Track,
    TrackType,
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

    # Asset.source (v20) is provenance the engine never reads, which is exactly why
    # it needs the guard: a mirror that quietly dropped a field would erase the only
    # durable record that a stock clip needs crediting, and no render would fail.
    assert _schema_property_names(_object_node(asset, "source")) == _model_field_names(AssetSource)

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

    # Markers are project-scoped and carry chapter titles; a dropped ``label`` would
    # turn every chapter back into an anonymous point without failing a render.
    assert _schema_property_names(
        _array_item_node(project_schema, "markers")
    ) == _model_field_names(Marker)


def test_timeline_descendant_fields_match(project_schema: dict[str, Any]) -> None:
    timeline = _object_node(project_schema, "timeline")
    track = _array_item_node(timeline, "tracks")
    assert _schema_property_names(track) == _model_field_names(Track)

    clip = _array_item_node(track, "clips")
    assert _schema_property_names(clip) == _model_field_names(Clip)

    effect = _array_item_node(clip, "effects")
    assert _schema_property_names(effect) == _model_field_names(Effect)

    # Keyframes appear on clips, on effects AND on effect layers; all three must
    # match the model.
    effect_layer = _array_item_node(track, "effectLayers")
    assert _schema_property_names(effect_layer) == _model_field_names(EffectLayer)
    for owner in (clip, effect, effect_layer):
        assert _schema_property_names(_array_item_node(owner, "keyframes")) == _model_field_names(
            Keyframe
        )

    # A keyframe's bezier handles (v14). ``in`` is a Python keyword, so the field is
    # ``in_`` with an alias — the comparison is against the alias, which is the only
    # name that reaches the file.
    handles = _object_node(_array_item_node(clip, "keyframes"), "handles")
    assert _schema_property_names(handles) == _model_field_names(BezierHandles)

    # Speed ramp (v15) and crop (v7): both are per-clip geometry/timing sub-objects
    # that change WHICH FRAME renders, so a silently dropped field is a wrong
    # picture rather than a crash.
    assert _schema_property_names(_array_item_node(clip, "speedRamp")) == _model_field_names(
        SpeedPoint
    )
    assert _schema_property_names(_object_node(clip, "crop")) == _model_field_names(CropRect)


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

        # The three animation phases are three DIFFERENT shapes on the TS side
        # (``in``/``out`` carry ``duration``, ``loop`` carries ``period``) and one
        # union model here. So the contract is: each phase is a subset of the
        # model, and together they account for every field of it — a model field
        # no phase declares is dead weight the renderer would read forever.
        animation = _object_node(style, "animation")
        phases = [_object_node(animation, key) for key in ("in", "out", "loop")]
        phase_fields = _model_field_names(CaptionAnimationPhase)
        for phase in phases:
            assert _schema_property_names(phase) <= phase_fields
        assert set().union(*(_schema_property_names(p) for p in phases)) == phase_fields


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
    # ``source`` (v12) is what lets a cue be REMAPPED after a later trim instead of
    # regenerated; without every field of it, a cue can only be thrown away.
    assert _schema_property_names(_object_node(cue, "source")) == _model_field_names(
        CaptionCueSource
    )


# --- Enum members -------------------------------------------------------------
#
# WHY this is separate from the name comparison: a closed vocabulary is declared
# twice — once as a Zod enum (exported into the JSON Schema's ``enum`` array) and
# once as a Python ``StrEnum`` or catalog. Names matching proves the FIELD exists;
# it says nothing about the VALUES. A member added on one side only is accepted by
# the editor and refused (or silently skipped) by the engine, or vice versa.


def _schema_enum(node: dict[str, Any]) -> set[str]:
    """The member set of a JSON Schema ``enum`` node (unwrapping nullable)."""
    unwrapped = _unwrap_nullable(node)
    members = unwrapped.get("enum")
    assert members is not None, f"expected an enum node, got {unwrapped.get('type')!r}"
    return set(cast(list[str], members))


def _enum_property(parent: dict[str, Any], key: str) -> set[str]:
    """The member set of the enum declared at ``parent.properties[key]``."""
    return _schema_enum(cast(dict[str, Any], parent["properties"][key]))


def test_enum_members_match(project_schema: dict[str, Any]) -> None:
    """Every closed vocabulary declared on both sides must have the SAME members."""
    timeline = _object_node(project_schema, "timeline")
    track = _array_item_node(timeline, "tracks")
    clip = _array_item_node(track, "clips")

    assert _enum_property(track, "type") == {member.value for member in TrackType}
    assert _enum_property(track, "role") == {member.value for member in AudioRole}
    assert _enum_property(clip, "blendMode") == {member.value for member in BlendMode}

    # ``easing`` is declared at four places in the contract and interpreted by ONE
    # Python enum; all four must agree with it, or a curve authored in the editor
    # silently falls back to linear at export.
    easing_members = {member.value for member in Easing}
    effect = _array_item_node(clip, "effects")
    effect_layer = _array_item_node(track, "effectLayers")
    for owner in (clip, effect, effect_layer):
        assert _enum_property(_array_item_node(owner, "keyframes"), "easing") == easing_members
    assert _enum_property(_array_item_node(clip, "speedRamp"), "easing") == easing_members


def test_effect_render_kinds_match_the_engine_catalog(project_schema: dict[str, Any]) -> None:
    """``EffectLayer.kind`` is a closed enum in TS and a bare ``str`` in Python.

    Python's counterpart is not an enum but the shipped catalog: ``known_kinds()``
    is every kind the render passes declare params for, and it is the ONLY dispatch
    key (ADR 0088). Nothing compared the two, so the Inspector could offer a kind
    the renderer had no pass for — which draws an untouched frame rather than
    raising, the quietest possible failure.
    """
    timeline = _object_node(project_schema, "timeline")
    track = _array_item_node(timeline, "tracks")
    effect_layer = _array_item_node(track, "effectLayers")
    assert _enum_property(effect_layer, "kind") == set(known_kinds())


# --- Nullability --------------------------------------------------------------


def _accepts_null(node: dict[str, Any]) -> bool:
    """Whether this JSON Schema node accepts an explicit ``null``.

    True only for a TS ``.nullish()`` field, which exports as an ``anyOf`` with a
    ``{"type": "null"}`` branch. A ``.optional()`` field exports without one: it
    accepts the key being ABSENT and rejects the key being present-and-null.
    """
    if node.get("type") == "null":
        return True
    return any(variant.get("type") == "null" for variant in node.get("anyOf", []))


def _assert_nulls_are_entitled(document: Any, node: dict[str, Any], path: str) -> None:
    """Recursively assert every ``null`` in ``document`` sits where TS accepts one."""
    if isinstance(document, dict):
        properties = cast(dict[str, Any], node.get("properties", {}))
        for key, value in document.items():
            prop = properties.get(key)
            if prop is None:
                # Undeclared keys are the field-NAME tests' business, not this one.
                continue
            where = f"{path}.{key}"
            if value is None:
                assert _accepts_null(prop), (
                    f"{where} is emitted as null, but the TS schema types it "
                    ".optional() — which accepts an ABSENT key and rejects null. "
                    "The editor refuses to open a project containing it."
                )
                continue
            _assert_nulls_are_entitled(value, _unwrap_nullable(prop), where)
    elif isinstance(document, list):
        items = cast(dict[str, Any] | None, node.get("items"))
        if items is None:
            return
        item_node = _unwrap_nullable(items)
        for index, value in enumerate(document):
            _assert_nulls_are_entitled(value, item_node, f"{path}[{index}]")


def _fully_nested_project() -> Project:
    """A project that reaches every nested model, with every scalar optional UNSET.

    Both halves matter. The nested objects are present so the walk actually visits
    each sub-schema; their own optional leaves are left unset so the serializer's
    absent-vs-null decision is exercised at every depth — which is precisely the
    combination the writer got wrong.
    """
    word = TranscriptWord(word="hello", start=0.0, end=0.5)
    keyframe = Keyframe(
        id="kf-1",
        time=0.0,
        property="opacity",
        value=1.0,
        handles=BezierHandles(out=(0.25, 0.1), **{"in": (0.75, 0.9)}),
    )
    clip = Clip(
        id="c1",
        asset_id="a1",
        track_id="t1",
        start=0.0,
        end=2.0,
        effects=[Effect(id="fx-1", type="transform", keyframes=[keyframe])],
        keyframes=[keyframe],
        captionStyle=CaptionStyle(
            background=CaptionBackground(color="#000000"),
            shadow=CaptionShadow(color="#000000", blur=0.1, offset_x=0.0, offset_y=0.0),
            highlight=CaptionHighlight(),
            animation=CaptionAnimation(
                **{"in": CaptionAnimationPhase(type="fade", duration=0.2)},
                out=CaptionAnimationPhase(type="fade", duration=0.2),
                loop=CaptionAnimationPhase(type="pulse", period=0.5),
            ),
            accent=CaptionAccent(mode="last-word"),
        ),
        captionCue=CaptionCue(
            text="hello",
            words=[word],
            source=CaptionCueSource(asset_id="a1", clip_id="c1", start=0.0, end=2.0),
        ),
        speedRamp=[SpeedPoint(id="sp-1", source_time=0.0, rate=1.0)],
        crop=CropRect(),
    )
    return Project(
        id="p1",
        name="parity",
        assets=[
            Asset(
                id="a1",
                path="a.mp4",
                media=AssetMedia(),
                source=AssetSource(
                    provider="pexels",
                    remote_id="1",
                    license="pexels",
                    attribution_required=False,
                    fetched_at="2026-01-01T00:00:00Z",
                ),
            )
        ],
        folders=[Folder(id="f1", name="Bin")],
        timeline=Timeline(
            tracks=[
                Track(id="t1", type=TrackType.VIDEO, clips=[clip]),
                Track(
                    id="t2",
                    type=TrackType.EFFECT,
                    effectLayers=[
                        EffectLayer(
                            id="el-1",
                            effect_id="gaussian-blur",
                            kind="blur-gaussian",
                            start=0.0,
                            end=1.0,
                            keyframes=[keyframe],
                        )
                    ],
                ),
            ]
        ),
        transcript=[word],
        markers=[Marker(id="m1", time=1.0)],
        angleGroups=[AngleGroup(id="g1", angles=[Angle(id="an1", asset_id="a1")])],
        capabilityPacks=[
            CapabilityPackPin(
                id="tracking-lite",
                version="1.0.0",
                release_digest="sha256:0",
                capabilities=["track"],
                required_for="edit",
            )
        ],
    )


def test_writer_emits_no_null_the_ts_schema_rejects(
    project_schema: dict[str, Any], tmp_path: Path
) -> None:
    """The engine's own writer must never produce a project the editor cannot open.

    This is the guard the field-NAME comparison could not be: it walks the actual
    serialized document against the contract and fails on any ``null`` at a path the
    TS side types ``.optional()``. It fails against the pre-``exclude_none`` writer,
    which emitted twelve of them.
    """
    destination = tmp_path / "project.fp.json"
    ProjectFile.save(_fully_nested_project(), destination)
    document = cast(dict[str, Any], json.loads(destination.read_text(encoding="utf-8")))
    _assert_nulls_are_entitled(document, project_schema, "project")


def test_the_written_project_round_trips_back_through_the_engine(tmp_path: Path) -> None:
    """Dropping every ``null`` must stay lossless in the OTHER direction too.

    ``.nullish()`` fields accept an absent key as well, so omitting nulls is safe —
    but only as long as every Python field that could hold ``None`` also defaults to
    ``None``. This reloads what the writer produced and compares models.
    """
    destination = tmp_path / "project.fp.json"
    original = _fully_nested_project()
    ProjectFile.save(original, destination)
    assert ProjectFile.load(destination) == original
