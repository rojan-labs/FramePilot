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
- **Real per-word timestamps only.** We ask whisper.cpp for token-level timing
  (``-ml 1 -sow --dtw <preset> -nfa -ojf``) and merge sub-word BPE tokens into whole
  words using the leading-space convention whisper.cpp's tokenizer uses — we do
  **not** split segment text on whitespace with interpolated timings. Word times
  come from the DTW alignment points (``t_dtw``), which need flash attention off
  (``-nfa``); whisper.cpp's heuristic ``offsets`` pad non-speech into neighbouring
  tokens and are only a fallback. Either way a word's end is capped relative to the
  transcript's median word duration (openai-whisper's rule), so a padded span can
  never pass for speech, and punctuation-only tokens are never words.
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
import statistics
import subprocess
import sys
import tempfile
import threading
import unicodedata
from collections.abc import Callable, Iterator, Sequence
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from framepilot_engine.media.ffmpeg import FFmpegError, FFmpegNotFoundError, find_ffmpeg
from framepilot_engine.media.probe import inspect_media
from framepilot_engine.subprocess_safety import validate_safe_argv
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


class AsrNoAudioError(AsrError):
    """The media carries no audio stream, so there is nothing to transcribe."""


# ---------------------------------------------------------------------------
# Binary discovery — mirrors media.ffmpeg's find_ffmpeg/find_ffprobe pattern.
# ---------------------------------------------------------------------------

_WHISPER_CLI_ENV = "FRAMEPILOT_WHISPER_CLI"
_WHISPER_BINARY_NAMES = ("whisper-cli", "whisper-cpp", "main")


def _running_packaged() -> bool:
    """True when this engine process is the PyInstaller-bundled binary.

    PyInstaller sets ``sys.frozen`` on the frozen executable (the same signal
    :mod:`framepilot_engine.brain.vector_store` already uses for its bundled
    ``_MEIPASS`` data lookup) — no separate env var is needed, and unlike an
    env var it cannot be left unset by an out-of-date spawn path.
    """
    return bool(getattr(sys, "frozen", False))


def find_whisper_cli() -> str:
    """Locate the ``whisper-cli`` binary (whisper.cpp CLI).

    Discovery order: an explicit ``FRAMEPILOT_WHISPER_CLI`` override (set by
    the desktop app either from an installed ``framepilot.local-whisper``
    Capability Pack or an explicit host-chosen path — see
    ``apps/desktop/electron/capability-packs/service.ts``), then, **in dev
    only**, ``whisper-cli``/``whisper-cpp``/``main`` on ``PATH`` (the names
    whisper.cpp has shipped its CLI under across versions/package managers,
    e.g. Homebrew's ``whisper-cpp`` formula installs ``whisper-cli``).

    A packaged sidecar never searches ``PATH``: ``docs/api/capability-packs.md``
    documents that the bundled sidecar "never opportunistically adopts a
    colocated whisper-cli", and a PATH hit there would be an unreviewed,
    unversioned binary running against user media outside the signed-pack
    trust chain the rest of local transcription goes through.

    :returns: An absolute path or bare command name runnable as whisper-cli.
    :raises WhisperCliNotFoundError: If no candidate binary is found anywhere.
    """
    import shutil

    override = os.environ.get(_WHISPER_CLI_ENV, "").strip()
    if override:
        return override
    if _running_packaged():
        raise WhisperCliNotFoundError(
            "No local transcription is installed. Install the "
            "framepilot.local-whisper Capability Pack (Settings → AI → Local "
            "transcription), or choose a hosted transcription provider in "
            "Settings → AI."
        )
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
def _complete_utf8(text: str) -> str:
    """Rejoin a word's raw token bytes into characters, dropping any left incomplete.

    Whisper JSON is read with ``surrogateescape`` (see :func:`transcribe_local`), so the
    bytes of a character split across two tokens arrive as escaped surrogates and are
    whole again once the word's tokens are concatenated. A fragment whose remaining
    bytes whisper never emitted (it restarts decoding mid-character) cannot be any
    character, so it is dropped rather than shown as a replacement glyph.
    """
    return text.encode("utf-8", "surrogateescape").decode("utf-8", "ignore")


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

#: whisper.cpp writes token ``offsets`` in milliseconds.
_OFFSET_UNITS_PER_SECOND = 1000.0

