"""Speech-to-text (ASR) via a local ``whisper-cli`` binary (plan H0.1).

WHY: transcription is the AI's "hearing" — captions, footage search, filler-word
cleanup, and hooks all depend on a real word-level transcript. This module owns
the **local, default** provider: whisper.cpp invoked as a subprocess (never a
Python binding — that would pull in per-platform native wheels). It is deliberately
thin and mirrors the existing ``analysis`` modules: a **pure JSON parser** (unit
testable with a fixture, no binary required) plus a thin subprocess wrapper that
takes an injectable runner so the whole path is testable offline.

## Non-negotiables (plan H0.1 / AGENTS.md invariant 6)

- **Never fabricate a transcript.** If the ``whisper-cli`` binary or the model
  file is missing, this module raises a typed, actionable error — it never
  invents words or interpolates fake timings.
- **Real per-word timestamps only.** We ask whisper.cpp for token-level offsets
  (``-ml 1 -sow --dtw <preset> -ojf``) and merge sub-word BPE tokens into whole
  words using the leading-space convention whisper.cpp's tokenizer uses — we do
  **not** split segment text on whitespace with interpolated timings.
- **Validated output.** Every merged word is constructed as a
  :class:`~framepilot_engine.timeline.models.TranscriptWord` (the Pydantic model
  shared with the timeline schema); a word that fails validation or has a
  degenerate (non-monotonic/zero-length) timing is repaired (clamped) or dropped,
  never emitted as-is.

## Model management

The professional default is the multilingual ``large-v3-turbo-q5_0`` model
(~548MiB), fetched via an **explicit** setup step (never a silent download on
first transcribe) and SHA256-verified before use. It is cached under a gitignored
app-data directory outside the project sandbox
(``~/.framepilot/models`` by default, overridable via
``FRAMEPILOT_ASR_MODEL_DIR``) — models are large, shared across projects, and are
not part of any single project's file tree.

The download is **streamed** chunk-by-chunk (never buffered whole in memory) and
reports real byte counts to an injectable progress callback, so a UI can show an
honest determinate progress bar instead of a spinner that sits on "Setting up…"
for a minute (AGENTS.md no-fake-progress invariant). :class:`AsrSetupTracker`
wraps that into a pollable, cancellable single-slot job for the service layer.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from framepilot_engine.media.ffmpeg import FFmpegNotFoundError, find_ffmpeg
from framepilot_engine.timeline.models import TranscriptWord

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Errors — typed and actionable; never fabricate a result (AGENTS.md invariant 6).
# ---------------------------------------------------------------------------


class AsrError(RuntimeError):
    """Base class for every ASR failure. Always carries an actionable message."""


class WhisperCliNotFoundError(AsrError):
    """The ``whisper-cli`` binary could not be located on PATH or via override."""


class AsrModelMissingError(AsrError):
    """The requested model is not present locally; the caller must run setup."""

    def __init__(self, model: str, expected_path: Path) -> None:
        super().__init__(
            f"ASR model {model!r} is not installed (expected at {expected_path}). "
            "Run the ASR setup step (POST /asr/setup or `framepilot engine setup-asr`) "
            "to download and verify it before transcribing."
        )
        self.model = model
        self.expected_path = expected_path


class AsrModelChecksumError(AsrError):
    """A downloaded model's SHA256 did not match the expected checksum."""


class AsrSetupCancelledError(AsrError):
    """Setup was cancelled by the caller before the download finished."""


class AsrSetupBusyError(AsrError):
    """A setup run was requested while another one is already in flight."""


class AsrTranscriptionError(AsrError):
    """The whisper-cli subprocess failed or produced no usable output."""


# ---------------------------------------------------------------------------
# Binary discovery — mirrors media.ffmpeg's find_ffmpeg/find_ffprobe pattern.
# ---------------------------------------------------------------------------

_WHISPER_CLI_ENV = "FRAMEPILOT_WHISPER_CLI"
_WHISPER_BINARY_NAMES = ("whisper-cli", "whisper-cpp", "main")


