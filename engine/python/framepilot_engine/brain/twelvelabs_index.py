"""Route-side glue between the sidecar and the TwelveLabs backend.

WHY: :mod:`framepilot_engine.brain.twelvelabs` is a pure REST client. This module
is the thin, testable layer that the ``/brain/visual/*`` routes use when a
TwelveLabs key is active: it persists the project's TL ``index_id`` and each
asset's ``video_id`` in the **existing** brain tables (no schema change — plan
constraint), drives one asset's upload+index step within a paced slice, and maps
TwelveLabs search clips back onto the :class:`EvidencePacket` contract the
orchestrator already reads. Everything here is deterministic given an injected
clock/sleep, so the paced polling is golden-testable without the live API.

Storage (migration-free, decision: reuse what exists):

- **Index id** — one per project — is a provenance-guarded field row
  (``fields`` table) under entity ``twelvelabs``/``index``. The ``fields`` table
  has no asset foreign key, so a project-level value fits without a sentinel row.
  A second field beside it holds the **key fingerprint** the index was made with
  (:func:`~framepilot_engine.brain.twelvelabs.key_fingerprint` — never the key): a
  project whose key changed to another account can no longer read its index, and
  :func:`bind_index` notices and binds the project to an index of the current
  account instead of reporting a working key as invalid.
- **Asset → video mapping** is an ``analysis_results`` row (``kind='tl:video'``)
  keyed by the asset, recording which index it lives in (``indexId``; derived from
  the task token on older rows). A fixed ``params_hash`` means a re-index of changed bytes
  overwrites the single row (the source ``content_hash`` lives in the result), so
  the mapping never accumulates stale duplicates. The same row remembers a
  **permanent rejection** (status ``rejected`` + the code, the human reason, and the
  upload policy that was refused), so the same bytes are never uploaded again just
  to be refused again — see :func:`poll_index_asset`.
- **Chapter prose → shot ledger**: :func:`describe_shots_from_chapters` maps a
  Pegasus chapter map onto the asset's measured shots as tier-2 ``described``
  facts (summary only — :func:`described_from_summary`), so a paid describe is
  read back as words on every later run instead of being asked for again.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from framepilot_engine.brain.described import DescribedParseError, described_from_summary
from framepilot_engine.brain.fts import SupportsWord
from framepilot_engine.brain.ledger_models import DescribedFacts, ShotRecord
from framepilot_engine.brain.models import Provenance
from framepilot_engine.brain.store import BrainStore
from framepilot_engine.brain.twelvelabs import (
    DEFAULT_PEGASUS_MODEL_NAME,
    TL_UPLOAD_POLICY_VERSION,
    TaskStatus,
    TLChapter,
    TLClip,
    TLHighlight,
    TwelveLabsAssetInaccessibleError,
    TwelveLabsMediaRejectedError,
    asset_task_token,
    task_token_index,
    task_token_uploaded_asset,
)
from framepilot_engine.brain.visual_search import (
    EvidencePacket,
    SupportsClip,
    project_span_to_timeline,
    transcript_overlap,
)

_log = logging.getLogger(__name__)


class SupportsGetTask(Protocol):
    """The only slice of :class:`TwelveLabsClient` that :func:`poll_index_asset`
    needs — narrowed so tests can pass a fake without subclassing the real
    (``httpx``-backed) client."""

    def get_task(self, task_id: str) -> TaskStatus: ...


class SupportsIndexBinding(Protocol):
    """The slice of :class:`TwelveLabsClient` that :func:`bind_index` needs."""

    @property
    def key_fingerprint(self) -> str: ...

    def create_index(self, name: str) -> str: ...

    def find_index(self, name: str) -> str | None: ...

    def index_accessible(self, index_id: str) -> bool: ...


__all__ = [
    "MIN_CHAPTER_SHOT_COVERAGE",
    "TL_DESCRIBED_MODEL",
    "TL_MAP_KIND",
    "TL_REJECTED_STATUS",
    "TL_TOOL",
    "TL_VIDEO_KIND",
    "MappedChapter",
    "MappedHighlight",
    "TLIndexOutcome",
    "VideoMapping",
    "bind_index",
    "chapter_caption",
    "chapters_to_packets",
    "clips_to_packets",
    "describe_shots_from_chapters",
    "forget_index_key_fingerprint",
    "is_twelvelabs_description",
    "map_pegasus_chapters",
    "map_pegasus_highlights",
    "poll_index_asset",
    "read_cached_pegasus",
    "read_index_id",
    "read_index_key_fingerprint",
    "read_usable_index_id",
    "read_video_mapping",
    "store_cached_pegasus",
    "store_index_id",
    "store_video_mapping",
    "video_to_asset_map",
]

#: ``analysis_results.kind`` for the asset→video mapping row.
TL_VIDEO_KIND = "tl:video"
#: ``analysis_results.kind`` for a cached Pegasus footage map (one row per asset,
#: content-hash keyed so it is computed once per indexed video).
TL_MAP_KIND = "tl:map"
#: Constant ``params_hash`` so a re-index overwrites the single mapping row.
_TL_VIDEO_PARAMS = "v1"
#: Tool/actor label recorded on every TwelveLabs-derived row.
TL_TOOL = "twelvelabs"
#: ``DescribedFacts.model`` for a shot described from a Pegasus chapter. Distinct from
#: every structured producer's id, which is what lets tier 2 recognise these rows as
#: summary-only (:func:`is_twelvelabs_description`) and replace them with a full record.
TL_DESCRIBED_MODEL = f"{TL_TOOL}/{DEFAULT_PEGASUS_MODEL_NAME}"
#: The share of a shot a chapter must cover to describe it when the chapter misses the
#: shot's keyframe. Below half, most of the shot shows something the chapter did not talk
#: about, and writing its prose onto the row would label the shot with its neighbour.
MIN_CHAPTER_SHOT_COVERAGE = 0.5

#: ``fields`` entity for the project-level index id.
_TL_INDEX_ENTITY = "twelvelabs"
_TL_INDEX_ID = "index"
_TL_INDEX_FIELD = "id"
#: Field beside the index id: the fingerprint of the key that index belongs to.
_TL_INDEX_KEY_FIELD = "keyFingerprint"

#: Paced polling of one indexing task within a single slice: check every
#: ``INTERVAL`` seconds up to ``BUDGET`` before yielding the slice back to the
#: caller (which re-posts to continue). Keeps each request well under the client
#: timeout while pacing task polling so we never hammer the API.
TL_POLL_INTERVAL_SECONDS = 3.0
TL_SLICE_POLL_BUDGET_SECONDS = 30.0

#: Human-readable "still working" reason surfaced while a task indexes.
INDEXING_REASON = "indexing"

#: Mapping status for bytes TwelveLabs refused for what they ARE (too big, too long,
#: unsupported). Distinct from ``failed`` — a transient failure that a later job retries
#: (plan: "retry after failed") — because retrying a permanent refusal re-uploads the
#: same file, possibly a gigabyte of it, only to be refused again.
TL_REJECTED_STATUS = "rejected"
#: ``failed`` stays the status for everything that can clear on a retry.
_TL_FAILED_STATUS = "failed"


@dataclass(frozen=True)
class VideoMapping:
    """One asset's TwelveLabs indexing state, as persisted in the brain."""

    task_id: str | None
    video_id: str | None
    status: str
    content_hash: str | None
    #: The id of the media we UPLOADED to TwelveLabs (``POST /assets``) — distinct
    #: from ``video_id`` (the indexed asset). Pegasus 1.5 generates from the uploaded
    #: asset, so the footage map needs this id; ``None`` for mappings written before
    #: it was persisted (the route recovers it from the index on demand).
    source_asset_id: str | None = None
    #: For a ``rejected`` mapping: TwelveLabs' machine code (or FramePilot's pre-flight
    #: code), the sentence shown to the user, and the :data:`TL_UPLOAD_POLICY_VERSION`
    #: that was refused. ``None`` on every other mapping and on rows written before
    #: rejections were remembered.
    rejection_code: str | None = None
    rejection_reason: str | None = None
    upload_policy: int | None = None
    #: The TwelveLabs index this mapping's task/video lives in. ``None`` only for rows
    #: whose index cannot be known (legacy ``/tasks`` ids): those are given the benefit
    #: of the doubt by :meth:`belongs_to`.
    index_id: str | None = None

    @property
    def ready(self) -> bool:
        """True when this asset is fully indexed and searchable (in ITS index)."""
        return self.status == "ready" and self.video_id is not None

    def belongs_to(self, index_id: str) -> bool:
        """Whether this mapping lives in ``index_id`` (unknown counts as yes)."""
        return self.index_id is None or self.index_id == index_id

    def ready_in(self, index_id: str) -> bool:
        """Ready AND in ``index_id`` — after a rebind, an old index's video is not."""
        return self.ready and self.belongs_to(index_id)

    def rejects(self, content_hash: str) -> bool:
        """Whether these exact bytes were refused under the CURRENT upload policy.

        Both halves matter: changed bytes (a re-export) deserve a fresh try, and so do
        bytes an OLDER upload path was refused for — the 1 GB file the direct-only
        policy could not send is exactly what multipart now can.
        """
        return (
            self.status == TL_REJECTED_STATUS
            and self.content_hash == content_hash
            and self.upload_policy == TL_UPLOAD_POLICY_VERSION
        )