#: whisper.cpp writes a token's ``t_dtw`` in centiseconds (one DTW step is 20 ms of audio,
#: so values are even); ``-1`` means no DTW point was computed for that token.
_DTW_UNITS_PER_SECOND = 100.0

#: The median word duration is capped here before it sizes the longest word allowed.
#: Value and rule are openai-whisper's ``add_word_timestamps`` (``timing.py``):
#: ``median_duration = min(0.7, median)``. The cap keeps a transcript made mostly of
#: non-speech-padded words (radio calls over jet noise) from licensing long words: its
#: own median would be inflated by the very padding the cap exists to remove.
_MEDIAN_WORD_DURATION_CAP_SECONDS = 0.7

#: A word may last at most this many median word durations — openai-whisper's
#: ``max_duration = median_duration * 2``.
_MAX_WORD_DURATION_IN_MEDIANS = 2.0

#: Unicode general-category prefixes that make a character part of a word: letters (L*),
#: numbers (N*) and combining marks (M*). Marks count because a Devanagari vowel sign or
#: virama is category M yet belongs to the syllable it modifies; classifying it as
#: punctuation would cut a Hindi word's timing short at its last letter.
_WORD_CATEGORY_PREFIXES = frozenset({"L", "N", "M"})

#: ``surrogateescape`` (how whisper JSON is read, see :func:`transcribe_local`) maps each
#: undecodable byte to U+DC80..U+DCFF. A token holding such bytes carries part of a
#: multi-byte character that only becomes whole once the word's tokens are joined.
_ESCAPED_BYTE_RANGE = ("\udc80", "\udcff")


def _token_offsets_seconds(token: dict[str, Any]) -> tuple[float, float] | None:
    offsets = token.get("offsets")
    if not isinstance(offsets, dict):
        return None
    t_from, t_to = offsets.get("from"), offsets.get("to")
    if not isinstance(t_from, (int, float)) or not isinstance(t_to, (int, float)):
        return None
    return float(t_from) / _OFFSET_UNITS_PER_SECOND, float(t_to) / _OFFSET_UNITS_PER_SECOND


def _token_dtw_seconds(token: dict[str, Any]) -> float | None:
    """The token's DTW point in seconds, or ``None`` when whisper.cpp computed none.

    ``None`` covers ``t_dtw == -1`` (DTW off, e.g. under flash attention), a missing key
    (a whisper.cpp build that predates DTW), and anything non-numeric.
    """
    raw = token.get("t_dtw")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw < 0:
        return None
    return float(raw) / _DTW_UNITS_PER_SECOND


def _has_word_character(text: str) -> bool:
    """True when ``text`` holds a letter, digit or combining mark in any script."""
    return any(unicodedata.category(char)[0] in _WORD_CATEGORY_PREFIXES for char in text)


def _carries_escaped_bytes(text: str) -> bool:
    low, high = _ESCAPED_BYTE_RANGE
    return any(low <= char <= high for char in text)


@dataclass(frozen=True)
class _Token:
    """One whisper.cpp text token with both of the timings whisper.cpp reports."""

    #: Raw token text; may carry surrogate-escaped bytes of a split character.
    text: str
    #: whisper.cpp's heuristic span. It pads non-speech into the neighbouring token, so
    #: it is only a fallback: on the X-59 radio calls ``" ."`` spanned 0.02-24.96 s.
    start: float
    end: float
    #: Where DTW alignment enters this token (its start), or ``None`` without DTW.
    dtw: float | None
    #: Carries a letter/digit/mark, or a byte fragment of a (nearly always) letter.
    is_content: bool


@dataclass(frozen=True)
class _RawWord:
    """Tokens grouped into one word by whisper.cpp's leading-space convention."""

    tokens: tuple[_Token, ...]
    #: The word's text with split characters rejoined; may be punctuation-only or empty.
    text: str

    def content_indices(self) -> list[int]:
        return [index for index, token in enumerate(self.tokens) if token.is_content]


@dataclass(frozen=True)
class _TimedWord:
    """A real word with its uncapped timing and what the duration cap is measured from."""

    text: str
    start: float
    end: float
    #: Start of the word's last content token. Only the stretch after it is unmeasured
    #: by the token timings, so the cap is anchored here, not at the word's start.
    anchor: float
    content_tokens: int
    #: Whether the start is a DTW point (else whisper.cpp's heuristic offset).
    dtw_timed: bool


