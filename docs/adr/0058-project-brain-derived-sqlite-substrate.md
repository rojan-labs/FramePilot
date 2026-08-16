# ADR 0058 — Project Brain: a derived, per-project SQLite substrate

- **Status:** accepted (2026-07-14)
- **Plan:** `plan/ORCHESTRATION_ENHANCEMENT_PLAN.md` (Phase B0; B1–B7 build on it)
- **Packages:** `engine/python/framepilot_engine/brain/`, sidecar routes in `service.py`,
  optional `projectId`/`assetId` on the `/asset-media` import path

## Context

Every analysis FramePilot ran (silence, scenes, beats, probes, transcripts) was
**ephemeral**: computed inside one agent run, returned to the loop, and discarded.
There was no database, no search surface, no similarity recall, and no provenance
for anything the substrate learned. The architecture proven by
[`davinci-resolve-mcp`](https://github.com/samuelgursky/davinci-resolve-mcp) — a thin
deterministic local-tooling substrate with a per-project `timeline_brain.sqlite`,
JSON sidecars, and field-level provenance — closes exactly this gap.

## Decision

Add a **Project Brain**: one SQLite database per project at
`<projectsRoot>/.framepilot-derived/<projectId>/brain.sqlite`, owned and written
**only by the Python sidecar**, with per-asset JSON sidecar exports
(`sidecars/<assetId>/analysis.json`) kept in lockstep.

Invariants (non-negotiable, enforced in code and tests):

1. **`project.fp.json` stays the single canonical document.** The brain is a
   derived, rebuildable cache — deleting it loses time, never truth. No brain row
   is required to open, edit, or render a project (tested).
2. **Single writer.** Only the Python sidecar opens the file for writing; the TS
   side reads via sidecar HTTP. This avoids cross-process SQLite contention and a
   `better-sqlite3` native dependency entirely.
3. **Sandboxed.** Every brain/sidecar path goes through `resolve_within`;
   `projectId`/`assetId` are treated as untrusted path segments.
4. **Provenance.** Field writes carry `source: machine | model | human` plus actor
   and timestamp in an append-only `field_changelog`; `write_field()` **refuses**
   to overwrite a human value with a machine/model value (typed conflict).
5. **Versioned, forward-only migrations** via `PRAGMA user_version`, mirroring
   `timeline-schema/migrations.ts`; newer files are rejected, never downgraded.
6. **Honest degradation.** No sidecar (browser), no FTS5, or any brain failure →
   typed `available:false`/warn-and-continue; media import is never blocked by a
   brain failure.

Schema **v1 as decided here** (the brain is at v2 as of B3.1, which added
`embeddings.payload`; `SCHEMA_VERSION` in `brain/migrations.py` is the live
answer — this section records the original decision, not the current DDL):
`assets` (probe + streaming content SHA256), `analysis_results`
(keyed by asset/kind/depth/params-hash — the generalized ASR-cache key),
`fields` + `field_changelog` (provenance), `jobs` (journal for B5), `frames`
(vision protocol, B4), `embeddings` (B3, created but unused), and contentless
FTS5 `transcript_fts`/`markers_fts` created only when the runtime supports FTS5.

## Alternatives rejected

- **TS-side `better-sqlite3`** — a native module dependency in Electron plus a
  second writer; the sidecar already owns all derived media.
- **Brain as canonical store** — would break the human-diffable project file,
  migrations story, and the patch engine's role as the single mutation path.
- **A vector DB / external search service** — thousands of rows per project, not
  millions; FTS5 + brute-force cosine (B3) are sufficient and local-first.

## Consequences

- Analysis results become durable and cacheable (B1); FTS search (B2), embeddings
  (B3), the vision protocol (B4), durable jobs (B5), and markdown memory tiers
  (B6) all build on this file.
- `POST /asset-media` accepts optional `projectId`/`assetId` and records the
  probe + content hash; `GET /brain/status` and `POST /brain/rebuild` manage the
  lifecycle. Rebuild-from-sidecars is byte-identical (determinism test).
- The brain directory is derived data: it is never committed, and deleting it is
  always safe.
