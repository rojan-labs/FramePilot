"""Element layers export fast, and every pixel is the one the old path drew (plan/elements 05 §7).

The budget: an export with 20 element layers costs at most 1.3x the same timeline without them.
The dispatch-only full Scale row measured 1.61x on CI: the elements added ~308 ms a 4K frame, all
of it serial Python work on the frame path. Three causes, each removed without changing a pixel:

* MoviePy blended every transparent layer over the WHOLE frame (a 4K canvas per sticker);
  ``render/bounded_composite.py`` blends it over only the pixels it covers.
* A still was LANCZOS-resized again every frame; ``render/still_resize.py`` reuses the resize
  while its picture and size repeat.
* A still's outline was redrawn every frame; ``compiler._apply_edge_styles`` reuses it while its
  picture, alpha and opacity repeat.

Both reuses keep their entries in one process-wide byte budget (``render/reuse_budget.py``) that
drops the least recently used, so a photo-heavy project cannot hold a second copy of every photo;
the pixels are the same whether an entry was kept or dropped, which is tested here too.

Each is compared here bit for bit with the definition it replaces, which is MoviePy's own
(``CompositeVideoClip``, ``vfx.Resize``) or the old per-frame redraw, switched back in by
monkeypatching, on the Scale row's own 20 sticker lanes and on the cases the row does not have.
"""

from __future__ import annotations

import gc
import statistics
import threading
import time
import tracemalloc
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render import bounded_composite, compiler, reuse_budget, still_resize
from framepilot_engine.render.bounded_composite import (
    BoundedCompositeVideoClip,
    compose_layer_on,
)
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.edge_styles import apply_edge_styles
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.render.reuse_budget import (
    MAX_ENTRY_SHARE,
    REUSE_BUDGET_BYTES,
    ReuseBudget,
    ReuseSlot,
)
from framepilot_engine.render.still_resize import ReusingResize
from framepilot_engine.timeline.models import Project
from tests.px5_scale_fixture import (
    ELEMENT_LAYERS,
    FPS,
    HEIGHT,
    WIDTH,
    scale_project,
    write_elements,
)

SECONDS = 2
#: Times the frames are drawn at, in this order: a rotation keyframe (0), a scale keyframe (1.0),
#: repeats and a step backwards, so any reuse that outlives its input would show.
IDENTITY_TIMES = (0.0, 1 / 30, 0.5, 1.0, 31 / 30, 1 / 30, 1.0, 59 / 30)


def _still(asset_id: str, path: str, width: int, height: int) -> dict[str, Any]:
    return {
        "id": asset_id,
        "path": path,
        "kind": "image",
        "media": {"width": width, "height": height},
    }


def _lane(
    name: str,
    asset_id: str,
    keyframes: list[dict[str, Any]],
    outlined: bool = False,
    lane_type: str = "overlay",
) -> Any:
    effects = (
        [
            {
                "id": f"{name}-outline",
                "type": "edge_style",
                "params": {"kind": "stroke", "widthPx": 8, "red": 255, "green": 255, "blue": 0},
            }
        ]
        if outlined
        else []
    )
    clip = {
        "id": f"clip-{name}",
        "assetId": asset_id,
        "trackId": name,
        "start": 0.0,
        "end": float(SECONDS),
        "sourceStart": 0.0,
        "sourceEnd": float(SECONDS),
        "effects": effects,
        "keyframes": keyframes,
    }
    return {"id": name, "type": lane_type, "clips": [clip]}


def _key(name: str, prop: str, t: float, value: float) -> dict[str, Any]:
    return {"id": f"{name}-{prop}-{t}", "property": prop, "time": t, "value": value}


def _place(name: str, scale: float, x: float, y: float) -> list[dict[str, Any]]:
    return [_key(name, "scale", 0.0, scale), _key(name, "x", 0.0, x), _key(name, "y", 0.0, y)]


def _turn(name: str) -> list[dict[str, Any]]:
    return [_key(name, "rotation", 0.0, 0.0), _key(name, "rotation", float(SECONDS), 270.0)]