def _parse_token(token: object) -> _Token | None:
    if not isinstance(token, dict):
        return None
    raw_text = token.get("text")
    if not isinstance(raw_text, str) or _is_special_token(raw_text):
        return None
    offsets = _token_offsets_seconds(token)
    if offsets is None:
        return None
    return _Token(
        text=raw_text,
        start=offsets[0],
        end=offsets[1],
        dtw=_token_dtw_seconds(token),
        is_content=_carries_escaped_bytes(raw_text) or _has_word_character(raw_text),
    )


def _group_segment_tokens(tokens: list[Any]) -> list[_RawWord]:
    """Group one segment's tokens into words (pure).

    whisper.cpp tokens carry a **leading space** on the first sub-token of a new
    word (the GPT-2/BPE convention); a token with no leading space is a
    continuation of the previous word. We never split on ASCII whitespace in the
    *rendered* text — only on this token-boundary convention, so an apostrophe or
    a hyphenated sub-word token stays attached to its word. A segment's first token
    always opens a word: scripts written without spaces (CJK) would otherwise merge
    every segment of a transcript into one.
    """
    groups: list[list[_Token]] = []
    for raw in tokens:
        token = _parse_token(raw)
        if token is None:
            continue
        if token.text.startswith(" ") or not groups:
            groups.append([token])
        else:
            groups[-1].append(token)
    return [
        _RawWord(tokens=tuple(group), text=_complete_utf8("".join(t.text for t in group)).strip())
        for group in groups
    ]


def _tokenless_segment_word(segment: dict[str, Any]) -> _RawWord | None:
    """A segment without token detail, used only when it holds exactly one word.

    We will not fabricate per-word timing by interpolating across a multi-word segment;
    a single-word segment needs no interpolation, so its own offsets are used directly.
    """
    text = _complete_utf8(str(segment.get("text", ""))).strip()
    if not text or len(text.split()) != 1:
        return None
    offsets = _token_offsets_seconds(segment)
    if offsets is None:
        return None
    token = _Token(
        text=text, start=offsets[0], end=offsets[1], dtw=None, is_content=_has_word_character(text)
    )
    return _RawWord(tokens=(token,), text=text)


def _is_real_word(word: _RawWord) -> bool:
    """A token group with a letter/digit/mark — anything else is punctuation, not a word."""
    return _has_word_character(word.text) and bool(word.content_indices())


def _end_boundary_dtw(words: Sequence[_RawWord], index: int, anchor: float) -> float | None:
    """Where alignment leaves word ``index``'s speech: the next token's DTW point.

    That is openai-whisper's ``end_times = jump_times[word_boundaries[1:]]``, where
    punctuation is an alignment unit of its own: the token after the last content token
    — a trailing punctuation token, a punctuation-only group, or the next word — starts
    where this word's speech stops. On the X-59 file ``" Copy"`` (DTW 33.94) is followed
    by ``"."`` at 34.54 and by the next word only at 44.76.

    A punctuation boundary aligned at or before the word's last content token measures
    nothing (DTW gave the word zero frames: ``" One"`` and its ``","`` both at 130.36),
    so the next boundary is tried; the next real word's start is the last candidate and
    is taken as is. ``None`` when a boundary token has no DTW point or nothing follows.
    """
    word = words[index]
    last_content = word.content_indices()[-1]
    boundaries = [token.dtw for token in word.tokens[last_content + 1 :]]
    for following in words[index + 1 :]:
        if _is_real_word(following):
            boundaries.append(following.tokens[0].dtw)
            break
        boundaries.extend(token.dtw for token in following.tokens)
    for position, point in enumerate(boundaries):
        is_last = position == len(boundaries) - 1
        if point is None or point > anchor or is_last:
            return point
    return None


def _time_word(words: Sequence[_RawWord], index: int) -> _TimedWord:
    """Uncapped timing for one real word: DTW when whisper.cpp computed it, else heuristic."""
    word = words[index]
    content = word.content_indices()
    first, last = word.tokens[content[0]], word.tokens[content[-1]]
    if first.dtw is not None:
        anchor = max(last.dtw if last.dtw is not None else first.dtw, first.dtw)
        boundary = _end_boundary_dtw(words, index, anchor)
        # No following DTW point (the transcript's last word, or a token whisper.cpp did
        # not align): the heuristic end is the only time whisper produced. The cap
        # applied afterwards bounds it like any other end.
        end = boundary if boundary is not None else word.tokens[-1].end
        return _TimedWord(
            text=word.text,
            start=first.dtw,
            end=end,
            anchor=anchor,
            content_tokens=len(content),
            dtw_timed=True,
        )
    start = word.tokens[0].start
    return _TimedWord(
        text=word.text,
        start=start,
        end=word.tokens[-1].end,
        anchor=max(last.start, start),
        content_tokens=len(content),
        dtw_timed=False,
    )


