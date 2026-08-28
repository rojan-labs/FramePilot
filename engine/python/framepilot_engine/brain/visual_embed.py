"""NVIDIA visual-embedding client with multi-key failover (plan MI2.1, §3.2).

WHY: the visual index (plan ``MEDIA-INTELLIGENCE.md``) embeds sampled video
frames and still images with NVIDIA ``llama-nemotron-embed-vl-1b-v2`` — a
cross-modal model where **image passages** and **text queries** land in one
vector space. This module owns the HTTP contract with
``integrate.api.nvidia.com`` and nothing else: batching, splitting oversized
payloads, and rotating through the user's comma-separated key ring
(:class:`~framepilot_engine.brain.keyring.KeyRing`) on failure. Sampling,
storage, and search live elsewhere (MI1/MI2.2/MI2.3).

Design rules:

- **Injected everything.** The ``httpx.Client`` and the monotonic clock are
  constructor parameters, so every branch — success, each failover status,
  exhaustion, payload splitting — is testable with respx and a fake clock.
  No test tier ever talks to the live API (plan §6).
- **The payload shape lives in exactly one place** (:meth:`_payload`); see its
  docstring for the asymmetric passage/query contract.
- **Never hardcode ``dim``.** The embedding dimension is captured from the
  first successful response (:attr:`VisualEmbedClient.dim`) and the schema
  stores it per vector — a model swap can never silently mix spaces.
- **Secrets and pixels stay out of logs.** Only batch sizes, dimensions, and
  HTTP status codes are logged; never key material, image bytes, or data URIs.
"""

from __future__ import annotations

import base64
import logging
import threading
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

import httpx

from framepilot_engine.brain.keyring import KeyRing, KeyRingExhaustedError, parse_keys

_log = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_BATCH_SIZE",
    "DEFAULT_TIMEOUT_SECONDS",
    "EMBEDDINGS_URL",
    "MODEL_ID",
    "NO_API_KEY_REASON",
    "EmbedResult",
    "VisualEmbedClient",
    "VisualEmbedError",
    "VisualEmbedderResolution",
    "resolve_visual_embedder",
]

#: The cross-modal embedding model (plan D1/§3.2). Image passages and text
#: queries share this one vector space; changing it invalidates stored vectors,
#: which is why the model id is part of every stored row's key.
MODEL_ID = "nvidia/llama-nemotron-embed-vl-1b-v2"

#: NVIDIA's OpenAI-compatible embeddings endpoint.
EMBEDDINGS_URL = "https://integrate.api.nvidia.com/v1/embeddings"

#: Frames per request. Conservative on purpose: each frame is a base64 JPEG
#: (~50-150 KB as a data URI), and the endpoint rejects oversized payloads with
#: 413 — starting small means the split-in-half path is the exception.
DEFAULT_BATCH_SIZE = 8
#: Ceiling on embedding requests in flight at once. The real ceiling is the number of
#: keys that can serve them (`KeyRing.alive_count`); this bounds a very long worklist
#: from opening an unreasonable number of sockets at once on a many-key ring.
DEFAULT_MAX_CONCURRENCY = 8

#: Per-request timeout in seconds. Embedding a batch of JPEG frames is slow
#: server-side; the default httpx 5s would flake constantly.
DEFAULT_TIMEOUT_SECONDS = 60.0

#: Typed reason when no key is configured (mirrors the honest-unavailable
#: reasons in :mod:`framepilot_engine.brain.embeddings`).
NO_API_KEY_REASON = "no_api_key"

_DATA_URI_PREFIX = "data:image/jpeg;base64,"


class VisualEmbedError(Exception):
    """A request failed in a way key rotation cannot fix.

    Raised for non-retryable HTTP errors (a 4xx that is not an auth/rate
    problem), malformed response bodies, and a single frame that exceeds the
    payload limit even alone (the split floor).
    """


class _PayloadTooLargeError(Exception):
    """Internal signal: the batch must be split, the key is not at fault."""


