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

| Tag     | Meaning                                                                    |
| ------- | -------------------------------------------------------------------------- |
| `UI`    | An explicit control exists — button, panel, drag gesture, shortcut.        |
| `AI`    | Only reachable by asking the AI in natural language. No UI control exists. |
| `UI+AI` | Both paths exist; test both, they are different code paths.                |

**Surface tags**: `desktop` (needs the Electron shell and/or the Python sidecar) ·
`desktop+browser` (works in a plain `pnpm --filter @framepilot/web-editor dev` build too).

**A note that changes how you read every AI row:** AI edits **auto-apply**. The sidebar submits
with `patchPolicy: 'auto_commit'` (`AiSidebar.tsx`), and the diff card in the run is a _receipt_
for a change already on the timeline, not an approval gate. So "expect" for an AI capability is
always **the timeline changed**, and your rollback is `⌘Z` or the History panel — not a Reject
button.

---

## 1. Shared setup — do this once per testing session

- [ ] **S1. Toolchain and build**
  - `pnpm install`
  - `pnpm engine:sync` (uses `uv` in `engine/python`)
  - `cp .env.example .env` if you have not already.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **S2. Launch the desktop app**
  - `pnpm desktop:dev` (alias for `pnpm --filter @framepilot/desktop dev`).
  - This builds `shared-types → timeline-schema → editor-core → ai-sdk`, starts Vite on
    `localhost:5173`, and launches Electron against it.
  - **Gotcha:** `@framepilot/ai-sdk` is consumed from its **built `dist`**. If you edit ai-sdk
    source mid-session, rebuild it or you are testing stale code.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **S3. Confirm the Python sidecar is up**
  - The Electron main process spawns and health-polls the sidecar itself
    (`apps/desktop/electron/sidecar/manager.ts`); you do not start it by hand.
  - Open the AI rail (right rail → **AI** tab) and look at the **engine status chip**. It must
    read reachable, not unreachable.
  - Default address: `FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8765`.
  - **This gate blocks a lot.** Every `analysis` and `action` tool — silence, scenes, beats,
    frame grabs, preview renders, export — runs on the sidecar. If the chip is not green, stop
    and fix it before testing anything in §7, §8, §12, §16, §17, or §19.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **S4. Configure a real AI provider**
  - `FRAMEPILOT_AI_PROVIDER` defaults to `mock` in `.env.example`. A mock provider will not
    exercise any AI capability meaningfully.
  - Open **Settings (⌘,) → AI** and select a real provider, or set the matching env pair
    (`ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`, `OPENROUTER_*`, `GROQ_*`, `GOOGLE_*`,
    `FRAMEPILOT_OPENAI_COMPATIBLE_*`, etc. — see `.env.example`).
  - **Pick a multimodal model** if you intend to test anything that needs the AI to _look_ at a
    frame (§16 vision review, `get_frame`).
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **S5. Speech-to-text provider**
  - **Settings (⌘,) → AI → Speech-to-text**: `Local` (whisper-cli) or `TwelveLabs`.
  - `Local` needs the model set up (the panel's local setup block; `WHISPER_MODEL`,
    `FRAMEPILOT_ASR_MODEL_DIR`).
  - `TwelveLabs` needs a key pasted in that same panel — the **same key** powers §17 footage
    understanding.
  - Also choose **Transcription: On demand / On import** here; `On import` warms new media in
    the background and changes what you observe in §5.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **S6. Optional keys, only if you are testing those sections**
  - `TWELVELABS_API_KEY` (or the Settings field) → §17 footage understanding, semantic search,
    footage map.
  - `FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS` or `FRAMEPILOT_EMBEDDINGS_MODEL_DIR` → visual/embedding
    search when not using TwelveLabs.
  - Result: **/**/____ · PASS / FAIL · notes:

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
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **S8. Save the project to disk before engine work**
  - Export and transcription both force a save first (`ensureSavedForExport`). Save early so
    `fp-media://` resolution and sidecar paths are stable.
  - Result: **/**/____ · PASS / FAIL · notes:

### Where things live (orientation)

| Surface                          | How to open                                                      |
| -------------------------------- | ---------------------------------------------------------------- |
| Left rail tabs                   | **Assets**, **Effects**, **Transitions**, **Text**, **Captions** |
| Right rail tabs                  | **AI**, **Inspector**                                            |
| Footage understanding            | Topbar icon, tooltip "Footage understanding"                     |
| Transcription                    | Topbar icon, tooltip "Transcription" (next to the above)         |
| History                          | Topbar icon · `⌘⇧H`                                              |
| Command palette (scoped AI edit) | `⌘K`                                                             |
| Keyboard shortcuts               | `?`                                                              |
| Settings                         | `⌘,`                                                             |
| Export                           | Topbar accent button, right side                                 |

### The three AI modes (right rail → AI → mode dropdown)

| Mode    | Label / hint in the app                           | Use it for                        |
| ------- | ------------------------------------------------- | --------------------------------- |
| `agent` | **Agent** — "Plans and edits over multiple steps" | Everything multi-step. Default.   |
| `chat`  | **Chat** — "Ask about your video and transcript"  | Read-only questions.              |
| `edit`  | **Edit** — "One quick, reviewable edit"           | One-shot single edits (ADR 0133). |