def find_whisper_cli() -> str:
    """Locate the ``whisper-cli`` binary (whisper.cpp CLI).

    Discovery order: an explicit ``FRAMEPILOT_WHISPER_CLI`` override, then
    ``whisper-cli``/``whisper-cpp``/``main`` on ``PATH`` (the names whisper.cpp has
    shipped its CLI under across versions/package managers, e.g. Homebrew's
    ``whisper-cpp`` formula installs ``whisper-cli``).

    :returns: An absolute path or bare command name runnable as whisper-cli.
    :raises WhisperCliNotFoundError: If no candidate binary is found anywhere.
    """
    import shutil

    override = os.environ.get(_WHISPER_CLI_ENV, "").strip()
    if override:
        return override
    for name in _WHISPER_BINARY_NAMES:
        found = shutil.which(name)
        if found:
            return found
    raise WhisperCliNotFoundError(
        "whisper-cli not found on PATH. Install whisper.cpp (e.g. `brew install "
        f"whisper-cpp` on macOS) or set {_WHISPER_CLI_ENV} to its path."
    )


def whisper_cli_available() -> bool:
    """True when a whisper-cli binary can be located (no subprocess run)."""
    try:
        find_whisper_cli()
    except WhisperCliNotFoundError:
        return False
    return True


# ---------------------------------------------------------------------------
# Model registry + local cache management
# ---------------------------------------------------------------------------

# `base.en` was a useful bootstrap model, but its 74M parameters are not an
# honest professional default: it misses names/lyrics, is English-only, and
# drifts more readily on long speech. The quantized multilingual large-v3-turbo
# model is materially more accurate while remaining practical on editor-class
# machines (~548 MiB rather than the full model's ~1.5 GiB).
DEFAULT_ASR_MODEL = "large-v3-turbo-q5_0"
_MODEL_DIR_ENV = "FRAMEPILOT_ASR_MODEL_DIR"


@dataclass(frozen=True)
class AsrModelSpec:
    """One downloadable whisper.cpp ggml model."""

    name: str
    url: str
    filename: str
    #: Expected SHA256 of the downloaded file — the value published as the LFS
    #: object id for this file in https://huggingface.co/ggerganov/whisper.cpp.
    #: Overridable per-model via ``FRAMEPILOT_ASR_<MODEL>_SHA256`` (dots/dashes
    #: uppercased to underscores) so a maintainer can correct it without a code
    #: change. A wrong checksum fails setup safely (closed) — verification only
    #: ever *rejects* a mismatch, it never accepts a corrupt/wrong model.
    sha256: str
    #: Published size of the download in bytes. Used only for display (so the UI
    #: can say "~141 MB download" before a byte is fetched, and can still show a
    #: determinate bar if the server omits ``Content-Length``) — never as a
    #: correctness check; :attr:`sha256` is the sole integrity gate.
    size_bytes: int


ASR_MODELS: dict[str, AsrModelSpec] = {
    "base.en": AsrModelSpec(
        name="base.en",
        url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
        filename="ggml-base.en.bin",
        sha256="a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        size_bytes=147964211,
    ),
    "large-v3-turbo-q5_0": AsrModelSpec(
        name="large-v3-turbo-q5_0",
        url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
        filename="ggml-large-v3-turbo-q5_0.bin",
        # Hugging Face's current X-Linked-ETag for the published binary.
        sha256="394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        size_bytes=574041195,
    ),
}

#: A SHA256 digest is exactly 64 hex characters. Checked rather than assumed: a
#: truncated 63-character literal shipped here once and turned every single
#: setup attempt into an unexplained checksum failure *after* a full ~141MB
#: download. Fail loudly and early on a malformed digest instead.
_SHA256_HEX = re.compile(r"[0-9a-fA-F]{64}")


def _checksum_env_var(model: str) -> str:
    return f"FRAMEPILOT_ASR_{model.upper().replace('.', '_').replace('-', '_')}_SHA256"


