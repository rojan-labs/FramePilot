"""FastAPI sidecar service for the FramePilot engine.

WHY: the Electron desktop shell offloads all rendering, validation, and media
inspection to this local HTTP service over typed IPC (PRD §10.2, plan 2.4).
Keeping render work out of the renderer process is a hard architecture rule
(PRD §9.2) — it keeps the UI responsive and the render path deterministic.

Routes delegate to the render/validation/inspection modules and use pydantic
request/response models so the IPC contract is concrete and self-documenting.

``/render`` (final export) is wired to the async ``RenderQueue`` (plan H1.3):
it submits the job and returns ``202`` immediately with a ``jobId`` to poll via
``GET /render/jobs/{job_id}``; it no longer blocks the HTTP request until
FFmpeg finishes. ``/render/preview`` stays synchronous — previews are cheap
(downscaled, short) and callers expect an immediate result, unlike a full
export (see ``render_preview_route``'s docstring for the full rationale).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator
from pydantic import ValidationError as PydanticValidationError

from framepilot_engine import __version__
from framepilot_engine.analysis.beats import DEFAULT_SENSITIVITY, Beat, detect_beats
from framepilot_engine.analysis.black import (
    DEFAULT_MIN_BLACK_SECONDS,
    DEFAULT_PICTURE_THRESHOLD,
    DEFAULT_PIXEL_THRESHOLD,
    detect_black,
)
from framepilot_engine.analysis.freeze import (
    DEFAULT_FREEZE_NOISE_DB,
    DEFAULT_MIN_FREEZE_SECONDS,
    detect_freezes,
)
from framepilot_engine.analysis.loudness import measure_loudness
from framepilot_engine.analysis.scenes import DEFAULT_SCENE_THRESHOLD, SceneCut, detect_scenes
from framepilot_engine.analysis.silence import (
    DEFAULT_MIN_SILENCE_SECONDS,
    DEFAULT_NOISE_FLOOR_DB,
    SilentRange,
    detect_silence,
)
from framepilot_engine.analysis.tiers import (
    ANALYZER_VERSIONS,
    AnalysisDepth,
    AnalysisKind,
    analysis_params_hash,
    kinds_for,
)
from framepilot_engine.analysis.visual_sampler import SAMPLER_VERSION, VisualSpan
from framepilot_engine.audio.asr import (
    DEFAULT_ASR_MODEL,
    AsrError,
    AsrModelChecksumError,
    AsrModelMissingError,
    AsrSetupBusyError,
    AsrSetupCancelledError,
    AsrSetupProgress,
    AsrSetupState,
    AsrSetupTracker,
    WhisperCliNotFoundError,
    extract_mono16k_wav,
    transcribe,
)
from framepilot_engine.audio.asr import get_status as get_status
from framepilot_engine.brain.captioner import (
    CaptionError,
    CaptionProviderConfig,
    CaptionProviderKind,
    SceneCaptioner,
    is_informative_caption,
    resolve_captioner,
)
from framepilot_engine.brain.embeddings import EmbedderResolution, resolve_embedder
from framepilot_engine.brain.fts import segment_utterances
from framepilot_engine.brain.keyring import EXHAUSTED_REASON, KeyRingExhaustedError, parse_keys
from framepilot_engine.brain.memory import (
    append_memory_entry,
    asset_section,
    bin_summary_path,
    latest_session_note,
    read_tier,
    tail_entries,
    write_bin_summary,
)
from framepilot_engine.brain.models import (
    AnalysisResultRow,
    AssetRow,
    BrainStatus,
    JobRow,
    JobState,
    MemoryEntry,
    MemoryTier,
    SearchHit,
    SessionContext,
    VisualCaptionRow,
    VisualSpanRow,
    VisualVectorRow,
)
from framepilot_engine.brain.sidecars import export_asset_sidecar, import_sidecars
from framepilot_engine.brain.similar import (
    AssetDigest,
    blend_hits,
    build_embedding_rows,
    semantic_hits,
)
from framepilot_engine.brain.soul import (
    SoulDoc,
    append_soul_note,
    note_correction,
    soul_digest,
    soul_root,
)
from framepilot_engine.brain.store import (
    BRAIN_FILENAME,
    BrainError,
    BrainSchemaError,
    BrainStore,
    brain_dir_for,
    brain_status,
    open_brain,
)
from framepilot_engine.brain.twelvelabs import (
    PEGASUS_UNAVAILABLE_REASON,
    TwelveLabsAuthError,
    TwelveLabsClient,
    TwelveLabsError,
    TwelveLabsIndexNotGenerativeError,
    TwelveLabsPegasusUnavailableError,
    resolve_twelvelabs,
)
from framepilot_engine.brain.twelvelabs_index import (
    chapters_to_packets,
    clips_to_packets,
    map_pegasus_chapters,
    map_pegasus_highlights,
    poll_index_asset,
    read_cached_pegasus,
    read_index_id,
    read_video_mapping,
    store_cached_pegasus,
    store_index_id,
    store_video_mapping,
    video_to_asset_map,
)
from framepilot_engine.brain.vector_store import VisualVectorStore
from framepilot_engine.brain.visual_embed import (
    MODEL_ID,
    VisualEmbedClient,
    VisualEmbedderResolution,
    VisualEmbedError,
    resolve_visual_embedder,
)
from framepilot_engine.brain.visual_search import (
    EvidencePacket,
    build_evidence_packets,
    project_span_to_timeline,
    transcript_overlap,
)
from framepilot_engine.config import Settings, get_settings
from framepilot_engine.media.derive import PROXY_ENCODE_VERSION, generate_proxy, generate_thumbnails
from framepilot_engine.media.ffmpeg import FFmpegError, NoAudioStreamError
from framepilot_engine.media.probe import MediaInfo, inspect_media
from framepilot_engine.media.waveform import extract_waveform
from framepilot_engine.render.frame_grab import (
    DEFAULT_MAX_DIMENSION,
    FrameGrabError,
    grab_frame,
)
from framepilot_engine.render.pipeline import RenderJob, RenderOptions, render
from framepilot_engine.render.queue import JobStatus, RenderQueue, RenderTask
from framepilot_engine.render.queue import RenderRequest as QueuedRenderRequest
from framepilot_engine.safety import PathTraversalError, resolve_within
from framepilot_engine.timeline.models import Project, ProjectFile, ProjectFileError
from framepilot_engine.validation.render_validation import (
    ExpectedRender,
    ValidationReport,
    validate_render,
)
from framepilot_engine.validation.temporal_evidence import (
    TemporalEvidenceBatch,
    TemporalEvidenceError,
    TemporalEvidenceRequest,
    acquire_temporal_evidence,
)
from framepilot_engine.visual_indexing import (
    FrameExtractionError,
    extract_keyframe_jpeg,
    sample_asset,
)

_log = logging.getLogger(__name__)

_LOGGING_CONFIGURED = False


def configure_logging() -> None:
    """Install a console handler on the ``framepilot_engine`` logger tree (idempotent).

    WHY: the engine's modules log via ``logging.getLogger(__name__)`` but nothing
    installs a handler, so those lines are swallowed unless the host (uvicorn/pytest)
    happens to configure the root logger. This makes the engine log every action to
    stderr on its own. The level is ``FRAMEPILOT_LOG_LEVEL`` (default ``INFO``),
    matching the TypeScript logger's env var so the whole stack shares one control.
    """
    global _LOGGING_CONFIGURED
    if _LOGGING_CONFIGURED:
        return
    level_name = os.environ.get("FRAMEPILOT_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    engine_logger = logging.getLogger("framepilot_engine")
    engine_logger.setLevel(level)
    if not engine_logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
        engine_logger.addHandler(handler)
    engine_logger.propagate = False
    _LOGGING_CONFIGURED = True


# --- Request / response models (the IPC contract) ----------------------------


class HealthResponse(BaseModel):
    """Liveness payload for ``GET /health``."""

    status: str = "ok"
    version: str = __version__


class RenderRequest(BaseModel):
    """Request body for ``POST /render`` (final export, PRD §9.3)."""

    project_path: str = Field(description="Path to the project.fp.json to render.")
    preset: str | None = Field(default=None, description="Export preset id (see render.presets).")
    burn_captions: bool = Field(
        default=False, description="Burn caption-track text into the output (plan 3.3)."
    )
    denoise: bool = Field(default=False, description="Master-bus broadband de-noise (plan 6).")
    eq: str | None = Field(
        default=None, description="EQ preset: flat|warm|bright|voice-clarity (plan H1.4)."
    )
    compression: str | None = Field(
        default=None, description="Compression preset: voice (plan H1.4)."
    )
    loudness: str | None = Field(
        default=None, description="Loudness preset: social|podcast|broadcast (plan 6)."
    )
    limiter: bool = Field(default=False, description="Master-bus brick-wall limiter (plan 6).")


class RenderPreviewRequest(BaseModel):
    """Request body for ``POST /render/preview`` (fast, low-res)."""

    project_path: str = Field(description="Path to the project.fp.json to preview.")
    preset: str | None = Field(default=None, description="Export preset id (see render.presets).")
    burn_captions: bool = Field(
        default=False, description="Burn caption-track text into the output (plan 3.3)."
    )


class RenderAcceptedResponse(BaseModel):
    """Immediate ``202`` body for ``POST /render`` (plan H1.3).

    WHY a dedicated model instead of the old ``RenderJob``: the job hasn't run
    yet, so there is no state/output/validation to report — only an id to poll.
    Poll ``GET /render/jobs/{job_id}`` for progress and, on completion, the
    ``RenderJob``-compatible result.
    """

    job_id: str = Field(alias="jobId", description="Submitted render task id.")
    status: JobStatus = Field(default=JobStatus.QUEUED)

    model_config = {"populate_by_name": True}


class ValidateRenderRequest(BaseModel):
    """Request body for ``POST /validate-render`` (PRD §9.4)."""

    output_path: str = Field(description="Path to the rendered output to validate.")
    expected_duration_seconds: float | None = Field(
        default=None, description="Expected timeline duration for tolerance checks."
    )
    expect_audio: bool = Field(default=True, description="Whether an audio stream is expected.")
    expect_video: bool = Field(default=True, description="Whether a video stream is expected.")


class InspectMediaRequest(BaseModel):
    """Request body for ``POST /inspect-media`` (plan 2.1)."""

    input_path: str = Field(description="Path to the media file to probe.")


class AssetMediaRequest(BaseModel):
    """Request body for ``POST /asset-media`` (plan Phase 8 — desktop import)."""

    input_path: str = Field(description="Path to the source media to import.")
    buckets: int = Field(default=400, ge=1, description="Waveform peak buckets to produce.")
    thumbnails: int = Field(
        default=5,
        ge=0,
        le=20,
        description="Number of timeline thumbnails to derive for video (0 = skip).",
    )
    proxy: bool = Field(
        default=False,
        description=(
            "Also derive a low-res preview proxy for video (H3). Idempotent: a "
            "previously derived proxy for the same source is reused; sources longer "
            "than the configured cap are skipped (background derivation follow-up)."
        ),
    )
    project_id: str | None = Field(
        default=None,
        alias="projectId",
        description=(
            "Project whose brain should record this import (plan B0.4). "
            "Requires asset_id; omitted → no brain write (back-compat)."
        ),
    )
    asset_id: str | None = Field(
        default=None,
        alias="assetId",
        description="The project asset id the imported media belongs to.",
    )

    model_config = {"populate_by_name": True}


class AssetMediaResponse(BaseModel):
    """Engine-derived media for an imported asset (mirrors TS ``AssetMedia`` plus
    the probed duration/kind so the desktop import can build a schema ``Asset``).
    Serialized with the TS camelCase aliases the renderer expects."""

    duration_seconds: float | None = Field(default=None, alias="durationSeconds")
    kind: str = Field(description="One of 'video' | 'audio' | 'image'.")
    peaks: list[float] | None = Field(default=None)
    peaks_per_second: float | None = Field(default=None, alias="peaksPerSecond")
    thumbnail_paths: list[str] | None = Field(default=None, alias="thumbnailPaths")
    proxy_path: str | None = Field(default=None, alias="proxyPath")
    brain_recorded: bool = Field(
        default=False,
        alias="brainRecorded",
        description="Whether this import was persisted to the project brain (plan B0.4).",
    )

    model_config = {"populate_by_name": True}


class BrainRebuildRequest(BaseModel):
    """Request body for ``POST /brain/rebuild`` (plan B0.4)."""

    project_id: str = Field(alias="projectId", description="Project whose brain to rebuild.")

    model_config = {"populate_by_name": True}


class BrainRebuildResponse(BaseModel):
    """Result of dropping and re-deriving a project brain from its sidecars."""

    imported: int = Field(description="How many asset sidecars were re-imported.")
    status: BrainStatus

    model_config = {"populate_by_name": True}


class BrainAnalysisResponse(BaseModel):
    """Persisted analysis rows for ``GET /brain/analysis`` (plan B1.3/B1.4).

    ``available=False`` is the honest-unavailable shape: a missing sandbox
    root or brain reports *why* with zero rows, never an error or a fabricated
    empty success.
    """

    available: bool
    reason: str | None = None
    results: list[AnalysisResultRow] = Field(default_factory=list)


class BrainJobsResponse(BaseModel):
    """Journaled jobs for ``GET /brain/jobs`` (plan B5.1).

    Same honest-unavailable shape as :class:`BrainAnalysisResponse`: a missing
    sandbox root or unopenable brain reports ``available=False`` with the
    reason and zero jobs, never an error or a fabricated empty success. The
    listed jobs include any flagged ``interrupted`` by the sidecar-restart
    sweep, so work cut off by a crash/restart is visible rather than silently
    lost.
    """

    available: bool
    reason: str | None = None
    jobs: list[JobRow] = Field(default_factory=list)


class BrainMemoryRequest(BaseModel):
    """Request body for ``POST /brain/memory`` (plan B6.1/B6.2).

    One append to a project's narrative memory. A ``corrections`` entry is also
    offered to the cross-project promotion heuristic (B6.2) — the same
    correction in a second project promotes it to the soul. ``soulDoc`` is the
    explicit "remember this across projects" escape hatch, which writes the
    named soul document directly instead of waiting for a repeat.
    """

    project_id: str = Field(alias="projectId", description="Project whose memory to append to.")
    tier: MemoryTier
    title: str = Field(min_length=1, description="One-line summary — the entry's heading.")
    body: str = Field(default="", description="Free prose: the reason, the detail.")
    patch_id: str | None = Field(
        default=None,
        alias="patchId",
        description="Patch this entry refers to; keeps the prose traceable (B6.4).",
    )
    soul_doc: SoulDoc | None = Field(
        default=None,
        alias="soulDoc",
        description="Set to ALSO record this across projects (explicit remember, B6.2).",
    )

    model_config = {"populate_by_name": True}


class BrainMemoryResponse(BaseModel):
    """Result of a memory append.

    Same honest-unavailable shape as the other brain surfaces: no sandbox root
    means there is nowhere to write, reported with a reason rather than an
    error. ``promoted`` reports whether this correction crossed the
    repeated-in-N-projects threshold and reached the soul (B6.2).
    """

    available: bool
    reason: str | None = None
    path: str | None = Field(default=None, description="The tier file written.")
    promoted: bool = Field(
        default=False, description="Whether a correction was promoted to the cross-project soul."
    )
    soul_path: str | None = Field(
        default=None, alias="soulPath", description="The soul document written, if any."
    )

    model_config = {"populate_by_name": True}


class SessionContextRequest(BaseModel):
    """Request body for ``POST /brain/session-context`` (plan B6.3).

    Mirrors ``BrainSearchRequest``'s source handling: the agent loop knows its
    project id directly, while the MCP path knows only the saved project path
    and lets the loaded document supply its own id.
    """

    project_id: str | None = Field(
        default=None,
        alias="projectId",
        description=(
            "Project whose context to assemble. Optional when a project source is "
            "supplied — the loaded document's own id is used."
        ),
    )
    project_path: str | None = Field(
        default=None, description="Saved project to derive the id from (optional)."
    )
    project: dict[str, Any] | None = Field(
        default=None, description="Inline project document to derive the id from (optional)."
    )

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _at_most_one_source(self) -> SessionContextRequest:
        if self.project_path is not None and self.project is not None:
            raise ValueError("Provide at most one of project_path or project.")
        return self


def analyzer_effective_params(kind: AnalysisKind) -> dict[str, Any]:
    """The parameters the unified ``/analyze`` pass runs each analyzer with.

    These feed :func:`analysis_params_hash` — the cache key must reflect what
    actually ran, so this table and ``run_analyzer`` MUST stay in lockstep.
    The unified route always analyses with the defaults; callers needing custom
    parameters use the single-analyzer routes (which do not cache).
    """
    if kind is AnalysisKind.SILENCE:
        return {
            "noiseFloorDb": DEFAULT_NOISE_FLOOR_DB,
            "minSilenceSeconds": DEFAULT_MIN_SILENCE_SECONDS,
        }
    if kind is AnalysisKind.SCENES:
        return {"threshold": DEFAULT_SCENE_THRESHOLD}
    if kind is AnalysisKind.BLACK:
        return {
            "minBlackSeconds": DEFAULT_MIN_BLACK_SECONDS,
            "pictureThreshold": DEFAULT_PICTURE_THRESHOLD,
            "pixelThreshold": DEFAULT_PIXEL_THRESHOLD,
        }
    if kind is AnalysisKind.BEATS:
        return {"sensitivity": DEFAULT_SENSITIVITY}
    if kind is AnalysisKind.FREEZE:
        return {
            "noiseDb": DEFAULT_FREEZE_NOISE_DB,
            "minFreezeSeconds": DEFAULT_MIN_FREEZE_SECONDS,
        }
    if kind is AnalysisKind.TRANSCRIPTION:
        return {"model": DEFAULT_ASR_MODEL}
    return {}  # probe / loudness take no tunables


class AnalysisProjectSource(BaseModel):
    """Shared project-source fields for the analysis routes.

    Callers supply EITHER a saved ``project_path`` (MCP / CLI) OR the live
    ``project`` document inline (the desktop/web agent loop analyses its
    in-memory WORKING copy, which may be unsaved). Media paths declared by an
    inline project are still sandbox-checked before any ffmpeg runs — inlining
    the document never widens what the engine may read.
    """

    project_path: str | None = Field(
        default=None, description="Path to the project.fp.json owning the asset."
    )
    project: dict[str, Any] | None = Field(
        default=None, description="The project document inline (alternative to project_path)."
    )

    @model_validator(mode="after")
    def _exactly_one_source(self) -> AnalysisProjectSource:
        if (self.project_path is None) == (self.project is None):
            raise ValueError("Provide exactly one of project_path or project.")
        return self


class RenderFrameRequest(AnalysisProjectSource):
    """Request body for ``POST /render/frame`` — one composited still.

    WHY a dedicated route rather than reusing ``/render/preview``: a preview is a
    whole encoded video file written to disk for a human to scrub. This is one
    picture, returned inline, for a model to look at. Sharing a route would mean
    encoding a video to answer "what does 12.4s look like?".

    WHY it takes an inline project like the analysis routes (rather than only a
    saved path): the agent asks for a frame to check work it has *just done*, and
    that work lives in an in-memory working copy that has not been saved. A
    path-only route would render the timeline as it was BEFORE the edit under
    review — the one picture guaranteed not to answer the question.
    """

    time_seconds: float = Field(
        description="Timeline time to grab, in seconds. Clamped into the timeline.",
    )
    preset: str | None = Field(
        default=None,
        description="Export preset id; omit to composite at the project's own resolution.",
    )
    max_dimension: int = Field(
        default=DEFAULT_MAX_DIMENSION,
        description="Longest edge of the returned image, in pixels.",
    )
    image_format: str = Field(default="jpeg", description="'jpeg' (small) or 'png' (lossless).")
    burn_captions: bool = Field(
        default=True,
        description="Draw caption text into the frame. Soft captions are invisible otherwise.",
    )


class RenderFrameResponse(BaseModel):
    """One composited frame, inline, as base64 image bytes."""

    media_type: str = Field(description="Image media type, e.g. 'image/jpeg'.")
    base64: str = Field(description="The image bytes, base64-encoded, with no data: prefix.")
    width: int
    height: int
    time_seconds: float = Field(description="The time actually rendered, after clamping.")
    duration_seconds: float = Field(description="The timeline's full duration.")


class TemporalEvidenceBatchRequest(AnalysisProjectSource):
    """A bounded evidence batch against the live working project revision."""

    requests: list[TemporalEvidenceRequest] = Field(
        min_length=1,
        description="Versioned temporal evidence requests from the AI review planner.",
    )


class BrainIndexRequest(AnalysisProjectSource):
    """Request body for ``POST /brain/index`` (plan B2.1).

    The canonical project document (saved or inline) is the only input: the
    FTS tables are rebuilt to mirror it exactly (invariant 1 — the index is
    derived, never truth).
    """

    project_id: str = Field(alias="projectId", description="Project whose brain to index.")

    model_config = {"populate_by_name": True}


class BrainIndexResponse(BaseModel):
    """Result of one FTS ingest pass (plan B2.1).

    ``available=False`` is the honest-unavailable shape: no sandbox root, no
    FTS5 in this SQLite build, or an unopenable brain — with the reason, never
    a fabricated success.
    """

    available: bool
    reason: str | None = None
    utterances: int = Field(default=0, description="Transcript utterances indexed.")
    markers: int = Field(default=0, description="Markers indexed.")
    embedded: int = Field(
        default=0, description="Embedding rows built for similarity search (plan B3.2)."
    )
    embeddings_reason: str | None = Field(
        default=None,
        alias="embeddingsReason",
        description="Why embeddings were NOT built (no model configured/loadable).",
    )

    model_config = {"populate_by_name": True}


class BrainSearchRequest(BaseModel):
    """Request body for ``POST /brain/search`` (plan B2.2).

    A project source is OPTIONAL here (unlike the analysis routes): when the
    caller supplies one — the agent loop always posts its live working copy —
    the FTS index is rebuilt from it before matching, so hits can never be
    stale relative to what the model is editing. Without a source the existing
    index is searched as-is.
    """

    project_id: str | None = Field(
        default=None,
        alias="projectId",
        description=(
            "Project whose brain to search. Optional when a project source is "
            "supplied — the loaded document's own id is used (the MCP path knows "
            "only the saved project path)."
        ),
    )
    query: str = Field(description="Free-text query; reduced to safe FTS terms.")
    limit: int = Field(default=20, ge=1, le=100, description="Max hits to return.")
    project_path: str | None = Field(
        default=None, description="Saved project to re-index before searching (optional)."
    )
    project: dict[str, Any] | None = Field(
        default=None, description="Inline project document to re-index before searching."
    )

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _at_most_one_source(self) -> BrainSearchRequest:
        if self.project_path is not None and self.project is not None:
            raise ValueError("Provide at most one of project_path or project.")
        return self


class BrainSearchResponse(BaseModel):
    """Typed search hits over transcript/markers/asset names (plan B2.2)."""

    available: bool
    reason: str | None = None
    hits: list[SearchHit] = Field(default_factory=list)


class SimilarSearchMode(StrEnum):
    """How a ``/brain/similar`` response was ranked (plan B3.3)."""

    BLENDED = "blended"  # semantic cosine + keyword FTS, weighted merge
    KEYWORD = "keyword"  # no embeddings model → honest FTS-only degrade


class BrainSimilarRequest(BrainSearchRequest):
    """Request body for ``POST /brain/similar`` (plan B3.3).

    Same contract as ``/brain/search`` (optional project source → re-index
    before matching); only the ranking differs.
    """


class BrainSimilarResponse(BaseModel):
    """Similarity hits, blended with keyword matches when possible (plan B3.3).

    ``mode='keyword'`` is the honest degrade: no embeddings model configured
    (or loadable) means the hits are plain keyword matches, with the reason —
    never a fabricated similarity ranking.
    """

    available: bool
    mode: SimilarSearchMode = SimilarSearchMode.KEYWORD
    reason: str | None = None
    hits: list[SearchHit] = Field(default_factory=list)


#: Job ``kind`` for a chunked visual-index job (plan MI4.1); guards ``jobId`` reuse
#: the same way :data:`BATCH_JOB_KIND` does for analysis.
VISUAL_JOB_KIND = "visual-index"
#: Default assets indexed per ``/brain/visual/index`` slice. Small on purpose:
#: sampling + embedding + captioning an asset is far heavier than an analysis
#: pass, so one call stays well under the request timeout (paced across turns).
DEFAULT_VISUAL_SLICE = 1
#: Hard cap on assets per slice (a single call can't reintroduce a long block).
MAX_VISUAL_SLICE = 10
#: How many assets in a row may fail on the hosted (TwelveLabs) path before the
#: slice stops. One failure is a bad file and must not block the other assets;
#: a run of them is a bad index, account, or network, and continuing would upload
#: — and be billed for — every remaining asset just to fail identically.
TL_CONSECUTIVE_FAILURE_LIMIT = 3


class VisualCaptionProviderPayload(BaseModel):
    """The host-resolved vision provider for captioning, in the request body.

    Mirrors :class:`~framepilot_engine.brain.captioner.CaptionProviderConfig`
    (plan D6/D7): the host reads the plaintext provider key and passes it here,
    the same channel MI0.1 established for the NVIDIA keys. Never logged.
    """

    kind: CaptionProviderKind
    model: str = Field(description="Vision-capable model id (e.g. claude-opus-4-8).")
    api_key: str = Field(alias="apiKey", description="Provider key; never logged or echoed.")
    base_url: str | None = Field(default=None, alias="baseUrl")

    model_config = {"populate_by_name": True}


class VisualIndexRequest(BaseModel):
    """Request body for ``POST /brain/visual/index`` (plan MI4.1).

    One bounded slice per call, paced across turns like ``/analyze/batch``: the
    worklist is fixed when the job is created (explicit ``assetIds`` or every
    video/image asset the brain knows) and stored in the job payload, so pacing
    is stable across turns. ``nvidiaKeys``/``captionProvider`` carry the host's
    plaintext credentials in the body (never read from disk, never logged);
    ``nvidiaKeys`` falls back to the ``FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS`` env.
    An optional project source lets caption text-embeddings rebuild the unified
    recall space (utterances + digests + captions) without a separate call.
    """

    project_id: str = Field(
        alias="projectId", description="Project whose brain journals this index job (required)."
    )
    project_path: str | None = Field(
        default=None, description="Saved project to embed captions against (optional)."
    )
    project: dict[str, Any] | None = Field(
        default=None, description="Inline project document to embed captions against (optional)."
    )
    asset_ids: list[str] | None = Field(
        default=None,
        alias="assetIds",
        description="Explicit worklist; omit to index every video/image asset in the brain. "
        "Fixed when the job is created — ignored on continuation calls.",
    )
    nvidia_keys: str | None = Field(
        default=None,
        alias="nvidiaKeys",
        description="Comma-separated NVIDIA embedding keys; falls back to the env setting.",
    )
    twelve_labs_key: str | None = Field(
        default=None,
        alias="twelveLabsKey",
        description="TwelveLabs API key; when set, indexing is delegated to TwelveLabs "
        "instead of the built-in NVIDIA-embed pipeline. Falls back to TWELVELABS_API_KEY. "
        "Never logged.",
    )
    caption_provider: VisualCaptionProviderPayload | None = Field(
        default=None,
        alias="captionProvider",
        description="Vision provider for per-scene captions; omit to skip captioning.",
    )
    job_id: str | None = Field(
        default=None,
        alias="jobId",
        description="Omit to start a new job (id minted, returned); pass the returned id to "
        "continue an in-flight job from its persisted cursor.",
    )
    max_assets: int = Field(
        default=DEFAULT_VISUAL_SLICE,
        ge=1,
        le=MAX_VISUAL_SLICE,
        alias="maxAssets",
        description="Assets to index this slice (bounded so one call can't block long).",
    )

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _at_most_one_source(self) -> VisualIndexRequest:
        if self.project_path is not None and self.project is not None:
            raise ValueError("Provide at most one of project_path or project.")
        return self


class VisualIndexItem(BaseModel):
    """One asset's outcome within an index slice (plan MI4.1)."""

    asset_id: str = Field(alias="assetId")
    ok: bool = Field(description="False when the asset could not be indexed (see reason).")
    indexed: int = Field(default=0, description="New spans embedded + stored this slice.")
    captioned: int = Field(default=0, description="Scenes captioned this slice.")
    reason: str | None = Field(
        default=None, description="Why the asset was skipped, when ok=false."
    )

    model_config = {"populate_by_name": True}


