"""Semantic ingest + similarity search over brain embeddings (plan B3.2/B3.3).

WHY: ``find_similar`` ("moments like X") needs meaning-level recall that FTS
keyword matching cannot give. This module owns the pure, deterministic
transformations between the canonical project document and the ``embeddings``
table, and the query-time ranking:

- **Ingest** (:func:`build_embedding_rows`): transcript utterances (the same
  ``DIALOGUE_GAP_SECONDS`` segmentation the FTS index and the TS semantic
  index use) plus per-asset bin-summary digests, embedded in ONE batch and
  stored with the payload each hit needs at query time.
- **Query** (:func:`semantic_hits`): brute-force cosine over the stored
  vectors, mapped back to typed :class:`~framepilot_engine.brain.models.SearchHit`
  rows via the payloads.
- **Blend** (:func:`blend_hits`): when both semantic and keyword hits exist,
  a deterministic weighted rank; with no embedder the caller degrades to
  keyword-only (honest, never fabricated similarity).

Everything here is pure over its inputs (the embedder is injected), so the
module carries 100% coverage without model weights.
"""

from __future__ import annotations

from dataclasses import dataclass

from framepilot_engine.brain.embeddings import Embedder, cosine_top_k, pack_vector
from framepilot_engine.brain.models import (
    EmbeddingRow,
    SearchHit,
    SearchHitType,
    TranscriptUtterance,
    VisualCaptionRow,
)

__all__ = [
    "AssetDigest",
    "blend_hits",
    "build_embedding_rows",
    "semantic_hits",
]

OWNER_TYPE_UTTERANCE = "utterance"
OWNER_TYPE_ASSET = "asset"
OWNER_TYPE_CAPTION = "caption"

# Blend weights (B3.3): semantic similarity carries more signal than keyword
# overlap, but a hit found by BOTH ranks above either alone (weights sum when
# the merge key matches). Documented constants, never magic numbers.
SEMANTIC_WEIGHT = 0.6
KEYWORD_WEIGHT = 0.4

# Long utterances are stored whole (the vector saw the full text) but hit
# snippets stay skimmable, mirroring the FTS snippet() budget.
_SNIPPET_MAX_CHARS = 120


@dataclass(frozen=True)
class AssetDigest:
    """One asset's embeddable digest: id, declared path, and the summary text."""

    asset_id: str
    path: str
    text: str


def build_embedding_rows(
    embedder: Embedder,
    utterances: list[TranscriptUtterance],
    digests: list[AssetDigest],
    captions: list[VisualCaptionRow] | None = None,
) -> list[EmbeddingRow]:
    """Embed a project's utterances + asset digests + captions in one batch (B3.2).

    Owner ids are positional for utterances (``utt:00042``) because those rows
    are dropped and rebuilt from the canonical document on every ingest
    (invariant 1). Captions (plan MI3.2 — optional, back-compatible) get a
    *stable* owner id ``cap:{assetId}:{sceneIndex}:{t0}`` keyed to their
    ``visual_captions`` PK, and a payload with everything MI5 fusion needs to
    build a caption evidence packet without re-reading the store. Embedding all
    three in ONE batch is deliberate: they share the model id, so a single
    :meth:`~framepilot_engine.brain.store.BrainStore.replace_embeddings` call
    stores the whole unified text-recall space at once (a per-kind call would
    clobber the others, which key the same ``model``).

    Each payload carries exactly what :func:`semantic_hits` needs to rebuild a
    typed hit.
    """
    caption_rows = captions or []
    texts = (
        [u.text for u in utterances]
        + [d.text for d in digests]
        + [c.text for c in caption_rows]
    )
    if not texts:
        return []
    vectors = embedder.embed(texts)
    rows = [
        EmbeddingRow(
            owner_type=OWNER_TYPE_UTTERANCE,
            owner_id=f"utt:{i:05d}",
            model=embedder.model_id,
            dim=len(vector),
            vector=vector,
            payload={"start": u.start, "end": u.end, "text": u.text},
        )
        for i, (u, vector) in enumerate(zip(utterances, vectors, strict=False))
    ]
    digest_vectors = vectors[len(utterances) : len(utterances) + len(digests)]
    rows.extend(
        EmbeddingRow(
            owner_type=OWNER_TYPE_ASSET,
            owner_id=digest.asset_id,
            model=embedder.model_id,
            dim=len(vector),
            vector=vector,
            payload={"path": digest.path},
        )
        for digest, vector in zip(digests, digest_vectors, strict=True)
    )
    rows.extend(
        EmbeddingRow(
            owner_type=OWNER_TYPE_CAPTION,
            owner_id=f"cap:{c.asset_id}:{c.scene_index}:{c.t0}",
            model=embedder.model_id,
            dim=len(vector),
            vector=vector,
            payload={
                "assetId": c.asset_id,
                "sceneIndex": c.scene_index,
                "t0": c.t0,
                "t1": c.t1,
                "text": c.text,
            },
        )
        for c, vector in zip(caption_rows, vectors[len(utterances) + len(digests) :], strict=True)
    )
    return rows


