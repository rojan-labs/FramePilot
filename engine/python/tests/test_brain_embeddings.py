"""Tests for the embedder seam + cosine similarity (plan B3.1/B3.2).

The embedding math and the capability gate are deterministic core code (100%
coverage): the ONNX session and tokenizer are constructor-injected, so every
branch — including all the honest-unavailable degradations — runs without
model weights or the optional ``embeddings`` extra installed.
"""

from __future__ import annotations

import importlib
import math
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from framepilot_engine.brain import BrainStore, EmbeddingRow
from framepilot_engine.brain.embeddings import (
    MODEL_FILENAME,
    TOKENIZER_FILENAME,
    OnnxTextEmbedder,
    cosine_top_k,
    load_onnx_embedder,
    pack_vector,
    resolve_embedder,
    unpack_vector,
)

# --- vector packing -----------------------------------------------------------


def test_pack_unpack_roundtrip_float32() -> None:
    vector = [0.25, -1.5, 3.0]
    assert unpack_vector(pack_vector(vector)) == vector


# --- cosine_top_k ---------------------------------------------------------------


def test_cosine_top_k_ranks_by_similarity_then_key() -> None:
    candidates = [
        ("orthogonal", pack_vector([0.0, 1.0])),
        ("same-b", pack_vector([2.0, 0.0])),  # scale must not matter (normalized)
        ("same-a", pack_vector([1.0, 0.0])),
        ("opposite", pack_vector([-1.0, 0.0])),
    ]
    ranked = cosine_top_k([1.0, 0.0], candidates, k=4)
    assert [key for key, _ in ranked] == ["same-a", "same-b", "orthogonal", "opposite"]
    assert ranked[0][1] == pytest.approx(1.0)
    assert ranked[2][1] == pytest.approx(0.0)
    assert ranked[3][1] == pytest.approx(-1.0)


def test_cosine_top_k_bounds_results_to_k() -> None:
    candidates = [(f"c{i}", pack_vector([1.0, float(i)])) for i in range(5)]
    assert len(cosine_top_k([1.0, 0.0], candidates, k=2)) == 2


def test_cosine_top_k_degenerate_inputs_return_empty() -> None:
    candidates = [("c", pack_vector([1.0, 0.0]))]
    assert cosine_top_k([1.0, 0.0], [], k=3) == []
    assert cosine_top_k([1.0, 0.0], candidates, k=0) == []
    assert cosine_top_k([0.0, 0.0], candidates, k=3) == []  # zero query vector


def test_cosine_top_k_zero_candidate_scores_zero_not_nan() -> None:
    ranked = cosine_top_k([1.0, 0.0], [("zero", pack_vector([0.0, 0.0]))], k=1)
    assert ranked == [("zero", 0.0)]


# --- OnnxTextEmbedder (fake session/tokenizer) -----------------------------------


class FakeSession:
    """An ONNX session double: 'hidden state' echoes token ids as floats."""

    def __init__(self, *, input_names: list[str], dim: int = 2) -> None:
        self._input_names = input_names
        self._dim = dim
        self.last_feeds: dict[str, Any] | None = None

    def get_inputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name=n) for n in self._input_names]

    def get_outputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="last_hidden_state", shape=[None, None, self._dim])]

    def run(self, output_names: list[str], feeds: dict[str, Any]) -> list[np.ndarray]:
        assert output_names == ["last_hidden_state"]
        self.last_feeds = feeds
        ids = feeds["input_ids"]
        # Each token's "hidden state" is [id, 1] so mean pooling is checkable.
        hidden = np.stack(
            [np.stack([[float(t), 1.0] for t in row]) for row in ids]
        ).astype(np.float32)
        return [hidden]


class FakeTokenizer:
    """Tokenizer double: one token per word, padded to the batch max length."""

    def encode_batch(self, texts: list[str]) -> list[SimpleNamespace]:
        split = [t.split() for t in texts]
        width = max(len(words) for words in split)
        return [
            SimpleNamespace(
                ids=[len(w) for w in words] + [0] * (width - len(words)),
                attention_mask=[1] * len(words) + [0] * (width - len(words)),
            )
            for words in split
        ]


