"""Tests for the AI tool layer (PRD §8.3, §18.2, plan Phase 4).

Covers, to 100%: every tool's derived schema validity; dispatch rejecting
unknown/unavailable tools and invalid args (missing required / extra field /
wrong type); every mutating handler producing operations that pass
``validate_patch`` on a fixture project; read tools returning expected data; and
action tools validating without a handler.
"""

from __future__ import annotations

import json

import pytest
from pydantic import TypeAdapter, ValidationError

from framepilot_engine.ai_tools import (
    Selection,
    ToolContext,
    ToolInputError,
    ToolResult,
    ToolSemanticError,
    ToolUnavailableError,
    UnknownToolError,
    get_tool,
    run_tool,
)
from framepilot_engine.ai_tools.handlers import _derive_id
from framepilot_engine.ai_tools.registry import TOOL_REGISTRY, NoArgs, ToolSpec
from framepilot_engine.timeline.models import (
    Asset,
    AssetMedia,
    AssetSource,
    Clip,
    Folder,
    Project,
    Timeline,
    Track,
    TrackType,
    TranscriptWord,
)
from framepilot_engine.timeline.operations import Operation
from framepilot_engine.validation.patch_validation import validate_patch

_OPERATION_ADAPTER: TypeAdapter[Operation] = TypeAdapter(Operation)

