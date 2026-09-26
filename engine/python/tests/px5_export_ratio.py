"""Measure the PX5 export budgets: a feature's cost to an export, against the timeline without.

Budgets, each against ONE plain export of the Scale fixture:

* ``scale`` - masks and a decontaminating 4K matte cost <= 1.5x
  (P13, ``plan/background-removal-ai/06-PRECISION-AND-EVAL.md``, "Production budgets");
* ``scale-elements`` - 20 sticker layers (five outlined, five turning) cost <= 1.3x
  (``plan/elements/05-RENDER-AND-PREVIEW.md`` section 7).

Needs ``pnpm px5:fixture`` first::

    pnpm px5:export-ratio                           # == uv run python -m tests.px5_export_ratio
    pnpm px5:export-ratio --variants scale-elements # the elements only
    pnpm px5:export-ratio --window-seconds 180      # the whole row (hours on a small runner)

It exports ``scale-plain`` once, then each compared variant, through the real ``export_video``
path at 4K, and reports each export's wall and CPU time and each comparison's ratio against the
plain one. Every variant is ``scale-plain`` plus exactly one feature
(``px5_scale_fixture.scale_project``), so one plain export is the baseline for all of them.

**Why a window by default.** The export's cost is per frame and the timeline is uniform (every
frame composites the same layers), so the ratio of a 10-second window is close to the ratio of the
row; the full 5,400 4K frames per export is hours. The window is the head of the timeline, trimmed
on every clip. A short window reads high: an export's fixed costs (opening every reader and every
sticker, the encoder's start) weigh more against 4 seconds of frames, which put CI's 4-second
matte ratios at 1.32-1.45x against 1.32x for the whole row (PX5.11). ``--window-seconds 180``
measures the row itself (``.github/workflows/preview-perf-full.yml``).

**Memory.** A composition holds an ffmpeg reader per clip; at 4K that is gigabytes. One export
at a time, each in its own process (``--child``), so the next starts from a clean heap. On a
workstation run it under ``workers/smart-mask/spike/watchdog.py``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import resource
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = REPO_ROOT / "tests" / "e2e" / ".tmp-px5-scale"
#: The export every comparison is measured against: the row with no masks and no elements.
BASELINE = "scale-plain"


@dataclass(frozen=True)
class Comparison:
    """One variant measured against the baseline: what it adds, and the most that may cost."""

    adds: str
    #: The largest allowed ``variant / baseline`` export time.
    budget: float


COMPARISONS: dict[str, Comparison] = {
    "scale": Comparison(adds="masks + a decontaminating 4K matte", budget=1.5),
    "scale-elements": Comparison(adds="20 sticker layers, 5 outlined, 5 turning", budget=1.3),
}
VARIANTS = (BASELINE, *COMPARISONS)


def exports_for(compared: Sequence[str]) -> tuple[str, ...]:
    """The exports a run makes, in order: the baseline once, then each compared variant once."""
    return (BASELINE, *(variant for variant in COMPARISONS if variant in compared))


def summarise(
    runs: Mapping[str, Mapping[str, Any]], *, window_seconds: float, machine: str
) -> dict[str, Any]:
    """The result a run reports: every export, and each comparison against the one baseline.

    ``withinBudget`` is judged on the exact ratio; the reported ratio is rounded to three places,
    so a miss by less than that still reads as a miss.
    """
    baseline = runs[BASELINE]
    comparisons: dict[str, dict[str, Any]] = {}
    for variant, comparison in COMPARISONS.items():
        run = runs.get(variant)
        if run is None:
            continue
        ratio = float(run["seconds"]) / float(baseline["seconds"])
        cpu_ratio = float(run["cpuSeconds"]) / max(float(baseline["cpuSeconds"]), 1e-9)
        comparisons[variant] = {
            "adds": comparison.adds,
            "against": BASELINE,
            "ratio": round(ratio, 3),
            "cpuRatio": round(cpu_ratio, 3),
            "budget": comparison.budget,
            "withinBudget": ratio <= comparison.budget,
        }
    return {
        "machine": machine,
        "windowSeconds": window_seconds,
        "baseline": BASELINE,
        "runs": dict(runs),
        "comparisons": comparisons,
    }


def over_budget(result: Mapping[str, Any]) -> list[str]:
    """The compared variants whose export cost more than their budget allows."""
    return [
        variant
        for variant, comparison in result["comparisons"].items()
        if not comparison["withinBudget"]
    ]


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--window-seconds", type=float, default=10.0)
    parser.add_argument(
        "--variants",
        nargs="+",
        choices=tuple(COMPARISONS),
        default=list(COMPARISONS),
        help=f"what to compare against {BASELINE}, which is exported once for all of them",
    )
    parser.add_argument(
        "--assert-budget",
        action="store_true",
        help="exit 1 when any compared variant is over its own budget",
    )
    parser.add_argument("--child", choices=VARIANTS, default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "--profile",
        choices=VARIANTS,
        default=None,
        help="cProfile ONE variant's export and print the engine's hottest functions",
    )
    return parser


def _export_in_child(fixture: Path, variant: str, window_seconds: float) -> dict[str, Any] | None:
    """One export in its own process, with the CPU its process tree spent; None if it failed."""
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    child = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--fixture",
            str(fixture),
            "--window-seconds",
            str(window_seconds),
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
        return None
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    run: dict[str, Any] = json.loads(line.removeprefix("PX5_EXPORT "))
    # CPU seconds of the export's whole process tree (its ffmpeg decoders included): on a
    # shared machine wall time moves with everyone else's load, CPU time far less.
    run["cpuSeconds"] = round(
        (after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime), 2
    )
    run["loadAverageAfter"] = [round(value, 1) for value in os.getloadavg()]
    return run


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
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
    for variant in exports_for(args.variants):
        run = _export_in_child(args.fixture, variant, args.window_seconds)
        if run is None:
            return 1
        runs[variant] = run
        # Each arm as soon as it lands: a long window killed by a memory watchdog during a later
        # export still leaves the earlier ones' numbers in the log.
        print("PX5_ARM " + json.dumps(run), flush=True)
    result = summarise(
        runs,
        window_seconds=args.window_seconds,
        machine=f"{platform.system()} {platform.machine()}",
    )
    (args.fixture / "results" / "export-ratio.json").write_text(
        json.dumps(result, indent=1) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, indent=1))
    missed = over_budget(result)
    if args.assert_budget and missed:
        print(f"over budget: {', '.join(missed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