Agent mode also has a **Plan first** toggle in the header ("Draft a step-by-step plan before
editing"), default **on**, persisted in `localStorage`.

### About the composer's slash commands

Typing `/` in the AI composer offers seven commands: `/create-short`, `/remove-silence`,
`/add-captions`, `/improve-pacing`, `/add-hook`, `/export`, `/plan-edit`.

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
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **2.2 Trim, split, delete, ripple delete, duplicate**
  - Do: drag a clip edge (trim); Toolbar **Split** or the Blade tool; **Delete**; **Ripple
    delete**; **Duplicate**.
  - Expect: each does exactly its named thing; ripple delete closes the gap, plain delete leaves
    it.
  - Fail if: ripple delete leaves a gap, or delete pulls downstream clips.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **2.3 Roll an edit point** — the one professional trim that _does_ have a UI
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
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **2.4 Insert vs Overwrite drop mode**
  - Do: Toolbar → **Drop mode** segmented control → toggle "Overwrite — dropped clips land where
    they fall" / "Insert — dropped clips push downstream clips right". Drop a clip onto occupied
    timeline in each mode.
  - Expect: overwrite replaces; insert pushes everything right.
  - Fail if: both modes behave the same.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **2.5 Multi-select, batch move, snapping**
  - Do: shift-click / cmd-click several clips, drag them; toggle Toolbar **Snapping**; hold
    **Alt** while dragging to invert the snap.
  - Expect: the whole selection moves by one delta; snap indicator appears at edit points.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **2.6 Markers**
  - Do: Toolbar **Marker** (or the marker shortcut) at the playhead; jump next/previous.
  - Expect: marker on the ruler; jump navigation lands on it.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **2.7 Tracks**
  - Do: add a track, reorder it, remove it; use the track context menu for mute/solo/lock flags.
  - Expect: preview and the audio mixer respect mute/solo.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **2.8 Undo / redo integrity**
  - Do: perform 2.2–2.7, then `⌘Z` repeatedly back to the start, then `⌘⇧Z` forward.
  - Expect: exact restoration at every step. This is invariant 1 + the patch engine's invert
    contract; treat any drift as a serious failure.
  - Result: **/**/____ · PASS / FAIL · notes:

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
  - Do: select a clip → _"Slip this clip 12 frames later."_
  - Expect: the clip's position and duration on the timeline are unchanged; the content shown
    shifts (check the filmstrip thumbnails / scrub through it).
  - Fail if: the clip moves or changes length.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.2 Slide** — move a clip while neighbours absorb it
  - Do: select a middle clip → _"Slide this clip 10 frames to the right."_
  - Expect: the clip moves; its neighbours grow/shrink to compensate; sequence duration and the
    clip's own content unchanged.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.3 Ripple trim**
  - Do: _"Ripple trim 15 frames off the end of this clip."_
  - Expect: everything after it pulls earlier by exactly that; no gap left.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.4 Lift** (leave the gap)
  - Do: _"Lift this clip out and leave the gap."_
  - Expect: clip gone, gap remains, downstream clips unmoved.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.5 Extract** (close the gap)
  - Do: _"Extract this clip and close the gap."_
  - Expect: clip gone, everything after pulled earlier.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.6 Insert**
  - Do: select a source clip in the **Source Monitor**, set the playhead → _"Insert this at the
    playhead and push everything later."_
  - Expect: nothing is overwritten; downstream content moves right.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.7 Overwrite**
  - Do: _"Overwrite at the playhead with the source clip."_
  - Expect: what was there is replaced; sequence duration unchanged.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.8 Replace**
  - Do: select a clip → _"Replace this clip's media with <other asset name>, keep the timing."_
  - Expect: same position and duration, different footage.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.9 J-cut** (sound leads the picture)
  - Setup: you need a **linked picture/sound edit point** — a clip whose audio and video are
    linked at a cut.
  - Do: _"Make this a J-cut, bring the incoming audio in 20 frames early."_
  - Expect: incoming audio starts before its picture.
  - Fail if: the tool reports it cannot resolve a linked edit point — record that; it means your
    fixture lacks linkage, not necessarily that the capability is broken.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.10 L-cut** (sound trails the picture)
  - Do: _"Make this an L-cut, hold the outgoing audio 20 frames past the cut."_
  - Expect: outgoing audio continues past its picture.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.11 Sync safety refusal** (negative test — this one should _fail closed_)
  - Do: ask for an edit that would break picture/sound sync without saying it is allowed, e.g.
    _"Trim just the video side of this linked clip."_
  - Expect: linked edits preserve sync **by default**; desync must be explicit. The AI should
    either preserve sync or refuse, naming the reason. **A silent desync is a failure.**
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **3.12 Ambiguous target refusal** (negative test)
  - Do: with **nothing selected**, ask _"Slip it 10 frames."_
  - Expect: a refusal that names what it needs — not an edit to an arbitrary clip.
  - Result: **/**/____ · PASS / FAIL · notes:

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
  - Do: put the playhead mid-clip → _"Cut to camera 2 here."_
  - Expect: a cut at the playhead; the new angle resumes at the **same instant** (through the
    sync offset), **not** the same source timestamp; the **sound is untouched**.
  - Fail if: the second angle starts from its own timecode, or the audio changes.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **4.2 Unsynced camera refusal** (negative test)
  - Do: ask to switch to an angle with **no authored sync**.
  - Expect: a refusal that **names the offset it needs**. Fail-closed is the correct behaviour
    here; a guessed switch is a failure.
  - Result: **/**/____ · PASS / FAIL · notes:

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
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **5.2 Transcribe on import** — `UI`
  - Do: Settings → AI → Transcription = **On import**; import a new speech clip.
  - Expect: transcription warms in the background without you asking.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **5.3 The AI transcribes when it needs to** — `AI`
  - Do: with an untranscribed clip, ask _"What does she say in the first minute?"_ in **Chat**
    mode.
  - Expect: the run transcribes (you should see a transcribe/read-transcript activity card) and
    answers from the actual words.
  - **Known architectural split:** the manual panel path and the agent path are **different code
    paths** (manual = IPC/host provider, agent = sidecar). Test both; a pass on one is not a pass
    on the other.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **5.4 Provider swap**
  - Do: run 5.1 once with **Local**, once with **TwelveLabs**.
  - Expect: both produce a usable transcript. TwelveLabs sends media off-device — confirm the
    hint says so before you accept it.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 6. Captions

`UI+AI` · `desktop` for generation (needs a transcript), `desktop+browser` for restyling

Caption templates: **51** in the catalog (`packages/timeline-schema/src/caption-templates.ts`),
reachable by family from both the Captions rail and the AI.

- [ ] **6.1 Generate a caption track** — `AI`
  - Setup: 5.1 passed for this clip.
  - Do: _"Add word-by-word captions from the transcript."_ (or the `Animate Captions` quick
    action, or `/add-captions`).
  - Expect: a caption track appears; cues line up with the spoken words in preview.
  - Fail if: cues drift off the speech, or the track is empty.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **6.2 Browse and apply a caption style** — `UI`
  - Do: left rail → **Captions** → search the gallery, filter by category, click a template.
  - Expect: the caption overlay in the preview changes to that template's look immediately.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **6.3 Restyle by asking** — `AI`
  - Do: _"Use a bolder caption style with a yellow highlight."_
  - Expect: the AI browses the catalog and applies a template. Watch the activity cards: you
    should see a style-discovery read followed by a track-level style change.
  - **Regression watch (recently fixed, worth re-confirming):** the run must **not** loop —
    re-reading the style it already knows, or reporting the same styling repeatedly.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **6.4 Auto-emphasis** — `AI`
  - Do: _"Emphasise the key words in the captions."_
  - Expect: selected words get the template's accent treatment. Once. The run should report
    emphasis as **emphasis**, not as a generic "Set track caption style", and must not retry work
    already applied.
  - Fail if: the run applies it repeatedly, or the completion report lists bare
    `Set track caption style:` rows with dangling colons.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **6.5 Edit a cue by hand** — `UI`
  - Do: Captions rail → click a caption row → edit its text; split a cue; merge two cues.
  - Expect: the preview updates; timing stays sane.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **6.6 Caption verification** — `AI`
  - Do: on a **fast-cut montage with captions**, ask _"Check the captions are in sync."_
  - Expect: a short, readable list of genuine problems. A caption spanning several **picture**
    cuts is fine now; only a caption bridging a real **speech** break should be flagged, and a
    caption is "out of date" only when it has genuinely drifted off its words.
  - Fail if: you get dozens of warnings on a montage whose captions are visibly fine, or the AI
    refuses to edit because "there is nowhere to put a caption".
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **6.7 Burn-in on export**
  - Covered in §19.2 — check the caption burn-in option there.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 7. Silence removal

`AI` · `desktop` **only** — `analyze_silence` is an `analysis` tool; the engine sidecar computes
it. There is **no silence-removal UI panel** (verified by grep across `apps/web-editor`). A
browser build cannot do this at all.

- [ ] **7.1 Detect and remove silent gaps**
  - Setup: talking-head clip with real pauses, on the timeline. Sidecar green (S3).
  - Do: _"Remove the silent gaps to tighten the cut."_ (or the `Trim Silence` quick action, or
    `/remove-silence`).
  - Expect: an **Analyze silence** activity card, then ripple deletes; the sequence gets
    measurably shorter; speech is not clipped at the boundaries.
  - Fail if: words are cut off at gap edges, gaps are left behind, or the run reports silence
    counts but applies nothing.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **7.2 Threshold steering**
  - Do: _"Remove only pauses longer than one second."_
  - Expect: short breaths survive; long pauses go.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **7.3 Undo the whole pass as one action**
  - Do: `⌘Z` once after 7.1.
  - Expect: the entire run reverses as **one** undo step, not clip-by-clip.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 8. Pacing and speed

`UI+AI` · `desktop+browser` (speed UI) / `desktop` (AI pacing, which reads the media)

- [ ] **8.1 Set clip speed** — `UI`
  - Do: select a clip → right rail **Inspector** → Speed section → change the rate.
  - Expect: clip length changes accordingly; audio pitch/behaviour matches the section's stated
    handling.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **8.2 Speed ramp / curve, freeze, reverse** — `UI`
  - Do: Inspector → Speed → author a ramp; try freeze and reverse.
  - Expect: preview shows the ramp; scrubbing through it is smooth.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **8.3 Punch-in** — `UI+AI`
  - UI: Inspector → **Transform** section → punch in.
  - AI: _"Punch in on the second half of this clip."_
  - Expect: a scale/position push toward the subject, visible in preview.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **8.4 Improve pacing (whole edit)** — `AI`
  - Do: _"Improve this edit: tighten pacing and fix obvious issues."_ (the `Improve Edit` quick
    action, or `/improve-pacing`).
  - Expect: a multi-step Agent run that reads the timeline, tightens slow sections, and reports
    what it changed. Every change should be visible on the timeline.
  - Fail if: the run narrates a plan and applies nothing, or the completion report claims work it
    did not do.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 9. Hooks and short-form restructuring

`AI` · `desktop`

- [ ] **9.1 Add a hook**
  - Setup: talking-head clip with transcript.
  - Do: _"Find the strongest moment and restructure the opening around it."_ (or `/add-hook`).
  - Expect: the run reads the transcript, identifies a candidate, and moves/duplicates it to the
    front as real timeline operations.
  - Fail if: it only _suggests_ a hook without editing — in Agent mode that is a failure, since
    edits auto-apply.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **9.2 Create a short**
  - Do: _"Turn this into a 45-second vertical short."_ (or `/create-short`).
  - Expect: a long multi-step run — reads footage, selects segments, cuts, and reports. Watch it
    to completion.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **9.3 Plan without mutating**
  - Do: switch to **Chat** mode (or use `/plan-edit`) → _"Give me an edit plan for this footage.
    Do not change anything."_
  - Expect: a structured plan. **The timeline must not change.** Verify by checking the History
    panel is unchanged.
  - Fail if: any patch lands. Chat mode must be read-only.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 10. Transitions

`UI+AI` · `desktop+browser`

- [ ] **10.1 Browse and apply from the panel** — `UI`
  - Do: select a cut → left rail **Transitions** → search, filter by category, click one.
  - Expect: it lands on the selected cut; the panel's target line says where it will go and turns
    blocked when there is no valid cut.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **10.2 Suggested-for-this-cut** — `UI`
  - Do: with a cut selected, look at the **"suggested for this cut"** section.
  - Expect: recommendations with a stated reason on each card.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **10.3 Preview thumbnails** — `UI`
  - Expect: each transition card renders a live thumbnail, not a static placeholder.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **10.4 Transition parameters** — `UI`
  - Do: select a clip with a transition → Inspector → **Transition** section: duration,
    alignment, audio mode, per-kind parameters, reset, disable, swap kind, remove.
  - Expect: every control changes the preview.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **10.5 Apply to all cuts** — `UI`
  - Do: use the apply-to-all-cuts affordance.
  - Expect: every valid cut gets it; invalid cuts are skipped rather than corrupted.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **10.6 Add a transition by asking** — `AI`
  - Do: _"Put a cross dissolve on every cut in this sequence."_
  - Expect: a **Browse transitions** / **Add transition** activity trail, then transitions on the
    timeline.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **10.7 Transition verification** — `AI`
  - Do: _"Check the transitions are correct."_
  - Expect: a plain-language report of what exists and what is wrong — not a raw data dump.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 11. Effects

`UI+AI` · `desktop+browser`

Effect layers come from `packages/timeline-schema/src/effect-catalog.ts`. `EffectsPanel.tsx`
states that **nothing in the panel is a placeholder** — every entry should do something.

- [ ] **11.1 Browse and apply** — `UI`
  - Do: left rail **Effects** → search, filter by category, click an effect card.
  - Expect: it applies to the selection and the preview changes visibly.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **11.2 Effect thumbnails** — `UI`
  - Expect: cards render a real preview of the effect, not a generic icon.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **11.3 Effect layers: add, reorder, duplicate, remove, enable/disable** — `UI`
  - Do: use the effect layer chips / layer menu on a clip.
  - Expect: order matters and is respected in preview; disabling bypasses without deleting.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **11.4 Effect parameters** — `UI`
  - Do: **Effect Inspector** → change parameters.
  - Expect: live preview response.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **11.5 Apply an effect by asking** — `AI`
  - Do: _"Add a subtle film grain to the B-roll clips."_
  - Expect: a **Discover effects** read, then the effect applied to the right clips.
  - Fail if: the AI claims it added an effect but no effect layer exists on the timeline. (This
    exact overclaim shape has regressed before — check the timeline, not the chat.)
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 12. Scene, beat, and media analysis

`AI` · `desktop` **only** — all sidecar `analysis` tools.

- [ ] **12.1 Scene detection**
  - Do: _"Where are the scene changes in this clip?"_
  - Expect: a **Detect scenes** card and timestamps that match what you see.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **12.2 Beat detection**
  - Setup: music track on the timeline.
  - Do: _"Find the beats in the music."_
  - Expect: a **Detect beats** card with a plausible tempo/onset list.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **12.3 Cut to the beat** — the one to test carefully
  - Do: with B-roll and a music bed, _"Cut this montage to the music."_
  - Expect: cuts land **on** detected beats. Recent behaviour: when the AI has measured the
    music, a cut slightly off is **snapped onto the beat**, and a badly-off cut is **refused with
    the nearest real beat named**. There is no setting for this.
  - Fail if: cuts sit visibly off-beat while the run reports beat detection succeeded.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **12.4 Media probe**
  - Do: _"What resolution and frame rate is this clip?"_
  - Expect: a **Probe media** card with correct values (cross-check with `ffprobe`).
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **12.5 Edit-boundary reading**
  - Do: after making several cuts, _"Where are all the cuts?"_
  - Expect: a readable list of cut positions, in plain language — not raw JSON.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 13. Motion and keyframes

`UI+AI` · `desktop+browser`

Keyframeable clip properties: **scale, x, y, rotation, opacity** (`CLIP_KEYFRAME_PROPERTIES` /
`motionCapabilities`).

- [ ] **13.1 Set a transform by hand** — `UI`
  - Do: Inspector → **Transform** → scale/position/rotation/opacity; or drag in the preview
    (`PreviewTransform`).
  - Expect: preview follows immediately.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **13.2 Keyframe a property** — `UI`
  - Do: Inspector → the **keyframe button** next to a property → set a value at two playhead
    positions.
  - Expect: keyframes appear on the timeline row; the property animates between them.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **13.3 Keyframe editing on the timeline** — `UI`
  - Do: move, delete, and multi-select keyframes; change easing; drag bezier handles.
  - Expect: the motion curve changes accordingly.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **13.4 Animate by asking** — `AI`
  - Do: select a clip → _"Slowly zoom this clip from 100% to 115% over two seconds."_
  - Expect: an **Animate clip properties** card and real keyframes on the clip. The tool takes an
    editorial objective plus **duration in frames** — it should not be asking you for raw
    keyframe arrays.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **13.5 Canvas-cover constraint** (negative test)
  - Do: _"Scale this clip down to 40%."_
  - Expect: if that would leave the canvas uncovered, the tool **fails closed** with a reason
    rather than producing black edges.
  - Result: **/**/____ · PASS / FAIL · notes:

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
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **14.2 Grade by asking** — `AI`
  - Do: _"Warm this shot up and lift the shadows a little."_
  - Expect: a **Correct shot color** card; the Inspector's Color values change to match.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **14.3 Shot matching across a recording** — `AI`
  - Setup: several clips cut from the **same** source recording.
  - Do: _"Match the grade across these shots."_
  - Expect: shot grouping expands one shot into **every clip cut from the same recording** — a
    fact about the footage, not a similarity guess. Clips from a _different_ recording should
    not be swept in.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **14.4 Skin preservation** (behaviour check)
  - Setup: a clip with a face in frame.
  - Do: ask for an aggressive white-balance match.
  - Expect: the match is held back until skin warmth stays inside ~8%, and it **refuses when
    there is too little skin to read** — naming that. A refusal here is a pass.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **14.5 Measure shot color** — `AI`
  - Do: _"Measure the colour of this shot."_
  - Expect: a **Measure shot color** card with real values.
  - Result: **/**/____ · PASS / FAIL · notes:

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
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **15.2 Preview audio mixer** — `UI`
  - Do: open the preview audio mixer; adjust per-track levels; mute/solo.
  - Expect: playback follows.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **15.3 Normalize** — `AI`
  - Do: _"Normalize this clip's level."_
  - Expect: a **Mix audio** card; loudest point moved to target without squashing dynamics.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **15.4 Ducking** — `AI`
  - Setup: music track under a speech track.
  - Do: _"Duck the music under the speech."_
  - Expect: music dips whenever speech is present.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **15.5 EQ and compression** — `AI`
  - Do: _"Make the voice clearer — cut the low rumble and even out the level."_
  - Expect: EQ and compressor land as one `audio_gain` chain in the stated order.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **15.6 Automation lane vs static level** (negative test)
  - Do: ask for **both** a static gain and a gain automation lane on the same clip.
  - Expect: a lane **supersedes** the static level rather than multiplying with it, and authoring
    both is **refused, naming the fix**. A silent multiply is a failure.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **15.7 Fix Audio quick action** — `AI`
  - Do: composer quick action **Fix Audio**.
  - Expect: a coherent multi-step audio pass, all changes visible.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 16. Masking and tracking

`UI+AI` · `desktop+browser` for authoring; the AI's tracking runs deterministically

> **Read this before testing.** Masks are drawn by hand (16.1), tracked through the Tracking Lite
> pack, and cut out through the Smart Mask pack (16.4, 16.5). The assistant masks through the
> `masking` tools (`find_mask_targets`, `create_mask`, `remove_background`, `track_mask`, …), which
> run the same pack jobs and land on the same Inspector review list (16.8). `generate_mask` and
> the model's fixed-bounds `add_mask` no longer exist. `create_shape_mask` (split, mirror,
> gradients, shape presets) and `mask_with_layer` (track matte, text as a mask) are live since MK8
> (16.9, 16.10).