@dataclass(frozen=True)
class TLIndexOutcome:
    """Result of driving one asset's TwelveLabs index step in a slice.

    ``advanced`` tells the route whether to move the job cursor past this asset:
    True once the asset is terminal (ready or failed), False while it is still
    indexing (the slice is re-posted to keep polling). ``newly_indexed`` counts a
    just-completed asset (for the response's ``indexed`` total).
    """

    advanced: bool
    ok: bool
    newly_indexed: int
    status: str
    reason: str | None = None


# -- persistence ------------------------------------------------------------------


def read_index_id(store: BrainStore) -> str | None:
    """The project's TwelveLabs index id, or ``None`` if never created."""
    row = store.get_field(_TL_INDEX_ENTITY, _TL_INDEX_ID, _TL_INDEX_FIELD)
    return row.value if row is not None and isinstance(row.value, str) else None


def store_index_id(store: BrainStore, index_id: str, *, key_fingerprint: str | None = None) -> None:
    """Persist the project's TwelveLabs index id (one per project).

    :param key_fingerprint: The fingerprint of the key the index belongs to, written
        beside it when known (always, from :func:`bind_index`).
    """
    store.write_field(
        _TL_INDEX_ENTITY,
        _TL_INDEX_ID,
        _TL_INDEX_FIELD,
        index_id,
        source=Provenance.MACHINE,
        actor=TL_TOOL,
    )
    if key_fingerprint is not None:
        _write_key_fingerprint(store, key_fingerprint)


