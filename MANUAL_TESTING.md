# MANUAL_TESTING.md — FramePilot capability verification checklist

> **Purpose.** A systematic, one-capability-at-a-time manual pass over everything a user can
> actually reach in the shipped product today. Work down the list, run each procedure, tick the
> box, and record the date and outcome.
>
> **Scope rule (matches `AGENTS.md` / `CLAUDE.md`).** A capability appears here **only** when a
> user can reach it from the product surface — a UI control or a natural-language AI request.
> Schemas, tools, workers, backends, and ADRs that exist without a user path are listed in
> [§20 Not yet manually testable](#20-not-yet-manually-testable), with the reason.
>
> **Surface priority.** Desktop is the #1 product surface. Every procedure below assumes the
> Electron desktop app unless a row says otherwise. Browser gaps are noted per capability, never
> treated as the baseline.
>
> **This is a documentation deliverable.** It changes no application code. Discovery date:
> **2026-08-21**, against branch `refactor/framepilot-95-runtime-convergence`.

---

## How to use this file

Each capability is one checklist row shaped like this:

```
- [ ] **Capability name** — `trigger type` · `surface`
  - Setup: (anything beyond the shared setup)
  - Do: exact steps
  - Expect: what you should observe
  - Fail if: the concrete failure signal
  - Result: __/__/____ · PASS / FAIL · notes:
```

**Trigger types**

| Tag | Meaning |
| --- | --- |
| `UI` | An explicit control exists — button, panel, drag gesture, shortcut. |
| `AI` | Only reachable by asking the AI in natural language. No UI control exists. |
| `UI+AI` | Both paths exist; test both, they are different code paths. |

**Surface tags**: `desktop` (needs the Electron shell and/or the Python sidecar) ·
`desktop+browser` (works in a plain `pnpm --filter @framepilot/web-editor dev` build too).

**A note that changes how you read every AI row:** AI edits **auto-apply**. The sidebar submits
with `patchPolicy: 'auto_commit'` (`AiSidebar.tsx`), and the diff card in the run is a *receipt*
for a change already on the timeline, not an approval gate. So "expect" for an AI capability is
always **the timeline changed**, and your rollback is `⌘Z` or the History panel — not a Reject
button.

---

## 1. Shared setup — do this once per testing session

- [ ] **S1. Toolchain and build**
  - `pnpm install`
  - `pnpm engine:sync` (uses `uv` in `engine/python`)
  - `cp .env.example .env` if you have not already.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **S2. Launch the desktop app**
  - `pnpm desktop:dev` (alias for `pnpm --filter @framepilot/desktop dev`).
  - This builds `shared-types → timeline-schema → editor-core → ai-sdk`, starts Vite on
    `localhost:5173`, and launches Electron against it.
  - **Gotcha:** `@framepilot/ai-sdk` is consumed from its **built `dist`**. If you edit ai-sdk
    source mid-session, rebuild it or you are testing stale code.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **S3. Confirm the Python sidecar is up**
  - The Electron main process spawns and health-polls the sidecar itself
    (`apps/desktop/electron/sidecar/manager.ts`); you do not start it by hand.
  - Open the AI rail (right rail → **AI** tab) and look at the **engine status chip**. It must
    read reachable, not unreachable.
  - Default address: `FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8765`.
  - **This gate blocks a lot.** Every `analysis` and `action` tool — silence, scenes, beats,
    frame grabs, preview renders, export — runs on the sidecar. If the chip is not green, stop
    and fix it before testing anything in §7, §8, §12, §16, §17, or §19.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **S4. Configure a real AI provider**
  - `FRAMEPILOT_AI_PROVIDER` defaults to `mock` in `.env.example`. A mock provider will not
    exercise any AI capability meaningfully.
  - Open **Settings (⌘,) → AI** and select a real provider, or set the matching env pair
    (`ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`, `OPENROUTER_*`, `GROQ_*`, `GOOGLE_*`,
    `FRAMEPILOT_OPENAI_COMPATIBLE_*`, etc. — see `.env.example`).
  - **Pick a multimodal model** if you intend to test anything that needs the AI to *look* at a
    frame (§16 vision review, `get_frame`).
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **S5. Speech-to-text provider**
  - **Settings (⌘,) → AI → Speech-to-text**: `Local` (whisper-cli) or `TwelveLabs`.
  - `Local` needs the model set up (the panel's local setup block; `WHISPER_MODEL`,
    `FRAMEPILOT_ASR_MODEL_DIR`).
  - `TwelveLabs` needs a key pasted in that same panel — the **same key** powers §17 footage
    understanding.
  - Also choose **Transcription: On demand / On import** here; `On import` warms new media in
    the background and changes what you observe in §5.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **S6. Optional keys, only if you are testing those sections**
  - `TWELVELABS_API_KEY` (or the Settings field) → §17 footage understanding, semantic search,
    footage map.
  - `FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS` or `FRAMEPILOT_EMBEDDINGS_MODEL_DIR` → visual/embedding
    search when not using TwelveLabs.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **S7. Sample media — use real desktop-scale footage**
  - Repo rule (`CLAUDE.md`): reproduce against **real camera files, minutes long**, not tiny
    fixtures. Tiny fixtures do not support any performance or long-form claim.
  - Prepare, in one folder:
    1. **Talking head, 3–10 min**, clean speech with real pauses → §5 transcript, §6 captions,
       §7 silence, §8 pacing, §9 hooks.
    2. **B-roll pack, 5–10 short clips** → §3 professional edits, §10 transitions, §17
       understanding, §19 montage runs.
    3. **A music track** → §12 beat detection, beat-synced cuts.
    4. **Two camera angles of the same take** → §4 multicam (you will need to author the sync
       offset; nothing is inferred from filenames).
  - Import via the **Assets** rail tab (left rail → Assets) or drag onto the media bin.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **S8. Save the project to disk before engine work**
  - Export and transcription both force a save first (`ensureSavedForExport`). Save early so
    `fp-media://` resolution and sidecar paths are stable.
  - Result: __/__/____ · PASS / FAIL · notes:

### Where things live (orientation)

| Surface | How to open |
| --- | --- |
| Left rail tabs | **Assets**, **Effects**, **Transitions**, **Text**, **Captions** |
| Right rail tabs | **AI**, **Inspector** |
| Footage understanding | Topbar icon, tooltip "Footage understanding" |
| Transcription | Topbar icon, tooltip "Transcription" (next to the above) |
| History | Topbar icon · `⌘⇧H` |
| Command palette (scoped AI edit) | `⌘K` |
| Keyboard shortcuts | `?` |
| Settings | `⌘,` |
| Export | Topbar accent button, right side |

### The three AI modes (right rail → AI → mode dropdown)

| Mode | Label / hint in the app | Use it for |
| --- | --- | --- |
| `agent` | **Agent** — "Plans and edits over multiple steps" | Everything multi-step. Default. |
| `chat` | **Chat** — "Ask about your video and transcript" | Read-only questions. |
| `edit` | **Edit** — "One quick, reviewable edit" | One-shot single edits (ADR 0133). |

Agent mode also has a **Plan first** toggle in the header ("Draft a step-by-step plan before
editing"), default **on**, persisted in `localStorage`.

### About the composer's slash commands

Typing `/` in the AI composer offers seven commands: `/create-short`, `/remove-silence`,
`/add-captions`, `/improve-pacing`, `/add-hook`, `/export-reels`, `/plan-edit`.

**Be honest about what these are.** Selecting one only **prefills the text box** with
`/<name> ` (`Composer.tsx` → `onChange('/' + command.name + ' ')`). There is no special routing,
no dedicated pipeline. The model reads the slash text as part of your prompt. Test them as
prompt shorthands, not as separate features — and where a plain-English phrasing is given below,
prefer it, because that is what a real user types.

---

## 2. Core timeline editing (manual)

`UI` · `desktop+browser` — this is the manual editing floor everything else sits on. If it is
broken, later sections will produce misleading results.

- [ ] **2.1 Import and place media**
  - Do: Assets rail → import your talking-head file → drag it to the timeline.
  - Expect: clip appears with a filmstrip and waveform; preview plays it.
  - Fail if: black filmstrip, no waveform, or preview will not play (desktop should resolve media
    over `fp-media://`).
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **2.2 Trim, split, delete, ripple delete, duplicate**
  - Do: drag a clip edge (trim); Toolbar **Split** or the Blade tool; **Delete**; **Ripple
    delete**; **Duplicate**.
  - Expect: each does exactly its named thing; ripple delete closes the gap, plain delete leaves
    it.
  - Fail if: ripple delete leaves a gap, or delete pulls downstream clips.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **2.3 Roll an edit point** — the one professional trim that *does* have a UI
  - Do: hold **Cmd/Ctrl** and drag the edge of a clip that is butt-joined to its neighbour.
  - Expect: both sides of the cut move together; total sequence duration unchanged; the drag
    ghost shows the roll.
  - Fail if: only the grabbed clip trims (that is a plain trim, not a roll), or the sequence
    duration changes.
  - **Flagged inconsistency:** `plan/PLAN.md`'s §7.2 audit states "a human editor cannot perform
    roll — there is no shortcut, menu item, or control that reaches them." That is not what the
    code does: `TimelineView.tsx:1565` resolves a roll neighbour on Cmd/Ctrl and
    `TimelineView.tsx:1629` calls `rollEditPatch`. Please confirm by hand and report — if it
    works, the plan needs correcting.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **2.4 Insert vs Overwrite drop mode**
  - Do: Toolbar → **Drop mode** segmented control → toggle "Overwrite — dropped clips land where
    they fall" / "Insert — dropped clips push downstream clips right". Drop a clip onto occupied
    timeline in each mode.
  - Expect: overwrite replaces; insert pushes everything right.
  - Fail if: both modes behave the same.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **2.5 Multi-select, batch move, snapping**
  - Do: shift-click / cmd-click several clips, drag them; toggle Toolbar **Snapping**; hold
    **Alt** while dragging to invert the snap.
  - Expect: the whole selection moves by one delta; snap indicator appears at edit points.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **2.6 Markers**
  - Do: Toolbar **Marker** (or the marker shortcut) at the playhead; jump next/previous.
  - Expect: marker on the ruler; jump navigation lands on it.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **2.7 Tracks**
  - Do: add a track, reorder it, remove it; use the track context menu for mute/solo/lock flags.
  - Expect: preview and the audio mixer respect mute/solo.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **2.8 Undo / redo integrity**
  - Do: perform 2.2–2.7, then `⌘Z` repeatedly back to the start, then `⌘⇧Z` forward.
  - Expect: exact restoration at every step. This is invariant 1 + the patch engine's invert
    contract; treat any drift as a serious failure.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 3. Professional edit operations (AI-only)

`AI` · `desktop+browser` — these route through the `professional_edit` tool, whose intents come
from `editor-capabilities.ts`'s `TIMELINE_SEEDS`. **Except roll (see 2.3) and insert (see 2.4),
no UI control reaches these.** Test them by typing in the AI rail, in **Agent** or **Edit** mode.

Shared setup for this whole section: place three or four B-roll clips butt-joined on one track,
click one to select it, and put the playhead where you want the operation to happen. The tool
resolves its target from the **live selection, playhead, and source monitor** — it will refuse
rather than guess.

- [ ] **3.1 Slip** — change what a clip shows without moving it
  - Do: select a clip → *"Slip this clip 12 frames later."*
  - Expect: the clip's position and duration on the timeline are unchanged; the content shown
    shifts (check the filmstrip thumbnails / scrub through it).
  - Fail if: the clip moves or changes length.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.2 Slide** — move a clip while neighbours absorb it
  - Do: select a middle clip → *"Slide this clip 10 frames to the right."*
  - Expect: the clip moves; its neighbours grow/shrink to compensate; sequence duration and the
    clip's own content unchanged.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.3 Ripple trim**
  - Do: *"Ripple trim 15 frames off the end of this clip."*
  - Expect: everything after it pulls earlier by exactly that; no gap left.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.4 Lift** (leave the gap)
  - Do: *"Lift this clip out and leave the gap."*
  - Expect: clip gone, gap remains, downstream clips unmoved.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.5 Extract** (close the gap)
  - Do: *"Extract this clip and close the gap."*
  - Expect: clip gone, everything after pulled earlier.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.6 Insert**
  - Do: select a source clip in the **Source Monitor**, set the playhead → *"Insert this at the
    playhead and push everything later."*
  - Expect: nothing is overwritten; downstream content moves right.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.7 Overwrite**
  - Do: *"Overwrite at the playhead with the source clip."*
  - Expect: what was there is replaced; sequence duration unchanged.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.8 Replace**
  - Do: select a clip → *"Replace this clip's media with <other asset name>, keep the timing."*
  - Expect: same position and duration, different footage.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.9 J-cut** (sound leads the picture)
  - Setup: you need a **linked picture/sound edit point** — a clip whose audio and video are
    linked at a cut.
  - Do: *"Make this a J-cut, bring the incoming audio in 20 frames early."*
  - Expect: incoming audio starts before its picture.
  - Fail if: the tool reports it cannot resolve a linked edit point — record that; it means your
    fixture lacks linkage, not necessarily that the capability is broken.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.10 L-cut** (sound trails the picture)
  - Do: *"Make this an L-cut, hold the outgoing audio 20 frames past the cut."*
  - Expect: outgoing audio continues past its picture.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.11 Sync safety refusal** (negative test — this one should *fail closed*)
  - Do: ask for an edit that would break picture/sound sync without saying it is allowed, e.g.
    *"Trim just the video side of this linked clip."*
  - Expect: linked edits preserve sync **by default**; desync must be explicit. The AI should
    either preserve sync or refuse, naming the reason. **A silent desync is a failure.**
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **3.12 Ambiguous target refusal** (negative test)
  - Do: with **nothing selected**, ask *"Slip it 10 frames."*
  - Expect: a refusal that names what it needs — not an edit to an arbitrary clip.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 4. Multicam / camera angles (AI-only, no UI at all)

`AI` · `desktop+browser` — `switch_angle`, via `professional_edit`. There are **zero** multicam
UI components in `apps/web-editor` (verified by grep for `cameraAngle` / `multicam`). The camera
angle group is schema v18 data; sync offsets are **authored, never inferred** — nothing is
derived from filenames or folders.

- [ ] **4.1 Camera switch at the playhead**
  - Setup: a project with a camera angle group and an **authored sync offset** between two
    angles. Since there is no UI to author this, you will need a project file that already has
    it, or the AI must be able to establish it — record which.
  - Do: put the playhead mid-clip → *"Cut to camera 2 here."*
  - Expect: a cut at the playhead; the new angle resumes at the **same instant** (through the
    sync offset), **not** the same source timestamp; the **sound is untouched**.
  - Fail if: the second angle starts from its own timecode, or the audio changes.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **4.2 Unsynced camera refusal** (negative test)
  - Do: ask to switch to an angle with **no authored sync**.
  - Expect: a refusal that **names the offset it needs**. Fail-closed is the correct behaviour
    here; a guessed switch is a failure.
  - Result: __/__/____ · PASS / FAIL · notes:

> **Reachability caveat, please confirm.** With no UI to create a camera angle group, whether a
> user can reach §4 at all from a cold start depends on the AI being able to author the group and
> sync offset. Discovery did not confirm a user-reachable authoring path. If you cannot set this
> up by hand, move §4 to §20 and say so.

---

## 5. Transcription

`UI+AI` · `desktop` (the sidecar / IPC does the work; a plain browser build has no engine)

- [ ] **5.1 Transcribe from the panel** — `UI`
  - Setup: S5 done. Talking-head clip on the timeline. Project saved.
  - Do: Topbar → **Transcription** → transcribe the clip.
  - Expect: progress reporting; then a transcript with clickable lines; clicking a line seeks the
    playhead; search filters lines; per-clip "Copy the transcript" works.
  - Fail if: it silently completes with no words, or the seek lands in the wrong place.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **5.2 Transcribe on import** — `UI`
  - Do: Settings → AI → Transcription = **On import**; import a new speech clip.
  - Expect: transcription warms in the background without you asking.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **5.3 The AI transcribes when it needs to** — `AI`
  - Do: with an untranscribed clip, ask *"What does she say in the first minute?"* in **Chat**
    mode.
  - Expect: the run transcribes (you should see a transcribe/read-transcript activity card) and
    answers from the actual words.
  - **Known architectural split:** the manual panel path and the agent path are **different code
    paths** (manual = IPC/host provider, agent = sidecar). Test both; a pass on one is not a pass
    on the other.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **5.4 Provider swap**
  - Do: run 5.1 once with **Local**, once with **TwelveLabs**.
  - Expect: both produce a usable transcript. TwelveLabs sends media off-device — confirm the
    hint says so before you accept it.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 6. Captions

`UI+AI` · `desktop` for generation (needs a transcript), `desktop+browser` for restyling

Caption templates: **51** in the catalog (`packages/timeline-schema/src/caption-templates.ts`),
reachable by family from both the Captions rail and the AI.

- [ ] **6.1 Generate a caption track** — `AI`
  - Setup: 5.1 passed for this clip.
  - Do: *"Add word-by-word captions from the transcript."* (or the `Animate Captions` quick
    action, or `/add-captions`).
  - Expect: a caption track appears; cues line up with the spoken words in preview.
  - Fail if: cues drift off the speech, or the track is empty.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **6.2 Browse and apply a caption style** — `UI`
  - Do: left rail → **Captions** → search the gallery, filter by category, click a template.
  - Expect: the caption overlay in the preview changes to that template's look immediately.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **6.3 Restyle by asking** — `AI`
  - Do: *"Use a bolder caption style with a yellow highlight."*
  - Expect: the AI browses the catalog and applies a template. Watch the activity cards: you
    should see a style-discovery read followed by a track-level style change.
  - **Regression watch (recently fixed, worth re-confirming):** the run must **not** loop —
    re-reading the style it already knows, or reporting the same styling repeatedly.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **6.4 Auto-emphasis** — `AI`
  - Do: *"Emphasise the key words in the captions."*
  - Expect: selected words get the template's accent treatment. Once. The run should report
    emphasis as **emphasis**, not as a generic "Set track caption style", and must not retry work
    already applied.
  - Fail if: the run applies it repeatedly, or the completion report lists bare
    `Set track caption style:` rows with dangling colons.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **6.5 Edit a cue by hand** — `UI`
  - Do: Captions rail → click a caption row → edit its text; split a cue; merge two cues.
  - Expect: the preview updates; timing stays sane.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **6.6 Caption verification** — `AI`
  - Do: on a **fast-cut montage with captions**, ask *"Check the captions are in sync."*
  - Expect: a short, readable list of genuine problems. A caption spanning several **picture**
    cuts is fine now; only a caption bridging a real **speech** break should be flagged, and a
    caption is "out of date" only when it has genuinely drifted off its words.
  - Fail if: you get dozens of warnings on a montage whose captions are visibly fine, or the AI
    refuses to edit because "there is nowhere to put a caption".
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **6.7 Burn-in on export**
  - Covered in §19.2 — check the caption burn-in option there.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 7. Silence removal

`AI` · `desktop` **only** — `analyze_silence` is an `analysis` tool; the engine sidecar computes
it. There is **no silence-removal UI panel** (verified by grep across `apps/web-editor`). A
browser build cannot do this at all.

- [ ] **7.1 Detect and remove silent gaps**
  - Setup: talking-head clip with real pauses, on the timeline. Sidecar green (S3).
  - Do: *"Remove the silent gaps to tighten the cut."* (or the `Trim Silence` quick action, or
    `/remove-silence`).
  - Expect: an **Analyze silence** activity card, then ripple deletes; the sequence gets
    measurably shorter; speech is not clipped at the boundaries.
  - Fail if: words are cut off at gap edges, gaps are left behind, or the run reports silence
    counts but applies nothing.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **7.2 Threshold steering**
  - Do: *"Remove only pauses longer than one second."*
  - Expect: short breaths survive; long pauses go.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **7.3 Undo the whole pass as one action**
  - Do: `⌘Z` once after 7.1.
  - Expect: the entire run reverses as **one** undo step, not clip-by-clip.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 8. Pacing and speed

`UI+AI` · `desktop+browser` (speed UI) / `desktop` (AI pacing, which reads the media)

- [ ] **8.1 Set clip speed** — `UI`
  - Do: select a clip → right rail **Inspector** → Speed section → change the rate.
  - Expect: clip length changes accordingly; audio pitch/behaviour matches the section's stated
    handling.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **8.2 Speed ramp / curve, freeze, reverse** — `UI`
  - Do: Inspector → Speed → author a ramp; try freeze and reverse.
  - Expect: preview shows the ramp; scrubbing through it is smooth.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **8.3 Punch-in** — `UI+AI`
  - UI: Inspector → **Transform** section → punch in.
  - AI: *"Punch in on the second half of this clip."*
  - Expect: a scale/position push toward the subject, visible in preview.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **8.4 Improve pacing (whole edit)** — `AI`
  - Do: *"Improve this edit: tighten pacing and fix obvious issues."* (the `Improve Edit` quick
    action, or `/improve-pacing`).
  - Expect: a multi-step Agent run that reads the timeline, tightens slow sections, and reports
    what it changed. Every change should be visible on the timeline.
  - Fail if: the run narrates a plan and applies nothing, or the completion report claims work it
    did not do.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 9. Hooks and short-form restructuring

`AI` · `desktop`

- [ ] **9.1 Add a hook**
  - Setup: talking-head clip with transcript.
  - Do: *"Find the strongest moment and restructure the opening around it."* (or `/add-hook`).
  - Expect: the run reads the transcript, identifies a candidate, and moves/duplicates it to the
    front as real timeline operations.
  - Fail if: it only *suggests* a hook without editing — in Agent mode that is a failure, since
    edits auto-apply.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **9.2 Create a short**
  - Do: *"Turn this into a 45-second vertical short."* (or `/create-short`).
  - Expect: a long multi-step run — reads footage, selects segments, cuts, and reports. Watch it
    to completion.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **9.3 Plan without mutating**
  - Do: switch to **Chat** mode (or use `/plan-edit`) → *"Give me an edit plan for this footage.
    Do not change anything."*
  - Expect: a structured plan. **The timeline must not change.** Verify by checking the History
    panel is unchanged.
  - Fail if: any patch lands. Chat mode must be read-only.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 10. Transitions

`UI+AI` · `desktop+browser`

- [ ] **10.1 Browse and apply from the panel** — `UI`
  - Do: select a cut → left rail **Transitions** → search, filter by category, click one.
  - Expect: it lands on the selected cut; the panel's target line says where it will go and turns
    blocked when there is no valid cut.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **10.2 Suggested-for-this-cut** — `UI`
  - Do: with a cut selected, look at the **"suggested for this cut"** section.
  - Expect: recommendations with a stated reason on each card.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **10.3 Preview thumbnails** — `UI`
  - Expect: each transition card renders a live thumbnail, not a static placeholder.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **10.4 Transition parameters** — `UI`
  - Do: select a clip with a transition → Inspector → **Transition** section: duration,
    alignment, audio mode, per-kind parameters, reset, disable, swap kind, remove.
  - Expect: every control changes the preview.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **10.5 Apply to all cuts** — `UI`
  - Do: use the apply-to-all-cuts affordance.
  - Expect: every valid cut gets it; invalid cuts are skipped rather than corrupted.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **10.6 Add a transition by asking** — `AI`
  - Do: *"Put a cross dissolve on every cut in this sequence."*
  - Expect: a **Browse transitions** / **Add transition** activity trail, then transitions on the
    timeline.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **10.7 Transition verification** — `AI`
  - Do: *"Check the transitions are correct."*
  - Expect: a plain-language report of what exists and what is wrong — not a raw data dump.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 11. Effects

`UI+AI` · `desktop+browser`

Effect layers come from `packages/timeline-schema/src/effect-catalog.ts`. `EffectsPanel.tsx`
states that **nothing in the panel is a placeholder** — every entry should do something.

- [ ] **11.1 Browse and apply** — `UI`
  - Do: left rail **Effects** → search, filter by category, click an effect card.
  - Expect: it applies to the selection and the preview changes visibly.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **11.2 Effect thumbnails** — `UI`
  - Expect: cards render a real preview of the effect, not a generic icon.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **11.3 Effect layers: add, reorder, duplicate, remove, enable/disable** — `UI`
  - Do: use the effect layer chips / layer menu on a clip.
  - Expect: order matters and is respected in preview; disabling bypasses without deleting.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **11.4 Effect parameters** — `UI`
  - Do: **Effect Inspector** → change parameters.
  - Expect: live preview response.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **11.5 Apply an effect by asking** — `AI`
  - Do: *"Add a subtle film grain to the B-roll clips."*
  - Expect: a **Discover effects** read, then the effect applied to the right clips.
  - Fail if: the AI claims it added an effect but no effect layer exists on the timeline. (This
    exact overclaim shape has regressed before — check the timeline, not the chat.)
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 12. Scene, beat, and media analysis

`AI` · `desktop` **only** — all sidecar `analysis` tools.

- [ ] **12.1 Scene detection**
  - Do: *"Where are the scene changes in this clip?"*
  - Expect: a **Detect scenes** card and timestamps that match what you see.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **12.2 Beat detection**
  - Setup: music track on the timeline.
  - Do: *"Find the beats in the music."*
  - Expect: a **Detect beats** card with a plausible tempo/onset list.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **12.3 Cut to the beat** — the one to test carefully
  - Do: with B-roll and a music bed, *"Cut this montage to the music."*
  - Expect: cuts land **on** detected beats. Recent behaviour: when the AI has measured the
    music, a cut slightly off is **snapped onto the beat**, and a badly-off cut is **refused with
    the nearest real beat named**. There is no setting for this.
  - Fail if: cuts sit visibly off-beat while the run reports beat detection succeeded.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **12.4 Media probe**
  - Do: *"What resolution and frame rate is this clip?"*
  - Expect: a **Probe media** card with correct values (cross-check with `ffprobe`).
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **12.5 Edit-boundary reading**
  - Do: after making several cuts, *"Where are all the cuts?"*
  - Expect: a readable list of cut positions, in plain language — not raw JSON.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 13. Motion and keyframes

`UI+AI` · `desktop+browser`

Keyframeable clip properties: **scale, x, y, rotation, opacity** (`CLIP_KEYFRAME_PROPERTIES` /
`motionCapabilities`).

- [ ] **13.1 Set a transform by hand** — `UI`
  - Do: Inspector → **Transform** → scale/position/rotation/opacity; or drag in the preview
    (`PreviewTransform`).
  - Expect: preview follows immediately.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **13.2 Keyframe a property** — `UI`
  - Do: Inspector → the **keyframe button** next to a property → set a value at two playhead
    positions.
  - Expect: keyframes appear on the timeline row; the property animates between them.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **13.3 Keyframe editing on the timeline** — `UI`
  - Do: move, delete, and multi-select keyframes; change easing; drag bezier handles.
  - Expect: the motion curve changes accordingly.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **13.4 Animate by asking** — `AI`
  - Do: select a clip → *"Slowly zoom this clip from 100% to 115% over two seconds."*
  - Expect: an **Animate clip properties** card and real keyframes on the clip. The tool takes an
    editorial objective plus **duration in frames** — it should not be asking you for raw
    keyframe arrays.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **13.5 Canvas-cover constraint** (negative test)
  - Do: *"Scale this clip down to 40%."*
  - Expect: if that would leave the canvas uncovered, the tool **fails closed** with a reason
    rather than producing black edges.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 14. Color grading

`UI+AI` · `desktop+browser`

Parameters (`COLOR_GRADE_PARAMETER_CONTRACTS`): **exposure** (−5…5), **contrast** (−1…1),
**saturation** (−1…3), **temperature** (−1…1), **tint** (−1…1), **shadows** (−1…1),
**highlights** (−1…1). Grades apply to the **clip as a whole**, not per frame — they are not
keyframeable.

- [ ] **14.1 Grade by hand** — `UI`
  - Do: select a clip → Inspector → **Color** section → move each parameter.
  - Expect: preview responds to all seven.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **14.2 Grade by asking** — `AI`
  - Do: *"Warm this shot up and lift the shadows a little."*
  - Expect: a **Correct shot color** card; the Inspector's Color values change to match.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **14.3 Shot matching across a recording** — `AI`
  - Setup: several clips cut from the **same** source recording.
  - Do: *"Match the grade across these shots."*
  - Expect: shot grouping expands one shot into **every clip cut from the same recording** — a
    fact about the footage, not a similarity guess. Clips from a *different* recording should
    not be swept in.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **14.4 Skin preservation** (behaviour check)
  - Setup: a clip with a face in frame.
  - Do: ask for an aggressive white-balance match.
  - Expect: the match is held back until skin warmth stays inside ~8%, and it **refuses when
    there is too little skin to read** — naming that. A refusal here is a pass.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **14.5 Measure shot color** — `AI`
  - Do: *"Measure the colour of this shot."*
  - Expect: a **Measure shot color** card with real values.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 15. Audio mixing

`UI+AI` · `desktop+browser`

Capabilities (`audioCapabilities`): **gain** (−120…24 dB), **fade in**, **fade out** (frames),
**normalize peak**, **sidechain duck** (−60…0 dB, default −12), **EQ**, **compression**, and a
**gain automation lane**. The stated chain order is
`mute → normalize → EQ → compressor → fader`. All of it extends the one canonical `audio_gain`
effect (ADR 0113).

- [ ] **15.1 Clip gain and fades** — `UI`
  - Do: select an audio-bearing clip → Inspector → **Audio** section → gain, fade in, fade out.
  - Expect: waveform and playback reflect the change.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **15.2 Preview audio mixer** — `UI`
  - Do: open the preview audio mixer; adjust per-track levels; mute/solo.
  - Expect: playback follows.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **15.3 Normalize** — `AI`
  - Do: *"Normalize this clip's level."*
  - Expect: a **Mix audio** card; loudest point moved to target without squashing dynamics.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **15.4 Ducking** — `AI`
  - Setup: music track under a speech track.
  - Do: *"Duck the music under the speech."*
  - Expect: music dips whenever speech is present.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **15.5 EQ and compression** — `AI`
  - Do: *"Make the voice clearer — cut the low rumble and even out the level."*
  - Expect: EQ and compressor land as one `audio_gain` chain in the stated order.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **15.6 Automation lane vs static level** (negative test)
  - Do: ask for **both** a static gain and a gain automation lane on the same clip.
  - Expect: a lane **supersedes** the static level rather than multiplying with it, and authoring
    both is **refused, naming the fix**. A silent multiply is a failure.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **15.7 Fix Audio quick action** — `AI`
  - Do: composer quick action **Fix Audio**.
  - Expect: a coherent multi-step audio pass, all changes visible.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 16. Masking and tracking

`UI+AI` · `desktop+browser` for authoring; the AI's tracking runs deterministically

> **Read this before testing.** Only **manual** mask tracking exists. `professional_tracking_mask`
> "tracks the existing bounded rectangle/ellipse mask on the selected shot using deterministic
> manual corrections" and explicitly says **automatic face/object/planar/segmentation tracking is
> unavailable until a real CV engine is installed.** `detect_faces` and `generate_mask` are
> registered as `available: false` on purpose (`domain-tools/tracking-mask.ts`) — the orchestrator
> refuses them rather than fabricating a result. See §20.

- [ ] **16.1 Add a mask** — `UI`
  - Do: add a mask to a clip from the Inspector.
  - Expect: a mask appears in the preview.
  - **Known limitation, verify it is still true:** `addMaskPatch`
    (`patch-builders-base.ts:1241`) **hardcodes** `bounds` to the centre 60%
    (`{x:0.2, y:0.2, width:0.6, height:0.6}`). There are no handles or numeric fields to place
    it. So the engine can mask, but a user **cannot author mask geometry**.
  - Record: can you move or resize the mask at all? If not, this row is **FAIL (not user-
    operable)** and everything downstream of it in §16 inherits that.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **16.2 Track an existing mask** — `AI`
  - Setup: 16.1 produced a mask, and it happens to sit over a moving subject.
  - Do: select the clip → *"Track this mask across the shot."*
  - Expect: a **Track mask** card; per-frame positions written; the mask follows the subject in
    preview.
  - Fail if: it invents coordinates, or claims a track with no per-frame data behind it.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **16.3 Automatic tracking refusal** (negative test — the important one)
  - Do: *"Automatically find and track the person in this shot."*
  - Expect: a clear statement that automatic subject tracking is **unavailable** and requires the
    on-demand Subject Intelligence Capability Pack. **No tracker is silently bundled or
    downloaded.**
  - Fail if: the AI claims it tracked something. That is exactly the fabrication the registry is
    built to prevent.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 17. Footage understanding and semantic search

`UI+AI` · `desktop` · **needs a TwelveLabs key or an embeddings key** (S6)

ADR 0070 / 0071 / 0097: an optional hosted understanding backend behind a typed facade.

- [ ] **17.1 Build the footage map** — `UI`
  - Do: Topbar → **Footage understanding** → build / **Rebuild the footage map**.
  - Expect: staged progress ("Mapping chapters and highlights…"), then chapters and highlights.
  - **With no key**, expect the honest message: *"No understanding key is configured. Add a
    TwelveLabs or embeddings key…"* — that message appearing is itself a pass for the
    unconfigured case.
  - **On a plan without generative understanding**, expect: *"Generative understanding is not
    available on this TwelveLabs plan."*
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **17.2 Map survives reopen and does not re-bill** — `UI`
  - Do: close and reopen the project; open the panel again.
  - Expect: the cached map is served **immediately**, without re-indexing and without another
    provider charge. Project ids are deterministic, so this must hold.
  - Fail if: it re-indexes on reopen. That is both a data-loss and a billing bug.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **17.3 Semantic footage search** — `AI`
  - Do: *"Find the shots where someone is at a whiteboard."*
  - Expect: a **Search visual evidence** / **Find similar** card and results that actually match.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **17.4 Describe footage** — `AI`
  - Do: *"Describe what happens in this clip."*
  - Expect: a **Describe footage** card and a description grounded in the actual footage.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **17.5 The AI looks at a frame** — `AI`
  - Setup: a **multimodal** model configured (S4).
  - Do: *"Look at the frame at 00:15 and tell me what's in it."*
  - Expect: a **See the frame** card and an answer that matches the frame.
  - Fail if: it describes something that is not there, or claims to have looked without the card
    appearing.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **17.6 Missing-evidence honesty** (negative test)
  - Do: with **no** key configured, ask a question that needs visual understanding.
  - Expect: it states plainly that it cannot see the footage. **Missing evidence is stated, not
    implied** (ADR 0118).
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 18. The AI run itself — control, honesty, recovery

`UI` · `desktop+browser` (the run machinery) — these are capabilities in their own right, and
several are recent fixes worth confirming by hand.

- [ ] **18.1 Chat mode is read-only**
  - Do: **Chat** → *"Delete the first ten seconds."*
  - Expect: it discusses; the timeline does **not** change.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.2 Edit mode does one shot**
  - Do: **Edit** → *"Trim two seconds off the start of the selected clip."*
  - Expect: one edit, applied, receipt card shown.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.3 Agent mode with Plan first**
  - Do: **Agent**, **Plan first** on → give a multi-step request (e.g. §9.2).
  - Expect: a drafted plan appears first, then the run follows it; steps mark off as they
    complete.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.4 Plan approval gate**
  - Do: request something with a large blast radius with Plan first on.
  - Expect: the plan approval card appears before the work starts.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.5 Mid-run steering**
  - Do: while a long run is going, type a steering message.
  - Expect: the run takes it into account without restarting.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.6 Cancel**
  - Do: press **Stop agent** mid-run.
  - Expect: it stops **immediately** with nothing half-applied.
  - Fail if: an edit lands after you cancelled, or the project is left inconsistent.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.7 Crash / restart recovery**
  - Do: start a long run; quit the app (or reload) mid-run; reopen the project.
  - Expect: the run is recovered from its durable log; you are not silently left with a
    half-finished edit and no record.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.8 The run does not narrate its own machinery** (ADR 0130 — recent fix)
  - Do: run several multi-step edits and read every reply.
  - Expect: **no** sentences like *"I'll continue from the interpret stage"* or *"I'll continue
    from where the run left off"* — in the chat, in the diff card's Summary, or in the Reason
    stored on the edit.
  - Also check: reopen the History panel and read the reason on an AI edit. Same rule.
  - Fail if: any such sentence appears anywhere. Test on a normal run, a cancelled one, and a
    retried one.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.9 The completion report is accurate** (ADR 0131 — recent fix)
  - Expect: each change named with **action + subject + detail** (e.g. `Deleted range Video 1 ·
    0s–3s`), identical lines collapsed to one row with `(×N)`, and **no** claim that changes
    "did not validate" when they simply were already in place.
  - Fail if: bare `Set track caption style:` rows, dangling colons, or a skipped-count that
    includes already-applied no-ops.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.10 No overclaimed verification**
  - Do: make a request naming effects or transitions, and watch a run that does **not** call
    those tools.
  - Expect: the internal check must **not** report your whole request as passed. It covers
    timeline consistency only and should be labelled as such.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.11 Wipe guard** (negative test)
  - Do: *"Start over."* / *"Clear the timeline and begin again."*
  - Expect: a full-track ripple delete is **blocked**; you get a confirmation or a refusal, not a
    wiped project.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.12 Ask-the-user round trip**
  - Do: make a genuinely ambiguous request (*"Cut this down."* with two very different clips
    selected).
  - Expect: an **A question for you** card that waits for your answer and then continues.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.13 Context chips and pinning**
  - Do: check the **Included context** chips reflect the selection/playhead; remove one; use
    `@` to pin a clip or asset.
  - Expect: chips update; a removed chip stays out of the next turn.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.14 Conversation export and copy** (recent fix)
  - Do: sidebar **⋯** menu → **Copy transcript** and **Export transcript**; History drawer row →
    **Copy Markdown** / **Export Markdown**.
  - Expect: the **whole run** — thinking, each tool call with arguments and raw result, every
    proposed edit with operations and validation issues, status changes, cost, resume checkpoint.
  - Fail if: the export contains only chat messages.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.15 Cmd+K scoped edit**
  - Do: select a clip → `⌘K` → type a scoped instruction.
  - Expect: the palette submits a scoped edit against that selection; the AI rail can also be
    opened from the palette.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.16 Context window indicator and cost**
  - Expect: the context indicator and cost reporting move in step with the run. Every extra
    billed call must be one you asked for.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **18.17 Variations (browser-only — known desktop gap)**
  - The "2 alternative takes" toggle in **Edit** mode is **hidden when an Electron bridge is
    present** — it is browser-only by design, and deliberately hidden rather than offered and
    silently ignored. Each take is a separately billed model call, so it is off by default.
  - Do (browser build only): enable it and submit an edit.
  - Expect: two alternative takes offered.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 19. Preview, render, and export

`UI` · **desktop only** — the render engine is Python (MoviePy + FFmpeg) behind the sidecar. A
browser build cannot export, and cannot generate proxies. This is an accepted browser gap.

- [ ] **19.1 Preview playback and transport**
  - Do: play, pause, `J`/`K`/`L`, frame step, second step, go to start/end, previous/next edit
    point.
  - Expect: accurate frame cadence; the playhead and preview agree.
  - **Rule:** preview is HTML video / canvas / proxy media. If you ever see MoviePy driving live
    preview, that is an architecture violation, not a bug.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **19.2 Export**
  - Do: Topbar → **Export video** → pick a preset → export.
  - Presets: **Instagram Reels (9:16)**, **TikTok (9:16)**, **YouTube Shorts (9:16)**, **YouTube
    (16:9)**, **Square (1:1)**.
  - Also exercise: **caption burn-in**, **loudness preset** (None / Social −14 LUFS / Podcast
    −16 LUFS / Broadcast −23 LUFS), **master EQ preset** (None / Flat / Warm / Bright / Voice
    clarity).
  - Expect: the project saves first, progress streams, the file lands, and **Reveal** opens it.
    Play the output: it must match the timeline.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **19.3 Render validation**
  - Expect: every render is checked automatically after it runs (invariant 4). A failed
    validation must surface as a failure, not a silent pass.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **19.4 Export by asking** — `AI`
  - Do: *"Export this for Reels."* (or `/export-reels`).
  - Expect: an **Export video** action card and a real file. The AI requests the export; the host
    performs it.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **19.5 Render preview** — `AI`
  - Do: *"Render a preview of this section so you can check it."*
  - Expect: a **Render preview** card and an actual rendered result the run then reasons about.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **19.6 History panel and AI-run undo**
  - Do: `⌘⇧H` → inspect the history; undo an AI run from there.
  - Expect: an AI run undoes as **one** action; the entry names what changed and where.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **19.7 Long-media behaviour**
  - Do: repeat 19.1–19.2 with a **feature-length** file, not a fixture.
  - Expect: adaptive program preview keeps scrubbing usable; proxies are generated (desktop
    only); export completes within `FRAMEPILOT_RENDER_TIMEOUT_SECONDS` (default 900).
  - Result: __/__/____ · PASS / FAIL · notes:

---

## 20. Not yet manually testable

These exist in the codebase but a user **cannot** reach them end-to-end today. They are listed so
you know the omission is deliberate. Do not write test procedures for them; if one becomes
reachable, move it up.

| Capability | Where it exists | Why it is not testable |
| --- | --- | --- |
| **Subject mask generation** (`generate_mask`) | `domain-tools/tracking-mask.ts`, `available: false` | **Permanently unavailable by design, not a gap.** Segmentation produces a bitmap; the timeline mask model steers by rectangle bounds. The measured path that exists is `track_subject_automatically` with `subject="silhouette"` — see §22. |
| **Text behind object** (PRD §6.6) | `engine/python/.../masking/mask.py` | Segmentation now exists (§22), but no user path composites text behind the returned matte. Engine ✓, no entry point. |
| **Local semantic vision review pack** | `VisionRunReviewControls`, temporal/vision review | The Subject Intelligence worker now exists and installs locally (§22), but its adoption by `VisionRunReviewControls` is unconfirmed. Cloud review is consent-gated only. |
| **Mask geometry authoring** | `addMaskPatch` | `bounds` is **hardcoded** to the centre 60%; no handles, no numeric fields. Engine ✓, UI not operable. Masking is only *partly* testable — see §16.1. |
| **Multicam angle-group authoring** | Schema v18 camera angle groups | **Zero** multicam UI components. Whether §4 is reachable at all depends on the AI authoring the group — unconfirmed. See the §4 caveat. |
| **`autocomplete` AI mode** | `orchestrator.ts` (`AiMode` includes `'autocomplete'`) | The sidebar exposes only `agent` / `chat` / `edit`. No UI entry point. |
| **Capability Pack install flow — the signed-catalog path** | `CapabilityPackDependencyDialog`, `CapabilityPackStorageSettings`, `apps/desktop/electron/capability-packs/` | The **download-from-catalog** half is still unreachable: no signed published catalog and no signing credentials (C6). Catalog and artifact URLs are hard-required to be `https:`, so a `file://` catalog cannot stand in. The **installed-pack** half is fully testable via local registration — see §22. |
| **Export/preview columns of the §7.2 capability matrix** | `plan/PLAN.md` | The plan itself marks these `?` — explicitly **not audited**. Do not infer status from this document either. |

---

## 21. Discovery notes, caveats, and things to confirm

Written down so the next person does not have to re-derive them, and so anything I could not
confirm is visible rather than papered over.

1. **AI edits auto-apply, and there is no Accept/Reject.** `patchPolicy: 'auto_commit'`.
   `DiffCard`'s doc comment says "Edits now apply as they land, so this card's job is narrower and
   quieter" — and `EventNode.tsx` contains **no** `Accept`/`Reject` control outside that comment,
   so the second paragraph of that comment (describing `A`/`R`/`P` bindings) is **stale text
   describing a removed UI**. Your rollback is `⌘Z` / History, full stop. Worth fixing that
   comment separately; it is not a product bug.
2. **Slash commands are prompt prefills, not routes.** No dedicated pipeline. Documented in the
   §1 orientation.
3. **Roll contradicts the plan.** `plan/PLAN.md` says the UI has no roll; `TimelineView.tsx` has
   one on Cmd/Ctrl-drag. Flagged at §2.3. This document does **not** silently pick a side.
4. **The UI does not go through `EditorCommand`; the AI and MCP do.** The web-editor builds raw
   operations in `patch-builders-base.ts`. Consequence for you: a stale **AI** command is
   rejected by the revision guard, while a stale **UI** edit is not. If you see a divergence
   between a UI action and its AI equivalent, this is why.
5. **Manual vs agent transcription are different code paths** (manual = IPC / hosted provider;
   agent = sidecar, local). §5.3 says so; test both.
6. **`professional_*` tools require a live editor interaction snapshot.** They throw without one.
   Always click a clip and place the playhead before testing §3, §13, §14, §15, §16.
7. **Motion / colour / audio are registered as `property`, not `command`** in the capability
   registry. Whether the §7.1 command contract covers them is **unresolved in the plan itself**.
   Their procedures are written from the tool descriptions and the parameter contracts, which are
   authoritative for behaviour.
8. **Transitions and captions have working UI + AI but no capability-registry entry.** Their rows
   here come from the panels and patch builders, not from `listEditorCapabilities()`.
9. **Counts.** 51 caption templates is verified against `caption-templates.ts` and corroborated by
   `CHANGELOG.md`. Effect and transition catalog counts were **not** pinned to a confident number
   and so are not stated.
10. **Browser gaps are systematic, not incidental.** `isDesktop()` is simply "is there a bridge".
    No bridge ⇒ no sidecar ⇒ no analysis tools, no proxies, no export, no render preview. Test
    the browser build only for the UI-only rows, and only if you care about it.
11. **Placement.** This file sits at the repo root beside `AGENTS.md` / `CLAUDE.md` /
    `PROGRESS.md`, matching the existing root-level working-document convention. The nearest
    alternative home would be `docs/guides/` (which holds `release-checklist-v1.md`) — move it
    there if you would rather this be a published guide than a working checklist.

---

## 22. Capability Pack media intelligence (locally registered packs)

`AI` · `desktop` — automatic tracking, subject detection, and segmentation. These run in an
isolated Capability Pack worker (ADR 0114), so they need a pack **installed** before any of it is
reachable. They are honest about absence: with no pack installed the agent returns an install
proposal, never a fabricated track.

### 22.0 Setup — register the packs locally (once per machine)

There is no signed catalog yet, and you cannot fake one: both the catalog URL and every artifact
URL are hard-required to be `https:`. The supported development path is
`framepilot-pack register-local`, which skips the catalog but still runs the pack through the
**same isolated health check** a signed install would run, and writes a real store record.

```bash
pnpm packs:register        # registers every locally buildable pack, then prints the store
```

That is a thin wrapper over the per-pack scripts, which you can also run individually:

```bash
./scripts/dev-register-tracking-lite.sh          # point / region / planar tracking
./scripts/dev-register-subject-intelligence.sh   # face / person / object detection + segmentation
```

`pnpm packs:register` deliberately continues past a pack that fails to build, reports every
outcome, and exits non-zero if any failed — so one broken pack does not leave the other
unregistered.

All of them are gated by `FRAMEPILOT_DEV_PACK_REGISTRATION=1`, which the scripts set only for the
registration call. Never set it in a packaged build. The store lands in
`~/Library/Application Support/@framepilot/desktop/capability-packs` — note `@framepilot/desktop`,
not `FramePilot`, because `app.setName()` is never called.

`pnpm packs:register` ends by reading the store back and printing it; every row must read
`installed healthy`. To check it later without re-registering:

```bash
node -e "const d=require(process.env.HOME+'/Library/Application Support/@framepilot/desktop/capability-packs/index.json');d.records.forEach(r=>console.log(r.identity.id,r.identity.version,r.state,r.health.status))"
```

The registered payload points at the worker's `.venv` in your checkout — if you delete or move
`workers/*/.venv`, re-run the script.

- [ ] **22.0 Packs registered** — Result: __/__/____ · PASS / FAIL · notes:

### 22.1 Subject detection — faces, people, objects

- Setup: 22.0 done. Import footage that actually contains people.
- Do: right rail → **AI** (Agent mode) → "find the faces in this clip".
- Expect: detections come back as **evidence**, with confidences; the timeline is not mutated by
  detection alone. Nothing found returns nothing — there is no fallback centre-frame box.
- Fail if: a detection appears on footage with no people in it, or every box is identical/centred
  (that is a fabricated result, which the pack is specifically built not to produce).
- **Verified at the worker level on 2026-08-25**, not yet through the UI: the installed pack
  returned 82 detections (66 face, 16 person) on the pinned group-photo fixture and `[]` on
  footage with no people. UI-level confirmation is what this row is for.
- Result: __/__/____ · PASS / FAIL · notes:

### 22.2 Automatic tracking — point / region / planar

- Setup: 22.0 done. A clip with a clearly moving subject.
- Do: select the clip, place the playhead, then ask "track this subject and make the text follow
  it" (or use `track_subject_automatically`).
- Expect: keyframes are written from **measured** samples; a lost target freezes the last known
  box and is reported lost rather than extrapolated into invented motion.
- Fail if: motion continues smoothly through a full occlusion (that is invention), or the run
  claims success while writing no keyframes.
- Note: `professional_*` tools need a live interaction snapshot — click a clip and place the
  playhead first, or the tool throws (§21.6).
- Result: __/__/____ · PASS / FAIL · notes:

### 22.3 Silhouette segmentation

- Setup: 22.0 done. A clip with a reasonably large person — PPHumanSeg is portrait/half-body
  trained and will honestly refuse a tiny distant figure.
- Do: ask to track a subject with `subject="silhouette"`.
- Expect: the mask follows the measured silhouette's bounding box.
- Fail if: an all-zero or full-frame "mask" is returned instead of a `target_lost` refusal.
- **Known-good vs known-refusal, verified at the worker level:** a point prompt resolved against a
  real person detection returned a genuine RLE mask (confidence 0.70); a small region holding a
  distant face correctly returned `target_lost`. A refusal on a small subject is **correct
  behaviour**, not a bug.
- Result: __/__/____ · PASS / FAIL · notes:

### 22.4 The honest refusal when no pack is installed

- Setup: temporarily move the store aside:
  `mv ~/Library/Application\ Support/@framepilot/desktop/capability-packs{,.bak}`
- Do: ask for automatic tracking.
- Expect: an explicit **install proposal**, and no timeline change. Nothing downloads silently.
- Fail if: the agent fabricates a track, or a download starts without approval.
- Restore the store afterwards (`mv` it back).
- Result: __/__/____ · PASS / FAIL · notes:

---

## Session log

| Date | Sections covered | Passed | Failed | Notes |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
