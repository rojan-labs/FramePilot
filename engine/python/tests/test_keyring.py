"""Tests for the embeddings key-ring failover state machine (brain.keyring, plan MI0.3)."""

from __future__ import annotations

import logging

import pytest

from framepilot_engine.brain.keyring import (
    DEFAULT_BASE_COOLDOWN_SECONDS,
    DEFAULT_MAX_COOLDOWN_SECONDS,
    EXHAUSTED_REASON,
    KeyRing,
    KeyRingExhaustedError,
    KeyState,
    mask_key,
    parse_keys,
)

KEY_A = "nvapi-aaaa-secret-1111"
KEY_B = "nvapi-bbbb-secret-2222"
KEY_C = "nvapi-cccc-secret-3333"

# --- parse_keys ---------------------------------------------------------------


def test_parse_keys_splits_strips_and_preserves_order() -> None:
    assert parse_keys(" k1 , k2,k3 ") == ("k1", "k2", "k3")


def test_parse_keys_drops_empty_entries() -> None:
    assert parse_keys(",k1,, ,k2,") == ("k1", "k2")


def test_parse_keys_dedupes_keeping_first_occurrence() -> None:
    assert parse_keys("k1,k2,k1,k3,k2") == ("k1", "k2", "k3")


def test_parse_keys_none_and_empty_and_blank() -> None:
    assert parse_keys(None) == ()
    assert parse_keys("") == ()
    assert parse_keys(" , ,") == ()


def test_parse_keys_single_key_no_comma() -> None:
    assert parse_keys("solo") == ("solo",)


# --- mask_key ------------------------------------------------------------------


def test_mask_key_shows_only_last_four_chars() -> None:
    masked = mask_key(KEY_A)
    assert masked == "…1111"
    assert KEY_A not in masked


def test_mask_key_fully_stars_short_keys() -> None:
    assert mask_key("abcd") == "…****"
    assert mask_key("ab") == "…**"


# --- construction ----------------------------------------------------------------


def test_constructor_rejects_non_positive_base_cooldown() -> None:
    with pytest.raises(ValueError, match="base_cooldown_seconds"):
        KeyRing([KEY_A], base_cooldown_seconds=0.0)


def test_constructor_rejects_cap_below_base() -> None:
    with pytest.raises(ValueError, match="max_cooldown_seconds"):
        KeyRing([KEY_A], base_cooldown_seconds=10.0, max_cooldown_seconds=5.0)


def test_constructor_dedupes_defensively() -> None:
    ring = KeyRing([KEY_A, KEY_A, KEY_B])
    assert len(ring.health(0.0)) == 2


def test_empty_ring_is_exhausted_and_acquires_nothing() -> None:
    ring = KeyRing([])
    assert ring.acquire(0.0) is None
    assert ring.exhausted(0.0)
    assert ring.health(0.0) == []


# --- rotation & failover ---------------------------------------------------------


def test_acquire_prefers_earlier_keys_while_alive() -> None:
    ring = KeyRing([KEY_A, KEY_B])
    assert ring.acquire(0.0) == KEY_A
    assert ring.acquire(0.0) == KEY_A  # stable until a failure is reported


def test_transient_failure_rotates_to_next_key() -> None:
    ring = KeyRing([KEY_A, KEY_B])
    ring.report_failure(KEY_A, 429, now=0.0)
    assert ring.acquire(0.0) == KEY_B


def test_auth_rejection_marks_key_dead_for_the_session() -> None:
    ring = KeyRing([KEY_A, KEY_B])
    ring.report_failure(KEY_A, 401, now=0.0)
    assert ring.health(0.0)[0].state is KeyState.DEAD
    # Dead is permanent: no amount of elapsed time revives it.
    assert ring.acquire(1e9) == KEY_B


def test_403_also_marks_dead() -> None:
    ring = KeyRing([KEY_A])
    ring.report_failure(KEY_A, 403, now=0.0)
    assert ring.health(0.0)[0].state is KeyState.DEAD
    assert ring.exhausted(1e9)


def test_unknown_status_cools_down_conservatively() -> None:
    ring = KeyRing([KEY_A])
    ring.report_failure(KEY_A, 418, now=0.0)
    assert ring.health(0.0)[0].state is KeyState.COOLING
    assert ring.acquire(0.0) is None