def read_index_key_fingerprint(store: BrainStore) -> str | None:
    """The fingerprint of the key the stored index belongs to; ``None`` if unknown."""
    row = store.get_field(_TL_INDEX_ENTITY, _TL_INDEX_ID, _TL_INDEX_KEY_FIELD)
    return _str_or_none(row.value) if row is not None else None


def forget_index_key_fingerprint(store: BrainStore) -> None:
    """Mark the stored index's ownership unknown, so the next index run re-checks it.

    Used when a call on an index this key was believed to own came back unreadable:
    the next :func:`bind_index` verifies it and binds a new one if it is gone.
    """
    _write_key_fingerprint(store, "")


def read_usable_index_id(store: BrainStore, key_fingerprint: str) -> str | None:
    """The stored index id if THIS key can be expected to read it, else ``None``.

    For the read-only routes: an index recorded under a different key is another
    account's, so the project reads as not indexed yet (the index run rebinds it)
    instead of every call failing as if the key were bad. An index with no recorded
    fingerprint (made before fingerprints) is assumed usable.
    """
    index_id = read_index_id(store)
    if index_id is None:
        return None
    stored = read_index_key_fingerprint(store)
    return index_id if stored is None or stored == key_fingerprint else None


def bind_index(client: SupportsIndexBinding, store: BrainStore, *, project_id: str) -> str:
    """The project's TwelveLabs index for the CURRENT key — reusing, adopting or rebinding.

    - stored and made with this key → used as is (no call);
    - stored, made before fingerprints were kept → checked once: readable → adopted
      (its fingerprint written); unreadable → rebound;
    - stored, made with a DIFFERENT key → rebound (that index is another account's);
    - none stored → created.

    Rebinding reuses this account's index of the same name when there is one (a user
    switching back to an earlier key gets its index, and its indexed footage, back);
    otherwise it creates one. Assets indexed in the old index are re-attached, not
    re-uploaded, by :func:`poll_index_asset`.

    :raises TwelveLabsError: On any API/transport failure.
    """
    current = client.key_fingerprint
    index_id = read_index_id(store)
    stored = read_index_key_fingerprint(store)
    name = f"framepilot-{project_id}"
    if index_id is not None and stored == current:
        return index_id
    if index_id is not None and stored is None:
        if client.index_accessible(index_id):
            _write_key_fingerprint(store, current)
            _log.info(
                "twelvelabs index adopted for this key: project=%s index=%s", project_id, index_id
            )
            return index_id
        why = "saved index not readable with this key"
    else:
        why = "key changed"
    if index_id is None:
        new_id = client.create_index(name)
    else:
        new_id = client.find_index(name) or client.create_index(name)
    store_index_id(store, new_id, key_fingerprint=current)
    if index_id is not None:
        _log.info(
            "ACT twelvelabs index rebound: project=%s old=%s new=%s (%s)",
            project_id,
            index_id,
            new_id,
            why,
        )
    return new_id


def _write_key_fingerprint(store: BrainStore, key_fingerprint: str) -> None:
    store.write_field(
        _TL_INDEX_ENTITY,
        _TL_INDEX_ID,
        _TL_INDEX_KEY_FIELD,
        key_fingerprint,
        source=Provenance.MACHINE,
        actor=TL_TOOL,
    )


