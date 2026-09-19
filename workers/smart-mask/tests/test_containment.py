"""BR3.17: a partial re-run changes what its correction reaches, and nothing else."""

from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("cv2")

from framepilot_smart_mask.containment import contain  # noqa: E402
from framepilot_smart_mask.prompts import FramePrompts  # noqa: E402

COUNT, HEIGHT, WIDTH = 5, 72, 128


def still(_source: int, _target: int) -> np.ndarray:
    return np.zeros((HEIGHT, WIDTH, 2), np.float32)


def subject() -> np.ndarray:
    alpha = np.zeros((HEIGHT, WIDTH), np.uint8)
    alpha[20:50, 30:60] = 255
    return alpha


def with_leak(alpha: np.ndarray) -> np.ndarray:
    leaked = alpha.copy()
    leaked[20:40, 80:100] = 255
    return leaked


def brush(keep: np.ndarray | None = None, remove: np.ndarray | None = None) -> FramePrompts:
    empty = np.zeros((HEIGHT, WIDTH), bool)
    return FramePrompts(
        index=2,
        pts=2,
        keep=empty if keep is None else keep,
        remove=empty if remove is None else remove,
        edge=empty.copy(),
    )


def test_neighbours_keep_their_previous_alpha_when_the_rerun_only_wobbles_their_edges() -> None:
    previous = [with_leak(subject()) if i == 2 else subject() for i in range(COUNT)]
    new = [subject() for _ in range(COUNT)]
    for i in (0, 1, 3, 4):
        new[i][20:50, 58:60] = 0  # a re-decided edge, unrelated to the fix
    remove = np.zeros((HEIGHT, WIDTH), bool)
    remove[20:40, 80:100] = True
    out, taken = contain(previous, new, {2: brush(remove=remove)}, still)  # type: ignore[arg-type]
    assert np.array_equal(out[2], subject()), "the brushed leak is gone"
    for i in (0, 1, 3, 4):
        assert np.array_equal(out[i], previous[i]), f"frame {i} is bit-identical"
    assert taken == [False, False, True, False, False]


def test_a_brushed_frame_keeps_its_unbrushed_pixels() -> None:
    previous = [subject() for _ in range(COUNT)]
    new = [subject() for _ in range(COUNT)]
    keep = np.zeros((HEIGHT, WIDTH), bool)
    keep[50:55, 30:60] = True  # the editor painted a missing strip back in
    new[2][50:55, 30:60] = 255
    new[2][25:30, 30:40] = 0  # the re-run also re-decided an unpainted patch: not taken
    out, _ = contain(previous, new, {2: brush(keep=keep)}, still)  # type: ignore[arg-type]
    assert (out[2][50:55, 30:60] == 255).all()
    assert (out[2][25:30, 30:40] == 255).all()


def test_a_fix_the_rerun_repeats_on_neighbours_carries_over() -> None:
    previous = [with_leak(subject()) for _ in range(COUNT)]
    new = [subject() for _ in range(COUNT)]
    new[4][20:50, 30:34] = 0  # frame 4 repeats the fix but also wobbles an edge elsewhere
    remove = np.zeros((HEIGHT, WIDTH), bool)
    remove[20:40, 80:100] = True
    out, taken = contain(previous, new, {2: brush(remove=remove)}, still)  # type: ignore[arg-type]
    assert all(not out[i][20:40, 80:100].any() for i in range(COUNT)), "the leak is gone everywhere"
    assert (out[4][20:50, 30:34] == 255).all(), "outside the fix's reach nothing is re-decided"
    assert all(taken)


def test_a_click_prompted_frame_takes_the_rerun_and_frames_without_a_previous_keep_it() -> None:
    previous = [subject() for _ in range(COUNT)]
    previous[4] = None  # type: ignore[call-overload]
    new = [with_leak(subject()) for _ in range(COUNT)]
    click = FramePrompts(index=0, pts=0, coords=[(0.7, 0.4)], labels=[1])
    out, _ = contain(previous, new, {0: click}, still)  # type: ignore[arg-type]
    assert np.array_equal(out[0], new[0])
    assert np.array_equal(out[4], new[4])