def _time_words(words: Sequence[_RawWord]) -> list[_TimedWord]:
    """Time every real word, folding punctuation-only "words" into their neighbours.

    A punctuation-only token group is no word: it is appended to the preceding word's
    text, keeping that word's timing (openai-whisper's ``merge_punctuations`` merges text
    and leaves timings alone), or dropped when nothing precedes it — the X-59 transcript
    opened with a ``" ."`` that whisper.cpp stretched over the first 25 seconds.
    Punctuation groups still bound the previous word's end via their DTW point.
    """
    timed: list[_TimedWord] = []
    for index, word in enumerate(words):
        if _is_real_word(word):
            timed.append(_time_word(words, index))
        elif word.text and timed:
            timed[-1] = replace(timed[-1], text=timed[-1].text + word.text)
    return timed


def _max_word_duration(words: Sequence[_TimedWord]) -> float | None:
    """Longest duration a word may have: twice the transcript's own median, median ≤ 0.7 s.

    openai-whisper computes the median over the non-zero word durations it aligned, and so
    do we, across the whole transcript. ``None`` when no word has a positive duration — a
    cap derived from nothing would only invent times.
    """
    durations = [word.end - word.start for word in words if word.end > word.start]
    if not durations:
        return None
    median = min(statistics.median(durations), _MEDIAN_WORD_DURATION_CAP_SECONDS)
    return median * _MAX_WORD_DURATION_IN_MEDIANS


def _cap_word_ends(words: Sequence[_TimedWord]) -> list[tuple[str, float, float]]:
    """Bound every word's end by the median-relative maximum duration (only shortens).

    openai-whisper truncates over-long words at sentence and segment boundaries, using
    segment timestamps to trim a word before a pause. whisper.cpp's per-word segments
    (``-ml 1``) take their timestamps from the same padded heuristic, so there is no
    independent segment end to trust: every word is capped instead. Two limits apply,
    both measured from times whisper produced:

    - the tail after the last content token's start is at most one maximum duration —
      for a one-token word that is openai-whisper's ``start + max_duration`` exactly,
      and a long multi-token word (or a CJK run, which has no spaces to split on) keeps
      the internal token boundaries alignment measured;
    - the whole word is at most one maximum duration per content token, which bounds
      the heuristic path too, where internal token spans are themselves padded.

    Starts are never moved: a DTW start is a measured point, and on the heuristic path
    nothing says which side of a padded span the speech is on.
    """
    max_duration = _max_word_duration(words)
    capped: list[tuple[str, float, float]] = []
    shortened = 0
    for word in words:
        end = word.end
        if max_duration is not None:
            tail_limit = word.anchor + max_duration
            token_limit = word.start + max_duration * word.content_tokens
            end = min(end, tail_limit, token_limit)
        shortened += end < word.end
        capped.append((word.text, word.start, end))
    _log.info(
        "ASR word timing: %d of %d words timed by DTW; %d ends capped (max word %s)",
        sum(1 for word in words if word.dtw_timed),
        len(words),
        shortened,
        "uncapped" if max_duration is None else f"{max_duration:.2f}s",
    )
    return capped


#: Longest repeating unit a hallucination loop is collapsed over. Long enough for a
#: whole hallucinated sentence, short enough that a repeated stanza of real speech
#: (a chant, a chorus) is not one "phrase".
_MAX_REPEAT_CYCLE_WORDS = 12
#: Consecutive repeats that mark a loop rather than emphasis.
_REPEAT_CYCLE_THRESHOLD = 5
#: How many copies survive, so the reader can still see what was said.
_REPEAT_CYCLES_KEPT = 2


