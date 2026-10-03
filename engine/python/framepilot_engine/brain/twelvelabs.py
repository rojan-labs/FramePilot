"""TwelveLabs hosted media-understanding client (optional backend).

WHY: FramePilot's built-in visual index (plan ``MEDIA-INTELLIGENCE.md``) samples
frames, embeds them with NVIDIA, and searches a local ``sqlite-vec`` store. When
a user configures a **TwelveLabs** API key we instead delegate the whole
understanding job to TwelveLabs' hosted models — Marengo (search/embeddings) and
Pegasus (generative footage map) — which index a video's **visual, audio, and
speech** together. This module is a thin, typed **facade over the official
``twelvelabs`` Python SDK**: it owns the mapping between the SDK's request/response
models and FramePilot's own dataclasses/typed errors, and nothing else. Choosing
the backend, persisting the asset↔video mapping, and mapping clips onto the
timeline live in the sidecar routes (:mod:`framepilot_engine.service`).

WHY the SDK (not hand-rolled REST): the raw endpoints drift — ``/summarize`` and
``/gist`` were sunset, ``/search`` dropped ``score`` for ``rank``, and index
``id`` replaced ``_id``. The generated SDK tracks the live v1.3 spec, so the
engine follows API changes for free instead of decoding raw JSON by hand.

.. note:: The ``twelvelabs`` package currently ships **without a declared
   license** (see ``pyproject.toml`` where the dependency is added). It is used
   with the maintainer's explicit acceptance of that risk; revisit if TwelveLabs
   publishes an officially-licensed release.

Design rules mirror :mod:`framepilot_engine.brain.visual_embed`:

- **Injected transport.** The SDK is built over a caller-supplied ``httpx.Client``
  (constructor parameter), so every branch — index create, task create/poll,
  search, analyze — is testable with ``respx``/``httpx.MockTransport`` at the wire
  level and never touches the live API.
- **Honest failures.** An SDK :class:`~twelvelabs.core.api_error.ApiError` or a
  transport error is translated to a typed :class:`TwelveLabsError`
  (401/403 → :class:`TwelveLabsAuthError`; a generate call against a Marengo-only
  index → :class:`TwelveLabsIndexNotGenerativeError`; a file TwelveLabs refuses
  for what it IS → :class:`TwelveLabsMediaRejectedError`; a valid key reading an
  index another account owns → :class:`TwelveLabsIndexInaccessibleError`, never an
  auth error); the routes translate that
  into an ``available=True`` response carrying a typed ``reason``, never a
  fabricated result. TwelveLabs never fabricates a video the user did not upload.
- **Secrets stay out of logs.** Only HTTP status codes, index/video/task ids, and
  result counts are logged; never the API key, media bytes, or a presigned chunk
  URL (those are bearer credentials for the upload).

Uploading local media — WHY two paths and a pre-flight:

- ``POST /assets`` (``method="direct"``) takes local video/audio only **up to
  200 MB** (SDK ``assets.create`` docs). A bigger file streams in full and is then
  refused with HTTP 400 ``video_filesize_too_large``: a 1 GB camera clip burned
  ~200 s of upload that way, then the next job uploaded it again.
- Local **video** up to **10 GB** goes through the **multipart upload** API
  (SDK ``multipart_upload`` docs). We drive its low-level calls ourselves rather
  than the SDK's ``upload_file`` helper, which writes chunk copies into a
  ``<stem>_chunks/`` folder beside the media — i.e. into the user's footage
  folder — and PUTs through the global ``httpx.put``, bypassing the injected
  client (so neither our timeouts nor the wire-level tests would apply).
- A file over 10 GB, or audio over 200 MB (multipart is video-only), is refused
  **before a byte is sent** with :class:`TwelveLabsMediaRejectedError`.

A rejection that is a property of the FILE (size, length, resolution, format —
:class:`TwelveLabsMediaRejectedError`) is permanent for those bytes, unlike a
rate limit or an outage; the caller remembers it so it is never re-uploaded
(:data:`TL_UPLOAD_POLICY_VERSION`).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import mimetypes
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, NoReturn

import httpx
from twelvelabs import (
    CompletedChunk,
    IndexesCreateRequestModelsItem,
    PresignedUrlChunk,
    ReportChunkBatchResponse,
    SyncResponseFormat,
)
from twelvelabs import TwelveLabs as _TwelveLabsSDK
from twelvelabs.core.api_error import ApiError
from twelvelabs.core.request_options import RequestOptions
from twelvelabs.types.video_context import VideoContext_AssetId

_log = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_INDEX_OPTIONS",
    "DEFAULT_MODEL_NAME",
    "DEFAULT_PEGASUS_MODEL_NAME",
    "DEFAULT_SEARCH_OPTIONS",
    "DEFAULT_TIMEOUT_SECONDS",
    "DEFAULT_TRANSCRIPTION_OPTIONS",
    "DIRECT_UPLOAD_MAX_BYTES",
    "MULTIPART_UPLOAD_MAX_BYTES",
    "NO_API_KEY_REASON",
    "PEGASUS_MAP_PROMPT_VERSION",
    "PEGASUS_MAX_SYNC_MEDIA_SECONDS",
    "PEGASUS_SECONDS_PER_MEDIA_SECOND",
    "PEGASUS_UNAVAILABLE_REASON",
    "PREFLIGHT_AUDIO_TOO_LARGE_CODE",
    "PREFLIGHT_FILE_TOO_LARGE_CODE",
    "TL_UPLOAD_POLICY_VERSION",
    "VISUAL_SEARCH_OPTIONS",
    "TLChapter",
    "TLClip",
    "TLGist",
    "TLHighlight",
    "TLWord",
    "TaskStatus",
    "TwelveLabsAssetInaccessibleError",
    "TwelveLabsAuthError",
    "TwelveLabsClient",
    "TwelveLabsClientResolution",
    "TwelveLabsError",
    "TwelveLabsIndexInaccessibleError",
    "TwelveLabsIndexNotGenerativeError",
    "TwelveLabsMediaRejectedError",
    "TwelveLabsPegasusUnavailableError",
    "asset_task_token",
    "key_fingerprint",
    "pegasus_timeout_seconds",
    "resolve_twelvelabs",
    "task_token_index",
    "task_token_uploaded_asset",
]

#: TwelveLabs REST base (API version 1.3).
DEFAULT_BASE_URL = "https://api.twelvelabs.io/v1.3"

#: The Marengo model powers search + embeddings (visual + audio understanding).
#: Pinned so a stored index's model is explicit; a model change means a new index.
DEFAULT_MODEL_NAME = "marengo3.0"

#: The Pegasus model powers **generative** understanding — the footage map
#: (chapters / highlights / summary) via ``POST /analyze``.
#:
#: WHY 1.5 and why it is NOT an index model: TwelveLabs sunset ``pegasus1.2``. It is
#: rejected at index creation (``POST /indexes`` → HTTP 400 ``parameter_invalid``:
#: "pegasus1.2 has been sunset"), which used to fail the FIRST index a project ever
#: created — so nothing indexed, and every footage map reported ``not_indexed``
#: forever. ``pegasus1.5`` needs no index at all: it analyses an **uploaded asset**
#: directly (``video={"type": "asset_id", ...}``, and ``video_id`` is rejected). So
#: an index carries Marengo only, and the map is generated from the asset we upload.
DEFAULT_PEGASUS_MODEL_NAME = "pegasus1.5"

#: Modalities Marengo **indexes**. These are the only values ``POST /indexes``
#: accepts as ``model_options`` — ``transcription`` is a *search* modality derived
#: from the indexed audio, NOT an index option, so it must never leak into index
#: creation (the API rejects it). Kept separate from :data:`DEFAULT_SEARCH_OPTIONS`
#: for exactly that reason.
DEFAULT_INDEX_OPTIONS = ("visual", "audio")

#: Search modalities enabled by default. Matches the TwelveLabs dashboard's
#: known-good config: the frame content, the audio track, AND the speech
#: transcription, so a query resolves against everything Marengo understood — the
#: same fused ranking the dashboard returns. ``transcription`` searches the
#: indexed speech (see :data:`DEFAULT_TRANSCRIPTION_OPTIONS`); it is valid at
#: search time on any visual+audio index. Kept configurable per call (image
#: queries pass ``("visual",)``).
DEFAULT_SEARCH_OPTIONS = ("visual", "audio", "transcription")

#: What a PICTURE search asks for: the frames, and nothing the footage says or plays.
#: ``search_visual`` promises what is on screen, and fusing in the speech modalities made
#: narrated footage answer from its words — desktop run 001be135's recap video carried its
#: own narration, so every "find the shot of X" came back at the moment the narrator said X,
#: and the agent laid the footage out in source order believing it had matched the picture.
VISUAL_SEARCH_OPTIONS = ("visual",)

#: How the ``transcription`` search modality matches, when it is requested: both
#: ``lexical`` (exact words) and ``semantic`` (meaning), mirroring the dashboard.
#: Ignored by TwelveLabs unless ``transcription`` is among the search options.
DEFAULT_TRANSCRIPTION_OPTIONS = ("lexical", "semantic")

#: Per-request timeout in seconds. Searches are slow server-side; httpx's 5s
#: default would flake. Task polling shares the bound (a quick GET).
DEFAULT_TIMEOUT_SECONDS = 120.0

#: Timeout for the ONE slow request that streams a whole local media asset to
#: TwelveLabs (``POST /assets``). A minutes-long camera file is hundreds of MB to
#: gigabytes; the 120s default silently kills the upload mid-stream, which the
#: route then surfaces as a generic failure — the classic "stuck at 0%" report.
#: A generous bound (not ``None``) lets a large upload finish while still capping
#: a genuinely hung connection so the paced slice can never block forever.
DEFAULT_UPLOAD_TIMEOUT_SECONDS = 900.0

#: Read bound for one Pegasus ``/analyze`` call, per second of the analysed video.
#:
#: A synchronous analysis sends NOTHING until Pegasus has read the whole video and
#: generated its answer, so httpx's read timeout is, in effect, the whole analysis — and
#: the flat :data:`DEFAULT_TIMEOUT_SECONDS` (120 s) is a bound that grows false with the
#: footage. Measured: a 7:47 reel's chapters took ~56 s (0.12 s/s) and its highlights
#: ~11 s; a 58:51 reel's chapters failed at 121 s with "The read operation timed out", so
#: an hour of footage had no map at all. Half a second per media second is 4x the
#: measured rate, room for a busy provider; it is a stuck-request bound, not an
#: expected time, and :func:`pegasus_timeout_seconds` floors it at the default.
#:
#: WHY a scaled per-call timeout and not ``analyze_stream`` with a per-chunk read
#: timeout (the SDK has both): a stream's FIRST chunk still waits for Pegasus to read
#: the whole video, so its bound would have to scale with duration all the same; and a
#: per-chunk bound never ends the failure ``_analyze_structured`` already guards against,
#: Pegasus repeating the tail of its JSON forever — a stream that keeps producing never
#: times out. One total bound covers both. The asynchronous ``/analyze/tasks`` API is the
#: only route past the sync endpoint's one-hour ceiling; it is not needed below it.
PEGASUS_SECONDS_PER_MEDIA_SECOND = 0.5
#: The duration assumed when an asset's is unknown (no probe): the sync ``/analyze``
#: endpoint's documented maximum, so a probe-less long asset is never held to the 120 s
#: bound that failed the hour-long reel.
PEGASUS_MAX_SYNC_MEDIA_SECONDS = 3600.0
#: Version of the footage-map prompts and schemas (chapters, highlights, summary). Part
#: of the key an in-flight map is shared under, so changing what is asked of Pegasus
#: never hands a caller an answer to the old question. Bump it with the prompts.
PEGASUS_MAP_PROMPT_VERSION = 1


def pegasus_timeout_seconds(duration_seconds: float | None) -> float:
    """The read bound for one Pegasus ``/analyze`` call over a video this long.

    :param duration_seconds: The analysed video's duration; ``None`` or non-positive when
        unknown, which is bounded as the longest video the sync endpoint accepts.
    :returns: Seconds, never below :data:`DEFAULT_TIMEOUT_SECONDS`.
    """
    media = (
        duration_seconds
        if duration_seconds is not None and duration_seconds > 0
        else PEGASUS_MAX_SYNC_MEDIA_SECONDS
    )
    return max(DEFAULT_TIMEOUT_SECONDS, media * PEGASUS_SECONDS_PER_MEDIA_SECOND)


#: Largest local video/audio file ``POST /assets`` (``method="direct"``) accepts.
#: WHY: the SDK's ``assets.create`` docs (twelvelabs 1.2.9) cap "Video and audio,
#: local files" at 200 MB. Anything bigger is streamed in full and only THEN refused
#: (HTTP 400 ``video_filesize_too_large``), so it must take the multipart path. Decimal
#: megabytes on purpose: if TwelveLabs means 200 MiB, the files in between still upload
#: fine through multipart; the other reading would send a few too-big files direct.
DIRECT_UPLOAD_MAX_BYTES = 200 * 1000 * 1000

#: Largest local video the multipart upload API accepts. WHY: the SDK's
#: ``multipart_upload.create`` docs: "Local video files up to 10 GB" (Pegasus 1.5 takes
#: the same ceiling). A bigger file is refused before a single byte is sent. Decimal for
#: the same conservative reason as :data:`DIRECT_UPLOAD_MAX_BYTES`.
MULTIPART_UPLOAD_MAX_BYTES = 10 * 1000 * 1000 * 1000

#: How FramePilot sends bytes to TwelveLabs. Persisted next to a remembered rejection so
#: that a CHANGE to the upload path re-tries bytes an older path was refused for. Bump it
#: whenever the upload logic below changes what TwelveLabs can accept. v1 sent every file
#: direct (and was refused for anything over 200 MB); v2 adds multipart up to 10 GB.
TL_UPLOAD_POLICY_VERSION = 2

#: FramePilot's own machine codes for a pre-flight refusal (no request was made), in
#: the same ``snake_case`` style as TwelveLabs' codes so callers read one vocabulary.
PREFLIGHT_FILE_TOO_LARGE_CODE = "file_too_large"
PREFLIGHT_AUDIO_TOO_LARGE_CODE = "audio_file_too_large"

#: Attempts per multipart chunk PUT before the upload gives up. A presigned PUT to
#: object storage fails transiently now and then (a reset connection, a 503); three
#: tries ride that out, while a chunk that keeps failing is a real outage the caller
#: should hear about rather than a loop that re-sends a gigabyte forever.
_CHUNK_PUT_ATTEMPTS = 3
#: First retry delay for a failed chunk; doubled on each further attempt (2 s, 4 s).
_CHUNK_RETRY_BACKOFF_SECONDS = 2.0
#: Chunks reported to TwelveLabs per ``report_chunk_batch`` call. The API asks for
#: batched reports; reporting as we go (not all at the end) keeps the session's
#: server-side progress real if the upload is interrupted.
_CHUNK_REPORT_BATCH = 10
#: Most presigned URLs one ``get_additional_presigned_urls`` call may return (API cap).
_PRESIGNED_URL_BATCH_MAX = 50
#: Log a progress line every this many chunks, so a 10-minute upload is visibly alive.
_CHUNK_PROGRESS_LOG_EVERY = 10
#: Content type for a raw multipart chunk PUT (what object storage expects).
_CHUNK_CONTENT_TYPE = "application/octet-stream"

#: The machine code TwelveLabs answers when the key is valid but the entity (an index,
#: an uploaded asset) belongs to ANOTHER account or no longer exists for this one:
#: ``403 {"code":"read_not_allowed","message":"The caller is not authorized to read
#: entity <id>."}`` — observed live after a project's key was switched to a different
#: account. It is about the ENTITY, never the key, so it must not read as a bad key.
_ENTITY_NOT_READABLE_CODE = "read_not_allowed"
#: Statuses on which :data:`_ENTITY_NOT_READABLE_CODE` is honoured.
_ENTITY_NOT_READABLE_STATUSES = frozenset({403, 404})

#: Domain separator for :func:`key_fingerprint`, so the digest is useless for anything
#: but recognising "the same key as before" (and a version, should the scheme change).
_KEY_FINGERPRINT_DOMAIN = b"framepilot:twelvelabs-key-fingerprint:v1\x00"
#: Hex characters kept: 64 bits tells keys apart and is not a usable hash of the key.
_KEY_FINGERPRINT_HEX_CHARS = 16
#: How many indexes one name lookup reads (first page only; the name filter keeps it small).
_INDEX_LOOKUP_PAGE_LIMIT = 50

#: Typed reason when no key is configured (mirrors ``visual_embed.NO_API_KEY_REASON``).
NO_API_KEY_REASON = "no_api_key"

#: Typed reason when the account is authenticated but not entitled to Pegasus
#: generative understanding (the ``/analyze`` endpoint). A route surfaces this so
#: the UI can offer the built-in fallback map instead of a fabricated one.
PEGASUS_UNAVAILABLE_REASON = "pegasus_unavailable"

#: Task states TwelveLabs reports; ``ready`` is the only terminal-success value.
_TASK_READY = "ready"
_TASK_FAILED = "failed"
_ASSET_TASK_PREFIX = "asset-v1"
_INDEXED_ASSET_TASK_PREFIX = "indexed-asset-v1"


class TwelveLabsError(Exception):
    """A TwelveLabs request failed (non-2xx, transport error, or bad payload).

    Carries an actionable, key-free message the route surfaces as a ``reason``.
    """


class TwelveLabsAuthError(TwelveLabsError):
    """The API key was rejected (HTTP 401).

    A distinct type so a route can report ``invalid_api_key`` rather than a
    generic failure, without ever echoing the key.
    """


class TwelveLabsPegasusUnavailableError(TwelveLabsError):
    """The key is valid but the account is not entitled to Pegasus (HTTP 402/403).

    Distinct from :class:`TwelveLabsAuthError` so a comprehension route can degrade
    to the built-in span/caption map (``pegasus_unavailable``) instead of reporting
    the whole key as invalid. Marengo search/index still work on such accounts.
    """


class TwelveLabsIndexNotGenerativeError(TwelveLabsError):
    """The index has no Pegasus model, so ``/analyze`` can't run (HTTP 400).

    TwelveLabs answers ``index_not_supported_for_generate`` when a generate call
    targets a Marengo-only index (one created before FramePilot added Pegasus to
    :meth:`TwelveLabsClient.create_index`). Distinct so the footage-map route can
    degrade to the built-in span/caption map — which the account's existing Marengo
    index already supports — instead of surfacing a raw HTTP 400. Recreating the
    index (with Pegasus) and re-indexing restores the full Pegasus map.
    """


class TwelveLabsIndexInaccessibleError(TwelveLabsError):
    """The key is fine, but the index (or entity) it names is not this account's.

    TwelveLabs answers ``read_not_allowed`` (HTTP 403) when a project's saved index was
    created under a DIFFERENT TwelveLabs account — the user switched keys — or is gone.
    Before this type it was read as a rejected key, so a user whose key worked was told
    to fix it, forever. The index route answers it by binding the project to an index
    of the current account; read-only routes report the project as not indexed yet.
    """


class TwelveLabsAssetInaccessibleError(TwelveLabsError):
    """An UPLOADED asset this account cannot read (another account's upload).

    Raised only by :meth:`TwelveLabsClient.get_task` when reading the uploaded asset
    itself fails with ``read_not_allowed`` — distinct from the index being unreadable,
    so a caller re-attaching an earlier upload to a new index knows to upload the file
    again rather than to rebind the index.
    """


class TwelveLabsMediaRejectedError(TwelveLabsError):
    """TwelveLabs will not take THIS file as it is (size, length, resolution, format).

    Distinct from every other failure because it is **permanent for these bytes**:
    a rate limit, an outage, or a bad key can clear on retry, but a 12 GB file or a
    video TwelveLabs judges too long never will. The caller persists it and stops
    re-uploading the same bytes (``twelvelabs_index.poll_index_asset``), and it is a
    property of the file — never evidence that the index or account is broken.

    ``str(exc)`` is written for a video editor ("ro.mp4 is 12.3 GB; TwelveLabs accepts
    files up to 10 GB…"), not "HTTP 400"; the machine ``code`` (TwelveLabs' own, e.g.
    ``video_filesize_too_large``, or a FramePilot pre-flight code) stays available.
    """

    def __init__(self, message: str, *, code: str, http_status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        #: The HTTP status TwelveLabs answered with; ``None`` for a pre-flight refusal.
        self.http_status = http_status

    def naming(self, file_name: str) -> TwelveLabsMediaRejectedError:
        """The same rejection, re-worded to name the file (the API error cannot)."""
        return TwelveLabsMediaRejectedError(
            _media_rejection_message(self.code, self.http_status, file_name),
            code=self.code,
            http_status=self.http_status,
        )


@dataclass(frozen=True)
class TaskStatus:
    """State of one media-indexing operation.

    ``task_id`` may advance from an uploaded-asset token to an indexed-asset token;
    callers persist the returned value so polling remains resumable. ``video_id``
    is populated only once ``status == "ready"``; ``done`` is True for both a
    ready and a failed task.

    ``source_asset_id`` is the id of the media we uploaded (``POST /assets``), which
    is a DIFFERENT id from ``video_id`` (the indexed asset inside the index). Pegasus
    generation needs the uploaded asset, so callers persist it alongside the mapping.
    """

    task_id: str
    status: str
    video_id: str | None
    source_asset_id: str | None = None

    @property
    def ready(self) -> bool:
        """True once the video is fully indexed and searchable."""
        return self.status == _TASK_READY and self.video_id is not None

    @property
    def failed(self) -> bool:
        """True when TwelveLabs gave up indexing this asset."""
        return self.status == _TASK_FAILED

    @property
    def done(self) -> bool:
        """True when polling should stop (ready or failed)."""
        return self.ready or self.failed


def key_fingerprint(api_key: str) -> str:
    """A short, non-reversible tag that recognises the same TwelveLabs key again.

    Stored next to a project's index id so a CHANGED key (often a different account,
    whose indexes the new key cannot read) is noticed before any call fails. Never the
    key, never reversible: a domain-separated SHA-256, truncated.
    """
    digest = hashlib.sha256(_KEY_FINGERPRINT_DOMAIN + api_key.strip().encode("utf-8"))
    return digest.hexdigest()[:_KEY_FINGERPRINT_HEX_CHARS]


def asset_task_token(index_id: str, asset_id: str) -> str:
    """The resumable token that attaches uploaded ``asset_id`` to ``index_id``.

    :meth:`TwelveLabsClient.get_task` waits for the asset to be ready, then attaches it
    — so re-tokening an EARLIER upload for a new index re-attaches it without uploading
    the file again.
    """
    return _task_token(_ASSET_TASK_PREFIX, index_id, asset_id)


def task_token_index(task_id: str | None) -> str | None:
    """The index a FramePilot task token belongs to, or ``None`` (legacy/unknown)."""
    token = _parse_task_token(task_id) if task_id else None
    return token[1] if token is not None else None


def task_token_uploaded_asset(task_id: str | None) -> str | None:
    """The uploaded-asset id an ``asset-v1`` token carries, or ``None``."""
    token = _parse_task_token(task_id) if task_id else None
    if token is None or token[0] != _ASSET_TASK_PREFIX:
        return None
    return token[2]


def _task_token(kind: str, index_id: str, remote_id: str) -> str:
    """Encode the durable state needed to resume the two-step indexing flow."""
    return f"{kind}:{index_id}:{remote_id}"


def _parse_task_token(task_id: str) -> tuple[str, str, str] | None:
    """Decode FramePilot task tokens while accepting legacy TwelveLabs task ids."""
    parts = task_id.split(":", maxsplit=2)
    if len(parts) != 3 or parts[0] not in {_ASSET_TASK_PREFIX, _INDEXED_ASSET_TASK_PREFIX}:
        return None
    kind, index_id, remote_id = parts
    if not index_id or not remote_id:
        return None
    return kind, index_id, remote_id


@dataclass(frozen=True)
class TLClip:
    """One ranked clip from a TwelveLabs search (``POST /search`` ``data[]``).

    ``start``/``end`` are **asset** seconds within the source video; ``score`` is a
    relevance score (higher = more relevant); ``transcription`` is the spoken words
    over the clip when the audio/transcription modality hit.

    ``rank`` is TwelveLabs' 1-based position (1 = best). WHY it matters: Marengo 3.0
    returns **only** ``rank`` — the SDK's ``SearchItem`` exposes no numeric ``score``
    and no ``confidence`` — so :func:`_clips_from_items` derives ``score`` from
    ``rank`` (``1/rank``) and leaves ``confidence`` ``None``. Without that, every clip
    defaulted to ``score=0``, the orchestrator saw an undistinguished wall of
    ``rrf=0`` scenes, and the agent looped with no relevance signal.
    """

    video_id: str
    start: float
    end: float
    score: float
    confidence: str | None = None
    transcription: str | None = None
    rank: int = 0


@dataclass(frozen=True)
class TLWord:
    """One word of TwelveLabs' native transcription (``GET .../videos/{id}``).

    ``start``/``end`` are **asset** seconds; ``value`` is the spoken word. TwelveLabs
    indexes the audio track when a video is added, so its word-level transcription is
    available with no extra ASR pass — this is the source FramePilot pulls into the
    project transcript on the TwelveLabs backend (the user's chosen design), instead
    of running local whisper a second time over audio TwelveLabs already understood.
    """

    start: float
    end: float
    value: str


@dataclass(frozen=True)
class TLChapter:
    """One chapter from Pegasus ``POST /analyze`` (chapter schema).

    ``start``/``end`` are **asset** seconds within the source video (the route
    projects them onto timeline time). ``title``/``summary`` are Pegasus' own
    labels for the chapter. This is the time-ordered "map of the video with no
    query" the orchestrator reasons over on long footage.
    """

    start: float
    end: float
    title: str
    summary: str = ""


@dataclass(frozen=True)
class TLHighlight:
    """One highlight from Pegasus ``POST /analyze`` (highlight schema).

    ``start``/``end`` are asset seconds; ``label`` is Pegasus' one-line name for
    the moment. Highlights have no native numeric score — the route derives one
    from position when ordering (best-first) is needed.
    """

    start: float
    end: float
    label: str


@dataclass(frozen=True)
class TLGist:
    """The whole-video summary from Pegasus ``POST /analyze`` (summary schema).

    ``summary`` is a one-paragraph description of the entire video with no query.
    Empty when Pegasus returned no text (honest, never fabricated).
    """

    summary: str


@dataclass(frozen=True)
class TwelveLabsClientResolution:
    """Outcome of the TwelveLabs capability gate (honest-unavailable shape).

    Mirrors :class:`~framepilot_engine.brain.visual_embed.VisualEmbedderResolution`:
    exactly one of ``client``/``reason`` is meaningful. No key is the shipped
    default — the caller then uses the built-in indexer instead.
    """

    client: TwelveLabsClient | None
    reason: str | None = None


class TwelveLabsClient:
    """Typed facade over the official ``twelvelabs`` SDK (media understanding v1.3).

    Every method returns FramePilot's own dataclasses (never the SDK's models) and
    raises :class:`TwelveLabsError` on failure (never a fabricated result); the
    sidecar routes catch that and degrade honestly. The underlying SDK is built
    over a caller-supplied ``httpx.Client`` so all branches are testable offline.
    """

    def __init__(
        self,
        api_key: str,
        *,
        http: httpx.Client,
        base_url: str = DEFAULT_BASE_URL,
        model_name: str = DEFAULT_MODEL_NAME,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        upload_timeout: float = DEFAULT_UPLOAD_TIMEOUT_SECONDS,
        sdk: _TwelveLabsSDK | None = None,
        direct_upload_max_bytes: int = DIRECT_UPLOAD_MAX_BYTES,
        max_upload_bytes: int = MULTIPART_UPLOAD_MAX_BYTES,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._model_name = model_name
        self._key_fingerprint = key_fingerprint(api_key)
        self._timeout = timeout
        self._upload_timeout = upload_timeout
        # The size limits are parameters (defaulting to TwelveLabs' documented ones) so
        # the multipart path is testable with a few bytes instead of a 200 MB fixture;
        # ``sleep`` is the chunk-retry backoff, injectable so retries cost no wall clock.
        self._direct_upload_max_bytes = direct_upload_max_bytes
        self._max_upload_bytes = max_upload_bytes
        self._sleep = sleep
        # Multipart chunks are PUT to presigned object-storage URLs outside the SDK, and
        # must go through this same injected client so timeouts and ``respx`` apply.
        self._http = http
        # ``sdk`` is an injection seam for tests that want to stub the SDK directly;
        # production always builds one over the injected httpx client so ``respx``
        # intercepts every call at the wire level. The SDK sends ``x-api-key`` and
        # never logs the key.
        self._sdk = sdk or _TwelveLabsSDK(
            api_key=api_key,
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            httpx_client=http,
        )

    @property
    def key_fingerprint(self) -> str:
        """:func:`key_fingerprint` of this client's key (safe to store and to log)."""
        return self._key_fingerprint

    # -- error translation ------------------------------------------------------

    @contextmanager
    def _translate_errors(self, *, pegasus: bool = False) -> Iterator[None]:
        """Map SDK/transport failures onto FramePilot's typed errors.

        Wraps one SDK call. The SDK raises an :class:`ApiError` (carrying
        ``status_code`` + parsed ``body``) for a non-2xx and an ``httpx.HTTPError``
        for a transport failure; both become a typed :class:`TwelveLabsError` so a
        route can degrade honestly. Only status codes are surfaced — never the API
        key, request body, or media bytes.

        :param pegasus: Set on generative (``analyze``) calls so a 402/403 reads as
            "no Pegasus entitlement" and a 400 ``index_not_supported_for_generate``
            reads as "index has no Pegasus model", instead of a generic failure.
        """
        try:
            yield
        except ApiError as exc:
            _raise_typed(exc, pegasus=pegasus)
        except httpx.HTTPError as exc:  # transport-level (DNS, connect, timeout)
            _log.warning("twelvelabs ✗ transport error: %s", exc)
            raise TwelveLabsError(f"TwelveLabs request failed: {exc}") from exc

    # -- indexes ----------------------------------------------------------------

    def create_index(self, name: str) -> str:
        """Create a Marengo (visual + audio) index and return its id.

        Marengo is the only model an index carries: it powers search, embeddings and
        the indexed transcription. Generative understanding (the footage map) is NOT
        an index concern any more — ``pegasus1.5`` analyses the uploaded asset
        directly (see :data:`DEFAULT_PEGASUS_MODEL_NAME`), and asking for a Pegasus
        model here is rejected outright, which used to break index creation and with
        it every downstream indexing job.

        :raises TwelveLabsError: On any API/transport failure.
        """
        with self._translate_errors():
            resp = self._sdk.indexes.create(
                index_name=name,
                models=[
                    IndexesCreateRequestModelsItem(
                        model_name=self._model_name,
                        model_options=list(DEFAULT_INDEX_OPTIONS),
                    ),
                ],
            )
        index_id = resp.id
        if not isinstance(index_id, str) or not index_id:
            raise TwelveLabsError("TwelveLabs index create returned no id.")
        _log.info("ACT twelvelabs index created: %s", index_id)
        return index_id

    def index_accessible(self, index_id: str) -> bool:
        """Whether this key can read ``index_id`` (False: another account's, or gone).

        :raises TwelveLabsError: On any other failure (a rejected key stays an auth error).
        """
        try:
            with self._translate_errors():
                self._sdk.indexes.retrieve(index_id)
        except TwelveLabsIndexInaccessibleError:
            return False
        return True

    def find_index(self, name: str) -> str | None:
        """The id of this account's index called exactly ``name``, or ``None``.

        Lets a project that switches back to an earlier account reuse the index it
        already has there (and every asset indexed in it) instead of making another.

        :raises TwelveLabsError: On any API/transport failure.
        """
        with self._translate_errors():
            page = self._sdk.indexes.list(index_name=name, page_limit=_INDEX_LOOKUP_PAGE_LIMIT)
        for index in page.items or []:
            if index.index_name == name and isinstance(index.id, str) and index.id:
                return index.id
        return None

    # -- indexing tasks ---------------------------------------------------------

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        """Upload a local media asset and return a resumable polling token.

        This deliberately uses TwelveLabs' current two-step asset workflow. The
        legacy ``/tasks`` endpoint accepts only ``video_file`` and therefore
        reports an MP3 as ``video_file_broken``. ``POST /assets`` accepts both
        audio and video; :meth:`get_task` attaches the ready upload to the index
        and then polls that indexed asset without blocking a request thread.

        The upload path is chosen by size (see the module docstring): up to
        :data:`DIRECT_UPLOAD_MAX_BYTES` goes direct; larger video goes multipart; a file
        TwelveLabs could never take is refused before anything is sent.

        :raises TwelveLabsMediaRejectedError: The file can't be indexed as it is (too
            big, too long, unsupported) — permanent for these bytes.
        :raises TwelveLabsError: On any other API/transport failure.
        """
        size_bytes = media_path.stat().st_size if media_path.exists() else -1
        media_type = mimetypes.guess_type(media_path.name)[0] or "application/octet-stream"
        self._preflight(media_path.name, size_bytes, media_type)
        multipart = size_bytes > self._direct_upload_max_bytes
        _log.info(
            "ACT twelvelabs upload start: index=%s file=%s size=%.1fMB method=%s",
            index_id,
            media_path.name,
            size_bytes / (1024 * 1024) if size_bytes >= 0 else -1.0,
            "multipart" if multipart else "direct",
        )
        started = time.monotonic()
        try:
            asset_id = (
                self._upload_multipart(media_path, size_bytes)
                if multipart
                else self._upload_direct(media_path, media_type)
            )
        except TwelveLabsMediaRejectedError as exc:
            raise exc.naming(media_path.name) from exc
        task_id = _task_token(_ASSET_TASK_PREFIX, index_id, asset_id)
        _log.info(
            "ACT twelvelabs upload done: asset=%s index=%s in %.1fs",
            asset_id,
            index_id,
            time.monotonic() - started,
        )
        return task_id

    def _preflight(self, file_name: str, size_bytes: int, media_type: str) -> None:
        """Refuse a file TwelveLabs could never accept, before a single byte is sent.

        :raises TwelveLabsMediaRejectedError: Over the multipart ceiling, or audio too
            big for the direct path (multipart upload is video-only per the SDK docs).
        """
        if size_bytes > self._max_upload_bytes:
            _log.warning(
                "twelvelabs ✗ pre-flight: file=%s size=%d over the %d-byte upload limit",
                file_name,
                size_bytes,
                self._max_upload_bytes,
            )
            raise TwelveLabsMediaRejectedError(
                f"{file_name} is {_format_size(size_bytes)}; TwelveLabs accepts files up to "
                f"{_format_size(self._max_upload_bytes)}. Export a smaller proxy to index "
                "it with TwelveLabs.",
                code=PREFLIGHT_FILE_TOO_LARGE_CODE,
            )
        if size_bytes > self._direct_upload_max_bytes and media_type.startswith("audio/"):
            _log.warning(
                "twelvelabs ✗ pre-flight: audio file=%s size=%d over the %d-byte direct limit",
                file_name,
                size_bytes,
                self._direct_upload_max_bytes,
            )
            raise TwelveLabsMediaRejectedError(
                f"{file_name} is {_format_size(size_bytes)}; TwelveLabs accepts audio files "
                f"up to {_format_size(self._direct_upload_max_bytes)}. Export a shorter or "
                "more compressed copy to index it with TwelveLabs.",
                code=PREFLIGHT_AUDIO_TOO_LARGE_CODE,
            )

    def _upload_direct(self, media_path: Path, media_type: str) -> str:
        """``POST /assets`` the whole file in one request; returns the asset id."""
        with media_path.open("rb") as handle, self._translate_errors():
            resp = self._sdk.assets.create(
                method="direct",
                file=(media_path.name, handle, media_type),
                request_options=RequestOptions(timeout_in_seconds=int(self._upload_timeout)),
            )
        asset_id = resp.id
        if not isinstance(asset_id, str) or not asset_id:
            raise TwelveLabsError("TwelveLabs asset upload returned no id.")
        return asset_id

    def _upload_multipart(self, media_path: Path, size_bytes: int) -> str:
        """Upload a large video through a multipart session; returns the asset id.

        Sequential on purpose: one chunk is in memory at a time (bounded whatever the
        file size), each read straight from the media at its offset — nothing is ever
        written to disk. The returned asset then follows the same ``processing`` →
        ``ready`` → attach-to-index path as a direct upload (:meth:`get_task`).

        :raises TwelveLabsError: On an API failure, or a chunk that keeps failing.
        """
        with self._translate_errors():
            session = self._sdk.multipart_upload.create(
                filename=media_path.name, type="video", total_size=size_bytes
            )
        upload_id = session.upload_id
        asset_id = session.asset_id
        chunk_size = session.chunk_size
        if not upload_id or not asset_id or not chunk_size or chunk_size <= 0:
            raise TwelveLabsError(
                "TwelveLabs multipart upload session is missing its id, asset id, or chunk size."
            )
        total_chunks = max(1, math.ceil(size_bytes / chunk_size))
        urls = _presigned_url_map(session.upload_urls)
        headers = {"Content-Type": _CHUNK_CONTENT_TYPE, **(session.upload_headers or {})}
        _log.info(
            "ACT twelvelabs multipart session: asset=%s upload=%s chunks=%d chunk=%.1fMB",
            asset_id,
            upload_id,
            total_chunks,
            chunk_size / (1024 * 1024),
        )
        pending: list[CompletedChunk] = []
        last_report: ReportChunkBatchResponse | None = None
        with media_path.open("rb") as handle:
            for chunk_index in range(1, total_chunks + 1):  # the API numbers chunks from 1
                offset = (chunk_index - 1) * chunk_size
                length = min(chunk_size, size_bytes - offset)
                handle.seek(offset)
                data = handle.read(length)
                if len(data) != length:
                    raise TwelveLabsError(
                        f"{media_path.name} changed size while it was uploading to TwelveLabs."
                    )
                etag = self._put_chunk(upload_id, chunk_index, total_chunks, data, urls, headers)
                pending.append(
                    CompletedChunk(
                        chunk_index=chunk_index, proof=etag, proof_type="etag", chunk_size=length
                    )
                )
                if len(pending) >= _CHUNK_REPORT_BATCH or chunk_index == total_chunks:
                    with self._translate_errors():
                        last_report = self._sdk.multipart_upload.report_chunk_batch(
                            upload_id, completed_chunks=pending
                        )
                    pending = []
                if chunk_index % _CHUNK_PROGRESS_LOG_EVERY == 0:
                    _log.info(
                        "twelvelabs multipart progress: asset=%s %d/%d chunks",
                        asset_id,
                        chunk_index,
                        total_chunks,
                    )
        completed = last_report.total_completed if last_report is not None else None
        if completed is not None and completed < total_chunks:
            raise TwelveLabsError(
                f"TwelveLabs registered {completed} of {total_chunks} uploaded chunks; "
                "the upload is incomplete."
            )
        return asset_id

    def _put_chunk(
        self,
        upload_id: str,
        chunk_index: int,
        total_chunks: int,
        data: bytes,
        urls: dict[int, str],
        headers: dict[str, str],
    ) -> str:
        """PUT one chunk to its presigned URL, with bounded retries; returns its ETag.

        A retry asks for a FRESH URL: the API documents presigned URLs as single-use
        and expiring after an hour, and says to retry failed chunks with new ones.

        :raises TwelveLabsError: When the chunk still fails after the last attempt.
        """
        problem = "no upload URL"
        for attempt in range(1, _CHUNK_PUT_ATTEMPTS + 1):
            if attempt > 1 or chunk_index not in urls:
                self._fetch_presigned_urls(upload_id, chunk_index, total_chunks, urls)
            url = urls.pop(chunk_index, None)
            if url is not None:
                try:
                    resp = self._http.put(
                        url, content=data, headers=headers, timeout=self._upload_timeout
                    )
                except httpx.HTTPError as exc:
                    # The type only: the message of a transport error can carry the URL,
                    # and a presigned URL is a bearer credential for the upload.
                    problem = type(exc).__name__
                else:
                    etag = str(resp.headers.get("ETag", "")).strip('"')
                    if resp.is_success and etag:
                        return etag
                    problem = f"HTTP {resp.status_code}" if not resp.is_success else "no ETag"
            if attempt < _CHUNK_PUT_ATTEMPTS:
                delay = _CHUNK_RETRY_BACKOFF_SECONDS * 2 ** (attempt - 1)
                _log.warning(
                    "twelvelabs chunk %d/%d upload failed (%s); retry %d/%d in %.0fs",
                    chunk_index,
                    total_chunks,
                    problem,
                    attempt,
                    _CHUNK_PUT_ATTEMPTS - 1,
                    delay,
                )
                self._sleep(delay)
        _log.warning(
            "twelvelabs ✗ chunk %d/%d upload gave up after %d attempts (%s)",
            chunk_index,
            total_chunks,
            _CHUNK_PUT_ATTEMPTS,
            problem,
        )
        raise TwelveLabsError(
            f"TwelveLabs upload failed: part {chunk_index} of {total_chunks} could not be "
            f"sent after {_CHUNK_PUT_ATTEMPTS} attempts ({problem})."
        )

    def _fetch_presigned_urls(
        self, upload_id: str, start: int, total_chunks: int, urls: dict[int, str]
    ) -> None:
        """Fetch presigned URLs for chunks ``start``.. (up to the API's 50) into ``urls``."""
        count = min(_PRESIGNED_URL_BATCH_MAX, total_chunks - start + 1)
        with self._translate_errors():
            resp = self._sdk.multipart_upload.get_additional_presigned_urls(
                upload_id, start=start, count=count
            )
        urls.update(_presigned_url_map(resp.upload_urls))

    def get_task(self, task_id: str) -> TaskStatus:
        """Advance or poll one resumable media-indexing operation.

        :raises TwelveLabsError: On any API/transport failure.
        """
        token = _parse_task_token(task_id)
        if token is not None:
            kind, index_id, remote_id = token
            if kind == _ASSET_TASK_PREFIX:
                return self._advance_uploaded_asset(task_id, index_id, remote_id)
            return self._poll_indexed_asset(task_id, index_id, remote_id)

        # Backward compatibility for mappings created before FramePilot adopted
        # TwelveLabs' asset workflow. Their persisted ids still belong to /tasks.
        with self._translate_errors():
            resp = self._sdk.tasks.retrieve(task_id)
        status = resp.status
        if not isinstance(status, str):
            raise TwelveLabsError("TwelveLabs task status missing.")
        video_id = resp.video_id if isinstance(resp.video_id, str) and resp.video_id else None
        _log.debug(
            "twelvelabs task poll: task=%s status=%s video=%s", task_id, status, video_id or "-"
        )
        return TaskStatus(task_id=task_id, status=status, video_id=video_id)

    def _advance_uploaded_asset(self, task_id: str, index_id: str, asset_id: str) -> TaskStatus:
        """Wait for an upload, then attach it to the requested index exactly once.

        :raises TwelveLabsAssetInaccessibleError: This key cannot read the upload (it
            was made under another account) — upload the file again.
        """
        try:
            with self._translate_errors():
                asset = self._sdk.assets.retrieve(asset_id)
        except TwelveLabsIndexInaccessibleError as exc:
            raise TwelveLabsAssetInaccessibleError(
                "The earlier TwelveLabs upload of this file belongs to a different "
                "TwelveLabs account; it has to be uploaded again."
            ) from exc
        asset_status = asset.status
        if not isinstance(asset_status, str):
            raise TwelveLabsError("TwelveLabs asset status missing.")
        if asset_status == _TASK_FAILED:
            return TaskStatus(
                task_id=task_id, status=_TASK_FAILED, video_id=None, source_asset_id=asset_id
            )
        if asset_status != _TASK_READY:
            return TaskStatus(
                task_id=task_id, status=asset_status, video_id=None, source_asset_id=asset_id
            )

        with self._translate_errors():
            indexed = self._sdk.indexes.indexed_assets.create(index_id, asset_id=asset_id)
        indexed_id = indexed.id
        if not isinstance(indexed_id, str) or not indexed_id:
            raise TwelveLabsError("TwelveLabs indexed-asset create returned no id.")
        next_task_id = _task_token(_INDEXED_ASSET_TASK_PREFIX, index_id, indexed_id)
        _log.info(
            "ACT twelvelabs index attach: asset=%s index=%s indexed_asset=%s",
            asset_id,
            index_id,
            indexed_id,
        )
        return TaskStatus(
            task_id=next_task_id, status="indexing", video_id=None, source_asset_id=asset_id
        )

    def _poll_indexed_asset(self, task_id: str, index_id: str, indexed_asset_id: str) -> TaskStatus:
        """Poll an asset after it has been attached to an index."""
        with self._translate_errors():
            indexed = self._sdk.indexes.indexed_assets.retrieve(index_id, indexed_asset_id)
        indexed_status = indexed.status
        if not isinstance(indexed_status, str):
            raise TwelveLabsError("TwelveLabs indexed-asset status missing.")
        video_id = indexed_asset_id if indexed_status == _TASK_READY else None
        source = getattr(indexed, "asset_id", None)
        _log.debug(
            "twelvelabs indexed asset poll: indexed_asset=%s status=%s",
            indexed_asset_id,
            indexed_status,
        )
        return TaskStatus(
            task_id=task_id,
            status=indexed_status,
            video_id=video_id,
            source_asset_id=source if isinstance(source, str) and source else None,
        )

    def source_asset_id(self, index_id: str, video_id: str) -> str | None:
        """The UPLOADED asset id behind an indexed video, or ``None``.

        Recovery path for mappings persisted before FramePilot stored the uploaded
        asset id: Pegasus 1.5 analyses the uploaded asset, so an older mapping that
        only knows its ``video_id`` would otherwise have no way to build a map short
        of re-uploading the footage.

        :raises TwelveLabsError: On any API/transport failure.
        """
        with self._translate_errors():
            indexed = self._sdk.indexes.indexed_assets.retrieve(index_id, video_id)
        asset_id = getattr(indexed, "asset_id", None)
        return asset_id if isinstance(asset_id, str) and asset_id else None

    # -- transcription ----------------------------------------------------------

    def get_transcription(self, index_id: str, video_id: str) -> list[TLWord]:
        """Fetch a ready video's word-level transcription (``start``/``end``/``value``).

        TwelveLabs transcribes the audio when the video is indexed, so this is a
        plain GET with no extra ASR cost. Returns words in spoken order; a video
        with no speech yields an empty list (honest, never fabricated).

        :raises TwelveLabsError: On any API/transport failure.
        """
        with self._translate_errors():
            resp = self._sdk.indexes.indexed_assets.retrieve(index_id, video_id, transcription=True)
        words = _words_from_items(resp.transcription)
        _log.info(
            "ACT twelvelabs transcription: index=%s video=%s → %d words",
            index_id,
            video_id,
            len(words),
        )
        return words

    # -- search -----------------------------------------------------------------

    def search(
        self,
        index_id: str,
        query_text: str,
        *,
        options: tuple[str, ...] = DEFAULT_SEARCH_OPTIONS,
        transcription_options: tuple[str, ...] = DEFAULT_TRANSCRIPTION_OPTIONS,
        page_limit: int = 10,
    ) -> list[TLClip]:
        """Text-to-video search over the index; ranked clips, best-first.

        :raises TwelveLabsError: On any API/transport failure.
        """
        # ``transcription_options`` (lexical/semantic) only mean anything when the
        # transcription modality is being searched; sending them otherwise is noise.
        transcription = list(transcription_options) if "transcription" in options else None
        with self._translate_errors():
            resp = self._sdk.search.create(
                index_id=index_id,
                query_text=query_text,
                search_options=list(options),
                group_by="clip",
                page_limit=page_limit,
                transcription_options=transcription,
            )
        clips = _clips_from_items(resp.data)
        _log.info(
            "ACT twelvelabs text search: index=%s options=%s len(query)=%d → %d clips",
            index_id,
            ",".join(options),
            len(query_text),
            len(clips),
        )
        return clips

    def search_by_image(
        self,
        index_id: str,
        image_jpeg: bytes,
        *,
        options: tuple[str, ...] = ("visual",),
        page_limit: int = 10,
    ) -> list[TLClip]:
        """Image-to-video search over the index; ranked clips, best-first.

        :raises TwelveLabsError: On any API/transport failure.
        """
        with self._translate_errors():
            resp = self._sdk.search.create(
                index_id=index_id,
                query_media_type="image",
                query_media_file=("query.jpg", image_jpeg, "image/jpeg"),
                search_options=list(options),
                group_by="clip",
                page_limit=page_limit,
            )
        clips = _clips_from_items(resp.data)
        _log.info(
            "ACT twelvelabs image search: index=%s options=%s bytes=%d → %d clips",
            index_id,
            ",".join(options),
            len(image_jpeg),
            len(clips),
        )
        return clips

    # -- Pegasus generative understanding (chapters / highlights / summary) ------
    #
    # WHY these post to ``/analyze`` and not ``/summarize``: TwelveLabs sunset the
    # ``/gist`` and ``/summarize`` endpoints (release note 2026-01-07; removed
    # 2026-02-15) — a live index now answers HTTP 410 ``endpoint_deprecated`` for
    # ``/summarize``, which is exactly the failure that made the footage map go
    # dark. The unified ``/analyze`` endpoint replaces them: instead of a fixed
    # ``type=chapter|highlight|summary``, we hand it a ``response_format`` JSON
    # schema describing the structure we want and parse the schema-conforming JSON
    # it returns. The field names in each schema are chosen to match what
    # :func:`_parse_chapters` / :func:`_parse_highlights` already expect, so the
    # public return types (and every caller) are unchanged.

    #: JSON schema handed to ``/analyze`` for a chapter breakdown. Field names
    #: mirror the old ``/summarize`` chapter shape so :func:`_parse_chapters` reads
    #: the ``/analyze`` output unchanged.
    _CHAPTER_SCHEMA: ClassVar[dict[str, Any]] = {
        "type": "object",
        "properties": {
            "chapters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "start_sec": {"type": "number"},
                        "end_sec": {"type": "number"},
                        "chapter_title": {"type": "string"},
                        "chapter_summary": {"type": "string"},
                    },
                    "required": ["start_sec", "end_sec", "chapter_title"],
                },
            }
        },
        "required": ["chapters"],
    }

    #: JSON schema handed to ``/analyze`` for a highlight reel; mirrors the old
    #: ``/summarize`` highlight shape for :func:`_parse_highlights`.
    _HIGHLIGHT_SCHEMA: ClassVar[dict[str, Any]] = {
        "type": "object",
        "properties": {
            "highlights": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "start_sec": {"type": "number"},
                        "end_sec": {"type": "number"},
                        "highlight": {"type": "string"},
                        "highlight_summary": {"type": "string"},
                    },
                    "required": ["start_sec", "end_sec", "highlight"],
                },
            }
        },
        "required": ["highlights"],
    }

    #: JSON schema handed to ``/analyze`` for a whole-video summary.
    _SUMMARY_SCHEMA: ClassVar[dict[str, Any]] = {
        "type": "object",
        "properties": {"summary": {"type": "string"}},
        "required": ["summary"],
    }

    def _analyze_structured(
        self,
        asset_ref: str,
        prompt: str,
        schema: dict[str, Any],
        *,
        duration_seconds: float | None = None,
    ) -> dict[str, object]:
        """One ``POST /analyze`` with a JSON-schema ``response_format`` → parsed object.

        ``asset_ref`` is the UPLOADED asset id (``POST /assets``), not the indexed
        ``video_id``: Pegasus 1.5 rejects ``video_id`` outright and takes a video
        context instead.

        ``/analyze`` returns the schema-conforming output as a **JSON string** in
        ``data`` (not a nested object), so we decode it here. Pegasus sometimes
        mis-escapes that string and then repeats the tail forever (a real, observed
        failure on multi-string schemas), which is why the decode is tolerant and why
        a mangled body is retried ONCE with the schema described in the prompt
        instead of as a ``response_format``. Anything still unparseable degrades to an
        empty object — the parsers then honestly return nothing rather than
        fabricating a map.

        Each call is bounded by :func:`pegasus_timeout_seconds` for the video's duration,
        not by the client's flat timeout (see :data:`PEGASUS_SECONDS_PER_MEDIA_SECOND`).

        :param duration_seconds: The video's duration, which sizes the read bound.
        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        bound = RequestOptions(
            timeout_in_seconds=math.ceil(pegasus_timeout_seconds(duration_seconds))
        )
        with self._translate_errors(pegasus=True):
            resp = self._sdk.analyze(
                model_name=DEFAULT_PEGASUS_MODEL_NAME,
                video=VideoContext_AssetId(asset_id=asset_ref),
                prompt=prompt,
                temperature=0.2,
                response_format=SyncResponseFormat(type="json_schema", json_schema=schema),
                request_options=bound,
            )
        decoded = _decode_analyze_json(resp.data)
        if decoded is not None:
            return decoded
        _log.warning(
            "twelvelabs /analyze returned unparseable structured body, retrying without "
            "response_format: asset=%s",
            asset_ref,
        )
        with self._translate_errors(pegasus=True):
            retry = self._sdk.analyze(
                model_name=DEFAULT_PEGASUS_MODEL_NAME,
                video=VideoContext_AssetId(asset_id=asset_ref),
                prompt=(
                    f"{prompt}\n\nReply with JSON only — no prose, no code fence — "
                    f"matching this JSON Schema exactly:\n{json.dumps(schema)}"
                ),
                temperature=0.2,
                request_options=bound,
            )
        return _decode_analyze_json(retry.data) or {}

    def summarize_chapters(
        self, asset_ref: str, *, duration_seconds: float | None = None
    ) -> list[TLChapter]:
        """Pegasus chapter breakdown of an uploaded asset (``POST /analyze``, schema=chapters).

        A time-ordered map of the whole video with no query — the linchpin of
        footage comprehension (plan D1). Chapters are returned in video order; a
        video Pegasus could not chapter yields an empty list (honest).

        :param duration_seconds: The video's duration; sizes the call's read bound.
        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        payload = self._analyze_structured(
            asset_ref,
            "Break this video into sequential chapters that cover the entire "
            "timeline in order, with no gaps or overlaps. For each chapter give "
            "its start and end time in seconds, a short title, and a one-sentence "
            "summary of what is SEEN on screen: who and what is shown, where, and "
            "what they do. Describe the picture, not the dialogue or narration.",
            self._CHAPTER_SCHEMA,
            duration_seconds=duration_seconds,
        )
        chapters = _parse_chapters(payload)
        _log.info(
            "ACT twelvelabs pegasus chapters: asset=%s → %d chapters", asset_ref, len(chapters)
        )
        return chapters

    def summarize_highlights(
        self, asset_ref: str, *, duration_seconds: float | None = None
    ) -> list[TLHighlight]:
        """Pegasus highlight reel of an uploaded asset (``POST /analyze``, schema=highlights).

        The salient moments Pegasus judged worth surfacing, in video order. Empty
        when Pegasus found none (honest, never fabricated).

        :param duration_seconds: The video's duration; sizes the call's read bound.
        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        payload = self._analyze_structured(
            asset_ref,
            "Identify the most salient highlight moments in this video. For each "
            "one give its start and end time in seconds and a short label naming "
            "the moment.",
            self._HIGHLIGHT_SCHEMA,
            duration_seconds=duration_seconds,
        )
        highlights = _parse_highlights(payload)
        _log.info(
            "ACT twelvelabs pegasus highlights: asset=%s → %d highlights",
            asset_ref,
            len(highlights),
        )
        return highlights

    def summarize_gist(self, asset_ref: str, *, duration_seconds: float | None = None) -> TLGist:
        """Pegasus whole-video summary (``POST /analyze``, schema=summary).

        :param duration_seconds: The video's duration; sizes the call's read bound.
        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        payload = self._analyze_structured(
            asset_ref,
            "Summarize this entire video in one concise paragraph describing what "
            "it shows, with no query or filtering.",
            self._SUMMARY_SCHEMA,
            duration_seconds=duration_seconds,
        )
        raw = payload.get("summary")
        summary = raw.strip() if isinstance(raw, str) else ""
        _log.info("ACT twelvelabs pegasus summary: asset=%s → %d chars", asset_ref, len(summary))
        return TLGist(summary=summary)

    def analyze(self, asset_ref: str, prompt: str, *, temperature: float = 0.2) -> str:
        """Open-ended Pegasus generation over an uploaded asset (``POST /analyze``).

        The escape hatch for questions the fixed summarize modes do not cover.
        Returns the generated text (empty when Pegasus produced none).

        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        with self._translate_errors(pegasus=True):
            resp = self._sdk.analyze(
                model_name=DEFAULT_PEGASUS_MODEL_NAME,
                video=VideoContext_AssetId(asset_id=asset_ref),
                prompt=prompt,
                temperature=temperature,
            )
        raw = resp.data
        text = raw.strip() if isinstance(raw, str) else ""
        _log.info(
            "ACT twelvelabs pegasus analyze: asset=%s len(prompt)=%d → %d chars",
            asset_ref,
            len(prompt),
            len(text),
        )
        return text


def _decode_analyze_json(raw: object) -> dict[str, object] | None:
    """Decode a ``/analyze`` body into a JSON object, tolerating Pegasus' escaping bug.

    Pegasus 1.5 usually returns clean JSON, but on schemas with more than one string
    field it can emit a body whose inner quotes are back-slash-escaped and whose tail
    repeats forever (``…"chapter_summary\":\"…"}]}"}]}"}]}``). A strict
    :func:`json.loads` throws on that and the whole footage map goes dark, so:

    1. try the body as-is;
    2. try the longest valid JSON object at its start (:meth:`json.JSONDecoder.raw_decode`
       ignores the repeated tail), optionally after unescaping the stray ``\"``;
    3. give up with ``None`` so the caller can retry or degrade honestly.

    Returns ``None`` — never a partial guess — when nothing decodes to an object.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    # A prose-free code fence occasionally wraps the body on the prompt-only retry.
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        text = text.removeprefix("json").strip()
    start = text.find("{")
    if start < 0:
        return None
    candidates = (text, text[start:], text[start:].replace('\\"', '"'))
    for candidate in candidates:
        try:
            value, _end = json.JSONDecoder().raw_decode(candidate.lstrip())
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _raise_typed(exc: ApiError, *, pegasus: bool) -> NoReturn:
    """Translate an SDK :class:`ApiError` into FramePilot's typed error hierarchy.

    Preserves the pre-SDK status-code contract: 401 (and non-Pegasus 403) → auth,
    except a 403/404 ``read_not_allowed`` (the entity is another account's) →
    :class:`TwelveLabsIndexInaccessibleError`;
    on a generative call 402/403 → no Pegasus entitlement and a 400
    ``index_not_supported_for_generate`` → a Marengo-only index; a 413/415, or a
    400/422 whose ``code`` is about the media (``video_*``/``audio_*``/``file_*``) →
    :class:`TwelveLabsMediaRejectedError`; anything else → a generic failure.
    Messages carry only the status code and machine ``code`` (a media rejection: plain
    words plus the code on the exception) — never the API key or response body text.
    """
    status = exc.status_code or 0
    code = _api_error_code(exc.body)
    if status == 401:
        _log.warning("twelvelabs ✗ rejected the API key (HTTP 401)")
        raise TwelveLabsAuthError("TwelveLabs rejected the API key (HTTP 401).") from exc
    if status in _ENTITY_NOT_READABLE_STATUSES and code == _ENTITY_NOT_READABLE_CODE:
        _log.warning("twelvelabs ✗ entity not readable by this key (HTTP %d %s)", status, code)
        raise TwelveLabsIndexInaccessibleError(
            "The saved TwelveLabs index belongs to a different TwelveLabs account or was deleted."
        ) from exc
    if pegasus and status in (402, 403):
        _log.warning("twelvelabs ✗ not entitled to Pegasus (HTTP %d)", status)
        raise TwelveLabsPegasusUnavailableError(
            f"TwelveLabs account is not entitled to Pegasus (HTTP {status})."
        ) from exc
    if status == 403:
        _log.warning("twelvelabs ✗ rejected the API key (HTTP 403)")
        raise TwelveLabsAuthError("TwelveLabs rejected the API key (HTTP 403).") from exc
    if pegasus and status == 400 and code == "index_not_supported_for_generate":
        _log.warning("twelvelabs ✗ index has no Pegasus model (HTTP 400)")
        raise TwelveLabsIndexNotGenerativeError(
            "TwelveLabs index does not support generate (no Pegasus model); "
            "re-index to enable the Pegasus footage map."
        ) from exc
    if _is_media_rejection(status, code):
        _log.warning("twelvelabs ✗ media rejected (HTTP %d code=%s)", status, code or "-")
        rejection_code = code or f"http_{status}"
        raise TwelveLabsMediaRejectedError(
            _media_rejection_message(rejection_code, status),
            code=rejection_code,
            http_status=status,
        ) from exc
    _log.warning("twelvelabs ✗ API error (HTTP %d code=%s)", status, code or "-")
    detail = f" ({code})" if code else ""
    raise TwelveLabsError(f"TwelveLabs API error (HTTP {status}){detail}.") from exc


