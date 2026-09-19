"""``report.json``: what the pipeline did and measured, per frame and per job.

Small, deterministic (sorted keys, no timestamps beyond the job's own durations), written
through the output directory so only the declared name is created. It carries no media
paths, prompts or pixels (BR4.11 observability rule): frame pts, scores, check results, rounds,
execution providers, tile size, memory ceiling and fallbacks.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Final

from . import MATTE_PIPELINE_VERSION, PACK_VERSION

REPORT_VERSION: Final = 1


def _clean(value: Any) -> Any:
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return round(value, 6)
    if isinstance(value, dict):
        return {str(key): _clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item) for item in value]
    return value


def build_report(
    *,
    frames: list[dict[str, Any]],
    job: dict[str, Any],
) -> dict[str, Any]:
    report: dict[str, Any] = _clean(
        {
            "version": REPORT_VERSION,
            "packVersion": PACK_VERSION,
            "pipelineVersion": MATTE_PIPELINE_VERSION,
            "job": job,
            "frames": frames,
        }
    )
    return report


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(report, separators=(",", ":"), sort_keys=True, allow_nan=False), encoding="utf-8"
    )


__all__ = ["build_report", "write_report"]
