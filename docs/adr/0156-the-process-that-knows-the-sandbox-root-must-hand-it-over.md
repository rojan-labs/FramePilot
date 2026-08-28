# ADR 0156 — The process that knows the sandbox root must hand it over

**Status:** accepted
**Date:** 2026-08-28
**Schema:** unchanged
**Related:** PRD §18.1 (path sandbox), ADR 0114 (derived-artifact location), ADR 0155
(a frame the renderer fits into needs a shape to fit)

## Context

Run `2ca2fcbe` was given 61 hiking photographs and a beat-synced Reel to build. It
placed a music track, then spent its entire budget failing to detect that track's
beats:

```
Finding the beat in Skyline_run_… — failed · 70ms
  Analysis failed (500): Internal Server Error
```

Four times, then the client's per-turn circuit breaker took over
(`detect_beats is unavailable this turn`), the repetition guard stopped the run
("that exact set of calls was already made … and produced nothing new"), and the
acceptance checks reported the truth: **0 shots on a timeline that asked for 61**,
two overlay clips over black. The run ended with two identical warnings:

```
Review could not run: Temporal evidence engine rejected the batch (500):
Internal Server Error
```

### What actually happened

The engine sidecar sandboxes every caller-supplied path against
`Settings.projects_root`, sourced from `FRAMEPILOT_PROJECTS_ROOT`. The engine has
**no default** — with the var unset, `sandbox()` fails closed with a 503, and every
path-based route is dead: `/detect-beats`, `/detect-scenes`, `/analyze-silence`,
`/analyze`, `/transcribe`, `/asr/prepare-audio`, `/render`, `/render/frame` and
`/review/temporal-evidence`.

Nothing set it. The desktop app resolves that folder for _itself_
(`resolveProjectsDir` → `~/Documents/FramePilot Projects`) and spawns the sidecar
with `{ ...process.env, ...resolved.env }`. `resolved.env` carried the staged
ffprobe path and nothing else. So the sidecar saw the var only if the human who
launched the app had exported it in their shell — which is why the failure looked
machine-specific and why `sandbox()`'s own docstring had drifted into asserting
_"The packaged desktop shell always sets it."_ It never did.

Measured against the live sidecar and a freshly started one from the same commit:

| route                            | live (no root)                        | fresh (root set)                            |
| -------------------------------- | ------------------------------------- | ------------------------------------------- |
| `POST /detect-beats`             | 500                                   | 200, 119 beats, 172.3 BPM                   |
| `POST /analyze-silence`          | 500                                   | 200                                         |
| `POST /transcribe`               | 500                                   | 200                                         |
| `POST /review/temporal-evidence` | 500                                   | 422 (revision mismatch — reached the route) |
| `POST /inspect-media`            | 503 `projects_root is not configured` | 200                                         |

### Why a misconfiguration surfaced as a 500

`/inspect-media` reported the misconfiguration honestly because `sandbox()` is the
first thing it touches. The analysis and review routes did not, because both
project resolvers computed a media base first:

```python
return project, settings.projects_root or Path.cwd(), "inline"
```

`Path.cwd()` raises `FileNotFoundError` when the process's launch directory has
been unlinked — a `git checkout` or a rebuild under a long-running dev sidecar is
enough, and that is exactly what had happened here (the process's cwd inode no
longer matched the path it named). That error was unhandled, so the route answered
a bare `500 Internal Server Error`, which is all the agent ever saw. The fallback
also ran _before_ the asset lookup, so a missing root masked the 404 and 400 those
routes could otherwise have given.

## Decision

**1. The desktop hands the engine its sandbox root, in every branch.**
`resolveSidecarCommand` now emits `FRAMEPILOT_PROJECTS_ROOT` from the app's own
resolved projects folder for the dev-uv, bundled, and `FRAMEPILOT_ENGINE_DIR`
override branches alike. That value already honours a user-set variable and makes
it absolute, so this narrows nothing the user chose; it removes the case where the
two processes disagree about where the user's projects live, and the case where
the engine has no root at all.

**2. The engine never resolves media against its own working directory.**
`inline_media_base()` returns `settings.projects_root` or raises the same 503
`sandbox()` raises. An inline document's paths are project-relative; the sandbox
root is the only legitimate base for them, and "wherever this process was launched"
was never one. One misconfiguration now has one diagnosis, and it arrives at the
agent as a sentence naming the variable to set.

**3. One outage is reported once.** Every review in a turn shares one engine, so a
single outage rejected every batch with the identical message and the run published
that sentence once per batch. `reviewFailures` collapses identical messages and
appends the count.

## Consequences

- A user who never exported `FRAMEPILOT_PROJECTS_ROOT` — that is, every packaged
  install — gets working beat detection, scene detection, silence analysis,
  transcription, frame rendering, and perceptual review.
- A genuinely unconfigured engine (the CLI, a test host, an embedder) now answers
  503 with the variable's name instead of 500 with nothing, on every path route
  rather than only the ones that reach `sandbox()` first.
- `Path.cwd()` no longer appears in `service.py`. The engine's read base is the
  sandbox root or nothing, which is what PRD §18.1 always intended.
- Ambient-cwd behaviour is gone: an embedder that relied on launching the engine
  inside a project folder must now set `FRAMEPILOT_PROJECTS_ROOT`. This is
  deliberate — that behaviour was an unbounded read surface, not a feature.

## Evidence

- Failing run: `run.md` (conversation `cd52aa9f`, run `2ca2fcbe`), 21 model calls,
  $1.26, 2 edits, 0 shots placed.
- Reproduction: identical `POST /detect-beats` body → 500 against the running
  sidecar, 200 against a fresh one started from the same commit with the root set.
- Regression tests: `engine/python/tests/test_service.py`
  (`test_inline_project_never_resolves_media_against_the_process_cwd` fails with the
  original `FileNotFoundError` on the pre-fix code),
  `apps/desktop/electron/sidecar/spawn.test.ts` (`sandbox root`),
  `packages/ai-sdk/src/review-findings.test.ts`.
