"""Measure what a ``color_grade`` does to the ledger's OWN facts, through the real export (#107).

``packages/editor-core/src/color-solver.ts`` turns two sets of tier-0 facts into a grade. Its
white-balance terms were derived on paper (full-range BT.709, a neutral grey patch) and a first
fit through ``/review/temporal-evidence`` read ``WARMTH_PER_TEMPERATURE`` ~15% under the derived
0.6936. That fit reconstructed warmth from float RGB through the very matrix it was testing, so it
could not tell "wrong matrix" from "shallower renderer curve". This script can:

1. It renders each grid cell through ``export_video`` - the compiler, ``render/color.py`` and the
   real encoder - and measures the FILE with ``analysis/shot_stats.py#measure_asset``, the exact
   filter graph tier-0 enrolment runs. Nothing is reconstructed; ``warmth`` is ``(V-U)/128`` off
   the encoded planes.
2. It identifies the encode's chroma chain from evidence instead of assuming it: the ungraded
   render's signalstats means are compared with the source's, re-expressed through each
   candidate chain (BT.709/BT.601, limited/full). Means are linear in RGB, so the swap is exact
   up to gamut clipping.
3. It predicts every cell with NO free parameter - the renderer's channel arithmetic
   (``R *= 1 + 0.3t``, ``B *= 1 - 0.3t``, ``G *= 1 + 0.3 tint``) applied to the measured
   channel means - and reports measured / predicted as the curve efficiency. 1.0 means the
   renderer's curve is exactly the derivation; below 1.0 is clipping.
4. It re-expresses every measured cell in the SOURCE chain (BT.709 limited range, what the
   ledger holds for camera files) and fits the solver's constants in the solver's own units:
   warmth moved per unit parameter per unit ``luma.mean``.

Run it on short clips (a few seconds each; every cell is one export)::

    cd engine/python
    uv run python -m tests.color_response_measure --work /tmp/color107 \\
        --media /abs/a.mp4 /abs/b.mp4 [--seconds 2] [--json out.json]

Media is COPIED into ``--work`` (the render sandbox); the originals are only read. One export
at a time, 480p, so a run stays well under a gigabyte of memory.

Nothing here writes back into the runtime. Changing a constant is a human decision, recorded in
``color-solver.ts``'s docstring with the numbers this prints.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

# ── The renderer's arithmetic (render/color.py) ────────────────────────────────────────

#: ``_TEMP_GAIN`` / ``_TINT_GAIN`` in ``render/color.py``.
RENDER_WB_GAIN = 0.3

# ── Chroma chains ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Chain:
    """One way RGB becomes the 8-bit Y/U/V planes signalstats reads."""

    name: str
    kr: float
    kb: float
    limited: bool

    @property
    def kg(self) -> float:
        return 1.0 - self.kr - self.kb

    @property
    def luma_span(self) -> float:
        return 219.0 if self.limited else 255.0

    @property
    def luma_floor(self) -> float:
        return 16.0 if self.limited else 0.0

    @property
    def chroma_span(self) -> float:
        return 224.0 if self.limited else 255.0


BT709_LIMITED = Chain("bt709-limited", 0.2126, 0.0722, True)
BT709_FULL = Chain("bt709-full", 0.2126, 0.0722, False)
BT601_LIMITED = Chain("bt601-limited", 0.299, 0.114, True)
BT601_FULL = Chain("bt601-full", 0.299, 0.114, False)
CHAINS: tuple[Chain, ...] = (BT709_LIMITED, BT709_FULL, BT601_LIMITED, BT601_FULL)

#: What the ledger holds for camera files: every source this was run on is tagged
#: ``tv``/``bt709``, and ffmpeg's decode honours the tag.
SOURCE_CHAIN = BT709_LIMITED

#: Neutral chroma code, and ``_WARMTH_FULL`` in ``analysis/shot_stats.py``.
CHROMA_NEUTRAL = 128.0
WARMTH_FULL = 128.0


@dataclass(frozen=True)
class Planes:
    """signalstats means in raw 8-bit codes: what tier-0 averages before normalising."""

    y: float
    u: float
    v: float
    sat: float
    y_low: float
    y_high: float

    @property
    def luma_mean(self) -> float:
        return self.y / 255.0

    @property
    def warmth(self) -> float:
        return (self.v - self.u) / WARMTH_FULL

    @property
    def green_magenta(self) -> float:
        return (self.u + self.v - 2 * CHROMA_NEUTRAL) / WARMTH_FULL


def rgb_from_planes(planes: Planes, chain: Chain) -> tuple[float, float, float]:
    """Mean R'G'B' (0..1) behind ``planes`` if they were written through ``chain``."""
    luma = (planes.y - chain.luma_floor) / chain.luma_span
    cb = (planes.u - CHROMA_NEUTRAL) / chain.chroma_span
    cr = (planes.v - CHROMA_NEUTRAL) / chain.chroma_span
    red = luma + 2 * (1 - chain.kr) * cr
    blue = luma + 2 * (1 - chain.kb) * cb
    green = (luma - chain.kr * red - chain.kb * blue) / chain.kg
    return red, green, blue


