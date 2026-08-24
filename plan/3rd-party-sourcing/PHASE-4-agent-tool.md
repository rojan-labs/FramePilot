# Phase 4 — Agent tool — `[~]` code complete · evidence run outstanding

> **Ships:** "add calm background music under the voice" completes in Agent mode and over MCP.
> **Depends on:** Phase 3 shipped **and** a human having confirmed through the Phase 2 UI that
> the provider returns usable tracks.

---

## Why this is last

Two reasons, both measured:

1. **Known token cost.** The registry is already 78 descriptors ≈ **15,710 tokens per
   request** at every stage except `apply` (`plan/PLAN.md:118`). Two more descriptors are
   paid on **every turn of every run**, forever, including runs that have nothing to do with
   music. That is worth paying for a capability proven useful, and not before.
2. **Backend-first is a known failure mode here.** This repo already carries AI-only
   capabilities with no UI (roll/slip/slide/insert/multicam). Phases 2–3 guarantee the human
   entry point exists first.

---

## P4.1 — Tool specs — `[x]`

**Touch:** `packages/ai-sdk/src/domain-tools/media.ts` (search) and
`domain-tools/audio.ts` (placement). Domain-by-subject, not by kind — the registry is
organized by what a tool is _about_ (`domain-tools/media.ts` header).

```
search_music(query, limit?)   → read/analysis. Returns normalized tracks.
                                Never downloads. Never mutates.
add_music(remoteId, atSeconds?, duckUnderTrackId?)
                              → host action → downloads, then returns the SAME
                                add_asset + add_layer + add_clip operations the
                                manual path builds — plus an adjust_audio duck
                                (−12 dB) when duckUnderTrackId names a track with
                                clips. Includes Asset.source, so an agent-added
                                track carries its credit exactly as a hand-added
                                one does.
```

**`add_music` returns operations, not a mutation** (AGENTS.md invariant 5). The download is
a host side effect; the timeline change is a typed, validated, reversible patch — identical
to what P3.3 builds. **Prove that with a test asserting the agent path and the manual path
produce deep-equal timelines.**

Descriptions are written for the model but read by editors — route wording through the
`lead-prompt-engineer` conventions: say what the tool does and when to reach for it, in
video-editor language, not API language. Keep them short; every word is billed per request.

`hostUiOnly` is **not** set — an external MCP agent driving a desktop session can legitimately
use these (unlike `ask_user`, which needs a human looking at the app).

---

## P4.2 — Host execution — `[x]`

**Touch:** `packages/ai-sdk/src/sidecar-executor.ts`, `apps/desktop/electron/main.ts`.

Add `hostMusicSearch` / `hostAddMusic` to `SidecarExecutorOptions`, **mirroring
`hostTranscribe` exactly** (`sidecar-executor.ts:175`, implemented `main.ts:1564`). The key
and the network I/O stay in main; the sidecar is not involved and gets no key.

Absent (browser surface, tests) ⇒ the tools fail honestly rather than silently no-op.

---

## P4.3 — Honest degradation — `[x]`

`available` is static in the registry, so a config-gated tool must degrade **at execution
time**, following the ASR/TwelveLabs `no-key` precedent and ADR 0118 (missing evidence is
stated, not implied).

- No key configured → `failed` with "No music provider key is configured." Never a
  fabricated result, never `completed_no_changes`.
- Provider error → the `MusicErrorCode` sentence from `CONTRACTS.md` §4, surfaced verbatim.
- A non-commercial-only result → refused with the reason. Attribution-required results are
  used normally; the credit lands in `Asset.source` and the model is told so in the tool
  result, so it can mention crediting in its summary rather than leaving it a surprise.
- Per ADR 0083, an `add_music` that produced no operations **fails closed** — it must not
  report success on an unchanged timeline.

**Tests:** a honesty regression test per arm. This is the arm most likely to rot.

---

## P4.4 — Cross-runtime parity — `[x]`

