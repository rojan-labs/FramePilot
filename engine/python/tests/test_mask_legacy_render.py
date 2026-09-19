"""Legacy migration gate (MK2.4): v21 mask effects export byte-identically on the v22 stack.

``tests/fixtures/mask-render/legacy-v21.json`` holds v21 clips with ``mask`` effects, and
``legacy-v21.migrated.json`` holds what the app's TypeScript migration turns them into (pinned
by ``packages/timeline-schema/src/mask-legacy-render-fixture.test.ts``). For every case and
sample, the alpha the v21 compiler attached (``rasterize_mask`` of the effect's spec at
clip time) must EQUAL, bit for bit, the alpha the v22 stack attaches for the migrated clip,
at the full cropped frame and at a decode-capped frame. ``_attach_mask`` multiplies this
alpha by the clip opacity exactly as v21 did, so equal alpha is an identical export.

MK2.5: ``legacy-v21.timings.migrated.json`` re-times every moving case to 1 s clips that start
mid-timeline at several frame rates (E2E.5's clip is the ``keyframed-ellipse-mid-timeline``
case). There the frame instants are not round, and the stored centre stops being one-to-one
with v21's fractions (x = 0.2 and 0.19999999999999996 store one centre); the migrated
``legacySpec`` is what makes every such frame exact, and these tests require that it, not the
recovery, drew every frame.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

import framepilot_engine.render.mask_stack as mask_stack
from framepilot_engine.render.mask_stack import clip_mask_stacks
from framepilot_engine.render.masks import (
    has_mask_keyframes,
    mask_spec_at,
    mask_spec_from_params,
    rasterize_mask,
)
from framepilot_engine.timeline.models import Clip, Effect

_FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "mask-render"
_INPUT = json.loads((_FIXTURES / "legacy-v21.json").read_text(encoding="utf-8"))
_TIMINGS = json.loads((_FIXTURES / "legacy-v21.timings.migrated.json").read_text(encoding="utf-8"))[
    "variants"
]
_MIGRATED = {
    case["id"]: case["clip"]
    for case in json.loads((_FIXTURES / "legacy-v21.migrated.json").read_text(encoding="utf-8"))[
        "cases"
    ]
}


def _v21_alpha(effect: Effect, t: float, width: int, height: int) -> np.ndarray:
    spec = (
        mask_spec_at(effect, t)
        if has_mask_keyframes(effect)
        else mask_spec_from_params(effect.params)
    )
    return rasterize_mask(spec, width, height)


def _frame_sizes(clip: dict[str, Any]) -> list[tuple[int, int]]:
    media = _INPUT["media"]
    crop = clip.get("crop") or {"width": 1.0, "height": 1.0}
    full = (round(crop["width"] * media["width"]), round(crop["height"] * media["height"]))
    return [full, (full[0] // 2, full[1] // 2)]


def test_every_fixture_case_was_migrated() -> None:
    assert sorted(_MIGRATED) == sorted(case["id"] for case in _INPUT["cases"])
    assert len(_MIGRATED) >= 9
    for clip in _MIGRATED.values():
        assert clip["masks"][0]["legacySpec"] is not None


def _frame_times(clip: dict[str, Any], fps: float) -> list[float]:
    """Clip-local times of every frame the export renders: ``n / fps - start`` in [start, end)."""
    start, end = float(clip["start"]), float(clip["end"])
    times: list[float] = []
    frame = max(0, math.floor(start * fps) - 1)
    while frame / fps < end:
        if frame / fps >= start:
            times.append(frame / fps - start)
        frame += 1
    return times


def _assert_every_frame_matches_v21(
    case_id: str,
    v21_clip: dict[str, Any],
    migrated_clip: dict[str, Any],
    media: dict[str, Any] | None,
    fps: float,
    monkeypatch: pytest.MonkeyPatch,
) -> int:
    """Every rendered frame, at two frame sizes, bit-identical to v21; returns frames checked.

    Also requires that the stored v21 spec (``legacySpec``), not the fraction recovery, drew
    every frame: recovery is only a best effort for masks edited after the migration.
    """
    first_mask = next(effect for effect in v21_clip["effects"] if effect["type"] == "mask")
    effect = Effect.model_validate(first_mask)
    migrated = Clip.model_validate(migrated_clip)
    media_size = None if media is None else (media["width"], media["height"])
    stacks = clip_mask_stacks(migrated, media_size)
    assert stacks is not None and len(stacks.alpha) == 1
    recovered: list[float] = []
    stored_spec = mask_stack._stored_v21_spec

    def spy(mask: Any, s: float, *rest: Any) -> Any:
        spec = stored_spec(mask, s, *rest)
        if spec is None:
            recovered.append(s)
        return spec

    monkeypatch.setattr(mask_stack, "_stored_v21_spec", spy)
    checked = 0
    for width, height in _frame_sizes(v21_clip):
        for t in _frame_times(v21_clip, fps):
            expected = _v21_alpha(effect, t, width, height)
            actual = stacks.alpha_at(t, width, height)
            assert actual is not None
            assert actual.dtype == expected.dtype
            assert actual.tobytes() == expected.tobytes(), (case_id, width, height, t)
            checked += 1
    assert recovered == [], (case_id, "recovered instead of the stored v21 spec", recovered[:3])
    return checked


@pytest.mark.parametrize("case", _INPUT["cases"], ids=lambda case: case["id"])
def test_migrated_masks_rasterise_byte_identically_to_v21(
    case: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    v21_clip = {**_INPUT["clipTemplate"], **case["clip"]}
    media = case.get("media", _INPUT["media"])
    checked = _assert_every_frame_matches_v21(
        case["id"], v21_clip, _MIGRATED[case["id"]], media, float(_INPUT["fps"]), monkeypatch
    )
    assert checked > 0


def test_the_timing_variants_cover_every_moving_case_at_every_offset() -> None:
    timings = _INPUT["timings"]
    pinned = {(variant["id"], variant["start"], variant["fps"]) for variant in _TIMINGS}
    expected = {
        (case_id, variant["start"], variant["fps"])
        for case_id in timings["cases"]
        for variant in timings["variants"]
    }
    assert pinned == expected
    assert all(variant["start"] > 0 for variant in timings["variants"])
    assert len({variant["fps"] for variant in timings["variants"]}) >= 4


@pytest.mark.parametrize(
    "variant",
    _TIMINGS,
    ids=lambda variant: f"{variant['id']}@{variant['start']}s@{variant['fps']}fps",
)
def test_mid_timeline_clips_rasterise_byte_identically_to_v21(
    variant: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    case = next(case for case in _INPUT["cases"] if case["id"] == variant["id"])
    media = case.get("media", _INPUT["media"])
    checked = _assert_every_frame_matches_v21(
        variant["id"], variant["v21"], variant["clip"], media, float(variant["fps"]), monkeypatch
    )
    assert checked >= 2 * math.floor(float(variant["fps"]))


def test_one_stored_centre_is_two_v21_fractions_and_the_stored_spec_decides() -> None:
    """The E2E.5 finding: no inverse of the centre can be exact; the stored spec is."""
    variant = next(
        case for case in _INPUT["cases"] if case["id"] == "keyframed-ellipse-mid-timeline"
    )
    v21_clip = {**_INPUT["clipTemplate"], **variant["clip"]}
    effect = Effect.model_validate(v21_clip["effects"][0])
    # Frame 144 at 30 fps is 0.7999999999999998 s into a clip that starts at 4 s.
    t = 144 / 30 - 4
    x = mask_spec_at(effect, t).x
    assert x == 0.19999999999999996
    width = 0.5
    centre = (x + width / 2) * 320
    assert centre == (0.2 + width / 2) * 320  # the same stored cx for both fractions
    assert math.trunc(x * 320) != math.trunc(0.2 * 320)  # yet v21's left edge differs
    migrated = Clip.model_validate(_MIGRATED["keyframed-ellipse-mid-timeline"])
    stacks = clip_mask_stacks(migrated, (320, 240))
    assert stacks is not None
    actual = stacks.alpha_at(t, 320, 240)
    assert actual is not None
    assert actual.tobytes() == _v21_alpha(effect, t, 320, 240).tobytes()


def test_a_mask_edited_after_migration_falls_back_to_recovery() -> None:
    """A stale ``legacySpec`` never draws: it must map onto the stored geometry to be used."""
    clip = json.loads(json.dumps(_MIGRATED["static-rectangle"]))
    clip["masks"][0]["cx"] += 10.0
    migrated = Clip.model_validate(clip)
    assert migrated.masks is not None
    mask = migrated.masks[0]
    assert mask.legacy_spec is not None
    spec = mask_stack._legacy_spec(mask, migrated, (320, 240), float(migrated.source_start))
    assert spec.x == pytest.approx(0.25 + 10.0 / 320)