def planes_from_rgb(rgb: tuple[float, float, float], chain: Chain, like: Planes) -> Planes:
    """The planes ``rgb`` writes through ``chain``; ``sat``/percentiles rescaled from ``like``.

    Only the three means are exact. Saturation and the luma percentiles are carried over with
    the chain's span ratio, which is exact for a pure scale and approximate otherwise; nothing
    in the warmth fit reads them.
    """
    red, green, blue = rgb
    luma = chain.kr * red + chain.kg * green + chain.kb * blue
    cb = (blue - luma) / (2 * (1 - chain.kb))
    cr = (red - luma) / (2 * (1 - chain.kr))
    return Planes(
        y=chain.luma_floor + chain.luma_span * luma,
        u=CHROMA_NEUTRAL + chain.chroma_span * cb,
        v=CHROMA_NEUTRAL + chain.chroma_span * cr,
        sat=like.sat,
        y_low=like.y_low,
        y_high=like.y_high,
    )


def reexpress(planes: Planes, written: Chain, wanted: Chain) -> Planes:
    """``planes`` as ``wanted`` would have written the same mean RGB."""
    return planes_from_rgb(rgb_from_planes(planes, written), wanted, planes)


def white_balance(
    rgb: tuple[float, float, float], temperature: float, tint: float
) -> tuple[float, float, float]:
    """``render/color.py`` stage 2 on channel MEANS, without the final clamp."""
    red, green, blue = rgb
    return (
        red * (1 + RENDER_WB_GAIN * temperature),
        green * (1 + RENDER_WB_GAIN * tint),
        blue * (1 - RENDER_WB_GAIN * temperature),
    )


def predicted_planes(baseline: Planes, chain: Chain, temperature: float, tint: float) -> Planes:
    """What an unclipped white balance does to ``baseline``'s planes, in ``chain``."""
    graded = white_balance(rgb_from_planes(baseline, chain), temperature, tint)
    return planes_from_rgb(graded, chain, baseline)


def neutral_patch_warmth_per_temperature(chain: Chain) -> float:
    """``color-solver.ts``'s derivation (a grey patch of unit light), in ``chain``'s units."""
    grey = Planes(
        y=chain.luma_floor + chain.luma_span,
        u=CHROMA_NEUTRAL,
        v=CHROMA_NEUTRAL,
        sat=0.0,
        y_low=0.0,
        y_high=0.0,
    )
    return predicted_planes(grey, chain, 1.0, 0.0).warmth - grey.warmth


def slope_through_origin(points: Sequence[tuple[float, float]]) -> float:
    """Least-squares gain: the responses are gains, not offsets."""
    numerator = sum(x * y for x, y in points)
    denominator = sum(x * x for x, _ in points)
    return 0.0 if denominator == 0 else numerator / denominator


# ── The grid ───────────────────────────────────────────────────────────────────────────