def expected_sha256(model: str) -> str:
    """Expected checksum for ``model``, honouring a per-model env override.

    :returns: The lowercased 64-character hex digest to verify a download against.
    :raises AsrError: If the configured digest is not a well-formed SHA256 — a
        malformed value can never match, so surfacing it up front beats letting
        a long download finish and fail verification for no visible reason.
    """
    spec = _spec_for(model)
    override = os.environ.get(_checksum_env_var(model), "").strip()
    digest = override or spec.sha256
    if not _SHA256_HEX.fullmatch(digest):
        source = f"{_checksum_env_var(model)} override" if override else "built-in model registry"
        raise AsrError(
            f"Expected SHA256 for ASR model {model!r} is malformed ({digest!r} from the "
            f"{source}): a SHA256 digest must be exactly 64 hex characters. Fix it before "
            "setup can verify a download."
        )
    return digest.lower()


def _spec_for(model: str) -> AsrModelSpec:
    spec = ASR_MODELS.get(model)
    if spec is None:
        raise AsrError(f"Unknown ASR model {model!r}. Known models: {sorted(ASR_MODELS)}.")
    return spec


def model_dir() -> Path:
    """The local cache directory models are stored under (outside any project).

    Defaults to ``~/.framepilot/models``; overridable via
    ``FRAMEPILOT_ASR_MODEL_DIR`` (e.g. for tests or a custom app-data location).
    """
    override = os.environ.get(_MODEL_DIR_ENV, "").strip()
    if override:
        return Path(override)
    return Path.home() / ".framepilot" / "models"


def model_path(model: str = DEFAULT_ASR_MODEL) -> Path:
    """Local path a given model would live at (whether or not it exists yet)."""
    return model_dir() / _spec_for(model).filename


def is_model_present(model: str = DEFAULT_ASR_MODEL) -> bool:
    """True when ``model``'s file exists locally (checksum not re-verified here —
    that only happens once, at :func:`setup_model` time, since re-hashing a large
    model on every transcribe call would be wasteful)."""
    return model_path(model).is_file()


@dataclass(frozen=True)
class ModelDownload:
    """One in-flight chunked model download."""

    #: Total body size when the server declared a ``Content-Length``, else ``None``.
    total_bytes: int | None
    #: The body, in chunks. Consumed exactly once.
    chunks: Iterator[bytes]


#: Opens a chunked download for a model URL as a context manager (so the socket
#: is always closed, including on a cancelled/failed read). Injectable so tests
#: never hit the network; the default is a small stdlib streaming HTTP GET.
StreamDownloader = Callable[[str], AbstractContextManager[ModelDownload]]

#: Reports download progress as ``(downloaded_bytes, total_bytes_or_None)``.
#: Called once before the first chunk (so a UI can render 0-of-N immediately)
#: and once per chunk thereafter. Only real byte counts are ever passed.
DownloadProgress = Callable[[int, int | None], None]

#: Returns True when the in-flight download should abort.
CancelCheck = Callable[[], bool]

#: Read size per chunk. 1MiB keeps peak memory flat and still gives ~140 progress
#: ticks across the default model — smooth enough for a progress bar without
#: making the callback hot.
_DOWNLOAD_CHUNK_BYTES = 1 << 20

#: Per-socket-operation timeout. Bounds a stalled connection without capping the
#: total download time (a slow link legitimately takes minutes for ~141MB).
_DOWNLOAD_TIMEOUT_SECONDS = 60.0