def read_video_mapping(store: BrainStore, asset_id: str) -> VideoMapping | None:
    """Read one asset's persisted TwelveLabs mapping, or ``None``."""
    rows = store.list_analysis(asset_id, kind=TL_VIDEO_KIND)
    if not rows:
        return None
    result = rows[-1].result
    task_id = _str_or_none(result.get("taskId"))
    return VideoMapping(
        task_id=task_id,
        video_id=_str_or_none(result.get("videoId")),
        status=str(result.get("status") or "unknown"),
        content_hash=_str_or_none(result.get("contentHash")),
        source_asset_id=_str_or_none(result.get("sourceAssetId")),
        rejection_code=_str_or_none(result.get("rejectionCode")),
        rejection_reason=_str_or_none(result.get("rejectionReason")),
        upload_policy=_int_or_none(result.get("uploadPolicy")),
        index_id=_str_or_none(result.get("indexId")) or task_token_index(task_id),
    )


def store_video_mapping(
    store: BrainStore,
    asset_id: str,
    *,
    content_hash: str,
    status: str,
    task_id: str | None = None,
    video_id: str | None = None,
    source_asset_id: str | None = None,
    rejection: TwelveLabsMediaRejectedError | None = None,
    index_id: str | None = None,
) -> None:
    """Upsert one asset's TwelveLabs mapping (single row per asset).

    ``rejection`` records a permanent refusal of these bytes (pass it with
    ``status=TL_REJECTED_STATUS``); its code, human reason, and the current upload
    policy are stored so :meth:`VideoMapping.rejects` can answer later without a call.
    ``index_id`` defaults to the index the task token names.
    """
    result: dict[str, object] = {
        "taskId": task_id,
        "videoId": video_id,
        "status": status,
        "contentHash": content_hash,
        "sourceAssetId": source_asset_id,
        "indexId": index_id or task_token_index(task_id),
    }
    if rejection is not None:
        result["rejectionCode"] = rejection.code
        result["rejectionReason"] = str(rejection)
        result["uploadPolicy"] = TL_UPLOAD_POLICY_VERSION
    store.record_analysis(
        asset_id,
        kind=TL_VIDEO_KIND,
        depth="",
        params_hash=_TL_VIDEO_PARAMS,
        result=result,
        tool=TL_TOOL,
    )


def video_to_asset_map(store: BrainStore, *, index_id: str | None = None) -> dict[str, str]:
    """Reverse map of ``video_id → asset_id`` for every indexed asset.

    :param index_id: Only mappings that live in this index (a row whose index is
        unknown counts). ``None`` keeps every row — the footage-map cache is
        index-independent on purpose.
    """
    out: dict[str, str] = {}
    for row in store.list_analysis(kind=TL_VIDEO_KIND):
        video_id = _str_or_none(row.result.get("videoId"))
        if video_id is None:
            continue
        if index_id is not None:
            row_index = _str_or_none(row.result.get("indexId")) or task_token_index(
                _str_or_none(row.result.get("taskId"))
            )
            if row_index is not None and row_index != index_id:
                continue
        out[video_id] = row.asset_id
    return out


# -- Pegasus map cache (kind='tl:map', content-hash keyed, plan FI2.1/FI2.3) -------


def read_cached_pegasus(
    store: BrainStore, asset_id: str, *, content_hash: str
) -> tuple[list[TLChapter], list[TLHighlight], str] | None:
    """Read one asset's cached Pegasus map for the CURRENT bytes, or ``None``.

    The cache is keyed on the video's ``content_hash`` (``params_hash``), so a
    re-index (new bytes → new ``video_id`` → new hash) is an automatic miss — a
    stale map is never served (plan FI2.3). Returns asset-time chapters/highlights
    plus the whole-video summary; the route re-projects them onto timeline time.
    """
    row = store.get_analysis(asset_id, kind=TL_MAP_KIND, params_hash=content_hash)
    if row is None:
        return None
    result = row.result
    chapters = [
        TLChapter(
            start=float(c["start"]),
            end=float(c["end"]),
            title=str(c.get("title") or ""),
            summary=str(c.get("summary") or ""),
        )
        for c in result.get("chapters", [])
        if isinstance(c, dict) and "start" in c and "end" in c
    ]
    highlights = [
        TLHighlight(start=float(h["start"]), end=float(h["end"]), label=str(h.get("label") or ""))
        for h in result.get("highlights", [])
        if isinstance(h, dict) and "start" in h and "end" in h
    ]
    summary = str(result.get("summary") or "")
    return chapters, highlights, summary


def store_cached_pegasus(
    store: BrainStore,
    asset_id: str,
    *,
    content_hash: str,
    chapters: Sequence[TLChapter],
    highlights: Sequence[TLHighlight],
    summary: str,
) -> None:
    """Persist one asset's Pegasus map, keyed by the current ``content_hash``.

    Stored in **asset** time (the projection onto timeline is cheap and depends on
    the live project), so the row survives timeline edits and is invalidated only
    by a re-index of changed bytes.
    """
    store.record_analysis(
        asset_id,
        kind=TL_MAP_KIND,
        depth="",
        params_hash=content_hash,
        result={
            "chapters": [
                {"start": c.start, "end": c.end, "title": c.title, "summary": c.summary}
                for c in chapters
            ],
            "highlights": [{"start": h.start, "end": h.end, "label": h.label} for h in highlights],
            "summary": summary,
        },
        tool=TL_TOOL,
    )