# Expected (available, mutating) flags per tool — the contract mirrored from TS.
_EXPECTED_FLAGS: dict[str, tuple[bool, bool]] = {
    "get_project_state": (True, False),
    "get_timeline": (True, False),
    "get_transcript": (True, False),
    # Timing + verification (ADR 0076).
    "get_timeline_map": (True, False),
    "map_time": (True, False),
    "get_mapped_transcript": (True, False),
    "list_edit_boundaries": (True, False),
    "verify_captions": (True, False),
    "verify_transitions": (True, False),
    "get_timeline_summary": (True, False),
    "get_clips": (True, False),
    "get_clip": (True, False),
    "get_selected_range": (True, False),
    "recall_evidence": (True, False),
    "load_skill": (True, False),
    "list_assets": (True, False),
    "discover_caption_styles": (True, False),
    "trim_clip": (True, True),
    "split_clip": (True, True),
    "delete_range": (True, True),
    "ripple_delete": (True, True),
    "delete_clip": (True, True),
    "delete_clips": (True, True),
    "move_clip": (True, True),
    "add_track": (True, True),
    "remove_track": (True, True),
    "move_track": (True, True),
    "add_clip": (True, True),
    "add_text_layer": (True, True),
    "add_caption_layer": (True, True),
    "add_keyframes": (True, True),
    "punch_in": (True, True),
    "apply_color_grade": (True, True),
    "adjust_audio": (True, True),
    # Effect layers (schema v13, ADR 0088). `discover_effects` reads the shipped
    # catalog, so it is available but non-mutating.
    "discover_effects": (True, False),
    "discover_transitions": (True, False),
    "apply_effect": (True, True),
    "move_effect": (True, True),
    "resize_effect": (True, True),
    "adjust_effect": (True, True),
    "set_effect_enabled": (True, True),
    "remove_effect": (True, True),
    "add_transition": (True, True),
    "add_mask": (True, True),
    "track_object": (True, True),
    "set_track_flags": (True, True),
    "set_track_caption_style": (True, True),
    "auto_emphasize_captions": (True, True),
    "set_caption_style": (True, True),
    "set_clip_speed": (True, True),
    "set_clip_crop": (True, True),
    "set_clip_blend_mode": (True, True),
    "add_asset": (True, True),
    "manage_assets": (True, True),
    "add_marker": (True, True),
    "remove_marker": (True, True),
    "transcribe": (True, False),
    "render_preview": (True, False),
    "export_video": (True, False),
    "analyze_silence": (True, False),
    "detect_scenes": (True, False),
    "get_frame": (True, False),
    "detect_beats": (True, False),
    "search_media": (True, False),
    "find_similar": (True, False),
    "search_visual": (True, False),
    "describe_footage": (True, False),
    "index_media": (True, False),
    "map_footage": (True, False),
    "read_edit_signals": (True, False),
    "session_context": (True, False),
    "generate_mask": (False, True),
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _clip(cid: str, track: str, start: float, end: float) -> Clip:
    return Clip.model_validate(
        {
            "id": cid,
            "assetId": "asset_001",
            "trackId": track,
            "start": start,
            "end": end,
            "sourceStart": 0.0,
            "sourceEnd": end - start,
        }
    )


@pytest.fixture
def project() -> Project:
    """A small multi-track project covering every track type used by handlers."""
    timeline = Timeline(
        tracks=[
            Track(
                id="v",
                type=TrackType.VIDEO,
                clips=[_clip("A", "v", 0, 4), _clip("B", "v", 5, 9)],
            ),
            Track(id="a", type=TrackType.AUDIO, clips=[_clip("AU", "a", 0, 4)]),
            Track(id="ov", type=TrackType.OVERLAY, clips=[]),
            Track(id="cap", type=TrackType.CAPTION, clips=[]),
        ]
    )
    return Project(
        id="project_001",
        name="Demo",
        timeline=timeline,
        transcript=[TranscriptWord(word="hello", start=0.0, end=0.5)],
    )


@pytest.fixture
def ctx(project: Project) -> ToolContext:
    return ToolContext(project=project, selection=Selection(start=1.0, end=2.0))


def _assert_patch_ok(result: ToolResult, project: Project) -> None:
    """Parse a mutating result's operations and assert they pass validation."""
    assert result.operations is not None
    ops = [_OPERATION_ADAPTER.validate_python(op) for op in result.operations]
    outcome = validate_patch(project.timeline, ops, asset_ids={"asset_001"})
    assert outcome.valid, outcome.issues


# ---------------------------------------------------------------------------
# Registry / schema validity
# ---------------------------------------------------------------------------


def test_registry_keys_match_spec_names_and_schema_is_object() -> None:
    for name, spec in TOOL_REGISTRY.items():
        assert isinstance(spec, ToolSpec)
        assert spec.name == name
        # Schema is derived from the input model and is a JSON-Schema object.
        assert spec.input_schema == spec.input_model.model_json_schema(by_alias=True)
        assert spec.input_schema.get("type") == "object"


def test_available_and_mutating_flags_match_contract() -> None:
    assert set(TOOL_REGISTRY) == set(_EXPECTED_FLAGS)
    for name, (available, mutating) in _EXPECTED_FLAGS.items():
        spec = TOOL_REGISTRY[name]
        assert spec.available is available, name
        assert spec.mutating is mutating, name


def test_unavailable_tools_are_exactly_the_engine_tbd_set() -> None:
    unavailable = {name for name, s in TOOL_REGISTRY.items() if not s.available}
    assert unavailable == {"generate_mask"}


def test_analysis_tools_are_available_non_mutating() -> None:
    for name in ("analyze_silence", "detect_scenes"):
        spec = TOOL_REGISTRY[name]
        assert spec.kind == "analysis"
        assert spec.available is True
        assert spec.mutating is False


def test_strict_models_forbid_extra_fields() -> None:
    # Every input model is the security boundary: unknown args are rejected.
    for spec in TOOL_REGISTRY.values():
        assert spec.input_model.model_config.get("extra") == "forbid"


def test_get_tool_lookup() -> None:
    assert get_tool("trim_clip") is TOOL_REGISTRY["trim_clip"]
    assert get_tool("does_not_exist") is None


def test_noargs_rejects_any_field() -> None:
    with pytest.raises(ValidationError):
        NoArgs.model_validate({"unexpected": 1})


# ---------------------------------------------------------------------------
# Dispatch guard rails
# ---------------------------------------------------------------------------


def test_unknown_tool_raises(ctx: ToolContext) -> None:
    with pytest.raises(UnknownToolError) as exc:
        run_tool("frobnicate", {}, ctx)
    assert exc.value.name == "frobnicate"


def test_unavailable_tool_raises(ctx: ToolContext) -> None:
    for name in ("generate_mask",):
        with pytest.raises(ToolUnavailableError) as exc:
            run_tool(name, {}, ctx)
        assert exc.value.name == name


def test_analysis_tools_validate_args_and_return_kind(ctx: ToolContext) -> None:
    # analyze_silence / detect_scenes validate their (all-optional) args here but
    # carry no in-process handler: the host runs ffmpeg via the sidecar and returns
    # the data. run_tool returns kind='analysis' with neither operations nor data.
    for name in ("analyze_silence", "detect_scenes"):
        result = run_tool(name, {}, ctx)
        assert result.kind == "analysis"
        assert result.operations is None and result.data is None
    result = run_tool("analyze_silence", {"assetId": "AU", "minSilenceSeconds": 1.0}, ctx)
    assert result.kind == "analysis"
    result = run_tool("detect_scenes", {"threshold": 0.6}, ctx)
    assert result.kind == "analysis"


def test_analysis_tools_reject_bad_args(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("analyze_silence", {"nope": 1}, ctx)  # extra field
    with pytest.raises(ToolInputError):
        run_tool("detect_scenes", {"threshold": 5.0}, ctx)  # out of [0, 1]


def test_missing_required_arg_raises(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError) as exc:
        run_tool("trim_clip", {"clipId": "A", "start": 1.0}, ctx)  # no ``end``
    assert exc.value.name == "trim_clip"
    assert exc.value.validation_error is not None


def test_extra_field_rejected(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("trim_clip", {"clipId": "A", "start": 1.0, "end": 3.0, "evil": True}, ctx)


def test_wrong_type_rejected(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("trim_clip", {"clipId": "A", "start": "soon", "end": 3.0}, ctx)


def test_negative_seconds_rejected_by_schema(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("trim_clip", {"clipId": "A", "start": -1.0, "end": 3.0}, ctx)


def test_action_tools_validate_without_handler(ctx: ToolContext) -> None:
    for name in ("render_preview", "export_video"):
        result = run_tool(name, {}, ctx)
        assert result.kind == "action"
        assert result.operations is None and result.data is None
    with pytest.raises(ToolInputError):
        run_tool("render_preview", {"oops": 1}, ctx)


# ---------------------------------------------------------------------------
# Read tools
# ---------------------------------------------------------------------------


def test_get_project_state(ctx: ToolContext, project: Project) -> None:
    result = run_tool("get_project_state", {}, ctx)
    assert result.kind == "read"
    expected = project.model_dump(by_alias=True)
    expected["history"] = []
    expected["assets"] = [{k: v for k, v in a.items() if k != "media"} for a in expected["assets"]]
    assert result.data == expected


def test_get_timeline(ctx: ToolContext, project: Project) -> None:
    result = run_tool("get_timeline", {}, ctx)
    assert result.data == project.timeline.model_dump(by_alias=True)


def test_get_transcript(ctx: ToolContext) -> None:
    result = run_tool("get_transcript", {}, ctx)
    # v12 adds assetId/confidence/speaker; absent values serialize as null, which
    # is the cross-language contract the TS schema accepts via `.nullish()`.
    assert result.data == [
        {
            "word": "hello",
            "start": 0.0,
            "end": 0.5,
            "assetId": None,
            "confidence": None,
            "speaker": None,
        }
    ]


def test_get_selected_range_present(ctx: ToolContext) -> None:
    result = run_tool("get_selected_range", {}, ctx)
    assert result.data == {"start": 1.0, "end": 2.0}


def test_get_selected_range_absent(project: Project) -> None:
    ctx = ToolContext(project=project)
    result = run_tool("get_selected_range", {}, ctx)
    assert result.data is None


def test_load_skill_returns_bundled_body(ctx: ToolContext) -> None:
    # The generated bundle (packages/ai-sdk/skills/*.md) always ships at least one
    # skill; a known name returns the full playbook (ADR 0057).
    from framepilot_engine.ai_tools.skills_generated import SKILLS

    assert SKILLS, "bundled skills must not be empty"
    name = SKILLS[0]["name"]
    result = run_tool("load_skill", {"name": name}, ctx)
    assert result.kind == "read"
    assert result.data["name"] == name
    assert result.data["body"]


def test_load_skill_unknown_name_lists_available(ctx: ToolContext) -> None:
    result = run_tool("load_skill", {"name": "no-such-skill"}, ctx)
    assert "Unknown skill" in result.data["error"]
    assert isinstance(result.data["available"], list) and result.data["available"]


@pytest.fixture
def binned_ctx(project: Project) -> ToolContext:
    """A context whose project has a populated, foldered media bin."""
    project.folders = [Folder(id="folder_broll", name="B-roll")]
    project.assets = [
        Asset(id="asset_v", path="media/v.mp4", kind="video", folderId="folder_broll"),
        Asset(id="asset_a", path="media/a.wav", kind="audio"),
        Asset(id="asset_i", path="media/i.png", kind="image", folderId="folder_broll"),
    ]
    return ToolContext(project=project)


def test_list_assets_returns_bin(binned_ctx: ToolContext) -> None:
    result = run_tool("list_assets", {}, binned_ctx)
    assert result.kind == "read"
    assert [a["id"] for a in result.data["assets"]] == ["asset_v", "asset_a", "asset_i"]
    assert [f["id"] for f in result.data["folders"]] == ["folder_broll"]


def test_list_assets_filters_by_kind(binned_ctx: ToolContext) -> None:
    result = run_tool("list_assets", {"kind": "audio"}, binned_ctx)
    assert [a["id"] for a in result.data["assets"]] == ["asset_a"]
    # Folders are always returned in full for organizational context.
    assert [f["id"] for f in result.data["folders"]] == ["folder_broll"]


def test_list_assets_filters_by_folder(binned_ctx: ToolContext) -> None:
    result = run_tool("list_assets", {"folderId": "folder_broll"}, binned_ctx)
    assert [a["id"] for a in result.data["assets"]] == ["asset_v", "asset_i"]


def test_blank_selector_means_not_provided(binned_ctx: ToolContext) -> None:
    """A model that sends ``folderId: ""`` asked for the whole bin, not for nothing.

    The observed failure: ``{"kind": "video", "folderId": ""}`` filtered for a folder no
    asset can belong to, so a full media bin read as empty and the agent asked the user
    to import footage that was already imported. Mirrors the TS ``filterString``.
    """
    blank = run_tool("list_assets", {"folderId": ""}, binned_ctx)
    assert [a["id"] for a in blank.data["assets"]] == ["asset_v", "asset_a", "asset_i"]

    with_kind = run_tool("list_assets", {"kind": "video", "folderId": "  "}, binned_ctx)
    assert [a["id"] for a in with_kind.data["assets"]] == ["asset_v"]

    padded = run_tool("list_assets", {"folderId": " folder_broll "}, binned_ctx)
    assert [a["id"] for a in padded.data["assets"]] == ["asset_v", "asset_i"]

    # Same tolerance on the other selector-shaped reads.
    assert run_tool("discover_caption_styles", {"query": ""}, binned_ctx).data["templates"]


def test_list_assets_flags_a_filter_that_matched_nothing(binned_ctx: ToolContext) -> None:
    """An empty *filtered* result must not read as an empty project (mirrors the TS tool)."""
    binned_ctx.project.assets = [
        Asset(id="asset_a", path="media/song.mp3", kind="audio"),
        Asset(id="asset_i", path="media/still.jpg", kind="image"),
    ]
    result = run_tool("list_assets", {"kind": "video"}, binned_ctx)
    assert result.data["assets"] == []
    assert "NOT empty" in result.data["note"]
    assert "2 asset(s)" in result.data["note"]
    assert "1 audio, 1 image" in result.data["note"]

    binned_ctx.project.assets = []
    assert "note" not in run_tool("list_assets", {}, binned_ctx).data


def test_asset_reads_strip_engine_derived_render_media(project: Project) -> None:
    """Waveform peaks/thumbnails/proxy never reach the model (mirrors model-view.ts).

    A minute of audio is hundreds of peak floats and a real bin is tens of thousands —
    pure render data that used to crowd the asset ids out of the model's view of the
    result.
    """
    project.assets = [
        Asset(
            id="asset_v",
            path="media/v.mp4",
            kind="video",
            durationSeconds=58.0,
            media=AssetMedia(
                proxyPath=".framepilot-derived/e1/proxy.mp4",
                peaks=[0.0089, 0.0158, 0.0259],
                peaksPerSecond=60.0,
                thumbnailPaths=[".framepilot-derived/e1/t0.jpg"],
            ),
        )
    ]
    ctx = ToolContext(project=project)

    listed = run_tool("list_assets", {}, ctx).data["assets"]
    assert listed == [
        {
            "id": "asset_v",
            "path": "media/v.mp4",
            "kind": "video",
            "durationSeconds": 58.0,
            "folderId": None,
        }
    ]
    state = run_tool("get_project_state", {}, ctx).data
    assert state["assets"] == listed
    assert state["history"] == []
    # The stored project keeps its media — only the model-facing copy drops it.
    assert project.assets[0].media is not None
    assert "peaks" not in json.dumps(state)


def test_asset_reads_collapse_provenance_to_the_one_actionable_bit(project: Project) -> None:
    """The model learns a credit is owed; it does not get eight fields of licence metadata.

    Mirrors ``toModelAsset`` in ``packages/ai-sdk/src/model-view.ts``. Licence URLs,
    creator URLs and fetch timestamps are not reasoning material — the model never
    opens a licence page — but "this track obliges a credit" is something it can say
    out loud in a summary.
    """
    project.assets = [
        Asset(
            id="asset_credit",
            path="media/bed.mp3",
            kind="audio",
            source=AssetSource(
                provider="openverse",
                remote_id="ov-1",
                license="cc-by",
                license_url="https://creativecommons.org/licenses/by/4.0/",
                attribution_required=True,
                attribution='"Bed" by Ada is licensed under CC BY 4.0.',
                creator="Ada",
                fetched_at="2026-08-23T12:00:00.000Z",
            ),
        ),
        Asset(
            id="asset_cc0",
            path="media/sting.mp3",
            kind="audio",
            source=AssetSource(
                provider="openverse",
                remote_id="ov-2",
                license="cc0",
                attribution_required=False,
                fetched_at="2026-08-23T12:00:00.000Z",
            ),
        ),
        Asset(id="asset_imported", path="media/cam.mp4", kind="video"),
    ]
    ctx = ToolContext(project=project)

    listed = run_tool("list_assets", {}, ctx).data["assets"]
    assert listed[0]["attributionRequired"] is True
    # Absent means "nothing to credit", never "unknown" — a CC0 track and a file the
    # user dragged in are both genuinely free of obligation, so neither is flagged.
    assert "attributionRequired" not in listed[1]
    assert "attributionRequired" not in listed[2]
    assert "source" not in json.dumps(listed)
    assert "creativecommons.org" not in json.dumps(listed)
    # The stored project keeps the full record — only the model-facing copy collapses it.
    assert project.assets[0].source is not None
    assert project.assets[0].source.attribution is not None


def test_list_assets_rejects_bad_args(binned_ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("list_assets", {"kind": "gif"}, binned_ctx)  # not a valid kind
    with pytest.raises(ToolInputError):
        run_tool("list_assets", {"nope": 1}, binned_ctx)  # extra field


# ---------------------------------------------------------------------------
# Mutating handlers — operations parse and pass validate_patch
# ---------------------------------------------------------------------------


def test_trim_clip(ctx: ToolContext, project: Project) -> None:
    result = run_tool("trim_clip", {"clipId": "A", "start": 1.0, "end": 3.0}, ctx)
    assert result.operations == [{"type": "trim_clip", "clipId": "A", "start": 1.0, "end": 3.0}]
    _assert_patch_ok(result, project)


def test_split_clip(ctx: ToolContext, project: Project) -> None:
    result = run_tool("split_clip", {"clipId": "A", "at": 2.0}, ctx)
    _assert_patch_ok(result, project)


def test_delete_range(ctx: ToolContext, project: Project) -> None:
    result = run_tool("delete_range", {"trackId": "v", "start": 1.0, "end": 2.0}, ctx)
    _assert_patch_ok(result, project)


def test_ripple_delete(ctx: ToolContext, project: Project) -> None:
    result = run_tool("ripple_delete", {"trackId": "v", "start": 1.0, "end": 2.0}, ctx)
    _assert_patch_ok(result, project)


def test_move_clip(ctx: ToolContext, project: Project) -> None:
    result = run_tool("move_clip", {"clipId": "B", "toTrackId": "v", "toStart": 4.0}, ctx)
    _assert_patch_ok(result, project)


def test_add_clip(ctx: ToolContext, project: Project) -> None:
    result = run_tool(
        "add_clip",
        {
            "trackId": "v",
            "assetId": "asset_001",
            "start": 10.0,
            "end": 10.46,
            # A legacy caller may still send the image asset's default 5s display
            # duration. The handler must derive the 1x source span from timeline time.
            "sourceEnd": 5.0,
        },
        ctx,
    )
    _assert_patch_ok(result, project)
    assert result.operations is not None
    assert result.operations[0]["sourceStart"] == 0.0
    assert result.operations[0]["sourceEnd"] == pytest.approx(0.46)


# NOTE: the layer ops (add_layer/remove_layer/move_layer) are applied by the TS host
# (editor-core), not the render engine, so — exactly like the set_caption_style /
# set_clip_* styling ops above — they are mirrored as a tool + handler here but are not
# part of the Python `Operation` union. These tests therefore assert the emitted op dict
# (the handler's contract) rather than running _assert_patch_ok, which would try to parse
# an op the sidecar deliberately does not apply.
def test_add_track_defaults_to_overlay_layer_in_front(ctx: ToolContext) -> None:
    # The fixture has four tracks (v, a, ov, cap), so the deterministic id is layer_<role>_5.
    result = run_tool("add_track", {}, ctx)
    assert result.operations == [
        {"type": "add_layer", "layerId": "layer_overlay_5", "layerType": "overlay", "atIndex": 0}
    ]


def test_add_track_honours_explicit_type_index_and_id(ctx: ToolContext) -> None:
    result = run_tool("add_track", {"type": "audio", "atIndex": 2, "id": "music_bed"}, ctx)
    assert result.operations == [
        {"type": "add_layer", "layerId": "music_bed", "layerType": "audio", "atIndex": 2}
    ]


def test_add_track_skips_a_generated_id_that_already_exists() -> None:
    # One track → the first candidate is layer_overlay_2; occupy it so the id
    # generator must increment past the collision to layer_overlay_3.
    project = Project(
        id="p",
        name="Collision",
        timeline=Timeline(tracks=[Track(id="layer_overlay_2", type=TrackType.OVERLAY, clips=[])]),
        transcript=[],
    )
    result = run_tool("add_track", {}, ToolContext(project=project))
    assert result.operations == [
        {"type": "add_layer", "layerId": "layer_overlay_3", "layerType": "overlay", "atIndex": 0}
    ]


def test_add_track_rejects_unknown_role_and_negative_index(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("add_track", {"type": "sticker"}, ctx)
    with pytest.raises(ToolInputError):
        run_tool("add_track", {"atIndex": -1}, ctx)


def test_add_text_layer_maps_to_overlay_op(ctx: ToolContext, project: Project) -> None:
    result = run_tool(
        "add_text_layer", {"trackId": "ov", "text": "Hi", "start": 0.0, "end": 2.0}, ctx
    )
    assert result.operations is not None
    assert result.operations[0]["type"] == "add_text_overlay"
    _assert_patch_ok(result, project)


def test_add_text_layer_carries_style_into_the_effect_params(
    ctx: ToolContext, project: Project
) -> None:
    """GAP-006: the agent can make one word visually dominant.

    ``add_text_layer`` used to take four fields and produce a default centred caption, so
    a brief asking for "large typography, important words dominant" had no way through.
    The style rides a second op on the same patch, into the params bag the Inspector
    writes and ``render/text_overlay.py`` resolves — one vocabulary, three consumers.
    """
    result = run_tool(
        "add_text_layer",
        {
            "trackId": "ov",
            "text": "$327,000,000",
            "start": 0.0,
            "end": 2.0,
            "sizePercent": 18,
            "color": "#ff2d55",
            "yPercent": 30,
            "align": "center",
        },
        ctx,
    )
    assert result.operations is not None
    assert [op["type"] for op in result.operations] == ["add_text_overlay", "set_effect_params"]
    style = result.operations[1]
    assert style["clipId"] == result.operations[0]["clipId"]
    assert style["params"] == {
        "fontSizePercent": 18,
        "color": "#ff2d55",
        "align": "center",
        "yPercent": 30,
    }
    # The style must target the effect the first op creates on that clip, not a guess.
    assert style["effectId"] == f"{style['clipId']}__text"
    _assert_patch_ok(result, project)


def test_add_caption_layer(ctx: ToolContext, project: Project) -> None:
    result = run_tool("add_caption_layer", {"trackId": "cap", "start": 0.0, "end": 2.0}, ctx)
    _assert_patch_ok(result, project)


def test_add_caption_layer_rejects_a_full_recording_block(ctx: ToolContext) -> None:
    with pytest.raises(ToolSemanticError, match=r"one readable cue.*whole recording or song"):
        run_tool(
            "add_caption_layer",
            {"trackId": "cap", "start": 0.0, "end": 195.32},
            ctx,
        )


def test_add_keyframes(ctx: ToolContext, project: Project) -> None:
    result = run_tool(
        "add_keyframes",
        {
            "clipId": "A",
            "keyframes": [
                {"time": 0.0, "property": "scale", "value": 1.0},
                {"time": 1.0, "property": "scale", "value": 1.5, "easing": "ease-in"},
            ],
        },
        ctx,
    )
    assert result.operations is not None
    kfs = result.operations[0]["keyframes"]
    assert kfs[0]["easing"] == "linear"  # default applied
    assert kfs[1]["easing"] == "ease-in"
    assert kfs[0]["id"] == _derive_id("kf", "A", "scale", 0.0)
    _assert_patch_ok(result, project)


def test_add_keyframes_requires_at_least_one(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("add_keyframes", {"clipId": "A", "keyframes": []}, ctx)


def test_punch_in_defaults_to_whole_clip(ctx: ToolContext, project: Project) -> None:
    # Clip "A" runs 0..4 → the punch-in window spans the clip; scale 1.0 → 1.2.
    result = run_tool("punch_in", {"clipId": "A"}, ctx)
    assert result.operations is not None
    op = result.operations[0]
    assert op["type"] == "add_keyframes" and op["clipId"] == "A"
    kfs = op["keyframes"]
    assert len(kfs) == 2
    assert kfs[0]["property"] == "scale" and kfs[0]["value"] == 1.0 and kfs[0]["time"] == 0.0
    assert kfs[1]["value"] == 1.2 and kfs[1]["time"] == 4.0
    assert kfs[0]["easing"] == "ease-in-out"
    _assert_patch_ok(result, project)


def test_punch_in_honours_explicit_window_and_repairs_collapse(
    ctx: ToolContext, project: Project
) -> None:
    explicit = run_tool(
        "punch_in",
        {
            "clipId": "A",
            "startTime": 1.0,
            "endTime": 3.0,
            "fromScale": 1.1,
            "toScale": 1.5,
            "easing": "ease-out",
        },
        ctx,
    )
    assert explicit.operations is not None
    kfs = explicit.operations[0]["keyframes"]
    assert kfs[0]["time"] == 1.0 and kfs[0]["value"] == 1.1 and kfs[0]["easing"] == "ease-out"
    assert kfs[1]["time"] == 3.0 and kfs[1]["value"] == 1.5

    # An inverted window is rejected, not silently repaired into a different edit: the
    # agent can correct a stated range it got wrong, but not an edit it never asked for.
    with pytest.raises(ToolInputError):
        run_tool("punch_in", {"clipId": "A", "startTime": 5.0, "endTime": 3.0}, ctx)


def test_punch_in_unknown_clip_falls_back_to_default_window(ctx: ToolContext) -> None:
    result = run_tool("punch_in", {"clipId": "ghost"}, ctx)
    assert result.operations is not None
    kfs = result.operations[0]["keyframes"]
    assert kfs[1]["time"] == pytest.approx(1.5)  # DEFAULT_PUNCH_IN_SECONDS


def test_apply_color_grade_default_type(ctx: ToolContext, project: Project) -> None:
    result = run_tool("apply_color_grade", {"clipId": "A"}, ctx)
    assert result.operations is not None
    assert result.operations[0]["effect"]["type"] == "color_grade"
    _assert_patch_ok(result, project)


def test_apply_color_grade_explicit(ctx: ToolContext, project: Project) -> None:
    result = run_tool(
        "apply_color_grade",
        {"clipId": "A", "type": "lut", "params": {"path": "looks/teal.cube"}},
        ctx,
    )
    assert result.operations is not None
    assert result.operations[0]["effect"]["type"] == "lut"
    assert result.operations[0]["effect"]["params"] == {"path": "looks/teal.cube"}
    _assert_patch_ok(result, project)


def test_apply_color_grade_lut_requires_a_path(ctx: ToolContext) -> None:
    # The renderer loads a LUT from params.path; a named-only LUT renders nothing, so
    # it must fail at the tool boundary rather than persist as a silent no-op.
    with pytest.raises(ToolInputError):
        run_tool(
            "apply_color_grade", {"clipId": "A", "type": "lut", "params": {"name": "teal"}}, ctx
        )


def test_apply_color_grade_rejects_unsupported_type(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("apply_color_grade", {"clipId": "A", "type": "sepia"}, ctx)


def test_adjust_audio(ctx: ToolContext, project: Project) -> None:
    result = run_tool("adjust_audio", {"clipId": "AU", "gainDb": -6.0}, ctx)
    assert result.operations == [{"type": "adjust_audio", "clipId": "AU", "gainDb": -6.0}]
    _assert_patch_ok(result, project)


def test_add_transition() -> None:
    # add_transition requires an adjacent clean cut; the shared `project` fixture
    # leaves a 1s gap between A and B for unrelated tests, so build one locally.
    timeline = Timeline(
        tracks=[
            Track(
                id="v", type=TrackType.VIDEO, clips=[_clip("A", "v", 0, 4), _clip("B", "v", 4, 9)]
            ),
        ]
    )
    project = Project(id="project_001", name="Demo", timeline=timeline)
    ctx = ToolContext(project=project, selection=Selection(start=1.0, end=2.0))
    result = run_tool(
        "add_transition",
        {
            "trackId": "v",
            "fromClipId": "A",
            "toClipId": "B",
            "kind": "fade",
            "durationSeconds": 0.5,
        },
        ctx,
    )
    _assert_patch_ok(result, project)


def test_add_transition_requires_positive_duration(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool(
            "add_transition",
            {
                "trackId": "v",
                "fromClipId": "A",
                "toClipId": "B",
                "kind": "fade",
                "durationSeconds": 0.0,
            },
            ctx,
        )


def test_add_mask(ctx: ToolContext, project: Project) -> None:
    result = run_tool("add_mask", {"clipId": "A", "shape": "ellipse"}, ctx)
    _assert_patch_ok(result, project)


def test_track_object(ctx: ToolContext, project: Project) -> None:
    result = run_tool("track_object", {"clipId": "A", "target": "face"}, ctx)
    _assert_patch_ok(result, project)


def test_set_track_flags(ctx: ToolContext, project: Project) -> None:
    result = run_tool("set_track_flags", {"trackId": "a", "muted": True}, ctx)
    assert result.operations is not None
    op = result.operations[0]
    assert op == {"type": "set_track_flags", "trackId": "a", "muted": True}
    assert "locked" not in op and "hidden" not in op  # omitted flags stay absent
    _assert_patch_ok(result, project)


def test_set_track_flags_requires_a_flag(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):  # the schema gate requires at least one flag
        run_tool("set_track_flags", {"trackId": "a"}, ctx)


# ---------------------------------------------------------------------------
# Per-clip styling tools (schema v5-v8, H1.2 slices) — these emit clip-scoped
# ops that are NOT part of the timeline ``Operation`` union (like add_asset
# below), so we assert the emitted op dicts directly rather than via
# ``_assert_patch_ok`` (the TS editor-core applies and validates them).
# ---------------------------------------------------------------------------


def test_set_caption_style(ctx: ToolContext) -> None:
    style = {
        "fontFamily": "Inter",
        "position": "bottom",
        "xPercent": 38,
        "yPercent": 64,
        "rotation": -6,
        "maxWidthPercent": 70,
        "textAlign": "left",
        "lineHeight": 0.95,
        "safeArea": True,
    }
    result = run_tool(
        "set_caption_style",
        {"clipId": "A", "captionStyle": style},
        ctx,
    )
    assert result.operations == [
        {
            "type": "set_caption_style",
            "clipId": "A",
            "captionStyle": style,
        }
    ]


def test_discover_caption_styles_lists_bundled_fonts_and_filters_templates(
    ctx: ToolContext,
) -> None:
    result = run_tool("discover_caption_styles", {"query": "karaoke", "limit": 3}, ctx)
    assert len(result.data["fonts"]) >= 20
    assert any(font["family"] == "Inter" for font in result.data["fonts"])
    assert len(result.data["templates"]) <= 3
    assert any(template["templateId"] == "karaoke" for template in result.data["templates"])


def test_set_track_caption_style_emits_complete_composition(ctx: ToolContext) -> None:
    style = {
        "templateId": "headline",
        "fontFamily": "Montserrat",
        "xPercent": 31,
        "yPercent": 72,
        "rotation": -4,
        "fontScale": 1.4,
    }
    result = run_tool(
        "set_track_caption_style",
        {"trackId": "cap", "captionStyle": style},
        ctx,
    )
    assert result.operations == [
        {"type": "set_track_caption_style", "trackId": "cap", "captionStyle": style}
    ]


def test_auto_emphasize_captions_is_grounded_and_can_compose_layout(ctx: ToolContext) -> None:
    result = run_tool(
        "auto_emphasize_captions",
        {
            "trackId": "cap",
            "keywords": ["HELLO"],
            "color": "#ff3b30",
            "fontScale": 1.35,
            "style": {"fontFamily": "Poppins", "xPercent": 42, "yPercent": 68},
        },
        ctx,
    )
    assert result.operations == [
        {
            "type": "set_track_caption_style",
            "trackId": "cap",
            "captionStyle": {
                "fontFamily": "Poppins",
                "xPercent": 42.0,
                "yPercent": 68.0,
                "accent": {
                    "mode": "keywords",
                    "keywords": ["hello"],
                    "color": "#ff3b30",
                    "fontScale": 1.35,
                },
            },
        }
    ]
    with pytest.raises(ToolSemanticError, match="not present"):
        run_tool(
            "auto_emphasize_captions",
            {"trackId": "cap", "keywords": ["invented"]},
            ctx,
        )


def test_caption_style_tools_reject_unknown_assets(ctx: ToolContext) -> None:
    with pytest.raises(ToolSemanticError, match="Unknown caption template"):
        run_tool(
            "set_track_caption_style",
            {"trackId": "cap", "captionStyle": {"templateId": "imaginary"}},
            ctx,
        )
    with pytest.raises(ToolSemanticError, match="not bundled"):
        run_tool(
            "set_caption_style",
            {"clipId": "A", "captionStyle": {"fontFamily": "Local Mystery Font"}},
            ctx,
        )


def test_set_caption_style_null_clears(ctx: ToolContext) -> None:
    result = run_tool("set_caption_style", {"clipId": "A", "captionStyle": None}, ctx)
    assert result.operations == [{"type": "set_caption_style", "clipId": "A", "captionStyle": None}]


def test_set_caption_style_requires_the_key(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):  # captionStyle is required (nullable, not optional)
        run_tool("set_caption_style", {"clipId": "A"}, ctx)


def test_set_clip_speed(ctx: ToolContext) -> None:
    result = run_tool("set_clip_speed", {"clipId": "A", "speed": 2.0}, ctx)
    assert result.operations == [{"type": "set_clip_speed", "clipId": "A", "speed": 2.0}]


def test_set_clip_speed_null_resets(ctx: ToolContext) -> None:
    result = run_tool("set_clip_speed", {"clipId": "A", "speed": None}, ctx)
    assert result.operations == [{"type": "set_clip_speed", "clipId": "A", "speed": None}]


def test_set_clip_speed_rejects_non_positive(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("set_clip_speed", {"clipId": "A", "speed": 0.0}, ctx)
    with pytest.raises(ToolInputError):
        run_tool("set_clip_speed", {"clipId": "A", "speed": -1.0}, ctx)


def test_set_clip_crop(ctx: ToolContext) -> None:
    result = run_tool(
        "set_clip_crop",
        {"clipId": "A", "crop": {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.5}},
        ctx,
    )
    assert result.operations == [
        {
            "type": "set_clip_crop",
            "clipId": "A",
            "crop": {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.5},
        }
    ]


def test_set_clip_crop_null_clears(ctx: ToolContext) -> None:
    result = run_tool("set_clip_crop", {"clipId": "A", "crop": None}, ctx)
    assert result.operations == [{"type": "set_clip_crop", "clipId": "A", "crop": None}]


def test_set_clip_blend_mode(ctx: ToolContext) -> None:
    result = run_tool("set_clip_blend_mode", {"clipId": "A", "blendMode": "screen"}, ctx)
    assert result.operations == [
        {"type": "set_clip_blend_mode", "clipId": "A", "blendMode": "screen"}
    ]


def test_set_clip_blend_mode_null_resets(ctx: ToolContext) -> None:
    result = run_tool("set_clip_blend_mode", {"clipId": "A", "blendMode": None}, ctx)
    assert result.operations == [{"type": "set_clip_blend_mode", "clipId": "A", "blendMode": None}]


def test_set_clip_blend_mode_rejects_unknown_mode(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("set_clip_blend_mode", {"clipId": "A", "blendMode": "sepia"}, ctx)


def test_track_object_arbitrary_region(ctx: ToolContext, project: Project) -> None:
    result = run_tool(
        "track_object",
        {
            "clipId": "A",
            "target": "object",
            "region": {"x": 0.3, "y": 0.3, "width": 0.2, "height": 0.2},
            "engine": "manual",
        },
        ctx,
    )
    assert result.operations is not None
    op = result.operations[0]
    assert op["target"] == "object"
    assert op["region"] == {"x": 0.3, "y": 0.3, "width": 0.2, "height": 0.2}
    assert op["engine"] == "manual"
    _assert_patch_ok(result, project)


# ---------------------------------------------------------------------------
# Project (media-bin) tools — assets & folders (schema v3, ADR 0026)
#
# These emit project-scoped ops (add_asset / create_folder / move_asset) that
# are NOT part of the timeline ``Operation`` union, so we assert the emitted op
# dicts directly rather than via ``_assert_patch_ok`` (the TS editor-core applies
# and validates them).
# ---------------------------------------------------------------------------


def _bin_project() -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "Bin",
            "assets": [
                {"id": "asset_001", "path": "a.mp4", "kind": "video"},
                {"id": "music", "path": "m.mp3", "kind": "audio"},
            ],
            "timeline": {"tracks": []},
        }
    )


def test_add_asset_derives_id_and_emits_op() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool("add_asset", {"path": "gen/clip one.mp4"}, ctx)
    assert result.operations == [
        {
            "type": "add_asset",
            "asset": {"id": "asset_gen_clip_one_mp4", "path": "gen/clip one.mp4", "kind": "video"},
        }
    ]


@pytest.mark.parametrize(
    "path",
    [
        "stock://pexels/20349219",  # the captured fabrication
        "https://example.com/clip.mp4",
        "clip",  # no extension: not a file
        "   ",
    ],
)
def test_add_asset_refuses_a_path_the_model_invented(path: str) -> None:
    """Mirrors ``modelAuthoredMediaPath`` in the TS registry.

    A captured agent run lost its stock ``remoteId``s to log compaction and guessed a path
    instead. Nothing looked at it: the patch validated and the card showed a checkmark for a
    bin entry pointing at nothing. A dead end the run can act on beats a success it cannot.
    """
    ctx = ToolContext(project=_bin_project(), selection=None)
    with pytest.raises(ToolInputError):
        run_tool("add_asset", {"path": path}, ctx)


def test_add_asset_honors_explicit_fields() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool(
        "add_asset",
        {
            "path": "g/v.wav",
            "kind": "audio",
            "id": "vo",
            "folderId": "folder_audio",
            "durationSeconds": 3,
        },
        ctx,
    )
    assert result.operations == [
        {
            "type": "add_asset",
            "asset": {
                "id": "vo",
                "path": "g/v.wav",
                "kind": "audio",
                "durationSeconds": 3.0,
                "folderId": "folder_audio",
            },
        }
    ]


def test_manage_assets_by_kind_groups_assets() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool("manage_assets", {"strategy": "by-kind"}, ctx)
    assert result.operations is not None
    assert {
        "type": "create_folder",
        "folderId": "folder_video",
        "name": "Video",
        "parentId": None,
    } in result.operations
    assert {
        "type": "move_asset",
        "assetId": "music",
        "folderId": "folder_audio",
    } in result.operations


# ---------------------------------------------------------------------------
# Markers / chapters (schema v9, H1.2 slice) — project-scoped ops, same
# not-in-the-Operation-union caveat as add_asset/manage_assets above.
# ---------------------------------------------------------------------------


def test_add_marker_derives_deterministic_id() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool("add_marker", {"time": 12.0}, ctx)
    assert result.operations == [
        {"type": "add_marker", "id": _derive_id("marker", 12.0, ""), "time": 12.0}
    ]


def test_add_marker_with_label_and_color_promotes_to_chapter() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool("add_marker", {"time": 5.0, "label": "Intro", "color": "#ff0000"}, ctx)
    assert result.operations == [
        {
            "type": "add_marker",
            "id": _derive_id("marker", 5.0, "Intro"),
            "time": 5.0,
            "label": "Intro",
            "color": "#ff0000",
        }
    ]


def test_add_marker_honors_explicit_id() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool("add_marker", {"time": 5.0, "id": "chapter_1"}, ctx)
    assert result.operations == [{"type": "add_marker", "id": "chapter_1", "time": 5.0}]


def test_add_marker_rejects_negative_time() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    with pytest.raises(ToolInputError):
        run_tool("add_marker", {"time": -1.0}, ctx)


def test_remove_marker_emits_op() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool("remove_marker", {"id": "chapter_1"}, ctx)
    assert result.operations == [{"type": "remove_marker", "id": "chapter_1"}]


# ---------------------------------------------------------------------------
# transcribe (plan H0.1) — host-owned ASR request
# ---------------------------------------------------------------------------


def test_transcribe_delegates_asset_identity_to_host() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool("transcribe", {"assetId": "asset_001"}, ctx)
    assert result.kind == "analysis"
    assert result.operations is None


def test_transcribe_accepts_host_default_asset_selection() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool("transcribe", {}, ctx)
    assert result.kind == "analysis"


def test_transcribe_rejects_model_supplied_words() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    with pytest.raises(ToolInputError):
        run_tool("transcribe", {"words": []}, ctx)


def test_manage_assets_defaults_to_by_kind_without_plan() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    assert (
        run_tool("manage_assets", {}, ctx).operations
        == run_tool("manage_assets", {"strategy": "by-kind"}, ctx).operations
    )


def test_manage_assets_applies_explicit_plan() -> None:
    ctx = ToolContext(project=_bin_project(), selection=None)
    result = run_tool(
        "manage_assets",
        {
            "folders": [{"id": "broll", "name": "B-roll", "parentId": None}],
            "assignments": [{"assetId": "asset_001", "folderId": "broll"}],
        },
        ctx,
    )
    assert result.operations == [
        {"type": "create_folder", "folderId": "broll", "name": "B-roll", "parentId": None},
        {"type": "move_asset", "assetId": "asset_001", "folderId": "broll"},
    ]


# ---------------------------------------------------------------------------
# Token-friendly reads — get_timeline_summary / get_clips / get_clip / windowed
# transcript (mirrors the TS tool-registry tests)
# ---------------------------------------------------------------------------


def test_get_timeline_summary_returns_compact_per_track_stats(ctx: ToolContext) -> None:
    data = run_tool("get_timeline_summary", {}, ctx).data
    assert data["durationSeconds"] == 9
    assert data["trackCount"] == 4
    assert data["clipCount"] == 3
    assert data["tracks"][0] == {
        "id": "v",
        "type": "video",
        "clipCount": 2,
        "firstClipStart": 0,
        "lastClipEnd": 9,
    }
    assert data["tracks"][2]["firstClipStart"] is None
    assert data["markerCount"] == 0
    assert data["transcriptWordCount"] == 1
    # Compactness contract: no clip bodies leak into the summary.
    assert "sourceStart" not in str(data)


def test_get_clips_lists_windows_and_paginates(ctx: ToolContext) -> None:
    everything = run_tool("get_clips", {}, ctx).data
    assert everything["total"] == 3
    assert everything["hasMore"] is False
    # Ties on start order by trackId ("a" < "v"), mirroring the TS sort.
    assert [c["id"] for c in everything["clips"]] == ["AU", "A", "B"]
    assert everything["clips"][0] == {
        "id": "AU",
        "trackId": "a",
        "assetId": "asset_001",
        "start": 0.0,
        "end": 4.0,
        "sourceStart": 0.0,
        "sourceEnd": 4.0,
        "effectCount": 0,
        "keyframeCount": 0,
    }

    windowed = run_tool("get_clips", {"trackId": "v", "start": 5, "end": 8}, ctx).data
    assert [c["id"] for c in windowed["clips"]] == ["B"]

    paged = run_tool("get_clips", {"limit": 1, "offset": 1}, ctx).data
    assert [c["id"] for c in paged["clips"]] == ["A"]
    assert paged["total"] == 3
    assert paged["hasMore"] is True


def test_get_clip_returns_full_detail_or_steering_error(ctx: ToolContext) -> None:
    found = run_tool("get_clip", {"clipId": "B"}, ctx).data
    assert found["trackId"] == "v"
    assert found["clip"]["id"] == "B"
    assert found["clip"]["effects"] == []
    missing = run_tool("get_clip", {"clipId": "nope"}, ctx).data
    assert missing == {"error": 'Unknown clip "nope". Use get_clips to list real ids.'}


def test_get_transcript_windows_by_start_end(ctx: ToolContext) -> None:
    hello = {
        "word": "hello",
        "start": 0.0,
        "end": 0.5,
        "assetId": None,
        "confidence": None,
        "speaker": None,
    }
    assert run_tool("get_transcript", {}, ctx).data == [hello]
    assert run_tool("get_transcript", {"start": 0.4}, ctx).data == [hello]
    assert run_tool("get_transcript", {"start": 0.5}, ctx).data == []
    assert run_tool("get_transcript", {"end": 0.0}, ctx).data == []


# ---------------------------------------------------------------------------
# Precise deletes & track tools — delete_clip / delete_clips / remove_track /
# move_track (mirrors the TS tool-registry tests)
# ---------------------------------------------------------------------------


def test_delete_clip_builds_exact_span_ops(ctx: ToolContext, project: Project) -> None:
    result = run_tool("delete_clip", {"clipId": "A"}, ctx)
    assert result.operations == [{"type": "delete_range", "trackId": "v", "start": 0, "end": 4}]
    _assert_patch_ok(result, project)
    rippled = run_tool("delete_clip", {"clipId": "B", "ripple": True}, ctx)
    assert rippled.operations == [{"type": "ripple_delete", "trackId": "v", "start": 5, "end": 9}]


def test_delete_clip_rejects_unknown_id(ctx: ToolContext) -> None:
    with pytest.raises(ToolSemanticError, match=r'Unknown clip "ghost".*get_clips'):
        run_tool("delete_clip", {"clipId": "ghost"}, ctx)


def test_delete_clips_dedupes_and_ripples_back_to_front(ctx: ToolContext) -> None:
    deduped = run_tool("delete_clips", {"clipIds": ["A", "A"]}, ctx)
    assert deduped.operations == [{"type": "delete_range", "trackId": "v", "start": 0, "end": 4}]
    rippled = run_tool("delete_clips", {"clipIds": ["A", "B"], "ripple": True}, ctx)
    assert rippled.operations == [
        {"type": "ripple_delete", "trackId": "v", "start": 5, "end": 9},
        {"type": "ripple_delete", "trackId": "v", "start": 0, "end": 4},
    ]


def test_delete_clips_rejects_empty_list(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("delete_clips", {"clipIds": []}, ctx)


def test_remove_track_and_move_track_map_to_layer_ops(ctx: ToolContext, project: Project) -> None:
    removed = run_tool("remove_track", {"trackId": "ov"}, ctx)
    assert removed.operations == [{"type": "remove_layer", "layerId": "ov"}]
    _assert_patch_ok(removed, project)
    moved = run_tool("move_track", {"trackId": "ov", "toIndex": 0}, ctx)
    assert moved.operations == [{"type": "move_layer", "layerId": "ov", "toIndex": 0}]
    _assert_patch_ok(moved, project)


def test_get_clips_rejects_out_of_range_limit(ctx: ToolContext) -> None:
    with pytest.raises(ToolInputError):
        run_tool("get_clips", {"limit": 0}, ctx)
    with pytest.raises(ToolInputError):
        run_tool("get_clips", {"limit": 500}, ctx)


def test_summary_flags_and_clip_row_speed_are_carried() -> None:
    flagged = Project(
        id="project_002",
        name="Flags",
        timeline=Timeline(
            tracks=[
                Track(
                    id="v",
                    type=TrackType.VIDEO,
                    muted=True,
                    locked=True,
                    hidden=True,
                    clips=[
                        Clip.model_validate(
                            {
                                "id": "fast",
                                "assetId": "asset_001",
                                "trackId": "v",
                                "start": 0,
                                "end": 1,
                                "sourceStart": 0,
                                "sourceEnd": 2,
                                "speed": 2,
                            }
                        )
                    ],
                )
            ]
        ),
    )
    flag_ctx = ToolContext(project=flagged, selection=None)
    summary = run_tool("get_timeline_summary", {}, flag_ctx).data
    assert summary["tracks"][0]["muted"] is True
    assert summary["tracks"][0]["locked"] is True
    assert summary["tracks"][0]["hidden"] is True
    row = run_tool("get_clips", {}, flag_ctx).data["clips"][0]
    assert row["speed"] == 2
