#!/usr/bin/env python3
"""Run ONE PX5 Scale-row variant on a workstation under the memory watchdog.

    python3 tests/e2e/scripts/px5-local-run.py scale/proxy [--budgets] [--play-seconds 20]

WHY a wrapper: this machine has been shut down twice by runaway memory, and the spike watchdog
(`workers/smart-mask/spike/watchdog.py`) follows a job by PROCESS GROUP. Playwright launches
Chrome detached, in a group of its own, so the group view would miss the browser entirely -
the one process worth watching. This follows the process TREE instead and reuses the
watchdog's own measurements and rules:

* starts only when `memory_pressure -Q` reports >= 40% free (waits up to --wait-minutes);
* every second sums the physical footprint (`top -stats mem`) of the whole tree and kills it
  above 8 GiB, when system swap grew by more than 1 GiB since the start, or when the kernel's
  free-memory level drops under 15%;
* refuses to start while another Playwright run is alive; an abort is recorded, never retried.

PX5.7: it also starts the web editor's dev server itself, with no file watcher and no hot
reload (`FRAMEPILOT_VITE_NO_WATCH=1`), and refuses to run while something else serves port
5173. With Playwright's own `webServer` (or a developer's server) an edit anywhere in the
worktree during a run - another agent's, an editor's autosave - hot-replaced the editor under
the test: the engine was rebuilt mid-step, and the run either measured a playback that never
started or waited on a replaced decode worker until it timed out (the "one run in ten" hang).

Each run appends one line to `tests/e2e/.tmp-px5-scale/results/local-runs.jsonl`.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "workers" / "smart-mask" / "spike"))
import watchdog  # noqa: E402  (the spike watchdog's measurements, reused as they are)

RESULTS = REPO / "tests" / "e2e" / ".tmp-px5-scale" / "results"
GIB = 2**30
#: Where the spec expects the editor (`baseURL` of `tests/e2e/playwright.config.ts`).
DEV_HOST, DEV_PORT = "127.0.0.1", 5173
DEV_READY_SECONDS = 120


def port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((host, port)) == 0


def start_frozen_dev_server() -> subprocess.Popen[bytes]:
    """The editor's dev server with no watcher and no hot reload (see the module note)."""
    env = {**os.environ, "FRAMEPILOT_VITE_NO_WATCH": "1"}
    argv = ["pnpm", "--filter", "@framepilot/web-editor", "dev", "--host", DEV_HOST]
    server = subprocess.Popen(
        argv, cwd=REPO, env=env, start_new_session=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )  # fmt: skip
    deadline = time.time() + DEV_READY_SECONDS
    while time.time() < deadline:
        if server.poll() is not None:
            raise RuntimeError("the frozen dev server exited before it served")
        try:
            with urllib.request.urlopen(f"http://{DEV_HOST}:{DEV_PORT}/", timeout=2):
                return server
        except OSError:
            time.sleep(0.5)
    kill_tree(server.pid)
    raise RuntimeError("the frozen dev server did not serve in time")


def tree_pids(root: int) -> list[int]:
    """`root` and every live descendant, by parent pid (process groups miss a detached Chrome)."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True).stdout
    children: dict[int, list[int]] = {}
    for line in out.splitlines():
        pid, _, ppid = line.strip().partition(" ")
        if pid.isdigit() and ppid.strip().isdigit():
            children.setdefault(int(ppid), []).append(int(pid))
    found, queue = [], [root]
    while queue:
        pid = queue.pop()
        found.append(pid)
        queue.extend(children.get(pid, []))
    return found


def other_playwright_runs() -> list[str]:
    out = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True)
    return [
        line.strip()[:140]
        for line in out.stdout.splitlines()
        if "playwright" in line and "test" in line and str(os.getpid()) not in line.split()[:1]
        and "px5-local-run" not in line
    ]


def kill_tree(root: int) -> None:
    for pid in reversed(tree_pids(root)):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("case", help="the spec title to run, e.g. scale/proxy")
    parser.add_argument("--budgets", action="store_true", help="assert the PX5 budgets")
    parser.add_argument("--play-seconds", type=int, default=20)
    parser.add_argument("--max-footprint-gib", type=float, default=8.0)
    parser.add_argument("--max-swap-growth-gib", type=float, default=1.0)
    parser.add_argument("--start-free-pct", type=int, default=40)
    parser.add_argument("--min-free-pct", type=int, default=15)
    parser.add_argument("--wait-minutes", type=float, default=10.0)
    args = parser.parse_args()

    if port_in_use(DEV_HOST, DEV_PORT):
        print(
            f"not started: something already serves {DEV_HOST}:{DEV_PORT}. Stop it: a watching "
            "dev server hot-reloads the editor under the run when any file changes (PX5.7)."
        )
        return 3
    deadline = time.time() + args.wait_minutes * 60
    while True:
        busy, free = other_playwright_runs(), watchdog.pressure_free_pct()
        if not busy and free >= args.start_free_pct:
            break
        if time.time() > deadline:
            print(f"not started: free={free}% (need {args.start_free_pct}%), busy={busy}")
            return 3
        time.sleep(15)

    env = {
        **os.environ,
        "FRAMEPILOT_RUN_PERF": "1",
        "PX5_PLAY_SECONDS": str(args.play_seconds),
        **({"PX5_ASSERT": "budgets"} if args.budgets else {}),
    }
    argv = [
        "pnpm", "--filter", "@framepilot/e2e", "exec", "playwright", "test",
        "--project=preview-perf", "--reporter=line", "--grep", f" {args.case}$",
    ]  # fmt: skip
    started, base_swap = time.time(), watchdog.swap_used_bytes()
    server = start_frozen_dev_server()
    proc = subprocess.Popen(argv, cwd=REPO, env=env, start_new_session=True)
    peak_footprint, peak_swap, min_free, reason = 0, base_swap, 100, None
    while proc.poll() is None:
        footprint = watchdog.footprint_bytes(tree_pids(proc.pid) + tree_pids(server.pid))
        swap, free = watchdog.swap_used_bytes(), watchdog.free_memory_pct()
        peak_footprint, peak_swap = max(peak_footprint, footprint), max(peak_swap, swap)
        min_free = min(min_free, free)
        if footprint > args.max_footprint_gib * GIB:
            reason = f"footprint {footprint / GIB:.2f} GiB over {args.max_footprint_gib} GiB"
        elif swap - base_swap > args.max_swap_growth_gib * GIB:
            reason = f"swap grew {(swap - base_swap) / GIB:.2f} GiB"
        elif free < args.min_free_pct:
            reason = f"free memory {free}% under {args.min_free_pct}%"
        if reason:
            kill_tree(proc.pid)
            proc.wait()
            break
        time.sleep(watchdog.POLL_SECONDS)
    kill_tree(server.pid)
    server.wait()
    record = {
        "case": args.case,
        "exitCode": proc.returncode,
        "seconds": round(time.time() - started, 1),
        "peakFootprintGiB": round(peak_footprint / GIB, 2),
        "swapGrowthGiB": round((peak_swap - base_swap) / GIB, 2),
        "minFreeMemoryPct": min_free,
        "aborted": reason is not None,
        **({"reason": reason} if reason else {}),
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    RESULTS.mkdir(parents=True, exist_ok=True)
    with open(RESULTS / "local-runs.jsonl", "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")
    print(json.dumps(record))
    return 4 if reason else int(proc.returncode or 0)


if __name__ == "__main__":
    sys.exit(main())
