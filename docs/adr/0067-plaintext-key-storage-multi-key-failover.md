# ADR 0067 — Plaintext NVIDIA key storage + comma-separated multi-key failover

- **Status:** accepted (2026-07-18)
- **Plan:** `plan/MEDIA-INTELLIGENCE.md` (D5, §3.2, §3.6, MI0.1–MI0.3)
- **Relates to:** [ADR 0066](./0066-nvidia-cloud-visual-embeddings.md) (what the
  key authorizes), [ADR 0005](./0005-multi-provider-ai-anthropic-nvidia.md)
  (existing `cfg.keys.*` config)
- **Packages:** `apps/web-editor` (Settings → AI → Embeddings), the AI config
  store, `engine/python/framepilot_engine/brain/keyring.py`

## Context

Media Intelligence needs one or more NVIDIA API keys ([ADR 0066](./0066-nvidia-cloud-visual-embeddings.md)).
Two questions had to be settled: **how keys are stored/shown**, and **how the
engine survives a bad or rate-limited key mid-index**.

On storage, the user gave an **explicit, mandated requirement (D5)**: keys are to
be entered and shown as plain text and stored as plain text, matching how the AI
tab already treats other provider keys (`cfg.keys.*`) — no OS keychain, no
masking, no encryption-at-rest ceremony. FramePilot is a **local-first desktop
app**; the AI config file already sits on the user's own machine holding the
Anthropic/Google/NVIDIA-chat keys in the same form.

On resilience, indexing a real project is thousands of embedding calls; a single
key hitting a 429 or a dead 401 mid-run must not fail the whole job.

## Decision

**Store the NVIDIA embeddings key(s) as plaintext in the same AI config file as
the other `cfg.keys.*`, shown in the UI as a visible `type="text"` input; support
a comma-separated list of keys with automatic rotate-on-failure and per-key
cooldown.**

Specifics:

- Own config slot **`cfg.keys.nvidiaEmbeddings`** — deliberately **not** the chat
  `nvidia` key (different product, different rotation semantics).
- Settings → AI → **Embeddings**: a plain, always-visible text input labeled
  "NVIDIA API key(s), comma-separated", with the same "stored as plain text on
  this machine" hint the existing AI tab uses.
- The engine's **key ring** (`brain/keyring.py`, a pure, fully-covered module)
  parses the list and runs a failover state machine: **mark dead** on 401/403,
  **cool down** (exponential backoff) on 429/5xx and rotate to the next, all keys
  exhausted → typed `{available:false, reason:"all_keys_failing", lastError}`.
  Per-key health is surfaced in `/brain/visual/status` and the settings UI.

## Consequences

- **Easier:** matches the user's stated model and the existing key UX; a user can
  paste several keys and get resilient, uninterrupted indexing without touching an
  OS keychain flow. The keyring is deterministic and 100%-covered.
- **Risk accepted — scoped honestly:**
  - **What plaintext-at-rest exposes:** anyone (or any process) with read access
    to the user's AI config file on this machine can read the NVIDIA key(s), the
    same as the already-stored provider keys. There is no additional encryption
    boundary.
  - **What it does *not* expose:** the key is **never** written to the brain, and
    the engine **never logs or echoes it** ([ADR 0066](./0066-nvidia-cloud-visual-embeddings.md));
    it is not transmitted anywhere except NVIDIA's own API over HTTPS; it is not
    in any project file, sidecar, or committed artifact.
  - **Why the user chose it:** local-first desktop, single-user machine, parity
    with existing key handling, and explicit priority on zero-friction setup over
    at-rest encryption. This ADR records that this was a deliberate, mandated
    trade-off (D5), not an oversight.
- **Boundary that stays firm:** the plaintext decision is about *host-side
  storage only*. The engine's no-log / no-persist rule for the key is independent
  and non-negotiable — if that ever changes it needs its own ADR.

## Alternatives Considered

- **OS keychain / encrypted-at-rest storage** — stronger at-rest posture, but
  contradicts the user's explicit requirement and diverges from how every other
  provider key is already handled; rejected per D5.
- **Masked (`type="password"`) input** — the user explicitly wanted the value
  visible for copy/verify; masking without encryption is security theatre here
  anyway.
- **Single key, no failover** — one 429 or dead key would fail a long index job;
  rejected as too fragile for thousands of calls.
- **Overload the existing chat `nvidia` key** — couples two products with
  different rotation and failover semantics; rejected in favor of a dedicated
  slot.
</content>
