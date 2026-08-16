"""Per-scene VLM captioner (plan MI3.1, §3.3).

WHY: vector recall alone only *ranks* frames — it cannot tell the orchestrator
what a scene actually shows. Each scene therefore gets a short, factual
natural-language caption from the user's configured vision-capable provider.
Those captions are then FTS-indexed and text-embedded (MI3.2), so a retrieval
hit resolves into **text the LLM can read and reason over**, unified with the
transcript recall space (plan D1).

Architecture (the locked MI3 decision):

- Captions run **engine-side** (decision D6: the sidecar is the single writer of
  the brain). The TS provider registry has no multimodal support and does not
  cross the process boundary, so this module does **not** reuse it. Instead the
  host resolves the vision provider + key and passes a typed
  :class:`CaptionProviderConfig` in the ``/brain/visual/index`` request body
  (the same host→sidecar channel MI0.1 established for the NVIDIA keys), and
  this module speaks the provider's HTTP API directly via ``httpx``.
- Two wire formats cover the whole configured provider set (D7 — "reuse the
  configured vision-capable provider", read as *same provider set, engine-side
  transport*):

  * ``kind="anthropic"`` → the Anthropic Messages API (``/v1/messages``,
    ``x-api-key`` + ``anthropic-version`` headers, base64 image content blocks).
  * ``kind="openai"`` → OpenAI-compatible chat completions
    (``/chat/completions``, ``Authorization: Bearer``, ``image_url`` data-URI
    content parts) — covers OpenAI, NVIDIA VLM NIM, Google (openai-compat),
    groq, openrouter, deepseek, and ollama.

Design rules mirror :mod:`framepilot_engine.brain.visual_embed`:

- **Injected transport.** The ``httpx.Client`` is a constructor parameter so
  every branch is testable with respx; no test tier ever calls a live API
  (plan §6).
- **Best-effort, no key rotation.** A caption is evidence, not truth: an HTTP
  failure raises a typed :class:`CaptionError` and the index job records the
  scene *without* a caption. Captions never rotate keys or fail a job.
- **Secrets and pixels stay out of logs.** Only frame counts and HTTP status
  codes are logged — never key material, image bytes, or data URIs.
"""

from __future__ import annotations

import base64
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

import httpx

_log = logging.getLogger(__name__)

__all__ = [
    "ANTHROPIC_VERSION",
    "CAPTION_INSTRUCTION",
    "DEFAULT_MAX_CAPTION_CHARS",
    "DEFAULT_MAX_FRAMES",
    "NO_VISION_PROVIDER_REASON",
    "CaptionError",
    "CaptionProviderConfig",
    "CaptionProviderKind",
    "CaptionerResolution",
    "SceneCaptioner",
    "is_informative_caption",
    "resolve_captioner",
]

#: The two request wire formats. The host maps its provider *name* (anthropic,
#: openai, nvidia, google, groq, openrouter, deepseek, ollama, …) onto one of
#: these two transports before building the config.
CaptionProviderKind = Literal["anthropic", "openai"]

#: Default hosts when the config leaves ``base_url`` unset.
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"
OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"

#: Anthropic requires a pinned API version header.
ANTHROPIC_VERSION = "2023-06-01"

#: How many frames of a long scene to send at once. A single keyframe usually
#: suffices; a short strip helps a scene with motion. Capped hard because more
#: frames cost more tokens for diminishing caption quality.
DEFAULT_MAX_FRAMES = 4

#: Response-token ceiling. Two factual sentences are short; a low cap keeps the
#: call cheap and discourages the model from narrating.
DEFAULT_MAX_TOKENS = 300

#: Captions are stored and FTS-indexed; a runaway response must not bloat the
#: brain. Hard-truncated after whitespace collapse.
DEFAULT_MAX_CAPTION_CHARS = 400

#: Per-request timeout (seconds). A VLM call over a few JPEGs is slow
#: server-side; httpx's 5 s default would flake.
DEFAULT_TIMEOUT_SECONDS = 60.0

#: Typed reason when no vision provider is configured (mirrors the
#: honest-unavailable reasons in :mod:`framepilot_engine.brain.visual_embed`
#: and :mod:`framepilot_engine.brain.embeddings`).
NO_VISION_PROVIDER_REASON = "no_vision_provider"