def test_5xx_cools_down() -> None:
    ring = KeyRing([KEY_A, KEY_B])
    ring.report_failure(KEY_A, 503, now=0.0)
    assert ring.health(0.0)[0].state is KeyState.COOLING
    assert ring.acquire(0.0) == KEY_B


# --- cooldown backoff --------------------------------------------------------------


def test_429_backoff_doubles_per_consecutive_failure() -> None:
    ring = KeyRing([KEY_A], base_cooldown_seconds=2.0, max_cooldown_seconds=300.0)
    ring.report_failure(KEY_A, 429, now=0.0)
    assert ring.health(0.0)[0].cooldown_remaining == pytest.approx(2.0)
    assert ring.acquire(2.0) == KEY_A  # cooled down → revived
    ring.report_failure(KEY_A, 429, now=2.0)
    assert ring.health(2.0)[0].cooldown_remaining == pytest.approx(4.0)
    assert ring.acquire(6.0) == KEY_A
    ring.report_failure(KEY_A, 429, now=6.0)
    assert ring.health(6.0)[0].cooldown_remaining == pytest.approx(8.0)


def test_backoff_caps_at_max_cooldown() -> None:
    ring = KeyRing([KEY_A], base_cooldown_seconds=2.0, max_cooldown_seconds=5.0)
    now = 0.0
    for _ in range(4):  # 2 → 4 → 5 → 5 (capped)
        assert ring.acquire(now) == KEY_A
        ring.report_failure(KEY_A, 429, now=now)
        now += 1000.0
    ring.report_failure(KEY_A, 429, now=now)
    assert ring.health(now)[0].cooldown_remaining == pytest.approx(5.0)


def test_cooldown_expiry_revives_key_via_acquire() -> None:
    ring = KeyRing([KEY_A])
    ring.report_failure(KEY_A, 429, now=10.0)
    assert ring.acquire(11.0) is None
    assert ring.exhausted(11.0)
    assert not ring.exhausted(12.0)  # exhausted() never mutates
    assert ring.health(11.0)[0].state is KeyState.COOLING
    assert ring.acquire(12.0) == KEY_A
    assert ring.health(12.0)[0].state is KeyState.ALIVE


def test_success_resets_backoff_to_base() -> None:
    ring = KeyRing([KEY_A], base_cooldown_seconds=2.0)
    ring.report_failure(KEY_A, 429, now=0.0)
    ring.report_failure(KEY_A, 429, now=2.0)  # backoff now 8s pending
    assert ring.acquire(6.0) == KEY_A
    ring.report_success(KEY_A)
    health = ring.health(6.0)[0]
    assert health.state is KeyState.ALIVE
    assert health.last_status is None
    ring.report_failure(KEY_A, 429, now=6.0)
    assert ring.health(6.0)[0].cooldown_remaining == pytest.approx(2.0)  # back to base


def test_success_while_cooling_revives_immediately() -> None:
    ring = KeyRing([KEY_A])
    ring.report_failure(KEY_A, 429, now=0.0)
    ring.report_success(KEY_A)
    assert ring.acquire(0.0) == KEY_A


def test_success_never_revives_a_dead_key() -> None:
    ring = KeyRing([KEY_A])
    ring.report_failure(KEY_A, 401, now=0.0)
    ring.report_success(KEY_A)
    assert ring.health(0.0)[0].state is KeyState.DEAD
    assert ring.acquire(0.0) is None


def test_late_transient_report_never_resurrects_a_dead_key() -> None:
    ring = KeyRing([KEY_A])
    ring.report_failure(KEY_A, 401, now=0.0)
    ring.report_failure(KEY_A, 429, now=1.0)
    assert ring.health(100.0)[0].state is KeyState.DEAD
    assert ring.acquire(100.0) is None


# --- exhaustion ------------------------------------------------------------------


def test_all_keys_failing_exhausts_the_ring() -> None:
    ring = KeyRing([KEY_A, KEY_B, KEY_C])
    ring.report_failure(KEY_A, 401, now=0.0)
    ring.report_failure(KEY_B, 429, now=0.0)
    ring.report_failure(KEY_C, 500, now=0.0)
    assert ring.acquire(0.5) is None
    assert ring.exhausted(0.5)
    assert ring.last_status == 500


def test_exhausted_error_carries_status_and_error() -> None:
    err = KeyRingExhaustedError(last_status=429, last_error="rate limited")
    assert err.last_status == 429
    assert err.last_error == "rate limited"
    assert "429" in str(err)
    assert EXHAUSTED_REASON == "all_keys_failing"


