"""Word timing from whisper.cpp DTW, capped, with punctuation folded into words.

The defect, measured on NASA's raw "X-59 First Flight B-roll" (radio calls over long
stretches of jet noise): the stored transcript had "." spanning 0.02-24.96 s, "Thank"
148.02-161.62 s and 27 words over 2 s, and the critic flagged cuts at 6 s and 17 s as
"inside a word". Two causes:

1. ``--dtw`` measured nothing. whisper.cpp 1.8+ turns flash attention on by default and
   DTW needs the attention weights flash attention never keeps, so every token came back
   with ``t_dtw = -1``. ``-nfa`` fixes it, but only a binary that lists the flag may get it.
2. The parser built every word from whisper.cpp's heuristic ``offsets``, which pad
   non-speech into the neighbouring token, and ignored ``t_dtw`` anyway.

Fixtures below use the measured token values (heuristic span, DTW point) where they exist.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.analysis.tiers import ANALYZER_VERSIONS, AnalysisKind
from framepilot_engine.audio import asr
from framepilot_engine.timeline.models import TranscriptWord

# --- Fixture builders -----------------------------------------------------------


def _token(text: str, start_s: float, end_s: float, dtw_s: float | None = None) -> dict[str, Any]:
    """A whisper.cpp ``-ojf`` token: offsets in ms, ``t_dtw`` in centiseconds (-1 = none)."""
    return {
        "text": text,
        "offsets": {"from": round(start_s * 1000), "to": round(end_s * 1000)},
        "t_dtw": -1 if dtw_s is None else round(dtw_s * 100),
    }


def _segment(*tokens: dict[str, Any]) -> dict[str, Any]:
    return {
        "offsets": {"from": tokens[0]["offsets"]["from"], "to": tokens[-1]["offsets"]["to"]},
        "text": "".join(str(token["text"]) for token in tokens),
        "tokens": list(tokens),
    }


def _document(*segments: dict[str, Any]) -> dict[str, Any]:
    return {"transcription": list(segments)}


def _spans(words: Sequence[TranscriptWord]) -> list[tuple[str, float, float]]:
    return [(word.word, word.start, word.end) for word in words]


def _assert_spans(
    words: Sequence[TranscriptWord], expected: Sequence[tuple[str, float, float]]
) -> None:
    assert [word.word for word in words] == [text for text, _start, _end in expected]
    for word, (_text, start, end) in zip(words, expected, strict=True):
        assert word.start == pytest.approx(start, abs=1e-3), word
        assert word.end == pytest.approx(end, abs=1e-3), word


#: Shaped like the measured X-59 transcript, one word per segment as ``-ml 1`` writes it.
#: Heuristic spans are whisper.cpp's padded ``offsets``; the third value is the DTW point.
#: "The weather is nice" is placed 10 s before "Thank" so a word ends in a long gap.
#: Natural (uncapped) durations: Copy. 0.60, The 0.16, weather 0.12, is 0.26,
#: nice 10.00, Thank 0.18, you. 0.02 → median 0.18 → longest word 0.36 s.
_X59_SHAPED = _document(
    _segment(
        _token("[_BEG_]", 0.0, 0.0),
        _token(" .", 0.02, 24.96, 3.66),
        _token("[_TT_1250]", 25.0, 25.0),
    ),
    _segment(_token(" Copy", 33.02, 35.00, 33.94), _token(".", 35.00, 35.00, 34.54)),
    _segment(_token(" The", 135.00, 137.00, 143.36)),
    _segment(_token(" weather", 137.00, 139.00, 143.52)),
    _segment(_token(" is", 139.00, 141.00, 143.64)),
    _segment(_token(" nice", 141.00, 148.00, 143.90)),
    _segment(_token(" Thank", 148.02, 161.62, 153.90)),
    _segment(_token(" you", 161.62, 169.80, 154.08), _token(".", 173.55, 177.91, 154.10)),
)


# --- DTW word timing -----------------------------------------------------------------


def test_dtw_word_starts_at_its_first_token_and_ends_at_the_next_tokens_point() -> None:
    # Heuristic spans deliberately padded: none of them may leak into the words.
    data = _document(
        _segment(_token(" one", 0.0, 1.9, 1.0)),
        _segment(_token(" two", 1.9, 2.0, 1.3)),
        _segment(_token(" three", 2.0, 2.1, 1.6), _token(".", 2.1, 5.0, 1.9)),
        _segment(_token(" four", 5.0, 5.4, 2.2)),
    )

    words = asr.parse_whisper_json(data)

    # The last word has no following DTW point, so its end is the heuristic one (5.4),
    # capped at twice the 0.3 s median.
    _assert_spans(
        words,
        [("one", 1.0, 1.3), ("two", 1.3, 1.6), ("three.", 1.6, 1.9), ("four", 2.2, 2.8)],
    )


def test_the_measured_x59_shape_has_no_long_or_punctuation_words() -> None:
    words = asr.parse_whisper_json(_X59_SHAPED)

    _assert_spans(
        words,
        [
            # The punctuation boundary (34.54) is past the 0.36 s cap.
            ("Copy.", 33.94, 34.30),
            ("The", 143.36, 143.52),
            ("weather", 143.52, 143.64),
            ("is", 143.64, 143.90),
            # The next word starts 10 s later; the cap stops "nice" swallowing the gap.
            ("nice", 143.90, 144.26),
            ("Thank", 153.90, 154.08),
            ("you.", 154.08, 154.10),
        ],
    )
    # The leading " ." that whisper.cpp stretched over 0.02-24.96 s is gone.
    assert all(asr._has_word_character(word.word) for word in words)


def test_the_measured_count_lands_where_dtw_heard_it_not_where_the_heuristic_put_it() -> None:
    """ "One two three one two one one": heuristic 116-134 s, DTW 130.4-136.5 s.

    An independent large-v3-turbo segment transcript put the count at 130.5-136.5 s.
    The first comma is aligned in the same 20 ms frame as "One" — a boundary that
    measures nothing — so "One," ends at the next word (132.50), capped.
    Natural durations 2.14, .52, .34, .48, .28, .24, .60 → median 0.48 → cap 0.96 s.
    """
    count = [
        ("One", 116.02, 117.58, 130.36, 130.36),
        ("two", 118.63, 120.21, 132.50, 133.02),
        ("three", 121.26, 123.89, 133.22, 133.56),
        ("one", 124.94, 126.52, 134.00, 134.48),
        ("two", 127.57, 129.15, 134.58, 134.86),
        ("one", 130.20, 131.78, 135.26, 135.50),
    ]
    segments = [
        _segment(
            _token(f" {text}", start, end, dtw),
            _token(",", end, end + 1.0, comma_dtw),
        )
        for text, start, end, dtw, comma_dtw in count
    ]
    segments.append(
        _segment(_token(" one", 132.83, 134.40, 135.92), _token(".", 134.41, 136.0, 136.52))
    )

    words = asr.parse_whisper_json(_document(*segments))

    _assert_spans(
        words,
        [
            ("One,", 130.36, 131.32),
            ("two,", 132.50, 133.02),
            ("three,", 133.22, 133.56),
            ("one,", 134.00, 134.48),
            ("two,", 134.58, 134.86),
            ("one,", 135.26, 135.50),
            ("one.", 135.92, 136.52),
        ],
    )


def test_the_median_is_capped_at_0_7_s_so_slow_padding_cannot_license_long_words() -> None:
    # Every word's natural span is 2 s: its own median would allow 4 s words. Capped at
    # 0.7 s, the longest word is 1.4 s.
    data = _document(
        *(_segment(_token(f" {text}", at, at + 2.0, at)) for text, at in _SLOW_WORDS),
    )

    words = asr.parse_whisper_json(data)

    _assert_spans(words, [(text, at, at + 1.4) for text, at in _SLOW_WORDS])


_SLOW_WORDS = [("Point", 0.0), ("complete", 2.0), ("thank", 4.0), ("you", 6.0)]


def test_a_multi_token_word_keeps_the_span_its_tokens_were_aligned_over() -> None:
    # Scripts without spaces arrive as one many-token "word" per segment. The cap is
    # measured from the last content token, so the aligned 1.9 s phrase survives a
    # 0.4 s longest-word limit instead of being cut to its first token.
    phrase = ["我们", "今天", "去", "公园", "散步"]
    cjk = _segment(
        *(
            _token((" " if index == 0 else "") + text, 0.0, 0.0, 10.0 + index * 0.4)
            for index, text in enumerate(phrase)
        ),
        _token("。", 0.0, 0.0, 11.9),
    )
    short = _segment(
        _token(" ok", 0.0, 0.0, 13.0),
        _token(" yes", 0.0, 0.0, 13.2),
        _token(" no", 0.0, 0.0, 13.4),
        _token(" so", 13.6, 13.8, 13.6),
    )

    words = asr.parse_whisper_json(_document(cjk, short))

    assert _spans(words)[0] == ("我们今天去公园散步。", 10.0, 11.9)


def test_a_boundary_without_a_dtw_point_falls_back_to_the_heuristic_end() -> None:
    data = _document(
        _segment(_token(" hello", 0.9, 1.4, 1.0)),
        _segment(_token(" world", 1.4, 1.8)),
    )

    words = asr.parse_whisper_json(data)

    _assert_spans(words, [("hello", 1.0, 1.4), ("world", 1.4, 1.8)])


# --- Heuristic fallback (no DTW: t_dtw = -1, or an old binary without the key) --------


def _strip_dtw(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "transcription": [
            {
                **segment,
                "tokens": [
                    {key: value for key, value in token.items() if key != "t_dtw"}
                    for token in segment["tokens"]
                ],
            }
            for segment in data["transcription"]
        ]
    }


_THANK_YOU_HEURISTIC = _document(
    _segment(_token(" Point", 146.02, 146.62)),
    _segment(_token(" complete", 146.62, 147.62), _token(".", 147.62, 148.00)),
    _segment(_token(" Thank", 148.02, 161.62)),
    _segment(_token(" you", 161.62, 169.80), _token(".", 173.55, 177.91)),
)


@pytest.mark.parametrize(
    "data",
    [_THANK_YOU_HEURISTIC, _strip_dtw(_THANK_YOU_HEURISTIC)],
    ids=["t_dtw=-1", "no t_dtw key"],
)
def test_the_heuristic_fallback_is_capped_too(data: dict[str, Any]) -> None:
    # Natural spans 0.60, 1.38, 13.60, 16.29 → median 7.49, capped at 0.7 → 1.4 s.
    words = asr.parse_whisper_json(data)

    _assert_spans(
        words,
        [
            ("Point", 146.02, 146.62),
            ("complete.", 146.62, 148.00),
            ("Thank", 148.02, 149.42),
            ("you.", 161.62, 163.02),
        ],
    )


def test_the_heuristic_fallback_bounds_a_word_whose_inner_tokens_are_padded() -> None:
    # whisper.cpp spreads a long segment over its tokens, so a two-token word can carry
    # padding in BOTH tokens; the per-token limit still bounds it (2 x 0.8 s here).
    data = _document(
        _segment(_token(" Thank", 100.0, 110.0), _token("s", 110.0, 120.0)),
        _segment(_token(" a", 120.0, 120.4)),
        _segment(_token(" lot", 120.4, 120.8)),
    )

    words = asr.parse_whisper_json(data)

    # Natural spans 20.0, 0.4, 0.4 → median 0.4 → 0.8 s per token; the tail limit
    # (last token "s" at 110.0 + 0.8) alone would have allowed 10.8 s.
    _assert_spans(words, [("Thanks", 100.0, 101.6), ("a", 120.0, 120.4), ("lot", 120.4, 120.8)])


def test_the_cap_never_lengthens_a_word() -> None:
    data = _document(
        _segment(_token(" quick", 1.0, 1.1, 1.0)),
        _segment(_token(" words", 1.1, 1.2, 1.1)),
        _segment(_token(" here", 1.2, 1.25)),
    )

    words = asr.parse_whisper_json(data)

    _assert_spans(words, [("quick", 1.0, 1.1), ("words", 1.1, 1.2), ("here", 1.2, 1.25)])


# --- Punctuation-only tokens are not words ---------------------------------------------


def test_a_leading_punctuation_token_is_dropped() -> None:
    data = _document(
        _segment(_token(" .", 0.02, 24.96, 3.66)),
        _segment(_token(" Pole", 25.02, 25.33, 25.68)),
    )

    words = asr.parse_whisper_json(data)

    assert [word.word for word in words] == ["Pole"]


@pytest.mark.parametrize(
    ("word", "punctuation"),
    [
        (" go", " ."),
        (" नमस्ते", " ।"),  # Devanagari danda; the word itself ends in a vowel sign (Mc)
        (" 你好", " 。"),  # CJK full stop
        (" wait", " —"),  # em dash
        (" really", " ?!"),
    ],
)
def test_a_punctuation_only_token_joins_the_preceding_word(word: str, punctuation: str) -> None:
    data = _document(
        _segment(_token(word, 1.0, 1.3, 1.0)),
        _segment(_token(punctuation, 1.3, 9.0, 1.3)),
        _segment(_token(" next", 9.0, 9.3, 1.6)),
    )

    words = asr.parse_whisper_json(data)

    # The punctuation keeps no span of its own; the word keeps its own timing. "next" is
    # last, so its heuristic end (9.3) is capped: median (0.3 + 7.7) / 2 → 0.7 → 1.4 s.
    _assert_spans(words, [(word.strip() + punctuation.strip(), 1.0, 1.3), ("next", 1.6, 3.0)])


def test_numbers_and_marks_are_word_characters_but_symbols_are_not() -> None:
    assert asr._has_word_character("100")
    assert asr._has_word_character("े")  # Devanagari vowel sign E (Mn)
    assert asr._has_word_character("é")
    assert not asr._has_word_character("«…»")
    assert not asr._has_word_character("。")
    assert not asr._has_word_character("")


def test_a_split_multibyte_character_still_counts_as_a_word() -> None:
    # Each token carries only part of the character's bytes (surrogate-escaped on read);
    # neither fragment is a letter, but the rejoined word is.
    ga = "ग".encode()
    first = (b" " + ga[:2]).decode("utf-8", "surrogateescape")
    rest = ga[2:].decode("utf-8", "surrogateescape")
    data = _document(_segment(_token(first, 0.0, 0.1, 0.0), _token(rest, 0.1, 0.2, 0.1)))

    words = asr.parse_whisper_json(data)

    assert [word.word for word in words] == ["ग"]


# --- -nfa: only when the binary lists it ------------------------------------------------

_HELP_WITH_NFA = """usage: whisper-cli [options] file0 file1 ...
  -dtw MODEL --dtw MODEL            [       ] compute token-level timestamps
  -fa,       --flash-attn           [true   ] enable flash attention
  -nfa,      --no-flash-attn        [false  ] disable flash attention