@dataclass(frozen=True)
class EmbedResult:
    """Vectors for one :meth:`VisualEmbedClient.embed_passages` call.

    ``vectors[i]`` corresponds to ``images[i]``; ``dim`` is the captured
    embedding dimension (``None`` only for an empty input on a fresh client).
    """

    model: str
    dim: int | None
    vectors: list[list[float]]


@dataclass(frozen=True)
class VisualEmbedderResolution:
    """Outcome of the visual-embedder capability gate (honest-unavailable shape).

    Mirrors :class:`~framepilot_engine.brain.embeddings.EmbedderResolution`:
    exactly one of ``client``/``reason`` is meaningful.
    """

    client: VisualEmbedClient | None
    reason: str | None = None


def _to_data_uri(image_jpeg: bytes) -> str:
    """Encode JPEG bytes as the base64 data URI the API expects."""
    return _DATA_URI_PREFIX + base64.b64encode(image_jpeg).decode("ascii")


def _is_payload_too_large(status: int, body: str) -> bool:
    """Whether a failure means "smaller batch, please" rather than a bad key.

    413 is unambiguous; some gateways report the same condition as a 400 whose
    body mentions the size problem.
    """
    if status == 413:
        return True
    return status == 400 and "too large" in body.lower()


class VisualEmbedClient:
    """Batched NVIDIA embeddings client over an injected key ring (plan §3.2).

    Failover per decision D5: 401/403 kill a key for the session, 429/5xx cool
    it down, and every failure rotates to the next key; when the whole ring is
    dead or cooling the typed
    :class:`~framepilot_engine.brain.keyring.KeyRingExhaustedError` propagates
    so callers surface ``{available: false, reason: "all_keys_failing"}``.
    """

    def __init__(
        self,
        ring: KeyRing,
        *,
        http: httpx.Client,
        now: Callable[[], float] = time.monotonic,
        batch_size: int = DEFAULT_BATCH_SIZE,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
    ) -> None:
        """
        :param ring: The failover key ring (from the user's comma-separated setting).
        :param http: The HTTP client — injected so tests mock the transport.
        :param now: Monotonic clock feeding the ring's cooldown math.
        :param batch_size: Max frames per request; oversized payloads still
            split themselves on 413.
        :param timeout_seconds: Per-request timeout.
        :raises ValueError: On a non-positive batch size or timeout.
        """
        if batch_size <= 0:
            raise ValueError(f"batch_size must be > 0, got {batch_size}.")
        if timeout_seconds <= 0:
            raise ValueError(f"timeout_seconds must be > 0, got {timeout_seconds}.")
        if max_concurrency <= 0:
            raise ValueError(f"max_concurrency must be > 0, got {max_concurrency}.")
        self._max_concurrency = max_concurrency
        # `_dim` and `_last_error` are written from whichever batch finishes first.
        self._state_lock = threading.Lock()
        self._ring = ring
        self._http = http
        self._now = now
        self._batch_size = batch_size
        self._timeout = timeout_seconds
        self._dim: int | None = None
        self._last_error: str | None = None

    @property
    def dim(self) -> int | None:
        """Embedding dimension captured from the first successful response.

        ``None`` until something has been embedded — never hardcoded (plan
        §3.2): the stored schema records this per vector.
        """
        return self._dim

    def embed_passages(self, images: Sequence[bytes]) -> EmbedResult:
        """Embed JPEG frames as **image passages** (the stored side of the space).

        :param images: JPEG-encoded frames, already bounded in resolution by
            the sampler's extraction step (MI1.2).
        :returns: One vector per input image, in order.
        :raises KeyRingExhaustedError: When every key is dead or cooling.
        :raises VisualEmbedError: On a non-retryable request failure, a
            malformed response, or a single frame beyond the payload limit.
        """
        if not images:
            return EmbedResult(model=MODEL_ID, dim=self._dim, vectors=[])
        data_uris = [_to_data_uri(image) for image in images]
        batches = [
            data_uris[start : start + self._batch_size]
            for start in range(0, len(data_uris), self._batch_size)
        ]
        if len(batches) == 1:
            # `dim` is captured DURING the request, so it must be read after it, not as
            # a sibling argument — Python evaluates arguments left to right.
            single = self._embed_batch(batches[0])
            return EmbedResult(model=MODEL_ID, dim=self._dim, vectors=single)
        # Batches were issued one after another, so embedding N frames cost N/batch_size
        # round-trips end to end — and on a 60-photo project ~98% of measured wall clock
        # was this wait. They are independent, so they go out together, bounded by the
        # number of keys that can actually serve them (see `_concurrency`).
        results: list[list[list[float]]] = [[] for _ in batches]
        with ThreadPoolExecutor(max_workers=self._concurrency()) as pool:
            futures = {
                pool.submit(self._embed_batch, batch): index for index, batch in enumerate(batches)
            }
            for future in as_completed(futures):
                # Order is restored by index, never by completion: a vector list that
                # does not line up with its spans silently mislabels the whole asset.
                results[futures[future]] = future.result()
        return EmbedResult(
            model=MODEL_ID, dim=self._dim, vectors=[v for batch in results for v in batch]
        )

    def _concurrency(self) -> int:
        """How many embedding requests to have in flight at once.

        Bounded by the keys that can actually serve them: several keys used to buy
        resilience and nothing else, because every request queued behind the first alive
        key's rate limit. It is also the backpressure — as keys cool this falls on its
        own, with no second limiter to keep in sync with the ring.
        """
        return max(1, min(self._max_concurrency, self._ring.alive_count(self._now())))

    def embed_query(self, text: str) -> list[float]:
        """Embed a text **query** into the shared image/text space.

        Query vectors are ephemeral by contract (plan §3.2): callers use them
        for one search and never store them.

        :raises KeyRingExhaustedError: When every key is dead or cooling.
        :raises VisualEmbedError: On a non-retryable failure or malformed response.
        """
        try:
            data = self._post(self._payload([text], input_type="query", modality="text"))
        except _PayloadTooLargeError as exc:
            # A search string can't be meaningfully split; report it as a
            # plain request failure.
            raise VisualEmbedError(
                "The query text exceeds the embeddings API payload limit."
            ) from exc
        return self._extract_vectors(data, expected=1)[0]

    # -- request plumbing --------------------------------------------------------

    def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        """Embed one passage batch, splitting in half on payload-size rejections.

        Recursive halving preserves input order (left half first) and floors
        at a single item: one frame that is still too large is a hard, typed
        error — silently dropping it would corrupt span→vector alignment.
        """
        try:
            data = self._post(self._payload(batch, input_type="passage", modality="image"))
        except _PayloadTooLargeError as exc:
            if len(batch) == 1:
                raise VisualEmbedError(
                    "A single frame exceeds the embeddings API payload limit even "
                    "on its own; re-extract it at a smaller resolution."
                ) from exc
            mid = len(batch) // 2
            _log.debug("visual embed batch of %d too large; splitting at %d", len(batch), mid)
            return self._embed_batch(batch[:mid]) + self._embed_batch(batch[mid:])
        return self._extract_vectors(data, expected=len(batch))

    @staticmethod
    def _payload(inputs: list[str], *, input_type: str, modality: str) -> dict[str, object]:
        """THE request body — the asymmetric embedding contract, in one place.

        NVIDIA's endpoint is OpenAI-``/v1/embeddings``-shaped with two
        asymmetric-retrieval extensions (what the OpenAI SDK would pass via
        ``extra_body``; we POST the flat JSON directly):

        - ``input``: data-URI strings for image passages, plain text for queries.
        - ``input_type``: ``"passage"`` for stored content, ``"query"`` for
          searches — the two sides of the cross-modal space.
        - ``modality``: one encoder-tower value per input. NVIDIA does not
          broadcast a one-item modality list across a batched ``input`` list;
          both arrays must have identical cardinality.
        """
        return {
            "model": MODEL_ID,
            "input": inputs,
            "encoding_format": "float",
            "input_type": input_type,
            "modality": [modality] * len(inputs),
        }

    def _post(self, payload: dict[str, object]) -> dict[str, object]:
        """POST once per live key until a key succeeds or the ring is exhausted.

        Status handling (plan §3.2 / D5):

        - ``200`` → success reported to the ring; JSON returned.
        - ``413`` (or a "too large" ``400``) → :class:`_PayloadTooLargeError`;
          the key is NOT penalized — the payload is at fault, not the key.
        - ``401/403/429/5xx`` → reported to the ring (dead / cooldown) and the
          next key is tried immediately.
        - any other status → :class:`VisualEmbedError`; rotating keys cannot
          fix a malformed request.
        """
        while True:
            # `exclusive` so concurrent batches draw DIFFERENT keys rather than all
            # queueing behind the first alive one. Released in `finally` whatever the
            # outcome — a key held by a failed request would shrink the ring silently.
            key = self._ring.acquire(self._now(), exclusive=True)
            if key is None:
                raise KeyRingExhaustedError(
                    last_status=self._ring.last_status, last_error=self._last_error
                )
            try:
                response = self._http.post(
                    EMBEDDINGS_URL,
                    json=payload,
                    headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                    timeout=self._timeout,
                )
                status = response.status_code
                if status == 200:
                    self._ring.report_success(key)
                    result: dict[str, object] = response.json()
                    return result
                body_snippet = response.text[:200]
                if _is_payload_too_large(status, response.text):
                    raise _PayloadTooLargeError()
                if status in (401, 403, 429) or status >= 500:
                    with self._state_lock:
                        self._last_error = f"HTTP {status}: {body_snippet}"
                    _log.warning("visual embed request failed with HTTP %d; rotating key", status)
                    self._ring.report_failure(key, status, self._now())
                    continue
                raise VisualEmbedError(
                    f"NVIDIA embeddings request failed with HTTP {status}: {body_snippet}"
                )
            finally:
                self._ring.release(key)

    def _extract_vectors(self, data: dict[str, object], *, expected: int) -> list[list[float]]:
        """Pull vectors out of a response body, in input order, capturing ``dim``.

        :raises VisualEmbedError: On a body without ``data``, a count mismatch,
            or a dimension that disagrees with the captured ``dim`` (vector
            spaces must never mix — plan §3.2).
        """
        entries = data.get("data")
        if not isinstance(entries, list) or len(entries) != expected:
            got = len(entries) if isinstance(entries, list) else "no"
            raise VisualEmbedError(
                f"Embeddings response returned {got} vectors for {expected} inputs."
            )
        ordered = sorted(entries, key=lambda e: int(e["index"]))
        vectors = [[float(v) for v in entry["embedding"]] for entry in ordered]
        for vector in vectors:
            # Under concurrent batches whichever finishes first captures the dimension;
            # the lock keeps the capture-then-compare from interleaving into a false
            # mismatch on two identical, correct responses.
            with self._state_lock:
                if self._dim is None:
                    self._dim = len(vector)
                    _log.info(
                        "ACT visual embeddings dim captured: model=%s dim=%d", MODEL_ID, self._dim
                    )
                    continue
                captured = self._dim
            if len(vector) != captured:
                raise VisualEmbedError(
                    f"Embeddings response dimension {len(vector)} does not match the "
                    f"captured dimension {captured} for {MODEL_ID}."
                )
        return vectors


def resolve_visual_embedder(
    keys_raw: str | None,
    *,
    http: httpx.Client | None = None,
    now: Callable[[], float] = time.monotonic,
) -> VisualEmbedderResolution:
    """The visual-embedder capability gate (plan §3.2, honest-unavailable).

    No configured key is the shipped default: visual indexing/search reports
    ``reason="no_api_key"`` instead of fabricating results. ``http`` exists so
    tests inject a mocked client; the default is a real one.

    :param keys_raw: The comma-separated ``FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS``
        setting (decision D5).
    """
    keys = parse_keys(keys_raw)
    if not keys:
        return VisualEmbedderResolution(client=None, reason=NO_API_KEY_REASON)
    client = VisualEmbedClient(
        KeyRing(keys),
        http=http if http is not None else httpx.Client(),
        now=now,
    )
    return VisualEmbedderResolution(client=client)
