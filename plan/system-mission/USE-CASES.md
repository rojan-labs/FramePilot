# Use cases — every end-to-end journey the mission must prove

> Each row is a user journey traced through the system. "Covered by" names the phase
> tasks that make it work and the Phase 9 test that proves it. A journey is **proven**
> only when its test passes on the desktop host against real media. Update the matrix
> as phases close.

## A. Trace template

Every journey passes through the same boundaries; each phase owns some of them:

```text
UI entry (sidebar / menu / shortcut)        → Phase 8
→ context ingestion (attachments, selection)  → Phase 3
→ context assembly (structured state)         → Phase 1
→ conductor decision / plan                   → Phase 1
→ tools & controllers                         → Phases 4, 5
→ editor-core patch → validate → commit       → unchanged (invariant)
→ verify (critic)                             → Phase 4
→ sidebar result summary / undo               → Phase 8
→ preview                                     → unchanged
→ export                                      → Phase 7
```

## B. Journeys

| ID | Journey | Entry | Must be true at the end | Covered by | State |
| --- | --- | --- | --- | --- | --- |
| UC-01 | **Raw recording → 30-second social montage** | "make a 30s montage of the best moments" | ≥N clips placed on the picture track, total ≈30s ±1s, cuts on frames, music (if asked) with beat grid grounded on the placed track, result summary names what changed, one undo reverts all | P1.4, P4.1, P4.3, P9.1 (`ai-journey-montage`) | `[ ]` |
| UC-02 | **Podcast highlight** | "pull the best 60 seconds for a clip" | Transcript-grounded selection, dialogue not cut mid-word, captions optional, timing honest | P1.3, P4.1, P4.4, P9.1 | `[ ]` |
| UC-03 | **Remove dead air** | "remove the silences" | Silence ranges removed as one reversible patch; speech untouched; count reported | existing `remove_silence` + P4.4 verify; P9.3 regression | `[ ]` |
| UC-04 | **Add captions** | "add captions" | Caption track from transcript, template from project style memory, burn-in choice respected at export | existing + P1.5 (style memory) + P7; P9.3 | `[ ]` |
| UC-05 | **Sync cuts to music** | "cut this to the beat" | Beat grid from the placed music (ADR 0157), cuts land on beats within tolerance, `hardSync` honoured | P4.1, P4.4; P9.3 | `[ ]` |
| UC-06 | **Apply a reference video's style** | attach `ref.mp4` + "make mine feel like this" | Reference analyzed once → `ReferenceProfile` (rhythm, shot length, transition kind, color, caption style, pacing); plan cites the profile; edit reflects it; second turn "same style" needs no re-attach | P3.1–P3.6, P1.5, P4.2; P9.1 | `[ ]` |
| UC-07 | **Use an image as brand/style context** | attach `logo.png` + "put our logo bottom-right" / attach `mood.jpg` + "grade like this" | Image role classified (brand/logo/style/color/thumbnail/b-roll/character); logo becomes an overlay op; color reference becomes a grade target; never re-sent raw every turn | P3.2, P3.4, P4.2; P9.1 | `[ ]` |
| UC-08 | **Refine an existing edit** | after UC-01: "tighten the middle, keep the ending" | Edit modifies the existing timeline, does not restart it (wipe guard), remembers prior decisions; call count ≤ first turn | P1.4, P1.5, P4.3; P9.1 | `[ ]` |
| UC-09 | **Context persists across turns** | "use the same captions as before" on turn 5 | No re-explanation needed; stale context (>TTL, superseded) is gone | P1.5; P9.1 | `[ ]` |
| UC-10 | **B-roll insertion** | "add b-roll over the part where I talk about the product" | Transcript anchors the range; cutaway placed (non-overlapping per ADR 0140); source is project media or stock | existing tools + P4.1; P9.3 | `[ ]` |
| UC-11 | **Animated captions / motion graphic** | "animate the captions" / "add a lower third" | Motion controller op with keyframes; renders in preview and export identically | existing motion controller + P4.1; P9.3 | `[ ]` |
| UC-12 | **Create a hook** | "start with the strongest line" | Hook found from full transcript, opening restructured as one patch | existing `add-hook` + P4.4; P9.3 | `[ ]` |
| UC-13 | **Export at chosen quality** | Export → 1080p / 4K, 30/60 fps, Recommended/High, H.264/HEVC, MP4/MOV | Dialog has no platform names; resolution capped at source with an upscale note; file matches choice (ffprobe); progress accurate; cancel works; reveal works; last choice remembered | P7.1–P7.7; P9.4 | `[ ]` |
| UC-14 | **Long session stays healthy** | 45-minute edit session: scrubbing, AI turns, previews | Renderer heap and main-process RSS plateau; FFmpeg/ffprobe children reaped; object URLs revoked; no listener growth | P6.1–P6.6; P9.5 | `[ ]` |
| UC-15 | **Failure paths** | model 5xx, tool throw, sidecar crash, invalid media, cancel mid-run, export failure, app restart mid-run | Every failure is surfaced in the sidebar in plain words, nothing half-applied, run state recoverable after restart | P5.4, P8.4; P9.2 | `[ ]` |
| UC-16 | **Large media** | 4K, 20-minute camera file, 60+ photos | Preparation completes with per-asset outcomes (media-intelligence closure), AI turn context stays within budget, export completes | P0 measurements, P6, P7; P9.4/9.5 | `[ ]` |

## C. What "proven" requires per journey

Two bars, and they are not the same one. The **deterministic** bar is a test that asserts
the timeline outcome of a scripted run — that is what P4.1 closes on, and it lives in
`packages/ai-sdk/src/use-case-outcomes.test.ts` (UC-01, UC-02, UC-10, UC-11),
`beat-grid-wiring.test.ts` (UC-05) and `remove-silences.test.ts` (UC-03). The **proven**
bar below is stricter and is Phase 9's: the desktop host, a real provider, real media. A row
stays `[ ]` until that passes, however green the deterministic layer is.


- The Phase 9 spec that names the journey passes on the desktop host (`tests/e2e-desktop`).
- The timeline outcome is asserted (clip count, times, track content), not the chat text.
- For UC-06/07/13 the media outcome is asserted with `ffprobe` or a rendered-frame check.
- For UC-14 the numbers are in `docs/reports/system-mission/06-after.md`.