#: Statuses that refuse the media itself whatever the code says: 413 Payload Too Large,
#: 415 Unsupported Media Type.
_MEDIA_REJECTION_STATUSES = frozenset({413, 415})
#: Statuses on which a media-describing ``code`` marks a permanent rejection of the file.
#: Deliberately not 401/403 (the key), 409 (a conflict), 429 (a rate limit), or 5xx
#: (an outage): those can clear, and remembering them would block a file forever.
_MEDIA_CODE_STATUSES = frozenset({400, 422})
#: TwelveLabs names media problems by what they are about: ``video_filesize_too_large``,
#: ``video_duration_too_long``, ``video_resolution_too_low``, ``video_file_broken``…
_MEDIA_CODE_PREFIXES = ("video_", "audio_", "file_")
#: A media-prefixed code that is about a missing RESOURCE, not about the bytes.
_NOT_MEDIA_CODE_SUFFIXES = ("_not_found",)

#: Plain-words reason per media-code fragment, most specific first. A video editor reads
#: these in the panel; the machine code stays on the exception for logs and logic.
_MEDIA_REJECTION_PHRASES: tuple[tuple[str, str], ...] = (
    ("filesize", "the file is larger than TwelveLabs accepts"),
    ("too_large", "the file is larger than TwelveLabs accepts"),
    ("duration_too_long", "the video is too long"),
    ("duration_too_short", "the video is too short"),
    ("aspect", "its aspect ratio is not supported"),
    ("resolution_too_low", "its resolution is too low"),
    ("resolution_too_high", "its resolution is too high"),
    ("resolution", "its resolution is not supported"),
    ("broken", "the file could not be read and may be damaged"),
    ("corrupt", "the file could not be read and may be damaged"),
    ("codec", "its codec is not supported"),
    ("format", "its format is not supported"),
    ("unsupported", "its format is not supported"),
)