def _snippet(text: str) -> str:
    if len(text) <= _SNIPPET_MAX_CHARS:
        return text
    return text[:_SNIPPET_MAX_CHARS].rstrip() + "…"


def _hit_from_row(row: EmbeddingRow, score: float) -> SearchHit:
    """Rebuild a typed hit from a stored embedding row's payload."""
    payload = row.payload or {}
    if row.owner_type == OWNER_TYPE_UTTERANCE:
        return SearchHit(
            type=SearchHitType.TRANSCRIPT,
            start=float(payload.get("start", 0.0)),
            end=float(payload.get("end", 0.0)),
            snippet=_snippet(str(payload.get("text", ""))),
            score=score,
        )
    if row.owner_type == OWNER_TYPE_CAPTION:
        # Caption rows carry asset-time span + text (plan MI3.2); a caption is
        # timed visual evidence, never an asset-name hit — classifying it as
        # ASSET here would corrupt find_similar once captions are text-embedded.
        return SearchHit(
            type=SearchHitType.CAPTION,
            asset_id=str(payload["assetId"]) if payload.get("assetId") is not None else None,
            start=float(payload.get("t0", 0.0)),
            end=float(payload.get("t1", 0.0)),
            snippet=_snippet(str(payload.get("text", ""))),
            score=score,
        )
    return SearchHit(
        type=SearchHitType.ASSET,
        asset_id=row.owner_id,
        snippet=str(payload.get("path", row.owner_id)),
        score=score,
    )


def semantic_hits(
    embedder: Embedder, query: str, rows: list[EmbeddingRow], *, limit: int
) -> list[SearchHit]:
    """Rank stored embeddings against ``query`` by cosine similarity (B3.3).

    Scores are shifted from cosine's [-1, 1] into [0, 1] so downstream
    blending never sees negatives. Rows from other models are the caller's
    responsibility to exclude (list by one model id).
    """
    if not rows or not query.strip():
        return []
    [query_vector] = embedder.embed([query])
    by_key = {f"{row.owner_type}/{row.owner_id}": row for row in rows}
    ranked = cosine_top_k(
        query_vector,
        [(key, pack_vector(row.vector)) for key, row in sorted(by_key.items())],
        limit,
    )
    return [_hit_from_row(by_key[key], (score + 1.0) / 2.0) for key, score in ranked]


def _merge_key(hit: SearchHit) -> tuple[str, str, float, float]:
    """Identity of the *thing* a hit points at, across semantic/keyword lists."""
    return (
        hit.type,
        hit.asset_id or hit.marker_id or "",
        round(hit.start, 3) if hit.start is not None else -1.0,
        round(hit.end, 3) if hit.end is not None else -1.0,
    )


def _normalized(hits: list[SearchHit]) -> dict[tuple[str, str, float, float], SearchHit]:
    """Scale a hit list's scores into [0, 1] by its own best score, keyed for merge."""
    best = max((h.score for h in hits), default=0.0)
    scaled: dict[tuple[str, str, float, float], SearchHit] = {}
    for hit in hits:
        key = _merge_key(hit)
        score = hit.score / best if best > 0 else 0.0
        existing = scaled.get(key)
        if existing is None or score > existing.score:
            scaled[key] = hit.model_copy(update={"score": score})
    return scaled


def blend_hits(
    semantic: list[SearchHit], keyword: list[SearchHit], *, limit: int
) -> list[SearchHit]:
    """Deterministic weighted merge of semantic + keyword hits (plan B3.3).

    Each list is normalized by its own best score, then weighted
    (:data:`SEMANTIC_WEIGHT` / :data:`KEYWORD_WEIGHT`); a hit present in both
    lists sums both contributions, so agreement outranks either signal alone.
    The semantic hit's snippet wins on merge (it carries the full utterance
    text rather than FTS match markers). Ties break by type, position, id.
    """
    semantic_by_key = _normalized(semantic)
    keyword_by_key = _normalized(keyword)
    blended: list[SearchHit] = []
    for key in sorted({*semantic_by_key, *keyword_by_key}):
        sem, kw = semantic_by_key.get(key), keyword_by_key.get(key)
        score = SEMANTIC_WEIGHT * (sem.score if sem else 0.0) + KEYWORD_WEIGHT * (
            kw.score if kw else 0.0
        )
        base = sem if sem is not None else kw
        assert base is not None  # every key came from one of the two maps
        blended.append(base.model_copy(update={"score": score}))
    blended.sort(key=lambda h: (-h.score, h.type, h.start or 0.0, h.asset_id or h.marker_id or ""))
    return blended[:limit]
