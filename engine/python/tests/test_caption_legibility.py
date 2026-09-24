"""Caption legibility against the picture (``render/caption_legibility.py``).

The captured 2026-09-23 short captioned its speaker in off-white with no outline over a cream
t-shirt; the words were right and barely readable. These pin the measure on the three caption
designs it has to judge without being told which one it is looking at.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.render import caption_legibility as cl
from framepilot_engine.timeline.models import Project

CREAM = (214, 205, 188)
OFF_WHITE = (244, 240, 235)


KEY = (255, 0, 255)


def _frame(color: tuple[int, int, int]) -> np.ndarray:
    frame = np.zeros((200, 200, 3), dtype=np.uint8)
    frame[...] = color
    return frame


def _letters(
    frame: np.ndarray, color: tuple[int, int, int], outline: tuple[int, int, int] | None = None
) -> np.ndarray:
    drawn = frame.copy()
    for x0 in range(40, 160, 30):  # four 10 px "strokes"
        if outline is not None:
            drawn[88:132, x0 - 3 : x0 + 13] = outline
        drawn[92:128, x0 : x0 + 10] = color
    return drawn


def _keyed() -> np.ndarray:
    """The captions alone with their text in the key colour: the letters' exact pixels."""
    return _letters(_frame((0, 0, 0)), KEY)


def test_off_white_letters_on_a_cream_shirt_do_not_read() -> None:
    delivered = _letters(_frame(CREAM), OFF_WHITE)
    measured = cl.measure_caption_pixels(delivered, _keyed())
    assert measured is not None
    assert measured[0] < cl.LEGIBLE_CONTRAST


def test_the_same_letters_with_an_outline_read() -> None:
    delivered = _letters(_frame(CREAM), OFF_WHITE, outline=(0, 0, 0))
    measured = cl.measure_caption_pixels(delivered, _keyed())
    assert measured is not None
    assert measured[0] >= cl.LEGIBLE_CONTRAST


def test_a_background_box_reads_whatever_is_behind_it() -> None:
    boxed = _frame(CREAM)
    boxed[80:140, 30:170] = (20, 20, 20)
    measured = cl.measure_caption_pixels(_letters(boxed, OFF_WHITE), _keyed())
    assert measured is not None
    assert measured[0] >= cl.LEGIBLE_CONTRAST


def test_dark_letters_are_found_by_the_key_not_by_their_colour() -> None:
    # Black text on a light box: the key colour finds the letters whatever colour they are.
    boxed = _frame(CREAM)
    boxed[80:140, 30:170] = (250, 250, 250)
    measured = cl.measure_caption_pixels(_letters(boxed, (10, 10, 10)), _keyed())
    assert measured is not None
    assert measured[0] >= cl.LEGIBLE_CONTRAST
    assert measured[1] < 0.05  # the fill is the dark text


def test_nothing_drawn_is_no_measurement() -> None:
    assert cl.measure_caption_pixels(_frame(CREAM), _frame((0, 0, 0))) is None


def _project() -> Project:
    cue = {
        "id": "cue_1",
        "assetId": "__caption__",
        "trackId": "captions",
        "start": 1.0,
        "end": 3.0,
        "sourceStart": 0,
        "sourceEnd": 2.0,
        "effects": [],
        "captionCue": {"text": "Today we are talking", "words": []},
    }
    return Project.model_validate(
        {
            "schemaVersion": 23,
            "id": "p",
            "name": "p",
            "fps": 30,
            "resolution": {"width": 1080, "height": 1920},
            "assets": [],
            "timeline": {
                "tracks": [
                    {
                        "id": "captions",
                        "type": "caption",
                        "clips": [cue],
                        "captionStyle": {"textColor": "#F4F0EB", "outlineWidth": 0},
                    }
                ]
            },
            "transcript": [],
        }
    )


