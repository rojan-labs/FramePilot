"""FramePilot render + timeline engine.

This package is the deterministic Python core of FramePilot ("Cursor for video
editing"). It owns the timeline data model, the MoviePy + FFmpeg render
pipeline, media inspection, tracking, masking, and render/patch validation, and
exposes them through a CLI (``framepilot``) and a local FastAPI sidecar.

WHY a separate Python engine: rendering and media analysis must be
*deterministic* and run outside the Electron renderer for safety and
reproducibility (PRD §9.2). The AI layer never mutates project JSON directly; it
proposes validated patches that this engine applies and renders (PRD §8.3/§8.4).

See ``plan/PLAN.md`` Phase 2 for the build contract.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.0.0"
