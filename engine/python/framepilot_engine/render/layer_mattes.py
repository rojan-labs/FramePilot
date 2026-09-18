"""Track mattes and text as a mask: the ``layer`` mask kind (MK8.2, plan 10).

WHY this exists: a track matte cuts one clip by ANOTHER picture — a title's letters ("video inside
text"), a shape animated on another track, a luma ramp. The matte is that source as the export
composites it at the same instant: the source clip (or every picture on the source track) drawn
alone on a transparent frame, placement, masks and opacity included. That is the frame plan's
own layer for the source (``frame_plan.layer_matte_sources`` marks it ``matteOnly``: rendered for
the matte, never composited itself, as Premiere's Track Matte Key and CapCut's text mask hide it).

**Channels.** ``alpha`` is the source's composited alpha; ``luma`` is its Rec. 709 luma over
transparent black (``luma(rgb) * alpha``), so a white title is opaque and a dark one is not;
``inverted-alpha`` and ``inverted-luma`` are ``1 - value``. Where the source draws nothing the
value is 0 (1 inverted).

**Mapping.** A clip's mask stack is attached to its CROPPED picture before that picture is resized,
rotated and pasted onto the frame, so the matte (a frame-space picture) is read at the frame pixel
each local pixel centre lands on (:func:`sample_positions`)::

    u = ((col + 0.5) * width) / local_width          # the centre, resized
    v = ((row + 0.5) * height) / local_height
    X = x + u                                          # no rotation
    X = x + hx + (du * cos + dv * sin)                 # rotated about the resized centre
    Y = y + hy + (dv * cos - du * sin)                 #   (du = u - hx, dv = v - hy; PIL's
                                                       #    counter-clockwise rotation)

and the matte pixel ``(floor(X), floor(Y))`` is taken (nearest; outside the frame reads as nothing).
The monitor evaluates the same expressions in a fragment shader (``layer-mattes.ts``); float32
cannot be byte-equal to this float64, so parity is judged by the PX4 oracle's ``alpha/layer-*``
rows at the unchanged gates.

The value then runs the matte finesse group (clean levels, denoise, morphology, blur) exactly as a
``key`` does, and the base invert and opacity. A layer mask has no drawn edge, so expansion and
feathers are refused on it (grow and soften it with finesse instead).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.render.key_mask import luma_of
from framepilot_engine.render.mask_raster import FloatArray

_log = logging.getLogger(__name__)

#: The channels a ``layer`` mask reads, in schema order.
LAYER_CHANNELS = ("alpha", "luma", "inverted-alpha", "inverted-luma")


@dataclass(frozen=True)
class PicturePlacement:
    """Where a clip's masked (cropped) picture lands on the frame at one instant.

    ``local_*`` is the raster the stack is attached at; ``width``/``height`` the size MoviePy
    resizes it to (``int(size * scale)``); ``rotation`` degrees counter-clockwise as PIL rotates
    (0 when the clip does not animate rotation); ``x``/``y`` the integer paste position
    (``compute_position`` truncates).
    """

    local_width: int
    local_height: int
    width: int
    height: int
    rotation: float
    x: int
    y: int


@dataclass(frozen=True)
class LayerMatteFrame:
    """A track matte source composited alone on a transparent frame: straight RGB and alpha."""

    rgb: npt.NDArray[np.uint8]
    alpha: FloatArray


def empty_matte_frame(width: int, height: int) -> LayerMatteFrame:
    """A frame where the source draws nothing (it is not playing, or it is empty)."""
    return LayerMatteFrame(
        rgb=np.zeros((height, width, 3), dtype=np.uint8),
        alpha=np.zeros((height, width), dtype=np.float64),
    )


def matte_channel(frame: LayerMatteFrame, channel: str) -> FloatArray:
    """The source's alpha or luma (over transparent black), BEFORE any inversion."""
    alpha = np.clip(np.asarray(frame.alpha, dtype=np.float64), 0.0, 1.0)
    if channel in ("alpha", "inverted-alpha"):
        return alpha
    rgb = np.asarray(frame.rgb, dtype=np.float64) / 255.0
    return luma_of(rgb) * alpha