def test_embedder_mean_pools_only_real_tokens_and_normalizes() -> None:
    session = FakeSession(input_names=["input_ids", "attention_mask"])
    embedder = OnnxTextEmbedder(session, FakeTokenizer(), model_id="fake:minilm")
    [short, long] = embedder.embed(["hi", "one two three"])
    # "hi" pads to width 3 but only its single real token may be pooled:
    # hidden = [2, 1] → normalized to unit length.
    expected = np.asarray([2.0, 1.0]) / math.sqrt(5.0)
    assert short == pytest.approx(expected.tolist())
    assert np.linalg.norm(long) == pytest.approx(1.0)
    assert embedder.model_id == "fake:minilm"
    assert embedder.dim == 2


def test_embedder_feeds_token_type_ids_only_when_graph_declares_them() -> None:
    with_types = FakeSession(input_names=["input_ids", "attention_mask", "token_type_ids"])
    OnnxTextEmbedder(with_types, FakeTokenizer(), model_id="m").embed(["a b"])
    assert with_types.last_feeds is not None
    assert np.array_equal(
        with_types.last_feeds["token_type_ids"], np.zeros((1, 2), dtype=np.int64)
    )
    without = FakeSession(input_names=["input_ids", "attention_mask"])
    OnnxTextEmbedder(without, FakeTokenizer(), model_id="m").embed(["a b"])
    assert without.last_feeds is not None and "token_type_ids" not in without.last_feeds


def test_embedder_empty_batch_short_circuits() -> None:
    session = FakeSession(input_names=["input_ids", "attention_mask"])
    assert OnnxTextEmbedder(session, FakeTokenizer(), model_id="m").embed([]) == []
    assert session.last_feeds is None


# --- capability gate (resolve/load) ------------------------------------------------


def test_resolve_embedder_without_configured_dir_is_honest_unavailable() -> None:
    resolution = resolve_embedder(None)
    assert resolution.embedder is None
    assert resolution.reason is not None
    assert "FRAMEPILOT_EMBEDDINGS_MODEL_DIR" in resolution.reason


def test_load_onnx_embedder_requires_both_model_files(tmp_path: Path) -> None:
    resolution = load_onnx_embedder(tmp_path)
    assert resolution.embedder is None and resolution.reason is not None
    assert MODEL_FILENAME in resolution.reason and TOKENIZER_FILENAME in resolution.reason
    (tmp_path / MODEL_FILENAME).write_bytes(b"onnx")
    still_missing = load_onnx_embedder(tmp_path)
    assert still_missing.embedder is None


@pytest.fixture
def model_dir(tmp_path: Path) -> Path:
    (tmp_path / MODEL_FILENAME).write_bytes(b"onnx")
    (tmp_path / TOKENIZER_FILENAME).write_text("{}")
    return tmp_path


@pytest.fixture
def fake_backend_modules(
    monkeypatch: pytest.MonkeyPatch, model_dir: Path
) -> Iterator[dict[str, Any]]:
    """Route the optional backend imports to controllable fakes."""
    calls: dict[str, Any] = {}

    class FakeRuntimeTokenizer(FakeTokenizer):
        def enable_truncation(self, *, max_length: int) -> None:
            calls["truncation"] = max_length

        def enable_padding(self) -> None:
            calls["padding"] = True

    fake_onnxruntime = SimpleNamespace(
        InferenceSession=lambda path, providers: FakeSession(
            input_names=["input_ids", "attention_mask"]
        )
    )
    fake_tokenizers = SimpleNamespace(
        Tokenizer=SimpleNamespace(from_file=lambda path: FakeRuntimeTokenizer())
    )
    real_import = importlib.import_module

    def fake_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "onnxruntime":
            return calls.get("onnxruntime_override") or fake_onnxruntime
        if name == "tokenizers":
            return fake_tokenizers
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(importlib, "import_module", fake_import)
    yield calls


def test_load_onnx_embedder_success_path(
    model_dir: Path, fake_backend_modules: dict[str, Any]
) -> None:
    resolution = load_onnx_embedder(model_dir)
    assert resolution.reason is None and resolution.embedder is not None
    assert resolution.embedder.model_id == f"onnx:{model_dir.name}"
    assert fake_backend_modules["truncation"] > 0 and fake_backend_modules["padding"] is True
    # resolve_embedder with a configured dir delegates to the loader.
    assert resolve_embedder(model_dir).embedder is not None


