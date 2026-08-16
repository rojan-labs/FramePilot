"""Deterministic render pipeline (PRD §9, plan Phase 2).

Compiles a timeline into a MoviePy + FFmpeg composition for preview and final
export, and owns the render-job lifecycle and export presets.

* :mod:`framepilot_engine.render.pipeline` — render job + lifecycle + ``render``.
* :mod:`framepilot_engine.render.presets` — export preset definitions.
"""

from __future__ import annotations