def sample_positions(
    placement: PicturePlacement, frame_width: int, frame_height: int
) -> tuple[npt.NDArray[np.int64], npt.NDArray[np.int64], npt.NDArray[np.bool_]]:
    """The frame pixel each local pixel centre lands on, and whether it is inside the frame."""
    local_w, local_h = placement.local_width, placement.local_height
    u = ((np.arange(local_w, dtype=np.float64) + 0.5) * placement.width) / local_w
    v = ((np.arange(local_h, dtype=np.float64) + 0.5) * placement.height) / local_h
    uu = np.broadcast_to(u.reshape(1, local_w), (local_h, local_w))
    vv = np.broadcast_to(v.reshape(local_h, 1), (local_h, local_w))
    if placement.rotation == 0.0:
        xs = placement.x + uu
        ys = placement.y + vv
    else:
        radians = placement.rotation * math.pi / 180.0
        cos_r = math.cos(radians)
        sin_r = math.sin(radians)
        hx = placement.width * 0.5
        hy = placement.height * 0.5
        du = uu - hx
        dv = vv - hy
        xs = placement.x + hx + (du * cos_r + dv * sin_r)
        ys = placement.y + hy + (dv * cos_r - du * sin_r)
    xi = np.floor(xs).astype(np.int64)
    yi = np.floor(ys).astype(np.int64)
    valid = (xi >= 0) & (xi < frame_width) & (yi >= 0) & (yi < frame_height)
    return xi, yi, valid


def sample_plane(values: FloatArray, placement: PicturePlacement) -> FloatArray:
    """A frame-sized plane read onto the clip's local raster (0 where a pixel lands off-frame).

    Shared by track mattes and by frame-space clip masks (MK9.1): both are frame pictures a clip
    is cut by, read at the frame pixel each of the clip's pixel centres lands on.
    """
    frame_h, frame_w = values.shape
    xi, yi, valid = sample_positions(placement, frame_w, frame_h)
    local = np.where(valid, values[np.clip(yi, 0, frame_h - 1), np.clip(xi, 0, frame_w - 1)], 0.0)
    return np.asarray(local, dtype=np.float64)


def sampled_channel(
    frame: LayerMatteFrame, channel: str, placement: PicturePlacement
) -> FloatArray:
    """The channel on the clip's local raster: sampled, then inverted when the channel asks."""
    local = sample_plane(matte_channel(frame, channel), placement)
    if channel.startswith("inverted-"):
        local = 1.0 - local
    return local


@dataclass
class LayerMatteResolver:
    """The export's track matte pictures, filled while the compile places pictures.

    A consumed layer (a clip's own layer, an under-layer for it, or anything on a consumed track)
    is added here instead of to the composite; :meth:`frame_at` composites a source's layers alone
    on a transparent frame at a sequence time, lazily and once per source, and keeps the last
    frame per source so several masks reading one source at one instant composite it once.
    """

    size: tuple[int, int]
    by_clip: dict[str, list[Any]] = field(default_factory=dict)
    by_track: dict[str, list[Any]] = field(default_factory=dict)
    _composites: dict[str, Any] = field(default_factory=dict)
    _last: dict[str, tuple[float, LayerMatteFrame]] = field(default_factory=dict)

    def add(self, track_id: str, clip_id: str, layer: Any) -> None:
        """Register a placed layer consumed as a matte (``clip_id`` = the clip it belongs to)."""
        self.by_clip.setdefault(clip_id, []).append(layer)
        self.by_track.setdefault(track_id, []).append(layer)

    def layers_of(self, source: Any) -> list[Any]:
        if source.kind == "clip":
            return self.by_clip.get(str(source.clip_id), [])
        return self.by_track.get(str(source.track_id), [])

    def frame_at(self, source: Any, time: float) -> LayerMatteFrame:
        """The source composited alone at sequence ``time`` (transparent where it draws nothing)."""
        key = f"{source.kind}:{source.clip_id if source.kind == 'clip' else source.track_id}"
        last = self._last.get(key)
        if last is not None and last[0] == time:
            return last[1]
        layers = self.layers_of(source)
        if not layers:
            frame = empty_matte_frame(*self.size)
        else:
            composite = self._composites.get(key)
            if composite is None:
                from moviepy import CompositeVideoClip

                # No bg_color: a transparent background, so the frame's alpha is the source's.
                composite = CompositeVideoClip(layers, size=self.size)
                self._composites[key] = composite
            rgb = np.asarray(composite.get_frame(time), dtype=np.uint8)
            mask = composite.mask
            alpha = (
                np.zeros(rgb.shape[:2], dtype=np.float64)
                if mask is None
                else np.asarray(mask.get_frame(time), dtype=np.float64)
            )
            frame = LayerMatteFrame(rgb=rgb[:, :, :3], alpha=alpha)
        self._last[key] = (time, frame)
        return frame


