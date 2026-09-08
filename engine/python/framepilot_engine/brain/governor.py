"""One resource governor for background footage indexing (plan VU8 §8.3).

WHY ONE MODULE: background indexing is the only thing in this sidecar that competes
with the user for the machine *while they are editing*. The rules that keep it polite
are few, fixed, and worth reading in one place — a governor spread across four routes
and three settings is a governor nobody can reason about, and the first symptom of that
is a render that got slower for a reason no one can name.

Three rules, and nothing else:

1. **Workers per tier.** Tier 0 is a pure ffmpeg decode and scales with cores:
   ``max(1, cores // 4)``. Tiers 1 and 2 get one worker each — they are dominated by a
   provider round trip or a resident model, and more of them buys latency, not throughput.
2. **Foreground work pauses every tier.** While a render, an export, a ``/render/frame``
   or a ``/review/temporal-evidence`` batch is in flight, indexing does not start a slice;
   it resumes :data:`IDLE_RESUME_SECONDS` after the last one finishes. This is the
   property a user actually feels, and it is deliberately modelled on the existing
   ``_temporal_evidence_gate`` rather than as a second, parallel mechanism: the gate says
   "one heavy batch at a time", this says "and nothing cheap runs behind it".
3. **Tier 2 refuses to start when memory is short.** Free memory below
   :data:`TIER2_MEMORY_HEADROOM` times the tier-2 model's resident size records
   ``skipped: low_memory`` for that slice and is re-evaluated on the next one. Tiers 0
   and 1 are untouched — the whole point of the three-column ledger is that the cheap
   facts survive the expensive tier being unavailable.

There is no configuration surface. Every number here is a constant with the reasoning
next to it; a knob would be one more thing to get wrong in a support thread.

Nothing in this module touches the brain, a project, or a key: it is a pure resource
question, and it is unit-testable with an injected clock, core count and memory reader.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

__all__ = [
    "IDLE_RESUME_SECONDS",
    "TIER0_CORES_PER_WORKER",
    "TIER2_MEMORY_HEADROOM",
    "TIER2_MODEL_RESIDENT_BYTES",
    "IndexGovernor",
    "free_memory_bytes",
]

_log = logging.getLogger(__name__)

#: Cores per tier-0 worker. Tier 0 is one ``ffmpeg`` process per asset, each of which
#: already threads internally, so a quarter of the machine saturates the decode without
#: leaving the editor's own work waiting behind a full core count.
TIER0_CORES_PER_WORKER = 4

#: Seconds of foreground quiet before indexing starts a slice again. Short enough that a
#: paused library resumes while the user is still reading the frame they rendered; long
#: enough that a burst of ``/render/frame`` calls (the agent's verification loop fires
#: several in a row) is treated as one busy period rather than N gaps to squeeze into.
IDLE_RESUME_SECONDS = 2.0

#: Resident size assumed for a tier-2 (description) model. The built-in tier-2 path calls
#: a hosted vision provider and holds only decoded frames, but a local perception pack
#: (plan VU5) loads a captioner into this process, and the refusal rule has to be written
#: against the worst case rather than the current one. A conservative small-VLM figure.
TIER2_MODEL_RESIDENT_BYTES = 1_500_000_000

#: How much free memory tier 2 requires, as a multiple of the model's resident size. Two,
#: because loading a model needs room for the weights AND the working set that decodes
#: frames into it; starting at exactly the weight size is how a swap storm begins.
TIER2_MEMORY_HEADROOM = 2.0

#: Recorded on the ``described`` tier when memory is short (plan §8.3). A stable string:
#: the host and the coverage line both read it, and a varying number in it would break the
#: agent-side repeated-failure guard.
LOW_MEMORY_REASON = "low_memory"

#: Stands in for "this tier takes nothing from the local machine, so bound it elsewhere".
_NO_LOCAL_LIMIT = 1 << 30


def free_memory_bytes() -> int | None:
    """Bytes of memory available for a new allocation, or ``None`` if unknowable.

    No new dependency: ``psutil`` is not a dependency of this engine and adding one for a
    single number is not a trade this codebase makes. Two readings instead:

    * Linux — ``MemAvailable`` from ``/proc/meminfo``, which is the kernel's own estimate
      of what a new process can get, reclaimable page cache included.
    * Otherwise (macOS is the product's first platform) — ``SC_AVPHYS_PAGES``, the free
      page count. It *under*-reports on macOS, because it excludes the large purgeable
      and compressed pools the VM reclaims on demand. Under-reporting is the safe
      direction for a refusal rule: the worst it does is defer tier 2 on a machine that
      could have run it, and the next slice asks again.

    ``None`` — no reading available — means the memory rule does not fire. A governor that
    blocked work because it could not measure would turn an unknown into an outage.
    """
    meminfo = Path("/proc/meminfo")
    try:
        if meminfo.exists():
            for line in meminfo.read_text(encoding="utf-8").splitlines():
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):  # pragma: no cover - unreadable procfs
        return None
    try:
        return int(os.sysconf("SC_AVPHYS_PAGES")) * int(os.sysconf("SC_PAGE_SIZE"))
    except (ValueError, OSError, AttributeError):  # pragma: no cover - platform without it
        return None


class IndexGovernor:
    """The scheduling authority for background indexing slices.

    Thread-safe: routes run in Starlette's threadpool, so foreground work is entered and
    left from several threads at once and the busy count has to be a guarded integer
    rather than a boolean anybody can clobber.

    Every input is injectable so the rules are testable without a render, a real clock or
    a particular machine — the constants above are the product decision, this class is
    only the arithmetic that applies them.

    :param cpu_count: Cores to size tier 0 against; defaults to the machine's.
    :param clock: Monotonic seconds source.
    :param free_memory: Reader for available bytes; defaults to :func:`free_memory_bytes`,
        and a reading of ``None`` from it disables the memory rule.
    :param external_busy: Foreground work this process does NOT enter and leave through
        :meth:`foreground` — the async render queue, whose jobs outlive the request that
        submitted them. Returns a label, or ``None`` when the queue is idle.
    """

    def __init__(
        self,
        *,
        cpu_count: int | None = None,
        clock: Callable[[], float] = time.monotonic,
        free_memory: Callable[[], int | None] | None = None,
        external_busy: Callable[[], str | None] | None = None,
    ) -> None:
        self._cores = max(1, cpu_count if cpu_count is not None else (os.cpu_count() or 1))
        self._clock = clock
        # Resolved here rather than as a default argument so the module-level reader can
        # be substituted (a test cannot re-bind a default that was captured at def time).
        self._free_memory = free_memory if free_memory is not None else free_memory_bytes
        self._external_busy = external_busy
        self._lock = threading.Lock()
        self._busy: dict[str, int] = {}
        # Far enough in the past that an untouched governor is never in its cool-down.
        self._idle_since = clock() - IDLE_RESUME_SECONDS

    # -- rule 1: workers per tier ------------------------------------------------

    def tier_workers(self, tier: str, *, hosted: bool = False) -> int:
        """How many assets this tier may work on at once.

        The rule governs LOCAL compute, which is the resource background indexing takes
        away from the editor. Tier 0 is always local (one ``ffmpeg`` per asset) and gets a
        quarter of the machine. Tiers 1 and 2 get one worker each *when their cost is a
        resident model*.

        ``hosted=True`` says the tier's cost is a provider round trip rather than this
        machine — which is what the built-in tier-1 path actually is today. Holding that
        to one worker would not protect anything: it was measured at ~98% waiting on the
        network (60 photos, 92.7 s wall against 1.5 s of local CPU), and serialising it
        buys the user a slower library and no headroom. The tier's own configured
        concurrency bounds it instead, so the caller's ``min`` decides.

        :param tier: ``measured`` / ``labelled`` / ``described``.
        :param hosted: Whether this tier's work is a network round trip.
        :returns: The local-worker cap; a large ceiling for a hosted tier, leaving the
            bound to the caller's configured concurrency.
        """
        if tier == "measured":
            return max(1, self._cores // TIER0_CORES_PER_WORKER)
        return _NO_LOCAL_LIMIT if hosted else 1

    # -- rule 2: foreground work pauses every tier -------------------------------

    @contextmanager
    def foreground(self, label: str) -> Iterator[None]:
        """Mark foreground work in flight for the duration of the block.

        The cool-down starts when the LAST concurrent piece of foreground work leaves,
        not the first, so overlapping renders do not each reset a timer the others are
        still inside.
        """
        with self._lock:
            self._busy[label] = self._busy.get(label, 0) + 1
        try:
            yield
        finally:
            with self._lock:
                remaining = self._busy.get(label, 1) - 1
                if remaining <= 0:
                    self._busy.pop(label, None)
                else:
                    self._busy[label] = remaining
                if not self._busy:
                    self._idle_since = self._clock()

    def defer_reason(self) -> str | None:
        """Why indexing must not start a slice right now, or ``None`` to proceed.

        A *reason*, not a boolean, because it is written into the slice's ``tiers`` map
        and read by a person looking at a coverage line that stopped moving. "Indexing is
        broken" and "indexing is being polite while you export" must not look the same.
        """
        with self._lock:
            busy = sorted(self._busy)
            idle_since = self._idle_since
        external = self._external_busy() if self._external_busy is not None else None
        if external is not None:
            busy = sorted({*busy, external})
        if busy:
            return f"deferred while {', '.join(busy)} is in flight"
        waited = self._clock() - idle_since
        if waited < IDLE_RESUME_SECONDS:
            return f"deferred for {IDLE_RESUME_SECONDS - waited:.1f}s of foreground idle"
        return None

    def wait_until_clear(
        self,
        *,
        budget: float = IDLE_RESUME_SECONDS,
        poll: float = 0.05,
        sleep: Callable[[float], None] = time.sleep,
    ) -> str | None:
        """Block up to ``budget`` seconds for the pause to lift; report why if it did not.

        WHY THIS BLOCKS. Indexing is paced by the HOST, which re-POSTs a slice the instant
        the previous one answers (``visual-index-client.ts`` has no delay between
        iterations, only a slice-count safety bound). An instant "deferred" answer would
        therefore spin the loop at request rate for the whole length of an export. Holding
        the request for a bounded moment turns that into one poll every couple of seconds,
        which is what a pause is supposed to cost.

        Called BEFORE the brain connection is opened, so a paused slice never sits on a
        SQLite handle while it waits.

        :returns: ``None`` once nothing is in flight, or the deferral reason at timeout.
        """
        deadline = self._clock() + budget
        reason = self.defer_reason()
        while reason is not None and self._clock() < deadline:
            sleep(poll)
            reason = self.defer_reason()
        return reason

    # -- rule 3: tier 2 needs headroom -------------------------------------------

    def tier2_skip_reason(self) -> str | None:
        """Why tier 2 must not start this slice, or ``None``.

        Tier 2 only. A machine too small to describe footage is still perfectly able to
        measure and label it, and the ledger's three columns exist so that the answer to
        "not enough memory" is a reported hole rather than a stalled job.
        """
        free = self._free_memory()
        if free is None:
            return None
        required = int(TIER2_MEMORY_HEADROOM * TIER2_MODEL_RESIDENT_BYTES)
        if free >= required:
            return None
        _log.info(
            "ACT indexing tier 2 deferred: free=%dMB required=%dMB",
            free // (1024 * 1024),
            required // (1024 * 1024),
        )
        return LOW_MEMORY_REASON
