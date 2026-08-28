"""Tests for engine configuration defaults and env parsing."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from framepilot_engine.config import AIProvider, Settings

# tests → python → engine → repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TS_PROVIDER_TYPES = _REPO_ROOT / "packages" / "ai-sdk" / "src" / "providers" / "types.ts"


def test_defaults_use_mock_provider() -> None:
    settings = Settings.from_env({})
    assert settings.ai_provider == AIProvider.MOCK
    assert settings.python_api_host == "127.0.0.1"
    assert settings.python_api_port == 8765
    assert settings.render_timeout_seconds == 900
    assert settings.asset_media_timeout_seconds == 60
    assert settings.ai_max_tokens == 8192
    assert settings.cors_allowed_origins == ["http://localhost:5173", "null"]


def test_cors_origins_env_override_is_comma_split() -> None:
    settings = Settings.from_env(
        {"FRAMEPILOT_CORS_ORIGINS": "https://a.example, https://b.example"}
    )
    assert settings.cors_allowed_origins == ["https://a.example", "https://b.example"]


def test_empty_string_env_falls_back_to_default() -> None:
    settings = Settings.from_env({"ANTHROPIC_MODEL": "  "})
    assert settings.anthropic_model == "claude-opus-4-8"


def test_env_overrides_are_applied() -> None:
    settings = Settings.from_env(
        {
            "FRAMEPILOT_AI_PROVIDER": "anthropic",
            "FRAMEPILOT_PYTHON_API_PORT": "9000",
            "ANTHROPIC_API_KEY": "sk-test",
        }
    )
    assert settings.ai_provider == AIProvider.ANTHROPIC
    assert settings.python_api_port == 9000
    assert settings.anthropic_api_key == "sk-test"


def test_ai_provider_roster_matches_the_ts_sdk() -> None:
    """The engine's roster must mirror `PROVIDER_NAMES` in the TS SDK.

    Drift here used to be silent until runtime: the enum was missing the
    providers added to TS over time, so `FRAMEPILOT_AI_PROVIDER=deepseek` raised
    ValueError inside `serve()` and killed the sidecar at boot.
    """
    source = _TS_PROVIDER_TYPES.read_text(encoding="utf-8")
    match = re.search(r"export const PROVIDER_NAMES = \[(.*?)\] as const;", source, re.DOTALL)
    assert match is not None, "PROVIDER_NAMES not found in the TS SDK source"
    # Drop `//` comments before reading the quoted entries: prose explaining an entry
    # contains apostrophes ("OpenAI's contract"), and the quote scanner would otherwise
    # read the text between two of them as a provider name and fail a roster that is
    # in fact identical.
    entries = re.sub(r"//[^\n]*", "", match.group(1))
    ts_names = set(re.findall(r"'([^']+)'", entries))
    assert ts_names == {provider.value for provider in AIProvider}


@pytest.mark.parametrize("name", [provider.value for provider in AIProvider])
def test_every_provider_in_the_roster_parses_from_env(name: str) -> None:
    assert Settings.from_env({"FRAMEPILOT_AI_PROVIDER": name}).ai_provider == AIProvider(name)


def test_unknown_provider_falls_back_instead_of_crashing_the_sidecar() -> None:
    # A host newer than this engine build may select a provider it has never
    # heard of. Nothing here reads `ai_provider`, so booting must still succeed.
    settings = Settings.from_env({"FRAMEPILOT_AI_PROVIDER": "provider-from-the-future"})
    assert settings.ai_provider == AIProvider.MOCK


def test_nvidia_embeddings_keys_default_to_unset() -> None:
    assert Settings.from_env({}).nvidia_embeddings_keys is None


def test_nvidia_embeddings_keys_env_override() -> None:
    settings = Settings.from_env({"FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS": "nvapi-1,nvapi-2"})
    assert settings.nvidia_embeddings_keys == "nvapi-1,nvapi-2"


def test_nvidia_embeddings_keys_empty_string_treated_as_unset() -> None:
    settings = Settings.from_env({"FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS": "  "})
    assert settings.nvidia_embeddings_keys is None


def test_asset_media_timeout_env_override() -> None:
    settings = Settings.from_env({"FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS": "30"})
    assert settings.asset_media_timeout_seconds == 30


def test_asset_media_concurrency_env_override() -> None:
    settings = Settings.from_env({"FRAMEPILOT_ASSET_MEDIA_CONCURRENCY": "1"})
    assert settings.asset_media_concurrency == 1


def test_asset_media_concurrency_defaults_to_a_bound_not_to_unbounded() -> None:
    # The defect this default exists for: the route had NO bound, so its concurrency was
    # whatever the arrival rate happened to be. An empty value must fall back to the
    # bound, never to "no gate".
    assert Settings.from_env({}).asset_media_concurrency == 2
    blank = Settings.from_env({"FRAMEPILOT_ASSET_MEDIA_CONCURRENCY": ""})
    assert blank.asset_media_concurrency == 2


def test_soul_root_defaults_to_unset_so_the_home_default_applies() -> None:
    # Unset means "use ~/.framepilot/soul" (resolved at call time), not "no soul".
    assert Settings.from_env({}).soul_root is None


def test_soul_root_env_override(tmp_path: Path) -> None:
    settings = Settings.from_env({"FRAMEPILOT_SOUL_ROOT": str(tmp_path / "soul")})
    assert settings.soul_root == tmp_path / "soul"


def test_path_envs_expand_tilde_to_home() -> None:
    # A `.env` line like FRAMEPILOT_SOUL_ROOT=~/.framepilot arrives with a literal
    # `~`; without expansion it would be a relative path under the sidecar's cwd.
    settings = Settings.from_env(
        {
            "FRAMEPILOT_SOUL_ROOT": "~/.framepilot",
            "FRAMEPILOT_PROJECTS_ROOT": "~/FramePilot Projects",
            "FRAMEPILOT_EMBEDDINGS_MODEL_DIR": "~/models",
        }
    )
    home = Path.home()
    assert settings.soul_root == home / ".framepilot"
    assert settings.projects_root == home / "FramePilot Projects"
    assert settings.embeddings_model_dir == home / "models"
    assert settings.soul_root is not None and settings.soul_root.is_absolute()