"""

_HELP_WITHOUT_NFA = """usage: whisper-cli [options] file0 file1 ...
  -dtw MODEL --dtw MODEL            [       ] compute token-level timestamps
  -fa,       --flash-attn           [false  ] flash attention
"""


def _install_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setenv("FRAMEPILOT_WHISPER_CLI", "/opt/whisper-cli")
    model_dir = tmp_path / "models"
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(model_dir))
    model_dir.mkdir(parents=True)
    (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"fake-model")
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"not-real-media")
    return media


def _recording_runner(
    calls: list[list[str]], output: dict[str, Any] = _X59_SHAPED
) -> Callable[[Sequence[str], float | None], None]:
    def run(argv: Sequence[str], timeout: float | None) -> None:
        del timeout
        if argv[0] == "/opt/whisper-cli":
            calls.append(list(argv))
            Path(argv[argv.index("-of") + 1]).with_suffix(".json").write_text(json.dumps(output))

    return run


def test_transcribe_disables_flash_attention_when_the_binary_supports_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    media = _install_model(monkeypatch, tmp_path)
    calls: list[list[str]] = []

    words = asr.transcribe_local(
        media, run=_recording_runner(calls), read_help=lambda _binary: _HELP_WITH_NFA
    )

    (argv,) = calls
    dtw_at = argv.index("--dtw")
    assert argv[dtw_at + 1 : dtw_at + 3] == ["large.v3.turbo", "-nfa"]
    assert words[0].word == "Copy."


@pytest.mark.parametrize(
    "help_text",
    [_HELP_WITHOUT_NFA, None, "  -nfax  something else\n"],
    ids=["older binary", "help unreadable", "only a longer option"],
)
def test_transcribe_omits_the_flag_a_binary_does_not_list(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, help_text: str | None
) -> None:
    media = _install_model(monkeypatch, tmp_path)
    calls: list[list[str]] = []

    asr.transcribe_local(media, run=_recording_runner(calls), read_help=lambda _binary: help_text)

    (argv,) = calls
    assert "-nfa" not in argv
    assert "--dtw" in argv


def test_the_help_probe_runs_once_per_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(asr, "_help_text_cache", {})
    probed: list[str] = []

    def fake_help(binary: str) -> str:
        probed.append(binary)
        return _HELP_WITH_NFA

    monkeypatch.setattr(asr, "_run_whisper_help", fake_help)

    assert asr.whisper_cli_supports_no_flash_attn("/opt/a/whisper-cli")
    assert asr.whisper_cli_supports_no_flash_attn("/opt/a/whisper-cli")
    assert asr.whisper_cli_supports_no_flash_attn("/opt/b/whisper-cli")

    assert probed == ["/opt/a/whisper-cli", "/opt/b/whisper-cli"]


def test_a_failed_help_probe_is_retried_not_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(asr, "_help_text_cache", {})
    answers: list[str | None] = [None, _HELP_WITH_NFA]
    monkeypatch.setattr(asr, "_run_whisper_help", lambda _binary: answers.pop(0))

    assert asr.whisper_cli_supports_no_flash_attn("/opt/whisper-cli") is False
    assert asr.whisper_cli_supports_no_flash_attn("/opt/whisper-cli") is True


def test_a_binary_replaced_in_place_is_probed_again(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(asr, "_help_text_cache", {})
    binary = tmp_path / "whisper-cli"
    binary.write_text("new build")
    answers = [_HELP_WITH_NFA, _HELP_WITHOUT_NFA]
    monkeypatch.setattr(asr, "_run_whisper_help", lambda _binary: answers.pop(0))

    assert asr.whisper_cli_supports_no_flash_attn(str(binary)) is True
    mtime_ns = binary.stat().st_mtime_ns
    os.utime(binary, ns=(mtime_ns, mtime_ns - 10**9))  # a pack downgraded in place

    assert asr.whisper_cli_supports_no_flash_attn(str(binary)) is False


def test_the_real_probe_reads_help_from_stderr(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # whisper-cli prints its usage to stderr, not stdout.
    monkeypatch.setattr(asr, "_help_text_cache", {})
    binary = tmp_path / "whisper-cli"
    binary.write_text(f"#!/bin/sh\ncat >&2 <<'EOF'\n{_HELP_WITH_NFA}EOF\n")
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR)

    assert asr.whisper_cli_supports_no_flash_attn(str(binary)) is True


def test_the_real_probe_answers_false_for_a_missing_binary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(asr, "_help_text_cache", {})

    assert asr.whisper_cli_supports_no_flash_attn(str(tmp_path / "absent")) is False


# --- The cache does not serve transcripts parsed by the old rules ------------------------


def test_the_cache_key_changes_with_the_timing_version(tmp_path: Path) -> None:
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"same bytes")
    model = asr.DEFAULT_ASR_MODEL

    v1 = asr._content_hash(media, model, timing_version=1)
    v2 = asr._content_hash(media, model, timing_version=2)
    legacy = hashlib.sha256(model.encode() + b"same bytes").hexdigest()

    assert v1 != v2
    assert asr._content_hash(media, model) == asr._content_hash(
        media, model, timing_version=asr.TRANSCRIPT_TIMING_VERSION
    )
    # Entries written before the key was salted at all are unreachable too.
    assert legacy not in {v1, v2, asr._content_hash(media, model)}


def test_an_entry_cached_by_the_old_parser_is_not_served(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    media = _install_model(monkeypatch, tmp_path)
    cache = tmp_path / "cache"
    monkeypatch.setenv("FRAMEPILOT_ASR_CACHE_DIR", str(cache))
    cache.mkdir()
    legacy_key = hashlib.sha256(asr.DEFAULT_ASR_MODEL.encode() + media.read_bytes()).hexdigest()
    inflated = [TranscriptWord(word=".", start=0.02, end=24.96).model_dump()]
    (cache / f"{legacy_key}.json").write_text(json.dumps(inflated))
    calls: list[list[str]] = []

    words = asr.transcribe(media, run=_recording_runner(calls), read_help=lambda _b: None)

    assert len(calls) == 1
    assert words[0].word == "Copy."


def test_the_analyze_cache_version_moves_with_the_timing_version() -> None:
    # `/analyze` stores transcripts in the brain under ANALYZER_VERSIONS; if it lagged,
    # it would keep serving the inflated v1 words the asr cache no longer does.
    assert ANALYZER_VERSIONS[AnalysisKind.TRANSCRIPTION] == asr.TRANSCRIPT_TIMING_VERSION
