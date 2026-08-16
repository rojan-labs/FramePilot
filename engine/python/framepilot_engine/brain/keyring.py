"""Multi-key failover state machine for the NVIDIA embeddings API (plan MI0.3).

WHY: the visual-embeddings setting is a comma-separated list of NVIDIA API keys
(decision D5 in ``plan/MEDIA-INTELLIGENCE.md``): when one key is rate-limited or
revoked the indexer must rotate to the next instead of stalling a background
job. This module is the *pure* state machine behind that failover — parsing,
rotation order, per-key exponential cooldown, session-permanent dead-marking,
and a typed exhaustion signal — with **no I/O and no clock reads**: callers
inject a monotonic ``now`` so every transition is deterministic and testable.

Failover semantics (plan §3.2):

- ``401``/``403`` → the key is rejected outright; mark it **dead** for the
  session (retrying an invalid key only burns quota and log noise).
- ``429``/``5xx`` → transient; put the key on **cooldown** with per-key
  exponential backoff (base doubles per consecutive failure, capped) and rotate
  to the next key.
- Any other reported status → cooldown too (conservative: an unknown failure
  is treated as transient, never as proof the key is bad).
- All keys dead or cooling → the ring is **exhausted**; the client surfaces the
  typed ``{available: false, reason: "all_keys_failing"}`` shape upstream.

Key material is secret: it never appears in logs, ``repr``s, exceptions, or the
:class:`KeyHealth` snapshots — only a masked fingerprint (last few characters)
is ever exposed.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum

from pydantic import BaseModel, Field

_log = logging.getLogger(__name__)

#: First cooldown after a transient failure, in seconds; doubles per
#: consecutive failure of the same key.
DEFAULT_BASE_COOLDOWN_SECONDS = 2.0

#: Ceiling on a single key's cooldown — beyond ~5 minutes longer waits stop
#: helping a background indexing job and only delay honest exhaustion reporting.
DEFAULT_MAX_COOLDOWN_SECONDS = 300.0

#: HTTP statuses that prove the key itself is bad (auth rejection) — the key is
#: dead for the session, not merely cooling down.
FATAL_STATUSES = frozenset({401, 403})

#: Typed reason string surfaced upstream when the whole ring is exhausted
#: (``{available: false, reason: EXHAUSTED_REASON}`` — plan §3.2).
EXHAUSTED_REASON = "all_keys_failing"

#: How many trailing characters of a key the masked fingerprint reveals.
_FINGERPRINT_CHARS = 4


class KeyState(StrEnum):
    """Lifecycle of one key in the ring."""

    ALIVE = "alive"
    COOLING = "cooling"  # transient failure; usable again after ``cooldown_until``
    DEAD = "dead"  # auth-rejected; permanent for the session


class KeyHealth(BaseModel):
    """Masked health snapshot of one key, for ``/brain/visual/status`` + the UI.

    Carries only the ring ``index`` and a masked ``fingerprint`` — never the
    key itself (D5: keys are stored plaintext by explicit user choice, but the
    engine still never echoes them back).
    """

    index: int = Field(ge=0)
    fingerprint: str = Field(description="Masked identity: '…' + the key's last 4 chars.")
    state: KeyState
    cooldown_remaining: float = Field(
        alias="cooldownRemaining", ge=0.0, description="Seconds until usable; 0 unless cooling."
    )
    last_status: int | None = Field(
        default=None, alias="lastStatus", description="HTTP status of the last failure, if any."
    )

    model_config = {"populate_by_name": True}


class KeyRingExhaustedError(Exception):
    """Every key is dead or cooling — the typed 'all_keys_failing' signal.

    Raised by the embedding client (plan MI2.1) when :meth:`KeyRing.acquire`
    has nothing to offer; ``last_status``/``last_error`` feed the honest
    ``{available: false, reason: "all_keys_failing", lastError}`` payload.
    """

    def __init__(
        self, *, last_status: int | None = None, last_error: str | None = None
    ) -> None:
        detail = f"lastStatus={last_status}" if last_status is not None else "no status recorded"
        super().__init__(f"All embeddings API keys are failing ({detail}).")
        self.last_status = last_status
        self.last_error = last_error


def parse_keys(raw: str | None) -> tuple[str, ...]:
    """Parse the comma-separated key setting into an ordered, de-duplicated tuple.

    Whitespace around each key is stripped, empty entries are dropped, order is
    preserved, and a repeated key keeps only its first occurrence (a duplicate
    would otherwise split one key's failure history across two slots).

    :param raw: The raw setting value (``None``/empty → no keys).
    :returns: The keys, in configured order.
    """
    if raw is None:
        return ()
    seen: dict[str, None] = {}
    for part in raw.split(","):
        key = part.strip()
        if key and key not in seen:
            seen[key] = None
    return tuple(seen)


def mask_key(key: str) -> str:
    """Masked fingerprint for logs/health: '…' + the last 4 chars, never more.

    A key no longer than the fingerprint would be revealed in full, so it is
    fully starred out instead.
    """
    if len(key) <= _FINGERPRINT_CHARS:
        return "…" + "*" * len(key)
    return "…" + key[-_FINGERPRINT_CHARS:]


@dataclass
class _KeySlot:
    """Mutable per-key state. ``repr=False`` on ``key`` keeps it out of reprs."""

    key: str = field(repr=False)
    state: KeyState = KeyState.ALIVE
    cooldown_until: float = 0.0
    next_cooldown: float = DEFAULT_BASE_COOLDOWN_SECONDS
    last_status: int | None = None


class KeyRing:
    """Ordered ring of API keys with failover, cooldown, and dead-marking.

    Pure state machine: every time-dependent method takes a monotonic ``now``
    (seconds; e.g. ``time.monotonic()`` at the call site) — the ring itself
    never reads a clock.
    """

    def __init__(
        self,
        keys: Sequence[str],
        *,
        base_cooldown_seconds: float = DEFAULT_BASE_COOLDOWN_SECONDS,
        max_cooldown_seconds: float = DEFAULT_MAX_COOLDOWN_SECONDS,
    ) -> None:
        """
        :param keys: Keys in priority order (normally from :func:`parse_keys`).
            Duplicates are dropped defensively — two slots sharing one key
            would corrupt per-key failure tracking.
        :param base_cooldown_seconds: First cooldown after a transient failure.
        :param max_cooldown_seconds: Cap on the exponential backoff.
        :raises ValueError: On a non-positive base or a cap below the base.
        """
        if base_cooldown_seconds <= 0:
            raise ValueError(f"base_cooldown_seconds must be > 0, got {base_cooldown_seconds}.")
        if max_cooldown_seconds < base_cooldown_seconds:
            raise ValueError(
                f"max_cooldown_seconds ({max_cooldown_seconds}) must be >= "
                f"base_cooldown_seconds ({base_cooldown_seconds})."
            )
        self._base_cooldown = base_cooldown_seconds
        self._max_cooldown = max_cooldown_seconds
        self._slots: list[_KeySlot] = [
            _KeySlot(key=key, next_cooldown=base_cooldown_seconds)
            for key in dict.fromkeys(keys)
        ]
        self._last_status: int | None = None

    def __repr__(self) -> str:  # never leaks key material
        states = ",".join(slot.state.value for slot in self._slots)
        return f"KeyRing(keys={len(self._slots)}, states=[{states}])"

    @property
    def last_status(self) -> int | None:
        """HTTP status of the most recent failure reported to the ring, if any."""
        return self._last_status

    def acquire(self, now: float) -> str | None:
        """Pick the key to use next, or ``None`` if the ring is exhausted.

        Preference order: the first **alive** key (stable rotation — earlier
        keys are always retried first once healthy), else the first **cooling**
        key whose cooldown has elapsed (which is revived to alive), else
        ``None``.
        """
        for slot in self._slots:
            if slot.state is KeyState.ALIVE:
                return slot.key
        for slot in self._slots:
            if slot.state is KeyState.COOLING and slot.cooldown_until <= now:
                slot.state = KeyState.ALIVE
                _log.debug("embeddings key %s cooled down; back in rotation", mask_key(slot.key))
                return slot.key
        return None

    def report_success(self, key: str) -> None:
        """Record a successful call: reset the key's backoff and failure state.

        A dead key stays dead — dead-marking is session-permanent by design,
        and a success report for one indicates caller confusion, not recovery.
        """
        slot = self._slot_for(key)
        slot.next_cooldown = self._base_cooldown
        slot.cooldown_until = 0.0
        slot.last_status = None
        if slot.state is not KeyState.DEAD:
            slot.state = KeyState.ALIVE

    def report_failure(self, key: str, status: int, now: float) -> None:
        """Record a failed call and transition the key per the D5 semantics.

        ``401``/``403`` → dead for the session. Everything else (``429``,
        ``5xx``, and — conservatively — any other status) → cooldown with
        exponential backoff, doubling per consecutive failure up to the cap.
        """
        slot = self._slot_for(key)
        slot.last_status = status
        self._last_status = status
        if status in FATAL_STATUSES:
            slot.state = KeyState.DEAD
            _log.warning(
                "embeddings key %s rejected with HTTP %d; dead for this session",
                mask_key(slot.key),
                status,
            )
            return
        if slot.state is KeyState.DEAD:
            return  # a late transient report must not resurrect a dead key
        slot.state = KeyState.COOLING
        slot.cooldown_until = now + slot.next_cooldown
        _log.debug(
            "embeddings key %s cooling for %.1fs after HTTP %d",
            mask_key(slot.key),
            slot.next_cooldown,
            status,
        )
        slot.next_cooldown = min(slot.next_cooldown * 2.0, self._max_cooldown)

    def exhausted(self, now: float) -> bool:
        """Whether :meth:`acquire` would return ``None`` at ``now`` (no mutation)."""
        for slot in self._slots:
            if slot.state is KeyState.ALIVE:
                return False
            if slot.state is KeyState.COOLING and slot.cooldown_until <= now:
                return False
        return True

    def health(self, now: float) -> list[KeyHealth]:
        """Masked per-key snapshot for status surfacing (never the keys themselves)."""
        return [
            KeyHealth(
                index=index,
                fingerprint=mask_key(slot.key),
                state=slot.state,
                cooldown_remaining=(
                    max(0.0, slot.cooldown_until - now)
                    if slot.state is KeyState.COOLING
                    else 0.0
                ),
                last_status=slot.last_status,
            )
            for index, slot in enumerate(self._slots)
        ]

    def _slot_for(self, key: str) -> _KeySlot:
        for slot in self._slots:
            if slot.key == key:
                return slot
        # The masked fingerprint keeps even a *wrong* key out of the exception text.
        raise ValueError(f"Key {mask_key(key)} is not in this ring.")
