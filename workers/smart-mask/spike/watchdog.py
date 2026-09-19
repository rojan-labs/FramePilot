"""Run BR0 jobs one at a time under a memory watchdog.

History: a first version capped process-tree RSS at 10 GiB. A SAM CoreML run reached a
16 GB *physical footprint* with RSS at 4.6 GiB (compressed/swapped pages and Core ML/Metal
allocations are not RSS) and pushed swap to 15.5 of 16 GB on the shared 16 GB machine. This
version measures what the OS charges the processes for.

Rules:
- ONE heavy job at a time: jobs run sequentially; a job does not start while another spike
  job runs (checked with ``ps``), nor while free memory is below the start level;
- each job runs in its own process group; every second the watchdog sums the physical footprint
  (``top -stats mem``: resident + compressed, including IOKit/Metal-backed memory) over the
  group and kills the whole group above ``--max-footprint-gib`` (default 8), when system swap
  grows by more than ``--max-swap-growth-gib`` (default 1) during the job, or when the
  kernel's free-memory level (``kern.memorystatus_level``, %) drops below ``--min-free-pct``
  (default 15). A job starts only when ``memory_pressure -Q`` reports a system-wide free percentage of
  at least ``--start-free-pct`` (default 40) and no other watched job runs (BR3.15: the earlier
  absolute-swap start gate is gone because macOS does not give swap back).
  (Absolute "swap used" was tried as a gate and never opened: macOS keeps swap allocated after
  pressure ends, 8.5 GB "used" with 76% of memory free and no spike job running. Swap *growth*
  and free memory are what a job actually changes.)
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
                 "throughput.py", "coreml_probe.py", "verify_proto.py", "export_sam.py", "export_birefnet.py",
                 # BR3: the pack's own heavy jobs share the same one-at-a-time rule.
                 "export_onnx.py", "parity_tracker.py", "run_eval.py", "framepilot_smart_mask",
                 "framepilot-smart-mask", "test_decoded_media.py")
POLL_SECONDS = 1  # 5 s let a 2048² BiRefNet session overshoot to 12 GB before the kill
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


def pressure_free_pct() -> int:
    """`memory_pressure -Q`: "System-wide memory free percentage" (the start gate since BR3.15)."""
    out = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True).stdout
    m = re.search(r"System-wide memory free percentage:\s*(\d+)%", out)
    return int(m.group(1)) if m else 0


def free_memory_pct() -> int:
    out = subprocess.run(["sysctl", "-n", "kern.memorystatus_level"], capture_output=True, text=True).stdout
    return int(out.strip() or 0)


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


def run_job(job: str, max_fp: int, max_growth: int, start_free: int, min_free: int, start_max_swap: int, log) -> dict:
    parts = job.split()
    # A job may name its own interpreter (the pack's .venv python) instead of a spike script.
    argv = [parts[0], "-u", *parts[1:]] if not parts[0].endswith(".py") else [sys.executable, "-u", *parts]
    while True:
        busy = other_spike_jobs({os.getpid()})
        free = free_memory_pct()
        swap = swap_used_bytes()
        # Absolute swap is not a start gate: macOS keeps swap allocated for hours after pressure
        # ends (it sat at 6.1-6.3 GB with nothing heavy running), so a swap ceiling can block forever.
        # Swap GROWTH during the job stays an abort rule below.
        free = pressure_free_pct()
        if not busy and free >= start_free:
            break
        log.write(f"waiting: busy={busy} freeMemoryPct={free} swapUsedGiB={swap / 2**30:.2f}\n")
        time.sleep(30)
    t0 = time.time()
    base_swap = swap_used_bytes()
    proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    peak_fp = peak_swap = 0
    min_seen_free = 100
    reason = None
    while proc.poll() is None:
        fp = footprint_bytes(group_pids(proc.pid))
        swap = swap_used_bytes()
        free = free_memory_pct()
        peak_fp, peak_swap, min_seen_free = max(peak_fp, fp), max(peak_swap, swap), min(min_seen_free, free)
        if fp > max_fp:
            reason = f"physical footprint {fp / 2**30:.2f} GiB exceeded {max_fp / 2**30:.1f} GiB local budget"
        elif swap - base_swap > max_growth:
            reason = (f"system swap grew {(swap - base_swap) / 2**30:.2f} GiB (limit {max_growth / 2**30:.1f}) "
                      f"from {base_swap / 2**30:.2f} GiB")
        elif free < min_free:
            reason = f"system free memory {free}% below {min_free}%"
        if reason:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            break
        time.sleep(POLL_SECONDS)
    rec = {"job": job, "exitCode": proc.returncode, "seconds": round(time.time() - t0, 1),
           "peakFootprintGiB": round(peak_fp / 2**30, 2), "startSwapUsedGiB": round(base_swap / 2**30, 2), "peakSwapUsedGiB": round(peak_swap / 2**30, 2), "minFreeMemoryPct": min_seen_free,
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
    ap.add_argument("--max-swap-growth-gib", type=float, default=1.0)
    ap.add_argument("--start-free-pct", type=int, default=40,
                    help="start only when memory_pressure -Q reports at least this free percentage")
    ap.add_argument("--min-free-pct", type=int, default=15)
    ap.add_argument("--start-max-swap-gib", type=float, default=6.0,  # accepted for old job files; unused
                    help="coordinator rule: no new heavy job while system swap used is above this")
    ap.add_argument("--jobs-file", help="one job per line (blank lines and # comments ignored)")
    ap.add_argument("jobs", nargs="*")
    a = ap.parse_args()
    if a.jobs_file:
        with open(a.jobs_file) as fh:
            a.jobs += [ln.strip() for ln in fh if ln.strip() and not ln.lstrip().startswith("#")]
    os.chdir(common.SPIKE_DIR)
    failed = 0
    with open(a.log, "a", buffering=1) as log:
        for job in a.jobs:
            log.write(f"== START {job} {time.strftime('%H:%M:%S')}\n")
            rec = run_job(job, int(a.max_footprint_gib * 2**30), int(a.max_swap_growth_gib * 2**30),
                          a.start_free_pct, a.min_free_pct, int(a.start_max_swap_gib * 2**30), log)
            log.write(f"== END {json.dumps(rec)}\n")
            failed += rec["aborted"] or rec["exitCode"] != 0
    # A caller chaining jobs (eval/ci_export_graphs.sh under SMART_MASK_EXPORT_WATCHDOG) must
    # see a killed or failed job, not a watchdog that finished its queue.
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