def _is_media_rejection(status: int, code: str | None) -> bool:
    """Whether an API error refuses the FILE itself — permanent for these bytes."""
    if status in _MEDIA_REJECTION_STATUSES:
        return True
    if status not in _MEDIA_CODE_STATUSES or not code:
        return False
    return code.startswith(_MEDIA_CODE_PREFIXES) and not code.endswith(_NOT_MEDIA_CODE_SUFFIXES)


def _media_rejection_message(
    code: str | None, http_status: int | None, file_name: str | None = None
) -> str:
    """A video editor's sentence for a media rejection ("TwelveLabs can't index ro.mp4: …").

    Falls back to the machine code in parentheses when the code is one we have no words
    for, so the message is never less informative than the raw error was.
    """
    subject = file_name or "this file"
    phrase: str | None = None
    for fragment, words in _MEDIA_REJECTION_PHRASES:
        if code and fragment in code:
            phrase = words
            break
    if phrase is None and http_status == 413:
        phrase = "the file is larger than TwelveLabs accepts"
    if phrase is None and http_status == 415:
        phrase = "its format is not supported"
    if phrase is None:
        return f"TwelveLabs can't index {subject} ({code or f'HTTP {http_status}'})."
    return f"TwelveLabs can't index {subject}: {phrase}."


