"""Can each caption be read against the picture it is drawn over?

WHY THIS EXISTS. The captured 2026-09-23 short captioned its speaker in off-white
(``#F4F0EB``) with no outline and a soft shadow, over a cream t-shirt: the words are drawn,
timed and placed correctly, and they barely read. ``verify_captions`` checks timing from the
timeline and cannot see that; ``get_frame`` can, but only if the agent looks at the right cue
and judges it — the run never did. This measures it.

HOW. Each sampled cue is taken twice: the delivered frame through the export's own compositor
(``grab_frame``, lossless — the composition ``get_frame`` caches), and a KEYED frame — the
caption layers alone over black (``compiler.caption_overlay_frames``), every text colour
swapped for a key colour nothing else uses. Colour does not move a glyph, so the key-coloured
pixels are exactly the letters' FILL in the delivered frame, whatever colour they really are.
The keyed frame holds no media, so it costs a caption raster, not a second picture render
(the first version rendered the picture twice: over two minutes cold).
Legibility is how far the fill stands off what immediately surrounds it in the delivered
frame — a thin ring just outside the letters, skipping the anti-aliased edge. That ring is
whatever the reader's eye separates the letters from: an outline, a background box, a
shadow, or bare picture, so one measure covers every caption design without knowing which
it is. The score is the WCAG contrast ratio between the
two luminances; 3:1 is the WCAG minimum for large text, which captions are.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt
from PIL import Image

from framepilot_engine.render.compiler import caption_overlay_frames
from framepilot_engine.render.frame_grab import DEFAULT_MAX_DIMENSION, grab_frame
from framepilot_engine.timeline.models import CaptionStyle, Clip, Project, Track

_log = logging.getLogger(__name__)

#: WCAG 2 minimum contrast for large text; a caption below it is hard to read at a glance.
LEGIBLE_CONTRAST = 3.0
#: Longest edge the frames are composited at — ``get_frame``'s own default, so the captioned
#: composition is usually already compiled and cached by the agent's own looks. Verdicts at
#: 540 and 720 px agreed on the captured project to a few hundredths.
MEASURE_DIMENSION = DEFAULT_MAX_DIMENSION
#: The colour every caption's text is drawn in for the keyed frame: nothing else is magenta.
KEY_COLOR = "#FF00FF"
_KEY_RGB = (255, 0, 255)
#: RGB distance from the key colour that still counts as fill (anti-aliased edges do not).
FILL_DISTANCE = 90.0
#: Fewest fill pixels worth measuring; fewer means the cue is not on screen at that time.
MIN_FILL_PIXELS = 40
#: The ring around the letters: from just past the anti-aliased edge out to this many px.
RING_INNER_PX = 1
RING_OUTER_PX = 3
#: Cues sampled when the caller names no times: spread over the edit, one per cue.
DEFAULT_SAMPLES = 4
MAX_SAMPLES = 8


class CaptionLegibilityError(ValueError):
    """The check cannot run; the message says why and what to do instead."""


@dataclass(frozen=True)
class CueLegibility:
    """One sampled cue: how well its letters stand off what is behind them."""

    time: float
    clip_id: str
    text: str
    #: Fill-to-surround contrast ratio (1 = invisible, 21 = black on white). ``None`` when
    #: nothing of the caption was drawn at this time.
    contrast: float | None
    #: WCAG relative luminance (0-1) of the letters' fill and of their surround.
    fill_luminance: float | None
    surround_luminance: float | None
    #: Where the caption's pixels are, ``(x0, y0, x1, y1)`` in frame fractions.
    box: tuple[float, float, float, float] | None

    @property
    def legible(self) -> bool:
        return self.contrast is not None and self.contrast >= LEGIBLE_CONTRAST


def _srgb_to_linear(channel: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    scaled = channel / 255.0
    return np.where(scaled <= 0.04045, scaled / 12.92, ((scaled + 0.055) / 1.055) ** 2.4)


def relative_luminance(rgb: npt.NDArray[np.uint8]) -> npt.NDArray[np.float64]:
    """WCAG 2 relative luminance of each RGB pixel (last axis = channels)."""
    linear = _srgb_to_linear(rgb[..., :3].astype(np.float64))
    return 0.2126 * linear[..., 0] + 0.7152 * linear[..., 1] + 0.0722 * linear[..., 2]


def contrast_ratio(first: float, second: float) -> float:
    """WCAG 2 contrast ratio between two relative luminances."""
    light, dark = max(first, second), min(first, second)
    return (light + 0.05) / (dark + 0.05)


def _dilate(mask: npt.NDArray[np.bool_], radius: int) -> npt.NDArray[np.bool_]:
    """Grow ``mask`` by ``radius`` pixels (8-connected), without a SciPy dependency."""
    grown = mask.copy()
    for _ in range(radius):
        padded = np.pad(grown, 1)
        grown = (
            padded[1:-1, 1:-1]
            | padded[:-2, 1:-1]
            | padded[2:, 1:-1]
            | padded[1:-1, :-2]
            | padded[1:-1, 2:]
            | padded[:-2, :-2]
            | padded[:-2, 2:]
            | padded[2:, :-2]
            | padded[2:, 2:]
        )
    return grown


def measure_caption_pixels(
    delivered: npt.NDArray[np.uint8], keyed: npt.NDArray[np.uint8]
) -> tuple[float, float, float, tuple[float, float, float, float]] | None:
    """``(contrast, fill luminance, surround luminance, box)`` for one frame pair, or ``None``.

    :param delivered: The frame as exported, captions burned in (RGB).
    :param keyed: The same instant with only the captions, their text in :data:`KEY_COLOR`.
    """
    distance = np.sqrt(((keyed[..., :3].astype(np.float64) - np.array(_KEY_RGB)) ** 2).sum(axis=2))
    fill = distance < FILL_DISTANCE
    if int(fill.sum()) < MIN_FILL_PIXELS:
        return None
    ring = _dilate(fill, RING_OUTER_PX) & ~_dilate(fill, RING_INNER_PX)
    if not ring.any():  # pragma: no cover - a fill always has an outside at these radii
        return None
    luminance = relative_luminance(delivered)
    fill_lum = float(np.median(luminance[fill]))
    ring_lum = float(np.median(luminance[ring]))
    rows = np.nonzero(fill.any(axis=1))[0]
    cols = np.nonzero(fill.any(axis=0))[0]
    height, width = fill.shape
    box = (
        round(float(cols[0]) / width, 3),
        round(float(rows[0]) / height, 3),
        round(float(cols[-1] + 1) / width, 3),
        round(float(rows[-1] + 1) / height, 3),
    )
    return contrast_ratio(fill_lum, ring_lum), fill_lum, ring_lum, box


def _keyed(style: CaptionStyle | None) -> CaptionStyle:
    # Solid letters in the keyed frame, whatever the style's `textOpacity` (schema v24):
    # the key finds WHERE the letters are, and a see-through letter drawn in a
    # translucent key colour would fall outside the key's colour distance and vanish.
    # How well a see-through letter reads is still judged on the delivered frame.
    return (style or CaptionStyle()).model_copy(
        update={"text_color": KEY_COLOR, "text_opacity": 1.0}
    )


def keyed_captions_project(project: Project) -> Project:
    """The project with only its visible caption tracks, every text colour :data:`KEY_COLOR`."""
    tracks: list[Track] = []
    for track in project.timeline.tracks:
        if track.type != "caption" or track.hidden:
            continue
        clips = [
            clip.model_copy(update={"caption_style": _keyed(clip.caption_style)})
            if clip.caption_style is not None
            else clip
            for clip in track.clips
        ]
        tracks.append(
            track.model_copy(update={"caption_style": _keyed(track.caption_style), "clips": clips})
        )
    timeline = project.timeline.model_copy(update={"tracks": tracks})
    return project.model_copy(update={"timeline": timeline})


def _caption_cues(project: Project) -> list[tuple[Track, Clip]]:
    return sorted(
        (
            (track, clip)
            for track in project.timeline.tracks
            if track.type == "caption" and not getattr(track, "hidden", False)
            for clip in track.clips
            if clip.end > clip.start
        ),
        key=lambda pair: pair[1].start,
    )


def _sampled(cues: list[tuple[Track, Clip]], count: int) -> list[tuple[Track, Clip]]:
    if len(cues) <= count:
        return cues
    step = (len(cues) - 1) / max(1, count - 1)
    return [cues[round(i * step)] for i in range(count)]


def _cue_text(clip: Clip) -> str:
    cue = getattr(clip, "caption_cue", None)
    return str(getattr(cue, "text", "") or "")


def _decode(png: bytes) -> npt.NDArray[np.uint8]:
    return np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), dtype=np.uint8)


def check_caption_legibility(
    project: Project,
    base_dir: Path,
    *,
    times: list[float] | None = None,
    samples: int = DEFAULT_SAMPLES,
) -> list[CueLegibility]:
    """Measure how well the captions read against the picture, cue by cue.

    :param project: The working project.
    :param base_dir: The project directory the media is resolved against.
    :param times: Timeline seconds to check; default: ``samples`` cues spread over the edit,
        each at its midpoint.
    :param samples: How many cues to sample when ``times`` is not given.
    :raises CaptionLegibilityError: No visible caption track has a cue.
    """
    cues = _caption_cues(project)
    if not cues:
        raise CaptionLegibilityError(
            "There are no captions to check: no visible caption track has a cue. Caption the "
            "edit first (caption_the_edit)."
        )
    if times is None:
        chosen = _sampled(cues, max(1, min(MAX_SAMPLES, int(samples))))
        points = [(clip.start + clip.end) / 2 for _track, clip in chosen]
    else:
        points = [float(t) for t in times[:MAX_SAMPLES]]
    delivered: dict[float, npt.NDArray[np.uint8]] = {}
    for point in points:
        if any(c.start <= point < c.end for _t, c in cues):
            delivered[point] = _decode(
                grab_frame(
                    project,
                    base_dir,
                    point,
                    max_dimension=MEASURE_DIMENSION,
                    image_format="png",
                    burn_captions=True,
                ).data
            )
    keyed: dict[float, npt.NDArray[np.uint8]] = {}
    if delivered:
        height, width = next(iter(delivered.values())).shape[:2]
        drawn = caption_overlay_frames(
            keyed_captions_project(project), (width, height), list(delivered)
        )
        keyed = dict(zip(delivered, drawn, strict=True))
    results: list[CueLegibility] = []
    for point in points:
        active = next(((t, c) for t, c in cues if c.start <= point < c.end), None)
        if active is None or point not in delivered:
            results.append(CueLegibility(point, "", "", None, None, None, None))
            continue
        _track, clip = active
        measured = measure_caption_pixels(delivered[point], keyed[point])
        results.append(
            CueLegibility(
                time=round(point, 3),
                clip_id=clip.id,
                text=_cue_text(clip),
                contrast=None if measured is None else round(measured[0], 2),
                fill_luminance=None if measured is None else round(measured[1], 3),
                surround_luminance=None if measured is None else round(measured[2], 3),
                box=None if measured is None else measured[3],
            )
        )
    _log.info(
        "ACT caption legibility: %d cue(s) checked, %d below %.1f:1",
        len(results),
        sum(1 for r in results if r.contrast is not None and not r.legible),
        LEGIBLE_CONTRAST,
    )
    return results
