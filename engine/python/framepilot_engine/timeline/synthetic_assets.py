"""Synthetic asset ids and a clip's renderable kind: the one definition in Python.

The TypeScript twin is ``packages/editor-core/src/synthetic-assets.ts``;
``tests/fixtures/clip-kind.json`` holds both to the same answers (plan/elements EL3).

A text overlay or a caption cue has no media file. Its ``asset_id`` is a sentinel naming what
draws it. Every module that asks "is this a title?", "does this clip read a source?" or "what
kind of clip is this?" asks here, so a new synthetic kind (a shape) is a change to this module,
not to every renderer and operation. ``tests/test_synthetic_assets.py`` fails if a sentinel is
spelled, copied or compared anywhere else in the engine.
"""

from __future__ import annotations

from typing import Final, Literal, Protocol

#: The asset id of a text overlay (``add_text_overlay``). Persisted: never change it.
TEXT_OVERLAY_ASSET_ID: Final = "__text__"
#: The asset id of a caption cue (``add_caption_layer``). Persisted: never change it.
CAPTION_ASSET_ID: Final = "__caption__"
#: The asset id of a shape (``add_shape``, schema v25). Persisted: never change it.
SHAPE_ASSET_ID: Final = "__shape__"

SyntheticClipKind = Literal["text", "caption", "shape"]
ClipRenderKind = Literal["video", "image", "audio", "text", "caption", "shape"]
LaneType = Literal["video", "audio", "caption", "overlay"]

_SYNTHETIC_KIND_BY_ASSET_ID: Final[dict[str, SyntheticClipKind]] = {
    TEXT_OVERLAY_ASSET_ID: "text",
    CAPTION_ASSET_ID: "caption",
    SHAPE_ASSET_ID: "shape",
}

#: Every synthetic asset id: a clip carrying one has no asset in the bin, by design.
SYNTHETIC_ASSET_IDS: Final = frozenset(_SYNTHETIC_KIND_BY_ASSET_ID)


class _HasAssetId(Protocol):
    @property
    def asset_id(self) -> str: ...


def is_synthetic_asset_id(asset_id: str) -> bool:
    """True when ``asset_id`` is a sentinel rather than a bin asset."""
    return asset_id in _SYNTHETIC_KIND_BY_ASSET_ID


def synthetic_clip_kind(asset_id: str) -> SyntheticClipKind | None:
    """What a synthetic id draws, or ``None`` for a media asset id."""
    return _SYNTHETIC_KIND_BY_ASSET_ID.get(asset_id)


def has_time_based_source(clip: _HasAssetId) -> bool:
    """Does this clip draw from a real, time-based source?

    A text overlay or a caption cue is generated at render time from its own parameters, so its
    ``source_start: 0`` means "nothing to say" rather than "the file starts here". Treating that
    0 as a real in-point is what made an overlay extendable forwards and immovable backwards.
    """
    return not is_synthetic_asset_id(clip.asset_id)


def clip_render_kind(asset_id: str, asset_kind: str | None) -> ClipRenderKind:
    """A clip's renderable kind, from its asset id and its asset's ``kind``.

    Never from its lane's advisory ``type``, so a clip behaves the same on any lane. An id absent
    from the bin (or an unknown asset kind) reads as ``video``, as the renderer draws it.
    """
    synthetic = synthetic_clip_kind(asset_id)
    if synthetic is not None:
        return synthetic
    if asset_kind == "audio":
        return "audio"
    if asset_kind == "image":
        return "image"
    return "video"


def lane_type_for_kind(kind: ClipRenderKind) -> LaneType:
    """The advisory ``track.type`` of a lane that hosts clips of ``kind``."""
    if kind == "audio":
        return "audio"
    if kind == "caption":
        return "caption"
    if kind in ("text", "shape"):
        return "overlay"
    return "video"
