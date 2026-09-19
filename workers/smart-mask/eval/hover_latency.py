"""Hover-highlight latency against the warm worker (plan 06 budget: ≤ 100 ms p95 after the
frame embedding exists; BR6.11).

Drives the INSTALLED entrypoint in warm mode (``--framepilot-worker-warm``), exactly the
process the desktop host keeps alive: one click request on a frame (pays the image encode), then
``--hovers`` hover requests on the same frame at different points, each timed from writing the
request line to reading its terminal line. Writes ``.cache/hover-latency.json``; run it under
``spike/watchdog.py`` (it loads the SAM graphs).

    ../.venv/bin/python ../eval/hover_latency.py walk_pan__scored --hovers 60
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

EVAL = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL))

from entrypoint import ENTRYPOINT, PACK, source_pts, worker_environment  # noqa: E402
from fixtures import discover  # noqa: E402

PILOT_DIR = PACK / ".cache" / "pilot-br3"
OUT = PACK / ".cache" / "hover-latency.json"


def request(fixture: Any, pts: int, index: int, request_id: str, **prompt: Any) -> dict[str, Any]:
    return {
        "type": "request", "protocolVersion": 1, "requestId": request_id, "projectRevision": 1,
        "media": {"handleId": "media", "assetId": fixture.name, "absolutePath": str(fixture.clip),
                  "sourceStartSeconds": index / fixture.fps, "sourceEndSeconds": (index + 1) / fixture.fps,
                  "fps": float(fixture.fps), "firstFrame": index, "lastFrameExclusive": index + 1},
        "capability": "subject.segment_frame",
        "parameters": {"pts": pts, "previewHeight": 360, **prompt},
    }  # fmt: skip


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, round(q / 100 * (len(ordered) - 1))))
    return ordered[rank]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clip")
    parser.add_argument("--hovers", type=int, default=60)
    parser.add_argument("--frame", type=int, default=8)
    arguments = parser.parse_args()
    fixture = next(f for f in discover([PILOT_DIR])[0] if f.name == arguments.clip)
    pts = source_pts(fixture.clip)[arguments.frame]
    process = subprocess.Popen(
        [str(ENTRYPOINT), "--framepilot-worker-warm"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, env=worker_environment(),
    )  # fmt: skip
    assert process.stdin is not None and process.stdout is not None

    def ask(message: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        started = time.perf_counter()
        process.stdin.write(json.dumps(message) + "\n")  # type: ignore[union-attr]
        process.stdin.flush()  # type: ignore[union-attr]
        while True:
            line = process.stdout.readline()  # type: ignore[union-attr]
            if not line:
                raise RuntimeError("the warm worker exited")
            reply = json.loads(line)
            if reply.get("type") in ("result", "failure"):
                return (time.perf_counter() - started) * 1000.0, reply

    box = fixture.box
    centre = {"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2}
    first_ms, first = ask(
        request(fixture, pts, arguments.frame, "hover-embed",
                points=[{**centre, "label": "include"}])
    )  # fmt: skip
    if first.get("type") != "result":
        raise SystemExit(f"first request failed: {first}")
    hovers: list[float] = []
    for step in range(arguments.hovers):
        # A pointer sweeping across the subject's box and a little beyond it.
        u = (step % 20) / 19
        point = {"x": min(0.999, max(0.0, box["x"] - 0.05 + u * (box["width"] + 0.1))),
                 "y": min(0.999, box["y"] + box["height"] * (0.2 + 0.6 * ((step // 20) % 3) / 2))}  # fmt: skip
        elapsed, reply = ask(
            request(fixture, pts, arguments.frame, f"hover-{step}", hoverPoint=point)
        )
        if reply.get("type") != "result":
            raise SystemExit(f"hover {step} failed: {reply}")
        hovers.append(elapsed)
    process.stdin.close()
    process.wait(timeout=60)
    result = {
        "measured": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "platform": sys.platform,
        "clip": fixture.name,
        "frame": arguments.frame,
        "previewHeight": 360,
        "firstRequestMs": round(first_ms, 1),
        "hovers": len(hovers),
        "hoverMs": {"p50": round(percentile(hovers, 50), 1), "p95": round(percentile(hovers, 95), 1),
                    "max": round(max(hovers), 1), "mean": round(sum(hovers) / len(hovers), 1)},
        "budgetMs": 100,
        "path": "worker round trip over stdin/stdout (warm process, embedding cached); excludes Electron IPC",
    }  # fmt: skip
    OUT.write_text(json.dumps(result, indent=2) + "\n")
    sys.stdout.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