def _edge_cases() -> list[dict[str, Any]]:
    """What the row lacks: layers off the frame's edges, a scale keyframe, a fade, an opaque one."""
    sticker = "element_fluent3d_fire"
    return [
        # An opaque still over the transparent layers: blended onto an RGBA frame.
        _lane("inset", "photo", _place("inset", 0.25, 1200.0, 700.0)),
        _lane("left-edge", sticker, _place("left-edge", 0.185, -1900.0, 0.0), outlined=True),
        _lane("corner", sticker, _place("corner", 0.185, 1800.0, 1000.0) + _turn("corner")),
        _lane("gone", sticker, _place("gone", 0.185, 2500.0, 0.0)),
        _lane(
            "keyframed",
            sticker,
            [
                _key("keyframed", "scale", 0.0, 0.1),
                _key("keyframed", "scale", 1.0, 0.2),
                _key("keyframed", "x", 0.0, 600.0),
                _key("keyframed", "y", 0.0, 300.0),
                *_turn("keyframed"),
            ],
            outlined=True,
        ),
        _lane(
            "fading",
            sticker,
            [
                *_place("fading", 0.185, -600.0, 300.0),
                _key("fading", "opacity", 0.0, 1.0),
                _key("fading", "opacity", float(SECONDS), 0.3),
            ],
            outlined=True,
        ),
    ]


def _write_media(base: Path) -> None:
    write_elements(base)
    rng = np.random.default_rng(20260926)
    Image.fromarray(rng.integers(0, 256, (HEIGHT, WIDTH, 3), dtype=np.uint8)).save(base / "bg.png")
    Image.fromarray(rng.integers(0, 256, (360, 640, 3), dtype=np.uint8)).save(base / "photo.png")


def _elements_project(edge_cases: bool) -> Project:
    """The Scale row's 20 sticker lanes and its title over a 4K still instead of the footage.

    With ``edge_cases``, also the layers of :func:`_edge_cases` and a sticker with no transform
    at all (fitted to the frame: its resize is the constant one).
    """
    row = scale_project(SECONDS, {}, "scale-elements")
    tracks = [track for track in row["timeline"]["tracks"] if not track["id"].startswith("v-")]
    title, lanes = tracks[0], tracks[1:]
    assert len(lanes) == ELEMENT_LAYERS
    assets = [asset for asset in row["assets"] if asset["kind"] == "image"]
    assets += [_still("bg", "bg.png", WIDTH, HEIGHT), _still("photo", "photo.png", 640, 360)]
    back = [_lane("background", "bg", [], lane_type="video")]
    if edge_cases:
        back.insert(0, _lane("fitted", "element_fluent3d_crown", []))
        lanes = _edge_cases() + lanes
    document = {**row, "assets": assets, "timeline": {"tracks": [title, *lanes, *back]}}
    return Project.model_validate(document)


def _compile(project: Project, base: Path) -> Any:
    index = index_assets([asset.model_dump(by_alias=True) for asset in project.assets], base)
    preset = ExportPreset(id="4k", label="4K", width=WIDTH, height=HEIGHT, fps=FPS)
    return compile_timeline(project, index, preset)


def _frames(project: Project, base: Path, times: tuple[float, ...]) -> list[np.ndarray]:
    composite = _compile(project, base)
    try:
        return [np.array(composite.get_frame(t)) for t in times]
    finally:
        close_clip_tree(composite)


def _old_definitions(monkeypatch: pytest.MonkeyPatch) -> None:
    """Switch the three definitions back: MoviePy's composite, MoviePy's resize, no reuse."""
    from moviepy import CompositeVideoClip
    from moviepy.video.fx.Resize import Resize

    monkeypatch.setattr(bounded_composite, "BoundedCompositeVideoClip", CompositeVideoClip)
    monkeypatch.setattr(still_resize, "ReusingResize", Resize)
    monkeypatch.setattr(compiler._StyledInputs, "matches", lambda *_: False)


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> Path:
    base = tmp_path_factory.mktemp("element-layers")
    _write_media(base)
    return base


@pytest.fixture(scope="module")
def old_frames(media: Path) -> list[np.ndarray]:
    """The elements row and its edge cases through the definitions the new ones replace."""
    with pytest.MonkeyPatch.context() as patch:
        _old_definitions(patch)
        return _frames(_elements_project(edge_cases=True), media, IDENTITY_TIMES)