#: Symmetric steps; the solver's contracts span -1..1 for white balance.
WB_STEPS: tuple[float, ...] = (-1.0, -0.5, -0.25, 0.25, 0.5, 1.0)
EXPOSURE_STEPS: tuple[float, ...] = (-1.0, -0.5, 0.5, 1.0)
RATIO_STEPS: tuple[float, ...] = (-0.5, -0.25, 0.25, 0.5)
GRID: dict[str, tuple[float, ...]] = {
    "temperature": WB_STEPS,
    "tint": WB_STEPS,
    "exposure": EXPOSURE_STEPS,
    "contrast": RATIO_STEPS,
    "saturation": RATIO_STEPS,
}

# ── The real pipeline ──────────────────────────────────────────────────────────────────

Measure = Callable[[Path, float], Planes]


def measure_with_ledger_chain(path: Path, seconds: float) -> Planes:
    """Tier-0's own pass over the first ``seconds`` of ``path``, averaged over its shots.

    The graph is ``tier0_argv``'s, untouched; the only change is ``-t`` on the input so a
    source is measured over exactly the window the render covers.
    """
    from framepilot_engine.analysis.shot_stats import measure_asset
    from framepilot_engine.media.ffmpeg import run_logs

    def windowed(argv: Sequence[str]) -> str:
        at = list(argv).index("-i")
        return run_logs([*argv[:at], "-t", f"{seconds:.3f}", *argv[at:]], timeout=300.0)

    shots = measure_asset(path, duration=seconds, runner=windowed)
    if not shots:
        raise RuntimeError(f"tier-0 measured no shots in {path}")
    weights = [max(shot.t1 - shot.t0, 1e-6) for shot in shots]
    total = sum(weights)

    def mean(values: Sequence[float]) -> float:
        return sum(w * v for w, v in zip(weights, values, strict=True)) / total

    return Planes(
        y=255.0 * mean([s.luma_mean for s in shots]),
        u=mean([s.u_mean for s in shots]),
        v=mean([s.v_mean for s in shots]),
        # ShotStats normalises SATAVG by 181.02; keep it normalised, ratios are all we read.
        sat=mean([s.sat_mean for s in shots]),
        y_low=255.0 * mean([s.luma_p10 for s in shots]),
        y_high=255.0 * mean([s.luma_p90 for s in shots]),
    )


def export_graded(work: Path, media_name: str, seconds: float, params: Mapping[str, float]) -> Path:
    """One export of one graded clip through ``export_video``; returns the file."""
    from framepilot_engine.render.export_settings import ExportSettings
    from framepilot_engine.render.pipeline import RenderState, export_video
    from framepilot_engine.timeline.models import Project

    label = "_".join(f"{k}{v:+g}" for k, v in params.items()) or "ungraded"
    effects = [{"id": "g", "type": "color_grade", "params": dict(params)}] if params else []
    project = Project.model_validate(
        {
            "id": "color107",
            "name": "color107",
            "fps": 24,
            "resolution": {"width": 1920, "height": 1080},
            "assets": [{"id": "a", "path": f"media/{media_name}", "kind": "video"}],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c",
                                "assetId": "a",
                                "trackId": "v",
                                "start": 0.0,
                                "end": seconds,
                                "sourceStart": 0.0,
                                "sourceEnd": seconds,
                                "effects": effects,
                            }
                        ],
                    }
                ]
            },
        }
    )
    output = f"out/{Path(media_name).stem}__{label}.mp4"
    job = export_video(
        project, base_dir=work, settings=ExportSettings(resolution="480p"), output_path=output
    )
    if job.state is not RenderState.COMPLETED:
        raise RuntimeError(f"export failed for {label}: {job.error} / {job.error_detail}")
    return work / output