# -- paced per-asset indexing -----------------------------------------------------


def poll_index_asset(
    client: SupportsGetTask,
    store: BrainStore,
    index_id: str,
    asset_id: str,
    media_path_name: str,
    upload: Callable[[], str],
    *,
    content_hash: str,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    poll_interval: float = TL_POLL_INTERVAL_SECONDS,
    poll_budget: float = TL_SLICE_POLL_BUDGET_SECONDS,
) -> TLIndexOutcome:
    """Drive one asset's TwelveLabs indexing forward within a single slice.

    Idempotent + resumable: an already-ready mapping for the current bytes is a
    no-op (``advanced``); a changed ``content_hash`` (or no mapping) starts a new
    upload; a pending task is polled up to ``poll_budget`` before the slice is
    yielded back to be re-posted. ``upload`` is a thunk (so the caller owns opening
    the file) that returns the new task id.

    Failures split in two. A ``failed`` mapping (TwelveLabs gave up, or the caller
    recorded a transient error) is re-uploaded by the next job — the deliberate
    "retry after failure" behaviour. A **permanent** refusal of the file
    (:class:`TwelveLabsMediaRejectedError`, from the upload, its pre-flight, or the
    attach-to-index step) is persisted as ``rejected`` and answered from the brain on
    every later call for the same bytes and upload policy: no upload, no network, the
    same human reason (outcome ``status="rejected"``).

    :raises TwelveLabsError: Any OTHER API/transport failure — the caller decides
        whether it is the key's fault or the file's.
    """
    mapping = read_video_mapping(store, asset_id)
    if mapping is not None and mapping.rejects(content_hash):
        _log.info(
            "twelvelabs index asset skipped (rejected before, not re-uploading): "
            "asset=%s file=%s code=%s",
            asset_id,
            media_path_name,
            mapping.rejection_code or "-",
        )
        return _rejected_outcome(
            mapping.rejection_reason or f"TwelveLabs can't index {media_path_name}."
        )
    try:
        return _advance_index_asset(
            client,
            store,
            index_id,
            asset_id,
            media_path_name,
            upload,
            mapping=mapping,
            content_hash=content_hash,
            sleep=sleep,
            now=now,
            poll_interval=poll_interval,
            poll_budget=poll_budget,
        )
    except TwelveLabsMediaRejectedError as exc:
        store_video_mapping(
            store,
            asset_id,
            content_hash=content_hash,
            status=TL_REJECTED_STATUS,
            rejection=exc,
        )
        _log.warning(
            "twelvelabs index asset REJECTED (remembered for these bytes): asset=%s file=%s "
            "code=%s",
            asset_id,
            media_path_name,
            exc.code,
        )
        return _rejected_outcome(str(exc))


def _rejected_outcome(reason: str) -> TLIndexOutcome:
    """A terminal, not-ok outcome for a file TwelveLabs will not take as it is."""
    return TLIndexOutcome(
        advanced=True, ok=False, newly_indexed=0, status=TL_REJECTED_STATUS, reason=reason
    )


