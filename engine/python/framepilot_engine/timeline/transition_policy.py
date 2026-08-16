"""Canonical Python transition boundary policy.

The TypeScript editor-core owns the product-wide transition contract. This module is
its Python semantic mirror and is the single Python decision point for adjacency, clean
cut geometry, and duration capacity. Validation and operation application consume this
result rather than maintaining independent formulas.
"""

from __future__ import annotations

from dataclasses import dataclass

from framepilot_engine.timeline.models import Timeline

_EPSILON = 1e-9


@dataclass(frozen=True)
class TransitionEligibility:
    """Result of checking whether one requested transition fits a real edit boundary."""

    ok: bool
    detail: str
    max_duration_seconds: float | None = None


def transition_eligibility(
    timeline: Timeline,
    *,
    track_id: str,
    from_clip_id: str,
    to_clip_id: str,
    duration_seconds: float,
) -> TransitionEligibility:
    """Validate one transition against the canonical Python boundary contract.

    A legal transition references two adjacent clips on the named track, those clips
    meet at a clean cut, and its requested duration is finite, positive, and no greater
    than half of the shorter neighbouring clip. The half-clip rule mirrors
    editor-core's ``transitionEligibility`` policy.
    """
    if not _finite(duration_seconds) or duration_seconds <= 0:
        return TransitionEligibility(False, "transition duration must be a positive finite number")

    track = next((candidate for candidate in timeline.tracks if candidate.id == track_id), None)
    if track is None:
        return TransitionEligibility(False, f"track '{track_id}' does not exist")

    ordered = sorted(track.clips, key=lambda clip: clip.start)
    to_index = next((index for index, clip in enumerate(ordered) if clip.id == to_clip_id), None)
    if to_index is None:
        return TransitionEligibility(
            False, f"incoming clip '{to_clip_id}' is not on track '{track_id}'"
        )
    if to_index == 0 or ordered[to_index - 1].id != from_clip_id:
        return TransitionEligibility(
            False,
            f"clips '{from_clip_id}' and '{to_clip_id}' are not adjacent in that order "
            f"on track '{track_id}'",
        )

    outgoing = ordered[to_index - 1]
    incoming = ordered[to_index]
    gap = incoming.start - outgoing.end
    if abs(gap) > _EPSILON:
        relation = f"{gap:.6g}s gap" if gap > 0 else f"{-gap:.6g}s overlap"
        return TransitionEligibility(
            False,
            f"transition requires a clean cut but the clips have a {relation}",
        )

    max_duration = min(
        (outgoing.end - outgoing.start) / 2,
        (incoming.end - incoming.start) / 2,
    )
    if duration_seconds > max_duration + _EPSILON:
        return TransitionEligibility(
            False,
            f"requested {duration_seconds}s exceeds this cut's {max_duration}s transition capacity",
            max_duration,
        )
    return TransitionEligibility(True, "transition fits the edit boundary", max_duration)


def _finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))