class VisualIndexResponse(BaseModel):
    """One index slice's progress + per-asset results (plan MI4.1).

    Honest-unavailable when the brain journal cannot be reached, or when no
    embedding key resolves (``reason`` set, nothing indexed). Otherwise the
    caller re-posts with ``jobId`` until ``done`` — ``cursor``/``total`` report
    how far the worklist has been consumed. ``reason`` also carries a mid-batch
    key-exhaustion signal (``all_keys_failing``) without failing the whole job.
    """

    available: bool
    reason: str | None = None
    job_id: str | None = Field(default=None, alias="jobId")
    cursor: int = 0
    total: int = 0
    done: bool = False
    indexed: int = Field(default=0, description="New spans embedded across the slice.")
    captioned: int = Field(default=0, description="Scenes captioned across the slice.")
    captions_reason: str | None = Field(
        default=None,
        alias="captionsReason",
        description="Why captions were NOT written (no vision provider / no project doc).",
    )
    items: list[VisualIndexItem] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class VisualIndexCancelRequest(BaseModel):
    """Request body for ``POST /brain/visual/index/cancel`` (plan MI4.1)."""

    project_id: str = Field(alias="projectId")
    job_id: str = Field(alias="jobId", description="The visual-index job to cancel.")

    model_config = {"populate_by_name": True}


class VisualIndexCancelResponse(BaseModel):
    """Outcome of cancelling a visual-index job (plan MI4.1).

    Cancellation is cooperative: the flag is journaled in the job payload and
    the next ``/brain/visual/index`` slice short-circuits on it (the work is
    already paced across HTTP calls, so there is no background loop to interrupt).
    """

    available: bool
    reason: str | None = None
    job_id: str | None = Field(default=None, alias="jobId")
    state: JobState | None = None

    model_config = {"populate_by_name": True}


class VisualJobStatus(BaseModel):
    """The last visual-index job's journaled state (plan MI4.3)."""

    job_id: str = Field(alias="jobId")
    state: JobState
    progress: float = Field(ge=0.0, le=1.0)
    error: str | None = None
    cursor: int = 0
    total: int = 0
    updated_at: str = Field(alias="updatedAt")

    model_config = {"populate_by_name": True}


class VisualStatusResponse(BaseModel):
    """Visual-index coverage/health for ``GET /brain/visual/status`` (plan MI4.3).

    Honest-unavailable like every brain surface: no sandbox root or an unusable
    brain reports ``available=False`` with the reason. ``keyConfigured`` is a
    plain bool derived from the env setting (this is a bodyless GET) — the key
    itself is NEVER returned. ``backend`` names the live vector backend
    (``sqlite-vec`` or the brute-force fallback).
    """

    available: bool
    reason: str | None = None
    backend: str | None = None
    counts: dict[str, int] = Field(default_factory=dict)
    indexed_assets: int = Field(default=0, alias="indexedAssets")
    total_assets: int = Field(default=0, alias="totalAssets")
    key_configured: bool = Field(default=False, alias="keyConfigured")
    last_job: VisualJobStatus | None = Field(default=None, alias="lastJob")

    model_config = {"populate_by_name": True}


#: Default/max evidence packets returned by ``/brain/visual/search`` (plan MI5.1).
DEFAULT_VISUAL_SEARCH_K = 8
MAX_VISUAL_SEARCH_K = 50
#: Candidate pool fetched from each retriever before fusion. Over-fetching past
#: ``k`` gives reciprocal-rank fusion room to reward spans that several
#: retrievers agree on rather than truncating each list at ``k`` in isolation.
VISUAL_SEARCH_POOL = 50


class VisualSearchRequest(BaseModel):
    """Request body for ``POST /brain/visual/search`` (plan MI5.1/§3.4).

    ``nvidiaKeys`` carries the host's plaintext embedding keys (never read from
    disk here, never logged), falling back to ``FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS``
    — the same channel ``/brain/visual/index`` uses. A project source is
    OPTIONAL (mirroring ``/brain/search``): when supplied it provides the clips
    used to project spans onto timeline time and the transcript used for
    ``transcriptOverlap`` (plan MI5.2); without it those fields degrade honestly
    to empty, but visual + caption recall still works.
    """

    project_id: str = Field(
        alias="projectId", description="Project whose brain to search (required)."
    )
    query: str = Field(description="Free-text query; embedded cross-modally and reduced to FTS.")
    k: int = Field(
        default=DEFAULT_VISUAL_SEARCH_K,
        ge=1,
        le=MAX_VISUAL_SEARCH_K,
        description="Max evidence packets to return.",
    )
    asset_ids: list[str] | None = Field(
        default=None, alias="assetIds", description="Restrict recall to these assets."
    )
    time_range: tuple[float, float] | None = Field(
        default=None,
        alias="timeRange",
        description="``[start, end]`` asset seconds; keep spans overlapping it.",
    )
    nvidia_keys: str | None = Field(
        default=None,
        alias="nvidiaKeys",
        description="Comma-separated NVIDIA embedding keys; falls back to the env setting.",
    )
    twelve_labs_key: str | None = Field(
        default=None,
        alias="twelveLabsKey",
        description="TwelveLabs API key; when set, search is served by TwelveLabs instead of "
        "the built-in vector store. Falls back to TWELVELABS_API_KEY. Never logged.",
    )
    project_path: str | None = Field(
        default=None, description="Saved project supplying clips + transcript (optional)."
    )
    project: dict[str, Any] | None = Field(
        default=None, description="Inline project document supplying clips + transcript."
    )

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _validate(self) -> VisualSearchRequest:
        if self.project_path is not None and self.project is not None:
            raise ValueError("Provide at most one of project_path or project.")
        if self.time_range is not None and self.time_range[0] > self.time_range[1]:
            raise ValueError("timeRange start must be <= end.")
        return self


class VisualDescribeRequest(BaseModel):
    """Enumerate one asset's indexed visual spans without semantic ranking.

    Unlike :class:`VisualSearchRequest`, this read needs neither a query nor an
    embedding key: it is a deterministic projection of already-indexed spans and
    captions. This is the executable contract behind the ``describe_footage`` tool.
    """

    project_id: str = Field(alias="projectId")
    asset_id: str = Field(alias="assetId")
    time_range: tuple[float, float] | None = Field(default=None, alias="timeRange")
    project_path: str | None = Field(default=None)
    project: dict[str, Any] | None = Field(default=None)
    twelve_labs_key: str | None = Field(
        default=None,
        alias="twelveLabsKey",
        description="TwelveLabs API key; falls back to TWELVELABS_API_KEY. Never logged.",
    )

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _validate(self) -> VisualDescribeRequest:
        if self.project_path is not None and self.project is not None:
            raise ValueError("Provide at most one of project_path or project.")
        if self.time_range is not None and self.time_range[0] > self.time_range[1]:
            raise ValueError("timeRange start must be <= end.")
        return self


class FootageMapRequest(BaseModel):
    """Request body for ``POST /brain/visual/footage-map`` (plan FI2.1).

    Produces a time-ordered structural digest of the project's footage with no
    query. Like :class:`VisualDescribeRequest` it needs neither a query nor an
    embedding key: the TwelveLabs arm calls Pegasus (cached by content hash), the
    built-in arm derives the map from already-indexed spans/captions. ``assetId``
    optionally narrows the map to one asset; omit it for the whole project.
    ``refresh`` forces a recompute past the cache (plan FI2.3); ``cachedOnly`` is its
    opposite and never calls the provider at all.
    """

    project_id: str = Field(alias="projectId")
    asset_id: str | None = Field(default=None, alias="assetId")
    refresh: bool = Field(
        default=False, description="Recompute past the cached map (re-fetch Pegasus)."
    )
    cached_only: bool = Field(
        default=False,
        alias="cachedOnly",
        description=(
            "Serve ONLY what is already cached: on a miss, return an empty map instead "
            "of calling the understanding provider. For callers that enrich something "
            "else (a run's context) and must never turn a cheap read into a slow, billed "
            "Pegasus fetch. Ignored when `refresh` is set — that is an explicit rebuild."
        ),
    )
    asset_time: bool = Field(
        default=False,
        alias="assetTime",
        description="Return chapter/highlight times in each asset's OWN source seconds "
        "(the footage's structure), not projected onto the timeline. The understanding "
        "panel uses this so the map reflects the footage, not the current edit; the AI "
        "keeps timeline projection (default) so it can act on the timeline.",
    )
    project_path: str | None = Field(default=None)
    project: dict[str, Any] | None = Field(default=None)
    twelve_labs_key: str | None = Field(
        default=None,
        alias="twelveLabsKey",
        description="TwelveLabs API key; falls back to TWELVELABS_API_KEY. Never logged.",
    )

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _validate(self) -> FootageMapRequest:
        if self.project_path is not None and self.project is not None:
            raise ValueError("Provide at most one of project_path or project.")
        return self


class VisualSearchResponse(BaseModel):
    """Fused visual-search evidence packets (plan MI5.1/§3.4e).

    Honest-unavailable like every brain surface: no sandbox root or an unusable
    brain reports ``available=False`` with the reason; no configured embedding
    key (or a mid-search key exhaustion) reports ``available=True`` with the
    typed reason and no packets — never a fabricated ranking. ``backend`` names
    the live vector backend (``sqlite-vec`` or the brute-force fallback).
    """

    available: bool
    reason: str | None = None
    backend: str | None = None
    packets: list[EvidencePacket] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class FootageChapter(BaseModel):
    """One time-ordered chapter of a video's structural digest (plan FI0.1).

    ``t0``/``t1`` are **timeline** seconds (asset spans are projected the same way
    evidence packets are). ``title`` is a short human label; ``summary`` is a
    one-to-two sentence description of what happens in the chapter. This is the
    unit the orchestrator walks to reason over long footage without a query.
    """

    t0: float = Field(description="Chapter start seconds (inclusive).")
    t1: float = Field(description="Chapter end seconds (exclusive).")
    title: str = Field(description="Short human-readable chapter label.")
    summary: str = Field(default="", description="One-to-two sentence description.")
    asset_id: str | None = Field(
        default=None,
        alias="assetId",
        description="Owning asset id. Set so the UI can label/group by footage and "
        "project onto the timeline when the asset is placed.",
    )

    model_config = {"populate_by_name": True}


class FootageHighlight(BaseModel):
    """One salient moment worth acting on (plan FI0.1).

    ``t0``/``t1`` are seconds; ``label`` names the moment; ``score`` is a
    relevance/salience score (higher = stronger), used only to order highlights.
    """

    t0: float = Field(description="Highlight start seconds (inclusive).")
    t1: float = Field(description="Highlight end seconds (exclusive).")
    label: str = Field(description="Short human-readable highlight label.")
    score: float = Field(default=0.0, description="Salience score; higher is stronger.")
    asset_id: str | None = Field(default=None, alias="assetId", description="Owning asset id.")

    model_config = {"populate_by_name": True}


class FootageMapResponse(BaseModel):
    """Time-ordered structural digest of a project's footage (plan FI0.1/§4).

    The "give me a map of this video with no query" contract. Reuses the honest-
    unavailable shape of every brain surface: no key / no Pegasus entitlement / no
    sidecar → ``available`` may still be True but ``reason`` carries the typed
    cause and the lists are empty — never a fabricated map. ``backend`` names who
    produced it (``twelvelabs`` or the built-in span/caption derivation). The
    shape is kept byte-identical to the Zod mirror in
    ``packages/ai-sdk/src/footage-map.ts``.
    """

    available: bool
    reason: str | None = None
    backend: str | None = None
    duration_sec: float = Field(
        default=0.0, alias="durationSec", description="Total footage duration in seconds."
    )
    chapters: list[FootageChapter] = Field(default_factory=list)
    highlights: list[FootageHighlight] = Field(default_factory=list)
    summary: str = Field(default="", description="Whole-footage summary, one paragraph.")

    model_config = {"populate_by_name": True}


class AnalysisEntryStatus(StrEnum):
    """Outcome of one analyzer inside a unified ``/analyze`` pass (plan B1.2)."""

    OK = "ok"
    SKIPPED = "skipped"  # analyzer incompatible with this asset (e.g. scenes on audio)
    UNAVAILABLE = "unavailable"  # capability gate: whisper/model missing, no audio decoded
    FAILED = "failed"  # the analyzer ran and errored; other kinds still return


class AnalyzeRequest(AnalysisProjectSource):
    """Request body for ``POST /analyze`` — unified, depth-tiered analysis (plan B1.2)."""

    asset_id: str | None = Field(
        default=None,
        alias="assetId",
        description="Asset to analyse; omit for the first audio/video asset.",
    )
    depth: AnalysisDepth = Field(
        default=AnalysisDepth.STANDARD,
        description="quick = probe+silence; standard = +scenes+loudness+black; "
        "deep = +beats+freeze+transcription.",
    )
    kinds: list[AnalysisKind] | None = Field(
        default=None,
        description="Explicit analyzer selection; overrides the depth expansion.",
    )
    project_id: str | None = Field(
        default=None,
        alias="projectId",
        description=(
            "Project whose brain should persist/cache this pass (plan B1.3). "
            "Omitted → results are computed fresh and not persisted (back-compat)."
        ),
    )

    model_config = {"populate_by_name": True}


class AnalysisEntry(BaseModel):
    """One analyzer's outcome inside a unified ``/analyze`` response."""

    kind: AnalysisKind
    status: AnalysisEntryStatus
    result: dict[str, Any] | None = Field(
        default=None, description="The typed analyzer output (camelCase), when status=ok."
    )
    reason: str | None = Field(
        default=None, description="Why the analyzer was skipped/unavailable/failed."
    )
    cached: bool = Field(
        default=False,
        description="True when the result was served from the project brain (plan B1.3).",
    )


class AnalyzeResponse(BaseModel):
    """Unified analysis pass result (camelCase aliases for the IPC surface)."""

    asset_id: str = Field(alias="assetId")
    depth: AnalysisDepth
    results: list[AnalysisEntry]

    model_config = {"populate_by_name": True}


#: Job ``kind`` for a chunked batch analysis (plan B5.2); guards ``jobId`` reuse.
BATCH_JOB_KIND = "analyze-batch"
#: Asset kinds a batch pass enumerates when no explicit ``assetIds`` is given.
ANALYZABLE_ASSET_KINDS: frozenset[str] = frozenset({"video", "audio"})
#: Default assets analysed per ``/analyze/batch`` slice — small enough to stay
#: well under the per-request timeout on realistic camera files.
DEFAULT_BATCH_SLICE = 2
#: Hard cap on assets per slice, so a single call can't reintroduce the
#: long-blocking pass the chunking exists to avoid.
MAX_BATCH_SLICE = 25

#: How many recent corrections/decisions ``/brain/session-context`` returns (B6.3).
#: Session context is injected as a prompt tier, so it carries the RECENT
#: guidance, not a project's whole history — the files keep everything.
SESSION_CONTEXT_TAIL_ENTRIES = 5


class AnalyzeBatchRequest(AnalysisProjectSource):
    """Request body for ``POST /analyze/batch`` — chunked bin analysis (plan B5.2)."""

    project_id: str = Field(
        alias="projectId",
        description="Project whose brain journals this batch job (required — batch is durable).",
    )
    asset_ids: list[str] | None = Field(
        default=None,
        alias="assetIds",
        description="Explicit worklist; omit to analyse every video/audio asset in the project. "
        "Fixed when the job is created — ignored on continuation calls.",
    )
    depth: AnalysisDepth = Field(
        default=AnalysisDepth.QUICK,
        description="Tier run per asset; defaults to quick (the session-warmup default, B5.6).",
    )
    job_id: str | None = Field(
        default=None,
        alias="jobId",
        description="Omit to start a new job (id minted, returned); pass the returned id to "
        "continue an in-flight job from its persisted cursor.",
    )
    max_assets: int = Field(
        default=DEFAULT_BATCH_SLICE,
        ge=1,
        le=MAX_BATCH_SLICE,
        alias="maxAssets",
        description="Assets to analyse this slice (bounded so one call can't block long).",
    )

    model_config = {"populate_by_name": True}


class AnalyzeBatchItem(BaseModel):
    """One asset's outcome within a batch slice (plan B5.2)."""

    asset_id: str = Field(alias="assetId")
    ok: bool = Field(description="False when the asset could not be analysed (see reason).")
    depth: AnalysisDepth | None = None
    results: list[AnalysisEntry] = Field(default_factory=list)
    reason: str | None = Field(
        default=None, description="Why the asset was skipped, when ok=false."
    )

    model_config = {"populate_by_name": True}


class AnalyzeBatchResponse(BaseModel):
    """One batch slice's progress + results (plan B5.2).

    Honest-unavailable when the brain journal cannot be reached. Otherwise the
    caller re-posts with ``jobId`` until ``done`` — ``cursor``/``total`` report
    how far the worklist has been consumed.
    """

    available: bool
    reason: str | None = None
    job_id: str | None = Field(default=None, alias="jobId")
    cursor: int = 0
    total: int = 0
    done: bool = False
    items: list[AnalyzeBatchItem] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class AnalyzeSilenceRequest(AnalysisProjectSource):
    """Request body for ``POST /analyze-silence`` (plan Phase 9.2)."""

    asset_id: str | None = Field(
        default=None, description="Asset to analyse; omit for the first audio-bearing asset."
    )
    noise_floor_db: float | None = Field(
        default=None, description="silencedetect RMS floor in dB (negative)."
    )
    min_silence_seconds: float | None = Field(
        default=None, ge=0.0, description="Minimum gap length to report."
    )