def _format_size(size_bytes: int) -> str:
    """A file size the way a video editor reads one: ``12.3 GB`` / ``250 MB`` (decimal)."""
    if size_bytes >= 1000**3:
        gigabytes = f"{size_bytes / 1000**3:.1f}".removesuffix(".0")
        return f"{gigabytes} GB"
    return f"{size_bytes / 1000**2:.0f} MB"


def _presigned_url_map(chunks: Sequence[PresignedUrlChunk] | None) -> dict[int, str]:
    """``chunk_index → url`` for the presigned URLs a multipart response carried."""
    return {
        chunk.chunk_index: chunk.url
        for chunk in chunks or ()
        if isinstance(chunk.chunk_index, int) and isinstance(chunk.url, str) and chunk.url
    }


def _api_error_code(body: object) -> str | None:
    """The ``code`` field of an SDK error body, or ``None``.

    TwelveLabs error bodies carry a stable machine ``code`` (e.g.
    ``index_not_supported_for_generate``) alongside the human ``message``. The SDK
    exposes the parsed body on :attr:`ApiError.body`; a non-dict body yields
    ``None`` so classification falls through to generic handling.
    """
    if isinstance(body, dict):
        code = body.get("code")
        return code if isinstance(code, str) else None
    return None


def _clips_from_items(items: Sequence[Any] | None) -> list[TLClip]:
    """Map SDK ``SearchItem`` rows (``SearchResults.data``) into :class:`TLClip`s, best-first.

    A row missing ``video_id`` or timing is skipped rather than fabricated — the
    caller sees fewer clips, never a wrong one.

    WHY the ``rank`` handling: Marengo 3.0's search returns ``rank`` (1 = best) and
    **no** ``score`` field, so a clip's relevance is derived as ``1/rank`` (the SDK
    model has no ``score`` at all). Without it every clip defaulted to ``score=0``
    and the orchestrator could not rank scenes. Results are sorted by ``rank``
    ascending so the caller always gets best-first order even if the API returns
    them unsorted.
    """
    if not items:
        return []
    clips: list[TLClip] = []
    for fallback_rank, item in enumerate(items, start=1):
        video_id = getattr(item, "video_id", None)
        start = getattr(item, "start", None)
        end = getattr(item, "end", None)
        if not isinstance(video_id, str) or not video_id:
            continue
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        raw_rank = getattr(item, "rank", None)
        rank = int(raw_rank) if isinstance(raw_rank, int) and raw_rank > 0 else fallback_rank
        score = 1.0 / rank
        transcription = getattr(item, "transcription", None)
        clips.append(
            TLClip(
                video_id=video_id,
                start=float(start),
                end=float(end),
                score=score,
                confidence=None,
                transcription=(
                    transcription if isinstance(transcription, str) and transcription else None
                ),
                rank=rank,
            )
        )
    clips.sort(key=lambda clip: clip.rank)
    return clips


