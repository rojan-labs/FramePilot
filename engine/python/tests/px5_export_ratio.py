"""Measure the PX5/P13 export budget: masks and 4K mattes cost <= 1.5x the same timeline without.

Budget: ``plan/background-removal-ai/06-PRECISION-AND-EVAL.md`` ("Production budgets", Scale
fixture). Needs ``pnpm px5:fixture`` first::

    pnpm px5:export-ratio                       # == uv run python -m tests.px5_export_ratio
    pnpm px5:export-ratio --window-seconds 180  # the whole row (hours on a small runner)

It exports two projects of the fixture through the real ``export_video`` path at 4K:
``scale`` (4 layers + text + a decontaminating 4K matte) and ``scale-plain`` (the same
timeline, no masks), and reports wall time each and their ratio.

**Why a window by default.** The export's cost is per frame and the timeline is uniform (every
frame composites the same four layers and the same matte), so the ratio of a 10-second window
is the ratio of the row; the full 5,400 4K frames twice is hours. The window is the head of the
timeline, trimmed on every clip. ``--window-seconds 180`` measures the row itself.

**Memory.** A composition holds an ffmpeg reader per clip; at 4K that is gigabytes. One export
at a time, each in its own process (``--child``), so the second starts from a clean heap. On a
workstation run it under ``workers/smart-mask/spike/watchdog.py``.
"""

from __future__ import annotations

import argparse
import json
import logging
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = REPO_ROOT / "tests" / "e2e" / ".tmp-px5-scale"
BUDGET_RATIO = 1.5
VARIANTS = ("scale-plain", "scale")


def windowed(project: dict[str, Any], seconds: float) -> dict[str, Any]:
    """The project's first ``seconds``: every clip trimmed, nothing else changed."""
    for track in project["timeline"]["tracks"]:
        for clip in track["clips"]:
            clip["end"] = min(float(clip["end"]), seconds)
            clip["sourceEnd"] = min(float(clip["sourceEnd"]), seconds)
    return project


def export_once(fixture: Path, variant: str, seconds: float) -> dict[str, Any]:
    from framepilot_engine.render.export_settings import ExportSettings
    from framepilot_engine.render.pipeline import RenderState, export_video
    from framepilot_engine.timeline.models import Project

    document = json.loads((fixture / "projects" / f"{variant}.json").read_text(encoding="utf-8"))
    project = Project.model_validate(windowed(document, seconds))
    output = f"results/export-{variant}.mp4"
    (fixture / "results").mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    job = export_video(
        project,
        base_dir=fixture,
        settings=ExportSettings(resolution="2160p"),
        output_path=output,
    )
    elapsed = time.perf_counter() - started
    if job.state is not RenderState.COMPLETED:
        raise RuntimeError(f"{variant} export failed: {job.error} / {job.error_detail}")
    target = job.target
    (fixture / output).unlink(missing_ok=True)
    return {
        "variant": variant,
        "seconds": round(elapsed, 2),
        "target": None if target is None else [target.width, target.height, target.fps],
        "encoder": job.encoder,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--window-seconds", type=float, default=10.0)
    parser.add_argument("--assert-budget", action="store_true")
    parser.add_argument("--child", choices=VARIANTS, default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "--profile",
        choices=VARIANTS,
        default=None,
        help="cProfile ONE variant's export and print the engine's hottest functions",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    if not (args.fixture / "manifest.json").exists():
        print(f"no Scale fixture at {args.fixture}: run `pnpm px5:fixture` first")
        return 2
    if args.profile is not None:
        import cProfile
        import pstats

        profiler = cProfile.Profile()
        profiler.runcall(export_once, args.fixture, args.profile, args.window_seconds)
        stats = pstats.Stats(profiler).sort_stats("cumulative")
        stats.print_stats(r"framepilot_engine|numpy|PIL|scipy", 35)
        return 0
    if args.child is not None:
        print(
            "PX5_EXPORT " + json.dumps(export_once(args.fixture, args.child, args.window_seconds))
        )
        return 0

    runs: dict[str, Any] = {}
    for variant in VARIANTS:
        child = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--fixture",
                str(args.fixture),
                "--window-seconds",
                str(args.window_seconds),
                "--child",
                variant,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        line = next((ln for ln in child.stdout.splitlines() if ln.startswith("PX5_EXPORT ")), None)
        if child.returncode != 0 or line is None:
            print(child.stdout[-1500:], child.stderr[-1500:])
            return 1
        runs[variant] = json.loads(line.removeprefix("PX5_EXPORT "))
    ratio = runs["scale"]["seconds"] / runs["scale-plain"]["seconds"]
    result = {
        "machine": f"{platform.system()} {platform.machine()}",
        "windowSeconds": args.window_seconds,
        "runs": runs,
        "ratio": round(ratio, 3),
        "budget": BUDGET_RATIO,
        "withinBudget": ratio <= BUDGET_RATIO,
    }
    (args.fixture / "results" / "export-ratio.json").write_text(
        json.dumps(result, indent=1) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, indent=1))
    return 1 if args.assert_budget and not result["withinBudget"] else 0


if __name__ == "__main__":
    sys.exit(main())
