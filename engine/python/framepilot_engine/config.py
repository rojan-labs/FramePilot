"""Runtime configuration for the FramePilot engine.

WHY: every tunable (AI provider, API keys, sidecar host/port, sandbox root,
render timeout) is read from the environment so the same code runs identically
on a dev machine, in CI, and inside the packaged desktop app. Env var names
mirror ``.env.example`` exactly so the desktop shell and the Python engine share
one source of truth.

This is a plain ``pydantic.BaseModel`` populated from ``os.environ`` rather than
pydantic-settings, to avoid an extra dependency for such a small surface. The
default provider is ``mock`` (deterministic, offline) so tests and first-run
never require secrets — see ``.env.example``.
"""

from __future__ import annotations

import logging
import os
from enum import StrEnum
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field

# Defaults kept in one place so they are searchable and match .env.example.
DEFAULT_AI_PROVIDER = "mock"
DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"
DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"
DEFAULT_NVIDIA_MODEL = "meta/llama-3.1-70b-instruct"
DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_API_HOST = "127.0.0.1"
DEFAULT_API_PORT = 8765
# CORS origins the sidecar accepts fetch() from: the Vite dev server (renderer
# in dev) and Electron's packaged-app renderer, which sends the literal string
# "null" as its Origin header when loaded from file://. Without this, a
# same-process browser fetch from the renderer to this sidecar (e.g. the
# Settings dialog's ASR setup call) fails its CORS preflight with 405, since
# Starlette has no route registered for OPTIONS.
DEFAULT_CORS_ORIGINS = ("http://localhost:5173", "null")
DEFAULT_RENDER_TIMEOUT_SECONDS = 900
# Asset-media derivation (probe + waveform + thumbnails on import) is far cheaper
# than a full render, so it gets a much tighter default bound. WHY: a crafted or
# looping input (e.g. an animated GIF/APNG with an enormous loop count, or a file
# ffmpeg decodes pathologically slowly) must not be able to hang the import path.
# Mirrors FRAMEPILOT_RENDER_TIMEOUT_SECONDS but scoped to the /asset-media route.
DEFAULT_ASSET_MEDIA_TIMEOUT_SECONDS = 60
# How many /asset-media derivations may run at once, process-wide. One call is an
# ffprobe, a FULL waveform decode, five thumbnail extractions and (for video) a proxy
# transcode of the ORIGINAL source — a 4K camera file or stock rendition. Routes run in
# Starlette's 40-slot threadpool, so ungated the only bound is how fast callers arrive:
# the desktop agent warms four sourcing downloads at a time and a human can drop in
# dozens of files at once, and each one then holds a threadpool slot AND an ffmpeg
# process against the same cores and the same memory. Two keeps one derivation's ffmpeg
# (itself multi-threaded) saturating the machine while the next is already queued, which
# is where the throughput is, without N simultaneous 4K decode buffers. 1 restores
# strictly-serial derivation. Same reasoning as the /review/temporal-evidence gate; that
# one is 1 because its unit of work is a whole compiled timeline rather than one file.
DEFAULT_ASSET_MEDIA_CONCURRENCY = 2
# How many assets one /brain/visual/index slice prepares at once (plan
# media-intelligence-closure phase 3). Preparation was strictly serial and ~98% of its
# measured wall clock was network wait: 60 photos cost 92.7s against ~1.5s of local CPU.
# Four keeps the sockets and the SQLite write contention modest while removing most of
# that wait; 1 restores the old strictly-serial behaviour exactly.
DEFAULT_VISUAL_INDEX_CONCURRENCY = 4
# Preview-proxy derivation (H3): transcodes are far slower than probes, so they
# get their own budget; sources longer than the cap are skipped synchronously
# (a background proxy queue is the follow-up for feature-length footage).
DEFAULT_PROXY_TIMEOUT_SECONDS = 300
DEFAULT_PROXY_MAX_DURATION_SECONDS = 900
DEFAULT_AI_MAX_TOKENS = 8192
DEFAULT_LOG_LEVEL = "info"


class AIProvider(StrEnum):
    """Supported AI orchestration providers.

    ``MOCK`` returns deterministic canned patches for tests/offline dev; it is
    the default so the engine never requires secrets to boot.

    This roster MIRRORS ``PROVIDER_NAMES`` in
    ``packages/ai-sdk/src/providers/types.ts`` — the TS SDK owns AI orchestration,
    the engine only records which provider the host selected. Keep the two in
    sync; ``test_config.py`` asserts it against the TS source so they cannot
    silently drift again.
    """

    ANTHROPIC = "anthropic"
    CLAUDE_AGENT_SDK = "claude-agent-sdk"
    NVIDIA = "nvidia"
    OPENROUTER = "openrouter"
    VERCEL_GATEWAY = "vercel-gateway"
    GROQ = "groq"
    GOOGLE = "google"
    OLLAMA = "ollama"
    DEEPSEEK = "deepseek"
    OPENAI_COMPATIBLE = "openai-compatible"
    MOCK = "mock"


