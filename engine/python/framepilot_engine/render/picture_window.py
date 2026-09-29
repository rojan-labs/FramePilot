"""Which clips can put pixels into ONE frame: the single-frame grab's compile window.

WHY this exists: ``get_frame`` answers "what does 5.2s look like?" by compositing through
the export's own compiler (see :mod:`framepilot_engine.render.frame_grab`). Compiling the
whole timeline for that opened a MoviePy reader for every clip — a probe, an ffmpeg decode
process, a first-frame read and a seek per clip — so a 60-second, 26-clip edit took 24-45s
per look (desktop run ``6cb12e30``), for a picture that at most three of those clips appear
in. This module names the clips whose layers can be playing at one instant, so the compiler
builds only those (``compile_timeline(..., window=...)``).

WHY the frame is still the export's: a layer that is not playing at ``t`` contributes nothing
to the composite at ``t`` — MoviePy composites ``playing_clips(t)`` over the background, in
layer order, and skips the rest — so dropping only non-playing layers leaves the frame at
``t`` bit-identical, provided every other stage is a function of ``t`` alone. The window is a
conservative SUPERSET of the playing layers (a clip is kept when any layer it builds could
still be playing), never an estimate.

Blend modes ARE windowed (AL38), at every instant where the export's frame is still a function
of the layers playing then. The export's blend compositor (``compiler._composite_with_blend_
modes``) takes each blended layer over the composite of everything beneath it; a layer that is
not playing is an exact identity there (the float round trip of an 8-bit frame is lossless, and
a blend at alpha 0 returns the base), so only two things make the frame depend on other layers:
the bottom layer's own mode is ignored, and a blended layer that outlives every layer beneath it
blends over their last frame, held. A window composites its layers with the same compositor,
and answers only an instant where every blended layer still to play has a layer beneath it,
built in the window, that lasts past that instant — then neither thing can happen, in the
export or in the window (``compiler.window_answers``). Elsewhere, and when a frosted text overlay
the window leaves out would put the export on the frost compositor (which rounds a blend
differently), the frame comes from the full compile. A blend mode on a burned caption is still
refused here.

Track mattes (``layer`` masks) ARE windowed. A matte source is a picture clip like any other,
so it is in the window exactly when one of its layers can be playing, and the compile still
consumes it as a matte (``layer_matte_sources`` reads the whole project, not the window). What
the matte is at ``t`` is :func:`~framepilot_engine.render.layer_mattes.composite_alone` of the
source's layers: only the layers playing at ``t``, drawn on a transparent frame (AL31). A source
whose layers are all idle is therefore the same transparent frame as a source with none built,
which is what the window leaves out. They were refused while the matte was MoviePy's composite
mask of every layer, idle ones included; since AL31 refusing them only made every grab and
colour measurement of a project with one track matte compile the whole timeline — 40 readers,
~43 s a frame on the captured travel reel (AL33).

Everything else is windowed: transitions (the under-layer a transition borrows from its
neighbour is built by, and placed inside, the clip that carries the transition, and the
neighbour is read from the full track), speed ramps and freeze frames (fitted to the clip's
own span), titles and shapes (exactly their span), burned captions (exactly their span),
effect layers (functions of the composited frame and ``t``, applied for the whole timeline
as before, and never windowed) and audio (never needed for a picture; not built at all).
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from framepilot_engine.effects.speed_curve import has_speed_ramp
from framepilot_engine.render.frame_plan import caption_tracks, clip_kind
from framepilot_engine.timeline.models import Clip, Project, TrackType
from framepilot_engine.timeline.synthetic_assets import DRAWN_CLIP_KINDS

#: The clip kinds the compiler turns into picture layers (``compile_timeline``'s main loop).
WINDOWED_KINDS = DRAWN_CLIP_KINDS

#: Slack added on both sides of a clip's reach. The compiler refuses a constant-speed or
#: reversed clip whose rendered segment differs from its timeline span by more than
#: ``_SPEED_DURATION_TOLERANCE_SECONDS`` (0.05s); twice that keeps every such layer inside
#: its reach. Keeping an extra clip costs one reader; missing one would cost a wrong frame.
REACH_SLACK_SECONDS = 0.1


@dataclass(frozen=True)
class PictureWindow:
    """The clips a composite at ``time`` must build; nothing outside it can be playing then."""

    time: float
    clip_ids: frozenset[str]


def clip_reach(clip: Clip, kind: str) -> tuple[float, float]:
    """``[start, end)`` timeline seconds within which a picture layer of ``clip`` can play.

    Every layer the compiler builds for a clip starts at or after ``clip.start``: its own
    layer is placed at ``clip.start``, and a transition's under-layer sits inside the clip's
    span (``frame_plan.transition_underlay_window``). A still, title, shape or caption plays
    for exactly ``end - start``. A VIDEO clip's own layer does not always: at the natural rate
    it plays for its SOURCE span (``_subclipped_source``), which a hand-edited or legacy
    document may not have kept equal to the timeline span. A ramp, freeze or other speed is
    fitted to ``end - start`` (exactly, or within the compiler's tolerance). A video clip with
    no source out-point plays to the end of its asset, whose length is only known once a reader
    opens, so it reaches forever.

    :param clip: A picture clip (video, still, title, shape, caption).
    :param kind: Its render kind (``frame_plan.clip_kind``).
    :returns: The reach, widened by :data:`REACH_SLACK_SECONDS` on both sides.
    """
    end = float(clip.end)
    natural_rate = not has_speed_ramp(clip) and (clip.speed is None or clip.speed == 1.0)
    if kind == "video" and natural_rate:
        if clip.source_end is None:
            end = math.inf
        else:
            source_span = float(clip.source_end) - float(clip.source_start)
            end = max(end, float(clip.start) + source_span)
    return float(clip.start) - REACH_SLACK_SECONDS, end + REACH_SLACK_SECONDS


def whole_timeline_reason(project: Project) -> str | None:
    """Why no frame of ``project`` can be composited from a window, or ``None`` if one can.

    A blended burned caption composites over the whole picture, held past its end; it is refused
    here. A blended picture layer is decided per instant by the windowed compile itself (see the
    module note).
    """
    for track in project.timeline.tracks:
        if track.type != TrackType.CAPTION:
            continue
        for clip in track.clips:
            mode = clip.blend_mode
            if mode is not None and mode != "normal":
                return f"caption {clip.id} uses the {mode} blend mode"
    return None


def picture_window_at(
    project: Project, time: float, asset_kinds: Mapping[str, str | None]
) -> PictureWindow | None:
    """The clips whose layers can be playing at ``time``, or ``None`` to compile everything.

    ``None`` when the project uses a construct the window cannot reproduce exactly
    (:func:`whole_timeline_reason`) or when no picture clip reaches ``time`` — a frame in a
    gap is black under the effect layers and captions, and the full compile is the only one
    that knows how long its own picture runs (a frosted caption past the picture's end holds
    that picture's last frame).

    :param project: The project being grabbed.
    :param time: Timeline seconds of the frame.
    :param asset_kinds: Asset id to kind, as the compile will read it (the asset index's kinds).
    """
    if whole_timeline_reason(project) is not None:
        return None
    wanted: set[str] = set()
    for track in project.timeline.tracks:
        if track.hidden:
            continue
        for clip in track.clips:
            kind = clip_kind(clip, asset_kinds)
            if kind not in WINDOWED_KINDS:
                continue
            start, end = clip_reach(clip, kind)
            if start <= time < end:
                wanted.add(clip.id)
    if not wanted:
        return None
    for track in caption_tracks(project):
        for clip in track.clips:
            start, end = clip_reach(clip, "caption")
            if start <= time < end:
                wanted.add(clip.id)
    return PictureWindow(time=float(time), clip_ids=frozenset(wanted))
