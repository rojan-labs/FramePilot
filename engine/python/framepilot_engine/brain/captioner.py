"""Per-shot STRUCTURED description from a hosted vision provider (plan VU6.3).

WHAT CHANGED, AND WHY THE PROSE PATH IS GONE
============================================

This module used to ask a vision model for "≤2 sentences" of prose and store the string.
That free-text prompt (``CAPTION_INSTRUCTION``) is **deleted**, along with the path that
produced it. Prose was a dead end for three reasons that no amount of prompt-tuning fixes:

- nothing downstream could *use* it — a filter cannot ask "which shots are wide", a solver
  cannot read a lower-third out of a sentence, and the shot ledger had nowhere to put it
  but a text column;
- the three producers (this one, the local VLM pack, TwelveLabs) wrote subtly different
  prose that nothing could compare;
- a sentence hides its own gaps. "A man at a desk" and "a man at a desk, and I could not
  read the sign behind him" are the same length and read the same.

The replacement is one JSON schema — ``brain/described.py`` — enforced at generation time
by whichever mechanism the wire format offers: an Anthropic tool ``input_schema``, an
OpenAI ``response_format: json_schema``, or (in the local pack) llama.cpp's grammar. All
three emit the same :class:`~framepilot_engine.brain.ledger_models.DescribedFacts`.
``visual_captions.text`` keeps the ``summary`` for FTS; the structured document goes to
``shots.described``.

Architecture (unchanged from the MI3 decision):

- Descriptions run **engine-side** (decision D6: the sidecar is the single writer of the
  brain). The TS provider registry has no multimodal support and does not cross the
  process boundary, so this module does **not** reuse it. The host resolves the vision
  provider + key and passes a typed :class:`CaptionProviderConfig` in the
  ``/brain/visual/index`` request body, and this module speaks the provider's HTTP API
  directly via ``httpx``.
- Two wire formats cover the whole configured provider set:

  * ``kind="anthropic"`` → the Anthropic Messages API (``/v1/messages``, ``x-api-key`` +
    ``anthropic-version`` headers, base64 image blocks, a forced tool call for structure).
  * ``kind="openai"`` → OpenAI-compatible chat completions (``/chat/completions``,
    ``Authorization: Bearer``, ``image_url`` data-URI parts, ``response_format``) — covers
    OpenAI, NVIDIA VLM NIM, Google (openai-compat), groq, openrouter, deepseek, ollama.

Design rules mirror :mod:`framepilot_engine.brain.visual_embed`:

- **Injected transport.** The ``httpx.Client`` is a constructor parameter so every branch
  is testable with respx; no test tier ever calls a live API.
- **Best-effort, no key rotation.** A description is evidence, not truth: an HTTP failure
  raises a typed :class:`DescribeError` and the shot is recorded *without* one.
- **Secrets and pixels stay out of logs.** Only frame counts and HTTP status codes are
  logged — never key material, image bytes, or data URIs.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from framepilot_engine.brain.described import (
    DESCRIBE_INSTRUCTION,
    DESCRIBED_JSON_SCHEMA,
    DESCRIBED_SCHEMA_NAME,
    DescribedParseError,
    parse_described,
)
from framepilot_engine.brain.ledger_models import DescribedFacts

_log = logging.getLogger(__name__)

__all__ = [
    "ANTHROPIC_TOOL_NAME",
    "ANTHROPIC_VERSION",
    "DEFAULT_MAX_FRAMES",
    "NO_VISION_PROVIDER_REASON",
    "CaptionProviderConfig",
    "CaptionProviderKind",
    "DescribeError",
    "DescriberResolution",
    "SceneDescriber",
    "is_informative_caption",
    "resolve_describer",
]

#: The two request wire formats. The host maps its provider *name* (anthropic, openai,
#: nvidia, google, groq, openrouter, deepseek, ollama, …) onto one of these two transports
#: before building the config.
CaptionProviderKind = Literal["anthropic", "openai"]

#: Default hosts when the config leaves ``base_url`` unset.
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"
OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"

#: Anthropic requires a pinned API version header.
ANTHROPIC_VERSION = "2023-06-01"

#: How many frames of a shot to send at once. Three — first, middle, last — is what the
#: local pack reads, and the two arms must be handed the same evidence or their
#: descriptions are not comparable. Capped hard because more frames cost more tokens for
#: diminishing quality.
DEFAULT_MAX_FRAMES = 3

#: Response-token ceiling. The schema is small; a low cap keeps the call cheap and
#: discourages a model from padding free-text fields.
DEFAULT_MAX_TOKENS = 600

#: Per-request timeout (seconds). A VLM call over a few JPEGs is slow server-side; httpx's
#: 5 s default would flake.
DEFAULT_TIMEOUT_SECONDS = 60.0

#: Typed reason when no vision provider is configured (mirrors the honest-unavailable
#: reasons in :mod:`framepilot_engine.brain.visual_embed`).
NO_VISION_PROVIDER_REASON = "no_vision_provider"

#: The tool name the Anthropic arm forces. Structure on that wire format is a tool call:
#: the model must emit an object matching ``input_schema`` or emit nothing at all.
ANTHROPIC_TOOL_NAME = "record_shot_description"

# Some OpenAI-compatible vision endpoints return their moderation/status preamble as
# `message.content` instead of an answer (observed: "User Safety: safe"). It is a
# successful HTTP response but contains zero visual evidence, so persisting it poisons FTS
# and causes the orchestrator to claim the footage is undescribed. The structured path is
# far less prone to it, but LEGACY rows written by the deleted prose path are still in
# every existing brain, and every reader of `visual_captions.text` has to be able to tell
# one from a real summary. Keep the filter deliberately narrow: short factual summaries
# such as "Person outdoors" remain valid.
_STATUS_ONLY_CAPTION = re.compile(
    r"^(?:(?:user|assistant|system)\s+)?safety\s*:\s*(?:safe|unsafe|blocked)?[.!]?$",
    re.IGNORECASE,
)


def is_informative_caption(text: str) -> bool:
    """Whether stored caption text contains visual evidence rather than status metadata.

    Applied to ``visual_captions.text`` on the way OUT of the store, because that table
    still holds rows the deleted prose path wrote. A row that fails this is treated as
    missing, which is what makes describing an already-"captioned" asset resumable.
    """
    collapsed = " ".join(text.split())
    return bool(collapsed) and _STATUS_ONLY_CAPTION.fullmatch(collapsed) is None


_USER_TEXT = "Describe this shot."
_IMAGE_MEDIA_TYPE = "image/jpeg"
_DATA_URI_PREFIX = f"data:{_IMAGE_MEDIA_TYPE};base64,"


class DescribeError(Exception):
    """A description request failed (HTTP error, unreadable body, or unusable answer).

    Best-effort by contract: callers catch this and record the shot without a description
    rather than failing the whole index job.
    """


@dataclass(frozen=True)
class CaptionProviderConfig:
    """The vision provider the host resolved for describing shots (plan D6/D7).

    Passed in the ``/brain/visual/index`` request body — the engine never reads provider
    keys from disk. ``base_url`` overrides the per-``kind`` default (self-hosted
    NIM/ollama, a gateway, or a proxy).
    """

    kind: CaptionProviderKind
    model: str
    api_key: str
    base_url: str | None = None


@dataclass(frozen=True)
class DescriberResolution:
    """Outcome of the describer capability gate (honest-unavailable shape).

    Mirrors :class:`~framepilot_engine.brain.visual_embed.VisualEmbedderResolution`:
    exactly one of ``describer``/``reason`` is meaningful.
    """

    describer: SceneDescriber | None
    reason: str | None = None


def _to_base64(image_jpeg: bytes) -> str:
    """Base64-encode JPEG bytes (the raw payload both wire formats embed)."""
    return base64.b64encode(image_jpeg).decode("ascii")


class SceneDescriber:
    """Turns a shot's keyframes into one structured description (plan VU6.3).

    One instance is bound to one provider config and one HTTP client. Both wire formats
    funnel through :meth:`describe_scene`; the ``kind`` on the config selects the request
    builder and response parser, and both ask for the SAME schema so the two arms' rows
    are directly comparable.
    """

    def __init__(
        self,
        config: CaptionProviderConfig,
        *,
        http: httpx.Client,
        max_frames: int = DEFAULT_MAX_FRAMES,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        """
        :param config: The resolved vision provider (kind, model, key, base_url).
        :param http: The HTTP client — injected so tests mock the transport.
        :param max_frames: Max keyframes sent per shot.
        :param max_tokens: Response-token ceiling requested from the provider.
        :param timeout_seconds: Per-request timeout.
        :raises ValueError: On a non-positive bound.
        """
        if max_frames <= 0:
            raise ValueError(f"max_frames must be > 0, got {max_frames}.")
        if max_tokens <= 0:
            raise ValueError(f"max_tokens must be > 0, got {max_tokens}.")
        if timeout_seconds <= 0:
            raise ValueError(f"timeout_seconds must be > 0, got {timeout_seconds}.")
        self._config = config
        self._http = http
        self._max_frames = max_frames
        self._max_tokens = max_tokens
        self._timeout = timeout_seconds

    @property
    def model(self) -> str:
        """The producing model id, stored on every row this describer writes."""
        return self._config.model

    def describe_scene(self, frames_jpeg: Sequence[bytes]) -> DescribedFacts:
        """Describe one shot from its keyframe(s).

        :param frames_jpeg: One or more JPEG frames, already resolution-bounded upstream.
            Only the first :attr:`_max_frames` are sent.
        :returns: The structured description, normalised by
            :func:`~framepilot_engine.brain.described.parse_described`.
        :raises DescribeError: On empty input, an HTTP error, an unreadable response body,
            or an answer with no usable summary.
        """
        if not frames_jpeg:
            raise DescribeError("describe_scene requires at least one frame.")
        frames = list(frames_jpeg)[: self._max_frames]
        url, headers, payload = self._build_request(frames)
        response = self._http.post(url, json=payload, headers=headers, timeout=self._timeout)
        if response.status_code != 200:
            raise DescribeError(
                f"Description request to {self._config.kind} provider failed with "
                f"HTTP {response.status_code}: {response.text[:200]}"
            )
        try:
            facts = parse_described(self._parse(response.json()), model=self._config.model)
        except DescribedParseError as error:
            raise DescribeError(
                f"The vision provider's answer is not a shot description: {error}"
            ) from error
        if not is_informative_caption(facts.summary):
            raise DescribeError(
                "The vision provider returned status metadata, not a shot description."
            )
        _log.debug(
            "described shot: frames=%d chars=%d fields=%d",
            len(frames),
            len(facts.summary),
            sum(1 for value in (facts.subject, facts.action, facts.setting) if value),
        )
        return facts

    # -- request plumbing --------------------------------------------------------

    def _base_url(self) -> str:
        """The provider host, using the per-``kind`` default when unset."""
        default = (
            ANTHROPIC_DEFAULT_BASE_URL
            if self._config.kind == "anthropic"
            else OPENAI_DEFAULT_BASE_URL
        )
        return (self._config.base_url or default).rstrip("/")

    def _build_request(self, frames: list[bytes]) -> tuple[str, dict[str, str], dict[str, Any]]:
        """Build ``(url, headers, json_body)`` for the configured wire format."""
        if self._config.kind == "anthropic":
            return self._anthropic_request(frames)
        return self._openai_request(frames)

    def _anthropic_request(self, frames: list[bytes]) -> tuple[str, dict[str, str], dict[str, Any]]:
        """Anthropic Messages API: base64 image blocks plus a FORCED tool call.

        ``tool_choice`` names the tool, so the schema is not a request the model may
        decline — it is the only shape the response can take.
        """
        content: list[dict[str, Any]] = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": _IMAGE_MEDIA_TYPE,
                    "data": _to_base64(frame),
                },
            }
            for frame in frames
        ]
        content.append({"type": "text", "text": _USER_TEXT})
        payload: dict[str, Any] = {
            "model": self._config.model,
            "max_tokens": self._max_tokens,
            "system": DESCRIBE_INSTRUCTION,
            "tools": [
                {
                    "name": ANTHROPIC_TOOL_NAME,
                    "description": "Record the structured description of this one shot.",
                    "input_schema": DESCRIBED_JSON_SCHEMA,
                }
            ],
            "tool_choice": {"type": "tool", "name": ANTHROPIC_TOOL_NAME},
            "messages": [{"role": "user", "content": content}],
        }
        headers = {
            "x-api-key": self._config.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }
        return f"{self._base_url()}/v1/messages", headers, payload

    def _openai_request(self, frames: list[bytes]) -> tuple[str, dict[str, str], dict[str, Any]]:
        """OpenAI-compatible chat completions with a strict ``json_schema`` response format."""
        content: list[dict[str, Any]] = [{"type": "text", "text": _USER_TEXT}]
        content.extend(
            {"type": "image_url", "image_url": {"url": _DATA_URI_PREFIX + _to_base64(frame)}}
            for frame in frames
        )
        payload: dict[str, Any] = {
            "model": self._config.model,
            "max_tokens": self._max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": DESCRIBED_SCHEMA_NAME,
                    "strict": True,
                    "schema": DESCRIBED_JSON_SCHEMA,
                },
            },
            "messages": [
                {"role": "system", "content": DESCRIBE_INSTRUCTION},
                {"role": "user", "content": content},
            ],
        }
        headers = {
            "Authorization": f"Bearer {self._config.api_key}",
            "content-type": "application/json",
        }
        return f"{self._base_url()}/chat/completions", headers, payload

    def _parse(self, data: dict[str, Any]) -> dict[str, Any]:
        """Extract the description object from a response body, per wire format.

        :raises DescribeError: On a body whose shape does not match the format, or whose
            content is not the JSON object the schema asked for.
        """
        try:
            if self._config.kind == "anthropic":
                for block in data["content"]:
                    if block.get("type") == "tool_use" and block.get("name") == ANTHROPIC_TOOL_NAME:
                        payload = block.get("input")
                        if not isinstance(payload, dict):
                            raise DescribeError("Anthropic tool call carried no input object.")
                        return payload
                raise DescribeError(
                    "Anthropic response contained no description tool call; the model "
                    "answered in prose, which this schema does not accept."
                )
            message = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise DescribeError(
                f"Could not read a description from the {self._config.kind} response body."
            ) from error
        if not isinstance(message, str):
            raise DescribeError("OpenAI-format description response had non-text content.")
        try:
            payload = json.loads(message)
        except ValueError as error:
            raise DescribeError(
                "The vision provider did not return JSON despite a json_schema request."
            ) from error
        if not isinstance(payload, dict):
            raise DescribeError("The vision provider returned JSON that is not an object.")
        return payload


#: One HTTP client per process for describing, created on first use. See the identical
#: note in `visual_embed._default_http`.
_shared_http: httpx.Client | None = None
_shared_http_lock = threading.Lock()


def _default_http() -> httpx.Client:
    """The process-wide description HTTP client, created on first use."""
    global _shared_http
    with _shared_http_lock:
        if _shared_http is None:
            _shared_http = httpx.Client()
        return _shared_http


def resolve_describer(
    config: CaptionProviderConfig | None, *, http: httpx.Client | None = None
) -> DescriberResolution:
    """The hosted-describer capability gate (plan VU6.3, honest-unavailable).

    No configured vision provider is a valid state (tier 2 is optional enrichment, and the
    local pack is the other producer): it resolves to ``reason="no_vision_provider"``
    instead of fabricating descriptions, mirroring
    :func:`~framepilot_engine.brain.visual_embed.resolve_visual_embedder`. ``http`` exists
    so tests inject a mocked client; the default is a real one.
    """
    if config is None:
        return DescriberResolution(describer=None, reason=NO_VISION_PROVIDER_REASON)
    # Shared, like the embedder's: a client per resolution was a client per index slice,
    # never closed, and now multiplied by the concurrency limit.
    client = http if http is not None else _default_http()
    return DescriberResolution(describer=SceneDescriber(config, http=client))