def collapse_repeated_phrases(
    words: list[tuple[str, float, float]],
) -> list[tuple[str, float, float]]:
    """Collapse a whisper.cpp hallucination loop down to two copies (pure).

    whisper.cpp decoding can fall into a cycle on non-speech audio and emit the same
    phrase over and over with plausible timings. One captured project holds 2431 words
    of which "I'll try to follow you later." repeats 396 times in a row over wind-only
    GoPro audio; the agent read the transcript and called it unusable, correctly.

    A cycle of one to :data:`_MAX_REPEAT_CYCLE_WORDS` words repeating at least
    :data:`_REPEAT_CYCLE_THRESHOLD` times consecutively is treated as a loop; the first
    :data:`_REPEAT_CYCLES_KEPT` cycles are kept and the rest dropped. The shortest cycle
    that qualifies wins, so "no no no no no" collapses as a one-word loop rather than as
    a longer phrase that happens to contain it.

    WHY this is safe: real speech does not repeat an identical multi-word segment five
    times consecutively at word-boundary precision. The accepted cost is a genuine
    single word said five or more times in a row ("no no no no no") losing everything
    past the second copy — a small, visible loss against a transcript that is otherwise
    unusable for every downstream tool that reads it.

    Timings are untouched: entries are only dropped, never rewritten, so an already
    monotonic list stays monotonic.

    :param words: merged ``(text, start, end)`` word tuples, in order.
    :returns: the same tuples with the tail of each detected loop removed.
    """
    result: list[tuple[str, float, float]] = []
    total = len(words)
    index = 0
    while index < total:
        cycle_length = 0
        repeats = 0
        for length in range(1, _MAX_REPEAT_CYCLE_WORDS + 1):
            # Not enough words left for the threshold at this length, nor at any longer.
            if index + length * _REPEAT_CYCLE_THRESHOLD > total:
                break
            pattern = [word for word, _start, _end in words[index : index + length]]
            count = 1
            probe = index + length
            while (
                probe + length <= total
                and [word for word, _start, _end in words[probe : probe + length]] == pattern
            ):
                count += 1
                probe += length
            if count >= _REPEAT_CYCLE_THRESHOLD:
                cycle_length, repeats = length, count
                break
        if cycle_length == 0:
            result.append(words[index])
            index += 1
            continue
        kept = cycle_length * _REPEAT_CYCLES_KEPT
        result.extend(words[index : index + kept])
        dropped = (repeats - _REPEAT_CYCLES_KEPT) * cycle_length
        _log.warning(
            "Collapsed a repeated transcript phrase %r: %d consecutive repeats, %d words "
            "dropped (whisper.cpp hallucination loop)",
            " ".join(word for word, _start, _end in words[index : index + cycle_length]),
            repeats,
            dropped,
        )
        index += cycle_length * repeats
    return result


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

    Word timing (see :data:`TRANSCRIPT_TIMING_VERSION`): a word starts at the DTW point
    of its first content token and ends at the DTW point of the token that follows its
    last content token; without DTW points the heuristic ``offsets`` are used. Either
    way the end is then capped relative to the transcript's median word duration
    (:func:`_cap_word_ends`), and punctuation-only tokens never become words.
    """
    segments = data.get("transcription")
    if not isinstance(segments, list):
        return []
    raw_words: list[_RawWord] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        tokens = segment.get("tokens")
        if isinstance(tokens, list) and tokens:
            raw_words.extend(_group_segment_tokens(tokens))
            continue
        tokenless = _tokenless_segment_word(segment)
        if tokenless is not None:
            raw_words.append(tokenless)
    # Timed across the whole transcript, not per segment: with `-ml 1` every word is its
    # own segment, so a word's end (the next token's DTW point) and a punctuation
    # token's preceding word both live in neighbouring segments.
    timed = _time_words(raw_words)
    # The collapse runs after BOTH segment branches have contributed, so a loop that
    # spans a segment boundary (which the captured 396-repeat loop does) is seen as one
    # run of words.
    return _clamp_monotonic(collapse_repeated_phrases(_cap_word_ends(timed)))


# ---------------------------------------------------------------------------
# Subprocess orchestration (thin; injectable so tests never need real binaries)
# ---------------------------------------------------------------------------

#: Runs a full argv to completion, raising :class:`AsrTranscriptionError` on a
#: non-zero exit, timeout, or missing binary. Returns nothing — every command
#: this module runs (ffmpeg extraction, whisper-cli) writes its result to a file
#: rather than stdout, so there is nothing to capture.
SubprocessRunner = Callable[[Sequence[str], float | None], None]


def _default_runner(argv: Sequence[str], timeout: float | None) -> None:
    # Argument-injection gate (PRD §18): argv carries user-derived media/model
    # paths; validate shape before exec.
    args = validate_safe_argv(argv)
    try:
        completed = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise AsrTranscriptionError(f"Binary not found: {args[0]!r}") from exc
    except subprocess.TimeoutExpired as exc:
        raise AsrTranscriptionError(f"Timed out after {timeout}s: {args[0]!r}") from exc
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

#: whisper-cli's switch to turn flash attention off. DTW aligns tokens to audio from the
#: decoder's cross-attention weights, and flash attention never materializes those
#: weights, so with it on whisper.cpp silently skips DTW and writes ``t_dtw = -1`` for
#: every token. whisper.cpp 1.8+ enables flash attention by default (``-fa [true]``), so
#: ``--dtw`` alone measured nothing: on the X-59 B-roll 0 of 122 tokens carried a DTW
#: point; with this flag 129 of 129 did.
_NO_FLASH_ATTN_FLAG = "-nfa"

#: ``-nfa`` as a whole option in ``--help`` text, not as part of another option's name.
_NO_FLASH_ATTN_IN_HELP = re.compile(r"(?<![\w-])-nfa(?![\w-])")

#: Bound on ``whisper-cli --help``. It prints usage after loading its compute backends
#: (0.17 s measured); the bound only keeps a hung binary from stalling a transcription.
_HELP_PROBE_TIMEOUT_SECONDS = 15.0

#: Reads a whisper-cli binary's ``--help`` text, or ``None`` when the binary could not
#: be asked. Injectable so tests never run a binary.
HelpReader = Callable[[str], str | None]

_help_text_cache: dict[tuple[str, int | None], str] = {}
_help_text_cache_lock = threading.Lock()


def _run_whisper_help(binary: str) -> str | None:
    """Run ``binary --help`` and return what it printed (whisper-cli uses stderr)."""
    try:
        args = validate_safe_argv([binary, "--help"])
        completed = subprocess.run(
            args, capture_output=True, timeout=_HELP_PROBE_TIMEOUT_SECONDS, check=False
        )
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        _log.warning("Could not read %r --help to detect its options: %s", binary, exc)
        return None
    return (completed.stdout + completed.stderr).decode("utf-8", errors="replace")


def _binary_mtime_ns(binary: str) -> int | None:
    try:
        return Path(binary).stat().st_mtime_ns
    except OSError:
        return None


def _cached_whisper_help(binary: str) -> str | None:
    """``--help`` text for ``binary``, run once per binary path and modification time.

    Keyed by mtime as well as path so a Capability Pack upgraded in place is asked
    again rather than handed the old binary's answer. A failed probe is not cached: a
    timeout on a busy machine must not switch DTW off for the rest of the session.
    """
    key = (binary, _binary_mtime_ns(binary))
    with _help_text_cache_lock:
        cached = _help_text_cache.get(key)
    if cached is not None:
        return cached
    text = _run_whisper_help(binary)
    if text is not None:
        with _help_text_cache_lock:
            _help_text_cache[key] = text
    return text


def whisper_cli_supports_no_flash_attn(binary: str, *, read_help: HelpReader | None = None) -> bool:
    """True when ``binary`` accepts ``-nfa`` (disable flash attention).

    An older whisper-cli rejects an unknown option, so the flag is only passed when the
    binary's own ``--help`` lists it. Such a build predates default-on flash attention,
    so its DTW works without the flag. An unreadable ``--help`` answers False: omitting
    the flag can at worst lose DTW (the capped heuristic timing still applies), while
    passing an unknown one fails the whole transcription.

    :param binary: The whisper-cli path or command name.
    :param read_help: Injectable ``--help`` reader; defaults to a cached subprocess run.
    """
    help_text = (read_help or _cached_whisper_help)(binary)
    return help_text is not None and _NO_FLASH_ATTN_IN_HELP.search(help_text) is not None


#: whisper-cli seconds allowed per second of audio. Measured: large-v3-turbo-q5_0 took
#: 263 s for a 415 s voiceover on an M-series Mac (~0.63x real time) — with flash
#: attention on, so DTW was not actually running. ``-nfa`` roughly doubles whisper time
#: (200 s of X-59 audio on a busy M1 Pro: 14.1 s → 27.3 s), which puts that voiceover
#: near 1.2x real time; 2x still leaves room for a loaded or slower machine. A single
#: bound shared with the 60 s media-probe timeout killed every clip longer than about a
#: minute and a half.
WHISPER_SECONDS_PER_AUDIO_SECOND = 2.0

#: Lowest whisper-cli bound: model load and DTW setup cost the same for a 3 s clip.
WHISPER_MIN_TIMEOUT_SECONDS = 300.0

#: Bytes per second of the mono 16 kHz 16-bit PCM WAV :func:`_prepare_mono16k_wav` writes.
_MONO16K_BYTES_PER_SECOND = 16000 * 2

#: Size of the canonical RIFF/WAVE header ffmpeg writes before the samples.
_WAV_HEADER_BYTES = 44


def whisper_timeout_seconds(audio_seconds: float, *, floor: float | None = None) -> float:
    """The whisper-cli time bound for ``audio_seconds`` of audio (pure).

    Recognition time grows with the audio's length, so the bound does too; it is a
    ceiling for a hung process, not an estimate.

    :param audio_seconds: Length of the decoded audio.
    :param floor: A caller's own minimum (its configured media timeout), if any.
    :returns: Seconds — never below :data:`WHISPER_MIN_TIMEOUT_SECONDS` or ``floor``.
    """
    scaled = max(audio_seconds, 0.0) * WHISPER_SECONDS_PER_AUDIO_SECOND
    return max(WHISPER_MIN_TIMEOUT_SECONDS, floor or 0.0, scaled)


def _wav_duration_seconds(wav_path: Path) -> float:
    """Length of a mono 16 kHz PCM WAV written by :func:`_prepare_mono16k_wav`."""
    try:
        size = wav_path.stat().st_size
    except OSError:
        return 0.0
    return max(size - _WAV_HEADER_BYTES, 0) / _MONO16K_BYTES_PER_SECOND


def _prepare_mono16k_wav(
    media_path: Path, out_path: Path, *, run: SubprocessRunner, timeout: float | None
) -> None:
    """Extract mono 16kHz PCM WAV via ffmpeg — the input format whisper.cpp expects.

    :raises AsrNoAudioError: If the decode failed because there is no audio stream.
    """
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
    try:
        run(argv, timeout)
    except (FFmpegError, AsrTranscriptionError) as exc:
        # The production runner raises AsrTranscriptionError, not FFmpegError; catching only
        # the latter meant the classification below ran for test fakes and never for real,
        # and a video with no audio returned ffmpeg's whole version banner as its reason.
        raise _decode_failure(media_path, exc, timeout=timeout) from exc


def _decode_failure(path: Path, exc: Exception, *, timeout: float | None) -> Exception:
    """Classify a failed audio decode of ``path`` into the error worth reporting.

    A video with no audio track fails this decode with ffmpeg's whole banner followed by
    "Output file does not contain any stream", and that string was going back to the
    caller — and from there to the model — as the 422 body. It names no cause the caller
    can act on and does not say the one thing that is true: this file has no sound in it.
    A run asked to caption a silent screen recording was told to read a codec dump.

    `analysis/silence.py` already answers the identical case with a sentence, and this is
    the same classification against the same probe: ask ffprobe what streams exist, and
    only when it answers "no audio" replace the failure. Anything else — a corrupt file, a
    missing codec, an unreadable path — is a different fault and is returned untouched.

    :returns: An :class:`AsrNoAudioError` when the media has no audio, else ``exc``.
    """
    try:
        info = inspect_media(path, timeout=timeout)
    except (FFmpegError, FileNotFoundError):
        return exc
    if info.has_audio:
        return exc
    return AsrNoAudioError(
        f"{path.name} has no audio track, so there is nothing to transcribe. "
        "Transcribe an asset that carries sound, or add one to the project."
    )


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


def _whisper_argv(
    whisper_cli: str,
    *,
    model: str,
    model_file: Path,
    wav_path: Path,
    out_prefix: Path,
    read_help: HelpReader | None,
) -> list[str]:
    """The whisper-cli command line for one word-timed transcription (pure but for the probe)."""
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
        _DTW_PRESETS.get(model, model),
    ]
    if whisper_cli_supports_no_flash_attn(whisper_cli, read_help=read_help):
        argv.append(_NO_FLASH_ATTN_FLAG)
    else:
        _log.warning(
            "%s does not list %s; passing --dtw alone. Word times fall back to capped "
            "heuristic offsets if this build's flash attention suppresses DTW.",
            whisper_cli,
            _NO_FLASH_ATTN_FLAG,
        )
    argv += [
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
    return argv


def transcribe_local(
    media_path: Path,
    *,
    model: str = DEFAULT_ASR_MODEL,
    run: SubprocessRunner | None = None,
    timeout: float | None = 300.0,
    read_help: HelpReader | None = None,
) -> list[TranscriptWord]:
    """Transcribe ``media_path`` with the local whisper-cli binary.

    Honest-unavailable by construction: raises :class:`WhisperCliNotFoundError`
    when the binary is missing and :class:`AsrModelMissingError` when the model
    has not been set up — it never falls back to a fabricated transcript.

    :param media_path: Already sandbox-resolved media file to transcribe.
    :param model: Model name (must already be installed via :func:`setup_model`).
    :param run: Injectable subprocess runner (tests supply a fake).
    :param timeout: Timeout in seconds for the ffmpeg audio decode, and the floor of
        whisper-cli's own bound, which scales with the audio's length
        (:func:`whisper_timeout_seconds`).
    :param read_help: Injectable whisper-cli ``--help`` reader, used to detect ``-nfa``
        support (:func:`whisper_cli_supports_no_flash_attn`).
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
        argv = _whisper_argv(
            whisper_cli,
            model=model,
            model_file=model_file,
            wav_path=wav_path,
            out_prefix=out_prefix,
            read_help=read_help,
        )
        runner(argv, whisper_timeout_seconds(_wav_duration_seconds(wav_path), floor=timeout))

        json_path = out_prefix.with_suffix(".json")
        if not json_path.is_file():
            raise AsrTranscriptionError(
                f"whisper-cli did not produce the expected JSON output at {json_path}."
            )
        try:
            # whisper.cpp writes token text as raw bytes, and a token can end inside a
            # multi-byte character (Devanagari, CJK, emoji). A strict decode failed the
            # whole transcript on one such token; the bytes are kept here and rejoined
            # into characters when tokens are merged into words (`_complete_utf8`).
            data = json.loads(json_path.read_text(encoding="utf-8", errors="surrogateescape"))
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


