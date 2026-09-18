"""AM2.5: a shot may name a region, and then only that crop is embedded.

The host scores a text query ("the red car") against each detection's crop to re-rank
candidates the detector has already classed. Additive under protocol v1: a host that predates
``region`` never sends it, and a shot without one embeds the whole keyframe exactly as before.
"""

from __future__ import annotations

import json

import pytest
from conftest import FakeBackend, prompt_vectors, unit

from framepilot_visual_embed.policy import embed_shots
from framepilot_visual_embed.protocol import (
    EmbedRequest,
    MediaHandle,
    NormalizedBox,
    ProtocolError,
    ShotPrompt,
    parse_input_line,
)

MEDIA = {
    "handleId": "media:clip-1",
    "assetId": "asset-1",
    "absolutePath": "/sandbox/project/media/shot.mp4",
    "sourceStartSeconds": 0.0,
    "sourceEndSeconds": 60.0,
    "fps": 30.0,
    "firstFrame": 0,
    "lastFrameExclusive": 1800,
}
HANDLE = MediaHandle(
    handle_id="media:1",
    asset_id="asset-1",
    absolute_path="/sandbox/a.mp4",
    source_start_seconds=0.0,
    source_end_seconds=60.0,
    fps=30.0,
    first_frame=0,
    last_frame_exclusive=1800,
)
LEFT = NormalizedBox(x=0.05, y=0.4, width=0.4, height=0.35)
RIGHT = NormalizedBox(x=0.55, y=0.4, width=0.4, height=0.35)


def embed_line(shots: list[dict[str, object]]) -> str:
    return json.dumps(
        {
            "type": "request",
            "protocolVersion": 1,
            "requestId": "embed:asset-1:0",
            "projectRevision": 3,
            "capability": "visual.embed",
            "media": MEDIA,
            "parameters": {"promptBankVersion": 1, "shots": shots},
        }
    )


def test_a_shot_without_a_region_parses_as_before() -> None:
    request = parse_input_line(embed_line([{"shotIndex": 0, "keyframeT": 2.0}]))

    assert isinstance(request, EmbedRequest)
    assert request.shots[0].region is None


def test_a_region_parses_onto_its_shot() -> None:
    box = {"x": 0.05, "y": 0.4, "width": 0.4, "height": 0.35}
    request = parse_input_line(
        embed_line(
            [
                {"shotIndex": 0, "keyframeT": 2.0, "region": box},
                {"shotIndex": 1, "keyframeT": 2.0},
            ]
        )
    )

    assert isinstance(request, EmbedRequest)
    assert request.shots[0].region == LEFT
    assert request.shots[1].region is None


@pytest.mark.parametrize(
    ("region", "message"),
    [
        ({"x": 0.8, "y": 0.1, "width": 0.4, "height": 0.2}, "inside the frame"),
        ({"x": 0.1, "y": 0.1, "width": 0.0, "height": 0.2}, "positive normalized size"),
        ({"x": -0.1, "y": 0.1, "width": 0.2, "height": 0.2}, "normalized to"),
        ({"x": 0.1, "y": 0.1, "width": 0.2}, "requires height"),
        ({"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2, "z": 1}, "unexpected keys"),
        ("left half", "must be an object"),
    ],
)
def test_a_region_the_host_would_refuse_is_refused(region: object, message: str) -> None:
    with pytest.raises(ProtocolError, match=message) as raised:
        parse_input_line(embed_line([{"shotIndex": 0, "keyframeT": 2.0, "region": region}]))

    assert raised.value.code == "invalid_request"


def test_two_crops_of_one_keyframe_embed_separately() -> None:
    red = unit(1.0, 0.0)
    grey = unit(0.0, 1.0)
    backend = FakeBackend(
        region_vectors={
            (LEFT.x, LEFT.y, LEFT.width, LEFT.height): red,
            (RIGHT.x, RIGHT.y, RIGHT.width, RIGHT.height): grey,
        }
    )
    request = EmbedRequest(
        request_id="embed:1",
        project_revision=0,
        media=HANDLE,
        prompt_bank_version=1,
        shots=(
            ShotPrompt(shot_index=0, keyframe_t=2.0, region=LEFT),
            ShotPrompt(shot_index=1, keyframe_t=2.0, region=RIGHT),
        ),
    )

    shots = list(embed_shots(request, backend, prompt_vectors()))

    assert [shot.vector for shot in shots] == [red, grey]
    assert backend.crops == [(2.0, LEFT), (2.0, RIGHT)]


def test_a_whole_frame_shot_is_never_cropped() -> None:
    backend = FakeBackend()
    request = EmbedRequest(
        request_id="embed:1",
        project_revision=0,
        media=HANDLE,
        prompt_bank_version=1,
        shots=(ShotPrompt(shot_index=0, keyframe_t=2.0),),
    )

    list(embed_shots(request, backend, prompt_vectors()))

    assert backend.crops == []
    assert "region" not in backend.encoded[0]