class SilenceAnalysisResponse(BaseModel):
    """Detected silent ranges for an asset (serialized with camelCase aliases)."""

    asset_id: str = Field(alias="assetId")
    ranges: list[SilentRange]
    #: Why the result is empty, when the media itself has nothing to detect (no
    #: audio track). ``None`` on a real detection — an empty ``ranges`` with no
    #: reason means silencedetect ran over real audio and found no gaps.
    reason: str | None = None

    model_config = {"populate_by_name": True}


class DetectScenesRequest(AnalysisProjectSource):
    """Request body for ``POST /detect-scenes`` (plan Phase 9.2)."""

    asset_id: str | None = Field(
        default=None, description="Asset to analyse; omit for the first video asset."
    )
    threshold: float | None = Field(
        default=None, ge=0.0, le=1.0, description="Scene-score threshold in [0, 1]."
    )


class SceneAnalysisResponse(BaseModel):
    """Detected scene cuts for an asset (serialized with camelCase aliases)."""

    asset_id: str = Field(alias="assetId")
    cuts: list[SceneCut]

    model_config = {"populate_by_name": True}


class DetectBeatsRequest(AnalysisProjectSource):
    """Request body for ``POST /detect-beats`` (plan AGENT-NATIVE-UX T6)."""

    asset_id: str | None = Field(
        default=None, description="Asset to analyse; omit for the first audio-bearing asset."
    )
    sensitivity: float | None = Field(
        default=None,
        ge=0.5,
        le=4.0,
        description="Peak-pick sensitivity; lower finds more (softer) beats.",
    )


class BeatAnalysisResponse(BaseModel):
    """Detected beats + estimated tempo for an asset (camelCase aliases)."""

    asset_id: str = Field(alias="assetId")
    beats: list[Beat]
    bpm: float | None = None
    #: Why the result is empty, when the media itself has nothing to detect (silent
    #: footage). ``None`` on a real detection — an empty ``beats`` with no reason means
    #: the detector ran over real audio and found no onsets.
    reason: str | None = None

    model_config = {"populate_by_name": True}


class AsrStatusResponse(BaseModel):
    """Local ASR (whisper-cli) readiness for a settings/status UI (plan H0.1)."""

    binary_available: bool = Field(alias="binaryAvailable")
    binary_path: str | None = Field(default=None, alias="binaryPath")
    model: str
    model_present: bool = Field(alias="modelPresent")
    model_path: str = Field(alias="modelPath")
    download_size_bytes: int = Field(alias="downloadSizeBytes")

    model_config = {"populate_by_name": True}


class AsrSetupRequest(BaseModel):
    """Request body for ``POST /asr/setup`` — explicit model download+verify."""

    model: str = Field(default=DEFAULT_ASR_MODEL, description="ASR model name to install.")


class AsrSetupResponse(BaseModel):
    """Result of installing an ASR model."""

    model: str
    path: str
    installed: bool = True


class AsrSetupProgressResponse(BaseModel):
    """Live progress of the in-flight (or most recent) ``POST /asr/setup``.

    Polled by the settings UI while its setup request is still in flight — the
    awaited POST cannot stream its own progress, and the model download is long
    enough (~141MB) that a bare spinner is not an acceptable answer.
    """

    state: AsrSetupState
    model: str
    downloaded_bytes: int = Field(alias="downloadedBytes")
    total_bytes: int | None = Field(default=None, alias="totalBytes")
    error: str | None = None

    model_config = {"populate_by_name": True}

    @classmethod
    def of(cls, progress: AsrSetupProgress) -> AsrSetupProgressResponse:
        """Project a tracker snapshot onto the wire model."""
        return cls(
            state=progress.state,
            model=progress.model,
            downloaded_bytes=progress.downloaded_bytes,
            total_bytes=progress.total_bytes,
            error=progress.error,
        )


class TranscribeRequest(AnalysisProjectSource):
    """Request body for ``POST /transcribe`` (plan H0.1) — local whisper-cli ASR.

    When a TwelveLabs key is active and the asset is TwelveLabs-indexed, the route
    instead returns TwelveLabs' native transcription (no second ASR pass — the
    audio was already transcribed at index time). ``project_id`` is needed only for
    that path, to read the asset's TwelveLabs video mapping from the project brain.
    """

    asset_id: str | None = Field(
        default=None, description="Asset to transcribe; omit for the first audio-bearing asset."
    )
    provider: Literal["whisper-cli", "twelvelabs"] = Field(
        default="whisper-cli",
        description=(
            "Explicit engine-owned ASR provider. Never silently falls back across providers."
        ),
    )
    model: str = Field(default=DEFAULT_ASR_MODEL, description="ASR model to use.")
    use_cache: bool = Field(
        default=True, description="Reuse a prior content-hash-cached transcription when available."
    )
    project_id: str | None = Field(
        default=None,
        alias="projectId",
        description="Project whose brain holds the TwelveLabs mapping (TwelveLabs backend only).",
    )
    twelve_labs_key: str | None = Field(
        default=None,
        alias="twelveLabsKey",
        description="TwelveLabs key; when set (and the asset is indexed) its transcription is "
        "returned instead of running whisper. Falls back to TWELVELABS_API_KEY. Never logged.",
    )

    model_config = {"populate_by_name": True}


class TranscribeResponse(BaseModel):
    """Word-level transcript produced for an asset (camelCase aliases)."""

    asset_id: str = Field(alias="assetId")
    words: list[dict[str, Any]]

    model_config = {"populate_by_name": True}


# --- App factory -------------------------------------------------------------