#: The caption prompt. Kept deliberately terse and factual: a caption is
#: FTS-searchable *evidence the orchestrator reads*, not prose for a human — so
#: it must state only what is visibly on screen, never guess intent or narrate.
#: Changing this wording changes what the whole visual-recall surface can find.
CAPTION_INSTRUCTION = (
    "Describe what is visible on screen in ≤2 sentences. State only what you "
    "can see — objects, people, text, setting, action. No speculation, no "
    "narration."
)

# Some OpenAI-compatible vision endpoints return their moderation/status preamble as
# `message.content` instead of a caption (observed: "User Safety: safe"). It is a
# successful HTTP response but contains zero visual evidence, so persisting it poisons
# FTS and causes the orchestrator to claim the footage is undescribed. Keep the filter
# deliberately narrow: factual short captions such as "Person outdoors" remain valid.
_STATUS_ONLY_CAPTION = re.compile(
    r"^(?:(?:user|assistant|system)\s+)?safety\s*:\s*(?:safe|unsafe|blocked)?[.!]?$",
    re.IGNORECASE,
)


def is_informative_caption(text: str) -> bool:
    """Whether provider text contains visual evidence rather than status metadata."""
    collapsed = " ".join(text.split())
    return bool(collapsed) and _STATUS_ONLY_CAPTION.fullmatch(collapsed) is None

_USER_TEXT = "Caption this scene."
_IMAGE_MEDIA_TYPE = "image/jpeg"
_DATA_URI_PREFIX = f"data:{_IMAGE_MEDIA_TYPE};base64,"


class CaptionError(Exception):
    """A caption request failed (HTTP error or unreadable response body).

    Best-effort by contract: callers catch this and record the scene without a
    caption rather than failing the whole index job (plan §3.3).
    """


@dataclass(frozen=True)
class CaptionProviderConfig:
    """The vision provider the host resolved for captioning (plan D6/D7).

    Passed in the ``/brain/visual/index`` request body — the engine never reads
    provider keys from disk. ``base_url`` overrides the per-``kind`` default
    (self-hosted NIM/ollama, a gateway, or a proxy).
    """

    kind: CaptionProviderKind
    model: str
    api_key: str
    base_url: str | None = None


@dataclass(frozen=True)
class CaptionerResolution:
    """Outcome of the captioner capability gate (honest-unavailable shape).

    Mirrors :class:`~framepilot_engine.brain.visual_embed.VisualEmbedderResolution`:
    exactly one of ``captioner``/``reason`` is meaningful.
    """

    captioner: SceneCaptioner | None
    reason: str | None = None


def _to_base64(image_jpeg: bytes) -> str:
    """Base64-encode JPEG bytes (the raw payload both wire formats embed)."""
    return base64.b64encode(image_jpeg).decode("ascii")