#: Version of how whisper output becomes words and times. It salts the cache key, so a
#: change here re-transcribes instead of serving words parsed by the old rules.
#:
#: - 1: heuristic ``offsets`` only (whisper.cpp pads non-speech into neighbouring tokens).
#: - 2: DTW word starts and ends with ``-nfa``, a median-relative duration cap, and
#:   punctuation-only tokens folded into words. v1 entries carry spans like ``"."``
#:   0.02-24.96 s and must not be served again.
#:
#: The ``/analyze`` brain cache keys on ``ANALYZER_VERSIONS[TRANSCRIPTION]`` in
#: ``analysis/tiers.py``; bump it together with this.
TRANSCRIPT_TIMING_VERSION = 2


def _content_hash(
    media_path: Path,
    model: str,
    *,
    timing_version: int = TRANSCRIPT_TIMING_VERSION,
    chunk_size: int = 1024 * 1024,
) -> str:
    digest = hashlib.sha256()
    digest.update(model.encode("utf-8"))
    # Separated from the model name by NUL so no model name can collide with a salt.
    digest.update(f"\0timing-v{timing_version}\0".encode())
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
    read_help: HelpReader | None = None,
) -> list[TranscriptWord]:
    """Content-hash-cached wrapper over :func:`transcribe_local`.

    Re-transcribing the same file with the same model is common (retries,
    re-imports, repeated dev/test runs) and whisper.cpp is comparatively slow —
    memoizing by a hash of (model, timing version, file bytes) avoids redundant
    work, per the plan's "model results are content-hash cached" invariant.
    """
    if not use_cache:
        return transcribe_local(
            media_path, model=model, run=run, timeout=timeout, read_help=read_help
        )

    key = _content_hash(media_path, model)
    cache_file = cache_dir() / f"{key}.json"
    if cache_file.is_file():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            return [TranscriptWord.model_validate(w) for w in cached]
        except (OSError, json.JSONDecodeError, ValidationError):
            _log.warning("Discarding unreadable ASR cache entry %s", cache_file)

    words = transcribe_local(media_path, model=model, run=run, timeout=timeout, read_help=read_help)
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps([w.model_dump() for w in words]), encoding="utf-8")
    except OSError as exc:  # pragma: no cover - cache write is best-effort
        _log.warning("Failed to write ASR cache entry %s: %s", cache_file, exc)
    return words
