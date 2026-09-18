"""Eval fixtures: construction-true clips and human-labelled clips (plan 06 "Fixture set").

Two kinds of ground truth, never mixed up in a report:

* **construction** — the BR3.15 pilot (``eval/pilot.py``): a subject with known alpha composited
  over real footage, so every frame has exact ground truth (``gt_alpha.npz``).
* **human** — MO-8's real camera clips with alpha keyframes every 0.5 s. A label counts only when
  it is marked ``"humanVerified": true``; a machine-proposed label is listed and ignored (the
  ``tier2.json`` lesson: a model's guess is not ground truth). Only labelled frames are scored.

Human fixture layout (``tests/fixtures/background-removal/<name>/`` or ``--fixtures DIR``)::

    meta.json    {"category", "split", "fps", "frames", "width", "height",
                  "box": {x, y, width, height} (first-frame subject box, the auto prompt),
                  "groundTruth": "human", "licence": {...}}
    frames.mkv   the clip (decoded with the worker's own pts semantics)
    labels.json  {"labels": [{"frame": 12, "file": "labels/000012.png",
                              "humanVerified": true, "labeller": "...", "date": "..."}]}
    labels/*.png 8-bit grayscale alpha at the clip's display size

A fixture's ``split`` is ``calibration`` (verify thresholds are fitted there) or ``scored``
(reported numbers come only from there).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import cv2
import numpy as np
import numpy.typing as npt

GroundTruth = Literal["construction", "human"]
SPLITS = ("calibration", "scored")


class FixtureError(ValueError):
    """A fixture directory that cannot be scored honestly (named, never silently skipped)."""


@dataclass
class Fixture:
    name: str
    directory: Path
    category: str
    split: str
    ground_truth: GroundTruth
    frames: int
    fps: float
    width: int
    height: int
    box: dict[str, float]
    licence: dict[str, Any]
    #: Frame index → label PNG (human fixtures only).
    labels: dict[int, Path] = field(default_factory=dict)
    #: Labels present but not marked human-verified: listed in the report, never scored.
    ignored_labels: list[dict[str, Any]] = field(default_factory=list)
    _truth: npt.NDArray[np.uint8] | None = None

    @property
    def clip(self) -> Path:
        return self.directory / "frames.mkv"

    def scored_frames(self) -> list[int]:
        """Frames with ground truth: every frame by construction, labelled keyframes otherwise."""
        if self.ground_truth == "construction":
            return list(range(self.frames))
        return sorted(self.labels)

    def truth(self, index: int) -> npt.NDArray[np.uint8]:
        """Ground-truth alpha (uint8) for a frame in :meth:`scored_frames`."""
        if self.ground_truth == "construction":
            if self._truth is None:
                self._truth = np.load(self.directory / "gt_alpha.npz")["alpha"]
            return self._truth[index]
        path = self.labels.get(index)
        if path is None:
            raise FixtureError(f"{self.name}: frame {index} has no human-verified label.")
        image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if image is None or image.dtype != np.uint8 or image.ndim != 2:
            raise FixtureError(f"{self.name}: label {path.name} is not an 8-bit grayscale PNG.")
        if image.shape != (self.height, self.width):
            raise FixtureError(f"{self.name}: label {path.name} is not {self.width}x{self.height}.")
        label: npt.NDArray[np.uint8] = image
        return label


def _meta(directory: Path) -> dict[str, Any]:
    meta: dict[str, Any] = json.loads((directory / "meta.json").read_text())
    for key in ("category", "split", "fps", "frames", "width", "height", "box"):
        if key not in meta:
            raise FixtureError(f"{directory.name}: meta.json is missing {key!r}.")
    if meta["split"] not in SPLITS:
        raise FixtureError(f"{directory.name}: split must be one of {SPLITS}.")
    return meta


def load_fixture(directory: Path) -> Fixture:
    """Read one fixture directory. Raises :class:`FixtureError` on anything unscorable."""
    meta = _meta(directory)
    declared = meta.get("groundTruth")
    if declared is None:
        # The BR3.15 pilot predates the field; it is construction-true by definition.
        if not (directory / "gt_alpha.npz").is_file():
            raise FixtureError(f"{directory.name}: no groundTruth field and no gt_alpha.npz.")
        declared = "construction"
    if declared not in ("construction", "human"):
        raise FixtureError(f"{directory.name}: groundTruth must be construction or human.")
    fixture = Fixture(
        name=directory.name,
        directory=directory,
        category=str(meta["category"]),
        split=str(meta["split"]),
        ground_truth=declared,
        frames=int(meta["frames"]),
        fps=float(meta["fps"]),
        width=int(meta["width"]),
        height=int(meta["height"]),
        box=dict(meta["box"]),
        licence=dict(meta.get("licence", {})),
    )
    if declared == "human":
        labels = json.loads((directory / "labels.json").read_text()).get("labels", [])
        for entry in labels:
            frame = int(entry["frame"])
            if not 0 <= frame < fixture.frames:
                raise FixtureError(f"{directory.name}: label frame {frame} is outside the clip.")
            if entry.get("humanVerified") is not True:
                fixture.ignored_labels.append(
                    {"frame": frame, "reason": "not marked humanVerified"}
                )
                continue
            path = (directory / str(entry["file"])).resolve()
            if directory.resolve() not in path.parents or not path.is_file():
                raise FixtureError(f"{directory.name}: label file {entry['file']!r} is missing.")
            fixture.labels[frame] = path
        if not fixture.labels:
            raise FixtureError(f"{directory.name}: no human-verified labels.")
    return fixture


def discover(roots: list[Path]) -> tuple[list[Fixture], list[dict[str, str]]]:
    """Every fixture under ``roots`` (one level), plus the directories refused and why."""
    fixtures: list[Fixture] = []
    refused: list[dict[str, str]] = []
    seen: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for directory in sorted(path for path in root.iterdir() if (path / "meta.json").is_file()):
            try:
                fixture = load_fixture(directory)
            except (FixtureError, KeyError, ValueError, json.JSONDecodeError) as error:
                refused.append({"name": directory.name, "reason": str(error)})
                continue
            if fixture.name in seen:
                refused.append({"name": fixture.name, "reason": "duplicate fixture name"})
                continue
            seen.add(fixture.name)
            fixtures.append(fixture)
    return fixtures, refused


__all__ = ["Fixture", "FixtureError", "GroundTruth", "discover", "load_fixture"]
