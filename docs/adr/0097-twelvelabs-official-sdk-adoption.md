# ADR 0097 — Adopt the official TwelveLabs SDK (facade), accepting its unlicensed status

- **Status:** accepted (2026-07-21)
- **Plan:** `plan/MEDIA-INTELLIGENCE.md`, `plan/AI-FOOTAGE-INTELLIGENCE-E2E.md`
- **Relates to:** [ADR 0070](./0070-twelvelabs-optional-understanding-backend.md)
  (TwelveLabs as an optional backend), [ADR 0067](./0067-plaintext-key-storage-multi-key-failover.md)
  (plaintext key storage)
- **Packages:** `engine/python/framepilot_engine/brain/twelvelabs.py`,
  `engine/python/pyproject.toml`, `engine/python/framepilot-engine.spec`

## Context

The TwelveLabs backend (ADR 0070) talked to `api.twelvelabs.io/v1.3` through a
**hand-rolled `httpx` REST client**. Over a few weeks that client broke three times
from silent API drift, each time surfacing to users as a dead footage map:

1. `/summarize` and `/gist` were **sunset** (HTTP 410 `endpoint_deprecated`).
2. `/analyze` (generate) requires a **Pegasus model on the index**; a Marengo-only
   index answers HTTP 400 `index_not_supported_for_generate`.
3. `/search` dropped the numeric `score` for `rank`, and index create started
   returning `id` instead of `_id`.

Each was a manual decode assumption that the raw client had no way to track. TwelveLabs
publishes a **generated Python SDK** (`twelvelabs`, Fern-generated) that follows the
live v1.3 spec, with typed request/response models and a typed error hierarchy.

**The catch:** the `twelvelabs` package ships with **no declared license** — none on
PyPI (no classifier, `license: None`), and no `LICENSE` file in the GitHub repo. Under
default copyright that is *all rights reserved*, and FramePilot redistributes the engine
inside the desktop app (PyInstaller). Every other engine dependency has its license noted
inline precisely because redistribution matters.

## Decision

**Adopt the SDK as a thin, typed facade, and accept the unlicensed status as a known,
documented risk** (explicit maintainer decision, 2026-07-21).

- `brain/twelvelabs.py` keeps its **entire public surface** — `TwelveLabsClient`, the
  `TL*` dataclasses, the `TwelveLabsError` hierarchy, `resolve_twelvelabs` — and now
  delegates internally to `twelvelabs.TwelveLabs`. `service.py`, `twelvelabs_index.py`,
  and the sidecar routes are unchanged.
- The SDK is built over a **caller-supplied `httpx.Client`**, so the existing `respx`
  wire-level tests still intercept every call offline (no live API in any test tier).
- SDK `ApiError`/transport failures are **translated** back into FramePilot's typed
  errors, preserving the honest-degradation contract (401/403 → auth; generative
  402/403 → no Pegasus entitlement; 400 `index_not_supported_for_generate` → a
  Marengo-only index → built-in footage-map fallback).
- The license risk is recorded **at the dependency** (`engine/python/pyproject.toml`)
  and here. Revisit if TwelveLabs publishes a licensed release.
- Desktop packaging: the spec `collect_submodules("twelvelabs")` (Fern's lazy
  `__getattr__` exports evade static analysis) and `copy_metadata("twelvelabs")` (the
  SDK reads its own version via `importlib.metadata` at import time) — without both a
  frozen sidecar `ImportError`s on boot.

## Consequences

- **Positive:** API drift is tracked by TwelveLabs, not us; typed models replace manual
  JSON decoding; no change to callers, behavior, schema, or tests' philosophy.
- **Negative / risk:** we ship an **unlicensed** third-party package in a redistributed
  product — a genuine legal exposure carried deliberately until upstream declares a
  license. The SDK's response shapes also become a dependency surface (e.g. `SearchItem`
  exposes no `score`/`confidence`, so `TLClip.confidence` is now always `None` and score
  is always `1/rank`).
- **Neutral:** one new transitive-free dependency (`twelvelabs` pulls only
  httpx/pydantic, already present).
