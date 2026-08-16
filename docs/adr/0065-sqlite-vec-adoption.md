# ADR 0065 — Adopt `sqlite-vec` for visual KNN, with a mandatory brute-force fallback

- **Status:** accepted (2026-07-18)
- **Plan:** `plan/MEDIA-INTELLIGENCE.md` (D4, MI2.2–MI2.4)
- **Amends:** [ADR 0058](./0058-project-brain-derived-sqlite-substrate.md) — whose
  "Alternatives rejected" ruled out a vector DB ("thousands of rows per project,
  not millions; FTS5 + brute-force cosine are sufficient")
- **Packages:** `engine/python/framepilot_engine/brain/` (`vector_store.py`,
  `migrations.py`), `apps/desktop` (packaging)

## Context

ADR 0058 deliberately declined a vector store: text embeddings (plan B3) were a
few thousand rows per project, and `cosine_top_k` — brute-force cosine in numpy —
ranked them fine. Media Intelligence changes the scale. Adaptive per-second visual
sampling produces **tens of thousands of image vectors per project** (D2), and
`search_visual` is an interactive, per-turn tool: an O(n) scan of the whole vector
table on every query does not hold a sub-100 ms budget at desktop scale.

The forces:

- We need **indexed KNN** at 10k–50k+ vectors, interactively.
- The Project Brain is a **single SQLite file, single writer** (ADR 0058
  invariants 1–2). Introducing a separate vector service or a second native
  writer would break both.
- Loadable SQLite extensions are **not guaranteed to be present** — the browser
  build has no engine at all, and a desktop packaging miss could ship a sidecar
  whose SQLite can't `load_extension`. Honest degradation (ADR 0058 invariant 6)
  forbids turning that into an error.

## Decision

**Adopt the `sqlite-vec` extension (Apache-2.0) as the visual KNN backend, stored
in `vec0` virtual tables inside the existing `brain.sqlite` — and require it to
degrade honestly to the brute-force `cosine_top_k` path when the extension cannot
load.** This amends ADR 0058's "no vector DB" stance for the *visual* scale only;
the single-file, single-writer brain is preserved (the extension runs inside the
sidecar's own SQLite connection).

Specifics:

- `brain/vector_store.py` is **one search seam over both backends**: `vec0`
  indexed KNN when the extension loads, brute-force `cosine_top_k` (BLOB-stored
  float32 vectors) otherwise. A parity test proves identical top-k on a fixture
  set, so callers never branch.
- Extension load failure is a **logged reason + fallback**, never a raised error.
  `GET /brain/visual/status` reports which backend is live.
- Vectors are brain-internal, derived, rebuildable data — a `migrations.py`
  schema addition (`visual_vectors`, `visual_spans`, `visual_captions`), **no**
  `project.fp.json` schema change.
- Desktop packaging **bundles the extension per-OS** into the frozen sidecar
  ([ADR 0062](./0062-desktop-packaging-bundled-engine.md) shipped the packaging
  seam; MI2.4 bundles sqlite-vec and smoke-tests it in the packaged sidecar). The
  fallback is the safety net, **not** an excuse to skip packaging.

## Consequences

- **Easier:** interactive visual KNN at desktop scale without a separate service,
  a second SQLite writer, or a `better-sqlite3`-style native TS dependency. The
  single-file brain (backup, rebuild, delete-is-safe) is intact.
- **Harder / costs accepted:** a per-OS loadable-extension delivery problem in
  packaging, and two backends to keep behaviourally identical (paid for by the
  parity test). When the fallback is live, large corpora are slower — acceptable
  because it is a degraded, honest mode, not the shipped desktop path.
- **Guardrails:** the parity test, the honest-fallback-on-load-failure test, the
  MI2.4 packaged-sidecar smoke test, and a release-checklist entry. Note that the
  *current* search p95 gap (see `docs/guides/performance-budgets.md`) is **not** a
  vec0 problem — raw KNN is ~52 ms; two per-search O(n) materializations dominate,
  and are a separate `performance-optimizer` follow-up.

## Alternatives Considered

- **Keep brute-force `cosine_top_k` only** — simplest, zero new dependency, but
  O(n) per query does not hold the budget at 50k vectors interactively. Retained
  as the *fallback*, not the primary.
- **External vector DB / service (FAISS, Qdrant, …)** — breaks the local-first,
  single-file, single-writer brain and adds an operational surface for a desktop
  app. Rejected, as in ADR 0058.
- **TS-side vector search** — would need a second reader/writer of the brain and
  a native module in Electron; ADR 0058 already rejected that pattern.
</content>
