"""Write the engine's frame plans into ``tests/fixtures/frame-plan/*.json`` (PX1.3).

The Python side of the ``frame_plan.py`` <-> ``frame-plan.ts`` parity pair: the engine is the
export, so its plan is the expected value, and the TypeScript twin is asserted against what
this writes. Run it after a deliberate change to either implementation::

    pnpm frame-plan:vectors

``test_frame_plan.py`` fails when the stored vectors no longer match the engine, and
``frame-plan.test.ts`` fails when they no longer match TypeScript, so neither side can move
without the vectors (and therefore the other side) being brought along.

``packages/editor-core/fixtures/frame-plan-offset-units.json`` is written by the same command.
Its cases carry a ``target`` frame other than the project's (a frame grab, a review render), so
it pins how both sides convert keyframed ``x``/``y`` from project pixels. It lives apart from the
feature-matrix files because the preview-parity oracle and the PX0 inventory render every case
there at the project's own size.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

from framepilot_engine.render.frame_plan import frame_plan_at
from framepilot_engine.timeline.models import Project

_log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "frame-plan"
#: Cases planned at a ``target`` other than the project's frame (see the module docstring).
OFFSET_UNITS_FIXTURE = (
    REPO_ROOT / "packages" / "editor-core" / "fixtures" / "frame-plan-offset-units.json"
)


def fixture_files() -> list[Path]:
    """Every vector file, in a stable order."""
    return sorted(FIXTURE_DIR.glob("*.json"))


def _target(case: dict[str, Any]) -> tuple[int, int] | None:
    """The case's output frame when it is not the project's own (``None``: it is)."""
    target = case.get("target")
    return None if target is None else (int(target["width"]), int(target["height"]))


def expected_plans(case: dict[str, Any]) -> list[dict[str, Any]]:
    """The engine's plan at each of a case's sample times."""
    project = Project.model_validate(case["project"])
    fps = {asset_id: float(rate) for asset_id, rate in case["probe"]["fps"].items()}
    frame_times = {
        asset_id: [float(value) for value in values]
        for asset_id, values in case["probe"].get("frameTimes", {}).items()
    }
    return [
        frame_plan_at(
            project,
            float(t),
            target=_target(case),
            burn_captions=bool(case["burnCaptions"]),
            source_fps=fps,
            source_frame_times=frame_times,
        ).to_json()
        for t in case["samples"]
    ]


def regenerate(path: Path) -> dict[str, Any]:
    """The file's document with every case's ``expected`` recomputed (not written)."""
    document: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    for case in document["cases"]:
        case["expected"] = expected_plans(case)
    return document


def serialize(document: dict[str, Any]) -> str:
    """The on-disk form: two-space JSON with a trailing newline, as the fixtures are stored."""
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    for path in [*fixture_files(), OFFSET_UNITS_FIXTURE]:
        document = regenerate(path)
        path.write_text(serialize(document), encoding="utf-8")
        _log.info("wrote %s (%d cases)", path.name, len(document["cases"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
