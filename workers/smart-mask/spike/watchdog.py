"""Run BR0 jobs one at a time under a memory watchdog.

History: a first version capped process-tree RSS at 10 GiB. A SAM CoreML run reached a
16 GB *physical footprint* with RSS at 4.6 GiB (compressed/swapped pages and Core ML/Metal
allocations are not RSS) and pushed swap to 15.5 of 16 GB on the shared 16 GB machine. This
version measures what the OS charges the processes for.

Rules:
- ONE heavy job at a time: jobs run sequentially; a job does not start while another spike
  job runs (checked with ``ps``), nor while system swap is above the swap limit;
- each job runs in its own process group; every 5 s the watchdog sums the physical footprint
  (``top -stats mem``: resident + compressed, including IOKit/Metal-backed memory) over the
  group and kills the whole group above ``--max-footprint-gib`` (default 8), or when system
  swap used exceeds ``--max-swap-gib`` (default 6);
- an abort is recorded in results/aborts.jsonl with the observed peak and is NOT retried.

    .venv/bin/python watchdog.py --log ../.cache/queue.log -- "parity_sam.py --ep cpu" "..."
Each job string is split on whitespace and run as ``<this python> -u <script> <args>``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time

import common

SPIKE_SCRIPTS = ("parity_sam.py", "parity_birefnet.py", "pilot_generate.py", "pipeline_proto.py",
                 "throughput.py", "coreml_probe.py", "verify_proto.py", "export_sam.py", "export_birefnet.py")
POLL_SECONDS = 5
_UNITS = {"B": 1, "K": 2**10, "M": 2**20, "G": 2**30, "T": 2**40}


def _parse_mem(text: str) -> int:
    m = re.match(r"([\d.]+)([BKMGT])", text.strip())
    return int(float(m.group(1)) * _UNITS[m.group(2)]) if m else 0


def group_pids(pgid: int) -> list[int]:
    out = subprocess.run(["ps", "-o", "pid=", "-g", str(pgid)], capture_output=True, text=True).stdout
    return [int(x) for x in out.split() if x.isdigit()]


def footprint_bytes(pids: list[int]) -> int:
    """Sum of top's MEM (physical footprint) over pids."""
    if not pids:
        return 0
    cmd = ["top", "-l", "1", "-stats", "pid,mem"]
    for p in pids:
        cmd += ["-pid", str(p)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    total = 0
    seen = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and int(parts[0]) in pids and parts[0] not in seen:
            seen.add(parts[0])
            total += _parse_mem(parts[1].rstrip("+-"))
    return total


def swap_used_bytes() -> int:
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    m = re.search(r"used = ([\d.]+)M", out)
    return int(float(m.group(1)) * 2**20) if m else 0


def other_spike_jobs(own_pids: set[int]) -> list[str]:
    """Python processes (by executable, not by shell text) running one of our spike scripts."""
    out = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True).stdout
    busy = []
    for line in out.splitlines():
        pid_s, _, cmd = line.strip().partition(" ")
        if not pid_s.isdigit() or int(pid_s) in own_pids:
            continue
        exe = cmd.split(" ", 1)[0]
        if "python" not in os.path.basename(exe) or "watchdog.py" in cmd:
            continue
        if any(s in cmd for s in SPIKE_SCRIPTS):
            busy.append(line.strip()[:160])
    return busy


def run_job(job: str, max_fp: int, max_swap: int, log) -> dict:
    argv = [sys.executable, "-u", *job.split()]
    while True:
        busy = other_spike_jobs({os.getpid()})
        swap = swap_used_bytes()
        if not busy and swap <= max_swap:
            break
        log.write(f"waiting: busy={busy} swapUsedGiB={swap / 2**30:.2f}\n")
        time.sleep(30)
    t0 = time.time()
    proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    peak_fp = peak_swap = 0
    reason = None
    while proc.poll() is None:
        fp = footprint_bytes(group_pids(proc.pid))
        swap = swap_used_bytes()
        peak_fp, peak_swap = max(peak_fp, fp), max(peak_swap, swap)
        if fp > max_fp:
            reason = f"physical footprint {fp / 2**30:.2f} GiB exceeded {max_fp / 2**30:.1f} GiB local budget"
        elif swap > max_swap:
            reason = f"system swap used {swap / 2**30:.2f} GiB exceeded {max_swap / 2**30:.1f} GiB"
        if reason:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            break
        time.sleep(POLL_SECONDS)
    rec = {"job": job, "exitCode": proc.returncode, "seconds": round(time.time() - t0, 1),
           "peakFootprintGiB": round(peak_fp / 2**30, 2), "peakSwapUsedGiB": round(peak_swap / 2**30, 2),
           "aborted": reason is not None, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    common.RESULTS.mkdir(parents=True, exist_ok=True)
    if reason:
        rec["reason"] = reason
        with open(common.RESULTS / "aborts.jsonl", "a") as f:
            f.write(json.dumps(rec) + "\n")
    with open(common.RESULTS / "jobs.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--max-footprint-gib", type=float, default=8.0)
    ap.add_argument("--max-swap-gib", type=float, default=6.0)
    ap.add_argument("jobs", nargs="+")
    a = ap.parse_args()
    os.chdir(common.SPIKE_DIR)
    with open(a.log, "a", buffering=1) as log:
        for job in a.jobs:
            log.write(f"== START {job} {time.strftime('%H:%M:%S')}\n")
            rec = run_job(job, int(a.max_footprint_gib * 2**30), int(a.max_swap_gib * 2**30), log)
            log.write(f"== END {json.dumps(rec)}\n")


if __name__ == "__main__":
    main()