class LayerMatteRefusal(ValueError):
    """A track matte the export cannot draw (a missing or looping source); says what to do."""


def assert_layer_sources(project: Any) -> None:
    """Refuse, before any frame renders, a track matte whose source is missing or loops.

    The validator refuses the same on mask edits; this also covers a loop created by moving a
    clip onto a track that another of its layer masks reads.
    """
    clips: dict[str, Any] = {}
    track_of: dict[str, Any] = {}
    tracks: dict[str, Any] = {}
    for track in project.timeline.tracks:
        tracks[str(track.id)] = track
        for clip in track.clips:
            clips[str(clip.id)] = clip
            track_of[str(clip.id)] = track

    def reads(clip: Any) -> list[str]:
        out: list[str] = []
        for mask in getattr(clip, "masks", None) or []:
            if not mask.enabled or mask.kind != "layer":
                continue
            source = mask.source
            if source.kind == "clip":
                out.append(str(source.clip_id))
            else:
                track = tracks.get(str(source.track_id))
                out.extend(str(candidate.id) for candidate in (track.clips if track else []))
        return out

    for clip_id, clip in clips.items():
        for mask in getattr(clip, "masks", None) or []:
            if not mask.enabled or mask.kind != "layer":
                continue
            source = mask.source
            exists = (
                str(source.clip_id) in clips
                if source.kind == "clip"
                else str(source.track_id) in tracks
            )
            if not exists:
                raise LayerMatteRefusal(
                    f"Mask {mask.id!r} on clip {clip_id!r} reads a clip or track that does not "
                    "exist. Point the track matte at an existing clip or track."
                )
            source_track = (
                track_of.get(str(source.clip_id))
                if source.kind == "clip"
                else tracks.get(str(source.track_id))
            )
            if source_track is not None and str(source_track.type.value) != "video":
                raise LayerMatteRefusal(
                    f"Mask {mask.id!r} on clip {clip_id!r} reads a track that holds no picture. "
                    "Point the track matte at a clip or track on a video track."
                )
        stack = reads(clip)
        visited: set[str] = set()
        while stack:
            current = stack.pop()
            if current == clip_id:
                raise LayerMatteRefusal(
                    f"Track mattes starting at clip {clip_id!r} lead back to it. Point the track "
                    "matte at a clip that does not use this clip as its matte."
                )
            if current in visited:
                continue
            visited.add(current)
            following = clips.get(current)
            if following is not None:
                stack.extend(reads(following))
    _log.debug("layer mask sources checked for %d clips", len(clips))


__all__ = [
    "LAYER_CHANNELS",
    "LayerMatteFrame",
    "LayerMatteRefusal",
    "LayerMatteResolver",
    "PicturePlacement",
    "assert_layer_sources",
    "empty_matte_frame",
    "matte_channel",
    "sample_plane",
    "sample_positions",
    "sampled_channel",
]