def _advance_index_asset(
    client: SupportsGetTask,
    store: BrainStore,
    index_id: str,
    asset_id: str,
    media_path_name: str,
    upload: Callable[[], str],
    *,
    mapping: VideoMapping | None,
    content_hash: str,
    sleep: Callable[[float], None],
    now: Callable[[], float],
    poll_interval: float,
    poll_budget: float,
) -> TLIndexOutcome:
    """Upload (when needed) and poll one asset within the slice budget.

    A mapping that lives in ANOTHER index (the project was rebound to a new index after
    a key change) is not ready here, but its bytes usually are already on TwelveLabs:
    the earlier upload is re-attached to ``index_id`` instead of uploading the file
    again. Only when this key cannot read that upload (another account's) is the file
    uploaded afresh.

    :raises TwelveLabsError: On any API/transport failure, media rejections included;
        :func:`poll_index_asset` turns a rejection into a remembered outcome.
    """
    # A `failed` mapping is retried on purpose (it may have been transient), and a
    # `rejected` one reaching here was refused for OTHER bytes or under an older upload
    # policy — both start over from a fresh upload.
    fresh = (
        mapping is None
        or mapping.content_hash != content_hash
        or mapping.status in (_TL_FAILED_STATUS, TL_REJECTED_STATUS)
    )

    moved = not fresh and mapping is not None and not mapping.belongs_to(index_id)

    if not fresh and not moved and mapping is not None and mapping.ready:
        _log.debug(
            "twelvelabs slice: asset=%s already ready (video=%s)", asset_id, mapping.video_id
        )
        return TLIndexOutcome(advanced=True, ok=True, newly_indexed=0, status="ready")

    source_asset_id = None if fresh else (mapping.source_asset_id if mapping else None)
    reattach_from = (
        (source_asset_id or task_token_uploaded_asset(mapping.task_id))
        if moved and mapping is not None
        else None
    )
    if reattach_from is not None:
        task_id = asset_task_token(index_id, reattach_from)
        source_asset_id = reattach_from
        _log.info(
            "ACT twelvelabs index asset (re-attach earlier upload, no re-upload): asset=%s "
            "upload=%s old_index=%s index=%s",
            asset_id,
            reattach_from,
            mapping.index_id if mapping is not None else "-",
            index_id,
        )
        store_video_mapping(
            store,
            asset_id,
            content_hash=content_hash,
            status="indexing",
            task_id=task_id,
            source_asset_id=source_asset_id,
        )
    elif fresh or moved or mapping is None or mapping.task_id is None:
        _log.info(
            "ACT twelvelabs index asset (fresh upload): asset=%s file=%s", asset_id, media_path_name
        )
        task_id = upload()
        store_video_mapping(
            store, asset_id, content_hash=content_hash, status="indexing", task_id=task_id
        )
    else:
        task_id = mapping.task_id
        _log.info("ACT twelvelabs index asset (resume poll): asset=%s task=%s", asset_id, task_id)

    # Poll this task up to the slice budget so a short clip finishes in one call.
    started = now()
    deadline = started + poll_budget
    while True:
        try:
            status = client.get_task(task_id)
        except TwelveLabsAssetInaccessibleError:
            if reattach_from is None:
                raise
            # The earlier upload is another account's: this key has to send the bytes.
            _log.info(
                "ACT twelvelabs index asset (earlier upload not readable, fresh upload): "
                "asset=%s file=%s",
                asset_id,
                media_path_name,
            )
            reattach_from = None
            source_asset_id = None
            task_id = upload()
            store_video_mapping(
                store, asset_id, content_hash=content_hash, status="indexing", task_id=task_id
            )
            continue
        # The current TwelveLabs workflow is upload asset → attach to index. Its
        # opaque polling token advances at that boundary, so persist and continue
        # with the returned token instead of repeatedly creating indexed assets.
        task_id = status.task_id
        # The uploaded-asset id is what Pegasus generates from, and the task token
        # stops carrying it once the asset is attached to the index — so keep the
        # first value we see rather than dropping it on a later poll.
        source_asset_id = status.source_asset_id or source_asset_id
        if status.ready:
            store_video_mapping(
                store,
                asset_id,
                content_hash=content_hash,
                status="ready",
                task_id=task_id,
                video_id=status.video_id,
                source_asset_id=source_asset_id,
            )
            _log.info(
                "ACT twelvelabs index asset ready: asset=%s task=%s video=%s",
                asset_id,
                task_id,
                status.video_id,
            )
            return TLIndexOutcome(advanced=True, ok=True, newly_indexed=1, status="ready")
        if status.failed:
            store_video_mapping(
                store,
                asset_id,
                content_hash=content_hash,
                status=_TL_FAILED_STATUS,
                task_id=task_id,
                source_asset_id=source_asset_id,
            )
            _log.warning("twelvelabs index asset FAILED: asset=%s task=%s", asset_id, task_id)
            return TLIndexOutcome(
                advanced=True,
                ok=False,
                newly_indexed=0,
                status="failed",
                reason="TwelveLabs failed to index this asset",
            )
        current = now()
        if current >= deadline:
            # Still indexing — persist progress and yield; the slice is re-posted.
            store_video_mapping(
                store,
                asset_id,
                content_hash=content_hash,
                status=status.status,
                task_id=task_id,
                source_asset_id=source_asset_id,
            )
            _log.info(
                "twelvelabs index asset still indexing: asset=%s task=%s status=%s "
                "(polled %.0fs this slice, yielding to re-post)",
                asset_id,
                task_id,
                status.status,
                current - started,
            )
            return TLIndexOutcome(
                advanced=False,
                ok=True,
                newly_indexed=0,
                status=status.status,
                reason=INDEXING_REASON,
            )
        sleep(poll_interval)


# -- clip → evidence packet -------------------------------------------------------


