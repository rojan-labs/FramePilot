"""The audio boundary check judges the spliced source over what else plays, above a floor.

Run x59-1 reported "Audio discontinuity 21.7 dB exceeds 12 dB" at a music bed's first frame,
three times, while the model re-faded the music. The bed faded in correctly (-86.6 dBFS at its
first frame); the jump was a radio call starting inside the continuous clip on ANOTHER track,
read off the mix. And the music's own fade measured as a step up from digital silence.

The mirror image followed: measured on its track ALONE, a lifted clip's stop under a cover
shot's continuing sound read 36 dB, a step no one hears. So the source is judged over the
background the other tracks play, held at its quieter side.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError

from framepilot_engine.media.assets import AssetIndex
from framepilot_engine.timeline.models import Project
from framepilot_engine.validation import temporal_evidence as evidence_module
from framepilot_engine.validation.perceptual_thresholds import AUDIBLE_RMS_FLOOR_DBFS
from framepilot_engine.validation.temporal_evidence import (
    AudioEvidenceRequest,
    TemporalEvidenceError,
    _audio_sample,
    _boundary_jump_db,
    acquire_temporal_evidence,
)

FPS = 30
SAMPLE_RATE = 48_000
#: The planner's window: two frames before the cut, three after.
START, BOUNDARY, END = 0, 2, 5
BOUNDARY_SECONDS = BOUNDARY / FPS
MAX_JUMP_DB = 12.0

Signal = Callable[[np.ndarray[Any, np.dtype[np.float64]]], np.ndarray[Any, np.dtype[np.float64]]]


def _request(**extra: Any) -> AudioEvidenceRequest:
    return AudioEvidenceRequest.model_validate(
        {
            "schemaVersion": 1,
            "requestId": extra.pop("requestId", "edit_audio_2"),
            "projectRevision": 4,
            "reason": "Changed audio edit boundary",
            "kind": "audio",
            "startFrame": START,
            "endFrame": END,
            "boundaryFrame": BOUNDARY,
            "channels": "mix",
            **extra,
        }
    )


MUSIC_SPLICE = {"trackIds": ["music"], "fromClipIds": [], "toClipIds": ["bed"]}


def _window(signal: Signal) -> np.ndarray[Any, np.dtype[np.float64]]:
    """The request window's samples at the engine's rate, as `_audio_frames` reads them."""
    count = round((END - START) / FPS * SAMPLE_RATE)
    times = np.linspace(START / FPS, END / FPS, count, endpoint=False, dtype=np.float64)
    return signal(times)[:, np.newaxis]


def _after(level: float) -> Signal:
    """Silence, then a sound at a steady ``level`` from the boundary: a hard entry."""
    return lambda t: np.where(t >= BOUNDARY_SECONDS, level, 0.0)


def _fade_in(level: float, seconds: float) -> Signal:
    """Silence, then ``level`` faded in linearly over ``seconds`` from the boundary."""
    return lambda t: level * np.clip((t - BOUNDARY_SECONDS) / seconds, 0.0, 1.0)


def _until(level: float) -> Signal:
    """A steady ``level`` that stops dead at the boundary: a hard exit."""
    return lambda t: np.where(t < BOUNDARY_SECONDS, level, 0.0)


def _fade_out(level: float, seconds: float) -> Signal:
    """``level`` faded out linearly, reaching silence exactly at the boundary."""
    return lambda t: level * np.clip((BOUNDARY_SECONDS - t) / seconds, 0.0, 1.0)


def _cut(before: float, after: float) -> Signal:
    return lambda t: np.where(t < BOUNDARY_SECONDS, before, after)


class TestTheFloor:
    """Each side is raised to the audibility floor before the jump is taken."""

    def test_silence_into_a_quiet_sound_is_not_a_jump(self) -> None:
        # -50 dBFS from nothing used to read as 70 dB (from -120). Neither side is loud enough
        # for a step between them to be heard.
        assert _boundary_jump_db(_window(_after(10 ** (-50 / 20))), _request()) == pytest.approx(
            10.0, abs=0.05
        )

    def test_nothing_audible_either_side_is_no_jump(self) -> None:
        quiet = _cut(10 ** (-75 / 20), 10 ** (-65 / 20))
        assert _boundary_jump_db(_window(quiet), _request()) == 0.0

    def test_a_cut_between_two_sounds_compares_the_two_sides(self) -> None:
        # Both audible: the sides' means (-12 and -24 dBFS), the comparison it always made.
        assert _boundary_jump_db(_window(_cut(0.25, 0.0625)), _request()) == pytest.approx(
            12.04, abs=0.01
        )

    def test_the_floor_is_the_one_in_the_shared_table(self) -> None:
        levels = evidence_module._boundary_levels(_window(lambda t: t * 0.0), _request())
        assert levels == (AUDIBLE_RMS_FLOOR_DBFS, AUDIBLE_RMS_FLOOR_DBFS)


class TestAnEntryFromSilenceIsJudgedByItsOnset:
    def test_a_fade_in_passes(self) -> None:
        # A one-second fade of a -12 dBFS bed: three frames in it is already at -22 dBFS, a
        # 38 dB "jump" by the side means, but its first 10 ms are at -57.
        jump = _boundary_jump_db(_window(_fade_in(0.25, 1.0)), _request())
        assert jump is not None and jump < MAX_JUMP_DB

    def test_a_hard_entry_flags(self) -> None:
        jump = _boundary_jump_db(_window(_after(0.25)), _request())
        assert jump == pytest.approx(48.0, abs=0.05)

    def test_a_hard_stop_flags_and_a_fade_out_passes(self) -> None:
        stop = _boundary_jump_db(_window(_until(0.25)), _request())
        faded = _boundary_jump_db(_window(_fade_out(0.25, 1.0)), _request())
        assert stop is not None and stop > MAX_JUMP_DB
        assert faded is not None and faded < MAX_JUMP_DB

    def test_the_levels_say_which_side_was_silent(self) -> None:
        before, after = evidence_module._boundary_levels(_window(_after(0.25)), _request()) or (
            0.0,
            0.0,
        )
        assert before == AUDIBLE_RMS_FLOOR_DBFS
        assert after == pytest.approx(-12.04, abs=0.01)


class _Audio:
    def __init__(self, signal: Signal) -> None:
        self._signal = signal

    def get_frame(self, times: np.ndarray[Any, np.dtype[np.float64]]) -> object:
        return self._signal(np.asarray(times, dtype=np.float64))[:, np.newaxis]


class _Composition:
    def __init__(self, signal: Signal | None) -> None:
        self.audio: _Audio | None = None if signal is None else _Audio(signal)
        self.duration: float | None = None
        self.closed = False

    def get_frame(self, time: float) -> object:
        return np.zeros((4, 4, 3), dtype=np.uint8)

    def close(self) -> None:
        self.closed = True


#: The mix of run x59-1 at frame 540, reduced: ambience at -55 dBFS on the picture track until
#: a radio call at -20 starts with the music; the music fades in from nothing.
RADIO_CALL = _cut(10 ** (-55 / 20), 0.1)
MUSIC_FADE = _fade_in(0.05, 3.0)


def _heard_jump(source: Signal, background: Signal | None, **request: Any) -> float:
    """The jump `_audio_sample` reports for ``source`` spliced over ``background``.

    The mix handed in is their sum, as the renderer's ``CompositeAudioClip`` makes it, so the
    background the engine derives (mix - source) is exactly ``background``.
    """
    mix = _Composition(source if background is None else (lambda t: source(t) + background(t)))
    sample = _audio_sample(
        mix,  # type: ignore[arg-type]
        _request(splice=MUSIC_SPLICE, **request),
        FPS,
        None,
        _Composition(source),  # type: ignore[arg-type]
    )
    assert sample.boundary_jump_db is not None
    return sample.boundary_jump_db


LEVEL_24 = 10 ** (-24 / 20)


class TestTheSourceIsJudgedOverWhatElsePlays:
    """Jump = |dB(sqrt(S_before² + B_ref²)) - dB(sqrt(S_after² + B_ref²))|, B_ref = quieter B."""

    def test_x59_the_music_entry_under_a_radio_call_passes(self) -> None:
        # B steps -55 → -20 (the radio call on v1). It is held at -55, and the bed's first
        # 10 ms are far under it, so nothing steps.
        assert _heard_jump(MUSIC_FADE, RADIO_CALL) < 2.0

    def test_a_lifted_clip_stopping_under_a_cover_shots_sound_passes(self) -> None:
        # The lift fixture: a1 stops at -24 dBFS while v2's cover plays -24 straight across.
        # -21 → -24 dBFS: the stop is a 3 dB dip, not the 36 dB the source alone reads.
        jump = _heard_jump(_until(LEVEL_24), lambda t: np.full_like(t, LEVEL_24))
        assert jump == pytest.approx(3.01, abs=0.05)

    def test_the_same_stop_with_nothing_else_playing_flags(self) -> None:
        assert _heard_jump(_until(LEVEL_24), None) == pytest.approx(36.0, abs=0.05)

    def test_a_hard_cut_between_two_levels_on_one_track_flags(self) -> None:
        # -10.5 → -30.5 dBFS on the source, silence everywhere else.
        assert _heard_jump(_cut(0.3, 0.03), None) == pytest.approx(20.0, abs=0.05)

    def test_the_backgrounds_own_change_never_counts(self) -> None:
        # A steady -30 dBFS source under which the radio call starts: B rising is not this cut.
        assert _heard_jump(lambda t: np.full_like(t, 10 ** (-30 / 20)), RADIO_CALL) < 0.1

    def test_the_peak_is_still_the_mixs(self) -> None:
        mix = _Composition(lambda t: RADIO_CALL(t) + MUSIC_FADE(t))
        sample = _audio_sample(
            mix,  # type: ignore[arg-type]
            _request(splice=MUSIC_SPLICE),
            FPS,
            None,
            _Composition(MUSIC_FADE),  # type: ignore[arg-type]
        )
        # The radio call plus the fade's last sample, not the music's -55 dBFS.
        assert sample.peak_dbfs == pytest.approx(-19.86, abs=0.01)

    def test_without_a_splice_the_mix_is_measured_as_before(self) -> None:
        # A request from before the splice was named: the radio call reads as the jump.
        mix = _Composition(lambda t: RADIO_CALL(t) + MUSIC_FADE(t))
        sample = _audio_sample(mix, _request(), FPS, None)  # type: ignore[arg-type]
        assert sample.boundary_jump_db is not None and sample.boundary_jump_db > 30

    def test_a_splice_with_no_sound_steps_from_silence_to_silence(self) -> None:
        mix = _Composition(RADIO_CALL)
        sample = _audio_sample(
            mix,  # type: ignore[arg-type]
            _request(splice=MUSIC_SPLICE),
            FPS,
            None,
            _Composition(None),  # type: ignore[arg-type]
        )
        assert sample.boundary_jump_db == 0.0


class TestTheContract:
    def test_an_old_request_without_a_splice_still_validates(self) -> None:
        assert _request().splice is None

    def test_a_splice_needs_a_boundary(self) -> None:
        with pytest.raises(ValidationError, match="needs boundaryFrame"):
            _request(splice=MUSIC_SPLICE, boundaryFrame=None)

    def test_a_splice_is_not_combined_with_a_role(self) -> None:
        with pytest.raises(ValidationError, match="channels must be 'mix'"):
            _request(splice=MUSIC_SPLICE, channels="music")

    def test_a_splice_names_at_least_one_track(self) -> None:
        with pytest.raises(ValidationError):
            _request(splice={"trackIds": []})

    def test_clip_ids_are_optional(self) -> None:
        splice = _request(splice={"trackIds": ["music"]}).splice
        assert splice is not None and splice.to_clip_ids == []


def _two_track_project(*, music_muted: bool = False) -> Project:
    return Project.model_validate(
        {
            "id": "project",
            "name": "Splice fixture",
            "fps": FPS,
            "resolution": {"width": 4, "height": 4},
            "assets": [
                {"id": "footage", "path": "a.mp4", "kind": "video"},
                {"id": "song", "path": "m.mp3", "kind": "audio"},
            ],
            "timeline": {
                "revision": 4,
                "tracks": [
                    {
                        "id": "picture",
                        "type": "video",
                        "clips": [
                            {
                                "id": "shot",
                                "assetId": "footage",
                                "trackId": "picture",
                                "start": 0,
                                "end": 2,
                                "sourceStart": 0,
                                "sourceEnd": 2,
                            }
                        ],
                    },
                    {
                        "id": "music",
                        "type": "audio",
                        "muted": music_muted,
                        "clips": [
                            {
                                "id": "bed",
                                "assetId": "song",
                                "trackId": "music",
                                "start": BOUNDARY_SECONDS,
                                "end": 2,
                                "sourceStart": 0,
                                "sourceEnd": 2 - BOUNDARY_SECONDS,
                            }
                        ],
                    },
                ],
            },
        }
    )


def _no_assets(*_args: object, **_kwargs: object) -> AssetIndex:
    return AssetIndex(base_dir="/nonexistent")


class _CompileByIsolation:
    """Answers the whole programme with the mix, and the isolated music track with the music."""

    def __init__(self) -> None:
        self.projects: list[Project] = []

    def __call__(self, project: Project, *_args: object, **_kwargs: object) -> _Composition:
        self.projects.append(project)
        picture = next(track for track in project.timeline.tracks if track.id == "picture")
        if picture.muted:
            return _Composition(MUSIC_FADE)
        return _Composition(lambda t: RADIO_CALL(t) + MUSIC_FADE(t))


class TestAcquisition:
    def test_measures_the_splice_tracks_alone_and_compiles_them_once(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        compile_spy = _CompileByIsolation()
        monkeypatch.setattr(evidence_module, "compile_timeline", compile_spy)
        monkeypatch.setattr(evidence_module, "index_assets", _no_assets)

        results = acquire_temporal_evidence(
            _two_track_project(),
            tmp_path,
            [
                _request(splice=MUSIC_SPLICE),
                _request(requestId="edit_audio_2_again", splice=MUSIC_SPLICE),
                _request(requestId="edit_audio_2_mix"),
            ],
        ).results

        jumps = [result.samples[0].boundary_jump_db for result in results]  # type: ignore[union-attr]
        assert jumps[0] is not None and jumps[0] < MAX_JUMP_DB
        assert jumps[1] == jumps[0]
        # The old-shaped request in the same batch still reads the mix.
        assert jumps[2] is not None and jumps[2] > 30
        # The programme once, the music track alone once, shared by both splice requests.
        assert len(compile_spy.projects) == 2
        isolated = compile_spy.projects[1]
        tracks = {track.id: track for track in isolated.timeline.tracks}
        assert tracks["picture"].muted and tracks["picture"].hidden
        assert not tracks["music"].muted and not tracks["music"].hidden

    def test_an_unheard_splice_is_not_compiled(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        compile_spy = _CompileByIsolation()
        monkeypatch.setattr(evidence_module, "compile_timeline", compile_spy)
        monkeypatch.setattr(evidence_module, "index_assets", _no_assets)

        [result] = acquire_temporal_evidence(
            _two_track_project(music_muted=True), tmp_path, [_request(splice=MUSIC_SPLICE)]
        ).results

        assert result.samples[0].boundary_jump_db == 0.0  # type: ignore[union-attr]
        assert len(compile_spy.projects) == 1

    def test_a_splice_on_a_track_the_project_lacks_is_refused(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setattr(evidence_module, "compile_timeline", _CompileByIsolation())
        monkeypatch.setattr(evidence_module, "index_assets", _no_assets)

        with pytest.raises(TemporalEvidenceError, match="does not have"):
            acquire_temporal_evidence(
                _two_track_project(), tmp_path, [_request(splice={"trackIds": ["nope"]})]
            )
