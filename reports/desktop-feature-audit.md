# Desktop Feature Audit — Engine vs UI (Phase 15 H17)

**Date:** 2026-07-06 · **Branch:** `milestone/production-hardening`

Scope: every engine capability (Python `framepilot_engine` + TS `editor-core` /
`ai-sdk`) audited against what the desktop editor actually exposes. "AI-only"
means reachable through the agent/tools but with no direct manual control.

## Status matrix

| Engine capability | Where it lives | UI status | Priority | Effort | Notes |
| --- | --- | --- | --- | --- | --- |
| Timeline ops (trim/split/move/ripple/delete/add) | editor-core + Python mirror | **Exposed** (direct manipulation + shortcuts + AI) | — | — | Complete |
| Render queue (final/preview) + validation | `render/` + sidecar | **Exposed** (Export dialog, auto-validated) | — | — | Complete |
| Caption generation + burn-in | `render/captions.py` | **Exposed** (Captions panel + export toggle) | — | — | Complete |
| Waveforms + thumbnails | `media/` derive | **Exposed** (timeline lanes) | — | — | Complete |
| **Preview proxies** | `media/derive.generate_proxy` | **Exposed as of H3** (was: never invoked) | — | — | Closed this milestone; background queue for >15min sources remains |
| **Transform keyframes (scale/x/y)** | `effects/transform.py` + keyframes | **Exposed as of H4** — preview renders them live + on-canvas handles; Inspector had punch-in/keyframes already | — | — | Closed this milestone |
| Rotation keyframes | `effects/transform.py` | **AI/Inspector-only** (no on-canvas rotate handle) | Medium | S | Add a rotate handle to the H4 controls |
| Opacity keyframes | evaluated, render deferred | **Not rendered** (engine defers to Phase 6) | Medium | M | Render support first (Phase 6), then UI |
| Color grade | `render/color` + tool | **Exposed** (Inspector + AI; preview approximates via CSS) | — | — | Complete |
| Audio gain / mute | ops + mixer | **Exposed** | — | — | Complete |
| Export audio polish (denoise / loudness / limiter) | render options | **Exposed** (Export dialog) | — | — | Complete |
| Silence analysis | `/analyze-silence` sidecar + `analyze_silence` tool | **AI-only** — no manual "detect silences" button/panel | High | M | A one-click "Remove silences" in the toolbar driving the same tool would surface the flagship flow to non-chat users |
| Scene detection | `/detect-scenes` + `detect_scenes` tool | **AI-only** — no manual UI, results not visualized | High | M | Visualize cuts as timeline markers; "split at scenes" action |
| Masks (rect/ellipse/polygon + feather/keyframes) | `render/masks.py` + Inspector panel | **Exposed** (Inspector), not previewed | Medium | L | Live mask preview needs canvas compositing in the monitor |
| Object tracking (manual tracker) | `effects/tracking.py` + `track_object` | **AI/MCP-only** — no picker UI | Low | L | Automatic CV tracking is dependency-gated (needs approval) |
| Face detection / subject masks | tool registry stubs | **Gated** (`available: false`, engine TBD) | Low | L | Blocked on a CV dependency decision (CLAUDE.md §5) |
| Transitions | ops + engine | **Exposed** (timeline junction pills + AI) | — | — | Complete |
| Speed ramps | — | **No engine support** | Medium | L | PRD §7.2 mentions ramps; engine work first |
| MCP server (external agents) | `packages/mcp-server` | **Exposed** (loopback HTTP; desktop doesn't yet mint/pass the bearer token to a bundled client) | Medium | S | Follow-up noted in Phase 12 |
| Project orientation / canvas | `project.resolution` | **Exposed as of H5** (monitor transport preset Select) | — | — | Closed this milestone |

## Recommended order

1. **Silence analysis UI** (High/M) — one-click "Remove silences" toolbar action
   reusing `analyze_silence` + the existing patch path; biggest user win per effort.
2. **Scene detection UI** (High/M) — markers at detected cuts + "split at scenes".
3. **Rotate handle** on the H4 transform controls (Medium/S).
4. **MCP bearer wiring** in the desktop shell (Medium/S).
5. **Mask preview** in the monitor (Medium/L).
6. **Opacity render** (engine Phase 6) then UI (Medium/M).
7. CV-gated features (faces/auto-track/segmentation) — pending the dependency
   approval the user deferred (Low/L).

## Gaps closed by this milestone

- Preview proxies: generated on import, played by the monitor (H3).
- Transform keyframes: rendered live in the preview + editable on canvas (H4).
- Canvas orientation: project-level presets in the monitor transport (H5).
- Relevance-ranked project-index search + keyframed-clip query for the AI (H10).
