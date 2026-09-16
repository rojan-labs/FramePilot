"""Run BR0 jobs one at a time under a memory watchdog.

Rules (after a memory incident on the 16 GB maintainer machine):
- ONE heavy job at a time: jobs run sequentially, and a job does not start while another
  spike job is running (checked with ``ps``);
- each job runs in its own process group; the watchdog sums RSS over that group every
  second and kills the whole group above ``--max-rss-gib`` (default 10);
- an abort is recorded in results/aborts.jsonl and the job is NOT retried.

Usage (detached, survives the launching shell):
    perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- .venv/bin/python watchdog.py \
        --log ../.cache/queue.log -- "parity_sam.py --ep cpu --precision fp32" "parity_sam.py ..."
Each job string is split on whitespace and run as ``.venv/bin/python -u <script> <args>``.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time

import common

SPIKE_SCRIPTS = ("parity_sam.py", "parity_birefnet.py", "pilot_generate.py", "pipeline_proto.py",
                 "throughput.py", "export_sam.py", "export_birefnet.py")


def group_rss_kib(pgid: int) -> int:
    out = subprocess.run(["ps", "-o", "rss=", "-g", str(pgid)], capture_output=True, text=True).stdout
    return sum(int(x) for x in out.split() if x.strip().isdigit())


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


def run_job(job: str, max_kib: int, log) -> dict:
    argv = [sys.executable, "-u", *job.split()]
    while busy := other_spike_jobs({os.getpid()}):
        log.write(f"waiting: other spike job running: {busy}\n")
        log.flush()
        time.sleep(30)
    t0 = time.time()
    proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    peak = 0
    aborted = False
    while proc.poll() is None:
        rss = group_rss_kib(proc.pid)
        peak = max(peak, rss)
        if rss > max_kib:
            os.killpg(proc.pid, signal.SIGKILL)
            aborted = True
            proc.wait()
            break
        time.sleep(1)
    rec = {"job": job, "exitCode": proc.returncode, "seconds": round(time.time() - t0, 1),
           "peakGroupRssGiB": round(peak / 1024 / 1024, 2), "aborted": aborted,
           "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    if aborted:
        rec["reason"] = f"process-tree RSS exceeded {max_kib / 1024 / 1024:.1f} GiB local budget"
        common.RESULTS.mkdir(parents=True, exist_ok=True)
        with open(common.RESULTS / "aborts.jsonl", "a") as f:
            f.write(json.dumps(rec) + "\n")
    with open(common.RESULTS / "jobs.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--max-rss-gib", type=float, default=10.0)
    ap.add_argument("jobs", nargs="+")
    a = ap.parse_args()
    os.chdir(common.SPIKE_DIR)
    max_kib = int(a.max_rss_gib * 1024 * 1024)
    with open(a.log, "a", buffering=1) as log:
        for job in a.jobs:
            log.write(f"== START {job} {time.strftime('%H:%M:%S')}\n")
            rec = run_job(job, max_kib, log)
            log.write(f"== END {json.dumps(rec)}\n")


if __name__ == "__main__":
    main()