- [ ] **16.1 Draw and edit masks on the monitor** — `UI` · desktop
  - Setup: a project with a real camera clip (4K if you have one). Select it, open Inspector → Mask.
  - Do: with the monitor toolbar, draw a Rectangle (drag), an Ellipse (Shift+Alt drag), a Pen path
    (clicks, one drag for a smooth point, Shift for a 45° segment, click the first point to close)
    and a Freehand stroke.
  - Expect: each shape appears in the Mask list with its own colour, the monitor cuts the picture
    live while dragging, and each shape is exactly one Undo.
  - Do: with Selection, move a mask, drag a point, Alt-drag a tangent, Cmd-click a point, click an
    edge to add a point, marquee two points and press Delete, drag the corner and rotation handles,
    drag the three knobs right of the shape, nudge with arrows and Shift+arrows, toggle snapping and
    drag near the frame centre, zoom to 400% and 800%.
  - Expect: handles stay on the picture's edge at every zoom; the pixel grid appears from 400%;
    typed values in the Inspector match (sub-pixel kept); Undo reverts each gesture once.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.1a Animate and retime a mask** — `UI` · desktop
  - Do: at 0 s click the keyframe diamond of Centre X; move the playhead to 2 s and drag the mask;
    play. Open the clip's keyframe lanes on the timeline and drag the mask lane marker; toggle
    **Apply to all keyframes** and change Outer feather.
  - Expect: the mask moves between the two positions in preview and export; the lane drag retimes
    every keyframe at that instant; with Apply to all keyframes on, one Undo reverts the feather on
    every keyframe.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.1b Keyboard-only drawing (a11y)** — `UI`
  - Do: Tab to the monitor canvas, press P, Space, Shift+Right ×20, Space, Shift+Down ×20, Space,
    Enter. Then `]` to select a point, arrows to nudge, Delete.
  - Expect: a three-point path mask; a screen reader announces each point and the result.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.1c Copy, paste and presets** — `UI`
  - Do: Copy mask on one clip, Paste masks on a clip with different resolution media; Save preset
    "Face box", Apply preset on a third clip; save, close and reopen the project.
  - Expect: pasted and applied masks sit at the same relative place in the new picture; the preset
    survives reopen; Delete preset undoes.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.1d Save time with a long rotoscope** — `UI` · desktop
  - Do: open a project whose path mask has hundreds of keyframes (or run
    `pnpm --filter @framepilot/timeline-schema exec vitest run src/save-budget.perf.test.ts`), edit,
    and watch autosave.
  - Expect: no visible hitch on autosave; the saved file reloads identically.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.1e The mask tools kill switch** — `UI` · desktop+browser
  - Do: build the editor with `VITE_FRAMEPILOT_MASK_TOOLS=off` (RD2.1; the same mechanism as the
    compositor flag) and reopen a project that already has masks.
  - Expect: no monitor mask toolbar and no Inspector **Mask** tab, and the masked clip still
    previews and exports exactly as before. The flag gates editing chrome, never a frame of
    output. Unset, a dev build is `on` and a packaged release is `off` until RD3.
  - Fail if: a mask stops cutting the picture, or the toolbar survives with the flag off.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.4 Background removal: the states you can reach today** — `UI` · desktop
  - > **Read first.** The Smart Mask pack is **not installable yet** (no catalog entry, and its
    > accuracy is not at gate — BR3.15). Everything below the pack warning needs a locally
    > registered pack or a fake one; the warning states themselves are testable now.
  - Setup: a project with a real camera clip. Select it, open Inspector → **Mask**.
  - Do: look at the first row without the pack installed.
  - Expect: **Remove background** is VISIBLE and disabled, with a warning above it naming the
    Smart Mask pack, its download size and its licences, and an **Install** button. A screen
    reader announces the reason with the button (it is `aria-describedby`), and re-selecting
    clips does **not** re-announce it (the warning is `role="status"`, not an alert).
  - Do: open the monitor's mask toolbar.
  - Expect: **AI Object** and **AI Brush** are there, disabled, with the same reason in their
    tooltip. The shape tools are unaffected.
  - Do: open the app in the browser build.
  - Expect: "Background removal needs the FramePilot desktop app." No install button.
  - Fail if: the button or the AI tools are hidden rather than disabled, or a build with no pack
    catalog offers an Install button that cannot work.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.5 Background removal end to end** — `UI` · desktop · **needs a registered Smart Mask pack**
  - Do: choose **Click to pick**, pick **AI Object** on the monitor, click the subject, Alt-click
    something to leave out, then press **Remove background**.
  - Expect: the clicks show as dots with a plus or a minus (not colour alone) and add **no** undo
    entries. The estimate line says roughly how long and how much disk. Over ten minutes, it asks
    you to confirm first.
  - Do: while it runs, select another clip, then come back.
  - Expect: the job keeps running; the row reconnects to it rather than starting a second one; the
    timeline shows a striped band over the part not processed yet; the monitor says "Processing
    background removal". When it finishes it lands on the **right** clip, as one Undo.
  - Do: press **Cancel** on a run.
  - Expect: "Stopped. Nothing changed." and no new mask.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.6 Reviewing the moments it was unsure about** — `UI` · desktop · **needs the pack**
  - Do: with moments flagged, press `J` and `K` in the review list; press **Looks right** on one;
    draw with the **Remove** brush over a mistake and press **Apply fix**; press **Lock this
    frame**; then clear the last moment.
  - Expect: `J`/`K` seek and switch the monitor to Overlay; each approval is one Undo; **Apply
    fix** re-runs only that window; **VERIFIED** appears only when NOTHING is flagged.
  - Fail if: VERIFIED appears while a moment is still flagged, or an unapplied brush stroke
    changes the picture.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.7 Text behind the subject, and what export says** — `UI` · desktop · **needs the pack**
  - Do: with a background removal applied and nothing on a track below, read the row. Then type
    text and press **Put text behind subject**. Then open **Export** with a moment unchecked.
  - Expect: the row warns the removed area exports as black with nothing behind it; the text lands
    between the subject and the background in ONE Undo; the export dialog says how many moments
    have not been checked, offers **Review**, and still lets you export.
  - Fail if: export blocks, or the count is hidden.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.2 Track an existing mask** — `AI`
  - Setup: 16.1 produced a rectangle or ellipse mask over a moving subject.
  - Do: select the clip → _"Track this mask across the shot."_
  - Expect: a **Track mask** card; per-frame positions written; the mask follows the subject in
    preview.
  - Fail if: it invents coordinates, or claims a track with no per-frame data behind it.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.3 Automatic tracking refusal** (negative test — the important one)
  - Do: _"Automatically find and track the person in this shot."_
  - Expect: a clear statement that automatic subject tracking is **unavailable** and requires the
    on-demand Subject Intelligence Capability Pack. **No tracker is silently bundled or
    downloaded.**
  - Fail if: the AI claims it tracked something. That is exactly the fabrication the registry is
    built to prevent.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.8 The assistant masks a subject** — `AI` · desktop · **needs Subject Intelligence; Smart Mask for cut-outs**
  - Do: with no packs installed, ask _"Remove the background of this clip."_
  - Expect: the pack install card with the signed proposal. Nothing downloads until you approve.
  - Do: with the packs, ask the same on a short clip, then on a long one.
  - Expect: the short clip gets its cut-out as ONE Undo, and the reply says how many moments need
    a look, with **Open review list**. The long one shows a card to start the Inspector's own
    job instead of starting it silently.
  - Do: on a shot with two people, ask _"Mask the person."_
  - Expect: thumbnails of both and a question; nothing is masked until you pick one.
  - Do: ask _"Darken everyone except the host."_
  - Expect: the face picker, with the face recognition line (off by default) and, once on,
    **Delete identity data**.
  - Fail if: the reply calls a mask verified, a mask lands without a pick when two things match,
    or a mask appears where you gave no numbers and nothing was detected.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.8a The AI masking kill switch** — `AI` · desktop+browser
  - Do: start the desktop app with `FRAMEPILOT_AI_MASKING=off` (the browser build: build it with
    `VITE_FRAMEPILOT_AI_MASKING=off`), open a project that already has masks, and ask _"Remove the
    background of this clip."_ Then press Cmd+K and ask _"Delete the mask on this clip."_
  - Expect: the assistant says it cannot do that here, in both. No pack job starts, no mask is
    added or removed, and the existing masks still preview and export. Unset, a dev build is `on`
    and a packaged release is `off` until RD3.
  - Fail if: any masking tool card appears, or Cmd+K proposes a mask edit with the switch off.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.9 Split, mirror, gradient and shape masks** — `UI+AI` · desktop
  - Setup: two video clips stacked (V1 over V2), Inspector → Mask on the V1 clip.
  - Do: Split tool (S): drag across the picture; turn it with the square handle (Shift for 15°
    steps), pull the softness knob. Mirror (M): click, widen the band with its edge handles.
    Gradient (G): drag top to bottom, then Alt-drag for a radial one. Shapes (H): pick Star, set 6
    points, drag a box; pick Rounded frame and drag. Undo each. Export 5 s.
  - Then ask the assistant: _"Split screen: keep the left half of this clip."_ and _"Darken the top
    of this shot with a gradient."_ and _"Put a heart around her face."_
  - Expect: every gesture is one undo step; the monitor and the export show the same edges (a hard
    diagonal split is clean, not stair-stepped); the rounded frame is two masks (outer, inner
    subtracted). The assistant places each on the frame or the face, never asks you for
    coordinates, and reports what it did.
  - Fail if: the monitor says "Mask not previewed yet" for any of them, an export differs from the
    monitor, or the assistant invents a position.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **16.10 Track matte and video inside text** — `UI+AI` · desktop
  - Setup: a title (big bold word) on the top track over a video clip, over a second clip below.
  - Do: select the video clip, Mask tab → Track matte: pick the title, Alpha, **Use as mask**. Switch
    the channel to Luma, then Alpha, inverted. Scale and rotate the video clip. Export 5 s. Undo.
    Then ask the assistant: _"Put this video inside the title."_
  - Expect: the clip shows only through the letters, over the clip below; the title itself is no
    longer drawn; inverted shows the clip everywhere except the letters; scaling the clip does not
    move the matte (it stays where the title is); the export matches the monitor; the assistant
    uses the title as an alpha track matte.
  - Fail if: white letters are drawn on top, the matte moves with the clip, or the export differs.
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 17. Footage understanding and semantic search

