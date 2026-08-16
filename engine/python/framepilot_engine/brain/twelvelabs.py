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
  index → :class:`TwelveLabsIndexNotGenerativeError`); the routes translate that
  into an ``available=True`` response carrying a typed ``reason``, never a
  fabricated result. TwelveLabs never fabricates a video the user did not upload.
- **Secrets stay out of logs.** Only HTTP status codes, index/video/task ids, and
  result counts are logged; never the API key or media bytes.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, NoReturn

import httpx
from twelvelabs import IndexesCreateRequestModelsItem, SyncResponseFormat
from twelvelabs import TwelveLabs as _TwelveLabsSDK
from twelvelabs.core.api_error import ApiError
from twelvelabs.core.request_options import RequestOptions

_log = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_INDEX_OPTIONS",
    "DEFAULT_MODEL_NAME",
    "DEFAULT_SEARCH_OPTIONS",
    "DEFAULT_TIMEOUT_SECONDS",
    "DEFAULT_TRANSCRIPTION_OPTIONS",
    "NO_API_KEY_REASON",
    "PEGASUS_UNAVAILABLE_REASON",
    "TLChapter",
    "TLClip",
    "TLGist",
    "TLHighlight",
    "TLWord",
    "TaskStatus",
    "TwelveLabsAuthError",
    "TwelveLabsClient",
    "TwelveLabsClientResolution",
    "TwelveLabsError",
    "TwelveLabsIndexNotGenerativeError",
    "TwelveLabsPegasusUnavailableError",
    "resolve_twelvelabs",
]

#: TwelveLabs REST base (API version 1.3).
DEFAULT_BASE_URL = "https://api.twelvelabs.io/v1.3"

#: The Marengo model powers search + embeddings (visual + audio understanding).
#: Pinned so a stored index's model is explicit; a model change means a new index.
DEFAULT_MODEL_NAME = "marengo3.0"

#: The Pegasus model powers **generative** understanding — the footage map
#: (chapters / highlights / summary) via ``POST /analyze``. An index MUST include a
#: Pegasus model or ``/analyze`` answers HTTP 400 ``index_not_supported_for_generate``
#: (an index is Marengo-only unless Pegasus is added at creation time). Including it
#: roughly doubles indexing cost/time, so it is explicit here rather than implied.
DEFAULT_PEGASUS_MODEL_NAME = "pegasus1.2"

#: Modalities Pegasus generates over. Same visual+audio surface as Marengo indexing.
DEFAULT_PEGASUS_OPTIONS = ("visual", "audio")

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


