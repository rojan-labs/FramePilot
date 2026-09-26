"""One byte budget for every per-frame result an export reuses (a still's resize, its outline).

WHY: a still layer reuses its last resize (``render/still_resize.py``) and its last outline
(``compiler._apply_edge_styles``) while their inputs repeat, and each reuse keeps a copy of its
input to compare against. Kept per layer for the whole export, that is a second copy of every
animated photo at its source size: a 100-photo Ken Burns slideshow of 12 MP stills held about
3.9 GB of reuse entries on top of the 3.4 GB MoviePy holds for the photos themselves. Only the
layers compositing now need an entry, so every entry in the process shares ONE budget, and the
least recently used entries are dropped when it is exceeded.

**Dropping an entry never changes a pixel.** An entry is only ever returned for an input equal to
the one it was computed from, and a missing entry means the next frame computes its result afresh,
as MoviePy always did (``test_element_layer_export.py`` renders under a budget that evicts).

The render service can run export jobs on more than one thread, so the budget is shared by all of
them and guarded by a lock.
"""

from __future__ import annotations

import itertools
import logging
import threading
import weakref
from collections import OrderedDict
from typing import Any

_log = logging.getLogger(__name__)

#: The bytes every reuse entry in the process may hold together. The Scale row's 20 sticker layers
#: (five outlined, five turning) at 4K hold 30.5 MiB in 45 entries (measured 2026-09-26), so this
#: keeps all of them eight times over, and besides them two or three animated 12 MP photos (39 MiB
#: each in a 1080p export, 56 MiB in a 4K one). The reference machine has 16 GB and MoviePy already
#: holds every still at its source size, so this is the most the reuse may add to that.
REUSE_BUDGET_BYTES = 256 * 1024 * 1024
#: An entry larger than this share of the budget (64 MiB) is not kept. Every layer is visited once
#: a frame, in the same order, and an LRU budget smaller than one frame's entries misses on every
#: one of them, so a single huge photo would otherwise flush every sticker's entry on every frame.
#: A layer this large (a 24 MP photo in a 4K export, 90 MiB) resizes afresh, as before any reuse.
MAX_ENTRY_SHARE = 4


class ReuseBudget:
    """Entries keyed by their owner's slot, least recently used first, within ``budget_bytes``."""

    def __init__(self, budget_bytes: int) -> None:
        self.budget_bytes = budget_bytes
        self._entries: OrderedDict[int, tuple[Any, int]] = OrderedDict()
        self._held = 0
        self._lock = threading.Lock()

    @property
    def held_bytes(self) -> int:
        with self._lock:
            return self._held

    @property
    def entry_count(self) -> int:
        with self._lock:
            return len(self._entries)

    def keeps(self, nbytes: int) -> bool:
        """Whether an entry of ``nbytes`` would be kept at all."""
        return nbytes <= self.budget_bytes // MAX_ENTRY_SHARE

    def get(self, key: int) -> Any | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            self._entries.move_to_end(key)
            return entry[0]

    def put(self, key: int, value: Any, nbytes: int) -> None:
        """Keep ``value`` as ``key``'s one entry, dropping the least recently used to fit."""
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._held -= previous[1]
            if not self.keeps(nbytes):
                return
            self._entries[key] = (value, nbytes)
            self._held += nbytes
            dropped = 0
            while self._held > self.budget_bytes:
                _, (_, freed) = self._entries.popitem(last=False)
                self._held -= freed
                dropped += 1
        if dropped:
            _log.debug("reuse budget: dropped %d least recently used entries", dropped)

    def discard(self, key: int) -> None:
        with self._lock:
            entry = self._entries.pop(key, None)
            if entry is not None:
                self._held -= entry[1]


#: The process's budget. Tests replace it to render under another one.
SHARED = ReuseBudget(REUSE_BUDGET_BYTES)

#: Never reused, unlike ``id()``: an outline entry is only right for its own layer's cut-out and
#: styles, so no slot may ever read an entry another slot left behind.
_SLOT_KEYS = itertools.count()


class ReuseSlot:
    """One owner's single entry in the budget, dropped when the owner is garbage collected."""

    def __init__(self, budget: ReuseBudget | None = None) -> None:
        self._budget = budget if budget is not None else SHARED
        self._key = next(_SLOT_KEYS)
        weakref.finalize(self, self._budget.discard, self._key)

    def keeps(self, nbytes: int) -> bool:
        return self._budget.keeps(nbytes)

    def get(self) -> Any | None:
        return self._budget.get(self._key)

    def put(self, value: Any, nbytes: int) -> None:
        self._budget.put(self._key, value, nbytes)

    def clear(self) -> None:
        self._budget.discard(self._key)


__all__ = ["MAX_ENTRY_SHARE", "REUSE_BUDGET_BYTES", "SHARED", "ReuseBudget", "ReuseSlot"]
