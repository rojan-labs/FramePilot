"""Embedder seam + brute-force cosine similarity for the Project Brain (plan B3).

WHY: "find moments similar to X" needs semantic recall, not just keyword
matching. This module owns the **seam**, not any particular model:

- :class:`Embedder` is the injectable protocol every backend implements.
- :func:`resolve_embedder` is the capability gate. With no model configured it
  resolves to *nothing* plus a reason — the honest-unavailable discipline
  (never a fabricated similarity). The real backend (ONNX MiniLM-class text
  encoder via ``onnxruntime`` + ``tokenizers``) activates ONLY when both the
  optional ``embeddings`` extra is installed and
  ``FRAMEPILOT_EMBEDDINGS_MODEL_DIR`` points at a model directory.
- Similarity is brute-force cosine over float32 vectors (davinci-style): a
  project brain holds thousands of utterances, not millions, so a vector
  database would be pure dependency creep.

Vectors are stored L2-normalized as little-endian float32 BLOBs so cosine
reduces to a dot product at query time.
"""

from __future__ import annotations

import importlib
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

_log = logging.getLogger(__name__)

__all__ = [
    "Embedder",
    "EmbedderResolution",
    "OnnxTextEmbedder",
    "cosine_top_k",
    "load_onnx_embedder",
    "pack_vector",
    "resolve_embedder",
    "unpack_vector",
]

# The two files an embeddings model directory must contain. MiniLM-class
# sentence encoders exported to ONNX ship exactly this pair.
MODEL_FILENAME = "model.onnx"
TOKENIZER_FILENAME = "tokenizer.json"

# Sentence encoders degrade past their training length; 256 tokens comfortably
# covers an utterance or a bin-summary digest section.
_MAX_TOKENS = 256


class Embedder(Protocol):
    """A text-embedding backend (plan B3.1).

    ``embed`` maps texts to unit-length (L2-normalized) vectors of ``dim``
    floats. ``model_id`` keys the stored vectors so switching models can never
    silently mix incompatible spaces.
    """

    @property
    def model_id(self) -> str: ...
    @property
    def dim(self) -> int: ...
    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


@dataclass(frozen=True)
class EmbedderResolution:
    """Outcome of the embedder capability gate (honest-unavailable shape).

    Exactly one of ``embedder``/``reason`` is meaningful: no embedder always
    comes with a human-readable reason the routes surface verbatim.
    """

    embedder: Embedder | None
    reason: str | None = None


def pack_vector(vector: Sequence[float]) -> bytes:
    """Serialize a vector to the BLOB format of the ``embeddings`` table."""
    return np.asarray(vector, dtype="<f4").tobytes()


def unpack_vector(blob: bytes) -> list[float]:
    """Deserialize a BLOB written by :func:`pack_vector`."""
    values: list[float] = np.frombuffer(blob, dtype="<f4").astype(float).tolist()
    return values


def _l2_normalize(matrix: np.ndarray) -> np.ndarray:
    """Row-normalize; an all-zero row stays zero instead of dividing by zero."""
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.where(norms == 0.0, 1.0, norms)


def cosine_top_k(
    query: Sequence[float], candidates: Sequence[tuple[str, bytes]], k: int
) -> list[tuple[str, float]]:
    """Brute-force cosine similarity, best first (plan B3.2).

    :param query: The query vector (any scale; normalized here).
    :param candidates: ``(key, packed_vector)`` pairs; stored vectors are
        already unit-length but are re-normalized defensively.
    :param k: Max results.
    :returns: Up to ``k`` ``(key, score)`` pairs, score in [-1, 1], sorted by
        score descending then key (deterministic ties).
    """
    if k <= 0 or not candidates:
        return []
    q = np.asarray(query, dtype=np.float32)
    q_norm = float(np.linalg.norm(q))
    if q_norm == 0.0:
        return []
    matrix = _l2_normalize(
        np.stack([np.frombuffer(blob, dtype="<f4") for _, blob in candidates]).astype(np.float32)
    )
    scores = matrix @ (q / q_norm)
    ranked = sorted(
        zip((key for key, _ in candidates), scores.tolist(), strict=True),
        key=lambda pair: (-pair[1], pair[0]),
    )
    return ranked[:k]