`UI+AI` · `desktop` · **needs a TwelveLabs key or an embeddings key** (S6)

ADR 0070 / 0071 / 0097: an optional hosted understanding backend behind a typed facade.

- [ ] **17.1 Build the footage map** — `UI`
  - Do: Topbar → **Footage understanding** → build / **Rebuild the footage map**.
  - Expect: staged progress ("Mapping chapters and highlights…"), then chapters and highlights.
  - **With no key**, expect the honest message: _"No understanding key is configured. Add a
    TwelveLabs or embeddings key…"_ — that message appearing is itself a pass for the
    unconfigured case.
  - **On a plan without generative understanding**, expect: _"Generative understanding is not
    available on this TwelveLabs plan."_
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **17.2 Map survives reopen and does not re-bill** — `UI`
  - Do: close and reopen the project; open the panel again.
  - Expect: the cached map is served **immediately**, without re-indexing and without another
    provider charge. Project ids are deterministic, so this must hold.
  - Fail if: it re-indexes on reopen. That is both a data-loss and a billing bug.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **17.3 Semantic footage search** — `AI`
  - Do: _"Find the shots where someone is at a whiteboard."_
  - Expect: a **Search visual evidence** / **Find similar** card and results that actually match.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **17.4 Describe footage** — `AI`
  - Do: _"Describe what happens in this clip."_
  - Expect: a **Describe footage** card and a description grounded in the actual footage.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **17.5 The AI looks at a frame** — `AI`
  - Setup: a **multimodal** model configured (S4).
  - Do: _"Look at the frame at 00:15 and tell me what's in it."_
  - Expect: a **See the frame** card and an answer that matches the frame.
  - Fail if: it describes something that is not there, or claims to have looked without the card
    appearing.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **17.6 Missing-evidence honesty** (negative test)
  - Do: with **no** key configured, ask a question that needs visual understanding.
  - Expect: it states plainly that it cannot see the footage. **Missing evidence is stated, not
    implied** (ADR 0118).
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 18. The AI run itself — control, honesty, recovery