def test_samples_each_cue_mid_way_and_reports_what_it_says(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    grabbed: list[float] = []
    keyed_at: list[list[float]] = []

    def fake_grab(project: Any, base: Path, at: float, **kwargs: Any) -> Any:
        assert kwargs["burn_captions"] is True
        grabbed.append(at)
        buffer = io.BytesIO()
        Image.fromarray(_letters(_frame(CREAM), OFF_WHITE)).save(buffer, "PNG")
        return type("Grab", (), {"data": buffer.getvalue()})()

    def fake_overlay(project: Any, target: tuple[int, int], times: list[float]) -> list[Any]:
        assert target == (200, 200)  # the delivered frame's own size
        assert project.timeline.tracks[0].caption_style.text_color == cl.KEY_COLOR
        keyed_at.append(list(times))
        return [_keyed() for _ in times]

    monkeypatch.setattr(cl, "grab_frame", fake_grab)
    monkeypatch.setattr(cl, "caption_overlay_frames", fake_overlay)
    [result] = cl.check_caption_legibility(_project(), Path("/nowhere"))
    # The delivered frame at the cue's midpoint, and the keyed captions at the same instant.
    assert grabbed == [2.0]
    assert keyed_at == [[2.0]]
    assert result.clip_id == "cue_1"
    assert result.text == "Today we are talking"
    assert result.contrast is not None and not result.legible


def test_refuses_a_project_with_no_captions() -> None:
    project = _project()
    empty = Project.model_validate(
        {**json.loads(project.model_dump_json(by_alias=True)), "timeline": {"tracks": []}}
    )
    with pytest.raises(cl.CaptionLegibilityError, match="caption_the_edit"):
        cl.check_caption_legibility(empty, Path("/nowhere"))


def test_the_route_serves_each_cue_and_the_threshold(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi.testclient import TestClient

    from framepilot_engine import service
    from framepilot_engine.config import Settings

    def fake_check(project: Any, base: Path, **kwargs: Any) -> list[cl.CueLegibility]:
        return [cl.CueLegibility(2.0, "cue_1", "Today", 1.31, 0.7, 0.52, (0.2, 0.7, 0.8, 0.8))]

    monkeypatch.setattr(service, "check_caption_legibility", fake_check)
    client = TestClient(service.create_app(Settings(projects_root=tmp_path)))
    project = json.loads(_project().model_dump_json(by_alias=True))
    body = client.post("/review/caption-legibility", json={"project": project}).json()
    assert body["threshold"] == cl.LEGIBLE_CONTRAST
    assert body["cues"][0]["clipId"] == "cue_1"
    assert body["cues"][0]["legible"] is False
    assert body["cues"][0]["surroundLuminance"] == 0.52


def test_the_route_says_when_there_is_nothing_to_check(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from framepilot_engine import service
    from framepilot_engine.config import Settings

    client = TestClient(service.create_app(Settings(projects_root=tmp_path)))
    project = json.loads(_project().model_dump_json(by_alias=True))
    project["timeline"] = {"tracks": []}
    response = client.post("/review/caption-legibility", json={"project": project})
    assert response.status_code == 422
    assert "caption_the_edit" in response.json()["detail"]


def test_the_keyed_overlay_draws_the_cue_in_the_key_colour_and_nothing_else() -> None:
    # Real caption rasterization, no picture: what the measure uses to find the letters.
    from framepilot_engine.render.compiler import caption_overlay_frames

    keyed = cl.keyed_captions_project(_project())
    during, before = caption_overlay_frames(keyed, (270, 480), [2.0, 0.5])
    key = np.array(KEY)
    near_key = np.sqrt(((during.astype(float) - key) ** 2).sum(axis=2)) < cl.FILL_DISTANCE
    assert near_key.sum() > cl.MIN_FILL_PIXELS
    assert not (np.sqrt(((before.astype(float) - key) ** 2).sum(axis=2)) < cl.FILL_DISTANCE).any()
