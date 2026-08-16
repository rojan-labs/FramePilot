# Project Status

> This is the human-readable implementation snapshot for FramePilot. Update it when a
> meaningful capability, system boundary, release state, or verification baseline changes.
> The detailed execution record remains [`plan/PLAN.md`](../../plan/PLAN.md), and user-facing
> changes remain [`CHANGELOG.md`](../../CHANGELOG.md).

**Snapshot date:** 2026-08-05  
**Lifecycle:** Active pre-release development  
**Repository version:** `0.0.0`  
**Overall:** Functional desktop editor and AI editing system under continued product,
performance, and reliability development.

## Current product state

FramePilot is no longer a scaffold. The repository contains an operational Electron editor,
a React timeline and preview system, a typed editing core, a multi-provider AI orchestrator,
a Python media and render sidecar, local project intelligence, desktop packaging, and a
large automated test suite.

The product is suitable for development, internal testing, and structured demonstrations.
It should still be treated as pre-release software. Interfaces, schemas, editing behavior,
packaging, and release mechanics can continue to evolve before a stable public release.

## Shipped foundations

### Project and editing model

- Zod project schema with cross-language synchronization into the Python engine.
- Typed timeline operations with validation, transactional patch application, inversion,
  diffing, and undo/redo.
- Schema migrations through version 14, including effect layers and real cubic Bezier
  keyframe handles.
- Multitrack video, audio, caption, overlay, and effect timelines.
- Manual trim, split, move, ripple, snapping, marker, transition, effect, and keyframe
  workflows.

### Editor and preview

- Electron desktop shell with secure preload and IPC boundaries.
- React editor with media bin, program monitor, timeline, inspector, captions, effects,
  transitions, export, settings, and AI sidebar.
- Adaptive preview strategy. Bounded proxy media can use WebCodecs, while long unproxied
  originals use the browser's streaming media path.
- Indexed active-span queries, virtualized caption editing, bounded render work, and other
  safeguards for feature-length or caption-heavy projects.
- Preview implementations for captions, overlays, effects, transitions, and keyframed
  transforms, paired with deterministic export implementations.

### AI orchestration

- Streaming chat, plan, edit, and agent workflows.
- Canonical tool registry with schema-validated inputs and explicit mutation boundaries.
- Skill and playbook loading for editing workflows such as captions and pacing.
- Bounded parallel read and analysis calls, serial mutation calls, cancellation, durable run
  state, replay, and recovery.
- Proposal review, timeline diffs, reversible application, and completion verification.
- Honest model usage reporting and descriptive activity steps.
- `get_frame` visual inspection for supported vision-capable models. It renders a frame from
  the current working project through the export compiler and attaches the image to the
  model request.

### Providers

FramePilot currently exposes provider adapters for:

- Anthropic
- NVIDIA
- OpenRouter
- Groq
- Google Gemini
- Ollama
- DeepSeek
- Deterministic mock

Provider choice changes transport and model behavior. It does not bypass the tool registry,
patch validation, host authority, or project safety boundaries.

### Media intelligence and memory

- Media probing, proxy generation, waveform extraction, scene detection, beat detection,
  transcription, frame extraction, and derived media artifacts.
- Per-project SQLite brain with provenance-aware fields, persisted analysis, session context,
  searchable transcripts, and derived indexes.
- Visual indexing and search through NVIDIA cross-modal embeddings when configured.
- `sqlite-vec` KNN where available, with a deterministic brute-force fallback.
- Project memory plus optional cross-project working-style memory.
- Hosted TwelveLabs integration for supported media-understanding paths when configured.

### Captions, effects, transitions, and motion

- Local whisper-cli and hosted transcription paths.
- Editable caption cues with split, merge, text changes, placement, templates, and automatic
  emphasis.
- Caption preview and render burn-in with visual verification support.
- First-class effect lanes, catalog-driven authoring, and matched GPU/numpy effect behavior.
- Catalog-driven transitions with searchable discovery, alignment, parameters, timeline
  affordances, and preview/export implementations.
- Keyframe controls for position, scale, rotation, and opacity, including navigation,
  movement, removal, easing, and editable Bezier curves.

### Render, packaging, and integration

- FastAPI sidecar and `framepilot` CLI.
- MoviePy and FFmpeg export, frame grabs, preview renders, and render validation.
- Desktop packaging through Electron Builder with a bundled PyInstaller engine.
- Packaged ffmpeg and ffprobe resolution, signing support, and release workflows.
- Streamable HTTP MCP server on a loopback interface for external agent clients.
- Marketing website package and Freemius-backed licensing and checkout integration.

## Current boundaries

- FramePilot remains pre-release and the root package version is `0.0.0`.
- Browser development is useful for editor work, but host-authoritative storage, packaged
  sidecar behavior, licensing, and some media capabilities require Electron.
- Live AI quality depends on the selected model, its tool-calling behavior, context window,
  visual support, and configured credentials.
- Visual embeddings and hosted media understanding send selected media data to configured
  cloud providers. Their use is opt-in through credentials and settings.
- Missing models, binaries, keys, indexes, or optional native extensions must degrade with a
  visible explanation. They must not produce fabricated analysis.
- Advanced professional editing surfaces continue to be expanded and hardened. The master
  plan is the source for incomplete work and accepted limitations.
- A signed public installer and stable compatibility guarantees should not be assumed until
  a release is published and the release checklist is satisfied.

## Latest recorded verification

The latest verification recorded on `main` for the August 4 vision and performance work
reported:

- `pnpm verify` green across 16 of 16 Turborepo tasks.
- 2,253 Python engine tests passed.
- One intentional Python test skip.

This is a historical verification snapshot, not a claim that every later branch has run the
same checks. Each pull request must report exactly what it validated.

## Sources of truth

| Question | Source |
| --- | --- |
| What exists now? | This status report and the current code |
| What changed for users? | [`CHANGELOG.md`](../../CHANGELOG.md) |
| What is planned or still incomplete? | [`plan/PLAN.md`](../../plan/PLAN.md) |
| Why was an architectural choice made? | [`docs/adr/`](../adr) |
| What is the long-term product intent? | [`PRD.md`](../../PRD.md) |
| How do I run or contribute? | [`docs/guides/onboarding.md`](../guides/onboarding.md) and [`CONTRIBUTING.md`](../../CONTRIBUTING.md) |

## Next priorities

Use the top status snapshot and unchecked work in [`plan/PLAN.md`](../../plan/PLAN.md).
Do not infer the next priority from the original Phase 0 to Phase 8 scaffold roadmap. The
plan now contains the detailed, dated implementation history and the remaining product work.