@dataclass(frozen=True)
class TaskStatus:
    """State of one media-indexing operation.

    ``task_id`` may advance from an uploaded-asset token to an indexed-asset token;
    callers persist the returned value so polling remains resumable. ``video_id``
    is populated only once ``status == "ready"``; ``done`` is True for both a
    ready and a failed task.
    """

    task_id: str
    status: str
    video_id: str | None

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
    ) -> None:
        self._model_name = model_name
        self._timeout = timeout
        self._upload_timeout = upload_timeout
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
        """Create an index with **both** models (visual + audio) and return its id.

        The index carries Marengo (search + embeddings) **and** Pegasus (generative
        understanding). Pegasus is required for the footage map's ``/analyze`` calls;
        an index missing it answers HTTP 400 ``index_not_supported_for_generate``.
        Creating both up front means one indexing pass serves both search and the map.

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
                    IndexesCreateRequestModelsItem(
                        model_name=DEFAULT_PEGASUS_MODEL_NAME,
                        model_options=list(DEFAULT_PEGASUS_OPTIONS),
                    ),
                ],
            )
        index_id = resp.id
        if not isinstance(index_id, str) or not index_id:
            raise TwelveLabsError("TwelveLabs index create returned no id.")
        _log.info("ACT twelvelabs index created: %s", index_id)
        return index_id

    # -- indexing tasks ---------------------------------------------------------

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        """Upload a local media asset and return a resumable polling token.

        This deliberately uses TwelveLabs' current two-step asset workflow. The
        legacy ``/tasks`` endpoint accepts only ``video_file`` and therefore
        reports an MP3 as ``video_file_broken``. ``POST /assets`` accepts both
        audio and video; :meth:`get_task` attaches the ready upload to the index
        and then polls that indexed asset without blocking a request thread.

        :raises TwelveLabsError: On any API/transport failure.
        """
        size_bytes = media_path.stat().st_size if media_path.exists() else -1
        _log.info(
            "ACT twelvelabs upload start: index=%s file=%s size=%.1fMB",
            index_id,
            media_path.name,
            size_bytes / (1024 * 1024) if size_bytes >= 0 else -1.0,
        )
        started = time.monotonic()
        media_type = mimetypes.guess_type(media_path.name)[0] or "application/octet-stream"
        with media_path.open("rb") as handle, self._translate_errors():
            resp = self._sdk.assets.create(
                method="direct",
                file=(media_path.name, handle, media_type),
                request_options=RequestOptions(timeout_in_seconds=int(self._upload_timeout)),
            )
        asset_id = resp.id
        if not isinstance(asset_id, str) or not asset_id:
            raise TwelveLabsError("TwelveLabs asset upload returned no id.")
        task_id = _task_token(_ASSET_TASK_PREFIX, index_id, asset_id)
        _log.info(
            "ACT twelvelabs upload done: asset=%s index=%s in %.1fs",
            asset_id,
            index_id,
            time.monotonic() - started,
        )
        return task_id

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
        """Wait for an upload, then attach it to the requested index exactly once."""
        with self._translate_errors():
            asset = self._sdk.assets.retrieve(asset_id)
        asset_status = asset.status
        if not isinstance(asset_status, str):
            raise TwelveLabsError("TwelveLabs asset status missing.")
        if asset_status == _TASK_FAILED:
            return TaskStatus(task_id=task_id, status=_TASK_FAILED, video_id=None)
        if asset_status != _TASK_READY:
            return TaskStatus(task_id=task_id, status=asset_status, video_id=None)

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
        return TaskStatus(task_id=next_task_id, status="indexing", video_id=None)

    def _poll_indexed_asset(self, task_id: str, index_id: str, indexed_asset_id: str) -> TaskStatus:
        """Poll an asset after it has been attached to an index."""
        with self._translate_errors():
            indexed = self._sdk.indexes.indexed_assets.retrieve(index_id, indexed_asset_id)
        indexed_status = indexed.status
        if not isinstance(indexed_status, str):
            raise TwelveLabsError("TwelveLabs indexed-asset status missing.")
        video_id = indexed_asset_id if indexed_status == _TASK_READY else None
        _log.debug(
            "twelvelabs indexed asset poll: indexed_asset=%s status=%s",
            indexed_asset_id,
            indexed_status,
        )
        return TaskStatus(task_id=task_id, status=indexed_status, video_id=video_id)

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
        self, video_id: str, prompt: str, schema: dict[str, Any]
    ) -> dict[str, object]:
        """One ``POST /analyze`` with a JSON-schema ``response_format`` → parsed object.

        ``/analyze`` returns the schema-conforming output as a **JSON string** in
        ``data`` (not a nested object), so we decode it here. A missing or
        non-string ``data``, or one that is not valid JSON, degrades to an empty
        object — the summarize parsers then honestly return nothing rather than a
        fabricated map.

        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        with self._translate_errors(pegasus=True):
            resp = self._sdk.analyze(
                video_id=video_id,
                prompt=prompt,
                temperature=0.2,
                response_format=SyncResponseFormat(type="json_schema", json_schema=schema),
            )
        raw = resp.data
        if not isinstance(raw, str) or not raw.strip():
            return {}
        try:
            decoded = json.loads(raw)
        except json.JSONDecodeError:
            _log.warning(
                "twelvelabs /analyze returned non-JSON structured body: video=%s", video_id
            )
            return {}
        return decoded if isinstance(decoded, dict) else {}

    def summarize_chapters(self, video_id: str) -> list[TLChapter]:
        """Pegasus chapter breakdown of a ready video (``POST /analyze``, schema=chapters).

        A time-ordered map of the whole video with no query — the linchpin of
        footage comprehension (plan D1). Chapters are returned in video order; a
        video Pegasus could not chapter yields an empty list (honest).

        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        payload = self._analyze_structured(
            video_id,
            "Break this video into sequential chapters that cover the entire "
            "timeline in order, with no gaps or overlaps. For each chapter give "
            "its start and end time in seconds, a short title, and a one-sentence "
            "summary of what happens.",
            self._CHAPTER_SCHEMA,
        )
        chapters = _parse_chapters(payload)
        _log.info(
            "ACT twelvelabs pegasus chapters: video=%s → %d chapters", video_id, len(chapters)
        )
        return chapters

    def summarize_highlights(self, video_id: str) -> list[TLHighlight]:
        """Pegasus highlight reel of a ready video (``POST /analyze``, schema=highlights).

        The salient moments Pegasus judged worth surfacing, in video order. Empty
        when Pegasus found none (honest, never fabricated).

        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        payload = self._analyze_structured(
            video_id,
            "Identify the most salient highlight moments in this video. For each "
            "one give its start and end time in seconds and a short label naming "
            "the moment.",
            self._HIGHLIGHT_SCHEMA,
        )
        highlights = _parse_highlights(payload)
        _log.info(
            "ACT twelvelabs pegasus highlights: video=%s → %d highlights",
            video_id,
            len(highlights),
        )
        return highlights

    def summarize_gist(self, video_id: str) -> TLGist:
        """Pegasus whole-video summary (``POST /analyze``, schema=summary).

        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        payload = self._analyze_structured(
            video_id,
            "Summarize this entire video in one concise paragraph describing what "
            "it shows, with no query or filtering.",
            self._SUMMARY_SCHEMA,
        )
        raw = payload.get("summary")
        summary = raw.strip() if isinstance(raw, str) else ""
        _log.info("ACT twelvelabs pegasus summary: video=%s → %d chars", video_id, len(summary))
        return TLGist(summary=summary)

    def analyze(self, video_id: str, prompt: str, *, temperature: float = 0.2) -> str:
        """Open-ended Pegasus generation over a video (``POST /analyze``).

        The escape hatch for questions the fixed summarize modes do not cover.
        Returns the generated text (empty when Pegasus produced none).

        :raises TwelveLabsAuthError: On 401 (key rejected).
        :raises TwelveLabsPegasusUnavailableError: On 402/403 (no Pegasus entitlement).
        :raises TwelveLabsError: On any other API/transport failure.
        """
        with self._translate_errors(pegasus=True):
            resp = self._sdk.analyze(video_id=video_id, prompt=prompt, temperature=temperature)
        raw = resp.data
        text = raw.strip() if isinstance(raw, str) else ""
        _log.info(
            "ACT twelvelabs pegasus analyze: video=%s len(prompt)=%d → %d chars",
            video_id,
            len(prompt),
            len(text),
        )
        return text


def _raise_typed(exc: ApiError, *, pegasus: bool) -> NoReturn:
    """Translate an SDK :class:`ApiError` into FramePilot's typed error hierarchy.

    Preserves the pre-SDK status-code contract: 401 (and non-Pegasus 403) → auth;
    on a generative call 402/403 → no Pegasus entitlement and a 400
    ``index_not_supported_for_generate`` → a Marengo-only index; anything else →
    a generic failure. Messages carry only the status code and machine ``code`` —
    never the API key or response body text.
    """
    status = exc.status_code or 0
    code = _api_error_code(exc.body)
    if status == 401:
        _log.warning("twelvelabs ✗ rejected the API key (HTTP 401)")
        raise TwelveLabsAuthError("TwelveLabs rejected the API key (HTTP 401).") from exc
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
    _log.warning("twelvelabs ✗ API error (HTTP %d code=%s)", status, code or "-")
    detail = f" ({code})" if code else ""
    raise TwelveLabsError(f"TwelveLabs API error (HTTP {status}){detail}.") from exc


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