def create_app(
    settings: Settings | None = None,
    *,
    render_queue: RenderQueue | None = None,
    asr_setup: AsrSetupTracker | None = None,
) -> FastAPI:
    """Construct the FastAPI application.

    :param settings: Engine settings; defaults to :func:`get_settings`.
    :param render_queue: Async render queue backing ``/render``; defaults to a
        real :class:`RenderQueue` (subprocess executor). Tests inject a queue
        built with a fake executor for deterministic, fast job transitions —
        see ``render/queue.py`` and ``test_render_queue.py`` for that pattern.
    :param asr_setup: Single-slot tracker backing the ``/asr/setup`` routes.
        Scoped to the app (not a module global) so each process/TestClient gets
        its own; tests inject one built with a fake downloader.
    :returns: A configured :class:`fastapi.FastAPI` instance.
    """
    settings = settings or get_settings()
    configure_logging()
    render_queue = render_queue or RenderQueue(
        default_timeout=float(settings.render_timeout_seconds)
    )
    asr_setup = asr_setup or AsrSetupTracker()

    # Which project brains have had their non-terminal jobs swept this process
    # lifetime (plan B5.1). Scoped to this app instance so a fresh process
    # (a real sidecar restart, or a new TestClient) sweeps again — that is
    # exactly the "restart re-lists interrupted jobs" contract. Populated lazily
    # on first job-touch of a project rather than by scanning every brain on
    # boot (brains are per-project and the derived dir may hold many).
    _swept_brain_jobs: set[str] = set()
    # Routes run in the threadpool (ADR 0117), so two requests can reach the
    # check-then-add in `sweep_interrupted_jobs_once` at once — without a lock
    # both would sweep and double-log, breaking the "idempotent per process"
    # contract its docstring promises. Same pattern as `_embedder_lock` below.
    _swept_brain_jobs_lock = threading.Lock()

    # Per-project locks for `/brain/visual/index`, which reads → processes →
    # writes a job's cursor across three separate `open_brain` sessions (plan
    # MI4.1's paced-slice pattern). Now that routes run in the threadpool, two
    # concurrent slices for the SAME project could otherwise both read the
    # same starting cursor, both process the same assets, and have the second
    # write clobber the first's advance with a stale base. Keyed by project
    # id — not a single lock — so unrelated projects still index in parallel;
    # created lazily and never removed, bounded by the distinct projects this
    # process touches.
    _visual_index_locks: dict[str, threading.Lock] = {}
    _visual_index_locks_guard = threading.Lock()

    # One temporal-evidence batch at a time, process-wide. Unlike the per-project
    # index locks above, this is deliberately NOT keyed: the resource it protects is
    # the machine's memory, which unrelated projects contend for just as much as
    # related ones. See the route for the measurements behind it.
    _temporal_evidence_gate = asyncio.Semaphore(1)

    def _visual_index_lock(project_id: str) -> threading.Lock:
        with _visual_index_locks_guard:
            lock = _visual_index_locks.get(project_id)
            if lock is None:
                lock = threading.Lock()
                _visual_index_locks[project_id] = lock
            return lock

    @asynccontextmanager
    async def lifespan(_app: FastAPI):  # type: ignore[no-untyped-def]
        """Stop the queue's worker threads when the sidecar process shuts down."""
        yield
        render_queue.shutdown(wait=False)  # pragma: no cover - exercised via process exit

    app = FastAPI(
        title="FramePilot Engine",
        version=__version__,
        summary="Local render/validation/inspection sidecar for the FramePilot desktop app.",
        lifespan=lifespan,
    )

    # The desktop renderer calls this sidecar with the browser's fetch(), which
    # is cross-origin (renderer origin is the Vite dev server or "null" for a
    # packaged file:// load; this service is its own http://127.0.0.1 origin).
    # A JSON POST triggers a CORS preflight; without this middleware Starlette
    # has no OPTIONS route registered and answers 405, which is what surfaced
    # to users as "Method Not Allowed" clicking "Set up" in Settings.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_allowed_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def _log_requests(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Log every HTTP action the engine handles: method, path, status, duration.

        This is the engine-wide "log all actions" surface — one line in, one line out
        per request, so the desktop app's sidecar calls (render/analyze/inspect) are
        always visible in the engine console when debugging.
        """
        start = time.monotonic()
        _log.info("ACT → %s %s", request.method, request.url.path)
        try:
            response = await call_next(request)
        except Exception:  # pragma: no cover - re-raised after logging
            _log.exception("ERR ✗ %s %s raised", request.method, request.url.path)
            raise
        elapsed_ms = (time.monotonic() - start) * 1000
        _log.info(
            "ACT ← %s %s → %s (%.0f ms)",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response

    def sandbox(candidate: str) -> Path:
        """Resolve a caller-supplied path inside the configured sandbox root.

        Security boundary for the sidecar (PRD §18.1): every route that accepts a
        filesystem path MUST route it through here BEFORE any disk access, so a
        local process cannot probe or render arbitrary files (e.g. ``/etc/passwd``
        or ``../../`` traversal) via the IPC surface.

        WHY the ``projects_root is None`` branch fails closed: ``Settings.projects_root``
        is sourced from the optional ``FRAMEPILOT_PROJECTS_ROOT`` env var and
        defaults to ``None`` (see ``config.py``). The packaged desktop shell
        always sets it. Without a root there is no sandbox boundary to enforce,
        so accepting caller-supplied paths would let any local process probe or
        render arbitrary files through the IPC surface — the exact path-injection
        class PRD §18.1 forbids. We therefore refuse the request with 503
        (a server-side misconfiguration, not a bad client request) and log an
        error so the missing configuration is observable. When a root IS
        configured, containment is strict.

        :raises HTTPException: 400 if the path escapes a configured
            ``projects_root``; 503 if no ``projects_root`` is configured.
        """
        root = settings.projects_root
        if root is None:
            _log.error(
                "projects_root is not configured; refusing path %r because sandbox "
                "containment cannot be enforced. Set FRAMEPILOT_PROJECTS_ROOT.",
                candidate,
            )
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "projects_root is not configured; path-based operations are unavailable. "
                "Set FRAMEPILOT_PROJECTS_ROOT.",
            )
        try:
            return resolve_within(root, candidate)
        except PathTraversalError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    def derive_thumbnails(
        input_path: Path, kind: str, duration: float | None, count: int, *, timeout: float
    ) -> list[str] | None:
        """Derive project-relative thumbnail paths for an imported asset (plan Phase 8).

        Thumbnails are *derived preview data*, written UNDER ``projects_root`` so the
        render-vs-preview boundary (PRD §9.2) holds: the renderer never re-derives
        them. Output lives in a deterministic per-source directory keyed by a stable
        hash of the source path relative to the root, so re-importing the same file is
        idempotent (no timestamps/randomness). Returns POSIX paths relative to the
        project root, or ``None`` when generation is skipped or fails — peaks/duration
        /kind still return so import never blocks on thumbnails.

        ``timeout`` bounds every ffmpeg/ffprobe subprocess this triggers (the
        duration probe and each frame extraction) so a crafted/looping source
        cannot hang derivation; on timeout the FFmpegError degrades to ``None``.
        """
        root = settings.projects_root
        if root is None:
            # Unsandboxed dev/CLI mode: no contained location to write under, so we
            # cannot return project-relative paths. Degrade rather than crash.
            _log.warning(
                "projects_root is not configured; skipping thumbnail derivation for %r.",
                str(input_path),
            )
            return None

        resolved_root = root.resolve()

        if kind == "image":
            # An image is its own single-frame preview; no ffmpeg work needed.
            return [input_path.relative_to(resolved_root).as_posix()]

        if kind != "video" or not duration or count <= 0:
            # Audio, durationless video, or thumbnails disabled.
            return None

        # Stable, collision-resistant dir name from the in-sandbox relative path.
        rel_source = input_path.relative_to(resolved_root).as_posix()
        digest = hashlib.sha1(rel_source.encode("utf-8")).hexdigest()[:12]
        try:
            out_dir = resolve_within(
                resolved_root, str(Path(".framepilot-derived") / digest / "thumbs")
            )
        except PathTraversalError as exc:  # pragma: no cover - digest is always safe
            _log.warning("Thumbnail output dir escaped sandbox; skipping: %s", exc)
            return None

        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            thumb_paths = generate_thumbnails(input_path, out_dir, count=count, timeout=timeout)
        except (FFmpegError, OSError) as exc:
            _log.warning("Thumbnail derivation failed for %r; continuing: %s", rel_source, exc)
            return None

        return [p.relative_to(resolved_root).as_posix() for p in thumb_paths]

    def derive_proxy_path(input_path: Path, kind: str, duration: float | None) -> str | None:
        """Derive (or reuse) a low-res preview proxy for a video asset (H3).

        The proxy lives beside the other derived data
        (``.framepilot-derived/<digest>/proxy.mp4``) so re-importing the same
        source reuses the existing transcode instead of paying it again. The
        digest is salted with ``PROXY_ENCODE_VERSION`` (preview WebCodecs
        compositor plan, P-1) so bumping the encode settings in
        :func:`generate_proxy` lands every source at a fresh, unwritten path
        instead of silently reusing a stale transcode under the old settings.
        Sources longer than ``settings.proxy_max_duration_seconds`` are
        skipped — a synchronous import must stay bounded; long-form footage
        gets proxies from a background queue (plan Phase 15 follow-up). Any
        failure degrades to ``None`` — the preview then plays the original.
        """
        root = settings.projects_root
        if root is None:
            _log.warning(
                "projects_root is not configured; skipping proxy derivation for %r.",
                str(input_path),
            )
            return None
        if kind != "video" or not duration:
            return None
        if duration > settings.proxy_max_duration_seconds:
            _log.warning(
                "Source %r is %.0fs (> %ss cap); skipping synchronous proxy derivation.",
                str(input_path),
                duration,
                settings.proxy_max_duration_seconds,
            )
            return None

        resolved_root = root.resolve()
        rel_source = input_path.relative_to(resolved_root).as_posix()
        digest = hashlib.sha1(f"{rel_source}|{PROXY_ENCODE_VERSION}".encode()).hexdigest()[:12]
        try:
            output = resolve_within(
                resolved_root, str(Path(".framepilot-derived") / digest / "proxy.mp4")
            )
        except PathTraversalError as exc:  # pragma: no cover - digest is always safe
            _log.warning("Proxy output path escaped sandbox; skipping: %s", exc)
            return None

        rel_output = output.relative_to(resolved_root).as_posix()
        if output.exists():
            return rel_output  # idempotent reuse — same source, same proxy
        try:
            generate_proxy(input_path, output, timeout=float(settings.proxy_timeout_seconds))
        except (FFmpegError, OSError) as exc:
            _log.warning("Proxy derivation failed for %r; continuing: %s", rel_source, exc)
            return None
        return rel_output

    def record_asset_in_brain(
        input_path: Path, project_id: str | None, asset_id: str | None, info: MediaInfo
    ) -> bool:
        """Persist an imported asset's probe into the project brain (plan B0.4).

        Honest degradation (B0.5): a missing sandbox root, missing ids, or any
        brain failure logs a warning and returns False — the import result the
        renderer depends on is NEVER blocked by the brain, which is a derived
        cache, not truth.
        """
        root = settings.projects_root
        if root is None or project_id is None or asset_id is None:
            return False
        try:
            resolved_root = root.resolve()
            content_sha256 = _sha256_file(input_path)
            with open_brain(resolved_root, project_id) as store:
                store.upsert_asset(
                    asset_id,
                    path=input_path.relative_to(resolved_root).as_posix(),
                    content_sha256=content_sha256,
                    probe=info.model_dump(mode="json"),
                )
                export_asset_sidecar(store, brain_dir_for(resolved_root, project_id), asset_id)
        except (BrainError, BrainSchemaError, PathTraversalError, OSError, ValueError) as exc:
            _log.warning(
                "Brain write failed for asset %r in project %r; import continues: %s",
                asset_id,
                project_id,
                exc,
            )
            return False
        _log.info(
            "ACT brain record: project=%s asset=%s sha=%s",
            project_id,
            asset_id,
            content_sha256[:12],
        )
        return True

    @app.get("/brain/status", response_model=BrainStatus)
    def brain_status_route(projectId: str) -> BrainStatus:
        """Report a project brain's existence/schema/FTS5/counts (plan B0.4).

        Never creates the database and never fails: every unusable state comes
        back as ``available=False`` with a reason (honest-unavailable, B0.5).
        """
        return brain_status(settings.projects_root, projectId)

    @app.post("/brain/rebuild", response_model=BrainRebuildResponse)
    def brain_rebuild_route(req: BrainRebuildRequest) -> BrainRebuildResponse:
        """Drop a project's brain.sqlite and re-derive it from its JSON sidecars.

        Safe because the brain is a derived cache (invariant 1): rebuilding
        loses nothing canonical. FTS/project-derived rows are re-ingested on
        the next save or search (B2.1).
        """
        root = settings.projects_root
        if root is None:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "The project brain requires a configured sandbox root "
                "(set FRAMEPILOT_PROJECTS_ROOT).",
            )
        try:
            brain_dir = brain_dir_for(root, req.project_id)
        except PathTraversalError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        db_path = brain_dir / BRAIN_FILENAME
        # The WAL journal files must go with the database or SQLite replays them.
        for suffix in ("", "-wal", "-shm"):
            Path(str(db_path) + suffix).unlink(missing_ok=True)
        try:
            with open_brain(root, req.project_id) as store:
                imported = import_sidecars(store, brain_dir)
                rebuilt_status = store.status()
        except (BrainError, BrainSchemaError) as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        _log.info("ACT brain rebuild: project=%s imported=%d sidecars", req.project_id, imported)
        return BrainRebuildResponse(imported=imported, status=rebuilt_status)

    def load_project_document(project_path: str | None, project: dict[str, Any] | None) -> Project:
        """Load a project document from a saved path OR an inline payload.

        Same validation contract as ``resolve_asset_media`` (saved → sandboxed
        ``ProjectFile.load``; inline → envelope-stripped ``model_validate``),
        shared by the brain index/search routes, which need the whole document
        (transcript + markers) rather than one asset's media.

        :raises HTTPException: 400 on load/validation failure.
        """
        if project_path is not None:
            return _load_project(sandbox(project_path))
        payload = {k: v for k, v in (project or {}).items() if k != "schemaVersion"}
        try:
            return Project.model_validate(payload)
        except PydanticValidationError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Invalid inline project: {exc}"
            ) from exc

    def reindex_project_fts(store: BrainStore, project: Project) -> tuple[int, int]:
        """Rebuild both FTS tables from one canonical project document (B2.1).

        :returns: ``(utterances, markers)`` counts actually indexed.
        """
        utterances = segment_utterances(list(project.transcript))
        store.reindex_transcript(utterances)
        store.reindex_markers(list(project.markers))
        return len(utterances), len(project.markers)

    # Loading an ONNX model is not free; resolve once per process and reuse.
    # A list, not a bare variable, so the closure can write without `nonlocal`
    # gymnastics across the nested route functions.
    _embedder_cache: list[EmbedderResolution] = []
    # Routes run in the threadpool (see `create_app`), so two requests can reach
    # the gate at once. Without the lock both would load the model.
    _embedder_lock = threading.Lock()

    def embedder_resolution() -> EmbedderResolution:
        """The process-wide embedder capability gate result (plan B3.1)."""
        with _embedder_lock:
            if not _embedder_cache:
                _embedder_cache.append(resolve_embedder(settings.embeddings_model_dir))
            return _embedder_cache[0]

    def reindex_project_embeddings(store: BrainStore, project: Project) -> tuple[int, str | None]:
        """Rebuild the embeddings for one project document (plan B3.2).

        Embeds the transcript's utterances plus each brain-known asset's
        bin-summary digest in one batch. Honest degradation: with no embedder
        the rows are left untouched and the reason is reported, never a
        fabricated count.

        :returns: ``(rows_written, unavailable_reason)``.
        """
        resolution = embedder_resolution()
        if resolution.embedder is None:
            return 0, resolution.reason
        utterances = segment_utterances(list(project.transcript))
        digests = [
            AssetDigest(
                asset_id=asset.id,
                path=asset.path,
                text=asset_section(asset, store.list_analysis(asset.id)),
            )
            for asset in store.list_assets()
        ]
        rows = build_embedding_rows(resolution.embedder, utterances, digests)
        return store.replace_embeddings(resolution.embedder.model_id, rows), None

    @app.post("/brain/index", response_model=BrainIndexResponse)
    def brain_index_route(req: BrainIndexRequest) -> BrainIndexResponse:
        """Rebuild a project brain's FTS tables from the canonical document (B2.1).

        Called on project save (desktop shell) and implicitly by
        ``POST /brain/search`` when a project source rides along. Honest-
        unavailable: no sandbox root, no FTS5, or an unusable brain reports
        ``available=False`` with the reason — never a fabricated success.
        """
        project = load_project_document(req.project_path, req.project)
        root = settings.projects_root
        if root is None:
            return BrainIndexResponse(
                available=False,
                reason="projects_root is not configured (set FRAMEPILOT_PROJECTS_ROOT).",
            )
        try:
            with open_brain(root.resolve(), req.project_id) as store:
                if not store.fts_available:
                    return BrainIndexResponse(
                        available=False,
                        reason="This runtime's SQLite build lacks FTS5; search is unavailable.",
                    )
                utterances, markers = reindex_project_fts(store, project)
                embedded, embeddings_reason = reindex_project_embeddings(store, project)
        except (BrainError, BrainSchemaError, PathTraversalError) as exc:
            return BrainIndexResponse(available=False, reason=str(exc))
        _log.info(
            "ACT brain index: project=%s utterances=%d markers=%d embedded=%d",
            req.project_id,
            utterances,
            markers,
            embedded,
        )
        return BrainIndexResponse(
            available=True,
            utterances=utterances,
            markers=markers,
            embedded=embedded,
            embeddings_reason=embeddings_reason,
        )

    @app.post("/brain/search", response_model=BrainSearchResponse)
    def brain_search_route(req: BrainSearchRequest) -> BrainSearchResponse:
        """Full-text search over transcript, markers, and asset names (B2.2).

        When the request carries a project source (the agent loop always posts
        its live working copy), the FTS index is rebuilt from it first so hits
        are never stale. Hits are merged best-score-first: bm25-ranked
        transcript/marker matches, then asset-name substring matches (0.0).
        Without FTS5 the FTS-backed hit types honestly degrade to asset-name
        matches only, with the reason reported.
        """
        root = settings.projects_root
        if root is None:
            return BrainSearchResponse(
                available=False,
                reason="projects_root is not configured (set FRAMEPILOT_PROJECTS_ROOT).",
            )
        project_doc: Project | None = None
        if req.project_path is not None or req.project is not None:
            project_doc = load_project_document(req.project_path, req.project)
        project_id = req.project_id or (project_doc.id if project_doc is not None else None)
        if project_id is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "projectId is required when no project source is supplied.",
            )
        try:
            with open_brain(root.resolve(), project_id) as store:
                reason: str | None = None
                if not store.fts_available:
                    reason = (
                        "This runtime's SQLite build lacks FTS5; transcript/marker "
                        "search degraded to asset-name matches only."
                    )
                elif project_doc is not None:
                    reindex_project_fts(store, project_doc)
                hits = [
                    *store.search_transcript(req.query, limit=req.limit),
                    *store.search_markers(req.query, limit=req.limit),
                    *store.search_assets(req.query, limit=req.limit),
                ]
        except (BrainError, BrainSchemaError, PathTraversalError) as exc:
            return BrainSearchResponse(available=False, reason=str(exc))
        # Best score first; deterministic tie-break by type, position, then id.
        hits.sort(key=lambda h: (-h.score, h.type, h.start or 0.0, h.asset_id or h.marker_id or ""))
        hits = hits[: req.limit]
        _log.info("ACT brain search: project=%s query=%r hits=%d", project_id, req.query, len(hits))
        return BrainSearchResponse(available=True, reason=reason, hits=hits)

    @app.post("/brain/similar", response_model=BrainSimilarResponse)
    def brain_similar_route(req: BrainSimilarRequest) -> BrainSimilarResponse:
        """Semantic similarity search, blended with keyword matches (plan B3.3).

        With an embeddings model: cosine-rank the stored utterance/asset
        vectors against the query and merge with the FTS keyword hits
        (agreement outranks either signal alone — see ``brain.similar``).
        Without one: honest ``mode='keyword'`` degrade to exactly what
        ``/brain/search`` would return, with the reason.
        """
        root = settings.projects_root
        if root is None:
            return BrainSimilarResponse(
                available=False,
                reason="projects_root is not configured (set FRAMEPILOT_PROJECTS_ROOT).",
            )
        project_doc: Project | None = None
        if req.project_path is not None or req.project is not None:
            project_doc = load_project_document(req.project_path, req.project)
        project_id = req.project_id or (project_doc.id if project_doc is not None else None)
        if project_id is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "projectId is required when no project source is supplied.",
            )
        resolution = embedder_resolution()
        try:
            with open_brain(root.resolve(), project_id) as store:
                if project_doc is not None and store.fts_available:
                    reindex_project_fts(store, project_doc)
                if project_doc is not None and resolution.embedder is not None:
                    reindex_project_embeddings(store, project_doc)
                keyword = [
                    *store.search_transcript(req.query, limit=req.limit),
                    *store.search_markers(req.query, limit=req.limit),
                    *store.search_assets(req.query, limit=req.limit),
                ]
                if resolution.embedder is None:
                    keyword.sort(
                        key=lambda h: (
                            -h.score,
                            h.type,
                            h.start or 0.0,
                            h.asset_id or h.marker_id or "",
                        )
                    )
                    return BrainSimilarResponse(
                        available=True,
                        mode=SimilarSearchMode.KEYWORD,
                        reason=resolution.reason,
                        hits=keyword[: req.limit],
                    )
                rows = store.list_embeddings(resolution.embedder.model_id)
                semantic = semantic_hits(resolution.embedder, req.query, rows, limit=req.limit)
        except (BrainError, BrainSchemaError, PathTraversalError) as exc:
            return BrainSimilarResponse(available=False, reason=str(exc))
        hits = blend_hits(semantic, keyword, limit=req.limit)
        _log.info(
            "ACT brain similar: project=%s query=%r semantic=%d keyword=%d hits=%d",
            project_id,
            req.query,
            len(semantic),
            len(keyword),
            len(hits),
        )
        return BrainSimilarResponse(available=True, mode=SimilarSearchMode.BLENDED, hits=hits)

    # -- visual index (plan MI4.1/MI4.3) ------------------------------------------

    def _asset_is_visual(asset: AssetRow) -> bool:
        """Whether a brain asset has video frames to sample (video or still image).

        Classified from the stored ffprobe result; an asset with no probe (or an
        audio-only one) is not part of the visual worklist.
        """
        if asset.probe is None:
            return False
        try:
            return MediaInfo.model_validate(asset.probe).has_video
        except PydanticValidationError:  # pragma: no cover - probe is engine-written
            return False

    def _asset_is_still_image(asset: AssetRow) -> bool:
        """Whether a brain asset is a single still photo rather than moving footage.

        WHY this is a routing decision and not a cosmetic one: TwelveLabs' index is
        a *video/audio* index. A still uploads fine (``POST /assets`` accepts
        images, for entity search) but cannot be attached to a Marengo index, so
        the attach/poll step answers ``404 resource_not_exists`` — observed on a
        real 61-photo project, where it froze preparation at cursor 0 forever. The
        built-in sample->embed path already understands stills
        (``sample_asset(is_image=True)``), so stills are routed there instead.
        """
        if asset.probe is None:
            return False
        try:
            return MediaInfo.model_validate(asset.probe).is_image
        except PydanticValidationError:  # pragma: no cover - probe is engine-written
            return False

    def _scene_cuts_for(
        store: BrainStore, asset_id: str, media_path: Path, content_hash: str, timeout: float
    ) -> list[float]:
        """Scene-cut times for an asset, reusing the cached analysis when present.

        Keyed by the same ``analysis_params_hash`` the ``/analyze`` scenes pass
        uses, so an already-analysed asset never re-runs ffmpeg; a fresh detect
        is cached back so a later analysis pass hits the same row.
        """
        params_hash = analysis_params_hash(
            AnalysisKind.SCENES,
            analyzer_effective_params(AnalysisKind.SCENES),
            content_sha256=content_hash,
        )
        cached = store.get_analysis(asset_id, kind=AnalysisKind.SCENES, params_hash=params_hash)
        if cached is not None:
            return [float(c["time"]) for c in cached.result.get("cuts", [])]
        cuts = detect_scenes(media_path, timeout=timeout)
        store.record_analysis(
            asset_id,
            kind=AnalysisKind.SCENES,
            depth=AnalysisDepth.STANDARD,
            params_hash=params_hash,
            result={"cuts": [c.model_dump(mode="json") for c in cuts]},
            tool=f"scenes@v{ANALYZER_VERSIONS[AnalysisKind.SCENES]}",
        )
        return [c.time for c in cuts]

    def _caption_scenes(
        captioner: SceneCaptioner,
        spans: list[VisualSpan],
        keyframes: dict[float, bytes],
        asset_id: str,
        caption_model: str,
    ) -> list[VisualCaptionRow]:
        """One caption per scene from its keyframe strip (best-effort, plan §3.3).

        A per-scene caption failure is logged and the scene is left uncaptioned —
        a caption is evidence, never truth, so it must never fail the index job.
        """
        by_scene: dict[int, list[VisualSpan]] = {}
        for span in spans:
            by_scene.setdefault(span.scene_index, []).append(span)
        rows: list[VisualCaptionRow] = []
        for scene_index, scene_spans in sorted(by_scene.items()):
            ordered = sorted(scene_spans, key=lambda s: s.t0)
            strip = [keyframes[s.t0] for s in ordered]
            try:
                text = captioner.caption_scene(strip)
            except CaptionError as exc:
                _log.warning("Caption skipped for %s scene %d: %s", asset_id, scene_index, exc)
                continue
            rows.append(
                VisualCaptionRow(
                    asset_id=asset_id,
                    scene_index=scene_index,
                    t0=ordered[0].t0,
                    t1=ordered[-1].t1,
                    text=text,
                    model=caption_model,
                )
            )
        return rows

    def _index_one_asset(
        store: BrainStore,
        vstore: VisualVectorStore,
        embedder: VisualEmbedClient,
        captioner: SceneCaptioner | None,
        caption_model: str,
        asset_id: str,
        resolved_root: Path,
        timeout: float,
    ) -> VisualIndexItem:
        """Sample → embed → (caption) → store one asset's NEW spans (plan MI4.1).

        Idempotent: spans already embedded for the asset's current bytes are
        skipped (resume), and a changed ``content_hash`` wipes the stale index
        first (re-index). Raises :class:`KeyRingExhaustedError` up to the route so
        a mid-batch key failure stops the slice without corrupting progress.
        """
        asset = store.get_asset(asset_id)
        if asset is None:
            return VisualIndexItem(asset_id=asset_id, ok=False, reason="asset not known to brain")
        try:
            media_path = resolve_within(resolved_root, asset.path)
        except PathTraversalError as exc:
            return VisualIndexItem(asset_id=asset_id, ok=False, reason=str(exc))
        info = (
            MediaInfo.model_validate(asset.probe)
            if asset.probe is not None
            else inspect_media(media_path, timeout=timeout)
        )
        if not info.has_video:
            return VisualIndexItem(asset_id=asset_id, ok=False, reason="asset has no video frames")
        is_image = info.is_image
        duration = info.duration_seconds or 0.0
        if not is_image and not duration:
            return VisualIndexItem(asset_id=asset_id, ok=False, reason="asset has no duration")
        content_hash = asset.content_sha256 or _sha256_file(media_path)

        # Re-index on a content change; otherwise resume-skip already-embedded spans.
        stored = store.list_visual_spans(asset_id, model=MODEL_ID)
        if any(s.content_hash != content_hash for s in stored):
            store.delete_visual_asset(asset_id)
            existing_keys: set[float] = set()
        else:
            existing_keys = store.existing_visual_span_keys(
                asset_id, content_hash, MODEL_ID, SAMPLER_VERSION
            )

        # A single undecodable frame (corrupt/unusual source, a seek ffmpeg can't
        # honour, an ffmpeg exit failure, …) must fail only THIS asset, not the
        # whole slice — otherwise one bad file in a project permanently blocks
        # indexing every other asset, since a re-run always hits the same asset
        # first (cursor order). Scene-cut detection (`detect_scenes`, invoked via
        # `_scene_cuts_for`) shares this failure mode, so it's covered by the
        # same try — both `FrameExtractionError` (ffmpeg exited 0 with no frame,
        # e.g. the still-image `-ss` decode quirk) and `FFmpegError` (a non-zero
        # exit, timeout, or missing binary — `media/ffmpeg.py`'s `run_bytes`)
        # are per-asset failures, never a reason to crash the request.
        try:
            scene_cuts = (
                []
                if is_image
                else _scene_cuts_for(store, asset_id, media_path, content_hash, timeout)
            )
            spans = sample_asset(
                media_path,
                duration_seconds=duration,
                scene_cuts=scene_cuts,
                is_image=is_image,
                timeout=timeout,
            )
        except (FrameExtractionError, FFmpegError) as exc:
            return VisualIndexItem(asset_id=asset_id, ok=False, reason=str(exc))
        todo = [s for s in spans if s.t0 not in existing_keys]
        captioned_scenes = {
            caption.scene_index
            for caption in store.list_visual_captions(asset_id)
            if is_informative_caption(caption.text)
        }
        # Captioning is independently resumable from embedding. An earlier agent
        # `index_media` run could have indexed vectors without caption credentials;
        # a later run with a provider must backfill those scenes instead of returning
        # early merely because every vector already exists. Uninformative legacy
        # status strings (for example "User Safety: safe") are treated as missing.
        caption_todo = (
            [s for s in spans if s.scene_index not in captioned_scenes]
            if captioner is not None
            else []
        )
        if not todo and not caption_todo:
            return VisualIndexItem(asset_id=asset_id, ok=True, indexed=0)

        try:
            required_keyframes = {s.t0: s for s in [*todo, *caption_todo]}
            keyframes = {
                s.t0: extract_keyframe_jpeg(media_path, s.keyframe_t, timeout=timeout)
                for s in required_keyframes.values()
            }
        except (FrameExtractionError, FFmpegError) as exc:
            return VisualIndexItem(asset_id=asset_id, ok=False, reason=str(exc))
        if todo:
            result = embedder.embed_passages([keyframes[s.t0] for s in todo])
            if result.dim is None:  # pragma: no cover - non-empty input always sets dim
                return VisualIndexItem(
                    asset_id=asset_id, ok=False, reason="embedder returned no dim"
                )
            dim = result.dim
            store.upsert_visual_spans(
                [
                    VisualSpanRow(
                        asset_id=asset_id,
                        model=MODEL_ID,
                        sampler_version=SAMPLER_VERSION,
                        t0=s.t0,
                        t1=s.t1,
                        scene_index=s.scene_index,
                        keyframe_t=s.keyframe_t,
                        phash=s.phash,
                        content_hash=content_hash,
                        frame_count=s.frame_count,
                    )
                    for s in todo
                ]
            )
            vstore.upsert(
                [
                    VisualVectorRow(
                        asset_id=asset_id,
                        model=MODEL_ID,
                        sampler_version=SAMPLER_VERSION,
                        t0=s.t0,
                        dim=dim,
                        vector=vector,
                    )
                    for s, vector in zip(todo, result.vectors, strict=True)
                ]
            )

        captioned = 0
        if captioner is not None and caption_todo:
            caption_rows = _caption_scenes(
                captioner, caption_todo, keyframes, asset_id, caption_model
            )
            if caption_rows:
                store.upsert_visual_captions(caption_rows)
                store.reindex_captions(store.list_visual_captions(asset_id), asset_id=asset_id)
                captioned = len(caption_rows)
        return VisualIndexItem(asset_id=asset_id, ok=True, indexed=len(todo), captioned=captioned)

    def _reindex_embeddings_with_captions(store: BrainStore, project: Project) -> None:
        """Rebuild the unified text-recall space including captions (plan MI3.2).

        ``replace_embeddings`` swaps ALL rows for the model, so captions can only
        be text-embedded alongside the transcript utterances and asset digests —
        embedding captions alone would clobber the transcript space. That is why
        this runs only when a project document is supplied (utterances need it).
        """
        resolution = embedder_resolution()
        if resolution.embedder is None:
            return
        utterances = segment_utterances(list(project.transcript))
        digests = [
            AssetDigest(
                asset_id=asset.id,
                path=asset.path,
                text=asset_section(asset, store.list_analysis(asset.id)),
            )
            for asset in store.list_assets()
        ]
        rows = build_embedding_rows(
            resolution.embedder, utterances, digests, captions=store.list_visual_captions()
        )
        store.replace_embeddings(resolution.embedder.model_id, rows)

    def _resolve_visual_job(store: BrainStore, req: VisualIndexRequest) -> JobRow:
        """Get the caller's in-flight index job, or create one with a fixed worklist.

        A continuation call (``jobId`` names an existing job) resumes it as-is;
        a fresh job's worklist is the explicit ``assetIds`` (deduped, order
        preserved) or every video/image asset the brain knows.
        """
        if req.job_id is not None:
            existing = store.get_job(req.job_id)
            if existing is not None:
                if existing.kind != VISUAL_JOB_KIND:
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        f"Job {req.job_id!r} exists but is not a {VISUAL_JOB_KIND} job.",
                    )
                return existing
        if req.asset_ids is not None:
            asset_ids = list(dict.fromkeys(req.asset_ids))
        else:
            asset_ids = [a.id for a in store.list_assets() if _asset_is_visual(a)]
        job_id = req.job_id or f"{VISUAL_JOB_KIND}-{uuid4().hex}"
        return store.create_job(
            job_id, kind=VISUAL_JOB_KIND, payload={"assetIds": asset_ids, "cursor": 0}
        )

    def _last_visual_job(store: BrainStore) -> VisualJobStatus | None:
        """The most recent visual-index job's journaled state (plan MI4.3)."""
        jobs = [j for j in store.list_jobs() if j.kind == VISUAL_JOB_KIND]
        if not jobs:
            return None
        job = jobs[-1]  # list_jobs is oldest-first
        return VisualJobStatus(
            job_id=job.id,
            state=job.state,
            progress=job.progress,
            error=job.error,
            cursor=int(job.payload.get("cursor", 0)),
            total=len(job.payload.get("assetIds", [])),
            updated_at=job.updated_at,
        )

    def _tl_still_image_item(
        store: BrainStore,
        vstore: VisualVectorStore,
        still_res: VisualEmbedderResolution,
        captioner: SceneCaptioner | None,
        caption_model: str,
        asset_id: str,
        resolved_root: Path,
        timeout: float,
    ) -> VisualIndexItem:
        """Prepare one still photo on the built-in path while TwelveLabs is active.

        TwelveLabs cannot index a still into its video index, so a photo project
        would otherwise be understood by nothing at all even with both keys set.
        The built-in sampler already handles ``is_image``, so a still is embedded
        here and becomes searchable + mappable exactly like a built-in-indexed
        video. The caption provider is passed through: a photo's caption IS its
        chapter title in the footage map, and without one a photo project's map is
        sixty identical "Scene 1" rows the model cannot tell apart.

        Honest-degrade: without an on-device embedding key the item reports why,
        and the cursor still advances — an unpreparable asset must never freeze
        the assets behind it.
        """
        if still_res.client is None:
            return VisualIndexItem(
                asset_id=asset_id,
                ok=False,
                reason=(
                    "still images are not indexable by TwelveLabs and need an "
                    f"on-device embedding key: {still_res.reason}"
                ),
            )
        try:
            return _index_one_asset(
                store,
                vstore,
                still_res.client,
                captioner,
                caption_model,
                asset_id,
                resolved_root,
                timeout,
            )
        except (KeyRingExhaustedError, VisualEmbedError) as exc:
            reason = getattr(exc, "last_error", None) or str(exc)
            _log.warning("still-image embed failed: asset=%s reason=%s", asset_id, reason)
            return VisualIndexItem(asset_id=asset_id, ok=False, reason=reason)

    def _tl_index_slice(
        client: TwelveLabsClient, req: VisualIndexRequest, resolved_root: Path
    ) -> VisualIndexResponse:
        """Index one paced slice through TwelveLabs (the ``twelveLabsKey`` backend).

        Mirrors the built-in route's journaled-job pacing (``_resolve_visual_job``
        + cursor), but each asset is uploaded to a TwelveLabs index and its
        ``video_id`` recorded in the brain. An asset still indexing does NOT
        advance the cursor — the slice is re-posted (like the built-in loop) until
        every asset is terminal. Captioning is a no-op: TwelveLabs understands the
        audio track natively, so no per-scene VLM captions are needed. Honest-
        unavailable: an auth failure reports ``invalid_api_key``; other API
        failures surface their message; no key never reaches here.
        """
        tl_captions_reason = (
            "TwelveLabs indexes the audio track natively; per-scene captions are not used."
        )
        # Phase 1 — resolve/create the job + ensure the project's TL index exists.
        try:
            with open_brain(resolved_root, req.project_id) as store:
                sweep_interrupted_jobs_once(store, req.project_id)
                job = _resolve_visual_job(store, req)
                asset_ids = [str(a) for a in job.payload.get("assetIds", [])]
                cursor = int(job.payload.get("cursor", 0))
                total = len(asset_ids)
                if job.payload.get("cancelled"):
                    return VisualIndexResponse(
                        available=True,
                        reason="cancelled",
                        job_id=job.id,
                        cursor=cursor,
                        total=total,
                    )
                if cursor >= total:
                    store.update_job(job.id, state=JobState.DONE, progress=1.0)
                    return VisualIndexResponse(
                        available=True, job_id=job.id, cursor=cursor, total=total, done=True
                    )
                store.update_job(
                    job.id, state=JobState.RUNNING, progress=cursor / total if total else 1.0
                )
                index_id = read_index_id(store)
                if index_id is None:
                    index_id = client.create_index(f"framepilot-{req.project_id}")
                    store_index_id(store, index_id)
        except TwelveLabsAuthError:
            return VisualIndexResponse(available=True, reason="invalid_api_key")
        except TwelveLabsError as exc:
            return VisualIndexResponse(available=True, reason=str(exc))
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualIndexResponse(available=False, reason=str(exc))

        # Phase 2 — upload/poll this slice's assets. An asset still indexing stops
        # the slice without advancing past it (resumable); the caller re-posts.
        slice_ids = asset_ids[cursor : cursor + req.max_assets]
        timeout = float(settings.asset_media_timeout_seconds)
        items: list[VisualIndexItem] = []
        indexed = advanced = 0
        stop_reason: str | None = None
        # Stills never reach TwelveLabs (see `_asset_is_still_image`); they are
        # embedded on the built-in path instead, so the hosted key does not withdraw
        # image understanding from a photo project. Resolved lazily because
        # `resolve_visual_embedder`/`resolve_captioner` each construct an HTTP client:
        # a video-only project must not pay for one on every slice.
        still_backend: tuple[VisualEmbedderResolution, SceneCaptioner | None, str] | None = None

        def _still_backend() -> tuple[VisualEmbedderResolution, SceneCaptioner | None, str]:
            nonlocal still_backend
            if still_backend is None:
                provider = req.caption_provider
                still_backend = (
                    resolve_visual_embedder(req.nvidia_keys or settings.nvidia_embeddings_keys),
                    resolve_captioner(
                        CaptionProviderConfig(
                            kind=provider.kind,
                            model=provider.model,
                            api_key=provider.api_key,
                            base_url=provider.base_url,
                        )
                        if provider is not None
                        else None
                    ).captioner,
                    provider.model if provider is not None else "",
                )
            return still_backend

        # Journaled on the job, not counted per slice: a slice is one asset by
        # default (`DEFAULT_VISUAL_SLICE`), so a per-slice counter could never
        # reach the bound and a broken index would upload every asset in the
        # project one call at a time.
        consecutive_failures = int(job.payload.get("consecutiveFailures", 0))
        try:
            with open_brain(resolved_root, req.project_id) as store:
                vstore = VisualVectorStore(store)
                for asset_id in slice_ids:
                    asset = store.get_asset(asset_id)
                    if asset is None:
                        items.append(
                            VisualIndexItem(
                                asset_id=asset_id, ok=False, reason="asset not known to brain"
                            )
                        )
                        advanced += 1
                        continue
                    if _asset_is_still_image(asset):
                        embed_res, still_captioner, still_caption_model = _still_backend()
                        item = _tl_still_image_item(
                            store,
                            vstore,
                            embed_res,
                            still_captioner,
                            still_caption_model,
                            asset_id,
                            resolved_root,
                            timeout,
                        )
                        items.append(item)
                        indexed += item.indexed
                        advanced += 1
                        continue
                    try:
                        media_path = resolve_within(resolved_root, asset.path)
                    except PathTraversalError as exc:
                        items.append(VisualIndexItem(asset_id=asset_id, ok=False, reason=str(exc)))
                        advanced += 1
                        continue
                    content_hash = asset.content_sha256 or _sha256_file(media_path)

                    # `upload` is invoked synchronously inside `poll_index_asset`
                    # (before this loop advances), so this closure over `media_path`
                    # has no late-binding hazard.
                    def _upload(idx: str = index_id, path: Path = media_path) -> str:
                        return client.create_index_task(idx, path)

                    try:
                        outcome = poll_index_asset(
                            client,
                            store,
                            index_id,
                            asset_id,
                            media_path.name,
                            upload=_upload,
                            content_hash=content_hash,
                        )
                    except TwelveLabsAuthError:
                        # Auth is a property of the key, not of this file: every
                        # remaining asset would fail identically. Stop the run.
                        stop_reason = "invalid_api_key"
                        break
                    except TwelveLabsError as exc:
                        # One asset the provider will not take (an unsupported or
                        # corrupt file) must NOT freeze the project. Before this,
                        # any TwelveLabsError broke the slice without advancing the
                        # cursor, so every re-post hit the same asset again and
                        # coverage stayed at 0/N forever — the reported defect.
                        # Record it as failed, advance, keep going.
                        reason = str(exc)
                        store_video_mapping(
                            store,
                            asset_id,
                            content_hash=content_hash,
                            status="failed",
                        )
                        items.append(VisualIndexItem(asset_id=asset_id, ok=False, reason=reason))
                        advanced += 1
                        consecutive_failures += 1
                        _log.warning(
                            "twelvelabs index asset failed: asset=%s reason=%s (%d consecutive)",
                            asset_id,
                            reason,
                            consecutive_failures,
                        )
                        if consecutive_failures >= TL_CONSECUTIVE_FAILURE_LIMIT:
                            # Not a bad file any more — a bad index/account/network.
                            # Stop before uploading (and being billed for) the rest.
                            stop_reason = reason
                            break
                        continue
                    consecutive_failures = 0
                    items.append(
                        VisualIndexItem(
                            asset_id=asset_id,
                            ok=outcome.ok,
                            indexed=outcome.newly_indexed,
                            reason=outcome.reason,
                        )
                    )
                    indexed += outcome.newly_indexed
                    if outcome.advanced:
                        advanced += 1
                    else:
                        break  # still indexing — yield the slice, keep the cursor
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualIndexResponse(available=False, reason=str(exc))

        # Phase 3 — persist the advanced cursor + terminal state.
        _ = timeout  # media timeout unused on the TL path (no local decode)
        new_cursor = cursor + advanced
        done = new_cursor >= total and stop_reason is None
        try:
            with open_brain(resolved_root, req.project_id) as store:
                store.update_job(
                    job.id,
                    # A job that stopped on a provider error is FAILED, not
                    # "running". It sat at `running` 0% for three retries in the
                    # reported defect, so the panel showed a blue progress badge
                    # for work that had already given up.
                    state=(
                        JobState.FAILED
                        if stop_reason is not None
                        else JobState.DONE
                        if done
                        else JobState.RUNNING
                    ),
                    progress=new_cursor / total if total else 1.0,
                    payload={
                        **job.payload,
                        "cursor": new_cursor,
                        "consecutiveFailures": consecutive_failures,
                    },
                    error=stop_reason,
                )
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualIndexResponse(available=False, reason=f"cursor not persisted: {exc}")

        _log.info(
            "ACT twelvelabs index: project=%s job=%s cursor=%d/%d done=%s indexed=%d",
            req.project_id,
            job.id,
            new_cursor,
            total,
            done,
            indexed,
        )
        return VisualIndexResponse(
            available=True,
            reason=stop_reason,
            job_id=job.id,
            cursor=new_cursor,
            total=total,
            done=done,
            indexed=indexed,
            captions_reason=tl_captions_reason,
            items=items,
        )

    @app.post("/brain/visual/index", response_model=VisualIndexResponse)
    def brain_visual_index_route(req: VisualIndexRequest) -> VisualIndexResponse:
        """Index a project's footage one bounded slice per call (plan MI4.1).

        The paced-slice journaled-job pattern (copying ``/analyze/batch``, not a
        background worker): each call resolves/advances a durable job, processes
        up to ``maxAssets`` assets (sample → embed → optionally caption → store),
        persists the advanced cursor, and returns ``{jobId, cursor, total, done}``;
        the caller re-posts until ``done``. Idempotent + resumable via
        ``existing_visual_span_keys``; cancellable via the payload flag. Honest-
        unavailable: no sandbox root, no embedding key, or a mid-batch key
        exhaustion all report a typed ``reason`` instead of crashing. Keys are
        never logged.
        """
        with _visual_index_lock(req.project_id):
            root = settings.projects_root
            if root is None:
                return VisualIndexResponse(
                    available=False,
                    reason="Visual indexing journals jobs in the brain, which requires a "
                    "configured sandbox root (set FRAMEPILOT_PROJECTS_ROOT).",
                )
            # TwelveLabs backend: when a key is configured, delegate understanding to
            # the hosted index instead of the built-in NVIDIA-embed pipeline.
            tl = resolve_twelvelabs(req.twelve_labs_key or settings.twelvelabs_api_key)
            if tl.client is not None:
                return _tl_index_slice(tl.client, req, root.resolve())
            embedder_res = resolve_visual_embedder(
                req.nvidia_keys or settings.nvidia_embeddings_keys
            )
            if embedder_res.client is None:
                # No key configured: nothing to index, reported honestly (never a stub).
                return VisualIndexResponse(available=True, reason=embedder_res.reason)

            caption_config = (
                CaptionProviderConfig(
                    kind=req.caption_provider.kind,
                    model=req.caption_provider.model,
                    api_key=req.caption_provider.api_key,
                    base_url=req.caption_provider.base_url,
                )
                if req.caption_provider is not None
                else None
            )
            captioner_res = resolve_captioner(caption_config)
            caption_model = req.caption_provider.model if req.caption_provider is not None else ""
            resolved_root = root.resolve()

            # Phase 1 — resolve/create the job, read its worklist + cursor. Opened and
            # CLOSED before any sampling so the per-slice connection never contends.
            try:
                with open_brain(resolved_root, req.project_id) as store:
                    sweep_interrupted_jobs_once(store, req.project_id)
                    job = _resolve_visual_job(store, req)
                    asset_ids = [str(a) for a in job.payload.get("assetIds", [])]
                    cursor = int(job.payload.get("cursor", 0))
                    total = len(asset_ids)
                    if job.payload.get("cancelled"):
                        return VisualIndexResponse(
                            available=True,
                            reason="cancelled",
                            job_id=job.id,
                            cursor=cursor,
                            total=total,
                        )
                    if cursor >= total:
                        store.update_job(job.id, state=JobState.DONE, progress=1.0)
                        return VisualIndexResponse(
                            available=True, job_id=job.id, cursor=cursor, total=total, done=True
                        )
                    store.update_job(
                        job.id, state=JobState.RUNNING, progress=cursor / total if total else 1.0
                    )
            except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
                return VisualIndexResponse(available=False, reason=str(exc))

            # Phase 2 — index this slice, asset by asset. A key exhaustion stops the
            # slice cleanly before advancing past the unprocessed asset (resumable).
            slice_ids = asset_ids[cursor : cursor + req.max_assets]
            timeout = float(settings.asset_media_timeout_seconds)
            items: list[VisualIndexItem] = []
            indexed = captioned = completed = 0
            exhausted: str | None = None
            try:
                with open_brain(resolved_root, req.project_id) as store:
                    vstore = VisualVectorStore(store)
                    for asset_id in slice_ids:
                        try:
                            item = _index_one_asset(
                                store,
                                vstore,
                                embedder_res.client,
                                captioner_res.captioner,
                                caption_model,
                                asset_id,
                                resolved_root,
                                timeout,
                            )
                        except KeyRingExhaustedError as exc:
                            exhausted = exc.last_error or EXHAUSTED_REASON
                            _log.warning(
                                "Visual index stopped: embedding keys exhausted (%s)", exhausted
                            )
                            break
                        except VisualEmbedError as exc:
                            # Non-retryable across every key (bad payload, malformed
                            # response) — rotating keys can't fix it, so stop the slice
                            # honestly rather than crash (mirrors /brain/visual/search).
                            exhausted = str(exc)
                            _log.warning(
                                "Visual index stopped: embedding request failed (%s)", exhausted
                            )
                            break
                        items.append(item)
                        indexed += item.indexed
                        captioned += item.captioned
                        completed += 1
            except (BrainError, BrainSchemaError, PathTraversalError, OSError, FFmpegError) as exc:
                return VisualIndexResponse(available=False, reason=str(exc))

            # Phase 3 — persist the advanced cursor + terminal state; embed captions.
            new_cursor = cursor + completed
            done = new_cursor >= total and exhausted is None
            captions_reason = captioner_res.reason if captioner_res.captioner is None else None
            try:
                with open_brain(resolved_root, req.project_id) as store:
                    store.update_job(
                        job.id,
                        # Same honesty rule as the hosted path: a slice that gave
                        # up on an exhausted key ring is FAILED, never "running".
                        state=(
                            JobState.FAILED
                            if exhausted is not None
                            else JobState.DONE
                            if done
                            else JobState.RUNNING
                        ),
                        progress=new_cursor / total if total else 1.0,
                        payload={**job.payload, "cursor": new_cursor},
                        error=EXHAUSTED_REASON if exhausted is not None else None,
                    )
                    if captioned and (req.project is not None or req.project_path is not None):
                        _reindex_embeddings_with_captions(
                            store, load_project_document(req.project_path, req.project)
                        )
                    elif captioned:
                        captions_reason = (
                            "no project document supplied; caption text-embeddings skipped"
                        )
            except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
                return VisualIndexResponse(available=False, reason=f"cursor not persisted: {exc}")

            _log.info(
                "ACT visual index: project=%s job=%s cursor=%d/%d done=%s indexed=%d captioned=%d",
                req.project_id,
                job.id,
                new_cursor,
                total,
                done,
                indexed,
                captioned,
            )
            return VisualIndexResponse(
                available=True,
                reason=EXHAUSTED_REASON if exhausted is not None else None,
                job_id=job.id,
                cursor=new_cursor,
                total=total,
                done=done,
                indexed=indexed,
                captioned=captioned,
                captions_reason=captions_reason,
                items=items,
            )

    @app.post("/brain/visual/index/cancel", response_model=VisualIndexCancelResponse)
    def brain_visual_index_cancel_route(
        req: VisualIndexCancelRequest,
    ) -> VisualIndexCancelResponse:
        """Cancel an in-flight visual-index job (plan MI4.1).

        Journals a ``cancelled`` flag on the job payload and marks it failed; the
        next ``/brain/visual/index`` slice short-circuits on the flag (the work is
        paced across HTTP calls, so there is no background loop to interrupt).
        """
        root = settings.projects_root
        if root is None:
            return VisualIndexCancelResponse(
                available=False,
                reason="projects_root is not configured (set FRAMEPILOT_PROJECTS_ROOT).",
            )
        try:
            with open_brain(root.resolve(), req.project_id) as store:
                job = store.get_job(req.job_id)
                if job is None or job.kind != VISUAL_JOB_KIND:
                    return VisualIndexCancelResponse(
                        available=False,
                        reason=f"No {VISUAL_JOB_KIND} job {req.job_id!r} to cancel.",
                    )
                updated = store.update_job(
                    job.id,
                    state=JobState.FAILED,
                    error="cancelled by user",
                    payload={**job.payload, "cancelled": True},
                )
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualIndexCancelResponse(available=False, reason=str(exc))
        _log.info("ACT visual index cancel: project=%s job=%s", req.project_id, job.id)
        return VisualIndexCancelResponse(available=True, job_id=updated.id, state=updated.state)

    @app.get("/brain/visual/status", response_model=VisualStatusResponse)
    def brain_visual_status_route(projectId: str) -> VisualStatusResponse:
        """Report visual-index coverage, counts, backend, and key/job health (MI4.3).

        Honest-unavailable: no sandbox root or an unusable brain reports
        ``available=False`` with the reason. ``keyConfigured`` is derived from the
        env setting (this GET carries no body) and the key itself is never
        returned.
        """
        # This GET carries no request body, so the TwelveLabs key (host-owned,
        # forwarded only on the index/search POSTs) is not visible here. Detect a
        # TwelveLabs-backed project from a signal that IS persisted: the project's
        # stored TL index id. Without this, a project indexed via a Settings key
        # (env unset) mislabels its backend as ``sqlite-vec`` and shows the NVIDIA
        # hint even while a TwelveLabs job runs — the "stuck on sqlite-vec" report.
        nvidia_key_configured = bool(parse_keys(settings.nvidia_embeddings_keys))
        env_tl_key = settings.twelvelabs_api_key is not None
        report = brain_status(settings.projects_root, projectId)
        if not report.available or settings.projects_root is None:
            # Brain unopenable: fall back to env-only backend detection.
            if env_tl_key:
                return VisualStatusResponse(
                    available=False,
                    reason=report.reason,
                    backend="twelvelabs",
                    key_configured=True,
                )
            return VisualStatusResponse(
                available=False, reason=report.reason, key_configured=nvidia_key_configured
            )
        try:
            with open_brain(settings.projects_root.resolve(), projectId) as store:
                total_assets = sum(1 for a in store.list_assets() if _asset_is_visual(a))
                last_job = _last_visual_job(store)
                # A stored TL index id (or the env key) means this project's
                # coverage is TwelveLabs-owned; the built-in vector store is empty.
                tl_active = env_tl_key or read_index_id(store) is not None
                if tl_active:
                    # Coverage is the UNION of both backends. A TwelveLabs project
                    # containing stills has them prepared on the built-in path
                    # (TwelveLabs cannot index a photo), so counting only the
                    # hosted mappings reported 0/61 on an all-photo project even
                    # once every photo was understood.
                    hosted = set(video_to_asset_map(store).values())
                    builtin = store.visual_indexed_asset_ids()
                    indexed = len(hosted | builtin)
                    return VisualStatusResponse(
                        available=True,
                        backend="twelvelabs",
                        counts={"videos": len(hosted), "images": len(builtin - hosted)},
                        indexed_assets=indexed,
                        total_assets=total_assets,
                        key_configured=env_tl_key,
                        last_job=last_job,
                    )
                counts = store.visual_index_counts()
                backend = VisualVectorStore(store).backend()
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualStatusResponse(
                available=False,
                reason=str(exc),
                backend="twelvelabs" if env_tl_key else None,
                key_configured=True if env_tl_key else nvidia_key_configured,
            )
        return VisualStatusResponse(
            available=True,
            backend=backend,
            counts=counts,
            indexed_assets=counts["assets"],
            total_assets=total_assets,
            key_configured=nvidia_key_configured,
            last_job=last_job,
        )

    def _tl_search(
        client: TwelveLabsClient, req: VisualSearchRequest, resolved_root: Path
    ) -> VisualSearchResponse:
        """Serve visual search through TwelveLabs (the ``twelveLabsKey`` backend).

        TwelveLabs fuses visual + audio + speech internally, so its ranked clips
        are mapped straight onto the evidence-packet contract (no local vector KNN
        / FTS). A project doc still supplies the clips + transcript used to enrich
        ``transcriptOverlap`` (plan MI5.2). Honest-unavailable: an unindexed
        project reports ``not_indexed``; an auth failure ``invalid_api_key``; a
        transport failure is ``available=False`` so the caller degrades cleanly.
        """
        project_doc: Project | None = None
        if req.project_path is not None or req.project is not None:
            project_doc = load_project_document(req.project_path, req.project)
        try:
            with open_brain(resolved_root, req.project_id) as store:
                index_id = read_index_id(store)
                video_to_asset = video_to_asset_map(store)
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualSearchResponse(available=False, reason=str(exc))
        if index_id is None:
            return VisualSearchResponse(available=True, backend="twelvelabs", reason="not_indexed")
        try:
            clips = client.search(index_id, req.query, page_limit=max(req.k, 10))
        except TwelveLabsAuthError:
            return VisualSearchResponse(
                available=True, backend="twelvelabs", reason="invalid_api_key"
            )
        except TwelveLabsError as exc:
            return VisualSearchResponse(available=False, reason=str(exc))

        clips_by_asset: dict[str, list[Any]] = {}
        utterances: list[Any] = []
        if project_doc is not None:
            for track in project_doc.timeline.tracks:
                for clip in track.clips:
                    clips_by_asset.setdefault(clip.asset_id, []).append(clip)
            utterances = segment_utterances(list(project_doc.transcript))
        packets = clips_to_packets(
            clips,
            video_to_asset=video_to_asset,
            clips_by_asset=clips_by_asset,
            utterances=utterances,
            k=req.k,
            asset_ids=req.asset_ids,
        )
        _log.info(
            "ACT twelvelabs search: project=%s clips=%d packets=%d",
            req.project_id,
            len(clips),
            len(packets),
        )
        return VisualSearchResponse(available=True, backend="twelvelabs", packets=packets)

    def _tl_transcribe(
        client: TwelveLabsClient, resolved_root: Path, project_id: str, asset_id: str
    ) -> list[dict[str, Any]] | None:
        """TwelveLabs' native transcription for one asset, or ``None`` if not indexed.

        Returns the words in the project's ``TranscriptWord`` shape (``word`` rather
        than TwelveLabs' ``value``) so the caller returns them exactly like a whisper
        transcript. ``None`` means this asset has no TwelveLabs video yet — the caller
        then falls back to local whisper. A TwelveLabs API failure raises so the route
        surfaces it honestly rather than silently degrading to a different backend.
        """
        try:
            with open_brain(resolved_root, project_id) as store:
                index_id = read_index_id(store)
                mapping = read_video_mapping(store, asset_id)
        except (BrainError, BrainSchemaError, PathTraversalError, OSError):
            return None
        if index_id is None or mapping is None or not mapping.ready or mapping.video_id is None:
            return None
        words = client.get_transcription(index_id, mapping.video_id)
        _log.info(
            "ACT twelvelabs transcribe: project=%s asset=%s → %d words",
            project_id,
            asset_id,
            len(words),
        )
        return [{"word": w.value, "start": w.start, "end": w.end} for w in words]

    def _pegasus_asset_map(
        client: TwelveLabsClient,
        store: Any,
        asset_id: str,
        *,
        content_hash: str,
        video_id: str | None,
        source_asset_id: str | None,
        index_id: str | None,
        can_fetch: bool,
        refresh: bool,
    ) -> tuple[list[Any], list[Any], str] | None:
        """One asset's Pegasus map (asset time): the CACHE is authoritative.

        Cache-first and index-INDEPENDENT (plan FI2.3): a stored map for the current
        ``content_hash`` is served without touching TwelveLabs, so a reopened project
        keeps its map even if the live index/mapping is gone (pruned server-side, a
        lost ``ready`` flag) — the very failure that made the map vanish on reopen.
        This is also what stops the re-billing: unchanged bytes → cache hit → zero
        Pegasus calls; only a genuine miss (new/changed footage) pays.

        A miss can be fetched only when ``can_fetch`` (a ready live mapping with a
        ``video_id``); otherwise ``None`` (no cache, nothing to charge for). ``refresh``
        forces a re-fetch past the cache — the explicit "rebuild" escape hatch, never
        the default. Raises the typed TwelveLabs errors so the route degrades honestly
        (auth / pegasus_unavailable / transport) — never a fabricated map.

        Pegasus 1.5 generates from the UPLOADED asset, so a fetch needs
        ``source_asset_id``. Mappings written before that id was persisted fall back to
        looking it up from the index once (``index_id`` + ``video_id``); a mapping we
        cannot resolve is an honest miss rather than a fabricated map.
        """
        if not refresh:
            cached = read_cached_pegasus(store, asset_id, content_hash=content_hash)
            if cached is not None:
                _log.debug("twelvelabs pegasus map cache hit: asset=%s", asset_id)
                return list(cached[0]), list(cached[1]), cached[2]
        if not can_fetch or video_id is None:
            # No cache and no live index to fetch from: honest miss, no API call.
            return None
        asset_ref = source_asset_id
        if asset_ref is None and index_id is not None:
            asset_ref = client.source_asset_id(index_id, video_id)
            if asset_ref is not None:
                # Backfill so the next miss (new bytes) needs no extra round trip.
                store_video_mapping(
                    store,
                    asset_id,
                    content_hash=content_hash,
                    status="ready",
                    video_id=video_id,
                    source_asset_id=asset_ref,
                )
        if asset_ref is None:
            _log.info(
                "twelvelabs pegasus map: no uploaded asset id for asset=%s — re-index to map it",
                asset_id,
            )
            return None
        chapters = client.summarize_chapters(asset_ref)
        highlights = client.summarize_highlights(asset_ref)
        gist = client.summarize_gist(asset_ref)
        # Persist even an empty-but-successful result so an unchanged asset is never
        # re-charged on the next open (plan FI2.3).
        store_cached_pegasus(
            store,
            asset_id,
            content_hash=content_hash,
            chapters=chapters,
            highlights=highlights,
            summary=gist.summary,
        )
        return list(chapters), list(highlights), gist.summary

    def _clips_by_asset(project_doc: Project | None) -> dict[str, list[Any]]:
        """Group a working project's clips by asset id (for span→timeline projection)."""
        out: dict[str, list[Any]] = {}
        if project_doc is None:
            return out
        for track in project_doc.timeline.tracks:
            for clip in track.clips:
                out.setdefault(clip.asset_id, []).append(clip)
        return out

    def _tl_footage_map(
        client: TwelveLabsClient,
        req: FootageMapRequest,
        resolved_root: Path,
        project_doc: Project | None,
    ) -> FootageMapResponse:
        """Build the footage map from Pegasus (the ``twelveLabsKey`` backend, plan FI2.1).

        Walks every asset the brain has mapped to a TwelveLabs video (or the one
        requested asset) and, per asset, serves the content-hash cache first —
        independent of the live index — so a reopened project keeps its map and an
        unchanged asset is never re-charged. Only a genuine cache miss on a still-ready
        mapping calls Pegasus (chapters/highlights/summary), which is then cached. Each
        asset's map is projected onto timeline time and merged in time order.

        Honest-unavailable: nothing cached and nothing live to fetch → ``not_indexed``;
        no Pegasus entitlement → ``pegasus_unavailable``; auth failure →
        ``invalid_api_key``; transport failure → ``available=False``.
        """
        clips_by_asset = _clips_by_asset(project_doc)
        chapters: list[FootageChapter] = []
        highlights: list[FootageHighlight] = []
        summaries: list[str] = []
        try:
            with open_brain(resolved_root, req.project_id) as store:
                index_id = read_index_id(store)
                # Every asset the brain has ever mapped to a TwelveLabs video — the
                # `tl:video` rows persist even if the live index is gone, so they still
                # give us (asset_id, content_hash) to serve the cache from on reopen.
                targets = sorted(set(video_to_asset_map(store).values()))
                if req.asset_id is not None:
                    targets = [a for a in targets if a == req.asset_id]
                served_assets = 0
                for asset_id in targets:
                    mapping = read_video_mapping(store, asset_id)
                    # content_hash falls back to the asset row so the cache is reachable
                    # even when only the mapping's hash is missing.
                    content_hash = mapping.content_hash if mapping is not None else None
                    if content_hash is None:
                        asset_row = store.get_asset(asset_id)
                        content_hash = asset_row.content_sha256 if asset_row is not None else None
                    if content_hash is None:
                        continue
                    # A live fetch is possible only with a ready mapping + a real index.
                    can_fetch = (
                        index_id is not None
                        and mapping is not None
                        and mapping.ready
                        and mapping.video_id is not None
                    )
                    pegasus = _pegasus_asset_map(
                        client,
                        store,
                        asset_id,
                        content_hash=content_hash,
                        video_id=mapping.video_id if mapping is not None else None,
                        source_asset_id=(mapping.source_asset_id if mapping is not None else None),
                        index_id=index_id,
                        # `cached_only` withdraws permission to fetch: a miss returns
                        # nothing rather than paying Pegasus for a caller that only
                        # wanted whatever was already there.
                        can_fetch=can_fetch and not req.cached_only,
                        refresh=req.refresh,
                    )
                    if pegasus is None:
                        # No cache and no live index to fetch from — skip this asset
                        # rather than charge for or fabricate a map.
                        continue
                    served_assets += 1
                    tl_chapters, tl_highlights, gist = pegasus
                    if req.asset_time:
                        # Asset-native: the footage's OWN structure, independent of the
                        # timeline (so it is complete even when the asset is unplaced or
                        # trimmed). The UI projects onto the timeline itself when editing.
                        for c in tl_chapters:
                            chapters.append(
                                FootageChapter(
                                    t0=c.start,
                                    t1=c.end,
                                    title=c.title,
                                    summary=c.summary,
                                    asset_id=asset_id,
                                )
                            )
                        for rank, h in enumerate(tl_highlights, start=1):
                            highlights.append(
                                FootageHighlight(
                                    t0=h.start,
                                    t1=h.end,
                                    label=h.label,
                                    score=1.0 / rank,
                                    asset_id=asset_id,
                                )
                            )
                    else:
                        for mc in map_pegasus_chapters(
                            tl_chapters, asset_id=asset_id, clips_by_asset=clips_by_asset
                        ):
                            chapters.append(
                                FootageChapter(
                                    t0=mc.t0,
                                    t1=mc.t1,
                                    title=mc.title,
                                    summary=mc.summary,
                                    asset_id=asset_id,
                                )
                            )
                        for mh in map_pegasus_highlights(
                            tl_highlights, asset_id=asset_id, clips_by_asset=clips_by_asset
                        ):
                            highlights.append(
                                FootageHighlight(
                                    t0=mh.t0,
                                    t1=mh.t1,
                                    label=mh.label,
                                    score=mh.score,
                                    asset_id=asset_id,
                                )
                            )
                    if gist:
                        summaries.append(gist)
                # Assets the hosted backend never mapped are understood by the
                # built-in index instead — stills are routed there because
                # TwelveLabs cannot index a photo. Their chapters ARE the entire
                # footage map of a photo project, so merge them here; without this
                # a 61-photo project answered `not_indexed` no matter how much of
                # it had been prepared.
                builtin_only = store.visual_indexed_asset_ids() - set(targets)
                builtin_chapters = _builtin_chapters_for(
                    store, req, clips_by_asset, only_assets=builtin_only
                )
                chapters.extend(builtin_chapters)
                served_assets += len({c.asset_id for c in builtin_chapters if c.asset_id})
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return FootageMapResponse(available=False, reason=str(exc))
        except TwelveLabsIndexNotGenerativeError:
            # The account's index predates Pegasus (Marengo-only), so /analyze can't
            # run — but its Marengo spans/captions are indexed, so the built-in
            # derivation gives a real, working map. Degrade to it rather than error;
            # recreating the index with Pegasus restores the richer Pegasus map.
            _log.info(
                "twelvelabs footage-map: index lacks Pegasus, using built-in map: project=%s",
                req.project_id,
            )
            return _builtin_footage_map(req, resolved_root, project_doc)
        except TwelveLabsPegasusUnavailableError:
            return FootageMapResponse(
                available=True, backend="twelvelabs", reason=PEGASUS_UNAVAILABLE_REASON
            )
        except TwelveLabsAuthError:
            return FootageMapResponse(
                available=True, backend="twelvelabs", reason="invalid_api_key"
            )
        except TwelveLabsError as exc:
            return FootageMapResponse(available=False, reason=str(exc))

        if served_assets == 0:
            return FootageMapResponse(available=True, backend="twelvelabs", reason="not_indexed")
        if req.asset_time:
            # Group by footage, then by source time — asset-native times from different
            # videos would interleave meaninglessly if sorted on time alone.
            chapters.sort(key=lambda c: (c.asset_id or "", c.t0, c.t1))
            highlights.sort(key=lambda h: (h.asset_id or "", -h.score, h.t0))
        else:
            chapters.sort(key=lambda c: (c.t0, c.t1))
            highlights.sort(key=lambda h: (-h.score, h.t0))
        duration = max([c.t1 for c in chapters] + [h.t1 for h in highlights] + [0.0])
        _log.info(
            "ACT twelvelabs footage-map: project=%s assets=%d chapters=%d highlights=%d",
            req.project_id,
            served_assets,
            len(chapters),
            len(highlights),
        )
        return FootageMapResponse(
            available=True,
            backend="twelvelabs",
            duration_sec=duration,
            chapters=chapters,
            highlights=highlights,
            summary=" ".join(summaries),
        )

    def _builtin_chapters_for(
        store: BrainStore,
        req: FootageMapRequest,
        clips_by_asset: dict[str, list[Any]],
        *,
        only_assets: set[str] | None = None,
    ) -> list[FootageChapter]:
        """Chapters derived from the BUILT-IN visual index, for an open brain.

        Shared by the built-in map and the hosted map: a TwelveLabs project can
        still contain assets only the built-in index understands (stills), and
        those chapters are the whole footage map for a photo project. ``only_assets``
        narrows the derivation to the assets the hosted arm did not already serve,
        so a merged map never lists an asset twice.
        """
        spans = [
            span
            for span in store.list_visual_spans(model=MODEL_ID)
            if (req.asset_id is None or span.asset_id == req.asset_id)
            and (only_assets is None or span.asset_id in only_assets)
        ]
        captions = {
            (caption.asset_id, caption.scene_index): caption.text
            for caption in store.list_visual_captions(req.asset_id)
            if is_informative_caption(caption.text)
        }
        chapters: list[FootageChapter] = []
        for span in spans:
            if req.asset_time:
                # Asset-native: the span's own source seconds, independent of the edit.
                t0, t1 = span.t0, span.t1
            else:
                ranges = project_span_to_timeline(
                    span.t0, span.t1, clips_by_asset.get(span.asset_id, [])
                )
                t0, t1 = (ranges[0][0], ranges[-1][1]) if ranges else (span.t0, span.t1)
            caption = captions.get((span.asset_id, span.scene_index))
            chapters.append(
                FootageChapter(
                    t0=t0,
                    t1=t1,
                    title=caption or f"Scene {span.scene_index + 1}",
                    summary=caption or "",
                    asset_id=span.asset_id,
                )
            )
        return chapters

    def _builtin_footage_map(
        req: FootageMapRequest, resolved_root: Path, project_doc: Project | None
    ) -> FootageMapResponse:
        """Derive the footage map from indexed spans/captions (built-in parity, D3).

        No key or network call: chapters are the already-indexed visual spans
        (captioned where a caption exists), projected onto timeline time. Highlights
        are left empty — the built-in index has no salience signal, and an honest
        empty list beats a fabricated one. Honest-absent when nothing is indexed.
        """
        clips_by_asset = _clips_by_asset(project_doc)
        try:
            with open_brain(resolved_root, req.project_id) as store:
                backend = VisualVectorStore(store).backend()
                chapters = _builtin_chapters_for(store, req, clips_by_asset)
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return FootageMapResponse(available=False, reason=str(exc))

        if not chapters:
            return FootageMapResponse(available=True, backend=backend, reason="not_indexed")
        if req.asset_time:
            chapters.sort(key=lambda c: (c.asset_id or "", c.t0, c.t1))
        else:
            chapters.sort(key=lambda c: (c.t0, c.t1))
        duration = max([c.t1 for c in chapters] + [0.0])
        _log.info(
            "ACT visual footage-map: project=%s backend=%s chapters=%d",
            req.project_id,
            backend,
            len(chapters),
        )
        return FootageMapResponse(
            available=True,
            backend=backend,
            duration_sec=duration,
            chapters=chapters,
            highlights=[],
            summary="",
        )

    @app.post("/brain/visual/footage-map", response_model=FootageMapResponse)
    def brain_visual_footage_map_route(req: FootageMapRequest) -> FootageMapResponse:
        """Time-ordered structural digest of a project's footage (plan FI2.1/§4).

        The "map this video with no query" surface. The TwelveLabs arm calls Pegasus
        (cached, content-hash keyed); the built-in arm derives the map from indexed
        spans/captions. Honest-unavailable at every gate — no sandbox root / no key /
        no Pegasus entitlement / not indexed → a typed reason, never a fabricated map.
        """
        root = settings.projects_root
        if root is None:
            return FootageMapResponse(
                available=False,
                reason="The footage map reads the project brain, which requires a configured "
                "sandbox root (set FRAMEPILOT_PROJECTS_ROOT).",
            )
        project_doc: Project | None = None
        if req.project_path is not None or req.project is not None:
            project_doc = load_project_document(req.project_path, req.project)
        tl = resolve_twelvelabs(req.twelve_labs_key or settings.twelvelabs_api_key)
        if tl.client is not None:
            return _tl_footage_map(tl.client, req, root.resolve(), project_doc)
        return _builtin_footage_map(req, root.resolve(), project_doc)

    @app.post("/brain/visual/search", response_model=VisualSearchResponse)
    def brain_visual_search_route(req: VisualSearchRequest) -> VisualSearchResponse:
        """Fused visual search over vectors + captions + transcript (plan MI5.1/§3.4).

        Embeds the query cross-modally (nemotron ``input_type='query'`` — never
        stored), runs the visual KNN, caption/transcript FTS, and text-vector
        recall in one brain session, then fuses them by reciprocal rank into
        evidence packets (:mod:`framepilot_engine.brain.visual_search`). An
        optional project source supplies the clips that project spans onto
        timeline time and the transcript for ``transcriptOverlap`` (plan MI5.2).
        Honest-unavailable: no sandbox root or unusable brain → ``available=False``;
        no key / key exhaustion → ``available=True`` with the typed reason and no
        packets. Keys and query text are never logged.
        """
        root = settings.projects_root
        if root is None:
            return VisualSearchResponse(
                available=False,
                reason="Visual search reads the project brain, which requires a configured "
                "sandbox root (set FRAMEPILOT_PROJECTS_ROOT).",
            )
        tl = resolve_twelvelabs(req.twelve_labs_key or settings.twelvelabs_api_key)
        if tl.client is not None:
            return _tl_search(tl.client, req, root.resolve())
        embedder_res = resolve_visual_embedder(req.nvidia_keys or settings.nvidia_embeddings_keys)
        if embedder_res.client is None:
            # No embedding key: the query cannot be embedded — reported honestly.
            return VisualSearchResponse(available=True, reason=embedder_res.reason)

        project_doc: Project | None = None
        if req.project_path is not None or req.project is not None:
            project_doc = load_project_document(req.project_path, req.project)

        try:
            query_vector = embedder_res.client.embed_query(req.query)
        except KeyRingExhaustedError as exc:
            _log.warning("Visual search stopped: embedding keys exhausted")
            return VisualSearchResponse(available=True, reason=exc.last_error or EXHAUSTED_REASON)
        except VisualEmbedError as exc:
            return VisualSearchResponse(available=False, reason=str(exc))

        text_res = embedder_resolution()
        try:
            with open_brain(root.resolve(), req.project_id) as store:
                if project_doc is not None and store.fts_available:
                    reindex_project_fts(store, project_doc)
                vstore = VisualVectorStore(store)
                backend = vstore.backend()
                visual_hits = vstore.search(
                    query_vector,
                    VISUAL_SEARCH_POOL,
                    asset_ids=req.asset_ids,
                    time_range=req.time_range,
                )
                caption_fts = store.search_captions(req.query, limit=VISUAL_SEARCH_POOL)
                transcript_fts = store.search_transcript(req.query, limit=VISUAL_SEARCH_POOL)
                semantic: list[SearchHit] = []
                if text_res.embedder is not None:
                    rows = store.list_embeddings(text_res.embedder.model_id)
                    semantic = semantic_hits(
                        text_res.embedder, req.query, rows, limit=VISUAL_SEARCH_POOL
                    )
                spans = store.list_visual_spans(model=MODEL_ID)
                captions = [
                    caption
                    for caption in store.list_visual_captions()
                    if is_informative_caption(caption.text)
                ]
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualSearchResponse(available=False, reason=str(exc))

        clips = (
            [clip for track in project_doc.timeline.tracks for clip in track.clips]
            if project_doc is not None
            else []
        )
        utterances = (
            segment_utterances(list(project_doc.transcript)) if project_doc is not None else []
        )
        packets = build_evidence_packets(
            visual_hits=visual_hits,
            caption_fts_hits=caption_fts,
            transcript_fts_hits=transcript_fts,
            semantic_hits=semantic,
            spans=spans,
            captions=captions,
            clips=clips,
            utterances=utterances,
            k=req.k,
            asset_ids=req.asset_ids,
            time_range=req.time_range,
        )
        _log.info(
            "ACT visual search: project=%s backend=%s visual=%d caption=%d transcript=%d "
            "semantic=%d packets=%d",
            req.project_id,
            backend,
            len(visual_hits),
            len(caption_fts),
            len(transcript_fts),
            len(semantic),
            len(packets),
        )
        return VisualSearchResponse(available=True, backend=backend, packets=packets)

    def _tl_describe(
        client: TwelveLabsClient, req: VisualDescribeRequest, resolved_root: Path
    ) -> VisualSearchResponse:
        """Enumerate one asset on TwelveLabs via Pegasus' cached chapter map (FI2.2).

        Walks the asset's Pegasus chapters (cached, content-hash keyed) in time
        order into evidence packets — the describe contract, now backed by real
        comprehension instead of a "not supported" stub. Honest-unavailable:
        unindexed → ``not_indexed``; no entitlement → ``pegasus_unavailable``.
        """
        project_doc: Project | None = None
        if req.project_path is not None or req.project is not None:
            project_doc = load_project_document(req.project_path, req.project)
        clips_by_asset = _clips_by_asset(project_doc)
        utterances = (
            segment_utterances(list(project_doc.transcript)) if project_doc is not None else []
        )
        try:
            with open_brain(resolved_root, req.project_id) as store:
                index_id = read_index_id(store)
                mapping = read_video_mapping(store, req.asset_id)
                if (
                    index_id is None
                    or mapping is None
                    or not mapping.ready
                    or mapping.video_id is None
                    or mapping.content_hash is None
                ):
                    return VisualSearchResponse(
                        available=True, backend="twelvelabs", reason="not_indexed"
                    )
                pegasus = _pegasus_asset_map(
                    client,
                    store,
                    req.asset_id,
                    content_hash=mapping.content_hash,
                    video_id=mapping.video_id,
                    source_asset_id=mapping.source_asset_id,
                    index_id=index_id,
                    can_fetch=True,
                    refresh=False,
                )
                # The guard above guarantees a live mapping, so the cache miss is
                # always fetchable — `None` cannot occur here, but stay honest if it does.
                if pegasus is None:
                    return VisualSearchResponse(
                        available=True, backend="twelvelabs", reason="not_indexed"
                    )
                chapters, _highlights, _gist = pegasus
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualSearchResponse(available=False, reason=str(exc))
        except TwelveLabsPegasusUnavailableError:
            return VisualSearchResponse(
                available=True, backend="twelvelabs", reason=PEGASUS_UNAVAILABLE_REASON
            )
        except TwelveLabsAuthError:
            return VisualSearchResponse(
                available=True, backend="twelvelabs", reason="invalid_api_key"
            )
        except TwelveLabsError as exc:
            return VisualSearchResponse(available=False, reason=str(exc))

        if req.time_range is not None:
            lo, hi = req.time_range
            chapters = [c for c in chapters if c.start <= hi and lo <= c.end]
        packets = chapters_to_packets(
            chapters,
            asset_id=req.asset_id,
            clips_by_asset=clips_by_asset,
            utterances=utterances,
        )
        _log.info(
            "ACT twelvelabs describe: project=%s asset=%s chapters=%d",
            req.project_id,
            req.asset_id,
            len(packets),
        )
        return VisualSearchResponse(available=True, backend="twelvelabs", packets=packets)

    @app.post("/brain/visual/describe", response_model=VisualSearchResponse)
    def brain_visual_describe_route(req: VisualDescribeRequest) -> VisualSearchResponse:
        """Walk one asset's complete indexed visual record in asset-time order.

        This is intentionally not implemented as a semantic search with a neutral
        query. A ranked top-k search can omit spans and its result changes with the
        embedding model, so it cannot satisfy ``describe_footage``'s enumeration
        contract. Existing derived rows are enough; no NVIDIA key or network call is
        required.
        """
        root = settings.projects_root
        if root is None:
            return VisualSearchResponse(
                available=False,
                reason="Visual description reads the project brain, which requires a configured "
                "sandbox root (set FRAMEPILOT_PROJECTS_ROOT).",
            )
        # The TwelveLabs backend has no local per-scene span store, but Pegasus'
        # cached chapter map IS a time-ordered walk of the footage — exactly what
        # describe enumerates (plan FI2.2, fixes G1). Serve that instead of the old
        # "not supported" stub; still honest when the map is unavailable.
        tl = resolve_twelvelabs(req.twelve_labs_key or settings.twelvelabs_api_key)
        if tl.client is not None:
            return _tl_describe(tl.client, req, root.resolve())

        project_doc: Project | None = None
        if req.project_path is not None or req.project is not None:
            project_doc = load_project_document(req.project_path, req.project)

        try:
            with open_brain(root.resolve(), req.project_id) as store:
                backend = VisualVectorStore(store).backend()
                spans = [
                    span
                    for span in store.list_visual_spans(model=MODEL_ID)
                    if span.asset_id == req.asset_id
                    and (
                        req.time_range is None
                        or (span.t0 <= req.time_range[1] and req.time_range[0] <= span.t1)
                    )
                ]
                captions = [
                    caption
                    for caption in store.list_visual_captions(req.asset_id)
                    if is_informative_caption(caption.text)
                ]
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return VisualSearchResponse(available=False, reason=str(exc))

        clips = (
            [
                clip
                for track in project_doc.timeline.tracks
                for clip in track.clips
                if clip.asset_id == req.asset_id
            ]
            if project_doc is not None
            else []
        )
        utterances = (
            segment_utterances(list(project_doc.transcript)) if project_doc is not None else []
        )
        caption_by_scene = {caption.scene_index: caption.text for caption in captions}
        packets = [
            EvidencePacket(
                asset_id=span.asset_id,
                t0=span.t0,
                t1=span.t1,
                scene_index=span.scene_index,
                # Enumeration has no relevance ranking. A constant keeps the existing
                # evidence-packet wire shape without pretending to be confidence.
                score=1.0,
                caption=caption_by_scene.get(span.scene_index),
                transcript_overlap=transcript_overlap(
                    project_span_to_timeline(span.t0, span.t1, clips), utterances
                ),
                sources=["visual-index"],
            )
            for span in sorted(spans, key=lambda item: (item.t0, item.t1, item.scene_index))
        ]
        _log.info(
            "ACT visual describe: project=%s asset=%s backend=%s packets=%d",
            req.project_id,
            req.asset_id,
            backend,
            len(packets),
        )
        return VisualSearchResponse(available=True, backend=backend, packets=packets)

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        """Liveness probe used by the desktop shell on sidecar startup."""
        return HealthResponse()

    @app.post(
        "/render", status_code=status.HTTP_202_ACCEPTED, response_model=RenderAcceptedResponse
    )
    def render_route(req: RenderRequest) -> RenderAcceptedResponse:
        """Submit a final export to the async render queue (plan H1.3, PRD §9.3/§18.3).

        Returns immediately with the queued job id instead of blocking until
        FFmpeg finishes; poll ``GET /render/jobs/{job_id}`` for progress and the
        final result. This is an engine-only contract change: the desktop/
        web-editor callers still expect the old synchronous 200+``RenderJob``
        shape and need a follow-up to switch to polling (see CHANGELOG.md).
        """
        project_path = sandbox(req.project_path)
        project = _load_project(project_path)
        opts = RenderOptions(
            preset_id=req.preset,
            preview=False,
            burn_captions=req.burn_captions,
            denoise=req.denoise,
            eq=req.eq,
            compression=req.compression,
            loudness=req.loudness,
            limiter=req.limiter,
        )
        task_id = render_queue.submit(
            QueuedRenderRequest(project=project, opts=opts, base_dir=str(project_path.parent))
        )
        _log.info(
            "ACT export queued: job=%s preset=%s burn_captions=%s path=%s",
            task_id,
            req.preset,
            req.burn_captions,
            project_path.name,
        )
        return RenderAcceptedResponse(job_id=task_id, status=JobStatus.QUEUED)

    @app.get("/render/jobs/{job_id}", response_model=RenderTask)
    def render_job_status_route(job_id: str) -> RenderTask:
        """Poll a submitted render's status/result (plan H1.3).

        ``RenderTask.result`` carries the same :class:`RenderJob` shape the old
        synchronous ``/render`` response used, so callers can treat it as a
        compatible view once the job reaches ``completed``/``failed``.
        """
        task = render_queue.get(job_id)
        if task is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No render job {job_id!r}.")
        return task

    @app.post("/render/jobs/{job_id}/cancel", response_model=RenderTask)
    def render_job_cancel_route(job_id: str) -> RenderTask:
        """Cancel a queued or running render (plan H1.3).

        Idempotent: cancelling an already-terminal (completed/failed/cancelled)
        job is a no-op that returns its unchanged, final state rather than
        erroring. Unknown ``job_id`` is a 404.
        """
        task = render_queue.get(job_id)
        if task is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No render job {job_id!r}.")
        render_queue.cancel(job_id)
        return render_queue.get(job_id)  # type: ignore[return-value]

    @app.post("/render/preview", response_model=RenderJob)
    def render_preview_route(req: RenderPreviewRequest) -> RenderJob:
        """Render a fast, downscaled preview and return the completed/failed job.

        Deliberately kept SYNCHRONOUS, unlike ``/render`` (plan H1.3): previews
        are downscaled to half-resolution (see ``_PREVIEW_SCALE`` in
        ``render/pipeline.py``) and used for short-lived scrub/inspect flows
        where the caller wants an immediate result, not a job to poll. A full
        export has no such bound, which is why it moved to the async queue.
        """
        return _run_render(
            sandbox(req.project_path), req.preset, preview=True, burn_captions=req.burn_captions
        )

    @app.post("/render/frame", response_model=RenderFrameResponse)
    def render_frame_route(req: RenderFrameRequest) -> RenderFrameResponse:
        """Composite ONE frame of the timeline and return it inline as base64.

        Synchronous, like ``/render/preview`` and for the same reason: the caller
        wants the picture now, not a job to poll. See
        :mod:`framepilot_engine.render.frame_grab` for why this goes through the
        real compiler rather than drawing a frame some cheaper way.
        """
        project, media_base, label = resolve_project_source(req)
        try:
            frame = grab_frame(
                project,
                media_base,
                req.time_seconds,
                preset_id=req.preset,
                max_dimension=req.max_dimension,
                image_format=req.image_format,
                burn_captions=req.burn_captions,
            )
        except FrameGrabError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        _log.info(
            "ACT frame served: t=%.3fs size=%dx%d source=%s",
            frame.time_seconds,
            frame.width,
            frame.height,
            label,
        )
        return RenderFrameResponse(
            media_type=frame.media_type,
            base64=frame.base64,
            width=frame.width,
            height=frame.height,
            time_seconds=frame.time_seconds,
            duration_seconds=frame.duration_seconds,
        )

    @app.post("/review/temporal-evidence", response_model=TemporalEvidenceBatch)
    async def temporal_evidence_route(
        req: TemporalEvidenceBatchRequest,
        request: Request,
    ) -> TemporalEvidenceBatch:
        """Measure requested frames, scopes, motion, and audio from one revision.

        This route returns evidence, never an editorial verdict. The AI SDK's
        deterministic reviewer owns thresholds and refuses missing/stale results.
        """
        project, media_base, label = resolve_project_source(req)
        cancelled = threading.Event()

        async def watch_disconnect() -> None:
            while not cancelled.is_set():
                if await request.is_disconnected():
                    cancelled.set()
                    return
                await asyncio.sleep(0.05)

        disconnect_watcher = asyncio.create_task(watch_disconnect())
        try:
            # Serialized on purpose. A batch compiles the timeline (an ffmpeg reader
            # per source clip) and decodes frames at project resolution, so its cost
            # is measured in GB, not MB. Routes run in Starlette's 40-slot threadpool,
            # so without this gate N callers each allocate a full budget at once —
            # which is exactly how a fast multi-turn agent run took a machine down.
            # The client-side bound in `review-findings.ts` is the other half; this
            # one holds for every caller, including the MCP server.
            async with _temporal_evidence_gate:
                batch = await run_in_threadpool(
                    acquire_temporal_evidence,
                    project,
                    media_base,
                    req.requests,
                    cancelled.is_set,
                )
        except TemporalEvidenceError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        finally:
            cancelled.set()
            disconnect_watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await disconnect_watcher
        _log.info(
            "ACT temporal evidence served: requests=%d source=%s",
            len(req.requests),
            label,
        )
        return batch

    @app.post("/validate-render", response_model=ValidationReport)
    def validate_render_route(req: ValidateRenderRequest) -> ValidationReport:
        """Validate a rendered output (PRD §9.4)."""
        output_path = sandbox(req.output_path)
        expected = ExpectedRender(
            duration_seconds=req.expected_duration_seconds,
            expect_audio=req.expect_audio,
            expect_video=req.expect_video,
        )
        return validate_render(output_path, expected)

    @app.post("/inspect-media", response_model=MediaInfo)
    def inspect_media_route(req: InspectMediaRequest) -> MediaInfo:
        """Probe a media file (plan 2.1)."""
        input_path = sandbox(req.input_path)
        try:
            return inspect_media(input_path)
        except FileNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
        except FFmpegError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    @app.post("/asset-media", response_model=AssetMediaResponse)
    def asset_media_route(req: AssetMediaRequest) -> AssetMediaResponse:
        """Probe an imported asset and derive read-only media for the timeline
        (duration + kind + waveform peaks). Drives the desktop import path so the
        renderer never computes media itself (plan Phase 8; render-vs-preview).

        Every ffmpeg/ffprobe subprocess spawned here (probe, waveform decode,
        thumbnail extraction) is bounded by ``settings.asset_media_timeout_seconds``
        (env ``FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS``) so a crafted or looping
        input cannot hang the import path (security follow-up, plan Phase 9.5)."""
        # Loopback-only route; the path is sandbox-checked before any disk access.
        derive_timeout = float(settings.asset_media_timeout_seconds)
        input_path = sandbox(req.input_path)
        try:
            info = inspect_media(input_path, timeout=derive_timeout)
        except FileNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
        except FFmpegError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

        has_video = len(info.video_streams) > 0
        duration = info.duration_seconds
        # A still image is a single-frame video stream that ffprobe reports with a
        # bogus ~0.04s duration; classify it on the container format, not duration
        # (see MediaInfo.is_image), or every photo imports as a zero-length "video"
        # and the timeline chases filmstrip frames that were never derived — the
        # fp-media ENOENT flood. Images take the own-source thumbnail path and get
        # no proxy (see derive_thumbnails / derive_proxy_path).
        kind = "image" if info.is_image else "video" if has_video else "audio"

        peaks: list[float] | None = None
        peaks_per_second: float | None = None
        try:
            waveform = extract_waveform(input_path, buckets=req.buckets, timeout=derive_timeout)
            peaks = waveform.peaks
            if waveform.duration_seconds > 0:
                peaks_per_second = waveform.bucket_count / waveform.duration_seconds
        except (FFmpegError, FileNotFoundError):
            # No audio track (image / silent video) or a decode that timed out:
            # peaks stay None — the timeline falls back to a skeleton. Not an error.
            peaks = None

        thumbnail_paths = derive_thumbnails(
            input_path, kind, duration, req.thumbnails, timeout=derive_timeout
        )
        proxy_path = derive_proxy_path(input_path, kind, duration) if req.proxy else None
        brain_recorded = record_asset_in_brain(input_path, req.project_id, req.asset_id, info)

        return AssetMediaResponse(
            durationSeconds=duration,
            kind=kind,
            peaks=peaks,
            peaksPerSecond=peaks_per_second,
            thumbnailPaths=thumbnail_paths,
            proxyPath=proxy_path,
            brainRecorded=brain_recorded,
        )

    def resolve_project_source(source: AnalysisProjectSource) -> tuple[Project, Path, str]:
        """Load the project a request names — saved path OR inline document.

        The same either/or contract :func:`resolve_asset_media` implements, but
        for callers that need the whole PROJECT rather than one asset's media
        (rendering composites every clip, so there is no single asset to resolve).
        Media paths are still sandbox-checked downstream by ``index_assets``, so
        inlining a document never widens what the engine may read.

        :returns: ``(project, media_base_dir, label)`` — the label is for logs
            only, never for the response.
        :raises HTTPException: 400 on a load/validation failure.
        """
        if source.project_path is not None:
            resolved = sandbox(source.project_path)
            try:
                return ProjectFile.load(resolved), resolved.parent, resolved.name
            except ProjectFileError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        payload = {k: v for k, v in (source.project or {}).items() if k != "schemaVersion"}
        try:
            project = Project.model_validate(payload)
        except PydanticValidationError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Invalid inline project: {exc}"
            ) from exc
        return project, settings.projects_root or Path.cwd(), "inline"

    def resolve_asset_media(
        source: AnalysisProjectSource,
        asset_id: str | None,
        *,
        need_audio: bool,
        prefer_kind: str | None = None,
    ) -> tuple[str, Path]:
        """Load a project (saved or inline) and resolve the media to analyse.

        Analysis reads a raw source, so it resolves the asset's declared path
        relative to the project file's directory — or, for an INLINE project
        document (the agent loop's unsaved working copy), relative to the
        configured projects root — and sandbox-checks it before any ffmpeg
        runs. When ``asset_id`` is omitted the first asset of a compatible kind
        is chosen (audio-bearing for silence/beats, video for scenes) so the
        common "analyse my clip" call needs no id.

        :param prefer_kind: Tried first when picking that default asset. Beat
            detection wants the soundtrack: in a bin holding both footage and a
            music file, "first compatible asset" is document order, which lands on
            silent footage as often as on the track the caller meant.
        :returns: The resolved ``(asset_id, media_path)``.
        :raises HTTPException: 400 on project-load/validation failure, 404 when
            no matching asset exists.
        """
        if source.project_path is not None:
            resolved_project = sandbox(source.project_path)
            try:
                project = ProjectFile.load(resolved_project)
            except ProjectFileError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
            media_base = resolved_project.parent
        else:
            # Inline document: strip the schemaVersion envelope (as ProjectFile.load
            # does) and validate. Media paths still go through sandbox() below —
            # an inline project cannot widen what the engine may read.
            payload = {k: v for k, v in (source.project or {}).items() if k != "schemaVersion"}
            try:
                project = Project.model_validate(payload)
            except PydanticValidationError as exc:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"Invalid inline project: {exc}"
                ) from exc
            media_base = settings.projects_root or Path.cwd()

        compatible = {"video", "audio"} if need_audio else {"video"}
        asset = None
        if asset_id is not None:
            asset = next((a for a in project.assets if a.id == asset_id), None)
            if asset is None:
                # List the real, analysable asset ids in the error so a caller that
                # passed a hallucinated/mistyped id (a known LLM failure mode — e.g.
                # appending a scene index to the id) can self-correct on the next
                # turn instead of dead-ending on a bare 404. Bounded so a huge bin
                # never bloats the message.
                known = [a.id for a in project.assets if a.kind in compatible]
                shown = ", ".join(known[:10]) or "(none)"
                more = f" (+{len(known) - 10} more)" if len(known) > 10 else ""
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND,
                    f"Asset {asset_id!r} not found in project. Known asset ids: {shown}{more}.",
                )
        else:
            preferred = (
                next((a for a in project.assets if a.kind == prefer_kind), None)
                if prefer_kind in compatible
                else None
            )
            asset = preferred or next((a for a in project.assets if a.kind in compatible), None)
            if asset is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND,
                    "No asset with the required media kind to analyse.",
                )
        # Resolve the declared (project-relative) path inside the sandbox.
        media_path = sandbox(str(media_base / asset.path))
        return asset.id, media_path

    def run_analyzer(
        kind: AnalysisKind,
        media_path: Path,
        info: MediaInfo,
        *,
        timeout: float,
        asset_id: str | None = None,
    ) -> AnalysisEntry:
        """Run one analyzer for the unified pass, mapping every outcome to a
        typed :class:`AnalysisEntry` (plan B1.2).

        Per-kind failures never abort the pass: an incompatible asset is
        ``skipped``, a missing capability (whisper binary/model, no decodable
        audio) is ``unavailable`` (honest-unavailable, never fabricated), and a
        runtime error is ``failed`` with the reason — the remaining analyzers
        still return.
        """
        needs_audio = kind in {
            AnalysisKind.SILENCE,
            AnalysisKind.LOUDNESS,
            AnalysisKind.BEATS,
            AnalysisKind.TRANSCRIPTION,
        }
        needs_video = kind in {AnalysisKind.SCENES, AnalysisKind.BLACK, AnalysisKind.FREEZE}
        if needs_audio and not info.has_audio:
            return AnalysisEntry(
                kind=kind, status=AnalysisEntryStatus.SKIPPED, reason="Asset has no audio stream."
            )
        if needs_video and (not info.has_video or info.is_image):
            return AnalysisEntry(
                kind=kind,
                status=AnalysisEntryStatus.SKIPPED,
                reason="Asset has no video timeline to analyse.",
            )

        duration = info.duration_seconds
        try:
            if kind is AnalysisKind.PROBE:
                result: dict[str, Any] = info.model_dump(mode="json")
            elif kind is AnalysisKind.SILENCE:
                ranges = detect_silence(media_path, total_duration=duration, timeout=timeout)
                result = {"ranges": [r.model_dump(mode="json") for r in ranges]}
            elif kind is AnalysisKind.SCENES:
                cuts = detect_scenes(media_path, timeout=timeout)
                result = {"cuts": [c.model_dump(mode="json") for c in cuts]}
            elif kind is AnalysisKind.LOUDNESS:
                loudness = measure_loudness(media_path, timeout=timeout)
                if loudness is None:
                    return AnalysisEntry(
                        kind=kind,
                        status=AnalysisEntryStatus.UNAVAILABLE,
                        reason="ffmpeg decoded no measurable audio (ebur128 reported nothing).",
                    )
                result = loudness.model_dump(mode="json", by_alias=True)
            elif kind is AnalysisKind.BLACK:
                blacks = detect_black(media_path, timeout=timeout)
                result = {"ranges": [r.model_dump(mode="json") for r in blacks]}
            elif kind is AnalysisKind.BEATS:
                try:
                    beat_analysis = detect_beats(media_path, timeout=timeout)
                except NoAudioStreamError as exc:
                    # Silent footage has nothing to detect — UNAVAILABLE (the analyzer had
                    # no input), not FAILED (the analyzer broke). Same shape as LOUDNESS
                    # above, and it keeps a caller's run alive on a video-only asset.
                    return AnalysisEntry(
                        kind=kind, status=AnalysisEntryStatus.UNAVAILABLE, reason=str(exc)
                    )
                result = {
                    "beats": [b.model_dump(mode="json") for b in beat_analysis.beats],
                    "bpm": beat_analysis.bpm,
                }
            elif kind is AnalysisKind.FREEZE:
                freezes = detect_freezes(media_path, total_duration=duration, timeout=timeout)
                result = {"ranges": [r.model_dump(mode="json") for r in freezes]}
            else:  # AnalysisKind.TRANSCRIPTION
                words = transcribe(media_path, timeout=timeout)
                result = {
                    "words": [
                        w.model_copy(update={"asset_id": asset_id}).model_dump(
                            mode="json", by_alias=True
                        )
                        for w in words
                    ]
                }
        except (WhisperCliNotFoundError, AsrModelMissingError) as exc:
            return AnalysisEntry(kind=kind, status=AnalysisEntryStatus.UNAVAILABLE, reason=str(exc))
        except (FFmpegError, AsrError, FileNotFoundError) as exc:
            _log.warning("Analyzer %s failed for %s: %s", kind, media_path.name, exc)
            return AnalysisEntry(kind=kind, status=AnalysisEntryStatus.FAILED, reason=str(exc))
        return AnalysisEntry(kind=kind, status=AnalysisEntryStatus.OK, result=result)

    def run_analyze_pass(req: AnalyzeRequest) -> AnalyzeResponse:
        """Run one asset's depth-tiered analysis pass, cache-through the brain.

        Extracted from the ``/analyze`` route so the chunked ``/analyze/batch``
        runner (plan B5.2) reuses the exact same per-asset semantics — cache
        lookup, provenance-tracked persistence, sidecar export, bin-summary
        regeneration — one asset at a time.
        """
        timeout = float(settings.asset_media_timeout_seconds)
        resolved_id, media_path = resolve_asset_media(req, req.asset_id, need_audio=True)
        try:
            info = inspect_media(media_path, timeout=timeout)
        except FileNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
        except FFmpegError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

        # Brain persistence is best-effort (plan B0.5/B1.3): any failure to open
        # or hash degrades to a fresh, unpersisted pass — never a request error.
        root = settings.projects_root
        brain: BrainStore | None = None
        content_sha: str | None = None
        if req.project_id is not None and root is not None:
            try:
                content_sha = _sha256_file(media_path)
                brain = open_brain(root.resolve(), req.project_id)
            except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
                _log.warning(
                    "Brain unavailable for /analyze (project=%s); computing fresh: %s",
                    req.project_id,
                    exc,
                )
                brain = None

        entries: list[AnalysisEntry] = []
        persisted = False
        try:
            if brain is not None and content_sha is not None:
                # The asset row is the cache anchor: keep its content hash and
                # probe current so a re-encoded source visibly invalidates.
                brain.upsert_asset(
                    resolved_id,
                    path=media_path.relative_to(root.resolve()).as_posix()
                    if root is not None and media_path.is_relative_to(root.resolve())
                    else str(media_path),
                    content_sha256=content_sha,
                    probe=info.model_dump(mode="json"),
                )
            for kind in kinds_for(req.depth, req.kinds):
                params_hash = analysis_params_hash(
                    kind, analyzer_effective_params(kind), content_sha256=content_sha
                )
                if brain is not None and content_sha is not None:
                    row = brain.get_analysis(resolved_id, kind=kind, params_hash=params_hash)
                    if row is not None:
                        entries.append(
                            AnalysisEntry(
                                kind=kind,
                                status=AnalysisEntryStatus.OK,
                                result=row.result,
                                cached=True,
                            )
                        )
                        continue
                entry = run_analyzer(kind, media_path, info, timeout=timeout, asset_id=resolved_id)
                entries.append(entry)
                if (
                    brain is not None
                    and content_sha is not None
                    and entry.status is AnalysisEntryStatus.OK
                    and entry.result is not None
                ):
                    brain.record_analysis(
                        resolved_id,
                        kind=kind,
                        depth=req.depth,
                        params_hash=params_hash,
                        result=entry.result,
                        tool=f"{kind}@v{ANALYZER_VERSIONS[kind]}",
                    )
                    persisted = True
            if persisted and brain is not None and root is not None:
                # Keep the portable JSON export in lockstep with the DB (B0.3).
                export_asset_sidecar(
                    brain, brain_dir_for(root.resolve(), str(req.project_id)), resolved_id
                )
            if brain is not None and root is not None:
                # Regenerate the media-bin digest after every pass (B1.5) — even a
                # pure cache-hit pass, so a deleted/missing digest self-heals.
                write_bin_summary(brain, brain_dir_for(root.resolve(), str(req.project_id)))
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            _log.warning(
                "Brain write failed during /analyze (project=%s); results still returned: %s",
                req.project_id,
                exc,
            )
        finally:
            if brain is not None:
                brain.close()

        _log.info(
            "ACT analyze: asset=%s depth=%s persisted=%s → %s",
            resolved_id,
            req.depth,
            persisted,
            ", ".join(f"{e.kind}:{'cache' if e.cached else e.status}" for e in entries),
        )
        return AnalyzeResponse(asset_id=resolved_id, depth=req.depth, results=entries)

    @app.post("/analyze", response_model=AnalyzeResponse)
    def analyze_route(req: AnalyzeRequest) -> AnalyzeResponse:
        """Run a depth-tiered analysis pass over one asset (plan B1.2).

        quick = probe+silence; standard = +scenes+loudness+black;
        deep = +beats+freeze+transcription. An explicit ``kinds`` list
        overrides the tier. The single-analyzer routes remain for callers
        that need custom parameters (back-compat).
        """
        return run_analyze_pass(req)

    def _resolve_batch_job(store: BrainStore, req: AnalyzeBatchRequest) -> JobRow:
        """Get the caller's in-flight batch job, or create one with a fixed worklist.

        A continuation call (``jobId`` names an existing job) resumes it as-is —
        the worklist and depth are whatever the job was created with, never
        re-derived, so pacing is stable across turns. A fresh job's worklist is
        the explicit ``assetIds`` (deduped, order preserved) or every analysable
        asset in the project; its id is minted when the caller supplied none.
        """
        if req.job_id is not None:
            existing = store.get_job(req.job_id)
            if existing is not None:
                if existing.kind != BATCH_JOB_KIND:
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        f"Job {req.job_id!r} exists but is not an {BATCH_JOB_KIND} job.",
                    )
                return existing
        if req.asset_ids is not None:
            asset_ids = list(dict.fromkeys(req.asset_ids))
        else:
            project = load_project_document(req.project_path, req.project)
            asset_ids = [a.id for a in project.assets if a.kind in ANALYZABLE_ASSET_KINDS]
        job_id = req.job_id or f"{BATCH_JOB_KIND}-{uuid4().hex}"
        return store.create_job(
            job_id,
            kind=BATCH_JOB_KIND,
            payload={"assetIds": asset_ids, "depth": str(req.depth), "cursor": 0},
        )

    @app.post("/analyze/batch", response_model=AnalyzeBatchResponse)
    def analyze_batch_route(req: AnalyzeBatchRequest) -> AnalyzeBatchResponse:
        """Analyse a media bin one bounded slice per call (plan B5.2).

        The davinci ``media_analysis_jobs`` pattern: instead of one call that
        risks the 120s timeout on a bin of many assets, the agent loop *paces*
        the work across turns. Each call processes up to ``maxAssets`` assets
        starting at the job's persisted cursor, advances the cursor in the
        brain ``jobs`` journal, and returns ``{jobId, cursor, total, done}``.
        The caller repeats with the returned ``jobId`` until ``done``.

        The asset worklist is fixed when the job is created (from an explicit
        ``assetIds`` or every analysable asset in the project) and stored in
        the job payload, so pacing is stable even if the working copy changes
        mid-run. Per-asset failures never abort the batch: the asset is
        reported ``ok=false`` with the reason and the cursor still advances
        (no silent loss, no infinite retry). Honest-unavailable: no sandbox
        root reports ``available=false`` with the reason.
        """
        root = settings.projects_root
        if root is None:
            return AnalyzeBatchResponse(
                available=False,
                reason="Batch analysis journals jobs in the brain, which requires a "
                "configured sandbox root (set FRAMEPILOT_PROJECTS_ROOT).",
            )

        # Phase 1 — resolve or create the job, read its worklist + cursor. The
        # brain is opened only for this bookkeeping and CLOSED before any
        # analysis runs, so run_analyze_pass's own per-asset brain connection
        # never contends with this one (single-writer, one connection at a time).
        try:
            with open_brain(root.resolve(), req.project_id) as store:
                sweep_interrupted_jobs_once(store, req.project_id)
                job = _resolve_batch_job(store, req)
                asset_ids = [str(a) for a in job.payload.get("assetIds", [])]
                depth = AnalysisDepth(job.payload.get("depth", req.depth))
                cursor = int(job.payload.get("cursor", 0))
                total = len(asset_ids)
                if cursor >= total:
                    # Already finished (idempotent re-poll of a completed job).
                    return AnalyzeBatchResponse(
                        available=True,
                        job_id=job.id,
                        cursor=cursor,
                        total=total,
                        done=True,
                    )
                store.update_job(
                    job.id, state=JobState.RUNNING, progress=cursor / total if total else 1.0
                )
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            return AnalyzeBatchResponse(available=False, reason=str(exc))

        # Phase 2 — analyse this slice. Each asset reuses run_analyze_pass, which
        # opens/persists its own brain pass; a per-asset error is captured, never
        # fatal to the batch.
        slice_ids = asset_ids[cursor : cursor + req.max_assets]
        items: list[AnalyzeBatchItem] = []
        for asset_id in slice_ids:
            asset_req = AnalyzeRequest.model_validate(
                {
                    **({"project_path": req.project_path} if req.project_path else {}),
                    **({"project": req.project} if req.project is not None else {}),
                    "projectId": req.project_id,
                    "assetId": asset_id,
                    "depth": depth,
                }
            )
            try:
                pass_result = run_analyze_pass(asset_req)
                items.append(
                    AnalyzeBatchItem(
                        asset_id=asset_id, ok=True, depth=depth, results=pass_result.results
                    )
                )
            except HTTPException as exc:
                _log.warning("Batch analyse skipped asset %s: %s", asset_id, exc.detail)
                items.append(AnalyzeBatchItem(asset_id=asset_id, ok=False, reason=str(exc.detail)))

        # Phase 3 — persist the advanced cursor + terminal state.
        new_cursor = cursor + len(slice_ids)
        done = new_cursor >= total
        try:
            with open_brain(root.resolve(), req.project_id) as store:
                store.update_job(
                    job.id,
                    state=JobState.DONE if done else JobState.RUNNING,
                    progress=new_cursor / total if total else 1.0,
                    payload={**job.payload, "cursor": new_cursor},
                )
        except (BrainError, BrainSchemaError, PathTraversalError, OSError) as exc:
            # The analysis itself is persisted per asset; only the journal cursor
            # could not advance. Report honestly so the caller can retry rather
            # than loop forever thinking it never progressed.
            return AnalyzeBatchResponse(available=False, reason=f"cursor not persisted: {exc}")

        _log.info(
            "ACT analyze batch: project=%s job=%s cursor=%d/%d done=%s slice=%d",
            req.project_id,
            job.id,
            new_cursor,
            total,
            done,
            len(slice_ids),
        )
        return AnalyzeBatchResponse(
            available=True,
            job_id=job.id,
            cursor=new_cursor,
            total=total,
            done=done,
            items=items,
        )

    @app.get("/brain/analysis", response_model=BrainAnalysisResponse)
    def brain_analysis_route(
        projectId: str, assetId: str | None = None, kind: str | None = None
    ) -> BrainAnalysisResponse:
        """Read persisted analysis rows from a project's brain (plan B1.3/B1.4).

        The TS orchestrator warms its ``AnalysisResultsBag`` from this route at
        run start instead of re-running ffmpeg. Honest-unavailable: a missing
        root/brain reports ``available=False`` with the reason and zero rows.
        """
        report = brain_status(settings.projects_root, projectId)
        if not report.available:
            return BrainAnalysisResponse(available=False, reason=report.reason)
        root = settings.projects_root
        assert root is not None  # available=True implies a configured root
        try:
            with open_brain(root.resolve(), projectId) as store:
                rows = store.list_analysis(assetId, kind=kind)
        except (BrainError, BrainSchemaError, PathTraversalError) as exc:
            return BrainAnalysisResponse(available=False, reason=str(exc))
        return BrainAnalysisResponse(available=True, results=rows)

    def sweep_interrupted_jobs_once(store: BrainStore, project_id: str) -> int:
        """Flag a project's non-terminal jobs ``interrupted`` on first touch (B5.1).

        The durable job journal only earns its keep if work cut off by a
        sidecar crash/restart is *visible* instead of silently stuck as
        ``queued``/``running`` forever. On the first time this process opens a
        given project's brain for job work, any still-non-terminal job is
        flagged ``interrupted`` — it cannot be making progress, because no job
        runs in the background here (each ``/analyze/batch`` slice completes
        within its request). Idempotent per process, so a job created *after*
        the sweep in this same process is never touched.
        """
        with _swept_brain_jobs_lock:
            if project_id in _swept_brain_jobs:
                return 0
            _swept_brain_jobs.add(project_id)
        flagged = store.mark_interrupted_jobs()
        if flagged:
            _log.info(
                "ACT brain jobs sweep: project=%s flagged %d interrupted", project_id, flagged
            )
        return flagged

    @app.get("/brain/jobs", response_model=BrainJobsResponse)
    def brain_jobs_route(projectId: str, state: str | None = None) -> BrainJobsResponse:
        """List a project's journaled jobs, oldest first (plan B5.1).

        On the first touch this process, non-terminal jobs left over from a
        prior run are flagged ``interrupted`` first (see
        :func:`sweep_interrupted_jobs_once`) so a restart never hides lost work.
        Honest-unavailable: a missing root/brain reports ``available=False``
        with the reason and zero jobs. An unknown ``state`` filter is a 422.
        """
        parsed_state: JobState | None = None
        if state is not None:
            try:
                parsed_state = JobState(state)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    f"Unknown job state {state!r}; expected one of "
                    f"{', '.join(s.value for s in JobState)}.",
                ) from exc
        report = brain_status(settings.projects_root, projectId)
        if not report.available:
            return BrainJobsResponse(available=False, reason=report.reason)
        root = settings.projects_root
        assert root is not None  # available=True implies a configured root
        try:
            with open_brain(root.resolve(), projectId) as store:
                sweep_interrupted_jobs_once(store, projectId)
                jobs = store.list_jobs(state=parsed_state)
        except (BrainError, BrainSchemaError, PathTraversalError) as exc:
            return BrainJobsResponse(available=False, reason=str(exc))
        return BrainJobsResponse(available=True, jobs=jobs)

    def resolve_brain_dir(project_id: str) -> Path:
        """The sandboxed brain directory for a project id (plan B6.1).

        :raises HTTPException: 503 with no configured root, 400 on traversal.
        """
        root = settings.projects_root
        if root is None:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Project memory requires a configured sandbox root (set FRAMEPILOT_PROJECTS_ROOT).",
            )
        try:
            return brain_dir_for(root, project_id)
        except PathTraversalError as exc:  # untrusted project_id
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    def resolve_soul_root() -> Path:
        """The cross-project soul directory (plan B6.2).

        Settings win over the ``~/.framepilot/soul`` default so a test or a
        portable install never writes the real home directory.
        """
        return settings.soul_root if settings.soul_root is not None else soul_root()

    @app.post("/brain/memory", response_model=BrainMemoryResponse)
    def brain_memory_route(req: BrainMemoryRequest) -> BrainMemoryResponse:
        """Append one entry to a project's narrative memory (plan B6.1/B6.2).

        Fed by the host's ``recordRejected``/``recordAccepted`` and run
        summaries. A ``corrections`` entry also feeds the cross-project
        promotion heuristic: the same correction in a second project promotes it
        to the soul (B6.2). Passing ``soulDoc`` is the explicit "remember this
        across projects" path and writes the soul directly.

        Writes only markdown — no project mutation, so nothing here needs the
        patch engine.
        """
        brain_dir = resolve_brain_dir(req.project_id)
        ts = datetime.now(UTC).isoformat()
        entry = MemoryEntry(
            tier=req.tier, title=req.title, body=req.body, patch_id=req.patch_id, ts=ts
        )
        path = append_memory_entry(brain_dir, entry)
        root = resolve_soul_root()
        promoted = False
        if req.tier is MemoryTier.CORRECTIONS:
            promoted = note_correction(root, req.title, req.project_id, ts=ts)
        soul_path: Path | None = None
        if req.soul_doc is not None:
            soul_path = append_soul_note(
                root,
                req.soul_doc,
                title=req.title,
                ts=ts,
                body=req.body,
                project_id=req.project_id,
            )
        return BrainMemoryResponse(
            available=True,
            path=str(path),
            promoted=promoted,
            soul_path=str(soul_path) if soul_path is not None else None,
        )

    @app.post("/brain/session-context", response_model=SessionContext)
    def brain_session_context_route(req: SessionContextRequest) -> SessionContext:
        """Assemble everything a model should know at session start (plan B6.3).

        The davinci ``session_start_context`` idea, budget-aware: the media
        digest, the last session's note, the recent corrections/decisions, and
        the cross-project soul — bounded to their tails so this can be injected
        as a context tier rather than dumped.

        ``available=False`` only when we genuinely cannot look (no sandbox root,
        traversal-rejected id). A project with no brain yet is available with
        empty sections and a ``status`` that says ``exists: false`` — a first
        run is not an error.
        """
        root = settings.projects_root
        if root is None:
            return SessionContext(
                available=False,
                reason=(
                    "projects_root is not configured (set FRAMEPILOT_PROJECTS_ROOT); "
                    "session context lives under the sandboxed derived directory."
                ),
            )
        project_id = req.project_id
        if project_id is None:
            if req.project_path is None and req.project is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "projectId is required when no project source is supplied.",
                )
            project_id = load_project_document(req.project_path, req.project).id
        try:
            brain_dir = brain_dir_for(root, project_id)
        except PathTraversalError as exc:  # untrusted project_id
            return SessionContext(available=False, reason=str(exc))
        summary_path = bin_summary_path(brain_dir)
        bin_summary = summary_path.read_text(encoding="utf-8") if summary_path.exists() else ""
        context = SessionContext(
            available=True,
            status=brain_status(root, project_id),
            bin_summary=bin_summary,
            session_note=latest_session_note(brain_dir),
            corrections=tail_entries(
                read_tier(brain_dir, MemoryTier.CORRECTIONS), SESSION_CONTEXT_TAIL_ENTRIES
            ),
            decisions=tail_entries(
                read_tier(brain_dir, MemoryTier.DECISIONS), SESSION_CONTEXT_TAIL_ENTRIES
            ),
            soul=soul_digest(resolve_soul_root()),
        )
        _log.info("ACT session context: project=%s", project_id)
        return context

    @app.post("/analyze-silence", response_model=SilenceAnalysisResponse)
    def analyze_silence_route(req: AnalyzeSilenceRequest) -> SilenceAnalysisResponse:
        """Detect silent ranges in an asset's audio (ffmpeg silencedetect, plan 9.2)."""
        timeout = float(settings.asset_media_timeout_seconds)
        resolved_id, media_path = resolve_asset_media(req, req.asset_id, need_audio=True)
        # Omitted optionals fall back to the analysis defaults (no None override).
        noise = req.noise_floor_db if req.noise_floor_db is not None else DEFAULT_NOISE_FLOOR_DB
        min_gap = (
            req.min_silence_seconds
            if req.min_silence_seconds is not None
            else DEFAULT_MIN_SILENCE_SECONDS
        )
        try:
            ranges = detect_silence(
                media_path,
                noise_floor_db=noise,
                min_silence_seconds=min_gap,
                timeout=timeout,
            )
        except NoAudioStreamError as exc:
            # A video-only asset is a fact about the file, not a decode fault — and "this
            # media has no silence to report" is a RESULT, exactly like the empty `beats`
            # a silent asset returns from /detect-beats. Reporting it as an error would
            # terminate a whole agent run over one silent-video asset.
            _log.info("ACT analyze-silence: asset=%s → no audio track (%s)", resolved_id, exc)
            return SilenceAnalysisResponse(asset_id=resolved_id, ranges=[], reason=str(exc))
        except (FFmpegError, FileNotFoundError) as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        _log.info("ACT analyze-silence: asset=%s → %d silent ranges", resolved_id, len(ranges))
        return SilenceAnalysisResponse(asset_id=resolved_id, ranges=ranges)

    @app.post("/detect-scenes", response_model=SceneAnalysisResponse)
    def detect_scenes_route(req: DetectScenesRequest) -> SceneAnalysisResponse:
        """Detect scene-cut timestamps in an asset's video (ffmpeg scene score, plan 9.2)."""
        timeout = float(settings.asset_media_timeout_seconds)
        resolved_id, media_path = resolve_asset_media(req, req.asset_id, need_audio=False)
        threshold = req.threshold if req.threshold is not None else DEFAULT_SCENE_THRESHOLD
        try:
            cuts = detect_scenes(media_path, threshold=threshold, timeout=timeout)
        except (FFmpegError, FileNotFoundError) as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        _log.info("ACT detect-scenes: asset=%s → %d scene cuts", resolved_id, len(cuts))
        return SceneAnalysisResponse(asset_id=resolved_id, cuts=cuts)

    @app.post("/detect-beats", response_model=BeatAnalysisResponse)
    def detect_beats_route(req: DetectBeatsRequest) -> BeatAnalysisResponse:
        """Detect beat/onset timestamps + BPM in an asset's audio (plan AGENT-NATIVE-UX T6)."""
        timeout = float(settings.asset_media_timeout_seconds)
        resolved_id, media_path = resolve_asset_media(
            req, req.asset_id, need_audio=True, prefer_kind="audio"
        )
        sensitivity = req.sensitivity if req.sensitivity is not None else DEFAULT_SENSITIVITY
        try:
            analysis = detect_beats(media_path, sensitivity=sensitivity, timeout=timeout)
        except NoAudioStreamError as exc:
            # A silent clip is a fact about the asset, not a decode fault — and "this media
            # has no beats" is a RESULT, exactly like the empty `ranges` a fully-loud clip
            # returns from /analyze-silence. Reporting it as an error made a single silent
            # asset terminate a whole agent run; reporting it as an empty analysis with the
            # reason attached lets the caller pick a music asset or edit without a grid.
            _log.info("ACT detect-beats: asset=%s → no audio track (%s)", resolved_id, exc)
            return BeatAnalysisResponse(asset_id=resolved_id, beats=[], bpm=None, reason=str(exc))
        except (FFmpegError, FileNotFoundError) as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        _log.info(
            "ACT detect-beats: asset=%s → %d beats, bpm=%s",
            resolved_id,
            len(analysis.beats),
            f"{analysis.bpm:.1f}" if analysis.bpm is not None else "unknown",
        )
        return BeatAnalysisResponse(asset_id=resolved_id, beats=analysis.beats, bpm=analysis.bpm)

    @app.get("/asr/status", response_model=AsrStatusResponse)
    def asr_status_route(model: str = DEFAULT_ASR_MODEL) -> AsrStatusResponse:
        """Report local whisper-cli binary + model readiness (plan H0.1)."""
        status = get_status(model)
        return AsrStatusResponse(
            binary_available=status.binary_available,
            binary_path=status.binary_path,
            model=status.model,
            model_present=status.model_present,
            model_path=status.model_path,
            download_size_bytes=status.download_size_bytes,
        )

    @app.post("/asr/setup", response_model=AsrSetupResponse)
    async def asr_setup_route(req: AsrSetupRequest) -> AsrSetupResponse:
        """Download + SHA256-verify the local ASR model (explicit step, plan H0.1).

        Runs on a worker thread rather than inline: the download takes tens of
        seconds to minutes, and awaiting it on the event loop would freeze every
        other route — including ``GET /asr/setup/progress``, the one the UI needs
        most while this is running.
        """
        try:
            path = await run_in_threadpool(asr_setup.run, req.model)
        except AsrSetupBusyError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        except AsrSetupCancelledError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        except AsrModelChecksumError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        except AsrError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        _log.info("ACT asr setup: model=%s path=%s", req.model, path)
        return AsrSetupResponse(model=req.model, path=str(path))

    @app.get("/asr/setup/progress", response_model=AsrSetupProgressResponse)
    def asr_setup_progress_route() -> AsrSetupProgressResponse:
        """Real byte-level progress of the in-flight (or last) model download."""
        return AsrSetupProgressResponse.of(asr_setup.snapshot())

    @app.post("/asr/setup/cancel", response_model=AsrSetupProgressResponse)
    def asr_setup_cancel_route() -> AsrSetupProgressResponse:
        """Abort an in-flight model download; the partial file is discarded.

        Idempotent: cancelling when nothing is running is a no-op that reports
        the current state, not an error.
        """
        asr_setup.cancel()
        return AsrSetupProgressResponse.of(asr_setup.snapshot())

    @app.post("/transcribe", response_model=TranscribeResponse)
    def transcribe_route(req: TranscribeRequest) -> TranscribeResponse:
        """Transcribe an asset's audio with the local whisper-cli ASR (plan H0.1).

        Honest-unavailable: a missing binary/model is reported as 503 (never a
        fabricated transcript) so the caller can surface an actionable "run
        setup" message instead of silently producing empty/fake captions.
        """
        timeout = float(settings.asset_media_timeout_seconds)
        resolved_id, media_path = resolve_asset_media(req, req.asset_id, need_audio=True)

        # Provider selection is explicit. Falling from TwelveLabs to local whisper
        # would make Settings lie, change privacy/cost behavior, and make accuracy
        # unpredictable. The desktop host indexes the requested asset first; this
        # route then reads TwelveLabs' native word-level transcript.
        if req.provider == "twelvelabs":
            tl = resolve_twelvelabs(req.twelve_labs_key or settings.twelvelabs_api_key)
            root = settings.projects_root
            if tl.client is None:
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    tl.reason or "TwelveLabs is not configured.",
                )
            if req.project_id is None or root is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "TwelveLabs transcription needs a saved project and configured projects root.",
                )
            try:
                tl_words = _tl_transcribe(tl.client, root.resolve(), req.project_id, resolved_id)
            except TwelveLabsAuthError as exc:
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
            except TwelveLabsError as exc:
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
            if tl_words is None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "TwelveLabs has not finished indexing this asset yet. "
                    "Retry after indexing completes.",
                )
            return TranscribeResponse(
                asset_id=resolved_id,
                words=[{**word, "assetId": resolved_id} for word in tl_words],
            )

        try:
            words = transcribe(
                media_path, model=req.model, timeout=timeout, use_cache=req.use_cache
            )
        except (WhisperCliNotFoundError, AsrModelMissingError) as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
        except AsrError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        _log.info("ACT transcribe: asset=%s → %d words", resolved_id, len(words))
        # Stamp the attribution here (schema v12, ADR 0076): this is the one place
        # that knows which asset was transcribed, and an unattributed transcript is
        # ambiguous the moment a project has two camera files. `by_alias` because
        # the TS contract reads camelCase — a bare model_dump() would emit
        # `asset_id` and the mapper would never see it.
        return TranscribeResponse(
            asset_id=resolved_id,
            words=[
                w.model_copy(update={"asset_id": resolved_id}).model_dump(by_alias=True)
                for w in words
            ],
        )

    @app.post("/asr/prepare-audio")
    def asr_prepare_audio_route(req: TranscribeRequest) -> Response:
        """Decode an asset's audio to a mono-16k PCM WAV for host-side chunking.

        The hosted ASR providers (groq/nvidia) run in the desktop host — their API
        keys never reach the sidecar — so long audio is split into fixed windows and
        uploaded from there. The only place that can decode arbitrary media is the
        engine, so it returns the canonical WAV and the host slices + transcribes it.
        Same sandbox contract as ``/transcribe`` (saved project, need_audio).
        """
        timeout = float(settings.asset_media_timeout_seconds)
        _resolved_id, media_path = resolve_asset_media(req, req.asset_id, need_audio=True)
        try:
            wav = extract_mono16k_wav(media_path, timeout=timeout)
        except AsrError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        return Response(content=wav, media_type="audio/wav")

    return app