`UI` · `desktop+browser` (the run machinery) — these are capabilities in their own right, and
several are recent fixes worth confirming by hand.

- [ ] **18.1 Chat mode is read-only**
  - Do: **Chat** → _"Delete the first ten seconds."_
  - Expect: it discusses; the timeline does **not** change.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.2 Edit mode does one shot**
  - Do: **Edit** → _"Trim two seconds off the start of the selected clip."_
  - Expect: one edit, applied, receipt card shown.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.3 Agent mode with Plan first**
  - Do: **Agent**, **Plan first** on → give a multi-step request (e.g. §9.2).
  - Expect: a drafted plan appears first, then the run follows it; steps mark off as they
    complete.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.4 Plan approval gate**
  - Do: request something with a large blast radius with Plan first on.
  - Expect: the plan approval card appears before the work starts.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.5 Mid-run steering**
  - Do: while a long run is going, type a steering message.
  - Expect: the run takes it into account without restarting.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.6 Cancel**
  - Do: press **Stop agent** mid-run.
  - Expect: it stops **immediately** with nothing half-applied.
  - Fail if: an edit lands after you cancelled, or the project is left inconsistent.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.7 Crash / restart recovery**
  - Do: start a long run; quit the app (or reload) mid-run; reopen the project.
  - Expect: the run is recovered from its durable log; you are not silently left with a
    half-finished edit and no record.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.8 The run does not narrate its own machinery** (ADR 0130 — recent fix)
  - Do: run several multi-step edits and read every reply.
  - Expect: **no** sentences like _"I'll continue from the interpret stage"_ or _"I'll continue
    from where the run left off"_ — in the chat, in the diff card's Summary, or in the Reason
    stored on the edit.
  - Also check: reopen the History panel and read the reason on an AI edit. Same rule.
  - Fail if: any such sentence appears anywhere. Test on a normal run, a cancelled one, and a
    retried one.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.9 The completion report is accurate** (ADR 0131 — recent fix)
  - Expect: each change named with **action + subject + detail** (e.g. `Deleted range Video 1 ·
0s–3s`), identical lines collapsed to one row with `(×N)`, and **no** claim that changes
    "did not validate" when they simply were already in place.
  - Fail if: bare `Set track caption style:` rows, dangling colons, or a skipped-count that
    includes already-applied no-ops.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.10 No overclaimed verification**
  - Do: make a request naming effects or transitions, and watch a run that does **not** call
    those tools.
  - Expect: the internal check must **not** report your whole request as passed. It covers
    timeline consistency only and should be labelled as such.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.11 Full-track clear is allowed and reversible** (ADR 0166)
  - Do: _"Clear the video track."_ / _"Start over."_ — then press undo.
  - Expect: the clear **applies** (no refusal — the wipe guard was removed because it blocked
    legitimate edits), and undo restores the timeline exactly as it was.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.12 Ask-the-user round trip**
  - Do: make a genuinely ambiguous request (_"Cut this down."_ with two very different clips
    selected).
  - Expect: an **A question for you** card that waits for your answer and then continues.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.13 Context chips and pinning**
  - Do: check the **Included context** chips reflect the selection/playhead; remove one; use
    `@` to pin a clip or asset.
  - Expect: chips update; a removed chip stays out of the next turn.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.14 Conversation export and copy** (recent fix)
  - Do: sidebar **⋯** menu → **Copy transcript** and **Export transcript**; History drawer row →
    **Copy Markdown** / **Export Markdown**.
  - Expect: the **whole run** — thinking, each tool call with arguments and raw result, every
    proposed edit with operations and validation issues, status changes, cost, resume checkpoint.
  - Fail if: the export contains only chat messages.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.15 Cmd+K scoped edit**
  - Do: select a clip → `⌘K` → type a scoped instruction.
  - Expect: the palette submits a scoped edit against that selection; the AI rail can also be
    opened from the palette.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.16 Context window indicator and cost**
  - Expect: the context indicator and cost reporting move in step with the run. Every extra
    billed call must be one you asked for.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **18.17 Variations (browser-only — known desktop gap)**
  - The "2 alternative takes" toggle in **Edit** mode is **hidden when an Electron bridge is
    present** — it is browser-only by design, and deliberately hidden rather than offered and
    silently ignored. Each take is a separately billed model call, so it is off by default.
  - Do (browser build only): enable it and submit an edit.
  - Expect: two alternative takes offered.
  - Result: **/**/____ · PASS / FAIL · notes:

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
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **19.2 Export**
  - Do: Topbar → **Export video** → pick a preset → export.
  - Presets: **Instagram Reels (9:16)**, **TikTok (9:16)**, **YouTube Shorts (9:16)**, **YouTube
    (16:9)**, **Square (1:1)**.
  - Also exercise: **caption burn-in**, **loudness preset** (None / Social −14 LUFS / Podcast
    −16 LUFS / Broadcast −23 LUFS), **master EQ preset** (None / Flat / Warm / Bright / Voice
    clarity).
  - Expect: the project saves first, progress streams, the file lands, and **Reveal** opens it.
    Play the output: it must match the timeline.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **19.3 Render validation**
  - Expect: every render is checked automatically after it runs (invariant 4). A failed
    validation must surface as a failure, not a silent pass.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **19.4 Export by asking** — `AI`
  - Do: _"Export this at 1080p."_ (or `/export`).
  - Expect: an **Export video** action card and a real file. The AI requests the export; the host
    performs it.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **19.5 Render preview** — `AI`
  - Do: _"Render a preview of this section so you can check it."_
  - Expect: a **Render preview** card and an actual rendered result the run then reasons about.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **19.6 History panel and AI-run undo**
  - Do: `⌘⇧H` → inspect the history; undo an AI run from there.
  - Expect: an AI run undoes as **one** action; the entry names what changed and where.
  - Result: **/**/____ · PASS / FAIL · notes:

- [ ] **19.7 Long-media behaviour**
  - Do: repeat 19.1–19.2 with a **feature-length** file, not a fixture.
  - Expect: adaptive program preview keeps scrubbing usable; proxies are generated (desktop
    only); export completes within `FRAMEPILOT_RENDER_TIMEOUT_SECONDS` (default 900).
  - Result: **/**/____ · PASS / FAIL · notes:

---

## 20. Not yet manually testable

These exist in the codebase but a user **cannot** reach them end-to-end today. They are listed so
you know the omission is deliberate. Do not write test procedures for them; if one becomes
reachable, move it up.

| Capability                                                 | Where it exists                                                                                              | Why it is not testable                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Text behind object** (PRD §6.6)                          | `engine/python/.../masking/mask.py`                                                                          | Segmentation now exists (§22), but no user path composites text behind the returned matte. Engine ✓, no entry point.                                                                                                                                                                                      |
| **Local semantic vision review pack**                      | `VisionRunReviewControls`, temporal/vision review                                                            | The Subject Intelligence worker now exists and installs locally (§22), but its adoption by `VisionRunReviewControls` is unconfirmed. Cloud review is consent-gated only.                                                                                                                                  |
| **Mask geometry authoring**                                | `addMaskPatch`                                                                                               | `bounds` is **hardcoded** to the centre 60%; no handles, no numeric fields. Engine ✓, UI not operable. Masking is only _partly_ testable — see §16.1.                                                                                                                                                     |
| **Multicam angle-group authoring**                         | Schema v18 camera angle groups                                                                               | **Zero** multicam UI components. Whether §4 is reachable at all depends on the AI authoring the group — unconfirmed. See the §4 caveat.                                                                                                                                                                   |
| **`autocomplete` AI mode**                                 | `orchestrator.ts` (`AiMode` includes `'autocomplete'`)                                                       | The sidebar exposes only `agent` / `chat` / `edit`. No UI entry point.                                                                                                                                                                                                                                    |
| **Capability Pack install flow — the signed-catalog path** | `CapabilityPackDependencyDialog`, `CapabilityPackStorageSettings`, `apps/desktop/electron/capability-packs/` | The **download-from-catalog** half is still unreachable: no signed published catalog and no signing credentials (C6). Catalog and artifact URLs are hard-required to be `https:`, so a `file://` catalog cannot stand in. The **installed-pack** half is fully testable via local registration — see §22. |
| **Export/preview columns of the §7.2 capability matrix**   | `plan/PLAN.md`                                                                                               | The plan itself marks these `?` — explicitly **not audited**. Do not infer status from this document either.                                                                                                                                                                                              |

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

- [ ] **22.0 Packs registered** — Result: **/**/____ · PASS / FAIL · notes:

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
- Result: **/**/____ · PASS / FAIL · notes:

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
- Result: **/**/____ · PASS / FAIL · notes:

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
- Result: **/**/____ · PASS / FAIL · notes:

### 22.4 The honest refusal when no pack is installed

- Setup: temporarily move the store aside:
  `mv ~/Library/Application\ Support/@framepilot/desktop/capability-packs{,.bak}`
- Do: ask for automatic tracking.
- Expect: an explicit **install proposal**, and no timeline change. Nothing downloads silently.
- Fail if: the agent fabricates a track, or a download starts without approval.
- Restore the store afterwards (`mv` it back).
- Result: **/**/____ · PASS / FAIL · notes:

---

## Session log

| Date | Sections covered | Passed | Failed | Notes |
| ---- | ---------------- | ------ | ------ | ----- |
|      |                  |        |        |       |
|      |                  |        |        |       |
|      |                  |        |        |       |