def _coerce_ai_provider(raw: str | None) -> AIProvider:
    """Parse ``FRAMEPILOT_AI_PROVIDER``, degrading to the default when unknown.

    WHY not just ``AIProvider(raw)``: the desktop shell owns this setting and
    ships on its own cadence, so a host offering a provider newer than this
    engine build is normal and expected. Nothing in the engine reads
    ``ai_provider`` — the TS SDK does all model calls — so an unrecognised name
    must never take the sidecar down at boot (it previously raised ``ValueError``
    inside ``serve()``, killing the process before it bound a port).

    :param raw: The env value, already stripped/emptied to ``None``.
    :returns: The matching provider, or the default when absent/unrecognised.
    """
    if raw is None:
        return AIProvider(DEFAULT_AI_PROVIDER)
    try:
        return AIProvider(raw)
    except ValueError:
        logging.getLogger(__name__).warning(
            "unknown FRAMEPILOT_AI_PROVIDER %r; falling back to %r",
            raw,
            DEFAULT_AI_PROVIDER,
        )
        return AIProvider(DEFAULT_AI_PROVIDER)


class Settings(BaseModel):
    """Engine settings, normally constructed from the environment.

    Prefer :func:`get_settings` over instantiating directly so the result is
    cached for the process lifetime.
    """

    ai_provider: AIProvider = AIProvider.MOCK

    # Anthropic (Claude)
    anthropic_api_key: str | None = None
    anthropic_model: str = DEFAULT_ANTHROPIC_MODEL
    anthropic_base_url: str = DEFAULT_ANTHROPIC_BASE_URL

    # NVIDIA NIM (OpenAI-compatible endpoint)
    nvidia_api_key: str | None = None
    nvidia_model: str = DEFAULT_NVIDIA_MODEL
    nvidia_base_url: str = DEFAULT_NVIDIA_BASE_URL

    # NVIDIA visual-embeddings key(s), comma-separated (media intelligence, plan
    # MEDIA-INTELLIGENCE D5). A separate slot from ``nvidia_api_key`` (chat):
    # different product, different rotation semantics. Env fallback only — the
    # host normally sends the keys in each ``/brain/visual/*`` request payload.
    # NEVER log or echo this value.
    nvidia_embeddings_keys: str | None = None

    # TwelveLabs media-understanding key (optional backend). When set, the
    # ``/brain/visual/*`` routes delegate video/image/audio understanding to
    # TwelveLabs' hosted Marengo index instead of the built-in NVIDIA-embed +
    # sqlite-vec pipeline; unset (the shipped default) keeps the built-in one.
    # Env fallback only — the host normally sends the key in the request payload.
    # NEVER log or echo this value.
    twelvelabs_api_key: str | None = None

    # Python sidecar service
    python_api_host: str = DEFAULT_API_HOST
    python_api_port: int = DEFAULT_API_PORT
    cors_allowed_origins: list[str] = Field(default_factory=lambda: list(DEFAULT_CORS_ORIGINS))

    # Runtime / safety
    projects_root: Path | None = None
    # Embeddings backend (plan B3.1): directory holding model.onnx + tokenizer.json.
    # Unset (the shipped default) → similarity search honestly degrades to FTS.
    embeddings_model_dir: Path | None = None
    # Cross-project memory root (plan B6.2). Unset → ~/.framepilot/soul. Overriding
    # it keeps tests (and a sandboxed/portable install) off the real home dir.
    soul_root: Path | None = None
    render_timeout_seconds: int = Field(default=DEFAULT_RENDER_TIMEOUT_SECONDS, gt=0)
    asset_media_timeout_seconds: int = Field(default=DEFAULT_ASSET_MEDIA_TIMEOUT_SECONDS, gt=0)
    asset_media_concurrency: int = Field(default=DEFAULT_ASSET_MEDIA_CONCURRENCY, gt=0)
    visual_index_concurrency: int = Field(default=DEFAULT_VISUAL_INDEX_CONCURRENCY, gt=0)
    proxy_timeout_seconds: int = Field(default=DEFAULT_PROXY_TIMEOUT_SECONDS, gt=0)
    proxy_max_duration_seconds: int = Field(default=DEFAULT_PROXY_MAX_DURATION_SECONDS, gt=0)
    ai_max_tokens: int = Field(default=DEFAULT_AI_MAX_TOKENS, gt=0)
    log_level: str = DEFAULT_LOG_LEVEL

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> Settings:
        """Build :class:`Settings` from ``FRAMEPILOT_*`` environment variables.

        Empty strings are treated as "unset" so a blank key in ``.env`` falls
        back to the default rather than overriding it with ``""``.

        :param environ: Mapping to read from; defaults to ``os.environ``.
        :returns: A populated :class:`Settings` instance.
        """
        env = environ if environ is not None else dict(os.environ)

        def value(name: str) -> str | None:
            raw = env.get(name)
            if raw is None:
                return None
            stripped = raw.strip()
            return stripped or None

        projects_root_raw = value("FRAMEPILOT_PROJECTS_ROOT")
        embeddings_model_dir_raw = value("FRAMEPILOT_EMBEDDINGS_MODEL_DIR")
        soul_root_raw = value("FRAMEPILOT_SOUL_ROOT")
        cors_origins_raw = value("FRAMEPILOT_CORS_ORIGINS")

        def path_value(raw: str | None) -> Path | None:
            # `~` in a .env value arrives literally (no shell expands it), and a bare
            # `Path("~/x")` is a RELATIVE path — it would silently resolve against the
            # sidecar's cwd and the user's data would land in `<cwd>/~/x`. Expand it
            # here so `FRAMEPILOT_SOUL_ROOT=~/.framepilot` means the home directory.
            return Path(raw).expanduser() if raw else None

        return cls(
            ai_provider=_coerce_ai_provider(value("FRAMEPILOT_AI_PROVIDER")),
            anthropic_api_key=value("ANTHROPIC_API_KEY"),
            anthropic_model=value("ANTHROPIC_MODEL") or DEFAULT_ANTHROPIC_MODEL,
            anthropic_base_url=value("ANTHROPIC_BASE_URL") or DEFAULT_ANTHROPIC_BASE_URL,
            nvidia_api_key=value("NVIDIA_API_KEY"),
            nvidia_model=value("NVIDIA_MODEL") or DEFAULT_NVIDIA_MODEL,
            nvidia_base_url=value("NVIDIA_BASE_URL") or DEFAULT_NVIDIA_BASE_URL,
            nvidia_embeddings_keys=value("FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS"),
            twelvelabs_api_key=value("TWELVELABS_API_KEY"),
            python_api_host=value("FRAMEPILOT_PYTHON_API_HOST") or DEFAULT_API_HOST,
            python_api_port=int(value("FRAMEPILOT_PYTHON_API_PORT") or DEFAULT_API_PORT),
            cors_allowed_origins=(
                [origin.strip() for origin in cors_origins_raw.split(",")]
                if cors_origins_raw
                else list(DEFAULT_CORS_ORIGINS)
            ),
            projects_root=path_value(projects_root_raw),
            embeddings_model_dir=path_value(embeddings_model_dir_raw),
            soul_root=path_value(soul_root_raw),
            render_timeout_seconds=int(
                value("FRAMEPILOT_RENDER_TIMEOUT_SECONDS") or DEFAULT_RENDER_TIMEOUT_SECONDS
            ),
            asset_media_timeout_seconds=int(
                value("FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS")
                or DEFAULT_ASSET_MEDIA_TIMEOUT_SECONDS
            ),
            asset_media_concurrency=int(
                value("FRAMEPILOT_ASSET_MEDIA_CONCURRENCY") or DEFAULT_ASSET_MEDIA_CONCURRENCY
            ),
            visual_index_concurrency=int(
                value("FRAMEPILOT_VISUAL_INDEX_CONCURRENCY") or DEFAULT_VISUAL_INDEX_CONCURRENCY
            ),
            proxy_timeout_seconds=int(
                value("FRAMEPILOT_PROXY_TIMEOUT_SECONDS") or DEFAULT_PROXY_TIMEOUT_SECONDS
            ),
            proxy_max_duration_seconds=int(
                value("FRAMEPILOT_PROXY_MAX_DURATION_SECONDS") or DEFAULT_PROXY_MAX_DURATION_SECONDS
            ),
            ai_max_tokens=int(value("FRAMEPILOT_AI_MAX_TOKENS") or DEFAULT_AI_MAX_TOKENS),
            log_level=value("LOG_LEVEL") or DEFAULT_LOG_LEVEL,
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return process-wide cached settings built from the environment.

    :returns: The cached :class:`Settings` instance.
    """
    return Settings.from_env()
