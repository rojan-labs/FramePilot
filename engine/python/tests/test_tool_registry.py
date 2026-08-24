"""Tests asserting the AI tool registry matches PRD §8.3."""

from __future__ import annotations

from framepilot_engine.ai_tools.registry import TOOL_REGISTRY, ToolSpec

# The canonical core tool names from PRD §8.3.
PRD_CORE_TOOLS = {
    "get_project_state",
    "get_timeline",
    "get_transcript",
    "get_selected_range",
    "analyze_silence",
    "detect_scenes",
    "track_object",
    "generate_mask",
    "add_text_layer",
    "add_caption_layer",
    "trim_clip",
    "split_clip",
    "delete_range",
    "add_keyframes",
    "apply_color_grade",
    "adjust_audio",
    "add_transition",
    "render_preview",
    "export_video",
}


def test_all_prd_core_tools_present() -> None:
    assert set(TOOL_REGISTRY) >= PRD_CORE_TOOLS


def test_registry_keys_match_spec_names() -> None:
    for name, spec in TOOL_REGISTRY.items():
        assert isinstance(spec, ToolSpec)
        assert spec.name == name
        assert spec.input_schema.get("type") == "object"


def test_query_tools_are_non_mutating() -> None:
    for name in ("get_project_state", "get_timeline", "render_preview", "export_video"):
        assert TOOL_REGISTRY[name].mutating is False


def test_edit_tools_are_mutating() -> None:
    for name in ("trim_clip", "split_clip", "delete_range", "apply_color_grade"):
        assert TOOL_REGISTRY[name].mutating is True