class OnnxTextEmbedder:
    """MiniLM-class ONNX sentence encoder: tokenize → transformer → mean-pool.

    The ONNX session and tokenizer are constructor-injected so the embedding
    math is unit-testable without model weights; :func:`load_onnx_embedder`
    builds the real pair from a model directory.
    """

    def __init__(self, session: Any, tokenizer: Any, *, model_id: str) -> None:
        self._session = session
        self._tokenizer = tokenizer
        self._model_id = model_id
        self._input_names = {i.name for i in session.get_inputs()}
        self._dim = int(session.get_outputs()[0].shape[-1])

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def dim(self) -> int:
        return self._dim

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed a batch of texts to unit-length vectors."""
        if not texts:
            return []
        encodings = self._tokenizer.encode_batch(list(texts))
        input_ids = np.asarray([e.ids for e in encodings], dtype=np.int64)
        attention = np.asarray([e.attention_mask for e in encodings], dtype=np.int64)
        feeds: dict[str, np.ndarray] = {"input_ids": input_ids, "attention_mask": attention}
        # Some ONNX exports drop token_type_ids; feed zeros only when declared.
        if "token_type_ids" in self._input_names:
            feeds["token_type_ids"] = np.zeros_like(input_ids)
        (hidden,) = self._session.run([self._session.get_outputs()[0].name], feeds)
        # Mean pooling over real (non-padding) tokens, per sentence-transformers.
        mask = attention[..., np.newaxis].astype(np.float32)
        summed = (hidden * mask).sum(axis=1)
        counts = np.maximum(mask.sum(axis=1), 1.0)
        vectors: list[list[float]] = _l2_normalize(summed / counts).astype(float).tolist()
        return vectors


def load_onnx_embedder(model_dir: Path) -> EmbedderResolution:
    """Load the ONNX backend from a model directory, or say why it can't (B3.1).

    Every failure path — missing files, the optional ``embeddings`` extra not
    installed, a corrupt model — resolves to a typed reason, never an
    exception: callers degrade to FTS-only search.
    """
    model_path = model_dir / MODEL_FILENAME
    tokenizer_path = model_dir / TOKENIZER_FILENAME
    if not model_path.is_file() or not tokenizer_path.is_file():
        return EmbedderResolution(
            embedder=None,
            reason=(
                f"Embeddings model directory {model_dir} must contain "
                f"{MODEL_FILENAME} and {TOKENIZER_FILENAME}."
            ),
        )
    try:
        onnxruntime = importlib.import_module("onnxruntime")
        tokenizers = importlib.import_module("tokenizers")
    except ImportError as exc:
        return EmbedderResolution(
            embedder=None,
            reason=(
                "The optional embeddings backend is not installed "
                f"(pip install 'framepilot-engine[embeddings]'): {exc}"
            ),
        )
    try:
        session = onnxruntime.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        tokenizer = tokenizers.Tokenizer.from_file(str(tokenizer_path))
        tokenizer.enable_truncation(max_length=_MAX_TOKENS)
        tokenizer.enable_padding()
    except Exception as exc:  # third-party loaders raise freely
        return EmbedderResolution(
            embedder=None, reason=f"Failed to load embeddings model from {model_dir}: {exc}"
        )
    embedder = OnnxTextEmbedder(session, tokenizer, model_id=f"onnx:{model_dir.name}")
    _log.info("ACT embeddings backend loaded: model=%s dim=%d", embedder.model_id, embedder.dim)
    return EmbedderResolution(embedder=embedder)


def resolve_embedder(model_dir: Path | None) -> EmbedderResolution:
    """The embedder capability gate (plan B3.1).

    No configured model directory is the SHIPPED default: similarity honestly
    reports unavailable and `find_similar` degrades to keyword search. Nothing
    downloads models or phones home.
    """
    if model_dir is None:
        return EmbedderResolution(
            embedder=None,
            reason=(
                "No embeddings model configured (set FRAMEPILOT_EMBEDDINGS_MODEL_DIR "
                "to a directory holding model.onnx + tokenizer.json); similarity "
                "search degrades to keyword matching."
            ),
        )
    return load_onnx_embedder(model_dir)