def clips_to_packets(
    clips: Sequence[TLClip],
    *,
    video_to_asset: dict[str, str],
    clips_by_asset: dict[str, list[SupportsClip]],
    words: Sequence[SupportsWord],
    k: int,
    asset_ids: Sequence[str] | None = None,
) -> list[EvidencePacket]:
    """Map ranked TwelveLabs clips onto the evidence-packet contract (MI5.1).

    ``start``/``end`` are asset seconds and become ``t0``/``t1`` directly. When a
    project doc supplied the clips + transcript ``words``, the span is projected onto
    timeline time and the words spoken over it fill ``transcriptOverlap``;
    otherwise the clip's own spoken words (from the audio modality) are used, so
    the field is never fabricated. A clip whose ``video_id`` is not one of THIS
    project's indexed assets is skipped — never mapped to a wrong asset.
    ``scene_index`` is the clip's rank (TwelveLabs has no scene model); it only
    keeps packets for the same asset distinct.
    """
    allow = set(asset_ids) if asset_ids else None
    packets: list[EvidencePacket] = []
    for rank, clip in enumerate(clips):
        asset_id = video_to_asset.get(clip.video_id)
        if asset_id is None:
            continue
        if allow is not None and asset_id not in allow:
            continue
        timeline_ranges = project_span_to_timeline(
            clip.start, clip.end, clips_by_asset.get(asset_id, [])
        )
        overlap = transcript_overlap(timeline_ranges, words)
        if not overlap and clip.transcription:
            overlap = clip.transcription
        packets.append(
            EvidencePacket(
                asset_id=asset_id,
                t0=clip.start,
                t1=clip.end,
                scene_index=rank,
                score=clip.score,
                caption=None,
                transcript_overlap=overlap,
                sources=[TL_TOOL],
            )
        )
        if len(packets) >= k:
            break
    return packets


# -- Pegasus map → footage map / evidence packets ---------------------------------


@dataclass(frozen=True)
class MappedChapter:
    """One Pegasus chapter projected onto **timeline** seconds (plan FI1.2).

    ``t0``/``t1`` are timeline seconds; ``title``/``summary`` are Pegasus' labels.
    The route converts a list of these into the ``FootageMapResponse.chapters``
    wire shape.
    """

    t0: float
    t1: float
    title: str
    summary: str


@dataclass(frozen=True)
class MappedHighlight:
    """One Pegasus highlight projected onto timeline seconds (plan FI1.2).

    ``score`` is derived from position (earlier = higher) since Pegasus gives no
    native numeric score; it only orders highlights, never claims a probability.
    """

    t0: float
    t1: float
    label: str
    score: float


def _project_span(
    start: float, end: float, asset_id: str, clips_by_asset: dict[str, list[SupportsClip]]
) -> tuple[float, float]:
    """Project an asset span ``[start, end)`` onto its timeline extent.

    Reuses :func:`project_span_to_timeline`; when the asset is on the timeline the
    extent spans the first projected range's start to the last range's end. When no
    clip windows over the span (no project doc, or the asset is not placed), the
    asset time is returned unchanged — honest, never dropped.
    """
    ranges = project_span_to_timeline(start, end, clips_by_asset.get(asset_id, []))
    if not ranges:
        return start, end
    return ranges[0][0], ranges[-1][1]


def map_pegasus_chapters(
    chapters: Sequence[TLChapter],
    *,
    asset_id: str,
    clips_by_asset: dict[str, list[SupportsClip]],
) -> list[MappedChapter]:
    """Project one video's Pegasus chapters onto timeline time (plan FI1.2).

    The chapters belong to a single indexed video (mapped to ``asset_id``); each
    asset span is projected through that asset's clips. Chapters keep their order.
    """
    mapped: list[MappedChapter] = []
    for chapter in chapters:
        t0, t1 = _project_span(chapter.start, chapter.end, asset_id, clips_by_asset)
        mapped.append(MappedChapter(t0=t0, t1=t1, title=chapter.title, summary=chapter.summary))
    return mapped


def map_pegasus_highlights(
    highlights: Sequence[TLHighlight],
    *,
    asset_id: str,
    clips_by_asset: dict[str, list[SupportsClip]],
) -> list[MappedHighlight]:
    """Project one video's Pegasus highlights onto timeline time (plan FI1.2).

    ``score`` is ``1/rank`` by original position so the caller can order highlights
    best-first across videos without a native score.
    """
    mapped: list[MappedHighlight] = []
    for rank, highlight in enumerate(highlights, start=1):
        t0, t1 = _project_span(highlight.start, highlight.end, asset_id, clips_by_asset)
        mapped.append(MappedHighlight(t0=t0, t1=t1, label=highlight.label, score=1.0 / rank))
    return mapped