@contextmanager
def _default_downloader(url: str) -> Iterator[ModelDownload]:  # pragma: no cover - network I/O
    import urllib.request

    with urllib.request.urlopen(url, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as response:
        declared = response.headers.get("Content-Length")
        total = int(declared) if declared is not None and declared.isdigit() else None
        yield ModelDownload(
            total_bytes=total,
            chunks=iter(lambda: response.read(_DOWNLOAD_CHUNK_BYTES), b""),
        )


def setup_model(
    model: str = DEFAULT_ASR_MODEL,
    *,
    downloader: StreamDownloader | None = None,
    on_progress: DownloadProgress | None = None,
    is_cancelled: CancelCheck | None = None,
) -> Path:
    """Stream-download and SHA256-verify ``model`` into the local cache.

    Never called implicitly by :func:`transcribe` — the caller (CLI command or
    the ``/asr/setup`` service route) must invoke this deliberately, so a model
    is never silently fetched on first use.

    The body is written straight to a temp file and hashed incrementally, so a
    ~141MB model never sits in memory and verification costs nothing extra at
    the end.

    :param model: Model name (key into :data:`ASR_MODELS`).
    :param downloader: Injectable chunked fetcher; defaults to a stdlib HTTP GET.
    :param on_progress: Optional real-byte progress sink (see :data:`DownloadProgress`).
    :param is_cancelled: Optional abort predicate, polled once per chunk.
    :returns: The path the verified model was written to.
    :raises AsrModelChecksumError: If the download fails checksum verification —
        the corrupt/wrong download is discarded, never written to the cache
        location under its real name.
    :raises AsrSetupCancelledError: If ``is_cancelled`` went true mid-download;
        the partial file is discarded.
    """
    spec = _spec_for(model)
    # Resolved up front: a malformed digest is a configuration bug, and finding
    # it out only after a full download wastes minutes of the user's time.
    expected = expected_sha256(model)
    open_download = downloader or _default_downloader

    target_dir = model_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / spec.filename

    _log.info("ACT asr setup: downloading model %r from %s", model, spec.url)
    # Write to a temp file in the same directory then atomically rename, so a
    # crash/interrupt/cancel mid-write never leaves a half-written file that
    # `is_model_present` would wrongly report as installed.
    fd, tmp_name_str = tempfile.mkstemp(dir=target_dir, prefix=f".{spec.filename}.")
    tmp_path = Path(tmp_name_str)
    digest = hashlib.sha256()
    downloaded = 0
    try:
        with os.fdopen(fd, "wb") as fh, open_download(spec.url) as download:
            # Fall back to the published size when the server declares none, so the
            # UI still gets a determinate bar. Both are real figures, never guesses.
            total = download.total_bytes if download.total_bytes is not None else spec.size_bytes
            if on_progress is not None:
                on_progress(0, total)
            for chunk in download.chunks:
                if is_cancelled is not None and is_cancelled():
                    raise AsrSetupCancelledError(
                        f"Setup of ASR model {model!r} was cancelled after "
                        f"{downloaded} of {total} bytes. Nothing was installed."
                    )
                fh.write(chunk)
                digest.update(chunk)
                downloaded += len(chunk)
                if on_progress is not None:
                    on_progress(downloaded, total)

        actual = digest.hexdigest()
        if actual != expected:
            raise AsrModelChecksumError(
                f"Downloaded model {model!r} failed checksum verification "
                f"(expected {expected}, got {actual}). Discarding; the model was NOT "
                "installed."
            )
        tmp_path.replace(target)
    finally:
        tmp_path.unlink(missing_ok=True)
    _log.info(
        "ACT asr setup: model %r verified (%d bytes) and installed at %s",
        model,
        downloaded,
        target,
    )
    return target


@dataclass(frozen=True)
class AsrStatus:
    """Local ASR readiness (binary + default model), for a settings/status UI."""

    binary_available: bool
    binary_path: str | None
    model: str
    model_present: bool
    model_path: str
    #: Published download size of ``model``, so a UI can warn "~141 MB download"
    #: *before* the user commits to setup rather than after it has started.
    download_size_bytes: int


def get_status(model: str = DEFAULT_ASR_MODEL) -> AsrStatus:
    """Report local whisper-cli + model availability without running anything."""
    try:
        binary_path = find_whisper_cli()
        binary_available = True
    except WhisperCliNotFoundError:
        binary_path = None
        binary_available = False
    return AsrStatus(
        binary_available=binary_available,
        binary_path=binary_path,
        model=model,
        model_present=is_model_present(model),
        model_path=str(model_path(model)),
        download_size_bytes=_spec_for(model).size_bytes,
    )


# ---------------------------------------------------------------------------
# Pollable, cancellable setup job (one at a time)
# ---------------------------------------------------------------------------


class AsrSetupState(StrEnum):
    """Lifecycle of the current (or most recent) :func:`setup_model` run.

    Deliberately has no separate "verifying"/"installing" state: the digest is
    computed incrementally while downloading and the install is an atomic
    rename, so both are instantaneous. Inventing phases the user appears to wait
    on would be fake progress.
    """

    IDLE = "idle"
    DOWNLOADING = "downloading"
    INSTALLED = "installed"
    CANCELLED = "cancelled"
    ERROR = "error"


@dataclass(frozen=True)
class AsrSetupProgress:
    """A point-in-time snapshot of the setup job, safe to serialise and poll."""

    state: AsrSetupState
    model: str
    downloaded_bytes: int
    total_bytes: int | None
    error: str | None


_IDLE_PROGRESS = AsrSetupProgress(
    state=AsrSetupState.IDLE,
    model=DEFAULT_ASR_MODEL,
    downloaded_bytes=0,
    total_bytes=None,
    error=None,
)


class AsrSetupTracker:
    """Runs :func:`setup_model` as a single-slot job that can be polled + cancelled.

    WHY: the download takes tens of seconds to minutes. The HTTP caller cannot
    read progress out of a request it is still awaiting, so the run publishes
    live byte counts here and a separate poll route reads them. Single-slot on
    purpose — two concurrent downloads of the same model would race on the same
    target path for no benefit.

    Thread-safe: :meth:`run` executes on a worker thread while :meth:`snapshot`
    and :meth:`cancel` are called from the event loop.
    """

    def __init__(self, *, downloader: StreamDownloader | None = None) -> None:
        """:param downloader: Injectable chunked fetcher passed through to
        :func:`setup_model`; defaults to the real streaming HTTP GET.
        """
        self._downloader = downloader
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._progress = _IDLE_PROGRESS

    def snapshot(self) -> AsrSetupProgress:
        """The current progress record (frozen — safe to read from any thread)."""
        with self._lock:
            return self._progress

    def is_running(self) -> bool:
        """True while a download is in flight."""
        with self._lock:
            return self._progress.state is AsrSetupState.DOWNLOADING

    def cancel(self) -> bool:
        """Request cancellation of an in-flight download.

        :returns: True if a run was in flight to cancel, False if idle — in which
            case nothing happens; cancelling nothing is not an error.
        """
        with self._lock:
            if self._progress.state is not AsrSetupState.DOWNLOADING:
                return False
        self._cancel.set()
        _log.info("ACT asr setup: cancellation requested")
        return True

    def run(self, model: str = DEFAULT_ASR_MODEL) -> Path:
        """Download + verify ``model``, publishing progress for pollers.

        Blocking — call it from a worker thread, never the event loop.

        :returns: The path the verified model was installed to.
        :raises AsrSetupBusyError: If another run is already in flight.
        :raises AsrError: Whatever :func:`setup_model` raises, after recording it
            in the snapshot so a poller sees the same message the caller got.
        """
        with self._lock:
            if self._progress.state is AsrSetupState.DOWNLOADING:
                raise AsrSetupBusyError(
                    f"Setup of ASR model {self._progress.model!r} is already running. "
                    "Wait for it to finish, or cancel it first."
                )
            self._cancel.clear()
            self._progress = AsrSetupProgress(
                state=AsrSetupState.DOWNLOADING,
                model=model,
                downloaded_bytes=0,
                total_bytes=None,
                error=None,
            )

        def publish(downloaded: int, total: int | None) -> None:
            with self._lock:
                # Ignore a late callback from a run that already terminated —
                # never resurrect a finished job back into DOWNLOADING.
                if self._progress.state is not AsrSetupState.DOWNLOADING:
                    return
                self._progress = replace(
                    self._progress, downloaded_bytes=downloaded, total_bytes=total
                )

        try:
            path = setup_model(
                model,
                downloader=self._downloader,
                on_progress=publish,
                is_cancelled=self._cancel.is_set,
            )
        except AsrSetupCancelledError:
            self._finish(replace(self.snapshot(), state=AsrSetupState.CANCELLED))
            raise
        except AsrError as exc:
            self._finish(replace(self.snapshot(), state=AsrSetupState.ERROR, error=str(exc)))
            raise
        self._finish(replace(self.snapshot(), state=AsrSetupState.INSTALLED))
        return path

    def _finish(self, progress: AsrSetupProgress) -> None:
        with self._lock:
            self._progress = progress
        self._cancel.clear()


# ---------------------------------------------------------------------------
# Pure whisper-cli JSON parsing (unit testable without the binary)
# ---------------------------------------------------------------------------


#: whisper.cpp's special/control tokens look like `[_BEG_]`, `[_TT_123]`, or the
#: GPT-style `<|...|>` markers — never real words, always dropped.
def _is_special_token(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    if stripped.startswith("[_") and stripped.endswith("]"):
        return True
    return stripped.startswith("<|") and stripped.endswith("|>")


#: Minimum word duration (seconds) a clamped/repaired entry is given when the
#: reported end time does not exceed its start — never zero-length, never
#: negative, but small enough to stay honest about a near-instant utterance.
_MIN_WORD_DURATION_SECONDS = 0.01


def _token_offsets_seconds(token: dict[str, Any]) -> tuple[float, float] | None:
    offsets = token.get("offsets")
    if not isinstance(offsets, dict):
        return None
    t_from, t_to = offsets.get("from"), offsets.get("to")
    if not isinstance(t_from, (int, float)) or not isinstance(t_to, (int, float)):
        return None
    return float(t_from) / 1000.0, float(t_to) / 1000.0


def _merge_tokens_to_words(tokens: list[dict[str, Any]]) -> list[tuple[str, float, float]]:
    """Merge whisper.cpp sub-word BPE tokens into whole words (pure).

    whisper.cpp tokens carry a **leading space** on the first sub-token of a new
    word (the GPT-2/BPE convention); a token with no leading space is a
    continuation of the previous word. We never split on ASCII whitespace in the
    *rendered* text — only on this token-boundary convention, so an apostrophe or
    a hyphenated sub-word token stays attached to its word.
    """
    words: list[tuple[str, float, float]] = []
    current_text = ""
    current_start: float | None = None
    current_end: float | None = None

    def flush() -> None:
        nonlocal current_text, current_start, current_end
        stripped = current_text.strip()
        if stripped and current_start is not None and current_end is not None:
            words.append((stripped, current_start, current_end))
        current_text = ""
        current_start = None
        current_end = None

    for token in tokens:
        raw_text = token.get("text")
        if not isinstance(raw_text, str) or _is_special_token(raw_text):
            continue
        offsets = _token_offsets_seconds(token)
        if offsets is None:
            continue
        start_s, end_s = offsets
        starts_new_word = raw_text.startswith(" ") or current_text == ""
        if starts_new_word and current_text:
            flush()
        current_text += raw_text
        current_start = start_s if current_start is None else current_start
        current_end = end_s
    flush()
    return words


def _clamp_monotonic(
    entries: list[tuple[str, float, float]],
) -> list[TranscriptWord]:
    """Repair non-monotonic/zero-duration timings; drop entries that fail
    validation even after repair, rather than emit bad data (never fabricate)."""
    result: list[TranscriptWord] = []
    prev_end = 0.0
    for word, start, end in entries:
        clamped_start = max(start, prev_end, 0.0)
        clamped_end = end if end > clamped_start else clamped_start + _MIN_WORD_DURATION_SECONDS
        try:
            transcript_word = TranscriptWord(
                word=word, start=round(clamped_start, 3), end=round(clamped_end, 3)
            )
        except ValidationError as exc:  # pragma: no cover - defensive, schema is permissive
            _log.warning("Dropping unvalidatable transcript word %r: %s", word, exc)
            continue
        result.append(transcript_word)
        prev_end = transcript_word.end
    return result


def parse_whisper_json(data: dict[str, Any]) -> list[TranscriptWord]:
    """Reduce whisper-cli's ``--output-json-full`` document to word-level
    :class:`TranscriptWord` entries (pure — no filesystem/subprocess access).

    Requires token-level detail (``tokens`` per segment, from ``-ojf``) to build
    honest per-word timestamps. A segment with no token detail is skipped when it
    contains more than one word — we will not fabricate per-word timing by
    interpolating across a multi-word segment; a single-word segment's own
    offsets are used directly since no interpolation is needed.
    """
    segments = data.get("transcription")
    if not isinstance(segments, list):
        return []
    entries: list[tuple[str, float, float]] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        tokens = segment.get("tokens")
        if isinstance(tokens, list) and tokens:
            entries.extend(_merge_tokens_to_words(tokens))
            continue
        text = str(segment.get("text", "")).strip()
        if text and len(text.split()) == 1:
            offsets = segment.get("offsets")
            if isinstance(offsets, dict):
                t_from, t_to = offsets.get("from"), offsets.get("to")
                if isinstance(t_from, (int, float)) and isinstance(t_to, (int, float)):
                    entries.append((text, float(t_from) / 1000.0, float(t_to) / 1000.0))
    return _clamp_monotonic(entries)


# ---------------------------------------------------------------------------
# Subprocess orchestration (thin; injectable so tests never need real binaries)
# ---------------------------------------------------------------------------

#: Runs a full argv to completion, raising :class:`AsrTranscriptionError` on a
#: non-zero exit, timeout, or missing binary. Returns nothing — every command
#: this module runs (ffmpeg extraction, whisper-cli) writes its result to a file
#: rather than stdout, so there is nothing to capture.
SubprocessRunner = Callable[[Sequence[str], float | None], None]


def _default_runner(argv: Sequence[str], timeout: float | None) -> None:
    try:
        completed = subprocess.run(list(argv), capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise AsrTranscriptionError(f"Binary not found: {argv[0]!r}") from exc
    except subprocess.TimeoutExpired as exc:
        raise AsrTranscriptionError(f"Timed out after {timeout}s: {argv[0]!r}") from exc
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        raise AsrTranscriptionError(
            f"{argv[0]!r} exited {completed.returncode}: {stderr or '<no stderr>'}"
        )


#: whisper.cpp DTW word-timestamp preset to pass to `--dtw`. Quantization does
#: not change the alignment-head layout, so the q5 model uses the upstream
#: `large.v3.turbo` preset.
_DTW_PRESETS: dict[str, str] = {
    "base.en": "base.en",
    "large-v3-turbo-q5_0": "large.v3.turbo",
}


def _prepare_mono16k_wav(
    media_path: Path, out_path: Path, *, run: SubprocessRunner, timeout: float | None
) -> None:
    """Extract mono 16kHz PCM WAV via ffmpeg — the input format whisper.cpp expects."""
    argv = [
        find_ffmpeg(),
        "-y",
        "-i",
        str(media_path),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        str(out_path),
    ]
    run(argv, timeout)


def extract_mono16k_wav(
    media_path: Path,
    *,
    run: SubprocessRunner | None = None,
    timeout: float | None = 300.0,
) -> bytes:
    """Decode ``media_path``'s audio to a mono 16 kHz PCM WAV and return its bytes.

    WHY this is a public helper: the hosted ASR providers (groq/nvidia) run in the
    desktop host, not the engine — their API keys never reach the sidecar. But long
    audio must be split into fixed windows before upload, and the only place that can
    decode arbitrary media is the engine. So the engine returns the canonical PCM WAV
    (linear samples, sliceable on a frame boundary without re-encoding) and the host
    chunks + uploads it itself. Same ffmpeg prep the local whisper path uses.

    :raises AsrTranscriptionError: if ffmpeg is unavailable or the decode fails.
    """
    runner = run or _default_runner
    with tempfile.TemporaryDirectory(prefix="framepilot-asr-prep-") as tmp:
        wav_path = Path(tmp) / "audio.wav"
        try:
            _prepare_mono16k_wav(media_path, wav_path, run=runner, timeout=timeout)
        except FFmpegNotFoundError as exc:
            raise AsrTranscriptionError(f"ffmpeg unavailable for ASR audio prep: {exc}") from exc
        return wav_path.read_bytes()


def transcribe_local(
    media_path: Path,
    *,
    model: str = DEFAULT_ASR_MODEL,
    run: SubprocessRunner | None = None,
    timeout: float | None = 300.0,
) -> list[TranscriptWord]:
    """Transcribe ``media_path`` with the local whisper-cli binary.

    Honest-unavailable by construction: raises :class:`WhisperCliNotFoundError`
    when the binary is missing and :class:`AsrModelMissingError` when the model
    has not been set up — it never falls back to a fabricated transcript.

    :param media_path: Already sandbox-resolved media file to transcribe.
    :param model: Model name (must already be installed via :func:`setup_model`).
    :param run: Injectable subprocess runner (tests supply a fake).
    :param timeout: Per-subprocess timeout in seconds (bounds ffmpeg + whisper-cli).
    :returns: Word-level transcript entries in chronological order.
    :raises WhisperCliNotFoundError: If the binary cannot be located.
    :raises AsrModelMissingError: If the model is not installed locally.
    :raises AsrTranscriptionError: If ffmpeg/whisper-cli fail or produce no output.
    """
    whisper_cli = find_whisper_cli()
    model_file = model_path(model)
    if not model_file.exists():
        raise AsrModelMissingError(model, model_file)
    runner = run or _default_runner

    with tempfile.TemporaryDirectory(prefix="framepilot-asr-") as tmp:
        tmp_dir = Path(tmp)
        wav_path = tmp_dir / "audio.wav"
        try:
            _prepare_mono16k_wav(media_path, wav_path, run=runner, timeout=timeout)
        except FFmpegNotFoundError as exc:
            raise AsrTranscriptionError(f"ffmpeg unavailable for ASR audio prep: {exc}") from exc

        out_prefix = tmp_dir / "transcript"
        dtw_preset = _DTW_PRESETS.get(model, model)
        argv = [
            whisper_cli,
            "-m",
            str(model_file),
            "-f",
            str(wav_path),
            "-ml",
            "1",
            "-sow",
            "--dtw",
            dtw_preset,
            # Multilingual auto-detection is required for the professional
            # model; base.en safely resolves to English. Suppressing non-speech
            # tokens reduces hallucinated text over music beds/leading silence.
            "-l",
            "auto",
            "-sns",
            "-ojf",
            "-of",
            str(out_prefix),
            "-np",
        ]
        runner(argv, timeout)

        json_path = out_prefix.with_suffix(".json")
        if not json_path.is_file():
            raise AsrTranscriptionError(
                f"whisper-cli did not produce the expected JSON output at {json_path}."
            )
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AsrTranscriptionError(f"Failed to read whisper-cli output: {exc}") from exc

    return parse_whisper_json(data)


# ---------------------------------------------------------------------------
# Content-hash cache (plan H0.1 invariant 11: results are content-hash cached)
# ---------------------------------------------------------------------------

_CACHE_DIR_ENV = "FRAMEPILOT_ASR_CACHE_DIR"


def cache_dir() -> Path:
    """Directory transcription results are memoized under (outside any project)."""
    override = os.environ.get(_CACHE_DIR_ENV, "").strip()
    if override:
        return Path(override)
    return model_dir().parent / "asr-cache"


def _content_hash(media_path: Path, model: str, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    digest.update(model.encode("utf-8"))
    with media_path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def transcribe(
    media_path: Path,
    *,
    model: str = DEFAULT_ASR_MODEL,
    run: SubprocessRunner | None = None,
    timeout: float | None = 300.0,
    use_cache: bool = True,
) -> list[TranscriptWord]:
    """Content-hash-cached wrapper over :func:`transcribe_local`.

    Re-transcribing the same file with the same model is common (retries,
    re-imports, repeated dev/test runs) and whisper.cpp is comparatively slow —
    memoizing by a hash of (model, file bytes) avoids redundant work, per the
    plan's "model results are content-hash cached" invariant.
    """
    if not use_cache:
        return transcribe_local(media_path, model=model, run=run, timeout=timeout)

    key = _content_hash(media_path, model)
    cache_file = cache_dir() / f"{key}.json"
    if cache_file.is_file():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            return [TranscriptWord.model_validate(w) for w in cached]
        except (OSError, json.JSONDecodeError, ValidationError):
            _log.warning("Discarding unreadable ASR cache entry %s", cache_file)

    words = transcribe_local(media_path, model=model, run=run, timeout=timeout)
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps([w.model_dump() for w in words]), encoding="utf-8")
    except OSError as exc:  # pragma: no cover - cache write is best-effort
        _log.warning("Failed to write ASR cache entry %s: %s", cache_file, exc)
    return words
