"""The compiler honours an EDITED caption at export time (schema v11, ADR 0071).

These are the tests that make caption editing real rather than cosmetic. Through
v10 the compiler re-derived each caption's words from the project transcript, so
an edit made in the editor could not survive an export — there was nowhere to
store it and nothing to read it from.

They assert against ``_caption_layers`` (the compiler's caption collection step)
rather than a full render, so they need no MoviePy encode and stay fast, while
still exercising the real code path the export uses.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from unittest.mock import patch

import pytest

from framepilot_engine.render.compiler import _caption_layers
from framepilot_engine.timeline.models import CaptionStyle, Clip, Project, TranscriptWord

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


def _project(
    *,
    cue: dict[str, Any] | None = None,
    clip_style: dict[str, Any] | None = None,
    track_style: dict[str, Any] | None = None,
) -> Project:
    """A one-caption project, optionally carrying a cue and/or styles."""
    return Project.model_validate(
        {
            "id": "p1",
            "name": "cue test",
            "version": 1,
            "fps": 30,
            "resolution": {"width": 480, "height": 480},
            "assets": [],
            "folders": [],
            "timeline": {
                "tracks": [
                    {
                        "id": "caption_1",
                        "type": "caption",
                        **({"captionStyle": track_style} if track_style else {}),
                        "clips": [
                            {
                                "id": "cap_a",
                                "assetId": "__caption__",
                                "trackId": "caption_1",
                                "start": 0.0,
                                "end": 2.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 2.0,
                                "effects": [],
                                "keyframes": [],
                                **({"captionCue": cue} if cue else {}),
                                **({"captionStyle": clip_style} if clip_style else {}),
                            }
                        ],
                    }
                ]
            },
            "transcript": [
                {"word": "transcript", "start": 0.0, "end": 1.0},
                {"word": "words", "start": 1.0, "end": 2.0},
            ],
            "markers": [],
            "aiMemory": {},
            "history": [],
        }
    )


def _captured_calls(project: Project) -> list[dict[str, Any]]:
    """Collect the (text, style, words) each caption layer would be rendered with.

    Patches ``_caption_clip`` so nothing touches MoviePy: the assertion is about
    what the compiler decided to draw, not about pixels (those have their own
    goldens).
    """
    calls: list[dict[str, Any]] = []

    def spy(
        clip: Clip,
        text: str,
        style: CaptionStyle | None,
        cue_words: Sequence[TranscriptWord],
        target_w: int,
        target_h: int,
        margin: int,
    ) -> object:
        calls.append({"clip": clip, "text": text, "style": style, "words": list(cue_words)})
        return object()

    with patch("framepilot_engine.render.compiler._caption_clip", side_effect=spy):
        _caption_layers(project, (480, 480))
    return calls


def test_export_uses_the_clip_own_cue_text_not_the_transcript() -> None:
    """The headline guarantee: an edited caption exports as edited."""
    project = _project(cue={"text": "my own words", "words": []})
    calls = _captured_calls(project)
    assert [c["text"] for c in calls] == ["my own words"]


def test_export_falls_back_to_the_transcript_without_a_cue() -> None:
    """The pre-v11 path, unchanged — this is what keeps the goldens valid."""
    calls = _captured_calls(_project())
    assert [c["text"] for c in calls] == ["transcript words"]


def test_export_uses_the_cue_own_word_timings() -> None:
    """Emphasis times against the cue's words, not a fresh transcript lookup.

    An edited caption must keep the karaoke beats its words had; re-deriving from
    the transcript would silently re-time it.
    """
    project = _project(
        cue={
            "text": "my own words",
            "words": [
                {"word": "my", "start": 0.0, "end": 0.3},
                {"word": "own", "start": 0.3, "end": 0.7},
                {"word": "words", "start": 0.7, "end": 1.2},
            ],
        },
        clip_style={"templateId": "karaoke"},
    )
    calls = _captured_calls(project)
    assert [w.word for w in calls[0]["words"]] == ["my", "own", "words"]
    assert calls[0]["words"][1].start == pytest.approx(0.3)


def test_export_skips_a_deliberately_blanked_cue() -> None:
    """A cleared caption stays cleared — it must not fall back to the transcript."""
    project = _project(cue={"text": "", "words": []})
    assert _captured_calls(project) == []


def test_export_applies_the_track_style_to_a_cue_with_no_override() -> None:
    """A track-wide restyle must reach every cue, which is the whole point of it.

    In v10 style lived only on the clip, so a template chosen for the project
    reached nothing unless it had been stamped onto each cue individually.
    """
    project = _project(track_style={"templateId": "hormozi"})
    calls = _captured_calls(project)
    assert calls[0]["style"].template_id == "hormozi"


def test_export_lets_a_per_cue_override_win_over_the_track_style() -> None:
    project = _project(
        track_style={"templateId": "hormozi", "textColor": "#ffffff"},
        clip_style={"textColor": "#ffd84d"},
    )
    style = _captured_calls(project)[0]["style"]
    # Clip wins on the field it sets; the track fills the rest.
    assert style.text_color == "#ffd84d"
    assert style.template_id == "hormozi"


def test_export_draws_no_style_when_neither_track_nor_clip_has_one() -> None:
    """The unstyled baseline path (byte-identical to pre-v5) is still reachable."""
    assert _captured_calls(_project())[0]["style"] is None


def test_export_skips_a_hidden_caption_track() -> None:
    project = _project(cue={"text": "hidden", "words": []})
    project.timeline.tracks[0].hidden = True
    assert _captured_calls(project) == []