def _sha256_file(path: Path, *, chunk_bytes: int = 1 << 20) -> str:
    """Streaming SHA256 of a file — the brain's cache-invalidation key (B1.3).

    Chunked so a minutes-long camera original never loads into memory at once.
    """
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_bytes):
            digest.update(chunk)
    return digest.hexdigest()


def _load_project(project_path: Path) -> Project:
    """Load a project file, mapping load failures to HTTP 400.

    ``project_path`` is already sandbox-resolved by the route (see
    ``create_app.sandbox``); this function never re-derives it from raw input.
    Shared by the async ``/render`` submit path and the synchronous preview
    path so the "is this project loadable" validation lives in one place.
    """
    try:
        return ProjectFile.load(project_path)
    except ProjectFileError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


def _run_render(
    project_path: Path,
    preset: str | None,
    *,
    preview: bool,
    burn_captions: bool = False,
    denoise: bool = False,
    loudness: str | None = None,
    limiter: bool = False,
) -> RenderJob:
    """Load a project and render it synchronously (used by the preview route only).

    The render driver itself never raises (failures become a ``FAILED`` job), so
    only project-load errors surface as HTTP errors here.
    """
    path = project_path
    project = _load_project(path)
    opts = RenderOptions(
        preset_id=preset,
        preview=preview,
        burn_captions=burn_captions,
        denoise=denoise,
        loudness=loudness,
        limiter=limiter,
    )
    _log.info(
        "ACT render start: preset=%s preview=%s burn_captions=%s path=%s",
        preset,
        preview,
        burn_captions,
        path.name,
    )
    job = render(project, opts, base_dir=path.parent)
    _log.info("ACT render done: state=%s output=%s", job.state, getattr(job, "output_path", None))
    return job


def serve(host: str | None = None, port: int | None = None) -> None:
    """Run the sidecar via uvicorn using configured host/port.

    :param host: Override bind host; defaults to ``settings.python_api_host``.
    :param port: Override bind port; defaults to ``settings.python_api_port``.
    """
    import uvicorn  # Local import keeps CLI --help fast and import graph lean.

    settings = get_settings()
    uvicorn.run(
        create_app(settings),
        host=host or settings.python_api_host,
        port=port or settings.python_api_port,
        log_level=settings.log_level,
    )
