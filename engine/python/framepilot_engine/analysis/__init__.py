"""Deterministic media analysis (plan Phase 9.2).

These are **analysis** capabilities, not edits: they read media through the
existing ffmpeg toolchain and return structured data (silent ranges, scene-cut
timestamps) for the AI orchestrator to reason about. They never mutate the
timeline and never render — the render-vs-preview boundary (PRD §9.2) is not
touched.

The design mirrors :mod:`framepilot_engine.validation.render_validation`: each
detector splits into a **pure log parser** (unit-testable without ffmpeg) and a
thin subprocess wrapper that takes an injectable
:data:`framepilot_engine.media.ffmpeg.Runner`, so the whole analysis matrix is
100% testable offline (dependency inversion).
"""

from __future__ import annotations

from framepilot_engine.analysis.beats import (
    Beat,
    BeatAnalysis,
    detect_beats,
    estimate_bpm,
    onset_envelope,
    pick_beats,
)
from framepilot_engine.analysis.black import (
    BlackRange,
    detect_black,
    parse_black_ranges,
    parse_black_seconds,
)
from framepilot_engine.analysis.freeze import (
    FrozenRange,
    detect_freezes,
    parse_frozen_ranges,
)
from framepilot_engine.analysis.loudness import (
    LoudnessAnalysis,
    measure_loudness,
    parse_loudness_summary,
)
from framepilot_engine.analysis.scenes import (
    SceneCut,
    detect_scenes,
    parse_scene_changes,
)
from framepilot_engine.analysis.silence import (
    SILENCE_PROBE_FLOOR_SECONDS,
    SilenceMeasurement,
    SilentRange,
    detect_silence,
    parse_silence_ranges,
    summarize_silence,
)
from framepilot_engine.analysis.visual_sampler import (
    DEFAULT_HAMMING_THRESHOLD,
    SAMPLER_VERSION,
    FrameCandidate,
    VisualSpan,
    build_candidates,
    build_spans,
    candidate_timestamps,
    dhash,
    hamming,
    image_span,
    plan_spans,
)

__all__ = [
    "DEFAULT_HAMMING_THRESHOLD",
    "SAMPLER_VERSION",
    "SILENCE_PROBE_FLOOR_SECONDS",
    "Beat",
    "BeatAnalysis",
    "BlackRange",
    "FrameCandidate",
    "FrozenRange",
    "LoudnessAnalysis",
    "SceneCut",
    "SilenceMeasurement",
    "SilentRange",
    "VisualSpan",
    "build_candidates",
    "build_spans",
    "candidate_timestamps",
    "detect_beats",
    "detect_black",
    "detect_freezes",
    "detect_scenes",
    "detect_silence",
    "dhash",
    "estimate_bpm",
    "hamming",
    "image_span",
    "measure_loudness",
    "onset_envelope",
    "parse_black_ranges",
    "parse_black_seconds",
    "parse_frozen_ranges",
    "parse_loudness_summary",
    "parse_scene_changes",
    "parse_silence_ranges",
    "pick_beats",
    "plan_spans",
    "summarize_silence",
]
