"""Generated autonomous tool routing mirror. Do not edit by hand.

Source: packages/ai-sdk/src/autonomous-tools.manifest.json
Generator: scripts/generate-autonomous-tools.mjs
"""

from __future__ import annotations

import json
from typing import Any

AUTONOMOUS_TOOL_INDEX_JSON = r'''{
  "version": 2,
  "tools": [
    {
      "name": "inspect_project",
      "stages": ["inspect", "understand", "recover", "verify"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["get_project_state"]
    },
    {
      "name": "inspect_timeline",
      "stages": ["inspect", "edit", "recover", "verify"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["get_timeline"]
    },
    {
      "name": "inspect_transcript",
      "stages": ["inspect", "understand", "edit", "recover", "verify"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["get_transcript"]
    },
    {
      "name": "probe_media",
      "stages": ["inspect", "understand", "verify"],
      "status": "planned",
      "kind": "runtime",
      "internalRoutes": []
    },
    {
      "name": "resolve_time",
      "stages": ["understand", "edit", "verify"],
      "status": "planned",
      "kind": "runtime",
      "internalRoutes": []
    },
    {
      "name": "get_frame",
      "stages": ["inspect", "understand", "recover", "verify"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["get_frame"]
    },
    {
      "name": "search_media",
      "stages": ["understand", "edit", "recover"],
      "status": "ready",
      "kind": "composite",
      "internalRoutes": [
        "search_media",
        "find_similar",
        "search_visual",
        "describe_footage",
        "map_footage"
      ]
    },
    {
      "name": "analyze_media",
      "stages": ["understand", "edit", "recover", "verify"],
      "status": "ready",
      "kind": "composite",
      "internalRoutes": ["transcribe", "analyze_silence", "detect_scenes", "detect_beats"]
    },
    {
      "name": "understand_timestamp",
      "stages": ["understand", "edit", "verify"],
      "status": "planned",
      "kind": "runtime",
      "internalRoutes": []
    },
    {
      "name": "plan_edit_candidates",
      "stages": ["edit"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["propose_edits"]
    },
    {
      "name": "propose_timeline_patch",
      "stages": ["edit", "recover"],
      "status": "ready",
      "kind": "proposal",
      "internalRoutes": []
    },
    {
      "name": "propose_project_patch",
      "stages": ["edit", "recover"],
      "status": "ready",
      "kind": "proposal",
      "internalRoutes": []
    },
    {
      "name": "render_preview",
      "stages": ["render", "verify"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["render_preview"]
    },
    {
      "name": "verify_result",
      "stages": ["verify", "recover"],
      "status": "ready",
      "kind": "composite",
      "internalRoutes": ["verify_captions", "verify_transitions"]
    },
    {
      "name": "ask_user",
      "stages": ["inspect", "understand", "edit", "recover", "verify", "render"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["ask_user"]
    },
    {
      "name": "load_skill",
      "stages": ["understand", "edit", "recover"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["load_skill"]
    },
    {
      "name": "discover_styles",
      "stages": ["understand", "edit"],
      "status": "ready",
      "kind": "composite",
      "internalRoutes": ["discover_caption_styles", "discover_effects", "discover_transitions"]
    },
    {
      "name": "recall_evidence",
      "stages": ["understand", "edit", "recover", "verify"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["recall_evidence"]
    },
    {
      "name": "manage_assets",
      "stages": ["edit", "recover"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["manage_assets"]
    },
    {
      "name": "inspect_session",
      "stages": ["inspect", "understand", "recover"],
      "status": "ready",
      "kind": "registry",
      "internalRoutes": ["session_context"]
    },
    {
      "name": "cancel_operation",
      "stages": ["recover"],
      "status": "planned",
      "kind": "runtime",
      "internalRoutes": []
    },
    {
      "name": "undo_edit",
      "stages": ["recover"],
      "status": "planned",
      "kind": "runtime",
      "internalRoutes": []
    }
  ]
}'''
AUTONOMOUS_TOOL_INDEX: dict[str, Any] = json.loads(AUTONOMOUS_TOOL_INDEX_JSON)
AUTONOMOUS_TOOL_VERSION: int = int(AUTONOMOUS_TOOL_INDEX["version"])
AUTONOMOUS_TOOL_NAMES: tuple[str, ...] = tuple(
    sorted(str(tool["name"]) for tool in AUTONOMOUS_TOOL_INDEX["tools"])
)


def autonomous_tool(name: str) -> dict[str, Any] | None:
    """Return one mirrored canonical tool or ``None``."""
    return next(
        (tool for tool in AUTONOMOUS_TOOL_INDEX["tools"] if tool["name"] == name),
        None,
    )