# ── Fitting ────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ClipResult:
    """Everything one clip measured, in the solver's units unless named otherwise."""

    clip: str
    source_luma_mean: float
    source_warmth: float
    encode_chain: str
    #: the ungraded export against a perfect pass-through of the source (codes).
    ungraded_drift: dict[str, float]
    #: measured Δwarmth / (t · luma.mean), in the export's own chain (what tier-0 reads).
    warmth_per_temperature_export_chain: float
    #: the same, re-expressed in the SOURCE chain (what the solver's inputs are).
    warmth_per_temperature_source_chain: float
    green_magenta_per_temperature_source_chain: float
    warmth_per_tint_source_chain: float
    green_magenta_per_tint_source_chain: float
    #: measured / zero-parameter channel-mean prediction, in the export chain.
    temperature_curve_efficiency: float
    tint_curve_efficiency: float
    #: the channel-mean prediction, source chain, at this clip's own means (no render).
    predicted_warmth_per_temperature_source_chain: float
    #: satMean ratio moved per unit temperature (the WB → satMean cross-term).
    sat_ratio_per_temperature: float
    #: log2(luma.mean ratio) per stop, as the solver reads it (Y/255, offset included).
    exposure_response: float
    #: the same through LIGHT, ``(Y - floor) / span``: what is left is clipping alone.
    exposure_response_light: float
    contrast_response: float
    saturation_response: float


#: The probe's colour: a full-scale red patch, where every candidate chain lands on
#: different codes by at least ten (601-limited 81/90/240, 709-limited 63/102/240, ...).
PROBE_RGB = (1.0, 0.0, 0.0)


def identify_encode_chain(probe: Planes) -> tuple[Chain, dict[str, float]]:
    """Which chain wrote ``probe``, the export of a pure-red source.

    Natural footage cannot answer this: its chroma is small, so the candidates differ by a
    code or two and the render's own drift decides. A saturated patch separates them by ten
    codes or more. Returns the winner and every candidate's code distance.
    """
    errors: dict[str, float] = {}
    for chain in CHAINS:
        expected = planes_from_rgb(PROBE_RGB, chain, probe)
        errors[chain.name] = math.hypot(
            expected.y - probe.y, expected.u - probe.u, expected.v - probe.v
        )
    return min(CHAINS, key=lambda chain: errors[chain.name]), errors


def chain_by_name(name: str) -> Chain:
    """The chain called ``name``."""
    for chain in CHAINS:
        if chain.name == name:
            return chain
    raise ValueError(f"unknown chroma chain {name!r}")


def ungraded_drift(source: Planes, ungraded: Planes, chain: Chain) -> dict[str, float]:
    """What an UNGRADED export does to the ledger's facts: the render's own shift.

    The source re-expressed through the encode chain is what a perfect pass-through would
    measure; anything left over is the render itself (scaling, decode, rounding).
    """
    expected = reexpress(source, SOURCE_CHAIN, chain)
    return {
        "luma_codes": ungraded.y - expected.y,
        "u_codes": ungraded.u - expected.u,
        "v_codes": ungraded.v - expected.v,
        "warmth_raw": ungraded.warmth - source.warmth,
    }