#: The row holds 30.5 MiB of entries: 16 MiB keeps some of them and drops the least recently used
#: every frame (an outline's 2.2 MiB entry is still under its share), and 0 keeps none.
EVICTING_BUDGETS = {"default": REUSE_BUDGET_BYTES, "evicting": 16 * 2**20, "keeping-none": 0}


@pytest.mark.parametrize("budget_bytes", EVICTING_BUDGETS.values(), ids=EVICTING_BUDGETS.keys())
def test_the_elements_row_exports_the_same_pixels_as_the_old_path(
    media: Path, old_frames: list[np.ndarray], budget_bytes: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    budget = ReuseBudget(budget_bytes)
    monkeypatch.setattr(reuse_budget, "SHARED", budget)
    after = _frames(_elements_project(edge_cases=True), media, IDENTITY_TIMES)
    for t, old, new in zip(IDENTITY_TIMES, old_frames, after, strict=True):
        assert old.shape == new.shape == (HEIGHT, WIDTH, 3)
        assert np.array_equal(old, new), f"frame at {t:.4f} s differs from the old path"
    # Not vacuous: the stickers turn, scale and fade between these frames.
    assert not np.array_equal(after[0], after[1])
    assert not np.array_equal(after[3], after[4])
    assert budget.held_bytes <= budget.budget_bytes


@pytest.fixture
def playing_row(media: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    # The process's budget at its real size, empty, so what the row holds is measured alone.
    monkeypatch.setattr(reuse_budget, "SHARED", ReuseBudget(REUSE_BUDGET_BYTES))
    composite = _compile(_elements_project(edge_cases=False), media)
    try:
        composite.get_frame(0.0)
        yield composite
    finally:
        close_clip_tree(composite)


def test_after_its_first_frame_the_row_resizes_and_outlines_nothing_again(
    playing_row: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A deterministic guard for the reuse: every sticker in the row keeps its size, and its
    # picture, alpha and opacity, so no frame after the first resizes or outlines one again. The
    # old path did both, 40 resizes and 5 outlines, on every frame.
    from moviepy.video.fx.Resize import Resize

    calls = {"resize": 0, "outline": 0}
    resizer = Resize.resizer

    def counted_resizer(self: Any, pic: Any, new_size: Any) -> Any:
        calls["resize"] += 1
        return resizer(self, pic, new_size)

    def counted_outline(*args: Any) -> Any:
        calls["outline"] += 1
        return apply_edge_styles(*args)

    monkeypatch.setattr(Resize, "resizer", counted_resizer)
    monkeypatch.setattr(compiler, "apply_edge_styles", counted_outline)
    for index in range(1, 5):
        playing_row.get_frame(index * 0.37)
    assert calls == {"resize": 0, "outline": 0}
    # The budget keeps every entry the row needs (a picture and an alpha per sticker, and the
    # five outlines) with room to spare: 30.5 MiB measured, under a quarter of the budget.
    assert reuse_budget.SHARED.entry_count == 2 * ELEMENT_LAYERS + 5
    assert reuse_budget.SHARED.held_bytes < REUSE_BUDGET_BYTES // 4


def test_no_layer_is_blended_over_the_whole_frame(
    playing_row: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # MoviePy blended each transparent layer over a frame-sized canvas; the bounded composite
    # blends only the pixels a layer covers. The largest layer here is the title.
    assert isinstance(playing_row, BoundedCompositeVideoClip)
    sizes: list[tuple[int, int]] = []
    blend = Image.alpha_composite

    def recorded(under: Image.Image, over: Image.Image) -> Image.Image:
        sizes.append(under.size)
        return blend(under, over)

    monkeypatch.setattr(Image, "alpha_composite", recorded)
    playing_row.get_frame(0.5)
    assert len(sizes) == ELEMENT_LAYERS + 1  # the stickers and the title
    assert max(width * height for width, height in sizes) < WIDTH * HEIGHT // 20


#: plan/elements 05 §7 budgets the export with 20 element layers at 1.3x the export without them.
#: Measured 2026-09-26 on an M1 Pro, median CPU of 15 frames, coverage paused: the row's 20
#: stickers and title over a 4K still composite in 87-90 ms a frame, about 21 ms of which is the
#: frame without them (its background, and the RGBA frame the first transparent layer makes).
#: Through the old path the same frame took 262-269 ms. Gated at x2 until CI's headroom is known
#: (docs/guides/performance-budgets.md), which the old path still fails.
ELEMENT_FRAME_MEASURED_MS = 90.0
CI_CEILING_FACTOR = 2.0
ELEMENT_FRAME_RUNS = 15


# CPU time, not wall time: the composite is single-threaded Pillow and numpy work, while CI runs
# the suite on several workers. Coverage is paused, as the app composites without a tracer.
@pytest.mark.no_cover
def test_the_twenty_element_layers_composite_a_4k_frame_inside_the_ceiling(
    playing_row: Any,
) -> None:
    samples = []
    for index in range(1, ELEMENT_FRAME_RUNS + 1):
        start = time.process_time()
        playing_row.get_frame(index * 0.13)
        samples.append((time.process_time() - start) * 1000)
    median = statistics.median(samples)
    ceiling = ELEMENT_FRAME_MEASURED_MS * CI_CEILING_FACTOR
    assert median < ceiling, (
        f"20 element layers + title over a 4K frame: {median:.1f} ms median CPU over "
        f"{ELEMENT_FRAME_RUNS} frames; measured {ELEMENT_FRAME_MEASURED_MS:.0f} ms, "
        f"CI ceiling {ceiling:.0f} ms"
    )


# --- compose_layer_on against MoviePy's compose_on, on every path it takes -----------------------

FRAME_SIZE = (64, 48)


def _layer(
    rng: np.random.Generator,
    size: tuple[int, int],
    position: Any,
    *,
    alpha: bool,
    mask_size: tuple[int, int] | None = None,
    relative: bool = False,
) -> Any:
    from moviepy import ImageClip

    width, height = size
    picture = rng.integers(0, 256, (height, width, 3), dtype=np.uint8)
    clip = ImageClip(picture).with_duration(1.0).with_start(0.25)
    if alpha:
        mask_w, mask_h = mask_size or size
        coverage = rng.random((mask_h, mask_w))
        coverage[coverage < 0.3] = 0.0
        coverage[coverage > 0.8] = 1.0
        clip = clip.with_mask(ImageClip(coverage, is_mask=True).with_duration(1.0))
    return clip.with_position(position, relative=relative)


def _backgrounds(rng: np.random.Generator) -> list[Image.Image]:
    width, height = FRAME_SIZE
    opaque = Image.fromarray(rng.integers(0, 256, (height, width, 3), dtype=np.uint8))
    translucent = Image.fromarray(rng.integers(0, 256, (height, width, 4), dtype=np.uint8))
    return [opaque, translucent, Image.new("RGBA", FRAME_SIZE, (0, 0, 0, 0))]


LAYER_CASES: dict[str, tuple[tuple[int, int], Any, dict[str, Any]]] = {
    "inside": ((20, 10), (5, 6), {}),
    "off the top left": ((20, 10), (-7, -4), {}),
    "off the bottom right": ((20, 10), (55, 43), {}),
    "larger than the frame": ((90, 70), (-10, -8), {}),
    "wholly off the right": ((20, 10), (64, 3), {}),
    "just off the left": ((20, 10), (-20, 3), {}),
    "centred": ((21, 11), "center", {}),
    "named corner": ((20, 10), ("right", "bottom"), {}),
    "relative": ((20, 10), (0.5, 0.25), {"relative": True}),
    "mask larger": ((20, 10), (5, 6), {"mask_size": (30, 15)}),
    "mask smaller": ((20, 10), (5, 6), {"mask_size": (12, 6)}),
    "mask wider, shorter": ((20, 10), (5, 6), {"mask_size": (30, 6)}),
}


#: Every case transparent, and opaque where it has no mask to fit.
COMPOSE_CASES = [
    pytest.param(case, alpha, id=f"{case}-{'transparent' if alpha else 'opaque'}")
    for case in sorted(LAYER_CASES)
    for alpha in (True, False)
    if alpha or "mask_size" not in LAYER_CASES[case][2]
]


@pytest.mark.parametrize(("case", "alpha"), COMPOSE_CASES)
def test_a_layer_composes_to_the_pixels_moviepy_composes(case: str, alpha: bool) -> None:
    size, position, options = LAYER_CASES[case]
    rng = np.random.default_rng(len(case))
    layer = _layer(rng, size, position, alpha=alpha, **options)
    for background in _backgrounds(rng):
        for t in (0.25, 0.9):
            expected = layer.compose_on(background.copy(), t)
            actual = compose_layer_on(layer, background.copy(), t)
            assert (actual.mode, actual.size) == (expected.mode, expected.size)
            assert actual.tobytes() == expected.tobytes(), f"{case} over {background.mode}"


@pytest.mark.parametrize("bg_color", [(0, 0, 0), None], ids=["opaque", "transparent"])
def test_a_stack_of_layers_composites_to_the_pixels_moviepy_composites(
    bg_color: tuple[int, int, int] | None,
) -> None:
    from moviepy import CompositeVideoClip

    rng = np.random.default_rng(7)
    layers = [
        _layer(rng, size, position, alpha=index % 3 != 1, **options)
        for index, (size, position, options) in enumerate(LAYER_CASES.values())
    ]
    old = CompositeVideoClip(layers, size=FRAME_SIZE, bg_color=bg_color)
    new = BoundedCompositeVideoClip(layers, size=FRAME_SIZE, bg_color=bg_color)
    for t in (0.0, 0.3, 0.9, 1.2):
        assert np.array_equal(old.get_frame(t), new.get_frame(t))
        if bg_color is None:
            assert np.array_equal(old.mask.get_frame(t), new.mask.get_frame(t))


# --- ReusingResize against MoviePy's Resize ------------------------------------------------------


def _changing_clip() -> Any:
    """A clip whose picture changes at 0.5 s and whose mask changes at 0.75 s."""
    from moviepy import VideoClip

    rng = np.random.default_rng(3)
    pictures = [rng.integers(0, 256, (30, 40, 3), dtype=np.uint8) for _ in range(2)]
    masks = [rng.random((30, 40)) for _ in range(2)]
    clip = VideoClip(lambda t: pictures[int(t >= 0.5)]).with_duration(2.0)
    mask = VideoClip(lambda t: masks[int(t >= 0.75)], is_mask=True).with_duration(2.0)
    return clip.with_mask(mask)


@pytest.mark.parametrize(
    "new_size",
    [1.7, (55, 23), lambda t: 1.5 if t < 1.0 else 0.6],
    ids=["constant-scale", "constant-size", "keyframed"],
)
def test_a_reused_resize_is_the_resize_moviepy_does(new_size: Any) -> None:
    from moviepy.video.fx.Resize import Resize

    source = _changing_clip()
    old = source.with_effects([Resize(new_size)])
    new = source.with_effects([ReusingResize(new_size)])
    # 0.8 -> 1.2 keeps the picture and mask and changes the keyframed size.
    for t in (0.0, 0.1, 0.6, 0.8, 1.2, 0.1, 1.2, 1.2, 0.3):
        reused = new.get_frame(t)
        assert np.array_equal(old.get_frame(t), reused)
        assert np.array_equal(old.mask.get_frame(t), new.mask.get_frame(t))
        # What a caller does to a returned frame never reaches the next one.
        reused[...] = 0


# --- The reuse budget --------------------------------------------------------------------------


def _held_by(effect: type, pictures: list[np.ndarray], frames: int) -> int:
    """Bytes a set of keyframed stills holds after ``frames`` rounds, beyond their pictures."""
    from moviepy import ImageClip

    gc.collect()
    tracemalloc.start()
    try:
        clips = [
            ImageClip(picture).with_duration(1.0).with_effects([effect(lambda t: 0.5)])
            for picture in pictures
        ]
        for _ in range(frames):
            for clip in clips:
                clip.get_frame(0.2)
        gc.collect()
        return int(tracemalloc.get_traced_memory()[0])
    finally:
        tracemalloc.stop()


def test_reuse_entries_stay_inside_the_budget_however_many_stills_play(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Twelve keyframed stills, each keeping a 1.8 MB entry (its 600 x 800 picture and the 300 x
    # 400 resize), under an 8 MiB budget: the reuse may hold no more than the budget, measured in
    # the bytes actually allocated, not in the budget's own count.
    from moviepy.video.fx.Resize import Resize

    budget = ReuseBudget(8 * 2**20)
    monkeypatch.setattr(reuse_budget, "SHARED", budget)
    rng = np.random.default_rng(11)
    pictures = [rng.integers(0, 256, (600, 800, 3), dtype=np.uint8) for _ in range(12)]
    extra = _held_by(ReusingResize, pictures, 2) - _held_by(Resize, pictures, 2)
    # Four entries fit (7.2 MB): the budget is used, and never exceeded.
    assert 6 * 2**20 < extra <= budget.budget_bytes + 2**20


def test_the_budget_keeps_the_stills_played_last_and_resizes_the_rest_afresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from moviepy import ImageClip
    from moviepy.video.fx.Resize import Resize

    budget = ReuseBudget(8 * 2**20)
    monkeypatch.setattr(reuse_budget, "SHARED", budget)
    rng = np.random.default_rng(12)
    pictures = [rng.integers(0, 256, (600, 800, 3), dtype=np.uint8) for _ in range(12)]
    reusing = [
        ImageClip(p).with_duration(1.0).with_effects([ReusingResize(lambda t: 0.5)])
        for p in pictures
    ]
    plain = [
        ImageClip(p).with_duration(1.0).with_effects([Resize(lambda t: 0.5)]) for p in pictures
    ]
    resizes = {"count": 0}
    resizer = Resize.resizer

    def counted(self: Any, pic: Any, new_size: Any) -> Any:
        resizes["count"] += 1
        return resizer(self, pic, new_size)

    monkeypatch.setattr(Resize, "resizer", counted)
    for clip, reference in zip(reusing, plain, strict=True):
        assert np.array_equal(clip.get_frame(0.3), reference.get_frame(0.3))
        assert budget.held_bytes <= budget.budget_bytes
    # Four 1.8 MB entries fit in 8 MiB: the last four stills played reuse theirs, the first
    # (dropped long ago) resizes again, and both give the same pixels.
    resizes["count"] = 0
    for clip in reusing[-4:]:
        clip.get_frame(0.6)
    assert resizes["count"] == 0
    assert np.array_equal(reusing[0].get_frame(0.6), plain[0].get_frame(0.6))
    assert resizes["count"] == 2  # the dropped still, and its MoviePy reference


def test_the_budget_drops_the_least_recently_used_entry() -> None:
    budget = ReuseBudget(400)
    for key in (1, 2, 3, 4):
        budget.put(key, f"entry {key}", 100)
    assert budget.get(1) == "entry 1"  # 1 is now the most recent, 2 the least
    budget.put(5, "entry 5", 100)
    assert budget.get(2) is None
    assert [budget.get(key) for key in (1, 3, 4, 5)] == ["entry 1", "entry 3", "entry 4", "entry 5"]
    assert (budget.held_bytes, budget.entry_count) == (400, 4)
    # A key's new entry replaces its old one in the count.
    budget.put(3, "entry 3 again", 60)
    assert (budget.held_bytes, budget.entry_count) == (360, 4)


def test_an_entry_too_large_for_its_share_is_not_kept_and_its_old_one_goes() -> None:
    budget = ReuseBudget(400)
    share = 400 // MAX_ENTRY_SHARE
    budget.put(1, "small", share)
    budget.put(2, "neighbour", share)
    assert budget.keeps(share) and not budget.keeps(share + 1)
    budget.put(1, "too large", share + 1)
    assert budget.get(1) is None
    assert budget.get(2) == "neighbour"  # nothing else was pushed out to make room
    assert (budget.held_bytes, budget.entry_count) == (share, 1)


def test_a_slot_s_entry_goes_when_its_owner_is_collected() -> None:
    budget = ReuseBudget(1000)
    slot = ReuseSlot(budget)
    slot.put("entry", 100)
    assert (slot.get(), budget.held_bytes) == ("entry", 100)
    del slot
    gc.collect()
    assert (budget.held_bytes, budget.entry_count) == (0, 0)


def test_render_threads_share_one_budget_without_losing_count() -> None:
    budget = ReuseBudget(10_000)
    slots = [ReuseSlot(budget) for _ in range(8)]

    def churn(slot: ReuseSlot) -> None:
        for size in range(1, 400):
            slot.put(size, size * 3)
            slot.get()

    threads = [threading.Thread(target=churn, args=(slot,)) for slot in slots]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    kept = [slot.get() for slot in slots]
    assert budget.held_bytes == sum(3 * size for size in kept if size is not None)
    assert budget.held_bytes <= budget.budget_bytes
