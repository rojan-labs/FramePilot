"""BR7.4: turn the eval workflow's dispatch inputs into its job matrix (pure; unit-tested).

One job per (variant, clip): a 2048² BiRefNet run of one 32-frame 720p clip is about an hour on
a 4-vCPU runner, so jobs run in parallel and a failure costs one clip, not the report.

* ``auto``      every category, both splits (the calibration split fits verify's thresholds)
* ``click``     every category, scored split (06's one-click gates)
* ``ablations`` ``band_off`` + ``fp32`` on ``hair_busy`` scored (06 band gate) and ``stab_off``
                on every scored category (06 dtSSD gate)
* ``replay``    correction convergence on ``replay_categories`` (scored; needs the auto run)
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

#: The pilot's categories (eval/pilot.py ``specs``), kept here so planning needs no numpy.
CATEGORIES = (
    "crossing",
    "fast_motion",
    "hair_busy",
    "leave_reenter",
    "low_light",
    "product_table",
    "similar_colour",
    "talking_head",
    "twin_distractor",
    "walk_pan",
)
SPLITS = ("calibration", "scored")
#: ``click_calibration`` (never in the default) runs one-click on the calibration split, so a
#: click rule can be fitted there instead of on the scored clips that judge the gate.
SUITES = ("auto", "click", "click_calibration", "ablations", "replay")
DEFAULT_SUITES = ("auto", "click", "ablations", "replay")


def _words(text: str) -> list[str]:
    return [word for word in text.replace(",", " ").split() if word]


def _pick(requested: str, allowed: tuple[str, ...], what: str) -> list[str]:
    chosen = _words(requested) or list(allowed)
    unknown = sorted(set(chosen) - set(allowed))
    if unknown:
        raise SystemExit(f"unknown {what}: {unknown}; choose from {list(allowed)}")
    return [item for item in allowed if item in chosen]


def plan(suites: str, categories: str, splits: str, replay_categories: str) -> dict[str, Any]:
    """``{"eval": [{variant, clip, category, split}], "replay": [{clip, category}]}``."""
    chosen_suites = _pick(suites, SUITES, "suites") if _words(suites) else list(DEFAULT_SUITES)
    chosen = _pick(categories, CATEGORIES, "categories")
    chosen_splits = _pick(splits, SPLITS, "splits")
    runs: list[dict[str, str]] = []

    def add(variant: str, category: str, split: str) -> None:
        runs.append({"variant": variant, "clip": f"{category}__{split}", "category": category,
                     "split": split})  # fmt: skip

    if "auto" in chosen_suites:
        for split in chosen_splits:
            for category in chosen:
                add("auto", category, split)
    if "click" in chosen_suites and "scored" in chosen_splits:
        for category in chosen:
            add("click", category, "scored")
    if "click_calibration" in chosen_suites and "calibration" in chosen_splits:
        for category in chosen:
            add("click", category, "calibration")
    if "ablations" in chosen_suites and "scored" in chosen_splits:
        if "hair_busy" in chosen:
            add("band_off", "hair_busy", "scored")
            add("fp32", "hair_busy", "scored")
        for category in chosen:
            add("stab_off", category, "scored")
    replays: list[dict[str, str]] = []
    if "replay" in chosen_suites and "scored" in chosen_splits:
        for category in _pick(replay_categories, CATEGORIES, "replay categories"):
            if category in chosen:
                replays.append({"clip": f"{category}__scored", "category": category})
    return {"eval": runs, "replay": replays}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suites", default="")
    parser.add_argument("--categories", default="")
    parser.add_argument("--splits", default="")
    parser.add_argument("--replay-categories", default="")
    arguments = parser.parse_args(argv)
    planned = plan(
        arguments.suites, arguments.categories, arguments.splits, arguments.replay_categories
    )
    # GitHub Actions output lines: a matrix may not be empty, so an empty plan is an error.
    if not planned["eval"]:
        raise SystemExit("nothing to run for these inputs")
    sys.stdout.write(f"eval={json.dumps(planned['eval'])}\n")
    sys.stdout.write(f"replay={json.dumps(planned['replay'])}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