def fit_clip(
    clip: str,
    source: Planes,
    ungraded: Planes,
    cells: Mapping[str, Sequence[tuple[float, Planes]]],
    chain: Chain,
) -> ClipResult:
    """Fit every response from measured cells written through ``chain``. Pure: no I/O."""
    base_src = reexpress(ungraded, chain, SOURCE_CHAIN)

    def wb(parameter: str) -> tuple[float, float, float, float, float]:
        export_pts: list[tuple[float, float]] = []
        warm_pts: list[tuple[float, float]] = []
        gm_pts: list[tuple[float, float]] = []
        efficiency_pts: list[tuple[float, float]] = []
        sat_pts: list[tuple[float, float]] = []
        for value, planes in cells[parameter]:
            temperature = value if parameter == "temperature" else 0.0
            tint = value if parameter == "tint" else 0.0
            export_pts.append((value, (planes.warmth - ungraded.warmth) / ungraded.luma_mean))
            in_src = reexpress(planes, chain, SOURCE_CHAIN)
            warm_pts.append((value, (in_src.warmth - base_src.warmth) / base_src.luma_mean))
            gm_pts.append(
                (value, (in_src.green_magenta - base_src.green_magenta) / base_src.luma_mean)
            )
            predicted = predicted_planes(ungraded, chain, temperature, tint)
            axis = "warmth" if parameter == "temperature" else "green_magenta"
            efficiency_pts.append(
                (
                    getattr(predicted, axis) - getattr(ungraded, axis),
                    getattr(planes, axis) - getattr(ungraded, axis),
                )
            )
            sat_pts.append((value, planes.sat / ungraded.sat - 1 if ungraded.sat else 0.0))
        return (
            slope_through_origin(export_pts),
            slope_through_origin(warm_pts),
            slope_through_origin(gm_pts),
            slope_through_origin(efficiency_pts),
            slope_through_origin(sat_pts),
        )

    temp_export, temp_warm, temp_gm, temp_eff, temp_sat = wb("temperature")
    _, tint_warm, tint_gm, tint_eff, _ = wb("tint")
    predicted_src = predicted_planes(base_src, SOURCE_CHAIN, 1.0, 0.0)

    exposure = slope_through_origin(
        [(v, math.log2(p.luma_mean / ungraded.luma_mean)) for v, p in cells["exposure"]]
    )

    def light(planes: Planes) -> float:
        return (planes.y - chain.luma_floor) / chain.luma_span

    exposure_light = slope_through_origin(
        [(v, math.log2(light(p) / light(ungraded))) for v, p in cells["exposure"]]
    )
    contrast_idx = ungraded.y_high - ungraded.y_low
    contrast = slope_through_origin(
        [(v, (p.y_high - p.y_low) / contrast_idx - 1) for v, p in cells["contrast"]]
    )
    saturation = slope_through_origin(
        [(v, p.sat / ungraded.sat - 1) for v, p in cells["saturation"]]
    )
    return ClipResult(
        clip=clip,
        source_luma_mean=source.luma_mean,
        source_warmth=source.warmth,
        encode_chain=chain.name,
        ungraded_drift=ungraded_drift(source, ungraded, chain),
        warmth_per_temperature_export_chain=temp_export,
        warmth_per_temperature_source_chain=temp_warm,
        green_magenta_per_temperature_source_chain=temp_gm,
        warmth_per_tint_source_chain=tint_warm,
        green_magenta_per_tint_source_chain=tint_gm,
        temperature_curve_efficiency=temp_eff,
        tint_curve_efficiency=tint_eff,
        predicted_warmth_per_temperature_source_chain=(
            (predicted_src.warmth - base_src.warmth) / base_src.luma_mean
        ),
        sat_ratio_per_temperature=temp_sat,
        exposure_response=exposure,
        exposure_response_light=exposure_light,
        contrast_response=contrast,
        saturation_response=saturation,
    )


@dataclass(frozen=True)
class ClipMeasurement:
    """The raw signalstats means one clip produced: every fit is a pure function of this."""

    clip: str
    encode_chain: str
    source: Planes
    ungraded: Planes
    cells: dict[str, list[tuple[float, Planes]]]

    def to_json(self) -> dict[str, Any]:
        return {
            "clip": self.clip,
            "encode_chain": self.encode_chain,
            "source": asdict(self.source),
            "ungraded": asdict(self.ungraded),
            "cells": {
                name: [[value, asdict(planes)] for value, planes in steps]
                for name, steps in self.cells.items()
            },
        }

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> ClipMeasurement:
        return cls(
            clip=str(data["clip"]),
            encode_chain=str(data["encode_chain"]),
            source=Planes(**data["source"]),
            ungraded=Planes(**data["ungraded"]),
            cells={
                name: [(float(value), Planes(**planes)) for value, planes in steps]
                for name, steps in data["cells"].items()
            },
        )

    def fit(self) -> ClipResult:
        chain = chain_by_name(self.encode_chain)
        return fit_clip(self.clip, self.source, self.ungraded, self.cells, chain)


