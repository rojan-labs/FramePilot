"""Scene-cut analysis via ffmpeg scene scoring (plan Phase 9.2).

WHY: "split into scenes" / "add a cut on every scene change" edits need to know
*where* the hard cuts are. The engine runs ffmpeg's ``select`` filter with the
``scene`` score expression and ``showinfo`` to emit the presentation timestamp of
every frame whose scene score exceeds a threshold, then reduces those log lines to
a list of typed :class:`SceneCut`s.

This is an ANALYSIS capability — it returns data and never mutates the timeline.
Following :mod:`framepilot_engine.validation.render_validation`, the log
**parser** is pure (unit-testable without ffmpeg) and the subprocess call takes
an injectable :data:`framepilot_engine.media.ffmpeg.Runner`.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import Runner, find_ffmpeg, run_logs

# With ``select='gt(scene,THRESH)',showinfo`` ffmpeg prints one showinfo line per
# selected frame on stderr, carrying the frame's presentation time:
#   [Parsed_showinfo_1 @ 0x..] n:0 pts:370688 pts_time:12.3456 duration:... ...
_PTS_TIME_RE = re.compile(r"pts_time:\s*(-?\d+(?:\.\d+)?)")

#: Default scene-score threshold (0..1). ffmpeg's ``scene`` score is the fraction
#: of the frame that changed; 0.4 is a reasonable default for hard cuts.
DEFAULT_SCENE_THRESHOLD = 0.4


class SceneCut(BaseModel):
    """One detected scene boundary (the timestamp of the first frame of a shot)."""

    time: float = Field(ge=0.0, description="Scene-cut time in seconds.")


def parse_scene_changes(logs: str) -> list[SceneCut]:
    """Reduce ffmpeg ``showinfo`` stderr to scene-cut timestamps (pure).

    Extracts the ``pts_time`` of every showinfo line (each corresponds to a frame
    that passed the ``select`` scene-score gate), normalising a negative time to 0
    and returning cuts in ascending order.

    :param logs: ffmpeg stderr text.
    :returns: The detected scene cuts in time order.
    """
    times = sorted(max(0.0, float(m)) for m in _PTS_TIME_RE.findall(logs))
    return [SceneCut(time=t) for t in times]


def detect_scenes(
    path: Path,
    *,
    threshold: float = DEFAULT_SCENE_THRESHOLD,
    runner: Runner | None = None,
    timeout: float | None = 60.0,
) -> list[SceneCut]:
    """Run ffmpeg scene scoring on ``path`` and return the scene-cut timestamps.

    :param path: Media file to analyse (assumed already sandbox-resolved).
    :param threshold: Scene-score threshold in [0, 1]; higher = fewer, harder cuts.
    :param runner: ffmpeg stderr runner; defaults to the real subprocess runner.
    :param timeout: Per-call timeout in seconds (bounds the subprocess).
    :returns: The detected scene cuts.
    """
    invoke = runner or (lambda argv: run_logs(argv, timeout=timeout))
    argv = [
        find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-vf",
        f"select='gt(scene,{threshold})',showinfo",
        "-an",
        "-f",
        "null",
        "-",
    ]
    return parse_scene_changes(invoke(argv))
