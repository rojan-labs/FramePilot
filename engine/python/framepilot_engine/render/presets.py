"""Export preset definitions (plan 2.2, PRD §6.1; renamed to platform presets H1.3b).

WHY real data: presets are static configuration, not logic. They are the
platform-targeted output formats the user picks at export time. The set now
mirrors the product plan's explicit short-form platform list — Reels, TikTok,
Shorts, YouTube — plus ``square`` (kept for feed-post exports, not itself named
in the plan but a real, already-shipped capability we didn't want to silently
drop). ``custom`` is handled at call sites, not listed here.

WHY ``loudness_target`` on the preset: the plan asks for "per-platform
loudness." Loudness itself stays a fully separate, user-controllable render
option (``RenderOptions.loudness`` / :mod:`framepilot_engine.audio.filters`,
values ``social``/``podcast``/``broadcast``) — a preset only carries a
*recommended default* for its platform; it does not force-apply loudnorm (the
user's explicit choice always wins). Reels/TikTok/Shorts/YouTube all default to
``"social"`` (-14 LUFS): this is the widely documented integrated-loudness
convention shared by short-form/streaming platforms (YouTube's published
loudness target, Spotify/TikTok/Instagram normalizing around the same -14 LUFS
figure) — see :data:`framepilot_engine.audio.filters.LOUDNESS_PRESETS`.
``square`` (feed posts, not a video platform on its own) keeps the same
general-purpose social default for consistency.

WHY ``linkedin_16_9`` was retired as a *distinct* preset: it was pixel-for-pixel
identical to the new ``youtube`` 16:9 preset (1920x1080). Exporting with
``youtube`` still produces a file that plays correctly on LinkedIn — no
capability was dropped, only the duplicate named entry. LinkedIn remains a
first-class *content-style* target elsewhere (`AiStreamAgentOptions.targetPlatform`
in `@framepilot/shared-types`) — that is a separate concern (agent pacing/hook
style) from this module (container resolution/codec), so nothing there changed.
"""

from __future__ import annotations

from pydantic import BaseModel


class ExportPreset(BaseModel):
    """A named export configuration (resolution / fps / codecs / loudness default)."""

    id: str
    label: str
    width: int
    height: int
    fps: int = 30
    video_codec: str = "libx264"
    audio_codec: str = "aac"
    container: str = "mp4"
    #: Recommended default key into `audio.filters.LOUDNESS_PRESETS` for this
    #: platform. A *default suggestion* only — the user's explicit loudness
    #: choice on the render request always takes precedence.
    loudness_target: str = "social"


REELS = ExportPreset(
    id="reels",
    label="Instagram Reels (9:16)",
    width=1080,
    height=1920,
    loudness_target="social",
)

TIKTOK = ExportPreset(
    id="tiktok",
    label="TikTok (9:16)",
    width=1080,
    height=1920,
    loudness_target="social",
)

SHORTS = ExportPreset(
    id="shorts",
    label="YouTube Shorts (9:16)",
    width=1080,
    height=1920,
    loudness_target="social",
)

YOUTUBE = ExportPreset(
    id="youtube",
    label="YouTube (16:9)",
    width=1920,
    height=1080,
    loudness_target="social",
)

SQUARE = ExportPreset(
    id="square",
    label="Square (1:1)",
    width=1080,
    height=1080,
    loudness_target="social",
)

# Lookup table keyed by preset id, consumed by the CLI/service and render path.
EXPORT_PRESETS: dict[str, ExportPreset] = {
    REELS.id: REELS,
    TIKTOK.id: TIKTOK,
    SHORTS.id: SHORTS,
    YOUTUBE.id: YOUTUBE,
    SQUARE.id: SQUARE,
}
