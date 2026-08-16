"""Typed rows for the Project Brain (plan B0.1).

WHY: every persisted shape in FramePilot is a validated Pydantic model (the
Python half of the Zod↔Pydantic parity discipline), never an ad-hoc dict.
These models are the contract between the SQLite tables in
:mod:`framepilot_engine.brain.migrations`, the JSON sidecar exports in
:mod:`framepilot_engine.brain.sidecars`, and the HTTP surface in ``service.py``.

Serialization uses camelCase aliases to mirror the TS conventions used by
``project.fp.json`` and every other IPC payload.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_serializer


class Provenance(StrEnum):
    """Who produced a stored value (davinci ``field_changelog`` rule).

    ``HUMAN`` values are protected: :meth:`~framepilot_engine.brain.store.BrainStore.write_field`
    refuses to overwrite them with ``MACHINE``/``MODEL`` values (plan B0.2).
    """

    MACHINE = "machine"  # deterministic tooling: ffprobe/ffmpeg/whisper parsers
    MODEL = "model"  # an LLM's judgment (e.g. vision labels, plan B4)
    HUMAN = "human"  # explicit user input/override — never silently overwritten


class JobState(StrEnum):
    """Lifecycle of a journaled brain job (plan B0.1 table, consumed by B5.1).

    ``INTERRUPTED`` marks jobs found non-terminal after a sidecar restart, so
    interrupted work is visible instead of silently lost.
    """

    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class MemoryTier(StrEnum):
    """Which narrative markdown file a memory entry belongs to (plan B6.1).

    The typed stores stay authoritative for *preferences* (``memory-store.ts``);
    these tiers are the **narrative** layer a model reads as prose:

    - ``CORRECTIONS``: edits the user rejected, and why (fed by ``recordRejected``).
    - ``DECISIONS``: edits the user accepted (fed by ``recordAccepted``).
    - ``SESSION_NOTES``: per-day run summaries, one file per date.
    """

    CORRECTIONS = "corrections"
    DECISIONS = "decisions"
    SESSION_NOTES = "session_notes"


class MemoryEntry(BaseModel):
    """One appended narrative memory entry (plan B6.1).

    ``patch_id`` is what makes a correction *traceable* (plan B6.4): it ties the
    prose back to a real entry in the project's patch history, so "the user
    rejected this" can always be resolved to the exact patch instead of staying
    an unfalsifiable claim.
    """

    tier: MemoryTier
    title: str = Field(description="One-line summary — the entry's markdown heading.")
    body: str = Field(default="", description="Free prose: the reason, the detail.")
    patch_id: str | None = Field(
        default=None,
        alias="patchId",
        description="Patch this entry is about; traces prose back to real history (B6.4).",
    )
    ts: str = Field(description="ISO-8601 UTC; also picks a session note's date file.")

    model_config = {"populate_by_name": True}


class AssetRow(BaseModel):
    """One media asset the brain knows about (mirrors a project ``Asset``)."""

    id: str
    path: str = Field(description="Asset path relative to the project, as declared.")
    content_sha256: str | None = Field(
        default=None,
        alias="contentSha256",
        description="Streaming SHA256 of the source bytes; the cache-invalidation key (B1.3).",
    )
    probe: dict[str, Any] | None = Field(
        default=None, description="ffprobe MediaInfo JSON captured at import."
    )
    created_at: str = Field(alias="createdAt", description="ISO-8601 UTC.")
    updated_at: str = Field(alias="updatedAt", description="ISO-8601 UTC.")

    model_config = {"populate_by_name": True}


class AnalysisResultRow(BaseModel):
    """One persisted analysis result for an asset (plan B0.1 / cached per B1.3)."""

    asset_id: str = Field(alias="assetId")
    kind: str = Field(description="Analyzer id: silence|scenes|beats|loudness|…")
    depth: str = Field(description="Analysis tier: quick|standard|deep (plan B1.2).")
    params_hash: str = Field(
        alias="paramsHash",
        description="Stable hash of the analyzer parameters; part of the cache key.",
    )
    result: dict[str, Any] = Field(description="The typed analyzer output, as JSON.")
    source: Provenance = Provenance.MACHINE
    tool: str = Field(description="Tool/model id + version that produced the result.")
    created_at: str = Field(alias="createdAt", description="ISO-8601 UTC.")

    model_config = {"populate_by_name": True}


class FieldRow(BaseModel):
    """Current value of one provenance-tracked field on a brain entity (B0.2)."""

    entity_type: str = Field(alias="entityType", description="e.g. 'asset', 'frame'.")
    entity_id: str = Field(alias="entityId")
    field: str
    value: Any = Field(description="The field value, as JSON.")
    source: Provenance
    actor: str = Field(description="Tool/model id or user identifier that wrote it.")
    updated_at: str = Field(alias="updatedAt", description="ISO-8601 UTC.")

    model_config = {"populate_by_name": True}


class FieldChangeRow(BaseModel):
    """One append-only provenance ledger entry (davinci ``field_changelog``)."""

    entity_type: str = Field(alias="entityType")
    entity_id: str = Field(alias="entityId")
    field: str
    old_value: Any = Field(default=None, alias="oldValue")
    new_value: Any = Field(alias="newValue")
    source: Provenance
    actor: str
    ts: str = Field(description="ISO-8601 UTC.")

    model_config = {"populate_by_name": True}


class FieldConflict(BaseModel):
    """Typed refusal returned when a write would clobber a human value (B0.2)."""

    entity_type: str = Field(alias="entityType")
    entity_id: str = Field(alias="entityId")
    field: str
    existing_source: Provenance = Field(alias="existingSource")
    attempted_source: Provenance = Field(alias="attemptedSource")
    message: str

    model_config = {"populate_by_name": True}


class WriteFieldResult(BaseModel):
    """Outcome of :meth:`BrainStore.write_field` — written, or a typed conflict."""

    written: bool
    field: FieldRow | None = None
    conflict: FieldConflict | None = None


class JobRow(BaseModel):
    """One journaled job (plan B0.1 table; the durable runner lands in B5.1)."""

    id: str
    kind: str = Field(description="e.g. 'analyze', 'derive-proxy'.")
    state: JobState
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    payload: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    created_at: str = Field(alias="createdAt", description="ISO-8601 UTC.")
    updated_at: str = Field(alias="updatedAt", description="ISO-8601 UTC.")

    model_config = {"populate_by_name": True}


class FrameRow(BaseModel):
    """One extracted frame registered for the vision protocol (plan B4)."""

    asset_id: str = Field(alias="assetId")
    ts_seconds: float = Field(alias="tsSeconds", ge=0.0)
    path: str = Field(description="Frame image path relative to the projects root.")
    purpose: str = Field(default="vision", description="Why it was extracted.")

    model_config = {"populate_by_name": True}


class EmbeddingRow(BaseModel):
    """One stored text embedding (plan B3.2).

    ``owner_type``/``owner_id`` locate what was embedded (a transcript
    utterance or an asset digest); ``model`` keys the vector space so mixed
    models never blend; ``payload`` carries the hit-reconstruction data
    (times/text for utterances, digest text for assets). Vectors are
    unit-length float32, stored packed (see ``brain.embeddings``).
    """

    owner_type: str = Field(alias="ownerType", description="'utterance' | 'asset'.")
    owner_id: str = Field(alias="ownerId")
    model: str = Field(description="Embedder model id that produced the vector.")
    dim: int = Field(gt=0)
    vector: list[float]
    payload: dict[str, Any] | None = Field(
        default=None, description="Hit-reconstruction data, as JSON."
    )

    model_config = {"populate_by_name": True}


class VisualSpanRow(BaseModel):
    """One embedded visual span persisted in ``visual_spans`` (plan MI2.2 / §3.1).

    Mirrors :class:`framepilot_engine.analysis.visual_sampler.VisualSpan` plus
    the identity columns the brain needs: the source ``asset_id``, the ``model``
    and ``sampler_version`` that produced the span, and the source
    ``content_hash`` that lets a re-index skip unchanged assets. The stored
    idempotency key is ``(content_hash, model, sampler_version, t0)`` (§3.1);
    the table PK is ``(asset_id, model, sampler_version, t0)``.
    """

    asset_id: str = Field(alias="assetId")
    model: str = Field(description="Embedding model id that keys the vector space.")
    sampler_version: int = Field(alias="samplerVersion", ge=0)
    t0: float = Field(ge=0.0, description="Span start in seconds (inclusive).")
    t1: float = Field(ge=0.0, description="Span end in seconds (exclusive).")
    scene_index: int = Field(alias="sceneIndex", ge=0)
    keyframe_t: float = Field(
        alias="keyframeT", ge=0.0, description="Timestamp of the embedded frame (== t0)."
    )
    phash: int = Field(ge=0, description="64-bit dHash of the keyframe.")
    content_hash: str = Field(
        alias="contentHash", description="Source-bytes hash; the re-index skip key (§3.1)."
    )
    frame_count: int = Field(
        alias="frameCount", ge=1, description="How many 1 fps candidates the span absorbed."
    )
    created_at: str = Field(
        default="", alias="createdAt", description="ISO-8601 UTC; stamped by the store on upsert."
    )

    model_config = {"populate_by_name": True}

    @field_serializer("phash")
    def _phash_as_string(self, value: int) -> str:
        """64-bit safety: serialize as a decimal string — JS ``Number`` (53-bit
        mantissa) would corrupt the top bits (matches ``VisualSpan.phash``)."""
        return str(value)


class VisualVectorRow(BaseModel):
    """One stored visual embedding vector (plan MI2.2), linked to its span.

    The key ``(asset_id, model, sampler_version, t0)`` is a foreign key onto
    :class:`VisualSpanRow`. Vectors are float32, stored packed via
    ``brain.embeddings.pack_vector``; ``dim`` is captured from the embedding
    response, never hardcoded (§3.2).
    """

    asset_id: str = Field(alias="assetId")
    model: str = Field(description="Embedding model id that produced the vector.")
    sampler_version: int = Field(alias="samplerVersion", ge=0)
    t0: float = Field(ge=0.0, description="Span start in seconds; ties the vector to its span.")
    dim: int = Field(gt=0)
    vector: list[float]

    model_config = {"populate_by_name": True}


class VisualCaptionRow(BaseModel):
    """One per-scene VLM caption (plan MI2.2 / §3.3), provenance-tracked.

    Captions are *derived data* written with ``source='model'`` (the VLM's
    judgment); the PK ``(asset_id, scene_index, t0)`` keys one caption per scene
    span. ``model`` records the VLM that produced it.
    """

    asset_id: str = Field(alias="assetId")
    scene_index: int = Field(alias="sceneIndex", ge=0)
    t0: float = Field(ge=0.0, description="Caption span start in seconds.")
    t1: float = Field(ge=0.0, description="Caption span end in seconds.")
    text: str
    source: Provenance = Provenance.MODEL
    model: str = Field(description="VLM model id that produced the caption.")
    created_at: str = Field(
        default="", alias="createdAt", description="ISO-8601 UTC; stamped by the store on upsert."
    )

    model_config = {"populate_by_name": True}


class TranscriptUtterance(BaseModel):
    """One contiguous run of spoken words, as indexed into ``transcript_fts`` (B2.1).

    The segmentation (``DIALOGUE_GAP_SECONDS``) mirrors the TS
    ``SemanticTimelineIndex`` dialogue derivation, so a search hit maps onto a
    dialogue segment the proposers already reason about. Times are timeline
    seconds — the canonical project transcript is timeline-time.
    """

    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)
    text: str


class SearchHitType(StrEnum):
    """What kind of indexed thing a search hit points at (B2.2 / MI3.2).

    ``CAPTION`` hits come from the per-scene VLM captions index (plan MI3.2):
    their ``start``/``end`` are the caption span's *asset* seconds and the
    ``asset_id`` names the source media, so visual fusion (MI5) can resolve
    them back to timeline time.
    """

    TRANSCRIPT = "transcript"
    MARKER = "marker"
    ASSET = "asset"
    CAPTION = "caption"


class SearchHit(BaseModel):
    """One typed full-text search hit (plan B2.2).

    ``start``/``end`` are timeline seconds for transcript/marker hits (a marker
    is a point: ``start == end``); ``None`` for asset hits, which locate a
    media-bin item rather than a moment. ``score`` is higher-is-better
    (negated SQLite bm25 rank for FTS hits; asset name matches rank below any
    FTS hit at 0.0).
    """

    type: SearchHitType
    asset_id: str | None = Field(default=None, alias="assetId")
    marker_id: str | None = Field(default=None, alias="markerId")
    start: float | None = None
    end: float | None = None
    snippet: str = Field(description="The matched text, with match markers for FTS hits.")
    score: float

    model_config = {"populate_by_name": True}


class BrainStatus(BaseModel):
    """Capability/health report for a project's brain (``GET /brain/status``).

    ``available=False`` is the honest-unavailable shape (plan invariant): a
    missing sandbox root or unusable SQLite reports *why* instead of failing
    or fabricating.
    """

    available: bool
    exists: bool = Field(description="Whether brain.sqlite exists on disk.")
    path: str | None = None
    schema_version: int | None = Field(default=None, alias="schemaVersion")
    fts5_available: bool = Field(default=False, alias="fts5Available")
    counts: dict[str, int] = Field(default_factory=dict)
    reason: str | None = Field(
        default=None, description="Set when available=False: why the brain is unusable."
    )

    model_config = {"populate_by_name": True}


class SessionContext(BaseModel):
    """Everything a model should know at session start (plan B6.3).

    The assembled answer to "what is this project, and what have we learned?" —
    ``bin_summary`` (the media), the latest session note (what happened last),
    the corrections/decisions tails (what the user wants), and the cross-project
    soul digest (how this user works). Honest-unavailable like every brain
    surface: no sandbox root or no brain reports ``available=False`` with the
    reason and empty sections, never a fabricated context.

    Defined after :class:`BrainStatus` because it embeds one.
    """

    available: bool
    reason: str | None = Field(
        default=None, description="Set when available=False: why there is no context."
    )
    status: BrainStatus | None = Field(
        default=None, description="The project brain's capability/health report."
    )
    bin_summary: str = Field(default="", alias="binSummary")
    session_note: str = Field(
        default="", alias="sessionNote", description="The most recent day's note."
    )
    corrections: str = Field(default="", description="Tail of corrections.md.")
    decisions: str = Field(default="", description="Tail of decisions.md.")
    soul: str = Field(default="", description="Cross-project soul digest (plan B6.2).")

    model_config = {"populate_by_name": True}
