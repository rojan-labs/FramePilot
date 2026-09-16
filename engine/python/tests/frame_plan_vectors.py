"""Write the engine's frame plans into ``tests/fixtures/frame-plan/*.json`` (PX1.3).

The Python side of the ``frame_plan.py`` <-> ``frame-plan.ts`` parity pair: the engine is the
export, so its plan is the expected value, and the TypeScript twin is asserted against what
this writes. Run it after a deliberate change to either implementation::

    pnpm frame-plan:vectors

``test_frame_plan.py`` fails when the stored vectors no longer match the engine, and
``frame-plan.test.ts`` fails when they no longer match TypeScript, so neither side can move
without the vectors (and therefore the other side) being brought along.
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

FIXTURE_DIR = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "frame-plan"


def fixture_files() -> list[Path]:
    """Every vector file, in a stable order."""
    return sorted(FIXTURE_DIR.glob("*.json"))


def expected_plans(case: dict[str, Any]) -> list[dict[str, Any]]:
    """The engine's plan at each of a case's sample times."""
    project = Project.model_validate(case["project"])
    fps = {asset_id: float(rate) for asset_id, rate in case["probe"]["fps"].items()}
    return [
        frame_plan_at(
            project, float(t), burn_captions=bool(case["burnCaptions"]), source_fps=fps
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
    for path in fixture_files():
        document = regenerate(path)
        path.write_text(serialize(document), encoding="utf-8")
        _log.info("wrote %s (%d cases)", path.name, len(document["cases"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