def measure_encode_probe(work: Path, seconds: float, measure: Measure) -> Planes:
    """Export a pure-red, BT.709-tagged source and measure it: the encode chain's fingerprint."""
    from framepilot_engine.media.ffmpeg import find_ffmpeg, run_logs

    (work / "media").mkdir(parents=True, exist_ok=True)
    probe = work / "media" / "probe-red.mp4"
    run_logs(
        [
            find_ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=red:s=640x360:r=24:d={seconds + 1:.3f},format=rgb24",
            "-vf",
            "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_range",
            "tv",
            "-c:v",
            "libx264",
            "-qp",
            "0",
            str(probe),
        ],
        timeout=120.0,
    )
    exported = export_graded(work, probe.name, seconds, {})
    planes = measure(exported, seconds)
    exported.unlink()
    return planes


def measure_clip(
    work: Path,
    media: Path,
    seconds: float,
    chain: Chain,
    *,
    measure: Measure = measure_with_ledger_chain,
) -> ClipMeasurement:
    """Copy ``media`` into the sandbox, render the grid, and measure every cell."""
    (work / "media").mkdir(parents=True, exist_ok=True)
    local = work / "media" / media.name
    if not local.exists():
        shutil.copyfile(media, local)
    source = measure(local, seconds)
    ungraded_file = export_graded(work, media.name, seconds, {})
    ungraded = measure(ungraded_file, seconds)
    ungraded_file.unlink()
    cells: dict[str, list[tuple[float, Planes]]] = {}
    for parameter, steps in GRID.items():
        cells[parameter] = []
        for value in steps:
            rendered = export_graded(work, media.name, seconds, {parameter: value})
            cells[parameter].append((value, measure(rendered, seconds)))
            rendered.unlink()
            print(f"  {media.stem} {parameter}={value:+g}", file=sys.stderr, flush=True)
    return ClipMeasurement(media.stem, chain.name, source, ungraded, cells)


def summarise(results: Sequence[ClipResult]) -> dict[str, Any]:
    """Per-clip rows plus the across-clip mean of every fitted field."""
    rows = [asdict(result) for result in results]
    numeric = [key for key, value in rows[0].items() if isinstance(value, float) and key != "clip"]
    means = {key: sum(row[key] for row in rows) / len(rows) for key in numeric}
    return {
        "neutral_patch_warmth_per_temperature": {
            chain.name: neutral_patch_warmth_per_temperature(chain) for chain in CHAINS
        },
        "clips": rows,
        "mean": means,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--media", type=Path, nargs="*", default=[])
    parser.add_argument("--work", type=Path, default=None, help="render sandbox (scratch)")
    parser.add_argument("--seconds", type=float, default=2.0)
    parser.add_argument("--json", type=Path, default=None, help="write the fitted summary here")
    parser.add_argument("--raw", type=Path, default=None, help="write raw measurements here")
    parser.add_argument(
        "--refit", type=Path, default=None, help="fit a --raw file again, rendering nothing"
    )
    args = parser.parse_args(argv)
    if args.refit is not None:
        loaded = json.loads(args.refit.read_text(encoding="utf-8"))
        probe_report = loaded["probe"]
        measured = [ClipMeasurement.from_json(row) for row in loaded["clips"]]
    else:
        if args.work is None or not args.media:
            parser.error("--media and --work are required unless --refit is given")
        probe = measure_encode_probe(args.work, args.seconds, measure_with_ledger_chain)
        chain, errors = identify_encode_chain(probe)
        probe_report = {"planes": asdict(probe), "chain": chain.name, "errors": errors}
        print(f"encode chain: {chain.name} {errors}", file=sys.stderr, flush=True)
        measured = []
        for media in args.media:
            measured.append(measure_clip(args.work, media, args.seconds, chain))
            if args.raw is not None:
                raw = {"probe": probe_report, "clips": [row.to_json() for row in measured]}
                args.raw.write_text(json.dumps(raw, indent=1) + "\n", encoding="utf-8")
    summary = {"probe": probe_report, **summarise([row.fit() for row in measured])}
    text = json.dumps(summary, indent=2)
    if args.json is not None:
        args.json.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
