"""The PX5 export-ratio script's bookkeeping (P13; plan/elements 05 section 7).

The exports themselves are minutes of 4K work each and run in CI's `preview-perf` job; these pin
what the script makes of them: one plain export is the baseline every comparison shares, and each
comparison is held to its own budget.
"""

from __future__ import annotations

from typing import Any

import pytest

from tests.px5_export_ratio import (
    BASELINE,
    COMPARISONS,
    build_parser,
    exports_for,
    over_budget,
    summarise,
)


def _run(variant: str, seconds: float, cpu_seconds: float) -> dict[str, Any]:
    return {"variant": variant, "seconds": seconds, "cpuSeconds": cpu_seconds}


def test_each_comparison_keeps_its_own_budget() -> None:
    assert BASELINE == "scale-plain"
    # The matte's P13 budget stays; 20 element layers get plan/elements 05 section 7's.
    assert COMPARISONS["scale"].budget == 1.5
    assert COMPARISONS["scale-elements"].budget == 1.3


def test_the_plain_row_is_exported_once_whatever_is_compared() -> None:
    assert exports_for(["scale", "scale-elements"]) == ("scale-plain", "scale", "scale-elements")
    assert exports_for(["scale-elements"]) == ("scale-plain", "scale-elements")
    assert exports_for(["scale-elements", "scale", "scale"]) == (
        "scale-plain",
        "scale",
        "scale-elements",
    )


def test_by_default_both_the_matte_and_the_elements_are_compared() -> None:
    assert build_parser().parse_args([]).variants == ["scale", "scale-elements"]
    assert build_parser().parse_args(["--variants", "scale-elements"]).variants == [
        "scale-elements"
    ]
    with pytest.raises(SystemExit):
        build_parser().parse_args(["--variants", "scale-plain"])


def test_every_export_is_compared_with_the_same_plain_run() -> None:
    runs = {
        "scale-plain": _run("scale-plain", 10.0, 20.0),
        "scale": _run("scale", 14.0, 24.0),
        "scale-elements": _run("scale-elements", 13.5, 25.0),
    }
    result = summarise(runs, window_seconds=4.0, machine="Linux x86_64")
    assert result["baseline"] == "scale-plain"
    assert result["windowSeconds"] == 4.0
    assert result["runs"] == runs
    assert result["comparisons"]["scale"] == {
        "adds": COMPARISONS["scale"].adds,
        "against": "scale-plain",
        "ratio": 1.4,
        "cpuRatio": 1.2,
        "budget": 1.5,
        "withinBudget": True,
    }
    elements = result["comparisons"]["scale-elements"]
    assert (elements["ratio"], elements["cpuRatio"]) == (1.35, 1.25)
    # 1.35 is inside the matte's 1.5 but not the elements' own 1.3.
    assert elements["withinBudget"] is False
    assert over_budget(result) == ["scale-elements"]


def test_a_run_of_the_elements_alone_reports_only_the_elements() -> None:
    runs = {
        "scale-plain": _run("scale-plain", 10.0, 20.0),
        "scale-elements": _run("scale-elements", 12.0, 22.0),
    }
    result = summarise(runs, window_seconds=180.0, machine="Linux x86_64")
    assert list(result["comparisons"]) == ["scale-elements"]
    assert over_budget(result) == []


def test_the_budget_is_judged_before_rounding() -> None:
    runs = {
        "scale-plain": _run("scale-plain", 10.0, 20.0),
        "scale-elements": _run("scale-elements", 13.0004, 26.0),
    }
    elements = summarise(runs, window_seconds=4.0, machine="m")["comparisons"]["scale-elements"]
    # Reported as 1.3, and still over a 1.3 budget: the report never rounds a miss into a pass.
    assert elements["ratio"] == 1.3
    assert elements["withinBudget"] is False
