from __future__ import annotations

import inspect

import pytest

from framepilot_engine.render import compiler
from framepilot_engine.validation.temporal_evidence import (
    TemporalEvidenceCancelled,
    _check_cancelled,
)


def test_professional_audio_path_does_not_materialize_whole_clip_arrays() -> None:
    source = inspect.getsource(compiler._apply_audio_effects) + inspect.getsource(
        compiler._stream_audio_processors
    )
    assert "to_soundarray" not in source
    assert "write_audiofile" in source
    assert "apply_audio_filter" in source


def test_temporal_evidence_cancellation_is_fail_fast() -> None:
    with pytest.raises(TemporalEvidenceCancelled):
        _check_cancelled(lambda: True)