def test_exhausted_error_without_status() -> None:
    err = KeyRingExhaustedError()
    assert err.last_status is None
    assert err.last_error is None
    assert "no status recorded" in str(err)


def test_last_status_starts_none() -> None:
    assert KeyRing([KEY_A]).last_status is None


def test_fresh_ring_with_an_alive_key_is_not_exhausted() -> None:
    assert not KeyRing([KEY_A]).exhausted(0.0)


# --- unknown-key reporting ---------------------------------------------------------


def test_reporting_an_unknown_key_raises_with_masked_message() -> None:
    ring = KeyRing([KEY_A])
    with pytest.raises(ValueError) as excinfo:
        ring.report_success(KEY_B)
    assert KEY_B not in str(excinfo.value)
    with pytest.raises(ValueError):
        ring.report_failure(KEY_B, 429, now=0.0)


# --- secrecy: keys never leak ---------------------------------------------------------


def test_full_key_never_appears_in_health_repr_or_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ring = KeyRing([KEY_A, KEY_B])
    with caplog.at_level(logging.DEBUG, logger="framepilot_engine.brain.keyring"):
        ring.report_failure(KEY_A, 401, now=0.0)
        ring.report_failure(KEY_B, 429, now=0.0)
        ring.acquire(10.0)  # revives B → debug log

    health = ring.health(10.0)
    dumped = " ".join(h.model_dump_json(by_alias=True) for h in health)
    everything = dumped + repr(ring) + repr(health) + caplog.text
    for key in (KEY_A, KEY_B):
        assert key not in everything
    assert health[0].fingerprint == "…1111"
    assert health[1].fingerprint == "…2222"


def test_health_snapshot_shape_and_aliases() -> None:
    ring = KeyRing([KEY_A])
    ring.report_failure(KEY_A, 429, now=0.0)
    payload = ring.health(1.0)[0].model_dump(by_alias=True)
    assert payload == {
        "index": 0,
        "fingerprint": "…1111",
        "state": "cooling",
        "cooldownRemaining": pytest.approx(DEFAULT_BASE_COOLDOWN_SECONDS - 1.0),
        "lastStatus": 429,
    }
    assert DEFAULT_MAX_COOLDOWN_SECONDS == 300.0


# --- exclusive checkout: several keys as throughput, not just failover -----------


def test_exclusive_checkout_spreads_concurrent_callers_across_keys() -> None:
    """Several keys used to buy resilience and nothing else.

    `acquire` always answered "the first alive key", so eight concurrent embedding
    requests all queued behind one key's rate limit — the Settings field invites
    comma-separated keys and the user reasonably reads that as throughput.
    """
    ring = KeyRing(["a", "b", "c"])
    taken = [ring.acquire(0.0, exclusive=True) for _ in range(3)]
    assert sorted(k for k in taken if k is not None) == ["a", "b", "c"]


def test_a_released_key_is_offered_again() -> None:
    ring = KeyRing(["a", "b"])
    first = ring.acquire(0.0, exclusive=True)
    ring.acquire(0.0, exclusive=True)
    assert first is not None
    ring.release(first)
    assert ring.acquire(0.0, exclusive=True) == first


def test_one_key_under_checkout_behaves_exactly_as_before() -> None:
    ring = KeyRing(["only"])
    assert [ring.acquire(0.0, exclusive=True) for _ in range(3)] == ["only"] * 3


def test_the_sequential_path_is_untouched_by_the_checkout_machinery() -> None:
    """A caller that never releases must see the original stable rotation."""
    ring = KeyRing(["a", "b", "c"])
    assert [ring.acquire(0.0) for _ in range(5)] == ["a"] * 5


def test_release_below_zero_is_a_no_op() -> None:
    ring = KeyRing(["a"])
    ring.release("a")
    ring.release("unknown")
    assert ring.acquire(0.0, exclusive=True) == "a"


def test_alive_count_is_the_ceiling_on_useful_concurrency() -> None:
    ring = KeyRing(["a", "b", "c"])
    assert ring.alive_count(0.0) == 3
    ring.report_failure("a", 401, 0.0)  # dead for the session
    ring.report_failure("b", 429, 0.0)  # cooling
    assert ring.alive_count(0.0) == 1
    # The cooled key comes back and concurrency rises with it — the backpressure is the
    # ring's own state, not a second limiter to keep in sync.
    assert ring.alive_count(10_000.0) == 2