class SceneCaptioner:
    """Turns a scene's keyframe(s) into one short factual caption (plan §3.3).

    One instance is bound to one provider config and one HTTP client. Both wire
    formats funnel through :meth:`caption_scene`; the ``kind`` on the config
    selects the request builder and response parser.
    """

    def __init__(
        self,
        config: CaptionProviderConfig,
        *,
        http: httpx.Client,
        max_frames: int = DEFAULT_MAX_FRAMES,
        max_caption_chars: int = DEFAULT_MAX_CAPTION_CHARS,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        """
        :param config: The resolved vision provider (kind, model, key, base_url).
        :param http: The HTTP client — injected so tests mock the transport.
        :param max_frames: Max keyframes sent per scene (a long scene's strip is
            truncated to this).
        :param max_caption_chars: Hard cap on the returned caption length.
        :param max_tokens: Response-token ceiling requested from the provider.
        :param timeout_seconds: Per-request timeout.
        :raises ValueError: On a non-positive bound.
        """
        if max_frames <= 0:
            raise ValueError(f"max_frames must be > 0, got {max_frames}.")
        if max_caption_chars <= 0:
            raise ValueError(f"max_caption_chars must be > 0, got {max_caption_chars}.")
        if max_tokens <= 0:
            raise ValueError(f"max_tokens must be > 0, got {max_tokens}.")
        if timeout_seconds <= 0:
            raise ValueError(f"timeout_seconds must be > 0, got {timeout_seconds}.")
        self._config = config
        self._http = http
        self._max_frames = max_frames
        self._max_caption_chars = max_caption_chars
        self._max_tokens = max_tokens
        self._timeout = timeout_seconds

    def caption_scene(self, frames_jpeg: Sequence[bytes]) -> str:
        """Caption one scene from its keyframe(s).

        :param frames_jpeg: One or more JPEG frames, already resolution-bounded
            upstream (the sampler/extraction step, MI1.2/MI4). Only the first
            :attr:`_max_frames` are sent.
        :returns: The caption, whitespace-collapsed and length-capped.
        :raises CaptionError: On an empty input, an HTTP error, an unreadable
            response body, or an empty caption.
        """
        if not frames_jpeg:
            raise CaptionError("caption_scene requires at least one frame.")
        frames = list(frames_jpeg)[: self._max_frames]
        url, headers, payload = self._build_request(frames)
        response = self._http.post(url, json=payload, headers=headers, timeout=self._timeout)
        if response.status_code != 200:
            raise CaptionError(
                f"Caption request to {self._config.kind} provider failed with "
                f"HTTP {response.status_code}: {response.text[:200]}"
            )
        caption = self._clean(self._parse(response.json()))
        if not caption:
            raise CaptionError("The vision provider returned an empty caption.")
        if not is_informative_caption(caption):
            raise CaptionError(
                "The vision provider returned status metadata, not a visual caption."
            )
        _log.debug("captioned scene: frames=%d chars=%d", len(frames), len(caption))
        return caption

    # -- request plumbing --------------------------------------------------------

    def _base_url(self) -> str:
        """The provider host, using the per-``kind`` default when unset."""
        default = (
            ANTHROPIC_DEFAULT_BASE_URL
            if self._config.kind == "anthropic"
            else OPENAI_DEFAULT_BASE_URL
        )
        return (self._config.base_url or default).rstrip("/")

    def _build_request(
        self, frames: list[bytes]
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        """Build ``(url, headers, json_body)`` for the configured wire format."""
        if self._config.kind == "anthropic":
            return self._anthropic_request(frames)
        return self._openai_request(frames)

    def _anthropic_request(
        self, frames: list[bytes]
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        """Anthropic Messages API: base64 image blocks + a system instruction."""
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
            "system": CAPTION_INSTRUCTION,
            "messages": [{"role": "user", "content": content}],
        }
        headers = {
            "x-api-key": self._config.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }
        return f"{self._base_url()}/v1/messages", headers, payload

    def _openai_request(
        self, frames: list[bytes]
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        """OpenAI-compatible chat completions: image_url data-URI content parts."""
        content: list[dict[str, Any]] = [{"type": "text", "text": _USER_TEXT}]
        content.extend(
            {"type": "image_url", "image_url": {"url": _DATA_URI_PREFIX + _to_base64(frame)}}
            for frame in frames
        )
        payload: dict[str, Any] = {
            "model": self._config.model,
            "max_tokens": self._max_tokens,
            "messages": [
                {"role": "system", "content": CAPTION_INSTRUCTION},
                {"role": "user", "content": content},
            ],
        }
        headers = {
            "Authorization": f"Bearer {self._config.api_key}",
            "content-type": "application/json",
        }
        return f"{self._base_url()}/chat/completions", headers, payload

    def _parse(self, data: dict[str, Any]) -> str:
        """Extract the caption text from a response body, per wire format.

        :raises CaptionError: On a body whose shape does not match the format.
        """
        try:
            if self._config.kind == "anthropic":
                blocks = data["content"]
                return "".join(b["text"] for b in blocks if b.get("type") == "text")
            message = data["choices"][0]["message"]["content"]
            if not isinstance(message, str):
                raise CaptionError("OpenAI-format caption response had non-text content.")
            return message
        except (KeyError, IndexError, TypeError) as exc:
            raise CaptionError(
                f"Could not read a caption from the {self._config.kind} response body."
            ) from exc

    def _clean(self, text: str) -> str:
        """Collapse whitespace and hard-cap the length (plan §3.3)."""
        collapsed = " ".join(text.split())
        if len(collapsed) > self._max_caption_chars:
            return collapsed[: self._max_caption_chars].rstrip()
        return collapsed


def resolve_captioner(
    config: CaptionProviderConfig | None, *, http: httpx.Client | None = None
) -> CaptionerResolution:
    """The captioner capability gate (plan §3.3, honest-unavailable).

    No configured vision provider is a valid state (captions are optional
    enrichment): it resolves to ``reason="no_vision_provider"`` instead of
    fabricating captions, mirroring
    :func:`~framepilot_engine.brain.visual_embed.resolve_visual_embedder`.
    ``http`` exists so tests inject a mocked client; the default is a real one.
    """
    if config is None:
        return CaptionerResolution(captioner=None, reason=NO_VISION_PROVIDER_REASON)
    client = http if http is not None else httpx.Client()
    return CaptionerResolution(captioner=SceneCaptioner(config, http=client))
