"""``POST /analyze/subject-layout`` — the HTTP half of ``masking/subject_layout.py``."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from framepilot_engine import service
from framepilot_engine.config import Settings
from framepilot_engine.masking.subject_layout import (
    BandCoverage,
    SubjectLayout,
    SubjectLayoutError,
    SubjectSample,
    TextBehindPlacement,
)
from framepilot_engine.service import create_app


def _project() -> dict[str, Any]:
    return {
        "schemaVersion": 23,
        "id": "p",
        "name": "p",
        "fps": 30,
        "resolution": {"width": 1080, "height": 1920},
        "assets": [],
        "timeline": {"tracks": []},
        "transcript": [],
    }


def _layout(text_behind: TextBehindPlacement | None) -> SubjectLayout:
    return SubjectLayout(
        clip_id="talk",
        mask_id="m1",
        start=0.0,
        end=5.2,
        samples=(SubjectSample(time=2.6, box=(0.1, 0.05, 0.9, 1.0), area=0.6),),
        box=(0.1, 0.05, 0.9, 1.0),
        reach=(0.0, 0.02, 1.0, 1.0),
        head_top=0.02,
        shoulders=0.42,
        bands=tuple(
            BandCoverage(top=i / 10, bottom=(i + 1) / 10, width_covered=0.5, span=(0.25, 0.75))
            for i in range(10)
        ),
        text_behind=text_behind,
    )


def test_serves_the_geometry_and_a_title_placement_from_its_rendered_box(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, Any] = {}

    def fake_measure(project: Any, base: Path, clip_id: str, **kwargs: Any) -> SubjectLayout:
        seen.update(kwargs, clip_id=clip_id)
        return _layout(
            TextBehindPlacement(y_percent=24.0, occluded=0.3, ends_visible=True, note="reads")
        )

    monkeypatch.setattr(service, "measure_subject_layout", fake_measure)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    response = client.post(
        "/analyze/subject-layout",
        json={
            "project": _project(),
            "clipId": "talk",
            "start": 0,
            "end": 5.2,
            "text": "MOTION",
            "textStyle": {"fontSizePercent": 11},
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["headTop"] == 0.02
    assert body["shoulders"] == 0.42
    assert len(body["bands"]) == 10
    assert body["textBehind"]["yPercent"] == 24.0
    assert body["textBehind"]["endsVisible"] is True
    # The title was measured as the export rasterizes it, not guessed.
    width, height = seen["text_box"]
    assert 0.5 < width < 1.0
    assert 0.1 < height < 0.2
    assert seen["clip_id"] == "talk"


def test_a_clip_with_no_cut_out_is_a_422_with_the_remedy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*args: Any, **kwargs: Any) -> SubjectLayout:
        raise SubjectLayoutError("Clip 'talk' has no cut-out to measure. Remove its background.")

    monkeypatch.setattr(service, "measure_subject_layout", refuse)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    response = client.post(
        "/analyze/subject-layout", json={"project": _project(), "clipId": "talk"}
    )
    assert response.status_code == 422
    assert "Remove its background" in response.json()["detail"]
