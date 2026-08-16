"""Tests for local ASR via whisper-cli (plan H0.1).

Covers, offline (no whisper-cli/model/network required):
- the pure whisper-cli JSON parser (token merging, special-token stripping,
  non-monotonic/zero-duration clamping) against a realistic fixture;
- model/binary availability + status reporting;
- the honest-unavailable contract (missing binary / missing model never
  fabricates a transcript);
- model setup (streamed download + incremental SHA256 verify, real byte-level
  progress, cancellation) with an injected fake downloader;
- the single-slot :class:`~framepilot_engine.audio.asr.AsrSetupTracker`;
- the content-hash cache wrapper.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.audio import asr
from framepilot_engine.media.ffmpeg import FFmpegNotFoundError
from framepilot_engine.timeline.models import TranscriptWord

# --- Fixture: a realistic whisper-cli --output-json-full document ------------
# Two segments ("Hello world." / "Bye."), the first split into whisper.cpp's
# characteristic sub-word BPE tokens (leading-space = new word) plus a
# control/special token that must be dropped.

_FIXTURE_JSON: dict[str, Any] = {
    "transcription": [
        {
            "offsets": {"from": 0, "to": 900},
            "text": " Hello world.",
            "tokens": [
                {"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}},
                {"text": " Hello", "offsets": {"from": 0, "to": 400}},
                {"text": " world", "offsets": {"from": 400, "to": 800}},
                {"text": ".", "offsets": {"from": 800, "to": 900}},
            ],
        },
        {
            "offsets": {"from": 1000, "to": 1300},
            "text": " Bye.",
            "tokens": [
                {"text": " Bye", "offsets": {"from": 1000, "to": 1250}},
                {"text": ".", "offsets": {"from": 1250, "to": 1300}},
            ],
        },
    ]
}


def test_parse_whisper_json_merges_subword_tokens_into_words() -> None:
    words = asr.parse_whisper_json(_FIXTURE_JSON)
    assert [w.word for w in words] == ["Hello", "world.", "Bye."]
    assert words[0] == TranscriptWord(word="Hello", start=0.0, end=0.4)
    assert words[1] == TranscriptWord(word="world.", start=0.4, end=0.9)
    assert words[2] == TranscriptWord(word="Bye.", start=1.0, end=1.3)


def test_parse_whisper_json_preserves_leading_silence_before_first_word() -> None:
    data = {
        "transcription": [
            {
                "offsets": {"from": 930, "to": 1420},
                "text": " Precisely timed.",
                "tokens": [
                    {"text": " Precisely", "offsets": {"from": 930, "to": 1250}},
                    {"text": " timed", "offsets": {"from": 1250, "to": 1380}},
                    {"text": ".", "offsets": {"from": 1380, "to": 1420}},
                ],
            }
        ]
    }

    words = asr.parse_whisper_json(data)

    assert words == [
        TranscriptWord(word="Precisely", start=0.93, end=1.25),
        TranscriptWord(word="timed.", start=1.25, end=1.42),
    ]


def test_parse_whisper_json_drops_special_tokens() -> None:
    words = asr.parse_whisper_json(_FIXTURE_JSON)
    assert all(w.word not in ("[_BEG_]", "") for w in words)


def test_parse_whisper_json_empty_transcription() -> None:
    assert asr.parse_whisper_json({"transcription": []}) == []


def test_parse_whisper_json_missing_transcription_key() -> None:
    assert asr.parse_whisper_json({}) == []


def test_parse_whisper_json_single_word_segment_without_tokens_uses_segment_offsets() -> None:
    data = {
        "transcription": [
            {"offsets": {"from": 500, "to": 900}, "text": "Hi", "tokens": []},
        ]
    }
    words = asr.parse_whisper_json(data)
    assert words == [TranscriptWord(word="Hi", start=0.5, end=0.9)]


def test_parse_whisper_json_multi_word_segment_without_tokens_is_dropped() -> None:
    # Never fabricate per-word timing by splitting a multi-word segment's text on
    # whitespace and interpolating — this must be dropped, not guessed.
    data = {
        "transcription": [
            {"offsets": {"from": 0, "to": 2000}, "text": "no token detail here", "tokens": []},
        ]
    }
    assert asr.parse_whisper_json(data) == []


def test_parse_whisper_json_clamps_non_monotonic_timings() -> None:
    # Second token's offsets regress before the first token's end — must clamp to
    # non-decreasing, never emit start > end or overlapping/negative-duration.
    data = {
        "transcription": [
            {
                "offsets": {"from": 0, "to": 1000},
                "text": " one two",
                "tokens": [
                    {"text": " one", "offsets": {"from": 0, "to": 500}},
                    {"text": " two", "offsets": {"from": 300, "to": 300}},
                ],
            }
        ]
    }
    words = asr.parse_whisper_json(data)
    assert [w.word for w in words] == ["one", "two"]
    assert words[0].start == 0.0
    assert words[0].end == 0.5
    # "two" started before "one" ended and had zero reported duration; clamped to
    # start no earlier than "one"'s end, with a small positive duration.
    assert words[1].start >= words[0].end
    assert words[1].end > words[1].start


def test_parse_whisper_json_ignores_tokens_without_offsets() -> None:
    data = {
        "transcription": [
            {
                "offsets": {"from": 0, "to": 100},
                "text": " hi",
                "tokens": [{"text": " hi"}],  # no "offsets" key at all
            }
        ]
    }
    assert asr.parse_whisper_json(data) == []


# --- Binary discovery ---------------------------------------------------------


def test_find_whisper_cli_uses_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/custom/whisper-cli")
    assert asr.find_whisper_cli() == "/opt/custom/whisper-cli"


def test_find_whisper_cli_missing_raises_actionable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRAMEPILOT_WHISPER_CLI", raising=False)
    monkeypatch.setattr("shutil.which", lambda _name: None)
    with pytest.raises(asr.WhisperCliNotFoundError, match="whisper-cli not found"):
        asr.find_whisper_cli()


def test_whisper_cli_available_false_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRAMEPILOT_WHISPER_CLI", raising=False)
    monkeypatch.setattr("shutil.which", lambda _name: None)
    assert asr.whisper_cli_available() is False


def test_whisper_cli_available_true_when_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRAMEPILOT_WHISPER_CLI", raising=False)

    def fake_which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name == "whisper-cli" else None

    monkeypatch.setattr("shutil.which", fake_which)
    assert asr.whisper_cli_available() is True


# --- Model management ---------------------------------------------------------


def test_model_path_and_dir_honour_env_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    assert asr.model_dir() == tmp_path
    assert asr.model_path("base.en") == tmp_path / "ggml-base.en.bin"


def test_is_model_present_false_when_absent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    assert asr.is_model_present("base.en") is False


def test_is_model_present_true_when_file_exists(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    tmp_path.mkdir(exist_ok=True)
    (tmp_path / "ggml-base.en.bin").write_bytes(b"fake-model-bytes")
    assert asr.is_model_present("base.en") is True


def test_unknown_model_raises() -> None:
    with pytest.raises(asr.AsrError, match="Unknown ASR model"):
        asr.model_path("does-not-exist")


def _fake_downloader(
    chunks: Sequence[bytes], *, total_bytes: int | None = None
) -> asr.StreamDownloader:
    """A :data:`~framepilot_engine.audio.asr.StreamDownloader` over fixed chunks."""

    @contextmanager
    def opener(_url: str) -> Iterator[asr.ModelDownload]:
        yield asr.ModelDownload(total_bytes=total_bytes, chunks=iter(chunks))

    return opener


def _pin_checksum(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
    import hashlib

    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", hashlib.sha256(payload).hexdigest())


def test_registry_checksums_are_well_formed_sha256_digests() -> None:
    # Guards the real regression: a 63-character literal shipped here once and
    # made every setup attempt fail verification after a full ~141MB download.
    for name, spec in asr.ASR_MODELS.items():
        assert asr._SHA256_HEX.fullmatch(spec.sha256), f"{name} has a malformed sha256"
        assert spec.size_bytes > 0


def test_expected_sha256_rejects_malformed_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", "0" * 63)
    with pytest.raises(asr.AsrError, match="64 hex characters"):
        asr.expected_sha256("base.en")


def test_expected_sha256_rejects_malformed_registry_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRAMEPILOT_ASR_BASE_EN_SHA256", raising=False)
    broken = asr.AsrModelSpec(
        name="base.en", url="https://example/x.bin", filename="x.bin", sha256="nope", size_bytes=1
    )
    monkeypatch.setitem(asr.ASR_MODELS, "base.en", broken)
    with pytest.raises(asr.AsrError, match="built-in model registry"):
        asr.expected_sha256("base.en")


def test_expected_sha256_lowercases_an_uppercase_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", "A" * 64)
    assert asr.expected_sha256("base.en") == "a" * 64


def test_setup_model_fails_fast_on_malformed_checksum_before_downloading(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", "abc")

    def _never_called(_url: str) -> Any:  # pragma: no cover - must not run
        raise AssertionError("the download must not start with a malformed checksum")

    with pytest.raises(asr.AsrError, match="64 hex characters"):
        asr.setup_model("base.en", downloader=_never_called)


def test_setup_model_streams_chunks_and_verifies_checksum(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"totally-fake-model-payload"
    _pin_checksum(monkeypatch, payload)

    installed = asr.setup_model(
        "base.en", downloader=_fake_downloader([payload[:10], payload[10:]], total_bytes=26)
    )

    assert installed == tmp_path / "ggml-base.en.bin"
    assert installed.read_bytes() == payload
    assert asr.is_model_present("base.en") is True
    # No temp leftovers from the atomic-rename dance.
    assert [p.name for p in tmp_path.iterdir()] == ["ggml-base.en.bin"]


def test_setup_model_reports_real_byte_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"abcdefghij"
    _pin_checksum(monkeypatch, payload)
    seen: list[tuple[int, int | None]] = []

    asr.setup_model(
        "base.en",
        downloader=_fake_downloader([payload[:4], payload[4:]], total_bytes=10),
        on_progress=lambda done, total: seen.append((done, total)),
    )

    # A leading 0-of-N tick (so a UI renders the bar immediately), then one per chunk.
    assert seen == [(0, 10), (4, 10), (10, 10)]


def test_setup_model_falls_back_to_published_size_when_no_content_length(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"xyz"
    _pin_checksum(monkeypatch, payload)
    seen: list[tuple[int, int | None]] = []

    asr.setup_model(
        "base.en",
        downloader=_fake_downloader([payload], total_bytes=None),
        on_progress=lambda done, total: seen.append((done, total)),
    )

    assert seen == [(0, 147964211), (3, 147964211)]


def test_setup_model_rejects_checksum_mismatch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", "0" * 64)

    with pytest.raises(asr.AsrModelChecksumError, match="checksum verification"):
        asr.setup_model("base.en", downloader=_fake_downloader([b"wrong-bytes"]))

    # The mismatched download must never be installed under the real filename,
    # nor left behind as a temp file.
    assert asr.is_model_present("base.en") is False
    assert list(tmp_path.iterdir()) == []


def test_setup_model_cancels_mid_download_and_discards_the_partial_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    _pin_checksum(monkeypatch, b"abcd")
    cancel_after_first = iter([False, True, True])

    with pytest.raises(asr.AsrSetupCancelledError, match="cancelled"):
        asr.setup_model(
            "base.en",
            downloader=_fake_downloader([b"ab", b"cd"], total_bytes=4),
            is_cancelled=lambda: next(cancel_after_first),
        )

    assert asr.is_model_present("base.en") is False
    assert list(tmp_path.iterdir()) == []


# --- AsrSetupTracker: pollable, cancellable, single-slot ---------------------


def test_tracker_starts_idle() -> None:
    tracker = asr.AsrSetupTracker()
    snapshot = tracker.snapshot()
    assert snapshot.state is asr.AsrSetupState.IDLE
    assert tracker.is_running() is False
    assert tracker.cancel() is False


def test_tracker_publishes_progress_then_installed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"model-bytes"
    _pin_checksum(monkeypatch, payload)
    tracker = asr.AsrSetupTracker(downloader=_fake_downloader([payload], total_bytes=len(payload)))
    mid: list[asr.AsrSetupProgress] = []

    # Observe the live snapshot from inside the run (what a poller would see).
    original = asr.setup_model

    def spy(model: str, **kwargs: Any) -> Path:
        on_progress = kwargs["on_progress"]

        def wrapped(done: int, total: int | None) -> None:
            on_progress(done, total)
            mid.append(tracker.snapshot())

        return original(model, **{**kwargs, "on_progress": wrapped})

    monkeypatch.setattr(asr, "setup_model", spy)

    path = tracker.run("base.en")

    assert path.is_file()
    assert [(p.state, p.downloaded_bytes, p.total_bytes) for p in mid] == [
        (asr.AsrSetupState.DOWNLOADING, 0, 11),
        (asr.AsrSetupState.DOWNLOADING, 11, 11),
    ]
    final = tracker.snapshot()
    assert final.state is asr.AsrSetupState.INSTALLED
    assert final.downloaded_bytes == 11
    assert final.error is None


def test_tracker_records_failure_message_for_pollers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", "0" * 64)
    tracker = asr.AsrSetupTracker(downloader=_fake_downloader([b"nope"]))

    with pytest.raises(asr.AsrModelChecksumError):
        tracker.run("base.en")

    snapshot = tracker.snapshot()
    assert snapshot.state is asr.AsrSetupState.ERROR
    assert snapshot.error is not None
    assert "checksum verification" in snapshot.error


def test_tracker_cancel_stops_the_run_and_reports_cancelled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    _pin_checksum(monkeypatch, b"abcd")
    tracker = asr.AsrSetupTracker()

    @contextmanager
    def opener(_url: str) -> Iterator[asr.ModelDownload]:
        def chunks() -> Iterator[bytes]:
            yield b"ab"
            # The UI's cancel lands between chunks, exactly as it would in life.
            assert tracker.cancel() is True
            yield b"cd"

        yield asr.ModelDownload(total_bytes=4, chunks=chunks())

    tracker._downloader = opener

    with pytest.raises(asr.AsrSetupCancelledError):
        tracker.run("base.en")

    snapshot = tracker.snapshot()
    assert snapshot.state is asr.AsrSetupState.CANCELLED
    assert snapshot.downloaded_bytes == 2
    assert asr.is_model_present("base.en") is False
    # The cancel flag is cleared, so a retry is not instantly cancelled again.
    assert tracker._cancel.is_set() is False


def test_tracker_rejects_a_concurrent_run(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"abcd"
    _pin_checksum(monkeypatch, payload)
    tracker = asr.AsrSetupTracker()
    busy: list[str] = []

    @contextmanager
    def opener(_url: str) -> Iterator[asr.ModelDownload]:
        def chunks() -> Iterator[bytes]:
            # A second request arriving while this one streams must be refused.
            with pytest.raises(asr.AsrSetupBusyError, match="already running"):
                tracker.run("base.en")
            busy.append("refused")
            yield payload

        yield asr.ModelDownload(total_bytes=4, chunks=chunks())

    tracker._downloader = opener
    tracker.run("base.en")

    assert busy == ["refused"]
    assert tracker.snapshot().state is asr.AsrSetupState.INSTALLED


def test_tracker_ignores_a_late_progress_callback_from_a_finished_run(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"abcd"
    _pin_checksum(monkeypatch, payload)
    tracker = asr.AsrSetupTracker(downloader=_fake_downloader([payload], total_bytes=4))
    leaked: list[asr.DownloadProgress] = []

    original = asr.setup_model

    def spy(model: str, **kwargs: Any) -> Path:
        leaked.append(kwargs["on_progress"])
        return original(model, **kwargs)

    monkeypatch.setattr(asr, "setup_model", spy)
    tracker.run("base.en")

    leaked[0](999, 999)  # a straggler after the job already terminated

    final = tracker.snapshot()
    assert final.state is asr.AsrSetupState.INSTALLED
    assert final.downloaded_bytes == 4


def test_get_status_reports_binary_and_model_state(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    status = asr.get_status("base.en")
    assert status.binary_available is True
    assert status.binary_path == "/opt/whisper-cli"
    assert status.model == "base.en"
    assert status.model_present is False


def test_get_status_reports_binary_unavailable_honestly(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.delenv("FRAMEPILOT_WHISPER_CLI", raising=False)
    monkeypatch.setattr("shutil.which", lambda _name: None)
    status = asr.get_status("base.en")
    assert status.binary_available is False
    assert status.binary_path is None


def test_is_special_token_recognizes_gpt_style_markers() -> None:
    assert asr._is_special_token("<|endoftext|>") is True
    assert asr._is_special_token("Hello") is False


def test_is_special_token_blank_text_is_special() -> None:
    assert asr._is_special_token("   ") is True


def test_parse_whisper_json_skips_non_dict_segments() -> None:
    data = {
        "transcription": [
            "not-a-dict",
            {"offsets": {"from": 0, "to": 100}, "text": "hi", "tokens": []},
        ]
    }
    words = asr.parse_whisper_json(data)
    assert [w.word for w in words] == ["hi"]


def test_cache_dir_defaults_alongside_model_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("FRAMEPILOT_ASR_CACHE_DIR", raising=False)
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path / "models"))
    assert asr.cache_dir() == tmp_path / "asr-cache"


def test_token_offsets_seconds_rejects_non_numeric_offsets() -> None:
    assert asr._token_offsets_seconds({"offsets": {"from": "x", "to": 1}}) is None
    assert asr._token_offsets_seconds({"offsets": "not-a-dict"}) is None
    assert asr._token_offsets_seconds({}) is None


# --- extract_mono16k_wav: hosted-chunking audio prep --------------------------


def test_extract_mono16k_wav_returns_ffmpeg_output_bytes(tmp_path: Path) -> None:
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    calls: list[Sequence[str]] = []

    def fake_run(argv: Sequence[str], timeout: float | None) -> None:
        calls.append(list(argv))
        # ffmpeg's output path is the final argv element; write a stand-in WAV there.
        Path(argv[-1]).write_bytes(b"RIFF....WAVEfake")

    data = asr.extract_mono16k_wav(media, run=fake_run)

    assert data == b"RIFF....WAVEfake"
    argv = calls[0]
    # Decoded to the canonical mono 16kHz PCM WAV the chunker expects.
    assert "-ar" in argv and "16000" in argv
    assert "-ac" in argv and "1" in argv
    assert "-f" in argv and "wav" in argv


def test_extract_mono16k_wav_wraps_missing_ffmpeg_as_asr_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"x")

    def boom(*_a: object, **_k: object) -> str:
        raise FFmpegNotFoundError("no ffmpeg")

    monkeypatch.setattr(asr, "find_ffmpeg", boom)
    with pytest.raises(asr.AsrTranscriptionError, match="ffmpeg unavailable"):
        asr.extract_mono16k_wav(media)


# --- transcribe_local: honest-unavailable contract ----------------------------


def test_transcribe_local_raises_when_binary_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("FRAMEPILOT_WHISPER_CLI", raising=False)
    monkeypatch.setattr("shutil.which", lambda _name: None)
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    with pytest.raises(asr.WhisperCliNotFoundError):
        asr.transcribe_local(media)


def test_transcribe_local_raises_when_model_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path / "models"))
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    with pytest.raises(asr.AsrModelMissingError, match="Run the ASR setup step"):
        asr.transcribe_local(media)


def test_transcribe_local_runs_ffmpeg_then_whisper_cli_and_parses_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    model_dir = tmp_path / "models"
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(model_dir))
    model_dir.mkdir(parents=True)
    (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"fake-model")

    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    calls: list[Sequence[str]] = []

    def fake_run(argv: Sequence[str], timeout: float | None) -> None:
        calls.append(list(argv))
        if argv[0] == "/opt/whisper-cli":
            # Locate the `-of <prefix>` output path and write the fixture JSON
            # exactly where transcribe_local will look for it.
            out_index = argv.index("-of") + 1
            prefix = Path(argv[out_index])
            prefix.with_suffix(".json").write_text(json.dumps(_FIXTURE_JSON))

    words = asr.transcribe_local(media, run=fake_run)

    assert [w.word for w in words] == ["Hello", "world.", "Bye."]
    # First call extracts mono 16k wav via ffmpeg; second runs whisper-cli with
    # word-timestamp flags against that wav.
    assert len(calls) == 2
    ffmpeg_argv, whisper_argv = calls
    assert "-ar" in ffmpeg_argv and "16000" in ffmpeg_argv
    assert "-ac" in ffmpeg_argv and "1" in ffmpeg_argv
    assert whisper_argv[0] == "/opt/whisper-cli"
    assert "-ml" in whisper_argv and "1" in whisper_argv
    assert "--dtw" in whisper_argv and "large.v3.turbo" in whisper_argv
    assert "-l" in whisper_argv and "auto" in whisper_argv
    assert "-sns" in whisper_argv
    assert "-np" in whisper_argv
    assert "-nt" not in whisper_argv
    assert "-ojf" in whisper_argv


def test_transcribe_local_raises_when_no_json_output_produced(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    model_dir = tmp_path / "models"
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(model_dir))
    model_dir.mkdir(parents=True)
    (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"fake-model")
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    def fake_run(argv: Sequence[str], timeout: float | None) -> None:
        return None  # never writes the expected JSON file

    with pytest.raises(asr.AsrTranscriptionError, match="did not produce"):
        asr.transcribe_local(media, run=fake_run)


def test_default_runner_raises_on_missing_binary(tmp_path: Path) -> None:
    with pytest.raises(asr.AsrTranscriptionError, match="Binary not found"):
        asr._default_runner(["/no/such/binary-xyz"], 5.0)


def test_default_runner_raises_on_nonzero_exit() -> None:
    with pytest.raises(asr.AsrTranscriptionError, match="exited"):
        asr._default_runner(["false"], 5.0)


def test_default_runner_succeeds_on_zero_exit() -> None:
    asr._default_runner(["true"], 5.0)  # must not raise


def test_default_runner_raises_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(*_args: object, **_kwargs: object) -> None:
        raise subprocess.TimeoutExpired(cmd="whisper-cli", timeout=1.0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(asr.AsrTranscriptionError, match="Timed out"):
        asr._default_runner(["whisper-cli"], 1.0)


def test_transcribe_local_raises_when_ffmpeg_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    model_dir = tmp_path / "models"
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(model_dir))
    model_dir.mkdir(parents=True)
    (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"fake-model")
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    def missing_ffmpeg() -> str:
        raise FFmpegNotFoundError("ffmpeg not found")

    monkeypatch.setattr(asr, "find_ffmpeg", missing_ffmpeg)

    with pytest.raises(asr.AsrTranscriptionError, match="ffmpeg unavailable"):
        asr.transcribe_local(media, run=lambda argv, timeout: None)


def test_transcribe_local_raises_on_malformed_json_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    model_dir = tmp_path / "models"
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(model_dir))
    model_dir.mkdir(parents=True)
    (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"fake-model")
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    def fake_run(argv: Sequence[str], timeout: float | None) -> None:
        if argv[0] == "/opt/whisper-cli":
            out_index = argv.index("-of") + 1
            Path(argv[out_index]).with_suffix(".json").write_text("{not valid json")

    with pytest.raises(asr.AsrTranscriptionError, match="Failed to read whisper-cli output"):
        asr.transcribe_local(media, run=fake_run)


# --- Content-hash cache --------------------------------------------------------


def test_transcribe_caches_by_content_hash(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    model_dir = tmp_path / "models"
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(model_dir))
    monkeypatch.setenv("FRAMEPILOT_ASR_CACHE_DIR", str(tmp_path / "cache"))
    model_dir.mkdir(parents=True)
    (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"fake-model")
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    call_count = 0

    def fake_run(argv: Sequence[str], timeout: float | None) -> None:
        nonlocal call_count
        if argv[0] == "/opt/whisper-cli":
            call_count += 1
            out_index = argv.index("-of") + 1
            prefix = Path(argv[out_index])
            prefix.with_suffix(".json").write_text(json.dumps(_FIXTURE_JSON))

    first = asr.transcribe(media, run=fake_run)
    second = asr.transcribe(media, run=fake_run)

    assert call_count == 1  # second call served from cache, whisper-cli not re-run
    assert first == second
    assert [w.word for w in first] == ["Hello", "world.", "Bye."]


def test_transcribe_use_cache_false_always_runs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    model_dir = tmp_path / "models"
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(model_dir))
    monkeypatch.setenv("FRAMEPILOT_ASR_CACHE_DIR", str(tmp_path / "cache"))
    model_dir.mkdir(parents=True)
    (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"fake-model")
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    call_count = 0

    def fake_run(argv: Sequence[str], timeout: float | None) -> None:
        nonlocal call_count
        if argv[0] == "/opt/whisper-cli":
            call_count += 1
            out_index = argv.index("-of") + 1
            prefix = Path(argv[out_index])
            prefix.with_suffix(".json").write_text(json.dumps(_FIXTURE_JSON))

    asr.transcribe(media, run=fake_run, use_cache=False)
    asr.transcribe(media, run=fake_run, use_cache=False)

    assert call_count == 2


def test_transcribe_discards_corrupt_cache_entry_and_retranscribes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    model_dir = tmp_path / "models"
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(model_dir))
    cache = tmp_path / "cache"
    monkeypatch.setenv("FRAMEPILOT_ASR_CACHE_DIR", str(cache))
    model_dir.mkdir(parents=True)
    (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"fake-model")
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")

    key = asr._content_hash(media, asr.DEFAULT_ASR_MODEL)
    cache.mkdir(parents=True)
    (cache / f"{key}.json").write_text("{not valid json")

    def fake_run(argv: Sequence[str], timeout: float | None) -> None:
        if argv[0] == "/opt/whisper-cli":
            out_index = argv.index("-of") + 1
            Path(argv[out_index]).with_suffix(".json").write_text(json.dumps(_FIXTURE_JSON))

    words = asr.transcribe(media, run=fake_run)
    assert [w.word for w in words] == ["Hello", "world.", "Bye."]