def _words_from_items(items: Sequence[Any] | None) -> list[TLWord]:
    """Map SDK ``TranscriptionDataItem`` rows into :class:`TLWord`s.

    A row missing timing or a value is skipped rather than fabricated. Words are
    returned in the API's order (spoken order); a video with no speech (or no
    ``transcription`` on the response) yields an empty list.
    """
    if not items:
        return []
    words: list[TLWord] = []
    for item in items:
        start = getattr(item, "start", None)
        end = getattr(item, "end", None)
        value = getattr(item, "value", None)
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        if not isinstance(value, str) or not value:
            continue
        words.append(TLWord(start=float(start), end=float(end), value=value))
    return words


def _parse_chapters(payload: dict[str, object]) -> list[TLChapter]:
    """Map an ``/analyze`` (chapter schema) response's ``chapters[]`` into :class:`TLChapter`s.

    The chapter schema names the fields ``start_sec``/``end_sec``/``chapter_title``/
    ``chapter_summary``. A row missing timing is skipped rather than fabricated;
    chapters are returned in the API's order and re-sorted by start time so the
    caller always gets a clean time-ordered walk.
    """
    raw = payload.get("chapters")
    if not isinstance(raw, list):
        return []
    chapters: list[TLChapter] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        start = item.get("start_sec")
        end = item.get("end_sec")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        title = item.get("chapter_title")
        summary = item.get("chapter_summary")
        chapters.append(
            TLChapter(
                start=float(start),
                end=float(end),
                title=(title if isinstance(title, str) and title else f"Chapter {index + 1}"),
                summary=summary if isinstance(summary, str) else "",
            )
        )
    chapters.sort(key=lambda chapter: chapter.start)
    return chapters


