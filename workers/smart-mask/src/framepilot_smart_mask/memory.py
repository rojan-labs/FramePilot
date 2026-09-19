"""Per-job memory ceiling and per-window wall-clock watchdog (BR3.14).

The ceiling is measured as the OS's **physical footprint**, not RSS: in BR0 a CoreML run read
4.6 GiB RSS while its footprint was 16 GB (compressed and Metal-backed pages are not RSS) and
the machine shut down. On macOS that is ``proc_pid_rusage().ri_phys_footprint``; on Windows the
process's private commit; elsewhere current RSS.

The governor samples once per second on a daemon thread. Above the ceiling, or when a window
runs past its deadline, it cancels the job with a typed reason; the pipeline stops at its next
check, closes its models and the runtime reports ``internal_error`` (plan 03: a breached limit
fails the job, and the host independently kills a worker it cannot trust). The peak footprint is
recorded in report.json.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import logging
import os
import sys
import threading
import time
from collections.abc import Callable
from typing import Any, Final

from .protocol import ProtocolError
from .runtime import CancellationFlag

_log = logging.getLogger(__name__)

SAMPLE_SECONDS: Final = 1.0
#: Per-frame wall-clock budget for a window (BR0.7: ~20 s/frame on CPU at 1080p; 4× margin).
WINDOW_SECONDS_PER_FRAME: Final = 90.0
WINDOW_SECONDS_BASE: Final = 600.0
_RUSAGE_INFO_V2: Final = 2
_PHYS_FOOTPRINT_OFFSET: Final = 72


def physical_footprint_bytes() -> int:
    """Current physical footprint of this process in bytes (0 when unknown)."""
    try:
        if sys.platform == "darwin":
            return _darwin_footprint()
        if sys.platform == "win32":
            return _windows_private_bytes()
        return _linux_rss()
    except Exception:  # pragma: no cover - platform API failure is reported as unknown
        return 0


def _darwin_footprint() -> int:
    library = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib")
    buffer = (ctypes.c_uint8 * 512)()
    if library.proc_pid_rusage(os.getpid(), _RUSAGE_INFO_V2, ctypes.byref(buffer)) != 0:
        return 0
    return int.from_bytes(
        bytes(buffer[_PHYS_FOOTPRINT_OFFSET : _PHYS_FOOTPRINT_OFFSET + 8]), "little"
    )


def _windows_private_bytes() -> int:  # pragma: no cover - exercised on Windows only
    class Counters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
            ("PrivateUsage", ctypes.c_size_t),
        ]

    windll: Any = getattr(ctypes, "windll")  # noqa: B009 - Windows-only attribute
    counters = Counters()
    counters.cb = ctypes.sizeof(Counters)
    handle = windll.kernel32.GetCurrentProcess()
    if not windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        return 0
    return int(counters.PrivateUsage)


def _linux_rss() -> int:
    with open("/proc/self/statm", encoding="ascii") as handle:  # noqa: PTH123
        pages = int(handle.read().split()[1])
    return pages * os.sysconf("SC_PAGE_SIZE")


class MemoryGovernor:
    """Samples footprint and window deadlines; cancels the job on a breach."""

    def __init__(
        self,
        ceiling_bytes: int,
        cancellation: CancellationFlag,
        probe: Callable[[], int] = physical_footprint_bytes,
        clock: Callable[[], float] = time.monotonic,
        interval: float = SAMPLE_SECONDS,
        seconds_per_frame: float = WINDOW_SECONDS_PER_FRAME,
    ) -> None:
        self.ceiling_bytes = ceiling_bytes
        self.seconds_per_frame = seconds_per_frame
        self.cancellation = cancellation
        self.probe = probe
        self.clock = clock
        self.interval = interval
        self.peak_bytes = 0
        self.breach: str | None = None
        self._deadline: float | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> MemoryGovernor:
        self.sample()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="memory-governor")
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def __enter__(self) -> MemoryGovernor:
        return self.start()

    def __exit__(self, *_: object) -> None:
        self.stop()

    def window_started(self, frames: int) -> None:
        with self._lock:
            self._deadline = self.clock() + WINDOW_SECONDS_BASE + self.seconds_per_frame * frames

    def window_finished(self) -> None:
        with self._lock:
            self._deadline = None

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            if self.sample():
                return

    def sample(self) -> bool:
        """Take one sample; returns True once the job has been cancelled for a breach."""
        footprint = self.probe()
        self.peak_bytes = max(self.peak_bytes, footprint)
        with self._lock:
            deadline = self._deadline
        reason = None
        if footprint > self.ceiling_bytes:
            reason = "memory_ceiling"
            detail = "Background removal needed more memory than this machine allows for one job."
        elif deadline is not None and self.clock() > deadline:
            reason = "window_timeout"
            detail = "Background removal stopped: part of the clip took far longer than expected."
        if reason is None:
            return False
        self.breach = reason
        _log.error(
            "smart-mask job limit breached: %s (peak footprint %d MiB)",
            reason,
            self.peak_bytes >> 20,
        )
        self.cancellation.cancel(ProtocolError("internal_error", detail))
        return True

    def report(self) -> dict[str, Any]:
        return {
            "ceilingBytes": self.ceiling_bytes,
            "peakFootprintBytes": self.peak_bytes,
            "breach": self.breach,
        }


__all__ = ["MemoryGovernor", "physical_footprint_bytes"]