Adding a tool touches four surfaces. Missing one is the standard drift bug:

- [x] TS `TOOL_REGISTRY` — `search_music` in `domain-tools/media.ts`, `add_music` in
      `domain-tools/audio.ts` (by subject, not by kind)
- [x] `registry.py` mirror — `SearchMusicArgs` / `AddMusicArgs`. No `handlers.py` arm, as
      predicted: these are host tools and the sidecar never sees them
- [x] Parity fixture regenerated (80 → 82 tools); both guard tests green
- [x] MCP flows automatically via `buildMcpTools`
- [x] `tool-classification.ts` — `search_music` revision_independent, `add_music`
      timeline_dependent (a memoized "already added" replayed past an undo would report a
      bed the timeline does not have)
- [x] `test_ai_tools.py`'s available/mutating contract table — an extra surface the plan
      did not list, and the one that caught the omission

**Rebuild the ai-sdk dist** — web-editor and desktop import from built `dist`, so an
un-rebuilt package means testing stale code.

---

## P4.5 — Skill — `[x]`

Extend an existing music/audio skill in `packages/ai-sdk/skills/*.md` rather than adding a
new one. Ground every recipe in what the tools actually do (`editing-skills-expert`
conventions): search returns candidates, `add_music` places and can duck, `detect_beats`
already exists for beat alignment.

Also check `wipe-guard` (`packages/ai-sdk/src/wipe-guard.ts`) — confirm `add_music` is not
caught by, and does not need, a guard trigger.

---

## P4.6 — Evidence — `[~]` token delta measured · agent run OUTSTANDING

> **Measured 2026-08-23: the registry's tool-descriptor section goes 15,762 → 16,132
> tokens — `+370` per request**, on every turn of every run. Read off the frozen
> golden manifests, whose only divergence after this phase was that arithmetic. The
> plan decided in advance to pay this; it is now a number rather than an estimate.
>
> **The agent evidence run itself is OUTSTANDING** for the same reason as P3.6: it
> needs a human at a desktop build with real footage. Both prompts are specified —
> "add calm background music under the voice" with a key configured, and the same
> prompt with the host override absent, which must fail honestly. The honesty arm is
> covered by unit tests per arm; what is unproven is the whole chain on real media.

Per `product-discipline.mdc` §8, judged by the resulting timeline and render, not by tool
calls:

> On the same real 5–15 minute recording used in P3.6: **"add calm background music under
> the voice"** → the agent searches, picks, downloads, places on a `music` track, ducks it
> under dialogue → export → bed audible and ducked, **and the Credits view names the
> creator**. Undo removes the run's changes.
> With no key configured, the same prompt **fails honestly with a stated reason**.

Record the prompt, the resulting operations, and the observed render.

---

## Definition of done

- [x] Both tools registered, TS ↔ Python ↔ MCP parity green, dist rebuilt
- [x] `add_music` returns operations; the agent path yields a timeline **deep-equal** to the
      manual path (tested — with the manual ops spelled out independently, so a change to
      the shared builder cannot make both sides wrong the same way)
- [x] Every degradation arm stated honestly, never fabricated (tested per arm: absent host,
      provider failure surfaced verbatim, non-commercial refusal, empty results as
      `warning` not `completed`)
- [x] Empty/unusable planned mutation fails closed (ADR 0083) — a payload that does not
      parse is rejected rather than reported as a completed edit on an unchanged timeline
- [ ] The P3.6/P4.6 evidence runs recorded, including the no-key run — OUTSTANDING
- [x] Registry token delta measured: **+370 per request** (15,762 → 16,132)
- [x] Unit/typecheck/lint green across every package; `test:e2e` green
- [x] `docs/guides/music-sourcing.md` has an Agent-mode section; `CHANGELOG.md` landed

**Deferred:** the agent choosing music by _mood inferred from the footage_ (that is footage
understanding, a different subsystem); automatic beat-aligned cutting to a fetched track
beyond what `detect_beats` already offers; multi-track music arrangement.