def _parse_highlights(payload: dict[str, object]) -> list[TLHighlight]:
    """Map an ``/analyze`` (highlight schema) ``highlights[]`` into :class:`TLHighlight`s.

    The highlight schema names the fields ``start_sec``/``end_sec`` and the label
    ``highlight`` (with an optional ``highlight_summary``). A row missing timing is
    skipped; highlights are re-sorted by start time.
    """
    raw = payload.get("highlights")
    if not isinstance(raw, list):
        return []
    highlights: list[TLHighlight] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        start = item.get("start_sec")
        end = item.get("end_sec")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        label = item.get("highlight")
        if not isinstance(label, str) or not label:
            label = item.get("highlight_summary")
        highlights.append(
            TLHighlight(
                start=float(start),
                end=float(end),
                label=(label if isinstance(label, str) and label else f"Highlight {index + 1}"),
            )
        )
    highlights.sort(key=lambda highlight: highlight.start)
    return highlights


def resolve_twelvelabs(
    api_key: str | None,
    *,
    http: httpx.Client | None = None,
    http_factory: Callable[[], httpx.Client] | None = None,
) -> TwelveLabsClientResolution:
    """The TwelveLabs capability gate (mirrors ``resolve_visual_embedder``).

    No configured key is the shipped default: the caller falls back to the
    built-in indexer instead of talking to TwelveLabs. ``http``/``http_factory``
    exist so tests inject a mocked client; production uses a real one.

    :param api_key: The plaintext ``TWELVELABS_API_KEY`` (host body or env).
    """
    key = api_key.strip() if api_key else ""
    if not key:
        return TwelveLabsClientResolution(client=None, reason=NO_API_KEY_REASON)
    if http is None:
        http = http_factory() if http_factory is not None else httpx.Client()
    return TwelveLabsClientResolution(client=TwelveLabsClient(key, http=http))
