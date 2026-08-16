"""Tests for the effect catalog mirror (schema v13, ADR 0088).

Guards the cross-language contract that makes manual and AI editing render the
same picture:

* the packaged ``effect_catalog.json`` is byte-identical to the TS artifact;
* every catalog entry names a render kind the engine declares params for;
* ``clamp_params`` mirrors the TS ``clampParamsForKind`` case for case;
* ``Timeline.active_effect_layers_at`` produces the SAME ordering as the TS
  ``activeEffectLayersAt`` — the two renderers walking different sequences is
  exactly how a stacked effect would drift between preview and render.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from framepilot_engine.render.effect_catalog import (
    clamp_params,
    default_params,
    get_effect,
    known_kinds,
    load_catalog,
    params_for_kind,
    resolve_params,
)
from framepilot_engine.timeline.models import EffectLayer, Timeline, Track, TrackType

_ENGINE_COPY = (
    Path(__file__).resolve().parents[1] / "framepilot_engine" / "render" / "effect_catalog.json"
)
_TS_ARTIFACT = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "timeline-schema"
    / "schema"
    / "effect-catalog.json"
)

_ALL_CATEGORIES = {
    "blur-focus",
    "glow",
    "light",
    "film",
    "retro",
    "analog",
    "glitch",
    "motion",
    "zoom",
    "chromatic",
    "dreamy",
    "warp",
    "pixel",
    "texture",
    "party",
    "comic",
    "outline",
    "lens-deform",
    "strobe",
    "mirror",
}


# ---------------------------------------------------------------------------
# Cross-language artifact parity
# ---------------------------------------------------------------------------


def test_engine_catalog_is_byte_identical_to_ts_artifact() -> None:
    assert _ENGINE_COPY.read_text(encoding="utf-8") == _TS_ARTIFACT.read_text(encoding="utf-8")


def test_catalog_ships_at_least_fifty_effects() -> None:
    assert len(load_catalog().effects) >= 50


def test_catalog_covers_all_twenty_families() -> None:
    assert set(load_catalog().categories) == _ALL_CATEGORIES


def test_every_effect_names_a_kind_the_engine_knows() -> None:
    # The one that matters: an entry on an unknown kind would browse fine in the
    # UI and then render as a no-op.
    kinds = known_kinds()
    for effect in load_catalog().effects.values():
        assert effect.kind in kinds, f"{effect.id} → unknown kind {effect.kind}"


def test_every_effect_override_is_a_declared_param_in_range() -> None:
    for effect in load_catalog().effects.values():
        declared = {p.name: p for p in params_for_kind(effect.kind)}
        for name, value in effect.params.items():
            assert name in declared, f"{effect.id} overrides unknown param {name}"
            descriptor = declared[name]
            assert descriptor.min <= value <= descriptor.max, f"{effect.id}.{name} out of range"


def test_every_kind_declares_at_least_one_param() -> None:
    for kind in known_kinds():
        assert params_for_kind(kind), f"{kind} declares no params"


def test_every_param_default_sits_inside_its_own_range() -> None:
    for kind in known_kinds():
        for p in params_for_kind(kind):
            assert p.min <= p.default <= p.max, f"{kind}.{p.name}"
            assert p.max > p.min
            assert p.step > 0


def test_choice_params_are_index_addressable() -> None:
    for kind in known_kinds():
        for p in params_for_kind(kind):
            if p.choices is None:
                continue
            assert p.min == 0
            assert p.step == 1
            assert len(p.choices) == int(p.max) + 1


def test_load_catalog_is_cached() -> None:
    assert load_catalog() is load_catalog()


# ---------------------------------------------------------------------------
# Param resolution — mirrors packages/timeline-schema/src/effect-catalog.test.ts
# ---------------------------------------------------------------------------


def test_default_params_is_complete_for_a_kind() -> None:
    assert set(default_params("analog-vhs")) == {p.name for p in params_for_kind("analog-vhs")}


def test_clamp_clamps_above_range() -> None:
    assert clamp_params("mosaic", {"size": 9999.0})["size"] == 128


def test_clamp_clamps_below_range() -> None:
    assert clamp_params("mosaic", {"size": -50.0})["size"] == 2


def test_clamp_drops_unknown_param_names() -> None:
    assert clamp_params("mosaic", {"size": 8.0, "bogus": 1.0}) == {"size": 8.0}


def test_clamp_falls_back_to_default_for_nan() -> None:
    assert clamp_params("mosaic", {"size": float("nan")}) == default_params("mosaic")


def test_clamp_falls_back_to_default_for_non_numeric() -> None:
    assert clamp_params("mosaic", {"size": "big"})["size"] == default_params("mosaic")["size"]  # type: ignore[dict-item]


def test_clamp_fills_missing_params_from_defaults() -> None:
    assert clamp_params("analog-vhs", {}) == default_params("analog-vhs")


def test_clamp_handles_none_params() -> None:
    assert clamp_params("mosaic", None) == default_params("mosaic")


def test_unknown_kind_yields_empty_params_rather_than_raising() -> None:
    # A project from a newer FramePilot must degrade, not abort a render.
    assert params_for_kind("not-a-real-kind") == ()
    assert default_params("not-a-real-kind") == {}
    assert clamp_params("not-a-real-kind", {"x": 1.0}) == {}


def test_get_effect_and_resolve_params_round_trip() -> None:
    entry = get_effect("halo-bloom")
    assert entry is not None
    resolved = resolve_params("halo-bloom")
    for p in params_for_kind(entry.kind):
        assert p.name in resolved


def test_get_effect_misses_are_none() -> None:
    assert get_effect("does-not-exist") is None
    assert resolve_params("does-not-exist") == {}


# ---------------------------------------------------------------------------
# Ordering contract — must match the TS activeEffectLayersAt exactly
# ---------------------------------------------------------------------------


def _layer(layer_id: str, start: float, end: float, **over: object) -> EffectLayer:
    return EffectLayer(
        id=layer_id, effectId="halo-bloom", kind="bloom", start=start, end=end, **over
    )


def _fx_track(track_id: str, layers: list[EffectLayer], **over: object) -> Track:
    return Track(id=track_id, type=TrackType.EFFECT, clips=[], effectLayers=layers, **over)


def test_effect_track_is_identified() -> None:
    assert _fx_track("fx", []).is_effect_lane is True
    assert Track(id="v", type=TrackType.VIDEO, clips=[]).is_effect_lane is False


def test_layer_covers_is_start_inclusive_end_exclusive() -> None:
    layer = _layer("a", 1.0, 3.0)
    assert layer.covers(1.0) is True
    assert layer.covers(2.0) is True
    assert layer.covers(3.0) is False
    assert layer.covers(0.5) is False


def test_abutting_layers_never_both_fire_on_the_boundary() -> None:
    track = _fx_track("fx", [_layer("a", 0.0, 2.0), _layer("b", 2.0, 4.0)])
    assert [layer.id for layer in track.active_effect_layers_at(2.0)] == ["b"]


def test_disabled_layers_are_skipped() -> None:
    track = _fx_track("fx", [_layer("a", 0.0, 5.0, disabled=True), _layer("b", 0.0, 5.0)])
    assert [layer.id for layer in track.active_effect_layers_at(1.0)] == ["b"]


def test_hidden_track_contributes_nothing() -> None:
    track = _fx_track("fx", [_layer("a", 0.0, 5.0)], hidden=True)
    assert track.active_effect_layers_at(1.0) == []


def test_zero_duration_layer_is_inactive() -> None:
    assert _layer("a", 2.0, 2.0).is_active is False


def test_layers_within_a_track_apply_in_start_order() -> None:
    track = _fx_track("fx", [_layer("late", 2.0, 6.0), _layer("early", 0.0, 6.0)])
    assert [layer.id for layer in track.active_effect_layers_at(3.0)] == ["early", "late"]


def test_lower_tracks_apply_first_bottom_up() -> None:
    # tracks[0] is the visual front, so it must run LAST — an effect above
    # receives the frame the one below already changed.
    timeline = Timeline(
        tracks=[
            _fx_track("front", [_layer("front-fx", 0.0, 5.0)]),
            _fx_track("back", [_layer("back-fx", 0.0, 5.0)]),
        ]
    )
    assert [layer.id for _, layer in timeline.active_effect_layers_at(1.0)] == [
        "back-fx",
        "front-fx",
    ]


def test_timeline_reports_the_owning_track() -> None:
    timeline = Timeline(tracks=[_fx_track("fx-1", [_layer("a", 0.0, 2.0)])])
    track, layer = timeline.active_effect_layers_at(1.0)[0]
    assert (track.id, layer.id) == ("fx-1", "a")


def test_clip_tracks_without_effect_layers_are_ignored() -> None:
    timeline = Timeline(tracks=[Track(id="v1", type=TrackType.VIDEO, clips=[])])
    assert timeline.active_effect_layers_at(1.0) == []


# ---------------------------------------------------------------------------
# Wire-format parity
# ---------------------------------------------------------------------------


def test_effect_layer_parses_camel_case_wire_format() -> None:
    # The TS side writes camelCase; a snake_case-only model would silently lose
    # `effectId` on every project load.
    layer = EffectLayer.model_validate(
        {"id": "fx1", "effectId": "halo-bloom", "kind": "bloom", "start": 0, "end": 2}
    )
    assert layer.effect_id == "halo-bloom"


def test_effect_layer_dumps_camel_case_by_alias() -> None:
    layer = _layer("fx1", 0.0, 1.0)
    assert "effectId" in layer.model_dump(by_alias=True)


def test_absent_intensity_resolves_to_full_strength() -> None:
    assert _layer("a", 0.0, 1.0).strength == 1.0
    assert _layer("a", 0.0, 1.0, intensity=0.25).strength == 0.25


def test_track_without_effect_layers_defaults_to_empty() -> None:
    # A v12 track has no `effectLayers` key at all.
    track = Track.model_validate({"id": "v1", "type": "video", "clips": []})
    assert track.effect_layers == []


def test_v12_track_round_trips_without_gaining_the_key() -> None:
    # Existing projects must stay byte-identical: `exclude_defaults` keeps the
    # new field out of a track that never had it.
    raw = {"id": "v1", "type": "video", "clips": []}
    track = Track.model_validate(raw)
    dumped = track.model_dump(by_alias=True, exclude_defaults=True)
    assert "effectLayers" not in dumped


@pytest.mark.parametrize("kind", sorted(known_kinds()))
def test_every_kind_clamps_a_hostile_param_bag(kind: str) -> None:
    # Every render pass trusts clamp_params absolutely, so it must never return a
    # missing key or an out-of-range value for ANY kind.
    hostile = {p.name: 1e9 for p in params_for_kind(kind)}
    clamped = clamp_params(kind, hostile)
    assert set(clamped) == {p.name for p in params_for_kind(kind)}
    for p in params_for_kind(kind):
        assert p.min <= clamped[p.name] <= p.max