def test_load_onnx_embedder_reports_missing_optional_extra(
    model_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_import = importlib.import_module

    def failing_import(name: str, package: str | None = None) -> object:
        if name in ("onnxruntime", "tokenizers"):
            raise ImportError(f"No module named {name!r}")
        return real_import(name, package)

    monkeypatch.setattr(importlib, "import_module", failing_import)
    resolution = load_onnx_embedder(model_dir)
    assert resolution.embedder is None and resolution.reason is not None
    assert "framepilot-engine[embeddings]" in resolution.reason


def test_load_onnx_embedder_reports_loader_failure(
    model_dir: Path, fake_backend_modules: dict[str, Any]
) -> None:
    def exploding_session(path: str, providers: list[str]) -> object:
        raise ValueError("corrupt model")

    fake_backend_modules["onnxruntime_override"] = SimpleNamespace(
        InferenceSession=exploding_session
    )
    resolution = load_onnx_embedder(model_dir)
    assert resolution.embedder is None and resolution.reason is not None
    assert "corrupt model" in resolution.reason


# --- store: replace/list embeddings (plan B3.2) ------------------------------------


def _row(owner_id: str, vector: list[float], **payload: Any) -> EmbeddingRow:
    return EmbeddingRow(
        owner_type="utterance",
        owner_id=owner_id,
        model="fake:minilm",
        dim=len(vector),
        vector=vector,
        payload=payload or None,
    )


def test_store_replace_and_list_embeddings_roundtrip(tmp_path: Path) -> None:
    with BrainStore.open(tmp_path / "brain.sqlite") as store:
        count = store.replace_embeddings(
            "fake:minilm",
            [_row("u1", [1.0, 0.0], text="hello", start=0.0, end=1.0), _row("u0", [0.0, 1.0])],
        )
        assert count == 2
        rows = store.list_embeddings("fake:minilm")
        assert [r.owner_id for r in rows] == ["u0", "u1"]  # deterministic order
        assert rows[1].vector == [1.0, 0.0]
        assert rows[1].payload == {"text": "hello", "start": 0.0, "end": 1.0}
        assert rows[0].payload is None
        assert store.status().counts["embeddings"] == 2


def test_store_replace_embeddings_is_scoped_to_one_model(tmp_path: Path) -> None:
    other = EmbeddingRow(
        owner_type="asset", owner_id="a1", model="other:model", dim=2, vector=[0.5, 0.5]
    )
    with BrainStore.open(tmp_path / "brain.sqlite") as store:
        store.replace_embeddings("other:model", [other])
        store.replace_embeddings("fake:minilm", [_row("u1", [1.0, 0.0])])
        store.replace_embeddings("fake:minilm", [_row("u2", [0.0, 1.0])])  # drop-and-rebuild
        assert [r.owner_id for r in store.list_embeddings("fake:minilm")] == ["u2"]
        assert [r.owner_id for r in store.list_embeddings("other:model")] == ["a1"]
        assert [
            r.owner_id for r in store.list_embeddings("other:model", owner_type="asset")
        ] == ["a1"]
        assert store.list_embeddings("other:model", owner_type="utterance") == []


def test_migration_v2_adds_payload_to_a_v1_brain(tmp_path: Path) -> None:
    """A brain created before B3 upgrades in place and accepts payloads."""
    import sqlite3

    from framepilot_engine.brain.migrations import MIGRATIONS

    db_path = tmp_path / "brain.sqlite"
    conn = sqlite3.connect(db_path)
    MIGRATIONS[0](conn)  # v1 only — the pre-B3 file format
    conn.execute("PRAGMA user_version = 1")
    conn.commit()
    conn.close()
    with BrainStore.open(db_path) as store:
        store.replace_embeddings("fake:minilm", [_row("u1", [1.0, 0.0], text="hi")])
        assert store.list_embeddings("fake:minilm")[0].payload == {"text": "hi"}