def chapters_to_packets(
    chapters: Sequence[TLChapter],
    *,
    asset_id: str,
    clips_by_asset: dict[str, list[SupportsClip]],
    words: Sequence[SupportsWord],
) -> list[EvidencePacket]:
    """Walk Pegasus chapters into evidence packets for the describe path (plan FI2.2).

    Each chapter becomes one packet in time order: ``t0``/``t1`` are the chapter's
    **asset** seconds (matching the built-in describe contract), ``caption`` is the
    chapter title+summary, and ``transcriptOverlap`` is the transcript ``words``
    spoken over the chapter's timeline projection. ``score`` is a constant
    (enumeration has no ranking, mirroring the built-in describe route).
    """
    packets: list[EvidencePacket] = []
    for index, chapter in enumerate(chapters):
        timeline_ranges = project_span_to_timeline(
            chapter.start, chapter.end, clips_by_asset.get(asset_id, [])
        )
        packets.append(
            EvidencePacket(
                asset_id=asset_id,
                t0=chapter.start,
                t1=chapter.end,
                scene_index=index,
                score=1.0,
                caption=chapter_caption(chapter),
                transcript_overlap=transcript_overlap(timeline_ranges, words),
                sources=[TL_TOOL],
            )
        )
    return packets


def chapter_caption(chapter: TLChapter) -> str:
    """One chapter as a line of prose: ``"Title — summary"``, or the title alone."""
    if chapter.summary:
        return f"{chapter.title} — {chapter.summary}"
    return chapter.title


# -- Pegasus map → shot ledger (tier 2, summary only) ------------------------------


def is_twelvelabs_description(facts: DescribedFacts | None) -> bool:
    """Whether a shot's tier-2 record is a Pegasus chapter summary rather than a full one.

    Tier 2 asks this before skipping a shot as already described: a summary-only row must
    never stop a structured producer (the local pack, the hosted captioner) from filling
    subject, camera and on-screen text for the same shot.
    """
    return facts is not None and facts.model == TL_DESCRIBED_MODEL


def _chapter_for_shot(shot: ShotRecord, chapters: Sequence[TLChapter]) -> TLChapter | None:
    """The chapter that describes ``shot``, or ``None`` when none honestly does.

    A chapter qualifies when it holds the shot's keyframe (the frame the ledger row stands
    for) or covers :data:`MIN_CHAPTER_SHOT_COVERAGE` of the shot; a zero-length shot can
    only qualify by its keyframe. Of those, the one covering most of the shot wins, ties
    going to the keyframe holder, then to the earlier chapter. Pegasus chapters need not
    tile the video, so "no chapter" is a real answer and the shot stays undescribed rather
    than borrowing a neighbour's words.
    """
    duration = shot.t1 - shot.t0
    best: TLChapter | None = None
    best_rank: tuple[float, bool] = (0.0, False)
    for chapter in chapters:
        covered = max(0.0, min(shot.t1, chapter.end) - max(shot.t0, chapter.start))
        holds_keyframe = chapter.start <= shot.keyframe_t <= chapter.end
        mostly_covered = duration > 0.0 and covered >= MIN_CHAPTER_SHOT_COVERAGE * duration
        if not (holds_keyframe or mostly_covered):
            continue
        rank = (covered, holds_keyframe)
        if best is None or rank > best_rank:
            best, best_rank = chapter, rank
    return best


def describe_shots_from_chapters(
    chapters: Sequence[TLChapter], shots: Sequence[ShotRecord]
) -> list[ShotRecord]:
    """Tier-2 rows for the shots a Pegasus chapter map describes (plan VU6.3).

    ``/brain/visual/describe`` on TwelveLabs pays 25-38 s of Pegasus per asset and used to
    hand the result to one turn and forget it: the ledger kept ``described: null``, so every
    later run's clip rows read as undescribed and the agent asked — and paid — again. This
    turns that answer into the ledger's own tier-2 record.

    Only shots with NO description are returned: a record from a real tier-2 producer is
    richer than a chapter summary and is never overwritten, and a shot this already filled
    is left alone. Each chapter's prose goes into ``summary`` via
    :func:`described_from_summary` and every structured field stays empty — TwelveLabs said
    a sentence, not a shot size. Both arguments must describe the SAME bytes; the caller
    filters ``shots`` to the content hash the chapter map was computed from.

    :param chapters: The asset's Pegasus chapters, asset seconds.
    :param shots: The asset's measured shots for the chapter map's content hash.
    :returns: Copies of the matched, undescribed shots with ``described`` set.
    """
    rows: list[ShotRecord] = []
    for shot in shots:
        if shot.described is not None:
            continue
        chapter = _chapter_for_shot(shot, chapters)
        if chapter is None:
            continue
        try:
            facts = described_from_summary(chapter_caption(chapter), model=TL_DESCRIBED_MODEL)
        except DescribedParseError:
            continue  # a chapter with no title and no summary says nothing to store
        rows.append(shot.model_copy(update={"described": facts}))
    return rows


def _str_or_none(value: object) -> str | None:
    """A non-empty string, or ``None`` (defensive against malformed rows)."""
    return value if isinstance(value, str) and value else None


def _int_or_none(value: object) -> int | None:
    """An int (never a bool), or ``None`` (defensive against malformed rows)."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None
