# Changelog

All notable changes to FramePilot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Closed a critical test-runner vulnerability (CVE-2026-47429).** The Vitest
  dev dependency used across every workspace package allowed arbitrary file
  read and execution while its UI server was listening. Upgraded to ≥ 3.2.6 in
  all packages, plus two test-harness timing fixes the new runner requires
  (byte-exact font comparison) and CI-sized budgets for the parse-budget stress
  test that ran ~42s under coverage on the 2-vCPU runner.
- **Hardened every external-binary launch against argument injection.**
  ffmpeg, ffprobe and whisper-cli invocations now pass through one audited
  validation gate before anything executes: arguments must be plain strings,
  NUL bytes are rejected outright, the binary itself can never be
  option-shaped, and dash-leading operand paths are defused. Values that reach
  these commands ultimately come from user or agent input, so a hostile value
  can no longer be shaped into an option of the target binary.

### Fixed

- **The AI is told what is in your footage; it decides what to do about it.** It used to be
  handed a ranked list of moves worked out in code — every highlight got "a push-in makes it
  land", a chapter whose title contained a word like "reveal" got another, a long quiet
  stretch got a speed ramp — and its job was to pick from that list. Five suggestions would
  come back with one reason between them, and the scores looked enough like evidence that the
  AI stopped forming its own view.

  Now it gets the facts instead: how long a chapter runs and how many highlights sit inside
  it, which gaps are long enough to notice, where the picture changes, which words were
  emphasised — and it chooses the cut, the reframe, the zoom or the nothing-at-all itself. It
  also now says which of those facts came from actually reading your footage and which were
  its own assumption, so a guess can no longer be presented to you as a finding.

- **Cutting to music is your call, not the app's.** If the AI had so much as analysed a track,
  every cut was forced onto the nearest detected beat — so a request for cuts on visual action
  ("ready to beat-sync once I add music") had its rhythm quietly replaced, and cuts sitting a
  tenth of a second off a beat were refused outright. Cuts that are nearly on a beat are still
  snapped exactly onto it for you; a cut you meant to sit off the beat now stands, and you are
  told how far off it is. Hard quantising happens only when the AI is deliberately syncing to
  the track.

- **"Do this to every clip" is now something the app can check.** A brief asking for every
  clip to be reframed, graded and given a subtle zoom could be answered with one clip done and
  the job reported as complete, because the only things being checked were the total length
  and the number of shots. Those per-clip requests are now checked across the whole cut, and
  you are told the shortfall — "the grade is on 1 of 47 clips" — instead of "all checks
  passed".

- **Black bars no longer slip through.** Nothing checked whether your clips actually fill the
  frame, so a vertical edit could ship with most shots letterboxed. Now a cut where some shots
  are reframed and others are not is flagged with the clips that were missed, and the AI can
  see at a glance which clips still need it.

- **When the AI cannot make the file you asked for, it says so.** A brief ending "one final
  rendered MP4" would finish with edits on the timeline, no file, and no mention of it —
  rendering isn't something the AI panel can do. It now tells you once, plainly, and points at
  the Export dialog.

- **The AI starts a job knowing what your project already knows.** In the browser it began
  every job blind: no footage map, no note of what was learned last session, no record of what
  you had already told it. Asked to choose moments "from the footage map", it had none, never
  fetched one, and described chapters it had made up. It now reads all three before it starts,
  as the desktop app already did.

- **Transitions no longer flash black at every cut.** A cross dissolve dissolved up from
  black instead of out of the shot before it; a whip pan whipped in over black; a wipe wiped
  in from nothing. It happened at every cut, in the monitor and in the exported file, because
  the shot being left had already ended by the time the next one started easing in and there
  was nothing underneath it.

  A transition now reveals the shot it is coming from, as it should: the outgoing shot keeps
  playing under the ramp (or holds its last frame, when it has been cut right to the end of
  its source). Nothing about your timeline changes — the same cuts, the same transitions, just
  the picture that belongs under them.

- **Cropped clips fill the frame in the monitor, the way they always did on export.** A
  vertical crop of horizontal footage showed as a small picture floating in a lot of black
  while the exported video was full-bleed. The monitor was showing you something worse than
  what you would get, which is the wrong way round — and if you (or the AI) "fixed" it by
  zooming in, the export ended up over-zoomed for real. The monitor now fills the frame
  exactly as the render does.

- **A dropped reply no longer throws away the whole job.** When the AI's provider dropped a
  request — an empty response, or a reply cut off mid-sentence — the run ended there, often
  after minutes of work, and told you it was "retryable" without retrying anything. Worse, a
  cut-off sentence was published as the AI's final word on your video. It now retries the
  step once, and if the reply is still cut short it says so plainly instead of leaving you a
  fragment.

- **The AI can be held to what you actually asked for.** Ask for "a 30 second reel from at
  least 20 moments" and it now records both as conditions and checks them against the finished
  cut, instead of treating your whole sentence as one unmeasurable goal — which is how a
  request for twenty moments could finish, reported as a success, with eight. Taste is
  deliberately left out of that: "make it nice" is still the AI's judgement to exercise, not
  something the app pretends to measure.

- **The AI stops being told to fix the same thing forever — and stops claiming a clean run
  when it is not.** Its own visual review kept reporting one defect it had no way to fix, and
  the app kept instructing it to fix that defect, turn after turn, until the job ran out. A
  problem now gets one correction attempt; after that you are told plainly that it is still
  there and that the run is not going to keep retrying. And "all checks passed" no longer
  appears while the visual review is still holding an unresolved problem.

- **It stops asking you the same question twice — and stops undoing what you already
  answered.** When the AI asked how the picture should sit in a vertical frame and you chose
  full-bleed, the next run knew nothing about it and rebuilt the whole cut with no crop at all.
  What you tell a job is now remembered with the project, so later jobs read it back.

- **It says when a cut was chosen blind.** If it assembles a montage without reading anything
  about what is actually in your footage, it now tells you so — and what to ask for if you want
  the selection grounded in content — instead of describing timings it guessed as though they
  came from a real look at the material.

- **Footage understanding works again — and reading a clip is now something you can actually
  do.** New footage never got read at all: the very first time a project prepared its
  understanding, the provider rejected the request outright (the generative model it asked for
  has been retired for this step), so nothing was ever prepared. Footage understanding then
  told you your clip "is not indexed yet" and pointed you at the media bin — which has no such
  action — while Rebuild kept re-asking for a map that could never exist. Nothing showed
  progress because nothing was running.

  Preparation now uses the provider's current models, so it goes through. Understanding is
  read straight from your footage rather than requiring it to be filed against a search index
  first, which is also what makes clips prepared in earlier versions readable without paying
  to re-upload them. And when a clip hasn't been read, the panel offers a **Read this footage**
  button that does it, streams its progress while it runs, and says plainly what went wrong
  when it can't — a wrong key, no remaining credit, no connection — instead of leaving you at a
  dead end.

- **The AI no longer talks to you about its own bookkeeping.** On longer jobs it had started
  opening its replies with things like *"I'll continue from the interpret stage"* or *"I'll
  continue from where the run left off"* — a status report on its internal state machine,
  which is not something you asked for and not something that means anything to an editor.
  The same sentence was also saved as the reason on the edit it made, so it reappeared every
  time you reviewed that change in the history.

  It now writes about your video and nothing else. The internal notes it keeps between steps
  are explicitly marked private to it, and the app enforces the same rule independently, so
  the sentence cannot reach you even if the AI forgets — on a normal run, a cancelled one, a
  retried one, or one that fails partway.

- **The AI stops redoing work it has already done.** In one caption job it applied your
  emphasis seven times over and still believed it had never managed it once — so it kept
  trying, kept looking, and finished without telling you the job was done. Two of its own
  notes were misleading it. Emphasising words and restyling a caption track were being
  written into its history under the same description, so it could not tell the two apart;
  and when it re-made a change that was already on your timeline, it recorded that as a
  *failure* and went looking for a cause to fix. Neither is true any more: each action is
  now recorded as the thing it actually was, and work already in place is reported as done
  rather than broken.

- **The summary at the end of an AI edit is readable again.** It had been listing every
  change as `Set track caption style:` — the same line eight times over, each one trailing a
  colon and then nothing, with no mention of which track was touched. It now names what was
  changed and where, and says each thing once with a count instead of repeating itself. It
  also no longer claims changes "did not validate" when they validated fine and were simply
  already in place.

- **The AI stops telling itself your whole request has passed.** Its internal check confirms
  the timeline is consistent — it cannot know whether the effects you asked for were added.
  It had been recording that check against your request word-for-word, so a job with half the
  work missing still read as passed. The check is now labelled for what it actually covers.

- **Cuts made to music actually land on the beat.** When you ask the AI to cut to a track, it
  analyses the music and gets the exact position of every beat — but nothing was checking its
  cuts against them, so a cut could sit just off and the montage would feel loose for no
  visible reason. Now, whenever it has measured the music, a cut that is very slightly off is
  moved onto the beat for you, and one that is badly off is refused with the nearest real beat
  named so it can correct itself. There is no setting for this: the AI decides whether the
  music matters, and if it does, the timing is guaranteed. Edits where it never looked at the
  music are unaffected.

### Changed

- **Captions on a fast-cut video can be checked again.** Asked to improve the captions on a
  20-second montage, the AI would read the footage, think it through, and then change
  nothing. The caption checker was the reason: it treated every *picture* cut as a place a
  caption must not cross. On a montage with a shot every half-second that is impossible to
  satisfy — there is nowhere to put a caption, and even a single word fails — so the AI
  correctly refused to make an edit it could not get right. It also called all 40 captions
  "out of date" simply because the project had been edited since, even though every one of
  them was still perfectly in time.

  A caption may now sit over as many shots as you like. It is only flagged when it would
  bridge a genuine break in the **speech** — two pieces of audio that were never spoken in
  one breath — which is the thing a viewer actually notices. And a caption is called out of
  date when it has really drifted off its words, not because you graded a clip afterwards.
  What used to be 68 confusing warnings is now a short, readable list you can act on.

- **The AI remembers more of what it read.** Sixteen of its inspection tools handed back a
  raw, mid-sentence slice of data, so a moment later the AI only "remembered" a fragment of
  gibberish — including, in one case, the result of its own caption check. It then went
  looking for answers it had already been given. Those tools now report their findings in
  plain terms (how many silent gaps and how long, where every cut is, which effects and
  transitions exist, what a check found and what is wrong), and a new safeguard means a tool
  can no longer be added without one.

  Reading the transcript of an edited timeline is also half the size it was and comes back in
  one go instead of four, so the AI spends its turns editing rather than re-fetching.

- **Exporting an AI conversation now gives you the whole run.** The Markdown export used to
  keep only the messages, so everything that explains an outcome — the thinking, each tool
  call with its arguments and raw result, every proposed edit with its operations and
  validation issues, run status changes, cost, and the resume checkpoint — was dropped from
  the file you shared. It now writes the complete transcript, turn by turn, with nothing
  from the log left out. You can also **copy** it: the conversation you are looking at has
  "Copy transcript" and "Export transcript" in the sidebar's ⋯ menu, and every row in the
  history drawer now offers "Copy Markdown" next to "Export Markdown".

- **FramePilot now has one AI editing runtime.** Requests that needed analysis before they
  could edit — "cut this to the music", "build a montage from the best shots" — used to run
  through a separate planning engine with its own understanding, planning and execution steps.
  Everything now runs through the agent you already watch work: it looks at the footage,
  detects the beats or scenes it needs, and makes the edit, all in one visible run. In
  practice that means those edits gain what the agent already had and the old path never did:
  you can steer them mid-run, undo the whole run as one action, and pick them back up after a
  crash or a restart. Cancelling stops them immediately with nothing half-applied. Beat-synced
  cuts land on exactly the same detected onsets as before. (ADR 0126,
  `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` Phase 1)

### Fixed

- **Calling the real Claude API through a self-hosted bridge no longer fails outright.**
  Two of the AI's tool descriptions (`map_time` and the professional audio mixer) told the
  model "pick exactly one of these shapes" in a way Anthropic's own Messages API refuses
  to accept from any tool — a call through a bridge that forwards straight to Claude's real
  API came back `input_schema does not support oneOf, allOf, or anyOf`. Both tools now
  describe the same rule in plain language instead, and nothing about what they actually
  accept or reject changed. A standing check now catches any future tool that makes the
  same mistake.

- **Asking the AI to restyle your captions no longer sends it in circles.** "Use a different
  caption style and emphasize the captions" could end a run with nothing applied: the read
  that reports the style your captions already use summarised it as a track and clip count,
  dropping the style itself, so two turns later the run had forgotten the one answer it
  needed and went looking for it again. Reads that carry caption information now keep it —
  the template a track uses and how it accents words, a clip's cue and any per-cue override,
  every mapped word with its timing, and the full template catalog listed by family. The
  catalog is also fully reachable now: 51 templates existed but no single request could
  return more than 45, and the default returned 20, so the style actually applied to your
  project could sit past the cut where the AI could neither name it nor pick something
  different.
- **Looking something back up mid-run now answers the question that was asked.** A query
  had to appear word-for-word inside a single record to match, so a perfectly sensible
  search for several terms at once came back "no match" even when every one of them was
  there. Queries now match on any of their words, with an exact phrase ranked first. And
  nothing is unreachable any more: a stored result larger than the recall budget used to
  hand back the same opening section however many times it was asked for, with no way to
  read on. It now says where it stopped and can be resumed from there.
- **"Continue" no longer costs the AI its goal.** Typing just "continue" (or "contine")
  made that word the run's objective, its success criterion, and the thing its own
  verification checked — so the run both forgot what it was doing and could only report
  itself inconclusive. A message that only asks it to keep going now resolves to the
  request underneath it, and what you actually typed is still kept verbatim. Its first
  reading of a request is also no longer permanent: it can be refined by a proper
  interpretation instead of being locked in before the run has looked at anything.
- **The AI can now see where each clip starts inside its footage.** Ask it to re-cut a
  montage so the clips don't all begin at the head of the take, and it used to circle: the
  reads that report each clip's in-point out of the original file were being cut off after
  about four clips out of forty, with nothing to say the rest was missing. It now receives
  every clip's timeline span *and* its source in/out, and on a long timeline it is told how
  to page through the rest. Looking something back up mid-run (`recall_evidence`) can now
  narrow to the clip you name instead of handing back the same truncated head.
- **The AI is no longer told to use tools it does not have.** A run driven by a model that
  cannot look at pictures was still being advised to "look at a frame", and two of the
  editing playbooks listed a background indexing tool the AI can never call. Both are gone,
  and a test now fails if any playbook advertises a tool the model cannot actually select.
- **Errors in the AI panel look like errors, and line up.** A failed run's notice had lost
  its red edge entirely, its Retry and Show details buttons sat out of line with the message
  they belong to, and opening "Show details" squeezed the detail text into a narrow column
  beside the message instead of laying it out underneath. Notices without an icon — plain
  informational ones — also started 20px to the left of every warning and error above them.
  All four came from three stylesheets describing the same card and disagreeing; one owns it
  now.
- **Assistant replies no longer waste a third of the panel on indentation.** Bulleted and
  numbered lists in the AI's replies were falling back to the browser's own spacing: a 40px
  indent in a 300px-wide panel, with markers sitting well outside the text column, and gaps
  between paragraphs half again wider than they needed to be.
- **One on/off control across the app.** "Keep inside safe area" in the caption panel was a
  bare browser checkbox; it is now the same switch as "Plan first" and every Settings row.
  Caption row selection uses the app's own checkbox instead of the browser's.
- **The AI stops re-deciding what you asked for on every turn.** Its own notes on a run
  recorded what it had just done ("Reading the timeline → Reading the timeline") instead of
  what it had found, and the run brief repeated your request back to it under four different
  headings. So each turn started over: one real montage request spent thirteen minutes and
  six and a half minutes of that inside a single thinking step, re-deriving the same plan.
  Its notes now carry the actual finding ("5 tracks, 87 clips…"), and the brief states your
  request once.
- **The AI can no longer be told to check its notes with no way to open them.** When a run
  has gathered enough and is pushed to start editing, fresh searches are withheld on
  purpose — but so was the one tool that reopens what it already read. It went ahead and
  guessed clip lengths from filenames. That tool now stays available.
- **The "going in circles" detector actually runs.** It was checking the wrong thing and had
  been silently passing every run, which is why a run that kept re-reading the same footage
  was never stopped and redirected.
- **`trim_clip` says what it cannot do.** Moving a clip's edges also moves what it reads
  from the footage; the description now says so, and names the way to change one without the
  other. (ADR 0127)

- **A hallucinated analysis request can no longer reach the media engine.** On the retired
  planning path, the arguments the model wrote for an analysis step were passed to the engine
  without being checked against that tool's schema. Every AI tool call is now validated at the
  boundary before anything is dispatched, as the agent has always done.

### Added

- **Vercel AI Gateway as a selectable AI provider.** Settings → AI now lists **Vercel AI
  Gateway** alongside the existing providers: paste a gateway key, pick a `provider/model`
  slug (default `anthropic/claude-sonnet-4.6`), and edits run through it like any other
  provider. The gateway fronts 100+ upstream models behind one OpenAI-compatible endpoint,
  so a single key covers Claude, GPT, Gemini and the rest, with Vercel's spend tracking and
  failover in front of them. It reads the static `AI_GATEWAY_API_KEY` (Vercel's own variable
  name); the OIDC token flow is deliberately not used, since those tokens expire in about a
  day and a desktop editor cannot assume the Vercel CLI is present to refresh them.
  (`packages/ai-sdk`, `apps/desktop`, `apps/web-editor`)

- **A manual, real-provider capture path for the FramePilot 9.5 Foundation benchmark.**
  `pnpm eval:agent:foundation` proves the Foundation *contract* entirely offline, but two of
  the roadmap's Phase-0 exit rows — real-provider latency/cache evidence and a real-provider
  Tier B-D distribution — need a real model call a hermetic CI run cannot honestly fabricate.
  `pnpm eval:agent:foundation:real` now drives every Tier B/C/D agent-outcome scenario through
  the real `Orchestrator.streamAgent` path against a real Google Gemini call (via the existing
  `BaselineCaptureProvider` rig), reusing the same fail-closed grader as the offline suite. It
  runs only as a manual `.github/workflows/foundation-real-eval.yml` (`workflow_dispatch`) job
  gated on a `GOOGLE_API_KEY` repository secret — not on every push/PR, since these are real,
  billed calls. This closes the *measuring infrastructure* for those two exit rows, not the
  rows themselves: the semantic Tier B-D predicates (e.g. "long awkward pauses are shortened")
  have no automated grader yet, so most/all captured runs correctly report `status: 'failed'`
  even when the real provider call succeeded — see
  `docs/quality/FRAMEPILOT-95-FOUNDATION-BASELINE.md` for why that is honest, not a defect.
  (`packages/ai-sdk`, `.github/workflows`)

### Changed

- **Relicensed from fully proprietary to source-available, non-commercial.** The prior
  license barred running, modifying, or contributing to the source at all without prior
  written permission. The new license (v2.0) grants free rights to view, run, modify, and
  contribute to the source for non-commercial purposes; commercial use of any kind — resale,
  hosting as a service, internal business use, or incorporation into another commercial
  product — still requires a separate written license. The packaged, paid desktop app is
  unaffected — it remains a separate commercial product under its own terms.
  (`LICENSE`, `README.md`, `CONTRIBUTING.md`)

### Removed

- **Recipes are gone.** Saving a run "as a recipe", the saved-workflow shelf in
  Settings → Memory, and the fixed templates behind them (remove silence, add captions,
  improve pacing, add hook, punch in, export reels, filler cleanup) have all been removed.
  A template could only ever do the request it was written for, and deciding when it
  "matched" was the problem: ask for an intro *with keyframes* and the template took the
  job, did none of the keyframe work, and reported "no changes — instant, no AI needed" as
  if that were a success. Every command now goes to the assistant, which reads what you
  actually asked for. (`packages/ai-sdk`, `apps/web-editor`, `apps/desktop`)

### Fixed

- **The timeline's track controls no longer run off the edge of their column.** The lock
  and solo buttons were drawn past the end of the track-header column, underneath the
  clips, so the row ended in a clipped, broken-looking edge. The controls had been enlarged
  to a proper touch target without widening the column to match; the column now fits them.
  (`apps/web-editor`)
- **The Export dialog's header is a header again.** Its title sat jammed in the top-left
  corner with the close button stacked underneath it, because the header's styling was
  written for the Settings dialog only and never applied here. (`apps/web-editor`)
- **The assistant knows the shape of your footage before it starts.** The chapter-by-chapter
  map of what is in your clips existed but was never given to it. It now arrives with each
  run — read only from what has already been analysed, so starting a run on new footage is
  never slowed down or billed for it. (`apps/desktop`, `engine/python`)

- **The assistant can now actually see the frames it renders when you ask it a question.**
  Asking "how many people are on screen at 13.3s?" made FramePilot render that frame — and
  then never show it to the assistant. Answering a question uses a different path from
  making an edit, and only the editing path was attaching the picture; the question path
  passed along the note saying "the frame is attached as an image" with no image behind it.
  So the assistant either told you it had no visual access to a frame it had just rendered,
  or described one it had never seen, and the render (up to 40 seconds of work) was wasted.
  Frames now reach the model on both paths, are shown once rather than re-sent and re-billed
  every turn afterwards, and a frame served from the run's cache no longer claims to be
  attached when it isn't. (`packages/ai-sdk`; ADR 0096)
- **Asking FramePilot to look at something no longer counts as a failed edit.** "Look into
  the frame", "check 12s", "identify the people in this shot" were being classified as
  editing commands. They ran the full editing agent, which — correctly — cannot finish a run
  that changed nothing, so a question that was answered perfectly well ended under a red
  "this run ended without applying anything" banner. Inspecting is now understood as a
  question, however you phrase it. (`packages/ai-sdk`)
- **The assistant now knows what it can see before it answers.** It was never told whether
  your footage had been indexed for visual search, so it guessed at its own abilities — and
  answered questions about what is on screen by reading the timeline summary, which cannot
  see anything. Each run now starts knowing its visual coverage, and when something is
  unavailable it says what it can still do instead of naming an internal step you have no
  way to run. (`apps/desktop`, `packages/ai-sdk`)
- **Checking an edit is now about seven times faster and uses a quarter of the memory.**
  When FramePilot looked at an edit to see whether it worked, it decoded and measured your
  footage at full 4K — to compute averages and ratios that a much smaller frame produces
  identically. It now checks at a bounded size, and never decodes a clip larger than the
  frame it is being fitted into. On an eight-clip 4K sequence a checked frame went from
  273ms and 781 MB to 38ms and 176 MB. The same applies to the stills the assistant looks
  at while it works: asking for a small picture no longer renders a huge one first. Your
  exports are untouched and still render from the original camera files. (`engine/python`;
  ADR 0124)
- **Long AI runs no longer grow until they exhaust your machine.** On a multi-step run over
  4K footage, memory could climb into the tens of gigabytes and take the whole computer down
  with it. Making edits apply instantly had, as a side effect, let every step start its own
  full perceptual review at the same moment — and each of those was rendering real frames at
  your project's resolution and keeping all of them. Reviews now run one at a time, are
  skipped entirely when a later step has already rewritten the part of the timeline they
  were about (their verdict was being discarded anyway), and keep only the frames they
  genuinely need to compare. A run of any length now stays flat in memory instead of growing
  with the number of edits. (`packages/ai-sdk`, `engine/python`; ADR 0123)
- **The editor no longer does invisible work on every edit.** The history panel rebuilt every
  past version of your project each time anything changed — even when the panel was closed
  and had never been opened. It now reconstructs only the version you hover over. Alongside
  this, the assistant's activity feed stopped re-analysing every step's changes many times a
  second while a run streams. (`apps/web-editor`)
- **Preview stopped leaking video frames and audio.** Several paths — a decode interrupted by
  an edit, a seek overtaken by a newer one, and tearing down the player — dropped decoded
  frames without releasing them, and switching preview modes left every decoded audio track
  in memory. These accumulated for as long as the app stayed open.
  (`apps/web-editor`)
- **A failed render setup no longer strands ffmpeg processes.** If preparing a timeline
  failed partway — a missing file, an unreadable LUT — the media readers already opened were
  abandoned, each holding a live ffmpeg process and its decode buffers. They are now released
  before the error is reported. (`engine/python`)

### Changed

- **AI edits now apply to your timeline the moment they are made.** Previously an edit was
  held back until a full perceptual review had rendered real frames and audio through the
  engine — 30 seconds to four minutes on a real sequence — so the timeline sat still for the
  whole run and then everything landed at once. Even "Auto" apply mode worked this way.
  Edits are now committed as soon as they validate (still validated, still checked against
  the current timeline), and review runs afterwards, alongside the next step, reporting what
  it finds instead of holding the work hostage. If review spots a real problem the assistant
  fixes it in a following step; if it cannot, you get a clear note about what is wrong and
  where. (`packages/ai-sdk`, `apps/desktop`, `apps/web-editor`; ADR 0122)
- **Accept/Reject is gone — edits apply, and Undo takes them back.** The review cards, "Apply
  all", the keep-only-some-changes preview and the Manual/Auto dropdown have been removed.
  Reviewing a list of timeline changes never told you whether an edit was any *good*; only
  watching it does. Each step now shows what it changed with a jump straight to that point on
  the timeline, and a run footer offers **Undo run** to reverse the whole thing in one action
  for as long as it is still the most recent change. The before/after preview remains, as a
  read-only look at what happened. (`apps/web-editor`; ADR 0122)
- **The assistant now tells you when your own saved workflow is what ran.** Teaching a
  workflow rerouted the whole run to your saved settings but said nothing about it, so the
  feature paid off invisibly and looked as though nothing had been learned. Matching runs
  now say which workflow answered. (`apps/web-editor`)
- **Cuts snapped to the beat are reported instead of only logged.** When the planner moves
  proposed cuts onto real audio onsets it now says how many it moved — a craft decision the
  editor should see, not an internal detail. (`packages/ai-sdk`)

### Added

- **Tracking Lite is now a real, separately packaged tracking worker.** Point, region, and planar
  tracking are implemented as an on-demand Capability Pack artifact
  (`workers/tracking-lite/`) rather than as weight added to the base installer: point tracking uses
  pyramidal Lucas–Kanade flow, region tracking uses CSRT with confidence measured from appearance
  similarity instead of a boolean status, and planar tracking fits a homography anchored to the
  requested quad. When the subject is occluded the last known box is held and flagged, never
  extrapolated, and a genuinely lost target fails as `target_lost` instead of returning a
  plausible-looking fabricated track. The worker disables its own networking, cannot write to a
  project, runs one thread with a fixed seed for identical results across runs, and answers
  cancellation mid-track. Desktop invocation, platform builds, and signed publication follow.
  (`workers/tracking-lite`)
- **Tracking Lite now proves itself against real video, and ships a real supply-chain record.** The
  pack pins exact dependency versions with wheel digests, and its licence notice and SBOM are
  generated from the environment that actually resolves rather than written by hand — including the
  LGPL components the OpenCV wheel redistributes, which the catalog must disclose before you approve
  a download. A separate build job encodes and decodes real video of a moving subject and requires
  every tracker to recover the true motion within 8 pixels, to disagree with a mirrored trajectory,
  to produce identical results run to run, and to report a subject that leaves frame as lost instead
  of inventing where it went. (`workers/tracking-lite`, `.github/workflows`)
- **The desktop app can now run the tracking pack under its own authority.** FramePilot picks the
  exact installed tracking release, holds it in place for as long as the job runs so it cannot be
  removed mid-track, and refuses to start against a project that has changed since the request was
  made. A pack that is missing produces an install offer, a pack that is damaged says so instead of
  looking absent, and a tracker that genuinely loses its subject reports that rather than a made-up
  result. (`apps/desktop`)
- **A measured track becomes a normal, undoable edit.** Tracker output now passes through one
  deterministic policy before it touches your timeline: uncertain or occluded frames never steer the
  mask, brief losses are bridged, a long loss is refused instead of guessed, jitter is smoothed, and
  no single bad frame can throw the mask across the picture. The result applies as one patch that
  undoes exactly, survives save and reload, and records which pack version measured it.
  (`packages/editor-core`)
- **Ask FramePilot to track a subject and it plans the job from what you drew.** Draw a mask around
  the subject and the editor works out the rest — which clip, which frames, whether to follow a
  point, the whole box, or the surface as a plane — and refuses clearly when there is nothing to
  track rather than guessing at a region. An overlay can then follow the result: it stays exactly
  where you placed it and moves with the subject, and while the subject is hidden it stops following
  instead of drifting on a stale guess. (`packages/ai-sdk`, `packages/editor-core`,
  `apps/desktop`)

- **Updates and add-on downloads now have a verified path to your machine.** Before an update is
  published, FramePilot checks that the update manifest actually matches the files being shipped —
  right file, right size, right fingerprint, right version — because an update manifest that points
  at the wrong thing breaks updating for everyone already installed and cannot be repaired by
  shipping a fix afterwards. The same build refuses to ship if an optional add-on's payload has
  crept into the main installer, which is what keeps the download small. Setting up the signing key
  that add-ons are verified against is now a single documented command, and the key is written in a
  way that keeps it out of build logs. (`scripts`, `packages/capability-packs`)

- **FramePilot can now find the people in your footage, without shipping a model in the app.**
  A new Subject Intelligence pack detects faces, people and objects and cuts a matte around a
  subject you point at — downloaded on demand, run entirely on your machine, with networking
  disabled inside the worker so nothing about your footage leaves the computer. It is honest about
  what it cannot see: no people found means no people found rather than a box in the middle of the
  frame, pointing at empty background says there is nothing there instead of inventing a matte, and
  the exact models that produced a result are recorded with the edit. The weights are pinned and
  checked against their published fingerprints every time they load, so a swapped model stops the
  pack rather than quietly changing your results. (`workers/subject-intelligence`)

- **Framing checks can now be confirmed on your own machine.** When FramePilot moves or crops a
  shot, it checks that the subject is still framed. That check can now be answered locally by the
  Subject Intelligence pack instead of a cloud model — no footage leaves the computer and there is
  nothing to pay per check. It stays strictly inside what it can actually judge: it will tell you a
  face is cut off at an edge, it will not pretend to judge whether a transition reads, and finding
  nobody in the shot leaves the check unconfirmed rather than failing a perfectly good edit on
  B-roll. (`packages/ai-sdk`)

- **Grades and audio edits are now proven from the exported file, property by property.** A grade
  has to change the picture in the direction it claims and leave every other layer's pixels
  untouched, so a colour change that leaks across shots can no longer pass as a working grade. A
  gain cut has to make the exported audio measurably quieter rather than merely different, and
  normalization has to lift a quiet source — with a control proving the lift came from normalization
  and not from re-exporting. Each proof is paired with a plausible wrong answer that must fail it.
  (`engine/python`)

### Changed

- **Looking at your edit is now nearly instant after the first look.** Rendering a frame of
  your timeline meant rebuilding the whole sequence from scratch every single time — about
  0.8 seconds per clip before the picture was even started, so on a 37-clip sequence every
  frame cost over half a minute and five frames cost three minutes. The built sequence is now
  kept and reused while nothing has changed: the first frame still costs what it costs, and
  the ones after it came back in about a second in testing. Change anything and it rebuilds,
  so you are never shown a stale picture. This also lifts a hard ceiling — past roughly 150
  clips these requests simply ran out of time and were abandoned, and the edit was built
  without the picture the AI asked to see. (`engine/python`)

- **The sidebar shows what the AI is actually doing.** A request spent its first half-minute
  understanding what you asked and drafting a plan, with nothing on screen for any of it —
  the app looked frozen at exactly the moment it was thinking hardest. Those phases now
  appear in an **Activity** list with live timers, alongside the plan itself rather than
  instead of it. (`packages/ai-sdk`, `apps/web-editor`)

### Fixed

- **Committing an ordinary edit no longer reports failure after it already saved.** The
  renderer transport facade replaces a successful same-revision commit's project with a
  compact patch envelope (to shrink the IPC payload); the desktop main process was
  re-parsing that envelope as a full project to reconcile Capability Packs, which always
  threw after the write, recovery snapshot, and WAL entry had already completed —
  reporting `invalid_patch` for every ordinary patch on the primary edit path used by both
  users and the AI. (`apps/desktop`)
- **A Capability Pack worker that exits before reading its input can no longer crash the
  app.** Writing to a dead worker's stdin raised an unhandled `EPIPE` with no listener on
  the stream; it is now caught and reported as a normal worker failure. (`packages/capability-packs`)
- **Restarting the render sidecar (after a pack install or storage relocation) no longer
  leaves rendering, exporting, and transcription dead until the app restarts.** `stop()`
  killed the old process without detaching its exit listener, so the dying process's
  delayed exit event could mark the newly started sidecar as failed. Listeners now check
  they still belong to the current process before touching state. (`apps/desktop`)
- **Installing a signed Capability Pack on Windows no longer gets quarantined regardless
  of a valid signature.** The Authenticode check spawned bare `powershell.exe` with a
  wholesale-replaced environment that dropped `PATH`, so the spawn itself failed
  (`ENOENT`) and was misreported as an untrusted executable. Process-launch essentials
  (`PATH`, `SystemRoot`, etc.) are now preserved. (`packages/capability-packs`)
- **The release workflow now actually signs macOS builds and publishes the update feed.**
  Both steps gated their `if:` on a variable defined only in that same step's own `env:`
  block, which GitHub Actions does not expose to that step's `if:` — so both conditions
  were always false and the steps silently no-opped. The variables now live at job level.
  (`.github/workflows/release.yml`)

- **Adding captions can no longer delete an unrelated overlay.** When a project had no
  dedicated caption track and captions landed on an `overlay` track instead (the same
  fallback logos, watermarks, and other graphics use), asking for captions could wipe
  that overlay content along with any previous caption set. Clearing now only ever
  touches clips it actually generated. (`packages/ai-sdk`)

- **Stopping a run during its final review check now reports "cancelled", not "failed".**
  Clicking Stop in the narrow window while the quality check was finishing its verdict
  showed the run as failed and surfaced its unreviewed edits as if they were a real
  answer, instead of respecting the cancellation like every other stop point in the run.
  (`packages/ai-sdk`)

- **Frame and evidence requests against the same edit no longer race each other.** Under
  real concurrent load, two requests hitting a freshly built composition at once could
  return a frame from decoders that had just been closed by an unrelated cache eviction,
  or each pay the full multi-second compile cost separately instead of one waiting on
  the other's result. (`engine/python`)

- **Visual indexing no longer double-processes an asset or loses progress under
  concurrent requests.** Two indexing calls landing at once for the same project could
  both read the same starting point, both re-embed the same asset, and have the second
  write silently overwrite the first's progress. (`engine/python`)

- **A rejected edit is kept when the check actually looked at it.** When semantic review
  examined an edit and judged it wrong, the work was discarded; now it is handed to you with
  the finding, like every other check. A review that could not run at all — for example
  because it needs your permission to send media — still stops without releasing anything,
  because that is a permission answer, not an opinion about the edit. (`packages/ai-sdk`)

- **Models that don't accept a temperature setting now work.** Newer reasoning models reject
  the creativity setting outright, so every request to one failed and the app was unusable
  with them. FramePilot now notices when a model says it doesn't take that setting, drops it
  for that connection, and carries on — without ignoring it for the models that do honour it.
  (`packages/ai-sdk`)

- **An interrupted run can be recovered again.** A run stopped mid-flight could leave behind a
  record FramePilot then refused to read, so it could never be tidied up: it failed to recover
  on every single launch, forever. Those records load again and the runs close properly.
  (`packages/ai-sdk`)

- **A repair that changes nothing no longer reports itself as broken.** When the automatic
  repair decided there was nothing to change, FramePilot called it "did not produce a valid
  patch" — sending you looking for a broken edit that never existed. It now says what actually
  happened: the repair made no changes, and the issue review found is still there.
  (`packages/ai-sdk`)

- **A run that fails its quality check no longer throws away the work it did.** When the
  perceptual check found a problem it could not automatically repair, FramePilot discarded
  every edit of the run — you were left with a warning and a Retry button after it had
  planned, analysed your footage, and made and validated real edits. The edits are now handed
  to you, clearly marked as not confirmed by review and carrying the specific finding, so you
  can look at them and decide. They can never be applied automatically in that state.
  (`packages/ai-sdk`)

- **The sidebar now shows the check running instead of going quiet.** Checking an edit against
  the rendered picture and sound is the longest part of an editing run — up to a minute on a
  real sequence — and the sidebar said "Done." and then showed nothing at all until it
  finished. The check now appears in the step list like every other step, with a live timer,
  so the wait is visible and named. (`packages/ai-sdk`, `apps/web-editor`)

- **Asking for captions on a project that already has them now works.** Captions are named
  after the moment they appear, which is what lets a regenerated set be recognized as the
  same captions rather than a second copy — but it also meant that asking a second time
  (a different template, a re-run transcript, a changed cut) collided with the captions
  already on the track and the whole request failed on the first cue. Since a template
  change re-groups the words, the second set is not the same set anyway. FramePilot now
  replaces the caption set on that track: your new captions land with the template you
  asked for, and one undo brings the previous set back. (`packages/ai-sdk`)

- **Perceptual review now finishes instead of timing out on real projects.** FramePilot
  checks its own edits by measuring the actual picture and sound at every cut it made, and
  it gave up on that check after two minutes — less time than the check needs on a sequence
  of any real size, so on a large edit it always gave up, and every result came back
  "applied but not reviewed". The engine and the app now work to one shared time budget:
  the largest batch of measurements the engine will accept is one the app will actually
  wait for. Measurements are also taken in playback order, which on longer sequences is
  roughly twice as fast as jumping around the timeline for them.
  (`engine/python`, `packages/ai-sdk`)

- **One slow analysis no longer breaks every other analysis in the run.** Reading your
  footage with an understanding model takes minutes on a large project, and while it ran the
  engine could not answer anything else at all — so beat detection and visual search, sitting
  in the queue behind it, were reported as failures they never got the chance to attempt. The
  edit was then built with none of them. Analyses now run alongside each other, and the ones
  that legitimately take minutes are given minutes. (`engine/python`, `packages/ai-sdk`)

- **An edit built without the analysis it needed now says so.** When a requested analysis
  came back empty, FramePilot carried on without telling the editing step anything was
  missing — and asked for a beat-synced montage with no beat grid, it produced evenly spaced
  cuts through your clips in the order they sit in the bin and presented that as synced to
  the music. The editing step is now told exactly which analysis is missing and instructed
  not to invent a substitute, so you get the part it could genuinely do, plus a plain
  statement of what it could not. (`packages/ai-sdk`)

- **Big edits no longer fail on their own size.** Asking for a montage of thirty-plus cuts could
  end in `Too big: expected string to have <=256 characters` and a Retry button. FramePilot labels
  each step of a run so it can recognise repeated work, and it was building those labels out of the
  full text of everything the step did — so the more the step edited, the longer its label, until it
  broke the run's own record and took the run with it. Labels are now a fixed size no matter how
  much work a step does. (`packages/ai-sdk`, `apps/desktop`)

- **A music bed no longer fails review for starting.** Laying music across a montage made FramePilot
  check for an audio "discontinuity" at the very first frame of the programme — where there is no
  cut, only the music beginning — and the level it measured there threw away the whole edit after it
  had already been applied and validated. Continuity is now checked across actual cuts, and only
  where the programme has sound on both sides of one; every other window is still metered for level,
  so a genuinely clipped or jarring mix is still caught. (`packages/ai-sdk`, `engine/python`)

- **Mixing audio no longer takes several rejected attempts to get right.** The audio tool advertised
  every setting as valid for every job, so asking it to ride a level could come back with a wall of
  refusals about EQ bands and fades that were never going to be accepted — sometimes losing the edit
  entirely when a repair attempt made the same call again. Each job now offers only its own settings,
  and a setting filed under the wrong one says which job owns it. (`packages/ai-sdk`)

- **Stopping a run can no longer leave a visual check counted as confirmed.** If you cancelled while
  FramePilot was still looking at the render, a review already in flight would finish and its answer
  would still count toward letting the edit commit. Cancelling now leaves every visual objective
  unconfirmed — including one whose answer arrives after you stopped — so a stopped run cannot end in
  a committed edit on the strength of a check you interrupted. (`packages/ai-sdk`)

- **Real Capability Pack workers can satisfy the signed health handshake.** The installer now passes
  the approved release identity and capability roster into health-check mode, avoiding a circular
  requirement to embed a release digest that cannot exist until after the artifact is hashed.
  (`packages/capability-packs`)
- **Sampling settings reach every OpenAI-compatible chat provider again.** OpenRouter,
  NVIDIA, and custom OpenAI-compatible servers now receive an explicitly requested
  temperature; requests that omit it continue to leave the provider default untouched.
  (`packages/ai-sdk`)
- **Professional editor activity cards use editor language instead of raw tool ids.** Color
  measurement, timeline, motion, color, tracking/mask, and audio commands now have explicit
  sidebar labels and domain-appropriate icons. (`apps/web-editor`)
- **Caption review stays operable in the narrow editor rail.** Virtualized cue rows now reserve a
  stable, non-overlapping action area, so editing and merge controls cannot intercept each other;
  undoing the first track style also resets the gallery to the restored template. The previously
  disabled caption and visual E2E contracts now follow the current Review → Style → Generate,
  Inspector-category, and AI-mode workflows. (`apps/web-editor`, `tests/e2e`)
- **CI now proves the release instead of reporting placeholders.** Pull requests and `main` pushes
  automatically run blocking functional and visual E2E, a mandatory desktop build, a real
  render-plus-validation fixture, and all 33 cross-runtime professional-operation render evals.
  The local `pnpm verify` command now mirrors those release gates; `verify:core` remains the fast
  development loop. (`.github/workflows/ci.yml`, root tooling)
- **The desktop release workflow is valid when signing secrets are absent.** The optional macOS
  certificate is projected through step environment before its condition is evaluated, avoiding a
  GitHub workflow-parse failure on every push. (`.github/workflows/release.yml`)
- **The web editor is strict-type clean again.** Manual patch persistence now keeps a stable bridge
  capability across asynchronous commits, imported media chunks cross IPC as owned
  `ArrayBuffer`s, and migrated legacy speech providers are ignored before a background job is
  created. (`apps/web-editor`)
- **Unreviewed AI edits can no longer slip through auto-commit when the reviewer is offline.** A
  temporal-review outage now marks the released proposal as unverified, and the desktop keeps it in
  human review even under auto-commit policy. Successfully reviewed edits carry an explicit verified
  disposition, and a missing legacy disposition is review-only too. (`packages/ai-sdk`, `apps/desktop`)
- **Accepted AI edits are idempotent across browser reloads and desktop transport retries.** Browser
  proposals and decisions now enter the shared durable WAL, repeated decisions produce one event,
  and recovery never re-emits a diff. Desktop recognizes an identical patch already present in
  persisted history and returns the existing full project/revision without another write, revision
  bump, or renderer-side patch application; patch-id collisions fail closed. (`apps/web-editor`,
  `apps/desktop`, `packages/shared-types`)
- **A stale Source Monitor selection no longer poisons the next AI request.** Closing the monitor or
  removing its asset clears the ephemeral snapshot; a vanished source asset is omitted from context
  while malformed live marks and clocks still fail closed. (`apps/web-editor`, `packages/ai-sdk`)
- **Professional controllers now reject project-only revision drift.** The live host revision is
  checked independently from the captured interaction/timeline snapshot, and multi-command domain
  tools validate and reverse their combined patch before releasing operations. (`packages/ai-sdk`)
- **Rendered professional evals inspect the applied project, not the fixture from before the edit.**
  The runner now sends the persisted post-edit revision to acquisition, and audio-only timelines
  receive a deterministic black picture canvas so their real mix remains renderable and measurable.
  (`packages/ai-sdk`, `engine/python`)
- **Lowering a clip's volume no longer wipes its EQ, compressor, or level ride.** Setting a plain
  gain on a clip you had just cleaned up used to silently delete that work — the edit reported
  success and you only found out on playback. Saying nothing about a processor now leaves it alone;
  clearing one is something you ask for. (`packages/editor-core`, `engine/python`, ADR 0113)

### Added

- **Semantic edit review now runs inside the shared production gate.** Motion, crop, mask,
  tracking, and transition operations declare bounded visual questions; FramePilot renders up to
  four frames from the unsaved edited project and requires a strict one-shot verdict before marking
  the proposal verified. Reviewer provider/model/prompt and exact local pack identity are recorded,
  and cloud media egress is blocked before rendering unless the run carries explicit consent.
  (`packages/ai-sdk`, `apps/desktop`)
- **On-demand tracking workers now have a real protocol contract.** Point, region, planar,
  face/object detection, and segmentation jobs use revision-bound sandboxed media handles,
  normalized geometry, bounded progress/results, confidence and occlusion, exact backend/model
  lineage, and typed terminal failures. The runtime resolves symlinks before launch, strips the
  process environment, starts without a shell, matches result identity exactly, and enforces
  cancellation/timeouts. Heavy native/model dependencies remain outside the base application.
  (`packages/capability-packs`)
- **Projects can pin heavyweight professional capabilities without bundling their models.** Schema
  v19 adds platform-neutral, immutable Capability Pack release pins with a migration that never
  guesses dependencies from existing tracks or effects. A host-neutral pack package now validates
  HTTPS-only platform artifacts, canonical release digests, Ed25519 catalog signatures, worker
  handshakes, install approvals/progress, storage records, pins, leases, and monotonic install
  lifecycles. Its host storage authority now uses atomic index commits, crash lease recovery,
  corrupt-index quarantine, project pin/lease guards, and two-phase removal. Explicitly approved
  artifacts can now download outside the app bundle with conservative ETag/Range resume, shared
  in-flight work, cancellation, disk-space refusal, exact-length checks, and SHA-256 verification.
  Raw and ZIP artifacts extract into disposable staging with an exact signed allowlist and reject
  traversal, symlinks, duplicates, extras, omissions, overwrites, and expansion-limit violations.
  Executables must match the catalog's exact Apple Team ID or Windows certificate SHA-256 and pass
  native OS trust checks, then return a bounded worker handshake matching their signed identity,
  protocol, and capability set before installation can continue.
  The host-neutral installer now commits a recovery receipt, immutable directory, and atomic index
  in order; coordinates separate processes; quarantines trust/health failures; cleans cancelled or
  abandoned staging; and re-verifies a committed receipt before repairing an interrupted index
  commit. A broken progress observer cannot roll back or misreport an otherwise valid transaction.
  Catalog trust now starts from offline root public keys and supports time-bounded, non-transitive
  online signing keys with root-controlled rotation/revocation, future-date checks, durable rollback
  prevention, and corrupt-state quarantine. Catalog expiry never disables an already installed pack.
  Storage accounting now reports state totals and per-project usage, shows project/lease blockers,
  and can propose quarantined-first then LRU cleanup. Nothing is evicted during planning; execution
  requires the user's exact displayed identity set and rechecks live pins and leases before removal.
  Desktop IPC now keeps catalog URLs, manifests, trust keys, paths, and install commands in main;
  renderer approvals can reference only a short-lived main-verified proposal. Settings → Storage
  shows real usage, health, pins, leases, progress, and explicit cleanup review, while browser builds
  never attempt native downloads. Users can move the pack store to an empty custom folder through
  the native picker: FramePilot blocks active installs/workers, copies into staging, validates the
  index, commits the durable pointer atomically, and retains the old copy for recovery.
  Automatic capability-invocation prompts are still intentionally not advertised as complete.
  Project open/save/patch now reconciles exact immutable pack pins into storage, including unhealthy
  matching versions, so cleanup cannot remove a closed-project dependency by accident. Missing
  dependencies open an explicit review gate: the app rereads the active project in main, proposes
  only its signed pinned release, displays size/license/privacy/platform facts, and downloads only
  after a second exact approval. The success event waits for the durable project pin; degraded mode
  is explicit, and render-required missing packs still refuse export. Locate/cloud alternatives
  remain unavailable until a verified provider exists.
  Packaged local transcription now uses the same signed on-demand platform instead of Python's
  direct 574 MB model download. The base app no longer discovers a bundled Whisper helper; Settings
  reviews and approves the exact `framepilot.local-whisper` release, and Electron injects only the
  healthy immutable pack's CLI/model paths into the sidecar. Install and storage relocation restart
  the sidecar with refreshed verified paths. Source-development setup remains available separately;
  production macOS/Windows artifact publication is still a release gate.
  Release operators now have one offline `framepilot-pack` command to inventory staged payloads,
  reject symlinks and unapproved licenses, derive exact archive/file hashes and a deterministic
  SBOM, refuse false logical release digests, sign Ed25519 catalogs, emit digest-addressed CDN
  publication plans, and create strictly newer signed rollback catalogs without replacing old
  bytes. Private keys are read from files and never enter command arguments or generated output;
  actual platform worker builds, signing/notarization, and CDN publication remain open gates.
  Automatic subject tracking resolves to the on-demand Subject Intelligence pack rather than
  implying a bundled CV engine. Capability-triggered approval and project dependency choices remain
  under active implementation and are not silently invoked. (`packages/timeline-schema`,
  `packages/capability-packs`, `packages/ai-sdk`, `engine/python`, ADR 0114)
- **Every browser and desktop editing route now enters the same review boundary.** Browser edits,
  recipes, planned edits, agents, and routed commands publish the canonical lifecycle and fail closed
  to an unverified proposal when no temporal reviewer is configured. Desktop recipes and planned
  edits now run in the hardened main process with validated IPC and durable lifecycle records instead
  of executing in the renderer or being unavailable. (`apps/web-editor`, `apps/desktop`,
  `packages/shared-types`, `packages/ai-sdk`)
- **Durable AI-run policy is now host-neutral.** Sequence and project consistency, event
  idempotency, migration, WAL bounds, snapshot checkpoints, quarantine, retention, and cache limits
  live in AI SDK's shared `RunStore`; Electron retains only its fsync/atomic-rename filesystem
  adapter. Browser IndexedDB can now use the exact same lifecycle authority instead of growing a
  second implementation. A browser adapter now provides transactional IndexedDB WAL/snapshot and
  quarantine records; environments without IndexedDB use a namespaced localStorage fallback capped
  at one million characters per run and four million total, failing closed at the limit. Browser
  edit, recipe, planned-edit, agent, and auto editing routes now record their canonical lifecycle and
  terminal snapshot without persisting a command that could reapply a patch after reload. The
  sidebar now finds an interrupted browser run, durably classifies it as a process-restart failure,
  and projects only its error/status; it never re-enters the orchestrator or patch bridge. Normally
  observed terminal runs clear their handles so they are not immediately recovered twice.
  Browser edit, recipe, planned-edit, agent, and auto editing routes are now covered by one terminal
  durability matrix. Proposal-producing routes persist pending/committed decisions, and a
  deterministic planned-edit fixture proves a real accepted proposal with the same terminal outcome
  as desktop rather than counting a no-change mock as coverage.
  (`packages/ai-sdk`, `apps/desktop`, `apps/web-editor`)
- **MCP's professional-editor boundary is explicit.** Portable explicit-target operations remain
  schema-validated and reversible over MCP; controllers that require the live editor selection,
  playhead, Source Monitor, effects, or keyframes are omitted from discovery and reject direct calls
  with typed `host_ui_only`. (`packages/mcp-server`)
- **FramePilot can now look at its own work — but only where looking is the only way to know.**
  Some things a measurement settles: whether a cut landed on the right frame, whether the sound is
  peak-safe. Some it cannot: whether you are still in frame after a reframe. For those, FramePilot
  now looks at the finished frames and tells you what it sees. It is deliberately narrow — it can
  fail an edit that measured clean, and it can never bless one that measured broken. If it cannot
  tell, it says "unverified" and treats that as a problem rather than as approval, because the one
  question the numbers could not answer is the last one that should get waved through.
  (`packages/ai-sdk`)
- **Grade a whole camera at once, and keep faces out of it.** "Match all of camera B to this shot"
  now grades every clip cut from that camera file in one go — the grouping follows the footage, so
  it stays right no matter how the shots come to look. And when you ask FramePilot to protect skin
  while matching, it measures how much of the shot is actually skin-toned and holds the white
  balance back until faces stay within 8% of the warmth they started at. If there is too little skin
  in the shot to read, it tells you that instead of quietly claiming it protected something.
  (`packages/ai-sdk`, `engine/python`)
- **Clean up and shape a clip's sound: EQ, compression, and a level you can ride.** Ask FramePilot
  to roll off the rumble under a voice, take the harshness out at 3 kHz, even out a performance that
  swings between a whisper and a shout, or dip the music under a line and bring it back. EQ, the
  compressor, fades, and ducking all sit on the one clip you selected, and every one of them undoes
  exactly. A level ride is a curve on the clip, authored in frames, and it *replaces* the clip's
  level rather than stacking with it — so if a clip already has a ride, FramePilot says so instead of
  quietly accepting a level change you would never hear. The rumble filter is measured, not
  approximated: an 80 Hz high-pass is -3 dB at 80 Hz, at any project frame rate.
  (`packages/editor-core`, `packages/ai-sdk`, `engine/python`, ADR 0113)
- **Cut between cameras: "switch to the tight camera here".** Group the cameras that filmed the
  same moment, tell FramePilot how far apart they started rolling, and it cuts at your playhead to
  the same instant from the other lens — not the same timestamp, which is a different moment
  whenever the cameras did not start together. It cuts the shot at the playhead, changes only the
  picture, and leaves your sound exactly where it is, so a camera change never becomes an audible
  jump in room tone. Undo restores the shot exactly. If a camera has no sync offset yet, FramePilot
  says so and names the one it needs instead of guessing — a cut to the wrong moment looks perfectly
  fine in the timeline, which is what makes guessing worse than asking. Sync is something you tell
  it; nothing is inferred from file names or folders. (`packages/timeline-schema`,
  `packages/editor-core`, `packages/ai-sdk`, ADR 0112)
- **Audio tracks can now carry a role — dialogue, music, or sfx.** This is what makes "duck the
  music under the dialogue" mean something specific instead of something guessed. Roles are always
  set by you, never inferred from a track or file name: a lane called "music" often holds a
  voice-over, and quietly mixing the wrong thing is the kind of mistake you only notice on playback.
  Existing projects open unchanged with no roles assigned, and nothing is labelled behind your back.
  (`packages/timeline-schema`, `engine/python`)

- **"Duck the music under the dialogue" now works as said.** Once your tracks carry roles, the
  agent ducks every music clip under the dialogue track without you selecting anything. If no track
  carries the role you named, or two tracks both claim it, it asks you to label the track instead of
  picking one — the wrong bed ducking is silent in the timeline and only audible on playback.
  Selection-based ducking still works unchanged for projects with no roles yet. (`packages/ai-sdk`)

- **The agent can check your mix against a delivery loudness target.** It measures programme
  loudness the way platforms do (EBU R128), per role if your tracks are labelled, and flags a mix
  that is too quiet as well as one that is too loud — either way the mix you approved is not the
  mix the audience hears. (`engine/python`, `packages/ai-sdk`)

- **The agent can now measure one role on its own — just the music, or just the dialogue.** It
  renders that role with everything else muted, so "how loud is the dialogue" answers about the
  dialogue rather than the whole mix. If no track carries the role you asked about, it says so
  instead of reporting silence as if the answer were reassuring. (`engine/python`)

### Fixed

- **Long stretches of audio were being reported as silent.** Checking the loudness or peak of
  anything longer than about a second and a half came back as digital silence — a confident, wrong
  answer with no error to warn you. Any window is now measured correctly. (`engine/python`)

- **External agents can no longer invoke editing tools that need your editor open.** Tools that
  depend on what you have selected, where the playhead is, or what the source monitor is showing
  were hidden from the MCP tool list but could still be called by name. They are now refused
  outright with a clear reason, so an external agent cannot act on interaction state it does not
  have. (`packages/mcp-server`)

### Added

- **The same edit now behaves identically whether it comes from the app or an external agent.** A
  parity fixture pins that the in-app path and the MCP path produce the same operations, the same
  validation result, and the same change to your timeline for a given command — and that an illegal
  edit is refused by both without committing anything. (`packages/mcp-server`)

- **Every professional editing controller is now proved against a real render, not a stub.** Cuts,
  motion, grades, tracking, and mixes each have an objective fixture that renders synthesised media
  through the actual engine and measures the result: a cut lands on the intended frame with sound
  continuous across it, a move ramps smoothly without ever exposing the canvas, a brighter grade
  genuinely brightens the picture while staying broadcast legal, a tracked region never leaves the
  frame or jitters, and a quieter mix is measurably quieter and safe from clipping. If the engine
  ever stopped applying one of these for real, the fixture fails — a correct-looking project file is
  no longer accepted as proof. (`engine/python`)

- **Professional capability promises now have an eval scorecard instead of demo-only coverage.**
  All 33 currently advertised editable timeline, motion, color, manual tracking, and audio
  capabilities require an explicit fixture registration across resolve, compile, validate, apply,
  invert, verify, persistence, and host-parity stages; new capabilities fail drift checks until a
  row is added. Unsupported automatic tracking keeps its real CV-engine reason and is never counted
  green. Every one of those 29 rows now runs as an executable case: it resolves a real referent
  from a live editor snapshot, compiles through the real domain compiler, and proves patch
  legality, exact undo, save/reload, transport stability, and temporal-review planning — then
  asserts the editorial result, so a roll only moves the shared cut, a slip leaves timeline
  placement untouched, a grade lands on one canonical layer without touching unselected shots, and
  a tracked region stays inside the frame. Drift now fails in both directions: a registered
  capability with no runnable case, or a case with no registration. A row only earns its
  verification stage when rendered evidence is actually acquired and reviewed — planning a check is
  no longer treated as having made it. A one-shot Node-to-Python gate now stages isolated synthetic
  media and requires all 33 applied projects to compile, acquire, and pass the production temporal
  reviewer. Property-specific pixel/audio negative controls remain the next semantic-depth gate.
  (`packages/ai-sdk`, `engine/python`)

- **Selected audio now has a professional, resolver-gated mix path.** The agent can level, mute,
  peak-normalize, and add frame-accurate fades to “this,” “these,” or the clip under the playhead
  while preserving omitted settings from the canonical clip mix. It can also duck the primary
  selected bed track under exactly one other selected audio-capable track; ambiguous sidechains
  fail closed instead of guessing dialogue/music roles. TypeScript and Python now reject self-duck
  links and reductions without a sidechain, preserve equal-power/smooth fade curves consistently,
  and request beginning/middle/end mix evidence even for embedded audio on video clips.
  (`packages/editor-core`, `packages/ai-sdk`, `engine/python`)

- **“Track this mask” now has an honest professional command path.** The agent resolves one live
  shot, takes normalized geometry and manual correction keyframes from its existing rectangle or
  ellipse mask, compiles a reversible canonical tracker, and requests bounded inside-frame/jitter
  evidence from the unified temporal reviewer. Canonical masks and trackers replace by ID instead
  of stacking. Automatic face/object/planar/segmentation tracking remains explicitly unavailable
  until a real CV engine is approved; the agent cannot guess a region or claim an automatic track.
  (`packages/editor-core`, `packages/ai-sdk`, `engine/python`)

- **Reference-shot color matching now consumes measured evidence instead of guessed values.** The
  agent measures target and reference shots through the deterministic render path, stores opaque
  revision-bound handles, and derives restrained exposure, contrast, saturation, temperature, and
  tint corrections from complete tonal statistics. Match deltas accumulate onto the already
  measured primary grade instead of replacing it, and the strict conditional tool contract remains
  compatible with providers that reject top-level union schemas. Wrong-source, stale, wrong-clip,
  incomplete, or visually obstructed measurements are rejected before a patch is built.
  (`packages/ai-sdk`, `packages/editor-core`, `engine/python`)

- **Color evidence now measures tonal distribution, not only channel endpoints.** Render-backed
  scope samples add per-channel mean, 10th/50th/90th percentiles, and near-black/near-white pixel
  ratios while remaining compatible with recorded evidence v1 batches. These measurements provide
  the deterministic input needed for honest reference-shot matching and clipping review; matching
  still refuses legacy min/max-only evidence. (`engine/python`, `packages/ai-sdk`)

- **Selected shots now have a deterministic primary color-correction path.** The color controller
  resolves “this,” “these,” or the playhead from live editor state and compiles explicit bounded
  exposure, contrast, saturation, white-balance, shadow, and highlight values into reversible
  commands. Each clip gets one stable primary-correction node, so repeated adjustments merge
  without stacking while separate creative LUT/look layers remain untouched. The tool refuses to
  infer a grade or claim shot matching without measured visual evidence. (`packages/editor-core`,
  `packages/ai-sdk`)

- **The agent can now animate a selected property like an editor, not by inventing keyframe
  arrays.** A professional motion controller resolves the live clip, selected property, playhead,
  easing, and frame duration into a revision-bound `animate_clip_property` command. It can animate
  toward a value or continue the established trajectory, rejects ambiguous property selections and
  out-of-clip windows, and can sample every frame to prevent transforms from revealing the canvas.
  The motion compiler validates property limits and returns an exact undo before the domain tool
  emits any operation. (`packages/editor-core`, `packages/ai-sdk`)

- **Professional timeline intent now has a real controller instead of tool-local choreography.**
  `TimelineEditObjective` resolves live source/sequence state into typed `EditorCommand` batches,
  preserving evidence-linked picture/sound sync by default and requiring an explicit opt-out for
  asymmetric edits. Ambiguous companions fail closed, and camera-angle intent is represented but
  truthfully rejected until multicam angle groups are schema-backed. The existing compiler remains
  the only layer allowed to emit reversible timeline operations. (`packages/ai-sdk`)

- **The AI now receives the editor state behind words like “this” and “here”.** Each turn captures
  the live playhead, selected clips, primary clip, tracks, timeline range, and project/timeline
  revisions in a versioned interaction snapshot. Browser and desktop runs carry the same shape;
  Electron validates and bounds it before use. A new deterministic target resolver refuses stale,
  missing, or ambiguous clip/edit-point/track/range references instead of silently choosing one,
  and mutating callers can require the live host revision to match the captured turn. This is the
  first shipped slice of the professional-editor control plane. (`packages/ai-sdk`,
  `packages/shared-types`, `apps/web-editor`, `apps/desktop`)
- **The AI can now see the professional controls the editor is actually using.** Selected effect
  layers, exact keyframes, and the source monitor's loaded asset, playhead, and in/out marks join the
  same ephemeral turn snapshot as clip selection. Browser state is filtered against the live
  project; Electron bounds the wire shape and independently rejects references that are not in its
  authoritative project. None of this panel state is persisted or added to undo history.
  (`packages/ai-sdk`, `packages/shared-types`, `apps/web-editor`, `apps/desktop`)
- **The timeline engine can now perform a true non-destructive source slip.** A new reversible
  source-range operation changes which source frames play while keeping the clip fixed on the
  timeline, with matching TypeScript/Python behavior and speed-duration validation. It is the
  engine primitive for the forthcoming professional slip command. (`packages/editor-core`,
  `engine/python`)
- **Professional roll, slip, and slide edits now have deterministic command compilers.** They accept
  revision-bound integer-frame intent, validate source handles, locks, adjacency, minimum duration,
  and final patch invariants, then return both the edit patch and its exact undo. Rational source
  and sequence rates prevent 29.97/23.976 drift, and unsupported retimed-boundary cases fail
  explicitly instead of assuming 1x footage. (`packages/editor-core`)
- **Ripple trim, lift, and extract now preserve their professional editing semantics.** Ripple
  extensions move downstream clips out of the way before consuming source handles; contractions
  close removed time. Lift deliberately leaves a gap, while extract closes it, and both support
  exact multi-clip undo. (`packages/editor-core`)
- **Replacing footage no longer requires destroying the edited clip.** A new reversible
  cross-runtime media replacement operation keeps the clip's effects, keyframes, masks, crop,
  speed, identity, and timeline position while validating the replacement asset and duration.
  (`packages/editor-core`, `engine/python`)
- **Insert and overwrite now work as real three-point edits—even inside a shot.** Commands use
  explicit source and sequence frame domains. Insert deterministically splits footage at the edit
  point and shifts everything downstream; overwrite replaces only destination time. Replace
  derives the required source span while retaining the existing clip and its attached edits.
  (`packages/editor-core`)
- **J-cuts and L-cuts now have linked-media-safe compilers.** The command names the four picture
  and sound clips around an aligned cut; FramePilot proves source linkage and track roles, checks
  audio handles, leaves the picture edit fixed, and moves only the sound boundary. J-cut/L-cut
  direction is semantic, so the model never guesses a positive or negative trim sign.
  (`packages/editor-core`)
- **The agent has its first resolver-gated professional editing tool.** One domain-owned
  `professional_edit` surface handles roll, ripple trim, slide, lift, and extract. The model names
  the editorial intent and frame count; FramePilot resolves “this/here/these” from live editor
  state and lets the deterministic command compiler create the operation sequence. Missing, stale,
  or ambiguous context fails before any operation is emitted. (`packages/ai-sdk`)
- **Source-monitor marks now carry an explicit rational editing clock.** Interaction context v2
  transports the monitor timebase with its playhead and marks across the renderer/main boundary.
  FramePilot validates the clock, frame/seconds agreement, and known media duration before a
  source-domain edit can consume it. (`packages/ai-sdk`, `packages/shared-types`, `apps/desktop`,
  `apps/web-editor`)
- **Professional source edits are now agent-operable end to end.** `professional_edit` adds slip,
  insert, overwrite, and replace while deriving the source asset, source clock, in/out marks,
  selected track or clip, and sequence playhead from live editor state. A mismatched slip source,
  missing marks, or missing monitor fails without emitting operations. (`packages/ai-sdk`)
- **J-cuts and L-cuts now resolve linked edit points instead of guessing.** `TargetResolver` pairs
  picture and sound boundaries only when cut time, track roles, and outgoing/incoming source assets
  agree. The agent can now request a semantic J- or L-cut while the compiler keeps picture fixed
  and moves only sound. (`packages/ai-sdk`)
- **Professional editor runs now share a validated lifecycle vocabulary.** Edit, recipe,
  planned-edit, and agent routes declare how they satisfy understand → resolve → inspect → plan →
  compile → execute → verify → review → repair → finalize. A pure reducer rejects out-of-order,
  cross-run, stale-sequence, inactive-stage, and post-finalize events; repair is the only legal
  loop. (`packages/ai-sdk`)
- **Browser, desktop, and auto-routing now enter edits through one `streamEditorRun` adapter.**
  Edit, recipe, planned-edit, and agent execution preserve their existing event streams exactly,
  while route selection, live controls, and initial cost handoff share one host boundary. A matrix
  test locks legacy and unified patch/outcome/terminal events byte-for-byte. (`packages/ai-sdk`,
  `apps/web-editor`, `apps/desktop`)
- **The editor can now describe its real commands and properties without prompt archaeology.** A
  typed capability registry exposes the 11 professional timeline commands plus implemented motion,
  color, and audio properties with target kinds, units, bounds, keyframe support, compiler,
  verifier, inverse path, operation types, and honest availability. Its values derive from runtime
  editor-core contracts, and drift tests fail when a command disappears, a tool becomes unavailable,
  or an advertised mutation loses its executable chain. (`packages/ai-sdk`, `packages/editor-core`)
- **Unified editor runs now expose a durable stage stream without changing the conversation.** The
  edit, recipe, planned-edit, and agent adapters can publish strictly ordered, serialisable lifecycle
  events beside their byte-identical UI events. Stage logs replay through the same reducer; normal
  runs finalize, while failures and cancellations settle the active stage with a reason instead of
  pretending completion. (`packages/ai-sdk`)
- **Desktop editor stages now survive reloads and process recovery.** Electron main appends canonical
  lifecycle records to the same serialized per-run WAL as stream, effect, patch, and terminal events.
  They are validated during tail replay, ordered before the presentation events they describe, and
  fully flushed before terminal settlement without appearing as duplicate sidebar rows.
  (`apps/desktop`, `packages/ai-sdk`)
- **The Critic can now judge how an edit behaves over time, not only whether its patch is valid.** A
  revision-bound evidence protocol covers representative frames, critical ranges, comparisons,
  scopes, transform/tracker/mask motion, and audio windows. Deterministic review catches black or
  isolated flash frames, illegal scopes/bounds, jerky motion, tracking jitter, clipping, and audio
  discontinuities; stale, incomplete, mismatched, or missing evidence cannot pass. Professional
  command facts choose the windows, including the moved sound boundary of J/L cuts.
  (`packages/ai-sdk`)
- **Temporal review now measures the edit FramePilot actually rendered.** The engine accepts a
  bounded, revision-checked batch against the live working project, compiles it once, and returns
  cached frame metrics, scopes, comparison differences, audio measurements, and stored motion/
  tracker/mask trajectories to the deterministic reviewer. A strict cancelling host client rejects
  HTTP, timeout, and malformed-response failures instead of treating them as evidence.
  (`engine/python`, `packages/ai-sdk`)
- **Editing runs no longer report success before FramePilot checks the changed picture and sound.**
  The shared edit/recipe/planner/agent execution boundary derives review windows from the validated
  before/after timeline, asks the engine for real evidence, and gates completion through the Critic.
  Changes remain staged until that review passes, so missing/failed evidence or Stop cannot commit a
  rejected edit. Durable runs retain revision, exact render settings, request, and decision lineage.
  (`packages/ai-sdk`, `apps/desktop`, `engine/python`)
- **FramePilot can repair one concrete picture or sound failure before giving up.** The repair is an
  ordinary typed, validated timeline patch—not a hidden mutation—and both the original and repair
  stay uncommitted until a second engine review passes. The attempt is hard-capped at one; missing
  evidence, no-op repairs, repeated failure, and cancellation release no patch. (`packages/ai-sdk`)
- **Connect FramePilot to any OpenAI-compatible server.** A new provider —
  **Settings → AI → OpenAI-compatible server** — takes a Server URL and talks to whatever
  is listening there: vLLM, LM Studio, llama.cpp, LiteLLM, a corporate gateway, or a local
  proxy. The API key is optional, since most self-hosted servers do not want one. Unlike
  every other provider it has no default address, so it tells you the URL is missing
  instead of quietly calling somebody else's API. (ADR 0108, `packages/ai-sdk`,
  `apps/desktop`, `apps/web-editor`)

### Fixed

- **Running an AI task no longer eats your machine's memory.** Every tool the AI ran wrote a
  copy of your entire project — including its full undo history — into the app's run log, and
  kept it in memory for as long as the app stayed open. On a project with a long editing
  history that was tens of gigabytes within a single request, freezing the app and forcing a
  restart. The run log now records what ran and how it finished, not a copy of the project;
  a captured real-world case went from 13 seconds of a frozen app and 2.3 GB held per run to
  about a millisecond and a few hundred bytes. (`apps/desktop`)
- **Opening the app is fast again, however many AI runs you have made.** Startup used to read
  and re-parse every AI run in your history — on one machine 1.1 GB across 242 runs — and hold
  all of it in memory for the session. It now checks each run's small summary file, loads only
  a run that was genuinely left unfinished, keeps the 50 most recent finished runs, and clears
  out quarantined evidence after two weeks. Older runs are removed automatically the next time
  you launch. (`apps/desktop`)
- **The AI sidebar stops holding a second copy of the conversation.** Streamed events were kept
  for the whole run after they had already been displayed, and a recovery bookmark was written
  to disk on every single event, stuttering the text as it arrived. (`apps/web-editor`)
- **A wrong provider address now says so, immediately and in plain words.** Pointing the
  app at a server that does not serve the expected route used to show the raw HTML error
  page from that server in the chat, and retry the request several times before giving up.
  Provider failures are now read properly: permanent ones (wrong address, bad key) fail at
  once with the actual reason, and only genuinely temporary ones (rate limits, outages) are
  retried. (`packages/ai-sdk`)
- **An API key set for Ollama is used again.** It was being dropped, so an Ollama behind a
  password-protected proxy could not be reached. (`packages/ai-sdk`)

### Changed

- **A consistency pass on the editor's controls.** Precision controls in the Timeline, Inspector,
  and Settings — keyframe handles, resets, switches — now meet a 24px minimum touch/click target
  without getting visually bulkier. Shared `Switch` and `SegmentedControl` controls replace
  Settings' previous one-off implementations, and caption font selection now uses FramePilot's
  own portaled, keyboard-navigable picker instead of the browser's native dropdown. A button in
  a loading state can no longer be re-enabled by passing `disabled={false}`. (`packages/ui`,
  `apps/web-editor`)
- **Big projects and big footage stay responsive.** A batch of performance work took the
  remaining "whole project" costs out of the paths you touch constantly:
  - **Importing large footage no longer loads it into memory.** A multi-gigabyte camera file
    used to be read into the app whole before being copied into your project, which could
    stall or exhaust it. It is now copied in bounded pieces, so import cost no longer scales
    with how big the file is. (`apps/web-editor`, `apps/desktop`)
  - **Editing stays fast as the timeline fills up.** Every edit used to re-check the entire
    timeline; it now checks only the tracks and cuts the edit actually touched, with the same
    strictness. Dragging and trimming on a dense timeline no longer recomputes every snap
    point on each mouse movement. (`packages/editor-core`, `apps/web-editor`)
  - **Assistant edits cost less on large projects.** Routine edits from the assistant now
    travel as just the change rather than a full copy of the project, and a long run is kept
    as one undo step without rebuilding it after every step. (`apps/desktop`, `apps/web-editor`,
    `packages/editor-core`)
  - **Assistant replies arrive more smoothly.** Saving a run's progress no longer waits on the
    disk for every token; it checkpoints at the points that actually matter for recovery.
    (`apps/desktop`)
  - **The preview does less work on high-refresh displays.** A 120 Hz screen no longer redraws
    a 30 fps project four times per frame, and waveforms are never decoded twice for the same
    footage. (`apps/web-editor`)
  - **Picking an AI provider only loads that provider.** (`packages/ai-sdk`)

### Removed

- **GitHub Models and GitHub Copilot are no longer AI providers.** Both needed a bespoke
  token exchange that nothing else in FramePilot requires, and neither earned the upkeep.
  If one of them was your active provider, the app falls back to the offline mock provider
  — which does not call any model — so open Settings and pick a real one. OpenRouter is the
  closest equivalent if you want an OpenAI-compatible endpoint. `GITHUB_MODELS_PAT`,
  `GITHUB_MODELS_MODEL`, `GITHUB_COPILOT_TOKEN` and `GITHUB_COPILOT_MODEL` are no longer
  read and can be deleted from your `.env`. (`packages/ai-sdk`, `apps/desktop`,
  `apps/web-editor`, ADR 0104)

### Fixed

- **The AI now tells you when it cannot do something, instead of quietly doing something
  else.** A handful of requests used to be "repaired" on their way through: ask for a
  transition of an impossible length and you got a one-frame one anyway; add a stray detail
  to a request and that detail was dropped without a word; ask to punch in on a backwards
  time range and you got a different range. In each case the assistant reported success for
  an edit you had not asked for. Those now come back as a clear, specific reason — which the
  assistant can act on and correct, usually without you noticing. Locked tracks are also
  genuinely locked now: the lock is enforced where edits are actually applied, so the
  assistant (and any future integration) cannot edit through it. (`packages/editor-core`,
  `packages/ai-sdk`, `engine/python`, ADR 0107)

- **Preview and export always reflect your current timeline.** A preview or exported file
  could previously be served from an earlier run's result within the same session, so you
  could make fifteen edits and be shown the video from before them. Renders and exports are
  never reused, and the frames the assistant looks at while checking its own work are stamped
  with the version of the timeline they came from. (`packages/ai-sdk`, ADR 0107)

- **Transcribing one clip no longer wipes the transcripts of the others.** Re-transcribing a
  single piece of footage now replaces only that footage's words, and undo restores exactly
  what was there before. (`packages/editor-core`, `packages/ai-sdk`)

- **Marker-only and transcript-only changes no longer show up as "no changes"** in the review
  panel, and the panel no longer fails to open for projects that have no markers yet.
  (`packages/editor-core`)

### Changed

- **The assistant now runs on LangGraph — and nothing about it should look different to you.**
  The loop that decides what the AI does next (plan → approve → run → verify) used to be a
  hand-written engine of ours. It is now a LangGraph state graph, which means the parts we do
  not want to own ourselves — retries, streaming, provider quirks — come from a maintained
  library instead of our own code. Every decision about _what to do_ is still ours and still
  pure. This was held to a hard bar: nine recorded agent sessions replay through the new
  runtime producing the exact same events, in the same order, with the same ids, as the old
  one. If you notice a difference, that is a bug, not the change. (`packages/ai-sdk`,
  ADR 0099/0102/0103)

- **Every AI provider now runs on LangChain, and the old hand-written clients are gone.**
  FramePilot used to carry its own HTTP client for each provider. Measured against real
  footage on DeepSeek, the LangChain path was faster on every latency figure — including a
  94% better worst case — and it is the only one that can report prompt-cache hits, which is
  what tells you how much of each request you are being billed for twice. There is nothing to
  configure: the switch that used to select between them is gone because there is only one
  now. If you set `FRAMEPILOT_AI_PROVIDER_IMPL`, you can delete it. (`packages/ai-sdk`,
  `apps/desktop`, `apps/web-editor`, ADR 0105)

- **The assistant streams its thinking again on DeepSeek and other reasoning models.**
  Reasoning models spend a while thinking before they answer. That thinking was being dropped
  on the way to the screen, so the panel sat blank — for 11 seconds on average, and sometimes
  the entire turn — and then the finished answer appeared at once. It now streams as it
  happens, which also took time-to-first-word from 11.7s back to 1.5s. (`packages/ai-sdk`)

### Added

- **The AI can now SEE your edit.** A new `get_frame` step renders a single frame of your
  timeline through the same engine as the final export and shows it to the model as a
  picture. This is what lets it check the things numbers cannot describe — whether a caption
  is actually readable against the shot behind it, whether a punch-in cropped someone's
  head, whether a title collides with the footage — instead of reporting work as done and
  leaving you to find the problem. Captions are burned into the frame it looks at, and the
  caption playbook now requires checking cues over at least two different backgrounds before
  calling them finished. Available on vision-capable models; on text-only models the step is
  not offered and the assistant keeps saying plainly when an edit is visually unreviewed.
  (`packages/ai-sdk`, `engine/python`, ADR 0096)

### Fixed

- **Big edits stopped bloating your project — and can be undone again.** Undoing an edit that
  removes something needs a record of what was there, and FramePilot was saving that record
  once per affected clip instead of once per track. Generating captions for a song wrote
  **115 MB** of undo data for **0.25 MB** of actual edit, and because a single edit that large
  is too big to keep, it was thrown away on save — so the one edit you were most likely to want
  back was the one you could not undo after reopening. FramePilot now keeps one record per
  track. The same caption pass measures **39 MB → 0.05 MB**; a real project's full history went
  from **174 MB to 0.5 MB**. Projects that had grown past 380 MB now save at about 1 MB, open
  in milliseconds, and their undo survives a restart. Undo behaviour itself is unchanged —
  every edit reverses exactly as before. (`packages/editor-core`, ADR 0106)
- **A project with a very large edit history opens again instead of crashing the app.** Undo
  history is the one part of a project file that can grow without limit, and a caption-heavy
  project had reached 383 MB of it against under 1 MB of actual content. Opening that project
  needed several gigabytes of memory and killed the app outright — at startup, with only a
  macOS "quit unexpectedly" dialog to show for it. FramePilot now recognises a project whose
  history is past what it can safely load, and opens it **without** that history rather than
  taking the app down: every asset, clip, caption, transcript and marker is preserved, and
  only the ability to undo edits from previous sessions is lost. Saving from the MCP server
  also trims stored undo history to the same budget the app and the editor already used —
  that gap is how the history grew this far in the first place. (`packages/timeline-schema`,
  `packages/mcp-server`)
- **Picking DeepSeek (or most other providers) no longer stops the app from starting.** The
  render engine kept its own, much shorter list of AI providers that had never been updated
  as new ones were added — it only knew Anthropic, NVIDIA and mock. Choosing any of the
  others meant the engine quit the moment it launched, which took editing, rendering and
  captions down with it and left the desktop app unable to reach anything. The engine now
  recognises every provider FramePilot offers, and a name it has never heard of is ignored
  with a warning rather than treated as fatal — it does not call models itself, so an
  unfamiliar name is no reason to refuse to start. (`engine/python`)
- **The assistant panel no longer fills memory with chats you never opened.** Opening a
  project used to read every past conversation's full transcript — every tool result, every
  analysis payload — into memory and keep it there for the whole session, which is what made
  long sessions bloat and eventually stall. The history list now loads only what it shows,
  a conversation's transcript is read when you open it, and idle ones are released again.
  Nothing is lost: they are on disk, and reopening one is instant. Searching history still
  searches everything. (`apps/web-editor`)
- **A long agent run stays smooth to the end.** Each step's row was rebuilding a full text
  copy of its result — including the whole raw payload — on every frame of the stream, for
  every row on screen, whether or not anyone ever pressed Copy. That work now happens when
  you press Copy. (`apps/web-editor`)
- **Short clips can take a transition again.** Dropping a dissolve on a cut between two
  short clips — silence-removal output, a stinger, a quick b-roll cut — did nothing and
  reported an error, because the half-second default was longer than the cut could hold and
  the whole edit was refused rather than shortened. A transition longer than the cut can
  carry is now trimmed to fit, so any duration you ask for lands: as long as you asked for,
  or as long as the shots allow. The same applies when you drag a transition's handle past
  the end of the shot, and to transitions the assistant adds. (`packages/editor-core`,
  `packages/ai-sdk`, ADR 0076)
- **Very short clips get captions.** A clip shorter than the word being spoken over it used
  to come out with no caption at all — the word was judged "mostly cut" and dropped, so
  rapid-fire cuts and slivers left off silence removal played silent on screen while the
  audio kept talking. A word is now kept when it is what you hear for most of the shot, even
  if the shot holds only part of the word. Normal cuts are unchanged: a word barely clipped
  at the edge of a long clip is still dropped rather than shown in full.
  (`packages/editor-core`, ADR 0076)
- **Timelines with lots of captions are responsive again.** Hovering, scrolling, zooming and
  dragging on a project with a few hundred caption cues no longer stutters. The timeline was
  re-deriving the whole project's cut structure once per cut on every one of those
  interactions — hundreds of times over — to decide whether a transition could go there,
  including on caption lanes, which can never take one. It is now worked out once, and
  caption lanes are skipped entirely. The hover highlight also no longer forces every clip's
  thumbnails and waveform to be redrawn. (`apps/web-editor`, `packages/editor-core`)
- **AI usage is reported honestly instead of reading as free.** Runs against
  OpenAI-compatible providers (NVIDIA, Groq, OpenRouter, GitHub Models, Ollama, DeepSeek)
  were shown as "Instant · no AI needed · 0 tokens" even after many model calls, because
  those providers only report token usage on a streamed request when asked to. FramePilot
  now asks. If a provider still reports nothing, the run says so — "usage not reported by
  provider" — rather than presenting a missing reading as a measured zero. (`packages/ai-sdk`)
- **Assistant steps now say what they are actually doing.** A run that loaded four different
  playbooks showed four identical "Load skill" rows; three searches in a row read "Search
  media" three times. Steps are now named by their subject — "Reading the short form pacing
  playbook", "Searching media for harbour at dusk", "Styling captions as neon pop", "Looking
  at the frame at 12.40s" — across every step type. (`apps/web-editor`, `packages/ai-sdk`)

- **Long caption tracks and live AI runs no longer make the editor progressively laggier.**
  The caption editor now keeps only the visible cue rows mounted, same-project agent commits
  reconcile into the open workspace without remounting it, and streamed agent output is delivered
  in bounded batches. Partial Markdown is formatted after it settles, preserving every event while
  preventing a growing conversation from consuming the renderer during multi-step edits.
  Caption sliders now preview locally and commit once per gesture, active preview captions use
  the timeline index instead of scanning the complete subtitle lane each frame, and autosave/agent
  commits retain a bounded newest undo suffix on disk so old multi-megabyte history cannot freeze
  the renderer. The full undo stack remains available for the current editing session.

- **Feature-length projects no longer load entire original movies into the preview compositor.**
  Unproxied video now uses Chromium's streaming media path while bounded proxies retain the
  WebCodecs compositor. Preview segment lookup is logarithmic, caption/effect spans are indexed
  near the playhead, and paused timeline/effect loops stop scheduling at display refresh. This
  removes whole-file CPU/memory growth and whole-timeline per-frame scans without changing edits
  or deterministic export behavior.

- **Long AI edits no longer exhaust Electron memory when reading projects with large undo histories.**
  Model-facing project reads and initial AI requests keep the current editable document but clear
  editor-only history, while the authoritative host retains the undo stack. Durable stream appends
  reuse one validated run index instead of rereading and reparsing the growing WAL for every token;
  legacy oversized logs are quarantined before parsing. Expandable tool details remain bounded
  before IPC/replay, and a disposed renderer detaches once while the host-owned run continues.

- **Vite no longer forces full editor reloads for timeline and workspace helper changes.** Pure
  project/pixel helpers now live outside React component modules, keeping Fast Refresh boundaries
  compatible during desktop development.

- **Lyric-video runs can no longer pass verification with one giant caption block.** Caption
  verification now counts only real caption clips (not titles on overlay tracks), fails when
  retained speech has no cues, rejects paragraph-sized transcript fallbacks, and requires cue
  provenance before reporting success. Agent guidance now treats `add_caption_layer` as one short
  phrase, avoids stacking every animation/style treatment by default, and reports lighting,
  colour, caption readability, typography and motion as visually unreviewed when preview rendering
  is unavailable.

### Added

- **AI-backed Auto Emphasis and a 22-family creative font catalog.** Auto Emphasis now calls the
  provider selected in Settings, validates its structured keyword response against the transcript,
  and feeds those anchors into caption generation and segmentation. Missing, failed, or malformed
  providers fall back to the deterministic local scorer with an explicit UI status. Caption styling
  now offers 22 bundled OFL font families across sans, display, serif, mono and handwritten groups;
  the canonical catalog generates matching web `@font-face` and Python render manifests, and
  templates use a broader typographic palette.
  The same capability is registered for the in-app agent and MCP: the AI can discover valid fonts
  and templates, ground semantic anchors in the actual captions/transcript, and set the complete
  track or per-cue composition—including x/y placement, rotation, size, width, alignment, spacing,
  background and safe area—through validated, reversible caption operations.

- **Captions now compose themselves around meaning—and remain fully editable.** Generate once to
  get natural phrase-level segmentation plus automatic emphasis based on context, pauses, delivery,
  sentence structure, confidence and emotional weight. Emphasized anchor words influence where cues
  and lines break, instead of being enlarged after arbitrary word chunks are already fixed. The new
  **Auto emphasis** action can re-analyze an existing set, while manual keywords, inline rewriting,
  merge, split, timing edits and undo stay available. Select a caption in the Program monitor to drag
  it anywhere, resize its wrap width, rotate it, or double-click its text; alignment, line height and
  safe-area behavior are persisted and match final export. Six production templates inspired by the
  supplied creator/editorial references add semantic-anchor, editorial contrast, compact tier,
  kinetic stack, handwritten and social-headline families.

- **Transcription and captions now behave like a professional editing workflow.**
  Local transcription uses a much stronger multilingual Whisper model with
  word-level DTW alignment, preserving real leading silence and provider
  timestamps instead of guessing. TwelveLabs is now a selectable speech-to-text
  provider that reuses the Media intelligence key, indexes the chosen clip, and
  returns native timed words without silently falling back to another engine.
  The Captions panel opens on **All**, uses the same category filters as Effects
  and Transitions, shows 12 always-readable previews before loading 8 at a time,
  and adapts from four columns to narrower layouts. Keyword emphasis now produces
  visibly different preview and export pixels instead of persisting a no-op style.
  Import-triggered transcription shares its live provider, elapsed time, error,
  and completion state with both transcript surfaces, so opening a panel never
  offers a duplicate Transcribe action. Redundant library helper labels and the
  standalone caption preview are removed, and the application header is slimmer.

- **Transitions are a library now, not a list of seven words.** 77 transitions
  across 7 categories — dissolves, slides, zooms, whips and blurs, ten kinds of
  wipe, glitch, light leaks, ink, liquid, kaleidoscope, and a 3D family with flips,
  cubes, doors, folds and a page turn. There is a **Transitions** tab in the left
  rail with search that understands directions ("left"), feels ("fast",
  "cinematic") and use cases ("social media"), and every tile animates on hover by
  running the transition's *real* renderer — so what you see before you apply it is
  what the export produces. Drag one onto any cut, or click between two clips for
  the same library in a popover anchored to that cut. (`apps/web-editor`,
  `engine/python`, `packages/timeline-schema`.)

- **Transitions can sit before, across or after the cut.** "Centre on cut" — what
  most editors expect — now exists, alongside "end at cut" and the original "start
  at cut", picked from a diagram rather than a dropdown of words. Projects you
  already have are untouched: they were all start-aligned, and they still are.

- **Sound across the cut.** A transition can pair a crossfade, a fade-out-fade-in,
  or an **equal-power** fade with the picture. Equal power is the one that matters
  for music: two clips crossfading on ordinary linear gain sum to an audible dip in
  the middle, and this holds the level steady through the join.

- **The transition inspector only shows controls that do something.** A mosaic has
  a block size; a glitch has intensity, block count, colour split and a variation
  seed; a wipe has an edge softness and no intensity, because a wipe either reveals
  or it does not. Nothing on screen is a knob the export ignores.

- **Suggestions for the cut you are looking at**, each with its reason — "these are
  two halves of one shot", "both shots are short, a fast hit keeps the pace",
  "matches the transition on the cut next to this one". Every suggestion is derived
  from your timeline, so the shelf is always there rather than waiting on an
  analysis you did not run.

- **Favourites, recents, most-used and your own presets.** Tune a transition, save
  it, and it sits in the panel beside the built-in ones. They follow you across
  projects rather than living in the project file.

- **Compare with and without.** Hold a transition off without removing it — every
  tuned value survives, one undo either way — and the timeline draws it dimmed so
  you can see why the cut looks hard.

- **Bulk apply, with the count attached.** Apply a transition to the cuts you have
  selected, to every similar cut on the lane, or to every cut in the project — each
  as one undo step, and each labelled with how many cuts it will touch before you
  commit to it.

- **Right-click a track header for track actions.** There was no way to *delete* a
  track at all — the header buttons only toggle hide/mute/lock, dragging only
  reorders, and Add track always dropped the new lane at the top of the stack. The
  new menu has **Delete track** (it tells you how many items go with it, and one
  undo brings them all back), plus **Add track above** / **Add track below**, which
  put a lane of the same kind exactly where you want it. (`apps/web-editor`.)

- **Add track now offers every kind of track.** The menu had only Video and Audio,
  even though the timeline has always understood text/overlay, caption and effect
  lanes — an adjustment lane to drop effects onto could not be created at all. All
  five are there now, each with the icon its header will carry. (`apps/web-editor`.)

- **Speed can ramp, freeze and reverse.** A clip's speed is no longer one number for
  its whole length: it can follow a **curve**, easing from normal into slow motion
  and back the way a hero shot or a montage needs. Set a clip to **0×** to hold a
  single frame, or to a **negative** speed to play it backwards. Trimming, splitting
  and deleting through a sped-up or ramped clip now works properly — before this, an
  ordinary trim of a 2× clip was refused, and splitting a ramped clip would have cut
  at the wrong frame. Projects you already have are untouched: a clip with no curve
  behaves exactly as it did.

  In the inspector's **Speed** section you get presets, a rate field, a **Reverse**
  toggle and a **Freeze frame** button — and the clip's new length is shown *before*
  you apply it, so you never have to undo a speed change just to find out what it
  did. You can also drive it the other way: type the duration you want and the speed
  follows.

  *Two things to know.* Audio on a ramped clip changes pitch as the speed changes —
  the same limitation constant-speed clips already had — and a frozen frame renders
  silent, because a held audio sample is not sound. The visual curve editor lands
  next. (`packages/timeline-schema`, `packages/editor-core`, `engine/python`,
  `apps/web-editor`)

- **Transitions you can shape.** Every transition now has controls for how it
  behaves, and only the ones that apply show up: **direction** (push, slide and wipe
  can go any of four ways; zoom can go in or out), **intensity** (how far it travels —
  a half-strength dissolve never fully loses the picture), **softness** (how feathered
  a wipe's edge is) and **easing** (linear, ease in, ease out, ease in-out, or a
  smooth curve). **Preview transition** plays the real cut on your real footage,
  starting just before it and running just past, so you can judge the join rather
  than guess. **Apply to selected** copies a transition you have tuned — kind, length
  and all — onto every other selected cut in one undoable step. **Reset look** puts
  everything back. Transitions you already have are untouched: every setting defaults
  to exactly what the app was already doing, so nothing changes look until you change
  it. Changing a transition's type or length no longer discards the settings you
  tuned. (`apps/web-editor`, `engine/python`)

- **Transitions you can see and grab on the timeline.** A transition is now a block
  on the cut that tells you what it is — its name and length when there is room, an
  icon when there is not — instead of an anonymous arrow. Drag either edge and the
  new length is shown while you drag, not after. Zoom out and blocks stay big enough
  to click; two transitions close together can no longer overlap, so you always grab
  the one you aimed at. Right-click a block for **Replace**, quick lengths (Fast /
  Standard / Slow) and **Remove**; lengths the cut is too short to hold are simply not
  offered. The `+` on a cut that cannot take a transition now tells you *why* rather
  than quietly disappearing. And in the transition picker, hovering a kind reveals
  **All** — apply that transition to every eligible cut in the project in one step
  (cuts that already have a transition are left alone), undoable with a single press.
  (`apps/web-editor`)

- **Custom motion curves.** Pick how a keyframe eases into the next one from a menu —
  linear, ease in, ease out, ease in-out, hold — or choose **Bezier** and click *Edit
  curve* to shape it by hand. Drag the two control points (or nudge them with the arrow
  keys) to get a slow start with a hard landing, a move that overshoots and settles, or
  a small wind-up before a push. The graph draws the real curve the export will use, and
  it grows to show overshoot rather than cutting it off at the top. *Reset curve* puts
  it back to the default. Curves you already had are untouched — anything set to Bezier
  before this keeps behaving exactly as it did.

- **Keyframes you can actually grab, on the timeline.** An animated clip now has a
  small diamond button in its corner that opens a **lane for each animated property**
  underneath it — scale on one row, position on another — instead of the single
  anonymous dot that used to mark "something happens here". Each keyframe is a real
  marker you can click to select, shift-click to add to a selection, drag to retime,
  and delete with the Delete key. Hovering one tells you the property, its value, its
  time and its easing. Double-clicking an empty spot in a lane drops a keyframe there,
  holding whatever value the animation already had at that moment — so adding one never
  moves your picture.

  Dragging keyframes snaps to the clip's edges, the playhead, your markers, and
  keyframes in the *other* lanes, so lining a move up with a zoom is easy; hold Alt to
  ignore that. Drag a group and it keeps its spacing, stopping at the clip's edge
  instead of bunching up. Every drag and every delete is one undo press. And dragging a
  keyframe never drags the clip out from under it.

- **Animate a property from the property itself.** The inspector's Transform panel now
  has real fields for **scale, X, Y, rotation and opacity** — until now there were
  none, and the only way to move or resize a clip was to drag it on the picture. Next
  to each one is a **diamond**: click it to drop a keyframe at the playhead, click it
  again to take that keyframe away, and use the arrows either side to jump between the
  keyframes you have already set. The diamond fills in when there is a keyframe where
  you are standing and rings when the property is animated somewhere else, so you can
  see what is moving at a glance. The old "pick a property, type a value, press Add
  keyframe" form is gone.

  Nudging a value does what you would expect from either kind of property: on a still
  clip it just changes the value, and on a clip you have already animated it sets a
  keyframe where the playhead is — and the row tells you it is about to, before you
  commit. Resetting a property clears its animation too, in one undo step.

- **A real scrub bar in the preview, with your cuts marked on it.** It spans the
  full width of the picture, and clicking lands exactly where you clicked instead of
  snapping to the nearest step. Small ticks show where every cut and clip edge sits,
  so you can scrub against the shape of your edit rather than a blank bar; dragging
  snaps onto those points, and holding Alt ignores them. Hold Shift while dragging
  for a fine scrub — the playhead slows to a fifth of your hand's movement, and it
  picks up from where it already was rather than jumping. Arrow keys step a frame,
  Shift+arrows a second, Home and End jump to the ends.

- **The transport now has the controls that were missing.** Jump to previous or next
  **edit point** (`⇧↑` / `⇧↓`) — it stops at every cut and clip edge, including both
  sides of a gap. **Loop** moved here from the view controls, next to play where it
  belongs. And a **monitor volume and mute**, which turns down everything you hear —
  footage and music together — without touching your project's audio levels or what
  gets exported. Your level is remembered separately from mute, so un-muting brings
  back the volume you had.

### Fixed

- **The AI can no longer report an empty media bin for a project full of media.** When a
  model filled an optional filter with an empty string — `list_assets {"kind":"video",
  "folderId":""}` — the tool read `""` as a real folder filter, matched nothing, and
  answered "no assets". The agent then asked the user to import footage that was already
  imported and sitting in the bin. Blank optional selectors (ids, queries, categories) are
  now read as "not provided" across every AI tool, in both the TypeScript and Python tool
  registries, and padded values are trimmed. Invalid input is still rejected as before.
  `list_assets` also now says explicitly when a *filter* matched nothing in a non-empty
  bin, so a narrow search can never be mistaken for an empty project, and
  `discover_caption_styles` treats a blank query as "browse everything" instead of failing
  the call. (`packages/ai-sdk`, `engine/python`.)

- **Program-monitor selection now matches the timeline.** Selecting a text object on
  the timeline immediately shows its editable bounds over the WebCodecs preview instead
  of leaving the object visually unselected. Preview clicks now use deliberate isolation:
  single-click selects the background picture, double-click selects the topmost text
  object under the pointer, and keyboard activation selects the object directly. Picture
  and text selection chrome now uses compact white borders and handles with a dark contrast
  edge, replacing the oversized blue treatment. (`apps/web-editor`, `tests/e2e`.)

- **TwelveLabs can now transcribe audio-only files such as MP3.** FramePilot no
  longer sends every selected asset through TwelveLabs' legacy video-only task
  upload, which reported valid audio as `video_file_broken`. It now uploads the
  file as a typed media asset, attaches it to the index, and polls both stages
  through the existing durable progress job. Timed words are read from the
  indexed asset, existing legacy jobs remain resumable, and **Try again** starts
  a fresh upload after a terminal indexing failure.

- **You can read what FramePilot was thinking again.** Every step of a run showed a
  "Thought for 6s" line with nothing behind it and nothing to expand. The rows were
  real; the thinking was never asked for. Reasoning has to be requested on the wire,
  and the request was going out without that ask, so the model reasoned privately and
  returned none of it. Runs now ask for thinking on the steps that display it, read
  the several spellings different providers stream it under, and a model that cannot
  think is retried without the request instead of failing. A step that genuinely had
  nothing to show no longer leaves a row you can click forever. (`packages/ai-sdk`,
  `apps/web-editor`.)

- **"Thinking…" no longer gets stuck in the middle of a thread.** After FramePilot
  applied an edit mid-run, a thinking row from an earlier step would keep shimmering
  for the rest of the session — two or three of them stacked up in one conversation.
  Applying an edit reloads the project, and the conversation was being rebuilt from
  its last save at that moment, so the last few seconds of the transcript — including
  the event that ends a thinking row, and that step's tool cards — were dropped. The
  transcript now survives that reload intact, and the thread is guaranteed to have at
  most one live thinking row whatever else goes wrong. (`apps/web-editor`,
  `packages/ai-sdk`.)

- **A second thought no longer erases the first.** When FramePilot thought, looked
  something up, and then thought again, the second block of thinking replaced the first
  one — in the first one's place, above the tool cards it actually came after — so the
  reasoning you wanted to read was simply gone. Each block of thinking is now its own
  row, in the order it happened, and you can open any of them. (`packages/ai-sdk`,
  `apps/web-editor`.)

- **The "Generating…" indicator is one thing moving, not three.** It stacked a pulsing
  dot, the label, and a bouncing ellipsis that repeated the "…" already in the label.
  It is now the FramePilot mark itself, breathing beside the status. (`apps/web-editor`.)

- **The on-cut transition popover shows its previews again.** Clicking between two
  clips opened the compact library with every tile collapsed to a dot beside a name,
  and the shelf chips stacked instead of scrolling — the popover borrows the context
  menu's surface, and the menu's "every button is a full-width row" styling was
  flattening the tiles. It now looks and animates like the Transitions tab it is a
  compact copy of. (`apps/web-editor`.)

- **Right-clicking a transition opens a proper menu.** It was asking for a class no
  stylesheet defines, so it drew as loose buttons wrapping over the timeline with no
  panel behind them. It is now a popover: a header showing which transition you
  clicked — running, not just named — then duration and placement as segmented rows
  rather than seven near-identical lines, then the actions. The effect-layer menu had
  the same broken class and is fixed with it. (`apps/web-editor`.)

- **Timeline lanes close up their own gaps again.** Collapsing a lane, reordering
  your tracks, or opening a clip's keyframe lanes changed how tall a row *should*
  be, but the timeline kept drawing every row at the height it started with — so a
  collapsed lane left a band of dead space behind it, and a reordered stack could
  end up with lanes drawn on top of each other. Rows now re-flow the moment a height
  changes, and each track's header sits exactly level with its lane instead of three
  pixels above it. (`apps/web-editor`.)

- **Drag-selecting on the timeline picks the lanes you actually dragged over.** Once
  a project had an effect lane — or a collapsed lane, or a clip with its keyframe
  lanes open — the rubber-band box was measured against an average lane height
  instead of the real ones. A box drawn over the audio lane quietly grabbed the
  video clips above it, and with a few of those lanes stacked up the box stopped
  catching anything at all. Bands are now hit-tested against where the lanes really
  are, at every zoom and lane size. Dragging across an effect lane also selects the
  effects on it, which it never did before. (`apps/web-editor`.)

- **Select all, then Delete, now clears the timeline — clips included.** ⌘A/Ctrl+A
  selects every clip *and* every effect, but Delete only ever removed the effects and
  left every clip sitting there. Both go now, in a single step that one undo brings
  back. Clicking a single clip (or a single effect) still means just that one thing,
  so Delete never takes something you did not have selected.
  (`apps/web-editor`.)

- **Rotated and faded clips now look right in the preview.** If you animated a
  clip's rotation or opacity, the exported video had it but the preview did not —
  the picture sat there flat and fully opaque, so there was no way to judge the
  effect without exporting. Both now show in the monitor, turning the same
  direction and fading by the same amount as the finished render.
  (`apps/web-editor`, revamp Phase 3.)

- **You can pose a clip directly on the picture again.** Click the preview to select
  the clip you can see, then drag it to reposition, pull a corner to resize, or use
  the new round handle above the box to **rotate** it — with the angle shown live as
  you turn. Dragging snaps to the frame's centre, edges and rule-of-thirds lines, and
  a guide line appears to show which alignment it found; hold Alt to ignore them.
  Hold Shift to keep a move on one axis or to rotate in 15° steps, and use Reset to
  put position, scale and rotation back to normal. These controls existed in an
  earlier version of the preview and had been missing since the monitor was rebuilt.

- **The inspector now shows only what the selected clip can actually accept**, and it
  remembers how you like it. Sections you collapse stay collapsed — including when you
  click a different clip, which previously sprang them all open again. Audio only
  appears for clips on tracks that carry sound, Text only for text clips, and
  Transition only when you have a single clip selected. New buttons at the top of the
  panel **copy** a clip's whole look and sound, **paste** it onto another clip,
  **apply** it across everything you have selected, or **reset** it all — each as a
  single step you can undo in one press. Selecting several clips at once now shows an
  em-dash for anything that differs between them instead of quietly showing you the
  first clip's value. Every property and every section also gained its own small reset
  button, which appears when you hover the row.

### Changed

- **The picture is now the biggest thing in the monitor.** The chrome wrapped around
  the preview canvas was costing about 121 pixels of height before the footage got a
  single one — on a shorter window with the timeline open, the picture was getting
  less than half of its own column. There is now one slim 28-pixel band above the
  picture (Source/Program tabs and view controls) and one below it (the transport),
  and the canvas keeps everything else. Portrait and square projects benefit the
  most. Applies to all three monitors, so nothing looks out of step.
  (`apps/web-editor`, revamp Phase 1.)

- **WebCodecs is now the sole program-monitor engine.** The canvas compositor owns
  the complete monitor shell and action controls:
  orientation, compare, loop, grid, safe area, fit/zoom, fullscreen, frame stepping,
  seeking, and timecode remain available throughout editing. Its frame contains
  against both monitor dimensions at the exact project aspect, including live portrait ↔
  landscape changes, and effect layers are pixel-verified on the product path. The obsolete
  Settings toggle and legacy selection/fallback branch are removed. Decoder errors now stay
  visible in the monitor while failed sources retain their timeline duration as gaps, and the
  scrubber occupies a full-width row above the centered transport controls instead of being
  squeezed into the right column. (`apps/web-editor`, ADR 0052.)

- **The context meter now knows ~275 models instead of two dozen.** Model capacities are
  generated from the vendored models.dev catalog
  (`packages/ai-sdk/model-capabilities/models.json` → `model-catalog.generated.ts`) rather
  than hand-maintained, so picking a newly released model shows its real window instead of
  the provider's assumed floor. Ids are matched on the model name alone — the `vendor/`
  prefix and any `:tag` suffix are dropped — so `zhipuai/glm-5v-turbo`, `glm-5v-turbo`, and
  `glm-5v-turbo:free` resolve to one entry whichever provider serves it. Refresh the
  catalog and run `pnpm --filter @framepilot/ai-sdk generate:model-capabilities`; a test
  fails if the committed module is stale. (`packages/ai-sdk`.)

- **Live AI activity now sits with the composer instead of occupying the sidebar header.**
  Thinking, tool, editing, and verification phases use a compact animated activity line
  beside the controls that can stop or steer the run. Each historical thought remains
  independently settled as **Thought for Ns** when a later step starts thinking.
  (`apps/web-editor`.)

- **The active AI plan is now a compact header accordion.** The latest plan remains docked
  above the activity stream during long runs and resets collapsed for each new run. Its
  collapsed preview shows the current or most recently settled scheduler task and progress
  count; expanding reveals concurrent work and the full settled ledger. A separate plan
  ledger is shown only when scheduler tasks are absent, avoiding duplicate checklists. The
  controls preserve keyboard, focus, and screen-reader behavior.

- **The AI activity stream was redesigned around a single run thread.** What the
  assistant is doing now reads as one continuous sequence — every step (thinking,
  each tool, the plan, timeline actions, progress) hangs off one spine with a status
  marker, rather than a stack of separate rows. Each row leads with one icon instead of
  three, and its details/copy actions stay out of the way until you hover or tab to it,
  so a fifty-step run scans as a quiet list. Only steps that need attention get a
  symbol: a finished step is a small dot, a warning or failure keeps its glyph, so the
  one thing that went wrong is findable. Runtimes use fixed-width digits and no longer
  shift as they tick. Proposed edits are now the only thing on screen with real weight —
  a coloured edge showing whether they are open, applied, refused or broken, one filled
  Accept button, and **A / R / P** shortcuts for accept, reject and preview while the
  card has focus (shown on the buttons). Error notices lost their full red wash for a
  quiet red edge, and a change's clips, tracks and files are now told apart at a glance.
  (`apps/web-editor`.)

### Added

- **Effects are now their own timeline layers, with 72 of them.** An effect no longer
  belongs to a single clip: you place it over a stretch of the edit and it restyles
  everything visible beneath it for exactly that long — across cuts, over several clips,
  or over just part of one. Drag its edges to change how long it runs, move it to
  re-time it, stack two for a combined look, switch one off to compare, or delete it.
  Every change is one undo.

  The catalog covers all twenty families: blur and focus, glow and bloom, light leaks and
  lens flares, film and cinematic looks, retro and vintage, VHS and analog, glitch and
  digital corruption, shake and impact, zoom and directional moves, chromatic separation,
  dreamy and soft, distortion and warp, pixel and halftone, grain and physical wear,
  party and neon, comic and stylised, edge and outline, fisheye, flash and strobe, and
  mirror and split. Every effect has an intensity dial, so "less of that" always works,
  and the ones with their own controls expose them when you select the layer.

  The AI assistant can do all of it too — find an effect by what you describe ("make it
  look like old tape", "censor that"), place it, retime it, retune it, stack it, switch it
  off, or remove it — and it drives the exact same machinery you do, so an AI edit and a
  hand edit land in the same place.

  Browsing is built for finding things: a category rail for all twenty families, plus
  Recommended, Popular, Favourites and Recently used. Search understands what you'd
  actually type — "vhs", "teal orange", "8mm", "censor" — not just our names for things.
  Every effect has its own thumbnail, and hovering one plays the real effect so you can
  see what you're about to get before you commit to it.

  (`packages/timeline-schema`, `packages/editor-core`, `packages/ai-sdk`,
  `apps/web-editor`, `engine/python`. Project files move to schema v13; older projects
  open unchanged. See `docs/adr/0088-effect-layers-schema-v13.md`.)

- **⌘A / Ctrl+A now selects every clip on the timeline.** Pressing it while the timeline
  has focus selects all clips in one go — so Delete, Duplicate, or an AI edit can act on
  the whole sequence — instead of the browser highlighting the page's text. Outside the
  timeline (the AI panel, the inspector, any text field) it still selects text as usual.
  (`apps/web-editor`.)

- **The AI composer shows how full the current request is.** One quiet figure sits
  immediately left of Send/Stop — `17K/1M`, what this request occupies over the model's
  window — and hovering or tabbing to it explains the rest: how much room is left, how
  much is held back for the reply, and when older conversation was last compressed (only
  if it ever was). The capacity is the selected model's real window, so switching model in
  Settings changes it. The figure starts from the assembled-request estimate (tool schemas
  included), is labelled an estimate until the provider reports a real count, and stays
  separate from cumulative run-cost telemetry. It dims while a request is in flight and
  never animates when the assistant is idle. Crucially, the tooltip says in plain words the
  thing that was worrying people: **a number that moves is not lost memory.** FramePilot
  pulls in different project information from one request to the next and compresses older
  conversation as a chat grows; your project memory and the decisions the assistant has
  committed to stay saved through all of it. (`packages/ai-sdk`, `apps/web-editor`,
  ADR 0078, ADR 0080.)

### Fixed

- **Preview playback no longer flashes black or makes the timeline playhead jump on mixed
  stock footage.** The WebCodecs clock now advances continuously through video-only clips,
  stills, and gaps while scheduling audible clips at their real timeline positions. The
  monitor, keyboard shortcuts, timeline, and separate music bus share one transport state;
  wrong-segment decoded frames are never painted, the canvas owner is isolated from per-frame
  React renders, repeated 24/30/60 fps source frames are reused instead of repainted at the
  display's 120 Hz refresh rate, and the canvas stays GPU-backed. The playhead moves outside
  React and snaps its 1px line to physical pixels instead of shimmering between them. Real-Chrome coverage now
  samples actual canvas pixels and monotonic time across audible/video-only B-frame footage,
  images, gaps, music, rapid cuts, and scrubbing. (`apps/web-editor`, ADR 0052.)

- **Agent runs now continue unfinished plans and cannot pass a failed acceptance check.**
  If the model stops calling tools while a committed deliverable is pending, FramePilot
  gives it one bounded mutation-only continuation focused on that step. Final success now
  requires a reconciled plan, traceable applied work, and passing deterministic checks;
  explicit requests such as a “30-second video” are verified against that duration instead
  of allowing a valid six-second fragment to report “all checks passed.” Partial safe edits
  stay reviewable, but the run ends honestly when the objective remains incomplete.
  (`packages/ai-sdk`, ADR 0087.)

- **AI chat and context stay stable while editing elsewhere.** Switching between AI,
  Inspector, and Transcript keeps the same sidebar instance, active run, conversation, and
  draft alive. The context figure is now owned by the primary request for the latest user
  message, so internal classification, planning, tool, and repair prompts no longer make it
  fluctuate. `glm-5v-turbo` now resolves the verified models.dev limits through qualified
  or slash-free ids: 200K context and 131,072 output tokens. (`packages/ai-sdk`,
  `apps/web-editor`, ADR 0087.)

- **A provider outage no longer arrives as "Done — no further edits."** When an AI provider
  drops a request *after* it has started responding — an overloaded or rate-limited gateway,
  a truncated stream — it reports that inside the response body. FramePilot skipped those
  frames, saw a reply with no words and no edits in it, and read that silence as the model
  saying it had nothing to add: the run closed with "Done — no further edits.", a
  "Instant · no AI needed" tag, and a timeline nothing had touched. Such a reply is now
  recognised for what it is and retried automatically; a request that still can't be
  answered says so, with a Retry button and the real reason. Edits from earlier steps of the
  same run are kept, not discarded. (`packages/ai-sdk`, `apps/web-editor`.)

- **A run that ends without changing anything now always says why.** A run whose work could
  not be verified used to settle as failed while showing nothing but a Retry button, so the
  only account of it was whatever the assistant happened to say before it stopped. The
  outcome is now stated in the conversation: nothing was applied, the timeline is unchanged,
  and what to try next. (`packages/ai-sdk`.)

- **An interrupted run whose checkpoint no longer matches the project stops honestly
  instead of quietly starting over.** If the project changed enough that a resumed run's
  saved edits can no longer be replayed, the run now pauses for reconciliation and keeps
  the interrupted run's applied edits for review — it no longer restarts from scratch
  against a project state the interrupted run never saw. The warning shown for this case
  now says "pausing for reconciliation" instead of the old, no-longer-accurate "starting
  over." (`packages/ai-sdk`, ADR 0081.)

- **A legacy (pre-v2) checkpoint operation missing its revision no longer fails to
  migrate.** `migrateWorkingState` computed a safe fallback revision for an old
  operation record that never carried one, but never wrote it back onto the migrated
  record — so that operation silently failed schema validation and the whole checkpoint
  was dropped as unparseable instead of being recovered. (`packages/ai-sdk`.)

- **A run that paused before any edit was attempted no longer shows two contradictory
  notices.** An empty drafted plan, a stale resume checkpoint, or another pre-turn
  integrity pause used to show its own specific explanation and then, immediately after,
  a generic "this run reviewed the footage but never made a change" notice — which was
  also factually wrong in this case, since no turn had run yet. Only the specific,
  accurate explanation is shown now. (`packages/ai-sdk`.)

- **Beat-synced montages now cut on every drum hit and still fill the music.** Asking for a
  tight, beat-driven recut previously ran into three separate walls: a montage that reached
  the end of the song was rejected as "off-grid", the music bed's own placement could never
  satisfy the beat rule, and a long recut came back as "model response was not valid JSON"
  because the reply was truncated mid-way. FramePilot now holds only the cuts you actually
  perceive — interior picture cuts — to the detected onsets, and lets the opening and the
  final frame sit where the edit needs them. A cut landing a couple of frames off a real hit
  is snapped onto it instead of throwing the whole proposal away, and a cut with no hit
  nearby is refused with the exact onset time to use. Splits and trims are held to the same
  standard as newly placed clips, so reusing one clip several times at different in-points
  stays in time. Cutting to music placed in the same step is now checked rather than silently
  accepted — the cause of montages whose clips were spaced uniformly instead of on the beat.
  Long proposals get the room they need, so a 30-second cut-per-hit edit no longer truncates.
  (`packages/ai-sdk`, ADR 0086.)

- **Multi-stage planned edits now keep their assembled cut through final polish and
  verification.** Later transition, grade, and keyframe steps receive the clip ids created
  by earlier validated assembly instead of the original empty timeline. Compilation adds a
  final combined assembly and verification when a model-authored plan omits them, and each
  verification resolves the correct ancestor edit. Schema-valid JSON wrapped in short
  provider prose can be recovered without accepting arbitrary text. If a post-assembly
  refinement after a verified checkpoint still exhausts its bounded attempts, FramePilot
  preserves and re-verifies the earlier valid edit, marks the skipped refinement as a visible
  warning, and reports why; mutations without a verified checkpoint still fail closed.
  (`packages/ai-sdk`, `apps/web-editor`, ADR 0085.)

- **Planned montage proposals now distinguish media assets from timeline tracks before
  assembly.** EditProposer receives exhaustive, separately named asset and track identity
  catalogs, and the driver validates the complete operation batch against the working
  project before accepting the task. Missing references, overlaps, ranges, and other
  project-semantic failures receive actionable bounded correction feedback; invalid batches
  cannot reach dependent assembly or verification. Assembly retains independent validation
  and now reports its actual issue instead of an “Assembled patch” success-shaped summary.
  The correction ceiling is three total attempts so an empty response followed by a
  distinct invalid-reference response can still recover without an unbounded loop.
  (`packages/ai-sdk`, ADR 0084.)

- **A planned mutation can no longer complete successfully after proposing zero edits.**
  Empty `propose_edit` output now receives bounded, feedback-guided correction attempts;
  an exhausted empty response fails the exact mutation task and prevents dependent patch
  assembly or verification from running. Desktop durable terminal state therefore records
  failure instead of `completed_no_changes` for an unbuilt montage. (`packages/ai-sdk`,
  `apps/desktop`, ADR 0083.)

- **Planned edits no longer fail at patch assembly when the Planner omits a duplicate
  upstream reference.** The validated task DAG now owns both scheduling and pure-leaf data
  bindings: compilation derives missing bindings from declared dependencies and rejects
  conflicting references before execution. Patch assembly also supports ordered fan-in
  from multiple operation-producing dependencies. The reported montage shape now runs
  through proposal, assembly, validation, and verification with no explicit `from` field.
  (`packages/ai-sdk`, ADR 0082.)

- **AI edits now stop safely if the run forgets what it committed to.** FramePilot used
  to show “could not confirm what this run committed to” and then continue applying and
  verifying edits anyway. Objectives and plans are now persisted before mutation, every
  operation is linked to its plan and decision with retry protection, and completion is
  allowed only after the committed deliverables reconcile with verification evidence.
  Missing, stale, mismatched, or unrecoverable run state blocks later tool calls, preserves
  existing edits for review, and ends honestly as failed instead of claiming all checks
  passed. The causal ledger now survives durable replay and Resume, and a development
  inspector exposes its stage, version, plan, decisions, operations, verification, and
  blocking diagnostics. (`packages/ai-sdk`, `apps/desktop`, `apps/web-editor`, ADR 0081.)

- **Reading the project and browsing the media bin no longer flood the assistant with
  waveform numbers.** Both reads returned each asset's engine-derived render data — the
  proxy path, the thumbnail paths, and `peaks`, one number per waveform bucket, so a
  single minute-long clip is hundreds of them and a real bin is tens of thousands. None of
  it is anything the assistant can reason with (it never draws a waveform or opens a
  proxy — the timeline and player read those straight from the project), but it filled the
  space where the asset ids should have been, both in what the assistant kept from the read
  and in the result popup you can open on the step. Those reads now return just what
  identifies a clip: id, file, kind, duration, and folder. (`packages/ai-sdk`,
  `engine/python`.)

- **One failed step no longer throws away the whole edit.** When a step in a planned edit
  failed — a footage read that errored, an analysis the media could not support — the run
  reported "The planned edit could not complete" and abandoned everything else it had been
  asked to do, including the grade and the pacing, which never depended on that step.
  Analysis steps are evidence-gathering: if one cannot answer, the rest of the plan now
  continues with less evidence rather than none of the work, and the failed step is still
  shown for what it was. Steps that change something (a render, an export) keep the strict
  rule — anything built on a change that never happened still stops. (`packages/ai-sdk`.)

- **Plan steps no longer go out missing the detail they need to run.** Steps like "survey
  the on-screen content" or "walk this footage" were being planned without the search text
  or the clip they were about, then failing — because when FramePilot draws up a plan it
  was shown only each tool's name and what it does, never what that tool needs to be given.
  It now sees the required and optional inputs for every tool and is told to fill them from
  the request and the project. A step that still arrives incomplete is caught before it is
  sent anywhere, reported in one line ("search_visual needs query"), and the rest of the
  plan continues. (`packages/ai-sdk`.)

- **A failed edit now says which step stopped it and why.** Every failure read "The planned
  edit could not complete" — the same sentence for a rejected proposal, a missing detail
  and an engine that was not running — and the reason FramePilot already had was thrown
  away. It now names the step and the reason: *The planned edit stopped at "Compose the
  montage": …*. (`packages/ai-sdk`.)

- **A rejected engine request no longer echoes your whole project back into the chat.**
  When the media engine refused a malformed request it quoted the entire request body in
  its error, and that body contains the project document — every asset's waveform data,
  thousands of numbers per clip. All of it landed in the step's result, in what the
  assistant remembers, and on screen. Engine errors are now reduced to the sentence that
  matters and hard-capped, the waveform/proxy/thumbnail data no longer goes to the engine
  at all (it re-derives everything from the file itself), and a long step result is folded
  behind a single line — "Output · 1,284 lines · 48 KB" — that opens when you want it and
  stays capped when open, with Copy giving the untruncated text.
  (`packages/ai-sdk`, `apps/web-editor`.)

- **Silent footage no longer ends the whole edit.** Ask for a beat-synced cut over stock
  or drone clips — most carry no audio track — and the run stopped dead at "The planned
  edit could not complete", throwing away the grade, the pacing and everything else that
  had nothing to do with the music. Two things were wrong. Beat detection on a clip with
  no sound reported a wall of raw ffmpeg output (the file's stream dump followed by
  "Output file does not contain any stream"), which told neither you nor the assistant
  anything useful, so it would try the same clip again. And "this clip has no beats" was
  treated as a broken tool rather than an answer, which is what killed the run. Now: the
  step reports "*clip.mp4* has no audio track, so there are no beats to detect. Run beat
  detection on a music or dialogue asset instead", marks itself a warning rather than a
  failure, and the rest of the edit carries on without a beat grid instead of being
  abandoned. Beat detection with no clip named also reaches for your music track first
  rather than whatever happens to sit at the top of the bin. Genuine decode failures are
  still reported in full, still stop the run, and are shown as a plain sentence instead
  of the engine's raw JSON. (`engine/python`, `packages/ai-sdk`.)

- **The assistant no longer starts over mid-task.** If a step somehow lost track of the
  goal or of what to do next, it used to go quiet about it and the assistant would
  compensate the only way it could — re-reading the timeline, re-browsing your media,
  re-finding the beats and re-proposing a plan it had already committed to. FramePilot now
  checks before every step that the goal, the next action and the current version of your
  project are all still there, restores what it can work out for itself, and tells you
  plainly when it cannot rather than quietly beginning again. (`packages/ai-sdk`.)

- **The AI no longer re-analyzes work it has already done.** Within a single request the
  agent could re-detect the beat, re-index media, re-browse the media bin and re-map
  footage after every applied cut — worst on beat-synced montages, which apply one cut per
  beat. Two internal tables that decide what a run remembers had fallen behind the tool
  registry, and anything missing from them defaulted to "record nothing, and discard it on
  the next edit". `detect_beats` was missing from both, so the beat map was forgotten the
  moment the first cut landed. Every tool is now classified explicitly, with a test that
  fails the build if a new tool is left unclassified, and results are only discarded by the
  operations that actually invalidate them — adding a clip no longer expires the media bin.
  (`packages/ai-sdk`, ADR 0079.)

- **Long AI requests re-billed their own instructions on every turn.** The agent contract,
  the committed plan and any loaded expert playbooks are identical for the whole run, but
  they were sent after the timeline snapshot — which changes with each edit — so prompt
  caching could never reuse them and per-turn context size fluctuated. They now precede the
  changing content with an explicit cache boundary. (`packages/ai-sdk`, ADR 0079.)

- **AI requests now keep one provider and recover across planner boundaries.** Model-tier
  routing and its Settings/environment configuration have been removed; the selected
  provider now owns classification, planning, editing, and repair for the whole request.
  Unsupported bounded plans continue through the general agent with cancellation,
  controls, context, and cumulative usage intact. Multi-hour semantic context is sampled
  across the full timeline, and Ollama retries once without `temperature` only after an
  explicit compatibility rejection. (`packages/ai-sdk`, `apps/web-editor`, `apps/desktop`,
  ADR 0078.)

- **AI media-bin browsing now sees the assets visible in the editor.** The asset
  panel reads the editor's live working store, while the AI request could briefly
  use an older app-level project snapshot during import/persistence. In that window,
  `list_assets` reported an empty bin despite visible thumbnails. AI requests now use
  the same live timeline, asset, folder, marker, transcript, and history snapshot as
  the editor. The snapshot is captured again at the instant the turn starts (including
  Cmd+K sends between React commits), and desktop re-validates it against the
  authoritative project revision before use.
  (`apps/web-editor`)

- **Beat-sync requests now analyze before placing clips.** They previously entered the
  generic sequential agent loop, which could start assembling or styling a timeline
  without a settled beat/scene evidence set. The command router now sends explicit
  music/beat synchronization through the bounded planned-edit graph: independent beat
  and footage analyses settle first, then scoped `add_clip` calls become one validated,
  reversible patch. When an `add_clip` proposal misses the mapped detected-onset grid,
  the runtime rejects it and uses its single bounded repair attempt instead of applying
  an almost-synchronized edit. A regression covers that repair, non-uniform onsets, and
  varied clip durations on their exact boundaries. (`packages/ai-sdk`)

- **Captions now land where the words actually play, not where they were spoken.**
  A transcript's timestamps belong to the original recording; a clip's belong to
  the edit. Nothing in the codebase held that distinction, so captions were placed
  at source timestamps — correct on an untouched timeline, and wrong from the
  first cut onward on every real edit. After a ripple delete, speech from 197s of
  the camera file was captioned at 197s on a 92-second sequence. It was invisible
  in testing because the two timebases coincide until something is cut, and every
  operation reported success. Captions are now derived by mapping each word
  through the clips that actually play: words in deleted footage are dropped, the
  survivors move with their footage, and no cue may span a cut — including where a
  ripple delete made two unrelated ranges visually adjacent. **Existing captions
  are not silently trusted**: cues generated before this change report unknown
  provenance until regenerated. (`packages/editor-core`, `packages/timeline-schema`,
  `packages/ai-sdk`, `apps/web-editor`, schema v12, ADR 0076.)
- **A transition can no longer be "added" where there is no cut.** `add_transition`
  stamped its effect onto whatever clip id it was given, without checking that the
  two clips were adjacent, on the same track, or in that order — so a transition
  asked for at a narrative pivot in the middle of a continuous clip applied
  cleanly, reported success, and rendered nothing. Requests are now checked against
  the real cuts, and a refusal explains what to do instead. (`packages/editor-core`,
  ADR 0076.)
- **The AI can no longer report unverified work as done.** It had no tool that
  could contradict a completion claim, so "the operation returned applied" was the
  only evidence available for statements like "captions are in place". New
  `verify_captions` and `verify_transitions` tools read committed timeline state
  and report concrete problems — cues out of sync, over deleted speech, across a
  cut, or left stale by a later edit; transitions with no cut beneath them or
  naming the wrong clip. The agent must run them before claiming either is
  finished, and say "applied but not verified" when it has not.
  (`packages/ai-sdk`, ADR 0076.)

### Changed

- **The AI reads the timeline mapping instead of calculating it.** New
  `get_timeline_map`, `map_time`, `get_mapped_transcript` and
  `list_edit_boundaries` tools expose the engine's own source↔sequence timing, and
  the agent contract now forbids converting between the two timebases by hand —
  the arithmetic is unverifiable in reasoning text and breaks silently on speed
  changes, reused ranges, and any edit made after the sums were done. The contract
  also states the order the work has to happen in (cuts, then captions, then
  styling, then transitions), because captions built before the cuts settle
  describe footage that is about to move. (`packages/ai-sdk`,
  `engine/python/framepilot_engine/ai_tools`, ADR 0076.)
- **Transcripts record which asset they came from.** `POST /transcribe` and the
  unified analyze pass now stamp the asset onto every word, so a project with two
  camera files no longer has an ambiguous transcript. Existing single-asset
  projects are attributed automatically on open; multi-asset ones are left
  unattributed rather than guessed at. (`engine/python/framepilot_engine/service.py`,
  schema v12.)

- **A running AI edit can no longer suddenly switch to an empty new chat.** Desktop
  auto-commits refresh the authoritative project and remount the editor so the timeline
  reflects each accepted change. Conversation hydration restored the records but not the
  active selection, so the durable run kept streaming into its original record behind the
  welcome screen. Recovery now reselects the live run's owning conversation before it
  consumes more events. The related detached-run path is hardened too: the sidebar stays
  attached (and can re-attach after teardown), and Stop retains authority over the actual
  host run instead of becoming a silent no-op. (`apps/web-editor`)

- **The AI editor no longer forgets what it already worked out.** On a longer video the
  agent could spend a whole run circling — re-reading the same transcript, re-mapping the
  same footage, re-deciding the same cuts, announcing it was ready to edit — and finish
  without touching your timeline. Two of its own mechanisms were working against each
  other: one deleted a result from its memory and told it to read the thing again, and the
  other answered that re-read with "you already have this" while handing back nothing. It
  had no way to get back to its own findings, so it started over, forever.

  The agent now keeps a durable record of the run — what it learned, what it decided, what
  it has already applied, and what is left — that survives every step, and any earlier
  result stays retrievable instead of being thrown away. It also notices when it is
  repeating itself in different words, and switches to making the edit rather than
  gathering more. Cutting a clip no longer makes it forget the transcript, because a cut
  cannot change what was said. If a run genuinely cannot finish, it tells you plainly
  instead of ending quietly with an untouched timeline. (`packages/ai-sdk`, ADR 0075)

### Added

- **Captions are now editable text.** Click any caption in the Captions panel and type.
  Fix a word the transcription got wrong, reword a line so it fits the frame, or add a
  line break exactly where you want one — and it stays put. Previously a caption's words
  were read straight from the transcript every time, so there was nowhere for an edit to
  live: the only way to change a caption was to change the transcript, which changed
  every other caption over the same words. Each edit is a normal undo step, and what you
  type is exactly what exports. (`apps/web-editor`, `packages/editor-core`,
  `packages/timeline-schema`, `engine/python`)

- **Split and merge captions.** Every caption row has **Split** (cuts at the playhead,
  giving each half its own words) and **Merge** (joins it with the one after it). Between
  those and inline editing, you can shape a generated caption set into exactly the one you
  want without regenerating. (`apps/web-editor`)

- **A caption style now applies to the whole set.** Pick a template and every caption
  changes at once — one action, one undo. Size, colour, and position still adjust the
  selected caption only, and the panel says which is which, so a caption you have
  hand-tuned survives a change of template. Previously the template had to be applied to
  each caption individually. (`apps/web-editor`, `packages/editor-core`,
  `packages/timeline-schema`, `engine/python`)

- **Emphasised keywords finally show up in your export.** Type words into
  **Emphasise words** and they are styled in the render, not just previewed in the panel.
  (`apps/web-editor`, `packages/timeline-schema`, `engine/python`)

- **See your captions before you commit to them.** The Captions panel previews the exact
  cues Generate will produce, using the same settings, so you can try a different cue
  length and see the result before anything touches the timeline. **Cue length** offers
  *Match the template*, *Short & punchy*, *Full subtitles*, and *One word at a time*.
  (`apps/web-editor`)

- **New Transcription panel — read everything that's said, clip by clip.** The header has
  a new **Transcription** button (next to Footage understanding) that opens a panel
  showing your transcript grouped by the footage it plays over, in timeline order.
  Click any timecode or word to jump the playhead there, watch the spoken word light up
  during playback, search what was said, and copy a clip's text. Audio/video with no
  words yet is listed with a **Transcribe** button, and words that no longer sit over any
  clip are shown as such rather than pinned to the wrong take. (`apps/web-editor`)

- **Hosted transcription now handles long clips and multiple API keys.** Audio/video
  longer than 30 seconds is automatically split into 30-second windows before it's sent
  to the hosted provider (Groq/NVIDIA) and stitched back into one transcript on the
  original timeline — no more oversized uploads on long recordings. And the
  speech-to-text key field accepts a **comma-separated list of keys**: if one is
  rate-limited or revoked, transcription rolls over to the next automatically.
  (`apps/desktop`, `packages/ai-sdk`, `engine/python`)

- **Transcription can now run automatically on import.** Settings → AI → Speech-to-text
  has a new **Transcription** choice: *On demand* (the default — transcribe from the
  Transcript panel or when the AI needs it) or *Automatically on import*. In the automatic
  mode, importing audio/video establishes the project transcript from the first clip using
  your selected provider — non-destructive, so importing more footage never overwrites an
  existing transcript. Desktop only. (`apps/web-editor`)

- **You can now set the speech-to-text model for hosted transcription.** Settings → AI →
  Speech-to-text shows a **model** field for Groq / NVIDIA next to the API-key field;
  leave it blank to use the provider default (e.g. `nemotron-asr-streaming` for NVIDIA).
  The chosen model is used by both the manual Transcribe button and the AI agent.
  (`apps/web-editor`, `apps/desktop`, `packages/ai-sdk`, `packages/shared-types`)

### Fixed

- **AI tasks no longer stop when the panel remounts or the project view refreshes.**
  The panel previously treated ordinary interface cleanup as if you had clicked Stop,
  which could cancel a healthy edit immediately after it changed the timeline and leave
  the replacement panel showing “Generating.” Durable tasks now keep running through
  panel/tab/navigation lifecycle changes and reconnect from their saved cursor. Only an
  explicit Stop or dismissed question can be recorded as cancellation; timeouts,
  failures, shutdowns, and interrupted restarts keep distinct, visible reasons. Long
  streams also checkpoint snapshots periodically instead of rewriting a full snapshot
  for every token, and exact duplicate events are ignored. (`apps/web-editor`,
  `apps/desktop`, `packages/ai-sdk`)

- **The assistant now commits to an edit instead of researching forever.** Asking for a
  big change — "cut this to a minute with captions and transitions" — could send it into
  a loop: reading the transcript, mapping the footage, and drafting the same plan over
  and over, minutes at a time, then finishing without touching your timeline. It now has
  a fixed budget for looking before it acts, and once that is spent it makes the best
  edit its evidence supports. Every edit it lands renews the budget, so long multi-step
  jobs still get to study each step properly. (`packages/ai-sdk`)

- **A run that changes nothing now tells you.** Previously the worst case was also the
  quietest: if the assistant gave up without ever attempting an edit, it finished
  looking like a normal run that happened to produce no changes. It now says plainly
  that your timeline is untouched, so you never have to check for yourself.
  (`packages/ai-sdk`)

- **Chat history now belongs to the project where it was created.** Opening another
  project no longer shows conversations from unrelated work. New conversation records
  carry explicit project ownership, and the persistence boundary prevents cross-project
  list, load, save, or delete operations. Legacy unscoped records stay hidden rather
  than being exposed to an arbitrary project. (`apps/web-editor`, `apps/desktop`,
  `packages/shared-types`)

- **Editor side panels and preview controls now stay aligned when space is tight.**
  Source/Program playback controls remain centered below the picture; orientation,
  loop, grid, safe-area, zoom, and fullscreen controls sit at the right of the same
  Source/Program header. Transcript words wrap as readable phrases instead of four-word stair-steps,
  and the Assets header, filters, sort, and import actions restructure against the
  resizable rail without clipping. (`apps/web-editor`)

- **Captions break where a sentence breaks.** Captions were cut every N words, blind to
  what was being said, so lines ended on "the" or "and" and a caption could sit on screen
  through several seconds of silence. They now break at sentence ends first, then clauses,
  then pauses — never leaving an article or preposition stranded at the end of a line.
  Captions are also held long enough to read, split when speech arrives faster than the
  eye can follow, and no longer blink off and on between phrases. (`packages/editor-core`)

- **Asking the AI for captions and pressing Generate now give the same result.** The two
  paths had separate rules for cutting up speech and quietly disagreed on the same
  project. (`packages/ai-sdk`, `packages/editor-core`)

- **The caption list shows what the export will actually say.** For a word that straddled
  a caption boundary, the panel and the rendered video disagreed about which caption it
  belonged to. (`apps/web-editor`, `engine/python`)

- **Generate captions can be run twice.** Generating a second time now replaces the
  existing captions instead of colliding with them, so it is safe to re-run after
  re-transcribing or changing the cue length. (`apps/web-editor`)

- **Removed a caption checkbox that did nothing.** The Captions panel had a "Burn in on
  export" toggle that only changed a line of text next to it; caption burn-in is set in
  the Export dialog, which is where it always took effect. (`apps/web-editor`)

- **Importing media now shows what's happening.** Every file you import gets a shimmering
  placeholder card in the Assets panel while it's probed, copied, and analysed, then turns
  into the real thumbnail when it lands — so a large import no longer looks like nothing
  happened (the loading state was previously invisible). (`apps/web-editor`)

- **Header tooltips now open downward.** Tooltips on the buttons in the top bar pointed
  upward, off the top edge of the window; they now appear below their button.
  (`apps/web-editor`)

- **Stopping, switching chats, and closing the app now reliably end an AI run.** The
  assistant runs one agent at a time, and its lifecycle is now airtight end to end:
  clicking Stop always settles the run (no more chat stuck shimmering "in progress");
  opening a New chat or a past conversation while a run is live cleanly stops that run
  instead of orphaning it in the chat you left; and closing or reloading the app aborts
  the in-flight run. If the app is force-quit or crashes mid-run, the next launch closes
  out the interrupted run automatically, so you never reopen into a permanently stuck
  "in progress" state. (`apps/web-editor`, `apps/desktop`)

- **The message box no longer gets stuck on "Stop" after you leave and come back.** If an
  AI run finished while its sidebar was closed, reopening it left the composer frozen on
  the red Stop button so you couldn't send a new message. Run recovery now recognizes a
  run that completed while you were away and settles it immediately, restoring Send.
  (`apps/web-editor`)

- **Choosing a hosted transcription provider (Groq / NVIDIA) now works when the AI does
  the transcribing.** Selecting NVIDIA (or Groq) under Settings → AI → Speech-to-text
  only changed the manual **Transcribe** button — the in-app agent's `transcribe` always
  went to the local Whisper engine and failed with "ASR model is not installed" when no
  local model was set up. The provider choice is now saved with your AI settings, so the
  agent transcribes off-device with your hosted key just like the button does; local
  `whisper-cli` still runs in the engine as before. (`apps/desktop`, `apps/web-editor`,
  `packages/ai-sdk`, `packages/shared-types`)

- **Stopping an AI run no longer leaves a "Thinking…" shimmer or a scary red error.**
  When you hit Stop (or rejected a step) while the model was mid-thought, the last
  reasoning line kept shimmering forever and a "A terminal run cannot accept stream
  events." banner could appear. A stopped run now settles its in-flight thinking
  immediately and quietly ignores the stray tokens that arrive just after. (`packages/ai-sdk`,
  `apps/desktop`)

- **Transcription no longer completes with an empty `[]` transcript.** The old AI tool
  accepted caller-supplied words but never ran speech-to-text, so the model could submit
  `words: []` and erase the transcript. The Transcript panel now runs the selected local,
  Groq, or NVIDIA provider in the trusted desktop host, shows source/progress/error state,
  and applies only non-empty timed words through the reversible `set_transcript` patch.
  The in-app agent and MCP tool now request an asset only; ASR output is host-produced and
  schema-validated before apply. (`apps/desktop`, `apps/web-editor`,
  `packages/ai-sdk`, `packages/mcp-server`, `engine/python`)

- **Long AI runs no longer bury their work in one expanding checklist.** Each agent
  step now keeps its own short thinking record beside the tools it used, in the order
  the work happened. Regular runs stay a readable activity stream; turning on
  **Plan first** still shows the fixed plan you approved. (`packages/ai-sdk`,
  `apps/web-editor`)

- **Footage understanding no longer re-charges the TwelveLabs API for footage that
  hasn't changed, and no longer vanishes when you reopen a project.** The footage-map
  route required a live TwelveLabs index and a `ready` mapping *before* it would even
  look at its own on-disk cache, so a reopened project fell through to "This footage
  is not indexed yet" even though a perfectly good map was cached, and any hiccup in
  the live index meant paying Pegasus all over again. The content-hash cache is now
  authoritative and served **per footage, first** — an unchanged clip is a pure cache
  read (zero API calls), a reopened project keeps its map even if the live index is
  gone, and a project with several clips only fetches the *new* one while serving the
  rest from cache. Only the explicit **Rebuild** action re-reads Pegasus.
  (`engine/python/framepilot_engine/service.py`)

### Added

- **AI runs now have a durable recovery foundation.** The desktop can persist each
  orchestration run as a validated, append-only event log with atomic snapshots,
  idempotent event retries, monotonic sequencing, explicit schema migrations, and
  quarantine for corrupted state. A sender/project-scoped preload gateway now exposes
  typed start, approval, answer, steering, cancel, resume, patch-decision, snapshot,
  and replay-from-cursor operations without making renderer state authoritative.
  Desktop plan approvals, model questions, steering, and cancellation now use those
  durable commands and persisted wait gates; browser/dev keeps its in-process adapters.
  Existing streamed AI activity is written to the run log before it reaches the
  renderer, making that activity recoverable while the Effect Runtime migration proceeds.
  Reloading the editor reclaims an active run, replays missing activity from its
  acknowledged cursor, resumes live delivery, and keeps approval, answer, steering,
  and cancellation controls attached to the same durable run.
  (`apps/desktop/electron/ai/run-store.ts`, `run-coordinator.ts`, `run-ipc.ts`)

- **Agent host work now crosses one observable execution boundary.** Analysis and
  action tools requested by ordinary agent and question runs use the shared Effect
  Runtime for host dispatch, successful-result deduplication, cancellation, and durable
  effect recording while retaining the run's compute budget and existing tool-card
  behavior. Up-front agent plan drafting and the bounded repair completion use that
  boundary as well. Live agent turns now retain incremental text, reasoning, and tool
  calls through a streaming model effect whose complete lifecycle is recoverable.
  The non-streaming agent API follows the same path, and the duplicate orchestrator
  host cache/direct-executor fallback has been removed. (`packages/ai-sdk`,
  `apps/desktop`)

- **Approvals and agent questions are now real execution effects.** Waiting for a plan
  decision or an answer is visible to the same runtime lifecycle as model and host work,
  with stable identity, durable effect recording, cancellation propagation, and a
  bounded deadline instead of an opaque Promise inside an orchestration handler.
  (`packages/ai-sdk`, `apps/desktop`)

- **Desktop project saves now reject stale state.** Validated opens, saves, and external
  MCP-originated changes share a host-owned monotonic project revision and one serialized
  commit lane per project. Autosave sends its expected revision; if the file changed
  meanwhile, the editor shows a save error instead of overwriting newer work. AI run
  records now start with the real project revision rather than a hard-coded zero.
  (`apps/desktop`, `apps/web-editor`, `packages/shared-types`)

- **The desktop now has an authoritative patch commit command.** Patch requests are
  envelope-checked at IPC, validated and applied through editor-core against the current
  project, schema-validated again, and persisted inside the per-project revision lane.
  Stale but still valid edits rebase deterministically; overlapping or invalid edits are
  rejected without changing the project. AI review accepts, subset accepts, batch apply,
  and auto-apply now use this command and replace the workspace from its committed result
  instead of mutating renderer-only state. (`apps/desktop`, `apps/web-editor`,
  `packages/shared-types`)

- **Saved desktop AI runs no longer trust a renderer-supplied project document.** The
  request carries project identity and expected revision; Electron resolves the
  validated authoritative project and rejects stale runs before model or host work
  begins. Only an unsaved revision-zero project sends a one-time bootstrap document.
  (`apps/desktop`, `apps/web-editor`, `packages/shared-types`)

- **AI review decisions now reconcile with durable run truth.** A successful desktop
  patch commit records its patch id and committed project revision on the originating
  run, updates the terminal outcome to “completed with changes,” and preserves explicit
  rejections. Reloaded run history no longer says “no changes” after the user applied
  its edit. (`apps/desktop`, `apps/web-editor`, `packages/ai-sdk`)

- **Project revisions now survive app restarts.** Electron restores its atomic revision
  registry before opening the IPC command surface and advances the revision if the file
  changed while FramePilot was closed. AI conflicts are classified as cleanly
  rebaseable, overlapping/replan-required, or authority-required instead of collapsing
  every stale outcome into one generic failure. (`apps/desktop`, `packages/shared-types`)

- **Desktop auto-apply is now a durable execution policy.** The selected review or
  auto-commit policy is persisted with the run. In auto mode Electron commits each
  validated proposal before publishing it, records committed/stale/rebased truth,
  synchronizes the open workspace to the returned revision, and reports the correct
  terminal outcome. React no longer initiates desktop auto-commits.
  (`apps/desktop`, `apps/web-editor`, `packages/ai-sdk`)

- **One AI run is one deterministic Undo step.** Host commits persist project-scoped
  inverse history and collapse consecutive patches from the same durable run into one
  reversible entry. The renderer installs the authoritative committed project without
  applying the operations twice. (`packages/editor-core`, `apps/desktop`)

- **The Footage understanding panel now teaches as it reveals.** A dismissible deck of
  info cards explains, in plain editor language, what chapters and highlights are and
  how the map is read (once, cached, from the footage — not your current cut); it shows
  the first time and stays gone once dismissed, with a header **guide** toggle to bring
  it back. The content itself now animates in with a staggered spring reveal — the
  summary, each chapter, and each highlight rise into place in order — and the chapter
  under the playhead pulses so it's unmistakable while footage plays. All motion honors
  `prefers-reduced-motion`. (`apps/web-editor/src/components/FootageUnderstandingPanel.tsx`)

### Changed

- **Footage understanding is now about the footage, not the current edit.** The map
  is built from each asset's own source structure, so it's complete even when the clip
  is unplaced, trimmed to a sliver, or split — an empty timeline no longer means an
  empty understanding. When a clip *is* on the timeline you can still act on it: click
  a chapter to seek there, and the chapter under the playhead lights up as you play.
  Multi-clip projects group chapters by footage. (`engine/python/…/service.py`,
  `apps/web-editor/src/components/FootageUnderstandingPanel.tsx`,
  `apps/web-editor/src/editor/footageProjection.ts`)

- **The Footage understanding panel got a craft pass.** Chapters read as a vertical
  timeline spine; the map loads with a shimmer skeleton and honest, staged status copy
  for the slow first build ("Reading the footage…" → "Building the full map…"), holding
  the loader back so a cached open shows nothing at all; empty/offline states get a
  clear icon, a next step, and a retry; highlights are visually distinct; and the
  ambiguous lightbulb "rebuild" button is now a labeled **Rebuild** control — a normal
  open only reads the cache and never re-bills. (`apps/web-editor/src/components/FootageUnderstandingPanel.tsx`)

- **TwelveLabs understanding now runs on the official `twelvelabs` SDK.** The
  engine's TwelveLabs client (`brain/twelvelabs.py`) was a hand-rolled REST client,
  which is why silent API drift kept breaking it — a sunset `/summarize` endpoint,
  `/search` swapping `score` for `rank`, index `id` replacing `_id`. It is now a
  thin typed facade over the generated SDK, so the engine tracks the live v1.3 spec
  for free; the public methods, dataclasses, typed errors, and offline (`respx`)
  tests are unchanged, so no caller or behavior changed. (Note: the SDK currently
  ships without a declared license; it is vendored with that risk accepted and
  documented at the dependency and in ADR 0097.) `engine/python`

- **The AI sidebar no longer scolds a run that made no timeline edit.** Read and
  agent runs legitimately finish without an edit — describing footage, answering a
  question, planning — and the old "No changes were made — I couldn't turn this
  into an applicable timeline edit / try rephrasing" notice fired on every one of
  them, reading as a failure of a run that did its job. That gating is removed; the
  run's own output stands on its own. (`apps/web-editor/src/ai/runOutcome.ts`)

### Added

- **TwelveLabs transcript pull (engine).** On the TwelveLabs backend `/transcribe`
  now returns TwelveLabs' own word-level transcription for an indexed asset —
  fetched from `GET /indexes/{id}/videos/{id}?transcription=true`, which TwelveLabs
  produces when it indexes the audio — instead of running local whisper a second
  time over audio it already understood. A non-indexed asset still falls back to
  whisper. This is the foundation for making talking-head edits ("make it a 1-min
  video") work on TwelveLabs projects; the host wiring that applies the transcript
  to the project so the agent reads it is the next step.
  (`engine/python/framepilot_engine/brain/twelvelabs.py`, `service.py`)

### Fixed

- **The center stage no longer gets crushed to a sliver on a narrow window.**
  `WorkspaceShell`'s layout gave both side rails their full persisted pixel
  widths and let the program monitor/timeline absorb whatever was left, with no
  floor — so on a narrowed desktop window the rails stayed full width while the
  stage shrank toward zero. The rails now give way first: `WorkspaceShell`
  measures its own width and shrinks both rails (proportionally, never below
  their own minimums, collapsed rails untouched) to keep the stage at least
  320px. The Electron window also gained a `minWidth`/`minHeight` floor so the
  OS-level resize can't push the layout past the point the rails have room to
  give. (`packages/ui/src/WorkspaceShell/{useRailLayout,WorkspaceShell}.tsx`,
  `apps/desktop/electron/main.ts`)

- **The footage map works again on TwelveLabs projects.** Two TwelveLabs API
  changes had broken it. First, TwelveLabs sunset the `/summarize` and `/gist`
  endpoints (removed 2026-02-15) — a live index now answers HTTP 410
  `endpoint_deprecated` — so the Pegasus chapter/highlight/summary calls moved to
  the replacement `/analyze` endpoint with a JSON-schema `response_format`, parsing
  the same structured output. Second, `/analyze` (generate) requires a **Pegasus**
  model on the index, but FramePilot created indexes with Marengo only, so
  `/analyze` answered HTTP 400 `index_not_supported_for_generate`. New indexes now
  include `pegasus1.2` alongside Marengo, and a project whose index predates this
  (Marengo-only) now falls back to the built-in span/caption footage map instead of
  surfacing a raw HTTP 400 — re-indexing recreates the index with Pegasus and
  restores the richer Pegasus map. Neither change alters the cached map shape or any
  caller.
  (`engine/python/framepilot_engine/brain/twelvelabs.py`, `service.py`)

- **TwelveLabs visual search now ranks results instead of returning a flat wall
  of ties.** Marengo 3.0's search response carries each clip's `rank` (1 = best)
  and **no** numeric `score` field, but FramePilot only read `score` — so every
  clip arrived with `score = 0`. The agent then saw an undistinguished list of
  `rrf=0` scenes with no relevance signal, repeated the same search, and stopped
  with "no further edits could be found." Search now derives the score from the
  rank (`1/rank`, best-first) and queries the same **visual + audio +
  transcription** modalities the TwelveLabs dashboard uses, so FramePilot's top
  result matches the dashboard's. Index creation still uses only the valid
  `visual` + `audio` model options. (`engine/python/framepilot_engine/brain/twelvelabs.py`)
- **Visual search/description now reach the TwelveLabs backend on desktop.** When
  the TwelveLabs (or NVIDIA) key lived only in Settings — not the engine env —
  `search_visual` and `describe_footage` omitted it from their requests, so the
  engine fell back to the empty built-in `sqlite-vec` store and reported
  TwelveLabs-indexed footage as "not indexed yet" even though indexing had
  reached 100%. Both query routes now forward the host-held key (matching
  `index_media`): search reaches whichever backend indexed the footage, and
  `describe_footage` returns the honest "use visual search" message on TwelveLabs
  instead of a misleading empty result. Keys still never enter model context or
  logs. (`packages/ai-sdk/src/sidecar-executor.ts`)
- **TwelveLabs text search no longer fails with HTTP 400 `content_type_invalid`.**
  The client sent `/search` as `application/x-www-form-urlencoded`, which
  TwelveLabs rejects — its v1.3 Search API requires `multipart/form-data`. Text
  queries now post the fields as multipart parts (repeated `search_options` per
  modality preserved), matching the image-search path.
  (`engine/python/framepilot_engine/brain/twelvelabs.py`)
- **Analysis tools recover from a wrong `assetId` instead of dead-ending on a
  404.** When a tool call (`detect_scenes`, `analyze_silence`, …) passed an asset
  id that isn't in the project — e.g. the model appended a scene index to the real
  id — the engine returned a bare *"Asset 'X' not found in project."* The error now
  lists the project's real analysable asset ids (bounded), so the agent can
  self-correct on the next turn. (`engine/python/framepilot_engine/service.py`)

### Added

- **TwelveLabs as an optional media-understanding backend (ADR 0070).** When a
  **TwelveLabs API key** is set (Settings → AI → Embeddings, or the
  `TWELVELABS_API_KEY` env), FramePilot delegates video/image/audio understanding
  to TwelveLabs' hosted Marengo index — which understands a clip's visual, audio,
  and speech content together — instead of the built-in NVIDIA-embed + `sqlite-vec`
  pipeline. It slots in behind the **same `/brain/visual/*` routes**: index/search
  degrade honestly (`invalid_api_key`, `not_indexed`, or a clean fallback), map
  TwelveLabs clips onto the existing `EvidencePacket` contract (reported
  `backend: "twelvelabs"`), and change nothing when no key is set. Word-level
  captions/transcript stay on local whisper (no caption-timing regression);
  `describe_footage` is honestly unsupported on this backend (use visual search).
  The asset↔video mapping reuses existing brain tables — no schema migration; the
  key is host-owned, never logged. New: `engine/.../brain/twelvelabs.py` +
  `twelvelabs_index.py`, `TWELVELABS_API_KEY`, and a TwelveLabs key slot in the
  desktop config and web-editor Settings.
  (`engine/python/framepilot_engine/service.py`,
  `packages/ai-sdk/src/{visual-index-client,sidecar-executor}.ts`,
  `packages/shared-types/src/ipc.ts`, `apps/desktop/electron/ai/ai-config.ts`,
  `apps/web-editor/src/{editor/visualIndex.ts,components/SettingsDialog.tsx}`)
- **NVIDIA speech-to-text + a dedicated ASR API key (plan H0.1).** Settings → AI →
  Speech-to-text now offers **NVIDIA** (`nemotron-asr-streaming` on
  `integrate.api.nvidia.com`) alongside Local (whisper-cli) and Groq. Hosted ASR
  now authenticates with its **own pasteable API key**, stored in its own slot —
  no longer the chat provider's key — so a transcription account can differ from
  the chat account. The key is stored locally (desktop `ai-config.json` /
  browser localStorage), forwarded only to the chosen provider, and never to
  FramePilot. New `NvidiaTranscriptionProvider` mirrors the Groq ASR provider
  (OpenAI-compatible multipart `/audio/transcriptions`, word-level timestamps).
  Env: `FRAMEPILOT_ASR_API_KEY` (dedicated key), `FRAMEPILOT_ASR_NVIDIA_MODEL`
  (optional model override).
  (`packages/ai-sdk/src/providers/nvidia-asr.ts`,
  `apps/web-editor/src/components/SettingsDialog.tsx`,
  `apps/desktop/electron/ai/ai-config.ts`)
- **Template-based captions (schema v10, ADR 0069).** The caption system is now a
  45-template catalog (one-word, phrase, karaoke, build, boxed, editorial,
  aesthetic, cinematic families) replacing the previous 3 style presets end to
  end. The Captions panel gains a category-tabbed gallery whose tiles
  live-animate each template; picking one stamps `captionStyle.templateId` on
  generated caption clips (size/color/position layer as per-clip overrides).
  The program monitor previews the exact template behavior (active-word,
  cumulative build, karaoke fill, entrances, accent words) via a shared
  DOM interpreter, and the Python engine burns in the same catalog looks with
  bundled OFL fonts (Inter, Archivo Black, Oswald, DM Serif Display, Space
  Mono, Caveat, Nunito). Adding a template is pure catalog data — renderers
  interpret closed enum vocabularies, never template ids. The AI
  `set_caption_style` tool and the `add_captions` recipe select templates too.
  Old projects using the legacy `clean`/`bold-pop`/`subtle` presets migrate to
  their nearest templates (first data-transforming migration, v9 → v10);
  unstyled captions keep the byte-identical baseline render.

### Fixed

- **TwelveLabs indexing of long videos no longer stalls, and its status is
  traceable.** The whole-file upload to TwelveLabs now gets a generous timeout on
  both the engine (`POST /tasks`) and the index client, instead of sharing the
  120-second per-request bound that silently killed a large upload mid-stream and
  left the job stranded at 0%. The Indexing status panel now detects a
  TwelveLabs-backed project from its stored index — so it reports
  `backend: "twelvelabs"` (not `sqlite-vec`) even when the key lives only in
  Settings and the engine env is unset. Every TwelveLabs call (upload
  start/finish with file size + elapsed, each indexing poll, search result
  counts, and typed failures) is now logged for tracing — never the key or media
  bytes. (`engine/python/framepilot_engine/brain/{twelvelabs,twelvelabs_index}.py`,
  `engine/python/framepilot_engine/service.py`,
  `packages/ai-sdk/src/visual-index-client.ts`)

### Removed

- **The unsupported `extract_frames` and `commit_vision` protocol has been removed
  end to end.** The engine no longer exposes its frame-extraction or vision-commit
  routes; the AI SDK, MCP host, prompts, activity metadata, and run-budget accounting
  no longer advertise or route either tool. Visual grounding remains available through
  `search_visual`, `describe_footage`, and `index_media`.

### Changed
- **Visual indexing can now use a selected caption provider.** Settings → AI →
  Embeddings lets editors choose the configured vision-capable model that writes
  factual scene descriptions; desktop keeps that provider key out of the renderer.
  The coverage line now includes zero and nonzero caption totals whenever that
  provider is configured, and refreshes every two seconds while the Embeddings
  view remains open. The Settings content header was also removed to leave more
  room for controls.
- **Settings is now an editor control room instead of a flat preference list.**
  All six sections remain live, but are grouped into Workspace, Intelligence,
  and Reference with section context, task-based control cards, a persistent
  readiness rail, keyboard arrow/Home/End navigation, focus trapping/restoration,
  a side-by-side Editing/Playback layout on wide screens, and responsive
  horizontal navigation down to narrow windows. AI/provider,
  memory, shortcut, and local preference storage contracts are unchanged. See
  [the Settings guide](docs/guides/settings.md).
- **Visual search is now ~15–45× faster: `VisualVectorStore.search` p95 at 50k
  vectors dropped from ~1–3 s to ~64 ms, meeting the MI7.1 budget (< 100 ms).**
  The cost was never the vec0 KNN (~52 ms) but two per-search O(n) passes —
  rebuilding every `visual_spans` row into a Pydantic object and scanning the whole
  rowid→key map — run on each query. Both are now O(k) indexed point lookups for
  only the top-k hit rowids (k ≤ 50), so search time is essentially the raw KNN.
  Results, ordering, filters, and the empty-index / orphan-rowid / missing-metadata
  edge cases are byte-for-byte identical (all parity + edge tests green), with no
  schema, index, migration, or dependency change. The strict perf gate
  (`FRAMEPILOT_PERF=1`) now passes, and a new regression guard pins the O(k)
  property so a revert to full materialization fails a test.

### Fixed
- **Beat-synced agent runs no longer stop after repeatedly asking for the missing end
  of a beat grid.** Every detected onset—including non-uniform timestamps—is now passed
  to the model instead of truncating at 32 and approximating the rest from average BPM.
  If a turn still repeats only memoized reads, FramePilot gives it one bounded
  mutation/ask-only recovery turn, preventing another redundant read cycle. Plan
  checkmarks now require an applied validated edit rather than merely another model
  turn.
- **Beat-synced image edits no longer fail every `add_clip` with a duration
  mismatch.** The model now supplies one authoritative timeline span and the tool
  boundary derives the matching 1× source range in both the in-app orchestrator
  and Python/MCP mirror. Sub-second, non-uniform beat intervals therefore remain
  valid even when an image asset advertises a default five-second display range.
  Rejected zero-op runs also no longer display a misleading successful self-check.
- **Visual descriptions and agent-triggered indexing now return consistent,
  useful evidence.** `describe_footage` uses a dedicated local enumeration route
  instead of a neutral semantic top-k query, so it reads every indexed span in
  order without needing an embedding-key round trip. Agent `index_media` calls now
  receive the same host-resolved embedding and caption credentials as Settings,
  can backfill captions onto already-embedded footage, and reject provider status
  metadata such as `User Safety: safe` instead of storing it as scene content.
- **The model now receives complete structured visual evidence and bounded repair
  guidance.** Visual tool results preserve asset times, scenes, captions, dialogue,
  retriever sources, and RRF relevance (explicitly not confidence); failure recovery
  permits one corrected retry by failure class instead of open-ended repetition.
- **NVIDIA visual indexing no longer stops with HTTP 400 on a frame batch.**
  The embeddings endpoint requires `modality` to contain one entry for every
  item in `input`; FramePilot sent a one-item list for batches of up to eight.
  The request builder now produces equal-cardinality arrays for every batch,
  with a regression test that fails on the rejected broadcast-style payload.
- **Visual indexing silently indexed zero still images, every time, on
  ffmpeg 8.1 — jobs reported "done, 100%" while `visual_spans` stayed empty.**
  Root cause, confirmed by running the engine's exact ffmpeg command against a
  real project's photo on disk: ffmpeg 8.1's `image2` still-image demuxer
  returns **zero frames for any `-ss` value placed before `-i`, including
  `-ss 0`** — exit code 0, no error, just empty stdout. Every still-image
  extraction requests `t=0.0` (there is only one frame), and the frame/
  keyframe argv builders (`engine/python/framepilot_engine/visual_indexing.py`)
  unconditionally emitted `-ss <t>` before `-i` for every asset, image or
  video. A new `_seek_args()` helper omits the flag at `t <= 0` (verified
  equivalent for real video too — a seek-to-the-start is a no-op regardless of
  container), fixing frame/keyframe extraction for every still image.
- **"Index now" could crash the whole visual-indexing job (500, surfaced in
  the browser as a misleading CORS error) on the first asset ffmpeg couldn't
  decode a frame from, or the first non-retryable NVIDIA embeddings response**
  — and because a slice always resumes from the same unfinished cursor, one
  bad asset permanently blocked indexing every other asset in the project on
  every retry. `POST /brain/visual/index` only caught `KeyRingExhaustedError`;
  `FrameExtractionError` and `FFmpegError` (ffmpeg produced no frame, exited
  non-zero, timed out, or the binary was missing) or a `VisualEmbedError` (a
  non-retryable NVIDIA response) propagated out uncaught. Starlette's
  `CORSMiddleware` never wraps a response for an unhandled exception, so the
  crash showed up client-side as "blocked by CORS policy," hiding the real 500
  and its traceback. `FrameExtractionError`/`FFmpegError` are now caught
  per-asset in `_index_one_asset` (that one asset is reported `ok: false` with
  a reason; the rest of the slice still indexes), and `VisualEmbedError` is
  now caught at the route level like `KeyRingExhaustedError`, matching the
  honest-degrade convention the sibling `/brain/visual/search` route already
  used. Five regression tests reproduce each crash/silent-failure mode and
  confirm the fixed route returns 200 with an honest per-asset or per-slice
  result instead of a raw 500 or a false "done."
- **Settings → AI → Embeddings always reported "Analysis engine unreachable,"
  even with a healthy sidecar and a valid NVIDIA key.** `VisualIndexClient`
  stored the native `fetch` unbound and called it as `this.fetchFn(...)`; a
  browser's native `fetch` throws `Illegal invocation` when invoked with `this`
  rebound away from `window`, so every status/index/cancel request from this
  client failed before it ever reached the network — silently, since the
  degrade-to-`undefined` path swallows the error into a debug log. It's now
  bound to `globalThis` on construction, matching the ASR client's existing
  pattern, with a regression test that reproduces the real browser brand-check
  (not just a permissive `vi.fn()` stub) so this can't silently regress.
- Settings → AI → Embeddings also now re-probes the engine on window focus
  instead of only once on open, so a panel opened during sidecar startup
  self-recovers instead of staying stuck.

### Added
- **FramePilot can now see your footage — the AI edits from what's on screen,
  not just what was said.** Add an NVIDIA API key under Settings → AI →
  Embeddings and FramePilot builds a visual index of your media in the
  background: it samples frames, understands them, and writes a short
  description of every scene. Ask for "the product shot", "where the whiteboard
  appears", or "make a short from the demo part" and the AI now retrieves the
  matching moments with evidence — timecodes and captions it can cite — instead
  of guessing from the transcript. Nothing runs without a key (configuring one
  is your consent for frames to be sent to NVIDIA's cloud for indexing), and if
  a key isn't set, isn't indexed yet, or you're on the browser build, the AI
  says so honestly rather than inventing an answer. Give several comma-separated
  keys and it rotates between them automatically if one is rate-limited. See
  [the Media Intelligence guide](docs/guides/media-intelligence.md). (ADRs 0065,
  0066, 0067)
- **Documented performance budgets and non-flaky guards for visual search &
  indexing (MI7.1).** The visual retrieval path now has two published budgets —
  `VisualVectorStore.search` p95 < 100 ms at 50k vectors (sqlite-vec), and an
  index-write throughput floor — measured by `engine/python/tests/test_visual_perf.py`
  against a seeded synthetic corpus. The tight search assertion is opt-in behind
  `FRAMEPILOT_PERF=1` (the default suite measures + logs and asserts only a
  generous regression ceiling, so it never flakes on CI runners); the guard skips
  honestly when sqlite-vec cannot load. Measurement flagged a real gap (search p95
  at 50k was ~1–3 s — two per-search O(n) table materializations dominating, not the
  vec0 KNN), which the `performance-optimizer` follow-up above has since closed
  (~64 ms, strict gate green). See `docs/guides/performance-budgets.md`.

- **The desktop app now packages into a real, self-contained installer.**
  `pnpm desktop:dist` produces an app that runs on a machine with no Python,
  no `uv`, and no repo checkout: the web-editor UI is staged into the package
  (built with a relative base so it loads from `file://`), and the render
  engine ships as a frozen PyInstaller bundle under `Resources/engine/` that
  the app spawns as its sidecar (verified end-to-end: health check + a real
  validated render from the frozen binary). Dev builds keep running the engine
  from source via `uv`; `FRAMEPILOT_ENGINE_DIR` still overrides either mode.
  Known follow-ups: `ffprobe` is not yet bundled (media inspect on a clean
  machine needs it on PATH or `FRAMEPILOT_FFPROBE`), and notarized releases
  still need an afterSign hook to deep-sign the engine binaries. (ADR 0062)
- **Installers are now fully self-contained and release-ready.** A clean
  machine needs nothing preinstalled: `ffprobe` ships inside the app next to
  the engine (media import probing and render validation work out of the box —
  verified by rendering with an empty PATH), and the app automatically uses a
  bundled `whisper-cli` for transcription the moment one is shipped. Release
  builds deep-sign the engine for macOS notarization, and a new tag-triggered
  release pipeline builds signed installers for macOS (Apple Silicon + Intel),
  Windows, and Linux and stages them on a draft GitHub Release for review.
  (ADR 0063)
- **Transitions now play live in the preview.** Scrubbing or playing across a
  cut shows the same fade, cross-dissolve, push, zoom, blur, wipe, or slide
  ramp the export produces — on both the WebCodecs canvas engine and the DOM
  preview player — instead of only appearing after a render. The preview
  evaluates the exact envelope math the Python render engine uses (same
  constants, mirrored in `apps/web-editor/src/preview/transition-envelope.ts`,
  locked by unit tests on both sides). (ADR 0061)
- **Two new transition kinds: `wipe` and `slide`.** Wipe is a soft left→right
  reveal; slide enters the next shot from below (push's vertical cousin).
  Available from the transition picker, the `add_transition` AI tool, and the
  MCP server; no schema change or migration — kinds live in the op unions.
  (`packages/editor-core`, `engine/python/.../render/transitions.py`,
  ADR 0061)

### Changed
- **The web editor's chrome has a new, more polished dark look.** A near-black
  surface palette (replacing the previous mid-gray "cool neutral" ramp) and a
  blue accent throughout — the Export button, active rail icon, selected clip
  outline, snap toggle, and playhead. The top bar gained a theme toggle and a
  "Send feedback" link; the Preview transport gained a "Fit" zoom dropdown and
  a fullscreen button; the Assets panel header was simplified to a title +
  labelled Import button; the empty Inspector now shows an icon + "It's empty
  here" message instead of bare text; and the timeline toolbar's snap toggle
  and zoom controls moved into a new view-controls row (with a zoom slider and
  a "Main scene" label) directly above the ruler they affect, alongside a new
  Duplicate-clip toolbar button. Every existing keyboard shortcut, menu, and
  panel still works — this is a re-skin, not a feature change. Light theme's
  accent moved from orange to a matching blue for consistency.
  (`packages/ui/src/tokens.css`, `apps/web-editor/src/styles.css`,
  `Topbar.tsx`, `Editor.tsx`, `MediaBin.tsx`, `PreviewPlayer.tsx`,
  `Inspector.tsx`, `Toolbar.tsx`, `TimelineView.tsx`)
- **The AI's question route is now hard-scoped to read-only tools.** A Q&A
  turn's advertised tool surface is limited by construction to reading,
  analysis, and asking you — a mutating or rendering tool descriptor can never
  reach a question prompt (enforced by the new route scope and locked in by
  tests; the question route sent no tools before, so nothing changes today —
  this is the guaranteed ceiling for when it gains tool use).
  (`packages/ai-sdk/src/orchestrator.ts` — `agentTools(scope)`,
  `tool-scope.ts` — `QUESTION_ROUTE_PERMISSIONS`)
- **AI runs now stop honestly when they've converged.** A run whose last few
  turns each produced almost no new output and no edits now ends itself with a
  clear "converged" notice (with the token numbers that triggered it) instead
  of quietly burning through its budget on tiny look-around calls. This is
  distinct from the existing "stopped making progress" stall notice, and both
  thresholds are tunable per run. (`packages/ai-sdk/src/kernel/conductor.ts`,
  `orchestrator.ts`, `agent.ts`)
- **Long AI runs stay lean: old tool results are cleared, not carried.** When
  a run's action history grows past a size threshold, the bulky data payloads
  of older read/analysis results are replaced in place with
  `[old result cleared — re-read if needed]` — the AI keeps the full record of
  what it called and what succeeded, and a repeat read costs nothing thanks to
  the run's memo. Your own words (mid-run guidance, answers to the AI's
  questions) and the record of actual edits are never cleared.
  (`packages/ai-sdk/src/orchestrator.ts` — `clearNotePayloads`,
  `compactAgentLog`)
- **Cheaper long AI runs via prompt-cache-stable prefixes.** The AI assistant
  now assembles each turn's prompt as a byte-stable prefix (contract + plan +
  loaded skill playbooks, in a fixed order) followed by the parts that
  genuinely change each turn (new guidance you send mid-run, the action log),
  and advertises its tools in a deterministic sorted order — so providers'
  prompt caching keeps working across the turns of a run instead of silently
  missing. No behavior change; golden byte-stability tests lock it in.
  (`packages/ai-sdk/src/orchestrator.ts`, `tool-registry.ts`)
- **Faster AI turns on read-heavy steps.** When the AI assistant makes several
  read/analysis calls in one step (reading the timeline, the transcript, and
  detecting silences, say), those now run in parallel against the engine
  instead of one after another — roughly 3× faster on a three-read step —
  while edits themselves still apply strictly one at a time, in order, exactly
  as before. Tunable via `FRAMEPILOT_MAX_TOOL_CONCURRENCY` (default 4). See
  ADR 0060. (`packages/ai-sdk/src/concurrency.ts`, `orchestrator.ts`,
  `tool-registry.ts`)

### Added
- **Token-friendly AI reads for long-form projects.** Three new read tools —
  `get_timeline_summary` (compact per-track overview: counts, spans, flags),
  `get_clips` (windowed by track/time, paginated compact rows), and `get_clip`
  (one clip in full detail) — plus an optional `start`/`end` window on
  `get_transcript`, so the AI can orient on an hour-long project without
  dumping every clip and word into context. Mirrored in the Python registry
  (parity-tested) and exposed over MCP automatically.
- **Python patch engine reaches operation parity with TS.** The engine's
  `Operation` union, apply/invert, and patch validator now cover the layer ops
  (`add_layer`/`remove_layer`/`move_layer`), `set_effect_params`, and the
  v5–v8 styling ops (`set_caption_style`, `set_clip_speed`, `set_clip_crop`,
  `set_clip_blend_mode`) — previously TS-only, so Python-side validation
  rejected patches the app accepted. All are reversible (apply→invert
  round-trip tested), and the validator gained the TS speed/duration
  invariant check plus `duplicate_layer`/`invalid_speed` error codes.
- **Precise, id-addressed delete and track tools.** `delete_clip` /
  `delete_clips` remove specific clips by id (optionally rippling the gap
  closed), deriving the exact time range in-process so the model can no longer
  fat-finger a hand-computed `delete_range` and take out half a track;
  `remove_track` / `move_track` expose the existing reversible
  `remove_layer` / `move_layer` operations to the AI. Batch ripple deletes are
  applied back-to-front so every range stays valid.
- **Animated timeline feedback for AI edits, undo, and redo.** When an edit
  commits, the touched clips flare with a short glow (AI-authored edits get a
  stronger ember halo; undo reads cooler and quieter) and clips shifted by a
  ripple glide to their new position instead of snapping. Derived purely from
  the edit history (`useEditPulse`), rendered with `framer-motion` (new
  web-editor dependency, MIT, license-scanned), scoped so drags and playback
  stay animation-free, and honours `prefers-reduced-motion`. See
  `plan/AI-EDIT-CONTINUITY-AND-MOTION.md` Part B.

### Fixed
- **Agent runs no longer "start over" by wiping the timeline.** A run that
  found partially-edited state could clear a whole track with one
  `ripple_delete` and rebuild from scratch — destroying prior accepted work and
  looping forever across runs. Two-layer fix: the agent contract now states the
  given timeline is the user's progress and must be continued, and a
  deterministic wipe guard (`packages/ai-sdk/src/wipe-guard.ts`) rejects any
  delete that would clear every clip on a multi-clip track of pre-run work,
  with a corrective note steering the model to targeted edits. The guard stands
  down when the user's own prompt asks for removal/reset, and never blocks
  narrow silence-removal ripples, single-clip deletes, or the run reworking
  clips it created itself. See `plan/AI-EDIT-CONTINUITY-AND-MOTION.md` Part A.
  The guard now also judges a call's deletes **in aggregate** (several narrow
  deletes that together clear a track are the same wipe as one wide range) and
  covers `remove_layer` (removing a populated track of pre-run work is
  rejected the same way, now that `remove_track` is an AI tool).
- **`FRAMEPILOT_SOUL_ROOT=~/.framepilot` (and other path env vars) now work.**
  The engine parsed path env values with a bare `Path(raw)`, so a literal `~`
  from `.env` became a *relative* path under the sidecar's cwd — the
  cross-project soul silently wrote to `<engine cwd>/~/.framepilot` territory
  (i.e. nowhere useful) and the user's `~/.framepilot` stayed empty.
  `Settings.from_env` now `expanduser()`s `FRAMEPILOT_PROJECTS_ROOT`,
  `FRAMEPILOT_EMBEDDINGS_MODEL_DIR`, and `FRAMEPILOT_SOUL_ROOT`.

### Removed
- **The dedicated "beat montage" tool and planner fast-path are gone.** Product
  decision to simplify the AI tool surface and reduce maintenance burden: the
  `synthesize_beat_montage` tool (TS `packages/ai-sdk/src/kernel/montage.ts` /
  `montage-leaves.ts` and the mirrored Python
  `engine/python/framepilot_engine/analysis/montage.py`), its `select_shots`
  model step in `plan-driver.ts`, and its planner-only leaf registry
  (`PLANNER_LEAVES`, now folded into `RECIPE_LEAVES`) have been removed. The
  live kernel planner (`Orchestrator.streamPlannedEdit`) no longer has a
  hardcoded montage shape — it plans any edit, montage-shaped or not, through
  the general `propose_edit` step over the same proven recipe primitives.
  `detect_beats`/`detect_scenes` and `buildBeatGrid` are unaffected: the model
  can still detect beats/scenes and build a cut-on-the-beat edit itself, it
  just no longer has a one-shot "build me a montage" shortcut.

### Added
- **The AI can add its own tracks now.** When it needs to stack things that can't
  share a lane — a title over your b-roll, a picture-in-picture, an extra overlay,
  a second music bed — and no existing track has room, it creates a new one and
  places the clip there, instead of giving up or piling everything onto one track.
- **The AI can ask you a question instead of guessing.** When it hits something
  only you can settle — a request that could go two ways, a look that depends on
  taste, something it genuinely cannot tell from the file — it now asks, right in
  the sidebar, and waits. You pick an option or type whatever you actually meant,
  and it carries on from your answer. The questions are written by the AI for the
  situation in front of it, not picked from a list we wrote, so it can ask about
  things nobody thought of in advance. You can also dismiss a question, which
  stops the run rather than letting it assume.
- **"Cut this to the beat" now lands on the beat.** A new step reads the track's
  tempo and places every clip so each cut falls exactly on a beat — you choose the
  shots, the order, and how often to cut (every bar keeps its energy; every single
  beat is exhausting), and the timing is exact rather than approximate.

- **The AI remembers what you told it — memory tiers & session context (plan
  B6).** FramePilot already recorded which edits you accepted and rejected, but
  only as a terse internal note the AI never really read back. Now:
  - **Rejecting an edit teaches it something.** Each accepted/rejected edit is
    also written as prose to `memory/decisions.md` / `memory/corrections.md`
    beside your project, each entry naming the exact edit it refers to. Nothing
    is invented: FramePilot records *that* you rejected an edit, never a guess
    at why.
  - **A new `session_context` tool** (AI panel + MCP) lets the AI pull up what
    it already knows about a project — your media, the last session, what you
    turned down, what you kept — instead of starting cold every time. Hosts can
    also inject a bounded digest straight into the AI's context, where it leads
    with what you rejected (repeating one of those is the costliest mistake) and
    yields to your timeline when context is tight.
  - **Preferences that follow you between projects.** When the *same* correction
    shows up in two different projects, FramePilot promotes it to a
    cross-project profile in `~/.framepilot/soul/` — one project disliking
    something stays that project's business. You can also say "remember this
    across projects" explicitly.
  - **Memory that cannot grow forever.** Each file is capped and trims the
    oldest entries first, always keeping the newest, and says so in the file
    when it has trimmed.
  Everything here is derived and rebuildable — your `project.fp.json` stays the
  single source of truth — and it degrades honestly with no engine sidecar
  connected (the browser build simply has no memory tiers). See
  [docs/guides/project-brain.md](docs/guides/project-brain.md).
  (`engine/python/framepilot_engine/brain/memory.py`, `brain/soul.py`,
  `service.py`, `packages/ai-sdk/src/memory-client.ts`, `brain-client.ts`,
  `context-builder.ts`, `tool-registry.ts`)
- **A warmer, safer, more resilient AI engine room (plan B5).** Several
  under-the-hood improvements to how the AI runs analysis:
  - **The brain warms itself when you open a project.** Opening a project now
    kicks off a quiet background analysis pass over your media, so the first
    "find where I said X" or "remove the silences" is instant instead of
    waiting on a cold engine. It never blocks the app, cancels itself when you
    open another project, and re-opens are near-free (already-analysed clips
    are cached).
  - **Long analyses no longer risk a timeout.** Analysing a whole bin of clips
    is now paced in small chunks across turns (`POST /analyze/batch`) instead
    of one long call, and the work is journaled so a crash/restart shows
    exactly where it left off (`GET /brain/jobs`) rather than silently losing
    it.
  - **A safety budget on AI analysis.** Each AI run now has a per-run cap on
    frames extracted, ffmpeg time, and transcription minutes, so a runaway
    request hits an honest, bounded stop instead of the compute wall.
  - **A whole AI edit collapses into one review/undo step.** Every patch from a
    single AI run now shares a run id, so a host can offer "undo the whole run"
    as one step (the per-step review still works too).
  - **The AI recovers from a failed analysis tool instead of giving up.** When
    one analysis step fails but nothing downstream depends on it, the run now
    routes around it and finishes honestly instead of failing the whole thing.
  See [docs/guides/project-brain.md](docs/guides/project-brain.md).
  (`engine/python/framepilot_engine/service.py`, `brain/store.py`,
  `packages/ai-sdk/src/kernel/cost/analysis-caps.ts`, `session-warmup.ts`,
  `kernel/plan-driver.ts`, `apps/desktop/electron/main.ts`)
- **The AI can now SEE your footage — the vision protocol (plan B4).** New
  `extract_frames` and `commit_vision` tools (AI panel + MCP) let the driving
  model look at real frames: `extract_frames` pulls stills (one per detected
  shot, a uniform grid, or exact timestamps), the model looks at them, and
  `commit_vision` records what each shows (labels, a face count, a description).
  FramePilot ships **no built-in computer vision** — the seeing is deferred to
  the AI that is already driving the edit, and observations are stored in the
  project brain with model provenance (a later human edit is never silently
  overwritten). To place an observation on the timeline, the AI follows up with
  `add_marker`. This supersedes the never-built `detect_faces`. See
  [docs/guides/vision-protocol.md](docs/guides/vision-protocol.md).
  (`engine/python/framepilot_engine/analysis/frames.py`, `service.py`,
  `packages/ai-sdk/src/tool-registry.ts`, `sidecar-executor.ts`,
  `packages/mcp-server/src/analysis-client.ts`)
- **Ask the AI for moments "like this one" — semantic similarity search (plan
  B3).** A new `find_similar` tool (AI panel + MCP) ranks your project by
  *meaning*, not just words: "find shots similar to the hook", "other moments
  where I talk about pricing". It blends embedding-based cosine similarity with
  the keyword search from B2 (weighted 0.6 semantic / 0.4 keyword) and returns
  the same typed, timeline-anchored hits as `search_media`. Embeddings are
  **opt-in and no model is bundled** — install the `embeddings` extra and point
  `FRAMEPILOT_EMBEDDINGS_MODEL_DIR` at an ONNX text embedder to enable semantic
  ranking; without it, `find_similar` degrades honestly to keyword-only and the
  result says which ranking ran. Embeddings are rebuilt alongside the search
  index on every save (`POST /brain/similar`). See
  [docs/guides/project-brain.md](docs/guides/project-brain.md).
  (`engine/python/framepilot_engine/brain/embeddings.py`, `brain/similar.py`,
  `service.py`, `packages/ai-sdk/src/tool-registry.ts`, `sidecar-executor.ts`,
  `packages/mcp-server/src/analysis-client.ts`)
- **Ask the AI "find where I said X" — indexed search over your project (plan
  B2).** The project brain now keeps FTS5 full-text indexes over the
  transcript (per-utterance, same segmentation the AI's timeline index uses)
  and markers, rebuilt from the canonical document on every save
  (`POST /brain/index`) and on demand at query time. A new `search_media`
  tool (AI panel + MCP) returns ranked, typed hits — transcript moments with
  timeline times, markers by label, asset-name matches enriched with their
  clip placements — instead of the AI re-reading the whole transcript.
  Queries are reduced to quoted FTS terms so search syntax can never be
  injected; builds without FTS5 degrade honestly to asset-name matches. The
  semantic timeline index also gains `loudness`/`black` slices fed from the
  brain's persisted analysis rows. (`engine/python/framepilot_engine/brain/fts.py`,
  `service.py`, `packages/ai-sdk/src/tool-registry.ts`, `sidecar-executor.ts`,
  `packages/mcp-server/src/analysis-client.ts`,
  `packages/ai-sdk/src/kernel/semantic-index/semantic-index.ts`)
- **The AI remembers what it learns about your media (plan B1).** Analysis is
  now a persisted substrate, not a per-session scratchpad: loudness (EBU R128),
  black-frame, and freeze detection join silence/scenes/beats as first-class
  analyzers; one `POST /analyze` route runs depth-tiered passes
  (`quick`/`standard`/`deep`); and every result is cached in the project brain
  keyed by the source file's content hash — re-running is instant, re-exporting
  the source honestly invalidates. The AI loop reads it back: agent runs start
  with the semantic index warmed from previous runs' results
  (`createAnalysisBagWarmer` → `OrchestratorOptions.warmAnalysis`), repeat
  analysis calls are served "(from project brain)" without re-running ffmpeg,
  and each pass regenerates `memory/bin_summary.md` — a small readable digest of
  every asset's duration, resolution, loudness, scenes, silence %, and opening
  transcript words. Everything degrades honestly when there is no sidecar or
  brain. See [docs/guides/project-brain.md](docs/guides/project-brain.md).
- **Project Brain (engine substrate, plan B0).** The Python sidecar now keeps a
  per-project `brain.sqlite` under `.framepilot-derived/<projectId>/` — a derived,
  rebuildable cache of everything analysis learns about your media (probes,
  content hashes, and soon persisted silence/scene/loudness results and
  transcript search). Media imports record into it automatically on desktop;
  provenance rules guarantee a value you set by hand is never silently
  overwritten by a tool or a model. New sidecar routes: `GET /brain/status`,
  `POST /brain/rebuild` (re-derives the database from its per-asset
  `analysis.json` sidecars, byte-identically). Deleting the derived directory
  remains safe — the project file stays the only source of truth. See
  [ADR 0058](docs/adr/0058-project-brain-derived-sqlite-substrate.md).
- **`deepseek` provider — DeepSeek's `deepseek-chat` and `deepseek-reasoner`.** A new AI
  provider behind the shared OpenAI-compatible adapter, so it streams and tool-calls exactly
  like the other providers. Add a `DEEPSEEK_API_KEY` in Settings → AI (or the env) and pick a
  model (defaults to `deepseek-chat`); `deepseek-reasoner`'s chain-of-thought is surfaced
  separately from its answer, same as the other reasoning models. See
  [docs/guides/ai-providers.md](docs/guides/ai-providers.md#deepseek-openai-compatible).
- **The AI agent now edits with the judgment of a senior editor, across the
  whole craft.** Fourteen new built-in playbooks cover the full professional
  workflow — prepping and logging footage, crafting hooks, cutting silence and
  filler without chop, caption design, color correction and grading, audio
  mixing, cut/transition grammar, vertical reframing, b-roll and layered
  compositing, beat-synced cutting, speed ramps, titles, long-form story
  structure, and a pre-export finishing pass. Ask for "make it cinematic" or
  "cut this to the music" and the agent follows the relevant playbook's
  professional taste rules instead of improvising.
- **The AI agent now comes with built-in editing playbooks ("skills") it
  consults before specialized work.** Ask for a punch-in or a tighter cut and
  the agent first loads an expert playbook — e.g. *keyframe-animation* (easing
  choices, subtle zoom ranges, timing moves to speech) or *short-form-pacing* —
  and follows it, instead of improvising. Skills are markdown files bundled
  with the SDK (`packages/ai-sdk/skills/`); only a one-line manifest sits in
  the agent's context and the full playbook loads on demand via the new
  `load_skill` tool, available identically in the desktop app, web editor, and
  MCP server. (ADR 0057)

### Changed
- **The AI panel reads like a feed, not a filing cabinet.** Each step is a
  compact row on a single thread, and — this is the part that matters — it now
  *shows what happened* instead of hiding it behind a box you had to open. Each row
  is a single status line; expanding it reveals the tool's actual output (the real
  result, not a repeat of the label), and the full details are still one click further.
- **"Plan first" moved out of the message bar into the AI panel header**, next to
  the apply-mode control, and your choice now sticks between sessions instead of
  resetting every time you reopen the app.

### Fixed
- **The AI no longer describes footage it cannot see.** It was being asked to
  look at your clips and report what was in them — but it never actually received
  the pictures, only their file paths. So it did the only thing it could: it made
  them up, and those invented descriptions were saved to the project and reused
  later. FramePilot now checks whether the AI model you have selected can really
  see images; if it cannot, it is not asked to, and it will ask you instead. If it
  can (Claude and Gemini can), nothing changes. **If you have been running the AI
  on your footage, anything it "saw" before this release was a guess.**
- **Still photos work with the AI again.** Asking it to look at a photo failed
  outright, so on a photo project it had nothing to work with at all.
- **A long AI request no longer gives up before it starts — or spins in circles.**
  Asking for something ambitious made it read the project, load its playbooks and
  study the music — exactly the right groundwork — and then stop, having decided it
  was going in circles, without making a single edit. The run no longer tries to
  guess the AI's intent or nag it into editing with escalating prompts (which never
  scaled and, worse, cut real runs off one turn too early). Instead it judges one
  plain fact: is the run still making progress? Reading something new, or attempting
  an edit, is progress; re-reading what it already has is not — and re-reading is now
  answered from memory ("you already have this") so it can't be mistaken for work.
  The run continues as long as it progresses and stops honestly the moment it stalls.
  It also can't promise a ten-step plan it only has room to half-finish.
- **Planning a full movie or documentary no longer runs out of room mid-plan.**
  The agent's turn/edit budget was sized for a single short-form ask ("trim this",
  "add captions") and cut long-form, many-scene plans off partway through — not
  because anything went wrong, just because it hit the ceiling. The budget is now
  sized for long-form work, and the run only stops on a genuine stall (repeatedly
  learning nothing new), which now takes noticeably longer to trigger.
### Changed
- **The AI now consults its editing playbooks automatically during agent runs.**
  The agent is instructed to load the matching expert playbook (pacing, hooks,
  captions, color, audio, reframing, transitions…) before specialized work and
  follow its professional taste rules, and its plans are ordered the way an
  editor works: structure first, then pacing, then polish. Under the hood every
  prompt the AI reads now lives in one audited module, so its editing voice
  stays consistent across chat, plan, edit, and agent modes.
- **Auto mode now applies each AI edit the moment it happens — no more waiting
  for the whole run to finish.** The agent proposes its edits step by step; with
  apply mode set to Auto, every validated step lands on your timeline instantly,
  and each step is its own Undo entry so you can peel back individual actions.
  In Manual mode you now review a stack of per-step edit cards (labeled
  "Step 1", "Step 2", …) with Accept/Reject per step plus Apply all — instead of
  one combined edit at the end. Anyone consuming the SDK event stream should
  note agent runs no longer emit a combined final diff; each applied turn emits
  its own `scope:'turn'` diff. (ADR 0056)

### Fixed
- **Agent mode no longer "reads the manual" forever and then changes nothing.**
  Ask for something ambitious — "re-edit this to a tighter beat sync" — and the
  AI would look up its editing playbooks over and over, narrate a confident
  ten-step plan, and finish with "No changes were made." It was not stalling or
  ignoring you: it only ever received about a third of each playbook, cut
  mid-sentence, so it kept asking for the rest until it ran out of turns. The AI
  now gets each playbook **in full**, and keeps it for the whole run instead of
  forgetting it a few steps later — so the turns it used to spend re-reading go
  into actually cutting your video. Long, multi-skill requests (beat sync +
  keyframes + colour + audio) are the ones that improve most.
- **Asking for frames "every N seconds" can no longer hang the analysis engine
  (plan B7).** Requesting a very fine spacing (say, every millisecond) made
  FramePilot plan every one of those moments before applying its own 16-frame
  limit — on a long clip that is billions of moments, and the engine would stop
  responding. It now spaces the frames out to fit the limit from the start. You
  could never have received more than 16 frames either way, so the only thing
  that changes is which moments get sampled.
  (`engine/python/framepilot_engine/analysis/frames.py`)
- **Derived project data stays out of version control.** `.framepilot-derived/`,
  `brain.sqlite`, and extracted frames (which are stills of your own footage) are
  now ignored explicitly rather than only incidentally — they were only covered
  while your projects lived in the default folder. (`.gitignore`)
- **You can now see what the AI is doing at a glance.** While a run is in flight
  the sidebar header shows a live shimmering status label ("Thinking…",
  "Running tool…", "Editing…") that tracks the agent's actual state — before,
  it was an unlabeled spinner, so a "thinking" agent looked stalled. The
  redundant little spinner next to the reasoning "Thinking…" text is gone too;
  the shimmer itself is the activity signal. (`AiSidebar`/`EventNode`)
- **The AI agent no longer claims edits it didn't make — and it fixes its own
  mistakes instead of giving up.** Previously a step could show a green checkmark
  ("Added text overlay…") and then the run would end with "No edits were applied —
  … Try rephrasing the request": edits were only checked at the end of a turn, and
  a rejected turn silently killed the run. Now every edit is validated the moment
  the agent proposes it — an impossible edit (say, two overlapping text layers on
  the same track) fails its own step with the actual reason, the valid edits still
  land, and the agent reads that reason and retries with a corrected edit instead
  of stopping. The agent is also now told up front that clips on one track can
  never overlap, so it stacks simultaneous overlays on separate tracks in the
  first place. (`packages/ai-sdk` orchestrator + conductor)
- **A failed AI step now offers Retry and Copy details right there, and its raw
  error text stays tucked away until you ask for it.** An error like "Render
  failed" used to just dump a technical detail block; it now shows a plain
  "Show details" toggle plus one-click **Retry** (the same retry the action bar
  already offered) when the step can be retried, and a **Copy details** button
  for sharing the exact error text. (`AiSidebar`/`EventNode`)
- **Reopening a chat now picks up exactly where you left it** — your unsent
  draft, which tool cards you had expanded, and your scroll position are
  restored instead of resetting to a blank conversation. (`AiSidebar`, using the
  already-persisted conversation UI state)
- **Screen readers no longer narrate scrolling as if it were new AI output.**
  The conversation list's live region used to announce every row that scrolled
  into view; now only genuinely new streamed replies are announced, and modals
  (tool details, the edit-preview popup) trap keyboard focus instead of letting
  Tab escape to the page behind them. (`AiSidebar`, `EventNode`, `DiffPreviewModal`)

### Changed
- **The AI copilot now understands what you actually asked.** In Agent mode, every
  request is read in full and routed intelligently instead of by keyword-matching. So
  "hi, add an intro using advanced keyframes and make it professional" now runs a real
  edit (the agent) instead of being mistaken for a canned action and replying "no changes
  were made." And a plain "hi" or a quick question gets a short, direct answer — no more
  spinning up a full plan for small talk. Commands you've saved as workflows still run
  instantly with zero AI cost. (`streamAuto` + the model command classifier; ADR 0055.)
- **The AI sidebar now narrates every step in editor language.** Newer actions that
  used to show data-model names ("Set clip blend mode", "Analyze silence") now read
  like an editor talking: "Finding silences in interview.mp4", "Reframing Intro.mp4",
  "Changed clip speed", "Styled captions", "Added marker". Analysis and styling steps
  name the clip or file they touch, and phrases never trail off when no clip is named.
  (`packages/ai-sdk/src/describe.ts`)

### Added
- **Project History panel — see and rewind every edit.** A new **History** button
  in the header (or ⌘⇧H) opens a right-side panel that lists every change you've
  made, end to end, as a scrubbable timeline. Each entry shows a plain-language
  label ("Trimmed clip", "Added captions") with the affected clip/track, whether
  **you** or the **AI** made it (and, for AI edits, the reason), and how long ago.
  Click any point to instantly jump the project back — or forward — to that state;
  the current point is marked and undone steps are shown dimmed so you always know
  where you are. Hovering an edit previews exactly what it changed (before → after).
  Undo, redo, and jump-to-start/latest live right in the panel, and **your history
  now survives closing and reopening the project.**
  (`apps/web-editor/src/components/HistoryPanel.tsx`,
  `packages/editor-core/src/history.ts`)

### Changed
- **New orange brand identity, everywhere.** FramePilot now uses its real logo
  mark (a filmstrip "F") and a warm orange accent in place of the placeholder
  violet-blue mark and indigo accent — the app icon, favicon, website, and
  editor all match. (`packages/ui/src/tokens.css`, `apps/website/src/app`,
  `apps/desktop/electron-builder.yml`)
- **Reorganized the timeline toolbar so every control has one clear home.**
  Tools (Selection/Blade), clip actions (Split/Delete/Ripple delete), Markers,
  Edit mode, and History are now grouped left-to-right by what they do, with
  Zoom out/in/**to fit** together on the right. The duplicate blade control and
  the duplicate Export button are gone — Add track now lives with the tracks
  (in the track-header gutter, with a Video/Audio choice), and a new **Snapping**
  toggle sits right in the toolbar instead of only in Settings. On a narrow
  window, the least-used groups tuck into a "⋯ More" menu instead of wrapping.
  (`apps/web-editor/src/components/Toolbar.tsx`,
  `apps/web-editor/src/components/TimelineView.tsx`)
- **Removed the "Timeline updated" pop-up after every edit.** With the new History
  panel keeping a permanent, reversible record of every change, the little toast
  that flashed after each edit was redundant — so it's gone. Error messages (for a
  change that couldn't be applied) still appear. (`apps/web-editor/src/components/Toasts.tsx`)
- **Redesigned header: a renameable project title and a labelled save status,
  replacing the ambiguous status dot.** Click the project name (or press F2) to
  rename it inline — Enter commits, Esc cancels. Next to it, a small dot-plus-word
  indicator now always says what's happening in plain language (**Saved**,
  **Unsaved**, **Saving…**, or **Couldn't save**, with the reason on hover) instead
  of a bare colored dot whose meaning had to be guessed. The transient "Saved to
  ~/…" text that used to briefly cover the project name after every Save/Open is
  gone — that feedback now lives entirely in the status indicator.
  (`apps/web-editor/src/components/Topbar.tsx`, `apps/web-editor/src/App.tsx`)
- **Timeline tooltips now explain what a control actually does, not just its
  name.** Hovering the razor, zoom, add-layer, track mute/hide/lock/solo
  controls, and every toolbar action (split, delete, ripple delete, marker,
  undo/redo, export) now shows a short plain-language line under the term —
  e.g. "Ripple delete" now also says it shifts later clips back to close the
  gap, and "Solo track" explains it's preview-only and doesn't touch your
  export. (`apps/web-editor/src/components/Tooltip.tsx`,
  `apps/web-editor/src/components/TimelineView.tsx`,
  `apps/web-editor/src/components/Toolbar.tsx`)

### Fixed
- **Still photos (JPEG/PNG/WebP) now show their picture again — in the media
  bin, the Source preview, and on the timeline.** ffprobe reports a photo as a
  single-frame video stream with a bogus ~0.04-second duration, and the import
  classifier keyed off that duration — so every imported photo was mislabelled a
  zero-length *video*. The timeline then chased per-frame filmstrip thumbnails
  (and a preview proxy) that are never generated for a still image, producing a
  flood of `fp-media request denied: ENOENT … /thumbs/thumb_000.png`, blank
  preview frames, and play-icon placeholders instead of the photo. The engine
  now classifies images on the container format, not duration
  (`MediaInfo.is_image`), so a photo imports as `image` with its own file as its
  thumbnail and no proxy. The editor is also hardened so an already-imported
  project renders correctly without re-importing: an image always previews from
  its own source (never a proxy), uses its own source as its bin thumbnail
  (ignoring any stale derived `thumb_*.png` pointer left by an older import), and
  is drawn as one tiled still on the timeline rather than a per-frame filmstrip.
  A photo's bin tile also no longer shows a play-triangle overlay or a `0:05`
  duration badge — a still is not playable and has no intrinsic duration (the
  `5s` is just the default length it takes when placed on the timeline).
  (`engine/python/framepilot_engine/media/probe.py`,
  `engine/python/framepilot_engine/service.py`,
  `apps/web-editor/src/editor/media.ts`,
  `apps/web-editor/src/editor/useAssetThumbnail.ts`,
  `apps/web-editor/src/editor/selectors.ts`)

### Changed
- **`POST /render` (final export) is now asynchronous, end to end (plan
  H1.3a+H1.3b, ADR 0050).** The route used to block the HTTP request until
  FFmpeg finished and return `200` with the completed (or failed) `RenderJob`.
  It now submits to the already-tested `RenderQueue`
  (`engine/python/framepilot_engine/render/queue.py`) and returns `202`
  immediately with `{ "jobId": "...", "status": "queued" }`. Poll
  `GET /render/jobs/{job_id}` for progress/result, or cancel with
  `POST /render/jobs/{job_id}/cancel` (idempotent no-op on an already-terminal
  job; `404` if unknown). This unblocks real mid-encode cancellation — a hung
  FFmpeg encode can now actually be killed instead of tying up the sidecar's
  only render slot. `POST /render/preview` is unchanged and still synchronous
  on purpose: previews are downscaled and short, and callers want an
  immediate result, not a job to poll. The export dialog now speaks this
  contract directly: exporting shows real **Queued → Rendering** status (no
  fabricated progress bar — the engine doesn't report a live percentage, only
  the coarse status) and a working **Cancel export** button.

### Fixed
- **Editing no longer freezes the experimental WebCodecs preview.** Every cut,
  trim, or delete used to reload and re-decode all of the timeline's media
  behind the scenes — a multi-second hang after each edit on real projects in
  the desktop app. The preview now keeps everything it already loaded and only
  reads media that is new to the timeline, so edits land instantly and
  playback picks right back up.
- **The experimental WebCodecs preview no longer lags on real camera footage.**
  Playing a timeline cut from original (unproxied) files — long-GOP, B-frame,
  high-resolution clips straight off a phone or camera — used to stutter and
  buffer, and clips could even show slightly wrong frames. The preview's
  decoder now streams ahead of the playhead instead of restarting for every
  few frames, and maps every frame by its exact timestamp, so rapid cuts,
  still images, a music track, and heavy scrubbing all play smoothly against
  real footage.

### Added
- **Timeline: duplicate clips and roll edits with Cmd/Ctrl-drag, plus audio fade
  handles.** Hold Cmd (Ctrl on Windows) while dragging a clip to drop a copy at
  the new spot instead of moving the original — the source clip never moves.
  Hold Cmd/Ctrl while dragging a trim handle on a cut where two clips touch to
  **roll the edit**: both clips' edges move together in one step, so the total
  length of the pair never changes. Audio clips now show small corner handles
  for fade-in/fade-out — drag them right on the timeline instead of opening the
  Inspector's Audio panel. (Alt is unchanged: it still inverts snapping while
  you drag.) (`apps/web-editor/src/components/TimelineView.tsx`,
  `apps/web-editor/src/editor/patch-builders.ts`)
- **New `lead-prompt-engineer` subagent** (`.agents/agents/claude/lead-prompt-engineer.md`,
  codex TOML + opencode entry, referenced from `CLAUDE.md` §8). Owns every string
  the model reads and every model-authored string the user sees — the system
  contract and context-builder prompt blocks (`packages/ai-sdk/src/context-builder.ts`),
  tool names/descriptions (TS registry + Python mirror + MCP parity), orchestrator
  mode instructions, and the model-layer copy streamed to the editor UI. WHY: prompt
  text was edited ad hoc across four surfaces with no owner enforcing the
  model/UI/customer audience split, determinism, or token/cache discipline; harness
  prompt patterns (Claude Code, Codex) are now applied for an audience of video
  editors rather than programmers. `CLAUDE.md` §8 also now lists the existing
  `performance-monitor`/`performance-optimizer` subagents it had missed.
- **A bigger, clearer AI edit-review popup.** The Review-changes popup is now a
  large comparison surface with **one shared playhead** — a single draggable
  scrubber (with jump-to-change buttons and change markers) that drives the
  before and after side by side at the same instant, instead of two separate
  transports. It uses a clear two-button **Keep / Remove** control per change (a
  check and a cross, instead of one toggle whose tooltip contradicted its icon),
  and its compare controls read in plain language ("Overlay", "Peek original",
  "Side by side") with tooltips that explain each. Clicking a clip, caption, or
  image chip in a suggested edit opens a read-only **before / after** preview for
  just that change. In the sidebar, a proposal's **Accept / Reject** now sit in a compact
  footer attached to the card (with **Show preview** and **Jump to timeline**),
  batch **Apply all / Reject all** move to the right, the context bar shows real
  rounded badges, and the composer gets a rounded send button — smaller, tighter,
  less busy.
- **Review an AI edit change-by-change before it touches your timeline.** The AI
  sidebar's **Show preview** now opens a **Review changes** popup: every change in
  the suggested edit is listed in plain language with the moment it happens
  (0:04, 0:08…), and you can **keep some and remove others** with a click. The
  before/after player shows exactly the changes you kept — and starts playing
  right where the edit lands, not back at 0:00 — so you see the difference
  instantly. Apply only what you kept and it commits as one clean edit you can
  Undo; **Jump to timeline** drops your playhead on the change. If a change you
  kept depends on one you removed, the popup tells you honestly instead of
  half-applying anything.
- **A calmer, editor-first AI sidebar.** The assistant now reads like a video
  editor's tool, not a developer console: no raw code, ids, or millisecond
  timings — steps read "instant" or "2s", the details view explains what
  happened in words (which clips, tracks, and files it touched), and edit cards
  speak plainly ("Suggested edit", "Can't apply this edit"). The conversation
  auto-scrolls as replies stream in but stays put the moment you scroll up to
  read something, and the "thinking" panel tidies itself away once the assistant
  is done.
- **Smoother multi-clip preview via an experimental WebCodecs compositor.** Turn
  on **Settings → Playback → WebCodecs preview (experimental)** to play a
  multi-clip montage as one continuous, frame-exact decode on a single canvas —
  no swap hitch at cuts — with transform, crop, color grade, blend mode, and
  text/caption overlays composited live and 9:16 (or any aspect) projects
  letterboxed like the export. If your media or GPU can't support it, the editor
  quietly falls back to the normal preview, so the switch is always safe to try.
  Off by default while it's polished; the deterministic export is unchanged.
- **Pin extra clips/assets as AI context with "@" (H1.5c).** Type `@` in the AI
  sidebar's composer to search your timeline clips and media-bin assets, and
  pick one to pin as extra context for your request — separate from (and in
  addition to) the "Selected" chip you already get from a live timeline
  selection. Each pin shows as its own removable chip, and you can pin as many
  as you like. Not included in this slice: pinning a raw time range, a marker,
  or a whole track by name — only individual clips and assets, for now.
- **A Source monitor, separate from the Program monitor (H1.7, J3 —
  source-vs-program split).** The center stage now has **Source | Program**
  tabs. Clicking an asset in the Media panel (not double-clicking — that still
  adds it straight to the timeline, unchanged) loads it into the new, read-only
  Source monitor and switches to it: its own transport (play/pause/frame-step/
  scrub), independent of the project timeline. You can mark an **in/out range**
  on the loaded clip (`I`/`O`, or the In/Out buttons) to preview a sub-range
  before deciding what to do with it — shown as a highlighted band on the
  scrubber. This is local, throwaway preview state: it never creates a clip,
  marker, or any project mutation, and switching back to Program leaves your
  edit exactly as it was. **Not included in this slice** (deferred, not
  dropped): inserting/overwriting the marked range onto the timeline,
  three-point editing, and gang/sync playback between the two monitors.
  (`apps/web-editor/src/components/SourceMonitor.tsx` (new),
  `components/Editor.tsx`, `components/MediaBin.tsx`.)
- **The program monitor now has a safe-area guides toggle (H1.7, J3).** A new
  button next to the existing rule-of-thirds grid toggle overlays broadcast-
  style action-safe (90% of frame) and title-safe (80% of frame) guide rects —
  pure CSS on the existing `.preview-frame`, so it works unchanged for both
  9:16 and 16:9 projects. Off by default, same persisted-preference pattern as
  the grid (`safeAreaGuidesByDefault` in Settings → Playback); also toggleable
  from the monitor toolbar. (`apps/web-editor/src/editor/useSettings.tsx`,
  `components/PreviewPlayer.tsx`, `components/SettingsDialog.tsx`,
  `styles.css`.)
- **AI review now offers side-by-side compare, next to the existing hold-to-
  compare toggle (H1.5, J3).** When reviewing a proposed AI edit, a new
  layout switch — "Hold to compare" / "Side by side" — lets you play or
  scrub before and after at the same time, in two panels, instead of holding
  a button to flip between them. Both panels always show the same instant;
  only the after (edited) panel plays audio, so you don't hear both at once.
  The existing hold-to-compare toggle is unchanged and still the default.
  Wipe compare (a single frame with a draggable before/after split line) is
  a natural next step planned as a follow-up, not included here.
  (`apps/web-editor/src/components/AiReviewPlayer.tsx`,
  `components/PreviewPlayer.tsx`, `components/PreviewAudioMixer.tsx`,
  `styles.css`.)
- **A large Agent-mode plan now pauses for your approval before it touches
  anything (P11.3 — plan-approval gate).** With **Plan first** on (the
  default), the assistant already drafts a numbered plan before it starts
  editing. Now, if that plan has more than 3 steps, the run stops right
  there and shows you the full plan with three choices: **Approve** (runs it
  exactly as drafted), **Edit request** (cancels the run — nothing was
  touched — and puts your original prompt back in the composer so you can
  refine it before trying again), or **Cancel** (stops outright, nothing
  touched). Small plans — the common "trim this," "add captions" asks —
  are never gated; only a plan bigger than the everyday case pauses for a
  look before it runs. Browser only for now: the desktop app's AI runs
  travel over IPC, which can't yet carry a live approve/cancel decision
  back to a paused run, so desktop keeps running plans of any size
  un-gated until that wiring lands. (`packages/ai-sdk/src/run-controls.ts`,
  `src/kernel/conductor.ts` — `PLAN_APPROVAL_STEP_THRESHOLD`,
  `src/orchestrator.ts`; `apps/web-editor/src/components/ai/
  PlanApprovalCard.tsx`, `components/ai/AiSidebar.tsx`. See
  `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P11.3/P12.4.)

- **You can now redirect a running Agent-mode task without stopping it
  (P11.4 — mid-run steering).** While the agent is working, a small input
  next to the running task lets you type extra guidance and send it —
  separate from the Stop button, and without waiting for the run to
  finish. Your message shows as "queued" until the agent reaches its next
  natural checkpoint (the same point where it already checks for Stop),
  at which point it folds your note into that step as an explicit
  instruction and confirms it in the conversation ("Steering applied:
  ..."). This is a next-checkpoint nudge, not an instant mid-step
  redirect — if you send a message while the agent is mid-tool-call, it
  waits for that call to finish before applying, then applies before the
  next step starts. Browser only for now, same IPC limitation as the
  plan-approval gate above. (`packages/ai-sdk/src/run-controls.ts`,
  `src/orchestrator.ts`; `apps/web-editor/src/components/ai/
  SteeringInput.tsx`, `components/ai/AiSidebar.tsx`. See
  `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P11.4/P12.5.)

- **Edit mode can now propose two alternative takes on the same request, and
  you pick one (H1.5 — variations / A-B compare).** A new "Show 2
  alternatives" toggle (Edit mode only, **off by default**) runs your request
  twice — two independent, real AI calls — and the review card gains a
  Take A / Take B switcher that re-points the same before/after preview at
  whichever candidate you're looking at. Accepting one discards the other; the
  card says so plainly, never leaving an orphaned pending take. Because a
  second take is a second real model call, this is opt-in and the usage chip
  shown after the run reflects the REAL combined cost of both calls, not just
  one — never hidden. Deterministic recipes (remove silences, add captions,
  fix pacing, punch in, …) never show this toggle: they produce the exact
  same result every time, so "variations" of one would just be the identical
  edit run twice — the toggle only appears for genuinely model-proposed edits.
  (`packages/ai-sdk/src/orchestrator.ts` — `editVariations`/
  `streamEditVariations`; `packages/ai-sdk/src/events.ts` — `DiffEvent.variants`;
  `apps/web-editor/src/components/ai/AiSidebar.tsx`,
  `components/ai/EventNode.tsx`. Browser only for this slice — see
  `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P13.1.)

- **The AI sidebar now uses your timeline selection as context, and understands
  more of an editor's language (H1.5c).** Selecting clips before asking for an
  edit ("tighten this", "make it punchier") now actually scopes the request —
  the composer shows a removable "Selected: N clips, S–Es" chip, and the
  selection is threaded into the AI's context so a large-project request can
  stay focused on the part you're looking at. Removing the chip means that
  turn's request skips it (your removal is respected, not silently undone).
  The deterministic recipe router also now recognizes a first slice of
  creative phrasing with zero AI calls — "make it punchier", "tighten this
  up", "snappier", "build energy" all route straight to the pacing recipe.
  Phrases that don't honestly match an existing recipe ("let it breathe",
  "cut to the reaction", "match the music") still fall through to full
  planning rather than being forced onto the wrong edit. **Not included yet**
  (separate follow-up): an "@" picker to pin specific clips/assets/ranges as
  context beyond the current selection. (`apps/web-editor/src/editor/
  selectors.ts`, `components/ai/AiSidebar.tsx`, `components/ai/Composer.tsx`,
  `ai/composerActions.ts`; `packages/ai-sdk/src/kernel/router.ts`.)

- **`⌘K` / `Ctrl+K` opens a quick command palette, and a clip's right-click
  menu can ask the AI about it directly (H1.5c second half).** With a clip
  selected, `⌘K` opens a palette whose free-text box sends your prompt as an
  edit request scoped to that selection — same request path the AI sidebar's
  composer already uses. Right-clicking a clip now also offers "Ask AI about
  this clip," which selects it and opens the same scoped palette (the
  click-a-moment-and-describe-it loop). With nothing selected, the palette
  says so plainly and offers to open the full AI sidebar instead of silently
  doing nothing. After a quick edit lands, the AI sidebar stays open on the
  same conversation so you can keep refining. **Not included yet**: scoping
  to a raw point in the timeline/preview player (rather than a whole clip).
  (`apps/web-editor/src/components/CommandPalette.tsx` (new),
  `components/ClipContextMenu.tsx`, `components/ai/AiSidebar.tsx`,
  `editor/shortcuts.ts`.)

- **The AI's parallel "planner" path now handles more requests, is honest when
  it can't, and self-checks with the same rigor as every other path
  (H1.6 — kernel half, AGENT-NATIVE P11.1/P11.2/P11.5/P11.6).** Previously the
  live planner path recognized exactly one plan shape (the beat-sync montage)
  before falling back to the standard agent loop; it now recognizes any plan
  built from that shape's primitives **plus** every deterministic recipe's
  proven building blocks (silence/caption/pacing/hook/punch-in/filler-cleanup
  synthesis), so more novel requests can run through it instead of quietly
  falling back. When it genuinely can't handle a request, that decision now
  carries a specific, inspectable reason internally (unparseable plan,
  unsupported task shape, etc.) rather than one generic notice — a step
  toward the fallback being explainable, not just silent (the reason isn't
  surfaced in the UI yet — that's a follow-up). Separately, recipes and the
  planner path now run the SAME real technical self-check every AI edit
  already ran on the sequential agent path (duration target, caption
  alignment, safe area, missing assets, export settings) before a patch is
  offered for review — not just "did the patch apply," but "does it actually
  hold up." This is a trust/consistency fix, not a new visible feature: no UI
  changed. (`packages/ai-sdk/src/kernel/montage-leaves.ts` — `PLANNER_LEAVES`;
  `src/orchestrator.ts` — `isRecognizedPlan`, `PlannerFallbackReason`;
  `src/kernel/plan-driver.ts`; `src/kernel/recipe-leaves.ts` — `verify`;
  `src/events.ts` — `NotificationEvent.reason`/`.detail`. Plan-approval UI for
  large autonomous edits and mid-run steering are separate, still-pending
  follow-ups — see `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P11.3/P11.4.)

- **Search your footage by what's said, not just by filename (H1.5/J4 —
  footage search v1).** The Media panel's search box now matches two things at
  once: asset names (partial/typo-tolerant, as before) and every word in your
  transcript. Type a word or phrase and see each spoken match with a few words
  of context and a timestamp; click a result to jump the playhead straight
  there, same as clicking a word in the Transcript panel. Matching is
  whole-word (so searching "cat" won't surface every "category"), and
  multi-word phrases ("thank you") match a run of consecutive words. Haven't
  transcribed yet? The panel says so plainly instead of showing a confusing
  empty list. (`apps/web-editor/src/editor/transcriptSearch.ts`,
  `MediaBin.tsx`.)

- **The Export dialog can now shape and even out your audio, not just clean it
  up.** Two new master-bus audio options join the existing Loudness/
  "Reduce background noise"/"Apply brick-wall limiter" controls: an **EQ
  preset** (Flat, Warm, Bright, or Voice clarity — each a sensible tone recipe
  for talking-head video) and an **"Even out volume" (voice compression)**
  checkbox that smooths out loud/quiet moments so your voice sits at a more
  consistent level. Both are optional, off by default, and combine with the
  existing audio options; no raw dials to fiddle with. (Engine: `RenderOptions.
  eq`/`.compression`, applied in the order de-noise → EQ → compression →
  loudness → limiter — see `plan/PLAN.md`'s H1.4 entry for the reasoning.)

- **Export presets are now named platforms — Reels, TikTok, Shorts, YouTube
  (plus Square) — each with a recommended loudness target.** The export
  dialog's preset picker used to list generic aspect-ratio names
  (`reels_9_16`, `square_1_1`, `linkedin_16_9`). It now lists the platforms
  creators actually target; picking one still sets the same resolution/aspect
  as before (Reels/TikTok/Shorts share 9:16 1080×1920; YouTube is 16:9
  1920×1080 — the same file that used to say "LinkedIn / YouTube" still
  exports fine for LinkedIn). Each preset also carries a recommended loudness
  default (-14 LUFS, the common streaming-platform convention) — the
  Loudness dropdown remains fully separate and user-overridable, this is just
  a sensible starting point per platform.

- **Clip speed, crop, and blend mode are now editable from the Inspector
  (plan H1.2, closing the last "no editor UI yet" gap on all three).** These
  three engine capabilities already rendered for real; they just had no way to
  set them. Now, with a clip selected: a **Speed** section sets a constant
  playback rate (presets 0.5x–4x, or a custom value); a **Crop** section sets
  a crop rect via x/y/width/height fields (numeric today — an on-canvas
  drag-to-crop is a tracked follow-up); and a **Blend mode** section picks
  from the engine's twelve compositing modes. Every change is one undoable
  edit, same as every other Inspector control. The live preview approximates
  crop and blend mode with native CSS (a rough "which region survives" mask
  for crop, `mix-blend-mode` for blend) — close, not pixel-exact; the
  deterministic result is always the real render. **Not yet included:**
  speed does not visually preview in the live monitor (the export/render is
  correct; only the on-screen scrub preview doesn't speed up yet) — a
  follow-up, tracked in `plan/PLAN.md` H1.2i.
- **Markers/chapters now persist end-to-end (schema v9, plan H1.2, C21 —
  follow-up to the schema-only slice below).** Pressing "M" at the playhead (or
  the toolbar's marker button) now builds a real, validated, undoable
  `add_marker`/`remove_marker` patch — through the same validate→apply→record
  pipeline as every other edit — instead of only touching local, non-persisted
  component state. `EditorState.markers`/`Project.markers` are now the same
  array; opening a project loads its markers, and Save/AI/undo/redo all see
  them. The timeline still shows a tick per marker, now reading real data and
  showing a labeled marker's ("chapter's") title as a tooltip. The Python
  engine's `Project` model gained a matching `markers: list[Marker]` field
  (schema parity restored, `SCHEMA_VERSION` 8→9 confirmed on the Python side).
  **Deferred, documented (not silent):** a click-to-rename affordance for
  promoting a marker to a titled chapter, and AI auto-chapter-generation from
  the transcript — both separate follow-ups; today's slice is add/remove +
  display, not a chapter-management UI.
- **Projects can now carry markers/chapters — schema + patch-engine capability
  only, no editor UI or AI tool yet (schema v9, plan H1.2).** The project
  schema's `Project.markers` is a new array of `{ id, time, label?, color? }`
  points on the timeline; a bare marker (no label) and a named "chapter" are
  the same shape (see ADR 0049 for why). New reversible `add_marker`/
  `remove_marker` project-scoped operations let one add/remove act as one
  undoable step (rather than replacing the whole marker list). **This is a
  foundation-layer capability only** — nothing is user-reachable yet; the
  existing preview-only marker ticks in the editor (`toggleMarker`) still
  don't persist, and the Python renderer/AI tool wiring are separate
  follow-ups (see `plan/PLAN.md` H1.2, ADR 0049).
- **Clips can now carry a compositing blend mode (multiply, screen, overlay,
  darken, lighten, and more) — schema + patch-engine capability only, no
  editor UI or render support yet (schema v8, plan H1.2).** The project
  schema's `Clip.blendMode` is an optional enum of twelve standard blend modes
  (chosen as the subset Pillow/NumPy per-channel arithmetic can realistically
  composite — see ADR 0048 for the full list and what was deliberately left
  out); absent (or `'normal'`) is today's unchanged alpha-over compositing. A
  new reversible `set_clip_blend_mode` timeline operation sets or clears a
  clip's blend mode, and is meaningful only on clips with something composited
  beneath them (e.g. an `overlay`-track clip) — documented, not schema-
  enforced, the same scoping `crop`/masks already use. **This is a
  foundation-layer capability only** — nothing is user-reachable yet; the
  Python renderer and editor UI wiring are separate follow-ups (see
  `plan/PLAN.md` H1.2, ADR 0048).
- **Clips can now carry a constant playback speed (2x, 0.5x slow-mo, etc.) —
  schema + patch-engine capability only, no editor UI or render support yet
  (schema v6, plan H1.2).** The project schema's `Clip.speed` is an optional
  constant playback rate; absent (or `1`) is today's unchanged 1:1 timeline/
  source-duration behavior. A new reversible `set_clip_speed` timeline
  operation recomputes a clip's timeline duration from its (untouched) source
  range and the new speed, and the patch validator now rejects any clip whose
  start/end/source-range/speed disagree. **This is a foundation-layer
  capability only** — nothing is user-reachable yet; the Python renderer and
  editor UI wiring are separate follow-ups (see `plan/PLAN.md` H1.2,
  ADR 0046).
- **Render engine can now actually composite a clip's blend mode (multiply,
  screen, overlay, darken, lighten, and more) — engine capability only, no
  editor UI yet (schema v8, plan H1.2).** The Python renderer mirrors the
  project schema's `Clip.blendMode` (bumped from the schema-only slice above)
  and applies it: a clip's picture is now blended against whatever is
  composited beneath it (e.g. an `overlay`-track clip over a base video
  track) using standard per-channel blend-mode math, still respecting the
  clip's own opacity/mask; a clip with no `blendMode` (or `'normal'`) renders
  exactly as before (byte-identical), and a clip with nothing beneath it (e.g.
  the sole clip on a base video track) is a documented no-op, not a crash.
  **This is still an engine/render capability only** — there is no editor UI
  to set a clip's blend mode, so nothing is user-reachable from this change
  alone; wiring the Inspector UI is a separate follow-up (`plan/PLAN.md`
  H1.2, ADR 0048).
- **Render engine can now actually time-remap a clip's constant playback
  speed — engine capability only, no editor UI yet (schema v6, plan H1.2).**
  The Python renderer mirrors the project schema's `Clip.speed` (bumped from
  the schema-only slice above) and applies it: a 2x-speed clip's footage
  plays back in half the timeline time, a 0.5x slow-mo clip stretches across
  twice the time, and a clip with no `speed` renders exactly as before
  (byte-identical). Sped-up/slowed-down audio is time-remapped along with the
  picture, which — a known, documented tradeoff — pitch-shifts it (no
  pitch-preserving time-stretch exists in this codebase yet); see ADR 0046's
  addendum. **This is still an engine/render capability only** — there is no
  editor UI to set a clip's speed, so nothing is user-reachable from this
  change alone; wiring the Inspector UI is a separate follow-up (`plan/PLAN.md`
  H1.2).
- **Render engine can now actually crop a clip to a rectangular window into its
  source frame — engine capability only, no editor UI yet (schema v7, plan
  H1.2).** The Python renderer mirrors the project schema's `Clip.crop`
  (fractions 0..1 of the source frame, matching the existing mask-bounds
  convention) and applies it via MoviePy's crop effect before any scale/
  transform/mask, so a cropped clip's mask geometry and letterbox fit are
  computed against the cropped frame, not the original one; a clip with no
  `crop` renders exactly as before (byte-identical). **This is still an
  engine/render capability only** — there is no editor UI to set a clip's
  crop, so nothing is user-reachable from this change alone; wiring the
  Inspector UI is a separate follow-up (`plan/PLAN.md` H1.2, ADR 0047).
- **Style your captions — font, color, outline, position, and a one-click
  preset — and it's saved with your project, undoable like any edit (plan
  H1.1, now fully end-to-end).** The Captions panel's template gallery, size
  slider, color swatches, and position buttons now edit the currently
  **selected** caption (click a caption in the list to select it) instead of
  only driving a live preview: each change applies immediately as a real,
  undoable timeline edit, and every caption remembers its own style. Selecting
  a different caption — or none — re-syncs the controls to what that caption
  actually has, so the panel never shows a stale style. This finishes the
  engine-only capability shipped earlier (see below): the render engine
  already knew how to burn styled captions, and now the editor UI can actually
  author them.
- **Render engine can now burn styled/animated ("karaoke") captions — engine
  capability only, no editor UI yet (schema v5, plan H1.1).** The project
  schema's `Clip.captionStyle` (font family/scale, text/outline color,
  top/middle/bottom position, a preset lookup mirroring the editor's built-in
  caption templates, and per-word `pop`/`karaoke-fill` highlight timed off the
  transcript) is now mirrored on the Python engine side and actually rendered:
  a caption clip with a `captionStyle` burns in with real color/outline/
  position, and one with word-highlight enabled animates the active spoken
  word per frame. A caption clip with no `captionStyle` still renders exactly
  as before (byte-identical), so no existing project's export changes.
  **This is an engine/render capability only** — the caption editor UI does
  not yet expose any way to set a `captionStyle` from the app, so nothing is
  user-reachable from this change alone; wiring the UI to author styles is a
  separate follow-up (see `plan/PLAN.md` H1.1, ADR 0045, ADR 0011).
- **Export now asks where to save the video, instead of always saving it to a
  fixed folder.** As soon as an export finishes rendering, a native Save dialog
  opens so you can pick the destination and file name yourself; if you dismiss
  it, the render is still safe and a **Save As…** button appears so you can
  save it anywhere afterwards. Nothing changed about how (or where) the engine
  itself renders — it still renders into the project's own folder first — this
  just adds the missing step of copying the finished file to wherever you
  actually want it.
- **See what an AI edit actually changes before you accept it (plan H1.5/J3).**
  A proposed edit's diff card in the AI sidebar now has a **Show preview** toggle
  that plays a real before/after video comparison — the same HTML-video preview
  the live editor uses, not a separate render — instead of leaving you to accept
  or reject an edit from an op summary alone. Hold the **Hold for before** button
  (or the `b` key) to see the original at the same playhead position; release to
  spring back to *after*, with a persistent Before/After pill so you always know
  which one you're looking at. Scrubber tick marks show exactly where the edit
  touched the timeline, and the player auto-seeks to the first changed region on
  open. An **Approximate** badge appears when a clip's before/after duration
  differs at your current playhead, so the comparison never overclaims precision
  it doesn't have; edits without a computed diff keep the old disabled Preview
  stub rather than a misleading toggle. Accept/Reject/Jump-to-timeline are
  unchanged — the preview is strictly read-only and can never itself modify your
  project.
- **Solo a track to hear it by itself (plan J2/H0.4).** Every track header now
  has a headphones button next to mute/lock/hide: click it to solo that track
  — every other track goes quiet in the preview while you listen, and clicking
  again (or soloing a different track) brings everything back. It's just for
  listening as you work: soloing never touches your project file, never shows
  up in undo/redo, and never changes what actually gets exported — if a track
  is soloed and you close without un-soloing, nothing about your edit changed.
  Soloing a track also lets you hear it even if you'd separately muted it, so
  you can quickly check a muted track without unmuting it first. The rest of
  the timeline's look was also checked against the design refresh below and
  found already consistent — dark mode is unaffected either way.
- **Light theme, and the workspace panels got a behind-the-scenes rebuild (plan
  J1/H0.4).** Settings → Display now has a **Theme** control (System / Light /
  Dark) — System follows your OS, and the choice sticks across sessions. Every
  color in the editor (panels, timeline, clips, buttons, text) now has a proper
  light counterpart designed to match the same visual hierarchy as dark mode —
  surfaces still step from base to elevated, text still fades from primary to
  muted, one accent color for actions/selection — instead of just inverting
  dark mode. The video preview stays a neutral dark surround in both themes
  (standard practice in professional editors, so footage/skin tones are never
  judged against a bright white background). Dark mode itself is unchanged
  pixel-for-pixel — nothing about today's look moves. Separately, the
  resizable/collapsible side panels and the timeline dock — drag to resize,
  collapse to a thin strip and back, remembered the way you left them — now
  run on a shared, more maintainable component internally; every drag,
  collapse, and expand behaves exactly as before (verified against the full
  existing test suite, including the end-to-end browser tests), it's just
  built to last as we keep rebuilding the rest of the editor's look (the
  timeline is next).
- **Perceived-latency + parallel "what's running" view (plan P8.1/P8.2).** The AI
  sidebar's event pipeline already computed a `view.tasks` field (folded from
  `task_started`/`task_finished`/`effect_progress`) so the UI could show several
  running DAG tasks at once, but no component read it. A new `TaskRunView`
  component renders `view.tasks` as simultaneous cards grouped by running vs.
  settled — two tasks that are both mid-flight (e.g. finding beats and finding
  scenes) now render side-by-side as visibly concurrent instead of a misleading
  sequential list, with settled tasks folding into a quieter trailing row.
  Mounted in `AiSidebar` as a strictly additive affordance: it renders nothing on
  every run today (no live driver emits `task_started` yet), so every existing
  sidebar behavior — tool cards, plan checklist, diff review, history,
  resume/retry — is unchanged. Also confirmed (with a new regression test, no
  code change needed) that the run indicator already appears within one frame of
  hitting Send, before the model resolves anything: every streaming method
  emits its first status update before any `await`, and the sidebar's
  frame-coalescing batcher delivers it on the very next animation frame. See
  `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P8.1/P8.2 (P8.3–P8.7 — prefetch, Cmd+K,
  preview-first review, apply-as-you-go, context chips — remain deferred).
- **Runs are now priced, replayable, and recovery-aware (plan P7.1/P7.2/P7.3/P7.4).**
  `cost-meter.ts`, `replay.ts`, and `recovery.ts` were built and unit-tested but had zero
  live callers — every real run priced $0 and could not be replayed or recovered except
  ad-hoc. `AiResponse.usage` is now populated by every provider whose response actually
  reports a real token count (never fabricated for providers that don't); a recipe run's
  cost is asserted **exactly** `{tokens: 0, usd: 0}` (it has no model tasks), while a
  planner/agent run prices real usage, including a rejected/retried model attempt, not
  just the winner. The sidebar surfaces this in **creator language only** (lens §2.5.6):
  a new "Instant · no AI needed" / "AI edits used this session" chip replaces the old
  coder-brained "Recipe · 0 tokens" one; raw token/$ numbers appear **only** behind a new,
  off-by-default "Show AI usage details" toggle (Settings → AI → Routing). `Orchestrator`
  gained an opt-in `recordEffects` option (off by default): when set, a
  `streamRecipe`/`streamPlannedEdit` run's effects are captured via
  `createRecordingEffectRuntime` and handed to a caller-supplied `onRecording`, provably
  replayable afterward via `createReplayEffectRuntime` with **zero** provider/host calls (a
  new determinism regression test proves this end to end). `plan-driver.ts`'s model tasks
  now catch a thrown model-effect error (previously an unhandled crash) and consult
  `recoveryFor`'s saga recovery table for retry-with-backoff, falling back to an honest
  failure once the table's own retry budget is exhausted — the table is the source of
  truth for this decision now, not a hardcoded loop. NOTE: the plan's example phrasing "AI
  edits used this month / on your plan" became **session-scoped** wording — there is no
  real plan/billing/quota concept in this codebase, so a monthly-limit framing would itself
  be a fabricated number. See `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P7.1–P7.4 (P7.5, a
  tracer/telemetry dev panel, is explicitly deferred).
- **Analysis-engine reachability + graceful offline degradation (plan P5.1/P5.2/P5.3).**
  An unset `VITE_FRAMEPILOT_PYTHON_API_URL` used to silently disable `analyze_silence`/
  `detect_scenes`/`detect_beats` in the browser dev server with no indication why. Adds
  `apps/web-editor/.env.example` documenting the var (defaults to the desktop app's own
  `127.0.0.1:8765`), a dev-mode-only console warning when it's unset, and a new
  `EngineStatusChip` in the AI sidebar that probes the sidecar's `/health` on mount and on
  window focus and shows unknown/reachable/unreachable *before* you ask for a beat-sync
  montage — pairing with the existing "model not ready" banner. Settings now labels
  **Ollama** "Offline · no network required" so it reads as the first-class offline model
  option it already was (Ollama is a model provider only; analysis still needs the sidecar
  — never routed to Ollama). See `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P5.1/P5.2/P5.3.
- **Semantic Index ingests real analysis + structured slice retrieval (plan P4.1/P4.2).**
  `buildSemanticIndex`/`semanticIndexFor` now accept an optional analysis-results bag and
  map a real `detect_scenes` → `shots`, `analyze_silence` → `silences`, `detect_beats` →
  `beats`, translated from the analyzed asset's source-media time into timeline time
  through every clip that actually places it — an unplaced asset honestly contributes
  nothing, never a fabricated placement. The index is now cached per (project snapshot,
  analysis-bag) pair, not just per project. A new `getSlice(index, { timeRange?, layerId?,
  kinds? })` (`kernel/semantic-index/semantic-index-slice.ts`) filters the index down to
  what one step needs ("dialogue 12–18s", "the beat grid"); `EditProposer`'s `slice` field
  is now real sliced data — this run's own already-completed analyses, scoped by an
  optional `timeRange`/`layerId`/`kinds` on the plan step — instead of an ad hoc single
  upstream value, and the Planner's request also carries the real project-derived slice
  alongside its existing cardinality summary. Closes P3.1's known gap: a live proposer can
  finally reason over concrete, already-detected shots/beats, not just bare counts. See
  `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P4.1/P4.2.
- **Transcription (ASR) — the AI gains hearing (plan H0.1).** `transcript` was previously
  populated only externally; nothing produced it. Adds a local-first, configurable speech-to-text
  path: `framepilot_engine/audio/asr.py` shells out to a local `whisper-cli` (whisper.cpp)
  binary for real, per-word timestamps (never fabricated), with explicit `base.en` model setup
  (`framepilot setup-asr` / `POST /asr/setup`, SHA256-verified) and a content-hash transcription
  cache; a new reversible `set_transcript` editor-core operation; an `ai-sdk` ASR provider
  abstraction (`LocalWhisperCliClient` default, opt-in hosted `GroqTranscriptionProvider` — sends
  audio off-device, disclosed) and a `transcribe` AI tool (TS + Python mirror); a minimal
  Settings → AI → Providers → "Whisper / Speech-to-text" section (provider picker, local model
  status + Set up action, hosted off-device disclosure). Wiring `transcribe` to auto-run on
  import is a follow-up. See `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H0.1.
- **Model-tier routing, live (plan H0.3 / P3.4).** Model calls now dispatch per
  declared proposer tier instead of always calling one injected provider:
  `IntentParser`/`Critic` run on the small tier, `Planner`/`EditProposer` on mid,
  once a tier is explicitly configured (Settings override or a
  `FRAMEPILOT_TIER_*_PROVIDER`/`_MODEL` env var). Undialed deployments keep
  today's exact behavior — every tier collapses to the single configured
  provider, never a silently-constructed unconfigured client, never a hard
  failure. See `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P3.4.
- **`groq` provider — fast open-weight inference via Groq.** A new AI provider (Llama,
  GPT-OSS, Kimi, … on Groq's LPU hardware) behind the shared OpenAI-compatible adapter, so
  it streams and tool-calls exactly like the other providers. Add a `GROQ_API_KEY` in
  Settings → AI (or the env) and pick a model (defaults to `llama-3.3-70b-versatile`). See
  [docs/guides/ai-providers.md](docs/guides/ai-providers.md#groq-openai-compatible).
- **`list_assets` AI/MCP tool — a focused read of the media bin.** Returns the project's
  `{ assets, folders }`, optionally filtered by `kind` (video/audio/image) and/or
  `folderId`. A cheaper, targeted alternative to `get_project_state` when an agent only
  needs the media library. Registered in the canonical tool registry (TS + Python mirror),
  so it is advertised over MCP automatically. See
  [docs/api/ai-tools.md](docs/api/ai-tools.md).
- **`google` provider — Google Gemini Developer API (AI Studio).** Reaches Gemini over the
  native Gemini REST endpoint via raw `fetch` (no vendor SDK), authenticated with a pasted
  `GOOGLE_API_KEY` in the `x-goog-api-key` header; streams and tool-calls like the other
  providers. Optional `GOOGLE_BASE_URL` overrides the endpoint. Defaults to
  `gemini-2.5-flash`. See
  [docs/guides/ai-providers.md](docs/guides/ai-providers.md#google-gemini-developer-api--ai-studio).

### Changed
- **AI runs are no longer bounded by a clock.** The 60-second connect timeout, the
  180-second idle timeout, and the desktop's 30-minute per-run cap are all disabled by
  default. A run against a slow or remote backend — e.g. a self-hosted Ollama reached
  over an ngrok tunnel, or a large local model that loads cold — can now take many
  minutes to first response and run for over an hour without being aborted. A run ends
  only when the model/transport finishes, a real connection error occurs, or you press
  **Stop**. (A dead socket no longer self-heals on a timer, so use Stop to cancel a run
  that is genuinely stuck.)

### Fixed
- **Exporting a video no longer fails with a 500 error after the render
  actually finishes.** The engine's completion log line referenced a field
  (`status`) that doesn't exist on a render job (it's `state`) — this crashed
  the request right after your video had already rendered successfully, so
  every export was reported as a failure even though the file was fine.
- **The AI editor no longer invents media that isn't there.** When your project had more
  than a couple of clips in the media bin, the assistant would sometimes try to add clips
  that pointed at made-up files (you'd see a wall of "Unknown asset" rejections and no
  edit). The cause: after the assistant looked up your media list, we were only handing it
  back the first couple of hundred characters of that list — so it never actually saw most
  of your files' real names and guessed at them. It now receives the complete list of your
  media (and timeline) ids every time it looks, so it references real clips instead of
  guessing, and long libraries are summarized honestly ("300 shown, 100 more — narrow your
  search") instead of being silently cut off.
- **Clicking "Set up" for the local Whisper model no longer shows a raw "Method Not
  Allowed" error.** The local engine wasn't answering the browser's preflight request
  correctly, which is what caused the error. If the local Whisper program still isn't
  installed on your machine, or setup still doesn't succeed, you'll now see a popup
  explaining why with a link to a new step-by-step setup guide, instead of a bare error.
  External links (like that guide) now correctly open in your default browser.
- **LUT color grades now actually apply at render time.** An `apply_color_grade` patch with
  `type: "lut"` validated and applied to the timeline, but the render compiler never loaded
  or applied the referenced `.cube` file — the pure LUT parser/applier existed
  (`render/color.py`) but nothing called it. A `lut` effect's `path` param is now
  sandbox-resolved against the project directory (same sandbox every asset path already
  resolves against) and applied via trilinear interpolation per frame; a missing/invalid file
  or a path escaping the sandbox raises a clear, typed `CompileError` instead of silently
  rendering ungraded. Proven by a new golden test that renders a red source through an
  inverting LUT and checks the output is cyan.
- **Text/title overlays now actually render.** `add_text_overlay` clips validated and applied
  to the timeline (they survived save/undo) but the render compiler silently skipped every
  clip of kind `text` — an edit that "applied" without ever rendering. The compiler now burns
  the overlay's authored text into the export, centered in the frame, via a new
  `framepilot_engine/render/text_overlay.py` renderer (honors optional `fontSize`/`color`
  params for a future style UI). Proven by a new golden test that renders with and without an
  overlay and diffs the frame.
- **Drag-select on the timeline now works from anywhere empty.** Dragging a rubber-band box
  over clips (like selecting files on Windows/macOS) did nothing in a real project: the
  marquee only started on the `.tracks` background, which is exactly as wide as its clips and
  fully covered by them — so there was no empty pixel left to grab. The gesture now lives on
  the full-width lane viewport, so a band-select can start from any empty space (right of the
  clips, an empty lane, below the last track) and drag across clips to select them, then
  delete or drag the whole group as one. Clicking a clip, seeking on the ruler, and dragging
  a single clip are unchanged.
- **Reasoning models no longer dump raw `<think>` chatter into the answer.** With a
  reasoning model (DeepSeek-R1 and friends via Groq, GitHub Models, OpenRouter, NVIDIA, or
  Ollama), the model's chain-of-thought was landing inside the assistant reply as an
  unformatted wall of text — sometimes with a literal `<think>…</think>` tag on screen —
  which also stopped the real answer from rendering as clean Markdown. FramePilot now
  separates a model's thinking from its answer at the source: a dedicated
  `reasoning_content`/`reasoning` field, an inline `<think>` block (even when the tag is
  split across streamed chunks), and Anthropic extended-thinking all flow into the
  collapsible **"Thinking…" / "Thought for Ns"** panel, while the reply itself stays clean,
  properly-formatted Markdown.
- **Preview playback no longer hitches at every cut.** Jumping between clips could hold
  the picture on a single frame for a few milliseconds at each cut — a stutter felt even
  when clips were far apart. The program monitor already pre-loads upcoming clips into a
  pool of `<video>` elements, but the incoming element was still *paused* at the moment of
  the cut, and the browser's `play()` takes a frame or two to spin its decoder back up —
  painting a static frame in the meantime. The monitor now **pre-rolls** the next clip:
  shortly before a cut it starts that element playing (silent, off-screen) and seeks it
  back so it reaches its in-point exactly at the cut, so the swap lands on an
  already-moving picture with no freeze and no skipped or repeated frames. Clips whose
  source begins at 0 (untrimmed) have nothing to seek back into and are unaffected — the
  remaining case a future decode-ahead compositor would close.
- **Agent mode no longer spins on analysis without ever editing.** When a request
  (e.g. "build a 75-image montage beat-synced to 15s") sent the agent to inspect and
  analyze the project, it could keep calling read-only tools turn after turn —
  re-running the same analysis with a slightly different argument each time (e.g.
  `detect_beats` at a new sensitivity) — and finish the whole run having placed no
  clips. The loop's spin guard only caught a call repeated *verbatim*, so varying an
  argument defeated it. Two root fixes, applied to both the streaming and non-streaming
  agent paths: (1) the run now stops after a bounded number of consecutive no-edit
  turns, and (2) once the model has inspected/analyzed, the per-turn instruction
  escalates to require a timeline edit and forbid further analysis (its results are
  already in the action log). An agent asked to build a montage now commits to placing
  the clips instead of endlessly gathering data.
- **Ollama could not be selected on desktop** (`Invalid AI provider: ollama`). The
  main-process request validator kept its own provider list that hadn't been updated,
  so it rejected Ollama runs before they reached the provider. Fixed, with a test that
  guards the full provider roster against future drift.
- **The agent's plan is a clean checklist again — its narration stays in the
  chat** (agent-native UX, Phase C1). When the assistant drafted an up-front plan,
  its intro sentence and any "Would you like me to proceed?" question were being
  turned into todo rows, so the checklist read as a mix of steps and prose and the
  run could stall on a question buried in the list. The plan draft is now split at
  its source: only the concrete numbered edits become the todo ledger, while the
  intro and any question are surfaced as a normal chat message you can answer.
- **The AI sidebar now tells you when a run changed nothing** (orchestration
  kernel, K4.1). A request the assistant only *read and planned* — or one that
  needs the analysis engine (silence/scene/beat detection) that isn't reachable
  in the browser — used to end on a green "Self-check: Passed" even though the
  timeline was untouched. Editing runs that apply no edit now end with an honest
  note explaining why (rephrase, or run the desktop app / configure the Python
  sidecar). Read-only questions asked in Agent mode are answered directly instead
  of driving the full agent loop.

### Added
- **Run FramePilot's AI locally with Ollama.** Ollama joins the provider list in
  Settings → AI, alongside a **Server URL** field (defaults to
  `http://localhost:11434/v1`) so you can point at any local or remote daemon, and a
  model field (defaults to `llama3.2`). No API key is required for a local server —
  Ollama shows as **Ready** immediately; the optional key is only for a
  remote/proxied daemon. Works on both desktop and the browser dev build, over the
  same OpenAI-compatible streaming path as the other providers.
- **The professional-editing verbs now run deterministically, end to end — no
  model call** (orchestration kernel, AGENT-NATIVE-COMPLETION-PLAN P1–P2). The
  recipes are live: a recognised command compiles to a task graph and executes on
  the kernel with **zero tokens**, instant and reviewable, instead of driving the
  LLM agent loop — with a subtle "Recipe · 0 tokens" chip so the win is visible.
  **Remove silence** detects the gaps with the engine and ripple-deletes them;
  **add captions** turns the transcript into a caption layer; **improve pacing**
  cuts the detected dead air; **add hook** trims the dead lead-in so the video
  opens on the first word; **punch in** adds an animated zoom. Every edit is
  validated and fully reversible (Undo restores exactly). **Export for Reels**
  routes to the Export dialog (a render, not a timeline edit). Runs on both the
  browser (with the Python sidecar) and the desktop app; when the analysis engine
  isn't reachable a run makes no edit and says why, rather than pretending it
  worked.
- **Configurable model-tier routing — now in the UI** (orchestration kernel,
  ADR 0043). The AI kernel routes cheap roles to a small model, composition to a
  mid model, and reserves the frontier tier for genuine need. Each tier's
  provider + model is now editable in **Settings → AI → Model tiers** (a picker +
  model field per tier), so you can retune cost and speed without touching a
  config file. An in-app override wins over the environment override
  (`FRAMEPILOT_TIER_{SMALL,MID,LARGE}_{PROVIDER,MODEL}`), which wins over the
  built-in default — each field resolved independently, and an unrecognised
  provider is ignored rather than crashing the AI path. See
  [ai-providers.md](docs/guides/ai-providers.md).
- **Beat-synced montages now run on a live, parallel planning path** (orchestration
  kernel, AGENT-NATIVE-COMPLETION-PLAN P3.1). A request like "make a montage cut
  to the beat" now runs beat detection and shot detection **at the same time**
  instead of one after another, picks up the strongest shots with one focused
  model decision, and lands every cut exactly on a beat — deterministically, with
  the model consulted a small, bounded number of times rather than once per step
  of a long back-and-forth. Other requests keep working exactly as before; this
  new path only engages in Agent mode for a request it fully recognises, and
  quietly falls back to the existing assistant otherwise.
- **The fast planning path now handles more than montages** (orchestration
  kernel, AGENT-NATIVE-COMPLETION-PLAN P3.2). The live planning path from above
  no longer recognises just one scenario — any request Agent mode can break into
  known steps (an analysis, one focused edit decision, and a review) now runs
  through the same fast, bounded-model-call path instead of the longer
  back-and-forth loop. Anything it doesn't yet recognise still falls back
  exactly as before, so nothing regresses.
- **The router recognises more editing verbs deterministically** (orchestration
  kernel, ADR 0043). The zero-token classifier recognises **remove silence**,
  **add captions**, **improve pacing**, **add hook**, **punch in**, and **export
  for Reels** and routes each to its recipe with no model call — with natural
  phrasing and parameters understood (e.g. "aggressively tighten the pacing",
  "punch in 1.5x", "export a 1:1 square version"). These now *execute*
  deterministically too (see the recipe entry above).
- **Cost meter for AI runs** (orchestration kernel, ADR 0043). Each model call is
  priced by the tier it ran on and tallied into a per-run ledger (tokens, dollars,
  and where the spend went by tier), and the scheduler can now enforce a **dollar
  budget** for a run in addition to task/token caps — the groundwork for keeping
  agent runs inside a predictable spend.
- **Cross-project memory, editable in Settings → Memory** (orchestration kernel,
  redesign §16.1, K5.1/K5.1b; ADR 0044). The AI's memory is split into scopes with
  the right lifetimes: what *this* project has learned (unchanged), plus new **user**
  memory — cross-project editorial defaults (target audience, brand/caption style,
  preferred pacing, favourite export platforms) a new project inherits and can override
  per field — and **workflow** memory. Edit these in a new **Settings → Memory** panel;
  they follow you across projects and are threaded into the model on both the browser and
  desktop builds. Stored locally (no secrets, no network).
- **Save a run as a recipe — "get cheaper as you teach it"** (orchestration kernel, K5.2).
  Run a command, then pick **Save as recipe** from the AI sidebar's ⋯ menu and name it: it
  becomes a deterministic, zero-token workflow that replays with **no model call** whenever
  you type its name. Only recipe-style commands can be saved (a planner run has no fixed
  replay yet, and the sidebar says so honestly). Manage saved workflows in Settings → Memory.
- **Instant, deterministic commands scale without prompt bloat** (orchestration kernel,
  K6.2). The tool registry gained capability/permission/cost metadata and **scoped
  descriptors**, so the AI can grow to 100+ tools while each turn still advertises only the
  handful it needs — keeping prompts small, fast, and cheap.
- **Sturdier, replayable agent runs** (orchestration kernel, K5.3). Agent runs now have a
  per-failure recovery policy (retry with backoff, fall back to a deterministic recipe or a
  cheaper model, route around a failed step, or pause honestly for review — never a faked
  ✅), a compacted conversation log, and **replay**: a recorded run reproduces exactly with
  zero model calls.
- **AI analysis tools now actually run** (ADR 0041). Agent-mode analysis calls
  (silence, scene cuts, and the new **beat detection** for beat-synced cuts)
  execute against the local engine and stream their real results back into the
  run — the tool card shows live elapsed time, the model uses the returned
  data on its next step, and Stop cancels the in-flight analysis (shown as
  "Stopped", never a checkmark). Without an engine connected the call fails
  honestly instead of pretending it ran. `detect_beats` reports beat
  timestamps plus an estimated BPM and is available from the AI panel and the
  MCP server.
- **Cursor-grade AI sidebar.** The agent's narration now appears as chat
  messages interleaved with its tool cards (instead of being folded into the
  reasoning panel); "Plan first" runs surface a live to-do ledger that checks
  steps off as they complete; the thinking shimmer settles into a real
  "Thought for Ns"; tool cards show a compact arguments line; and runs that
  applied edits close with a markdown report of what changed and what was
  skipped (and why).

### Fixed
- **Thumbnails-on zoom no longer lags the app** (ADR 0041). Each filmstrip
  source now decodes once app-wide into a bounded bitmap cache, each clip
  draws ONE canvas from those bitmaps instead of up to 16 re-rasterizing
  `background-image` tiles, and during a zoom gesture the strip freezes and
  redraws once on settle — the CapCut/Resolve behavior.
- **Collapsed side rails read as a quiet 24px edge.** The fat bordered strip is
  gone; the resize splitter hides while its rail is collapsed, and
  collapse/expand animates instead of snapping.

### Added
- **"Show thumbnails on timeline" setting** (Settings → Editing, default on).
  Turns the clip filmstrip picture layer off for very large projects — the hint
  explains thumbnails cost extra memory and decode work. When on, even sliver
  clips now draw at least one frame (the old 24px picture cutoff hid them).

### Fixed
- **Timeline zoom no longer degrades the whole app until restart.** Zoomed-in
  clips sized their waveform / filmstrip-placeholder canvases to the clip's
  full pixel width (easily 100k+ px — beyond browser canvas limits), pinning
  hundreds of MB of GPU memory per clip that was never reclaimed. Canvas
  backing stores are now clamped (8192 device px) and CSS-stretched.

### Changed
- **Film-scale timeline performance.** Clips, transition pills, cut affordances
  and ruler ticks are horizontally windowed: only the visible slice of the
  timeline (plus a quantized overscan buffer) mounts, so zooming, scrolling and
  dragging stay responsive on hour-long, thousand-clip timelines. Filmstrip
  frames also reuse DOM nodes across zoom instead of remounting per tick.

### Added
- **On-canvas transform controls (H4).** Click the program monitor to select the
  picture clip under the playhead; drag the bounding box to reposition and the
  corner handles to scale proportionally. Gestures live-preview and commit one
  validated, undoable patch (`add_keyframes` with the new mirrored `replace`
  flag — same-property/same-time keyframes update in place in both engines).
  The preview now also renders transform keyframes live during playback.
- **Project orientation presets (H5).** A canvas Select in the monitor
  transport: 16:9, 9:16, 1:1, 4:5, 21:9 (aspect-matched; non-preset canvases
  read as "Custom WxH"). Propagates to preview, guides, and render because the
  canvas is `project.resolution`.
- **Preview proxies end-to-end (H3).** Importing video now derives (or
  idempotently reuses) a low-res proxy via the sidecar
  (`.framepilot-derived/<digest>/proxy.mp4`); the monitor plays proxies while
  export still renders originals. Sources over
  `FRAMEPILOT_PROXY_MAX_DURATION_SECONDS` skip synchronous derivation.
- **GitHub Models + GitHub Copilot providers (H11).** OpenAI-compatible chat +
  SSE streaming; Copilot session-token exchange with caching, `gho_` fallback
  and actionable `ghp_` rejection. Configurable in Settings → AI (now the app's
  own Select) and via `GITHUB_MODELS_PAT` / `GITHUB_COPILOT_TOKEN`.
- **`reasoning_delta` stream event (H1).** Live reasoning now streams O(chunk)
  deltas (one canonical snapshot per line) instead of re-shipping the full text
  per token; `createConversationViewBuilder` folds event logs incrementally.
- **File → Home (H20)**, **Settings deep-link to the AI tab (H2)**, and a
  **desktop feature audit** (`reports/desktop-feature-audit.md`, H17).

### Added
- **Draggable text overlays.** Drag **Text** from the Overlays panel onto any
  timeline lane to create an overlay at the drop point. A selected overlay is
  editable on the canvas — drag to move, drag a side handle to resize its wrap
  box (text reflows), and double-click to edit the text inline. The Inspector
  gains a full **Text** panel (content, colour, font, weight, size, alignment,
  box width, position, background, in/out animation + duration). Styling lives in
  the text effect's open param bag (no schema migration) and the monitor renders
  a live styled preview with scrub-accurate in/out animation. Backed by a new
  reversible `set_effect_params` engine operation (apply/invert, 100% covered).
- **Rule-of-thirds composition grid.** A toggleable gridline overlay in the
  monitor (off by default) replaces the old 9:16 safe-area guides.
- **On-cut transition picker.** Clicking the **+** on a butt-joined cut now opens
  a picker of every transition (fade, cross-dissolve, push, zoom, blur) instead
  of silently inserting a default.

### Added
- **Apply mode (Manual / Auto) in the AI sidebar.** A dropdown beside the mode
  selector controls how proposed edits reach the timeline. **Manual** (default)
  keeps today's flow — each edit is a reviewable card you Accept or Reject.
  **Auto** applies every valid edit the instant the AI proposes it (still
  validated, still reverted by Undo). Each option carries a `?` help tooltip and
  an ⓘ beside the dropdown explains the control; the choice is remembered.

### Changed
- **Program monitor.** The letterbox background now matches the panel surface
  instead of near-black; the frame is contained with a pure-CSS technique so it
  reflows correctly on any resize and the grid/overlays track the picture. The
  preview element pool was widened (3→5) to reduce cut flicker on fast montages.
- **Header status.** Save/IO messages (e.g. "Saved to …") now appear in the
  header's title slot and fade out, instead of a separate floating toast.
- **Orientation menu.** Opens upward so it is no longer hidden behind the
  timeline dock.
- **AI orchestration efficiency.** Tool descriptors no longer carry the unused
  JSON-Schema `$schema` dialect URI, and plan-only turns advertise no tools —
  cutting per-turn token cost with no change to context budgets or behaviour.
- **AI sidebar (H2/H13).** Tool cards and Proposed Edits are accordions
  (collapsed by default, expansion remembered per run, animated without layout
  shift); the Stop button no longer blinks; the right rail opens on AI.
- **Header (H12).** Project title centered; the save state is a fixed-size
  status dot (label in tooltip/aria) — no layout shift on state changes.
- **Timeline (H6/H7).** Width-adaptive filmstrips (a sliver always shows one
  real frame — fixes thumbnails vanishing at low zoom), rAF-coalesced
  placeholder paints, `content-visibility` culling for off-screen clips, and
  mock-aligned tokens (light hairline playhead, 30px ruler, 5px clip radius).
- **Playback (H8).** Transcript and caption panels re-render only at word/cue
  boundaries; playhead queries run against a memoized O(log n) playback index.
- **Startup (H15).** The window appears only with a composed first frame
  (`ready-to-show`) and the shell fades in over the identical canvas colour.
- **Recents (H16).** Browser recents come from tiny per-project meta entries
  (sorted by last opened, top five) instead of parsing every project blob.

### Fixed
- **Editing text overlays from the preview.** Clicking a text overlay on the
  program monitor now selects **that overlay** (and opens its on-canvas
  move/resize/double-click-to-edit box) instead of falling through to the
  background clip. The overlay layer sits above the full-frame click target, and
  the overlay text is a proper keyboard-operable control.
- **Orientation menu rendered behind the preview / off-screen.** The canvas
  orientation dropdown (and every app dropdown) is now portaled with fixed,
  viewport-clamped positioning that auto-flips up/down, so it can't be clipped by
  the preview stage's containment or covered by the video. Its trigger height now
  matches the neighbouring transport buttons.
- **Tooltips overflowing the window.** Long tooltip text (the AI help/info hints)
  now wraps within a capped width and is clamped to stay on-screen, instead of
  running off the right edge.
- **Agent run that edits nothing but shows no reason.** In Agent mode a tool
  call whose operation the validator later rejected (e.g. a trim that would
  overlap its neighbour) still printed a "Trimmed clip …" activity row, yet the
  operation never entered the combined edit — so a run could show a wall of
  activity and end with **no proposed-edit card and nothing to apply**. Activity
  rows now appear only for operations that actually applied, and a run that
  lands nothing states plainly that no edits were applied and why, instead of
  ending silently.
- **AI sidebar text overflow.** Long unbroken strings (provider error JSON,
  asset ids, URLs) on error/tool/edit cards now wrap inside the card instead of
  spilling past its right edge; the review buttons wrap onto a second row in a
  narrow sidebar.
- **Phantom "Proposed edit · 0 operations" card.** A plan-only turn, a chat
  reply, or a run whose tool calls all failed (e.g. a provider 413) no longer
  renders an empty, un-reviewable proposed-edit card or inflates the batch
  "Apply all N edits" count.
- **Timeline zoom lag.** The thumbnail and waveform caches were unbounded and
  keyed by exact pixel size, so repeated zooming minted a fresh image every
  frame and leaked memory. They are now bounded LRU caches (evicted bitmaps are
  released), and waveforms bucket their width so nearby zoom levels reuse one
  bitmap — repeated zooming stays smooth.
- **Silent AI failures (H9).** Conversation autosave/delete/hydrate failures
  are now observable instead of unhandled rejections; Stop now aborts the
  session that actually started the run (switching provider mid-run previously
  orphaned the in-flight stream).
- **Preview flicker (H3).** Video→image cuts hold the last frame until the
  image decodes; a playhead gap no longer leaves a stale frame over the empty
  state.
- **Local project index (`@framepilot/ai-sdk/project-index`).** A Cursor-style
  local intelligence layer over the open project: entity lookup (clip / track /
  asset / effect by id), structural queries (by kind, type, time range),
  relationship queries (clips of an asset, effects of a clip), and text search
  (overlay/caption text, asset names). Memoized per immutable project snapshot
  with per-track sub-index reuse, so edits re-index only the touched tracks and
  deletions can never leave stale entries. `projectNames` and the context
  builder now read from it instead of re-walking the project per turn.

### Changed
- **Recent projects on the launch screen show only the latest five**, ordered by
  most recently opened.
- **Playhead handle has a generous invisible hit area** and a compositor-layer
  hint, so grabbing and sweeping it feels precise during playback.

### Fixed
- **Long AI runs no longer die with "The operation was aborted".** Four causes,
  all fixed: (1) the SDK's idle watchdog aborted its own controller and leaked
  the raw `AbortError` to the user — it now surfaces as the typed, retryable
  "idle timed out" provider error the retry layer handles; (2) the idle/connect
  budgets were too tight for extended-thinking turns (now 60 s to first byte,
  180 s between chunks); (3) the desktop hub's max-run cap (now 30 minutes, was
  10) ended long agent runs as a silent "cancelled" — it now ends them with an
  explicit "AI run exceeded the 30-minute limit" error the sidebar renders;
  (4) the agent's up-front plan and repair-pass `complete()` calls ignored the
  run's abort signal, so Stop could not cancel them — the signal now threads
  through to the upstream fetch, and an abort during those calls settles the
  run as *cancelled*, not failed.
- **Preview no longer freezes ~100-200 ms at every clip change.** The program
  monitor's 2-slot double buffer became a pooled player: a few persistent
  `<video>` elements each pre-load *and pre-seek* one upcoming clip, so a cut is
  an instant swap to already-decoded media. Same-asset trims — which the old
  front/back design deliberately skipped warming and therefore stalled on an
  in-file seek — now get their own pre-seeked slot. Cuts can no longer flash
  black: the monitor tracks per-slot readiness (which clip each element has a
  decoded, seeked frame for) and only switches the visible picture once the new
  clip's frame is actually paintable, holding the previous clip's last frame
  for the few milliseconds in between. Pressing play also runs through a
  **prepare-on-play gate**: playback holds briefly (with a "Preparing preview…"
  status) until the current clip *and* the warmed upcoming clips all have
  decoded frames, instead of opening with a stutter; a 2.5 s cap guarantees
  play can never hang.
- **Accepting an AI edit can no longer silently fail.** "Accept" (and batch
  "Apply all") committed through a fire-and-forget dispatch and then marked the
  card "Applied — use Undo to revert" and recorded *positive* learning into
  `aiMemory`, even when the store's validator refused the patch because the
  timeline had changed since the run started. Accept now goes through a new
  checked apply (`useEditor.applyPatchChecked`, re-validated against the CURRENT
  state); a refused patch shows an explicit "Couldn't apply — the timeline
  changed" state on the card, records no learning, and a batch stops honestly at
  the first edit that does not land.
- **One malformed tool call no longer discards a whole AI edit.** `streamEdit`
  aborted the entire run on the first invalid call, throwing away the other,
  valid calls. It now recovers per call: failures surface as warnings, the valid
  operations still become a reviewable diff, and the run only fails when *every*
  call was rejected.
- **Read tools now get the same junk-key tolerance as mutating tools.** A model
  padding `get_timeline({ projectId })` failed the read outright (and confused
  the loop); invented top-level keys are now stripped before validation on the
  AI path, while structurally wrong calls (non-object args) still fail loudly.
- **Playback no longer re-renders the editor 60×/s.** The playback loop
  dispatched `seek` into the reducer every animation frame, re-rendering the
  whole editor subtree (PreviewPlayer, Inspector, Transcript, CaptionEditor)
  per frame. The loop now advances only the playhead clock
  (`useEditor.seekTransient`); components that display the live playhead
  subscribe via `usePlayhead`, and pausing commits the clock position back into
  the reducer. Keyboard shortcuts read the live clock (`getPlayhead`), so
  split/nudge/paste act where playback actually is.
- **Startup no longer flashes.** The renderer paints the app's dark canvas from
  an inline critical style before the bundle loads, and the license check shows
  a branded FramePilot splash (mark + sweep bar, reduced-motion-aware) instead
  of a bare "Checking your license…" text swap.
- **A hallucinated extra argument no longer sinks a valid AI edit.** Weaker models
  routinely pad an otherwise-correct tool call with junk envelope keys (e.g.
  `manage_assets({ action, projectId, strategy })`), which the strict schema rejected
  wholesale (`Unrecognized keys: "action", "projectId"`) — so the agent read the
  timeline, tried to organize, failed, and finished with **0 operations / no changes**.
  The AI orchestration path now **strips unknown top-level keys** before validation and
  keeps the valid fields, so the edit applies. The registry schema itself stays strict
  (its own tests enforce that); only the AI boundary is tolerant.
- **Agent steps are no longer marked "failed" for doing read-only work.** A step that
  only inspects the project (get_timeline / detect_scenes / get_project_state) does real,
  successful work but produces no *edit*; the plan checklist wrongly showed it as a red
  cross while the tool cards below (correctly) showed green checks — confusing. A step is
  now a **cross only when a tool genuinely failed** or a produced edit was rejected;
  successful reads and legitimate no-ops show a check.
- **A run can no longer get visually stuck "in progress."** If a provider/network call
  threw mid-run, the header kept spinning and the "Thinking…" panel kept shimmering even
  though the composer had re-enabled. Runs now **always settle** — surfacing the error,
  stopping the shimmer, and ending in a terminal status — even when a step throws.
- **AI tool calls no longer fail when a model serialises numbers as strings.** Several
  providers (NVIDIA NIM and other OpenAI-compatible models in particular) emit numeric
  tool arguments as JSON strings — `{"start":"5"}` instead of `{"start":5}` — which the
  strict tool schemas rejected wholesale with `expected number, received string`, so an
  otherwise-correct `add_clip`/`trim_clip`/`add_transition`/… failed almost every time.
  The tool registry now coerces string-encoded numbers (and `"true"`/`"false"` booleans)
  at the untrusted boundary while still advertising `number`/`boolean` in the JSON Schema
  and still rejecting genuinely non-numeric input. This is the fix for the frequent
  "Rejected add_clip: Invalid arguments" failures during agent edits.

### Improved
- **Tool-call cards are now collapsible accordions** with a short summary in the chat and
  the **full, untruncated** result in the "View details" popup (previously the popup also
  showed a truncated `…` preview). The reasoning panel no longer duplicates the plan
  checklist — it shows only the model's real words, and an empty reasoning row is hidden.
- **The AI sidebar now shows the model's real reasoning, streamed live.** Agent runs
  stream the model's own rationale into a "Thinking…" panel (with a shimmer while it
  arrives) instead of hardcoded placeholder lines; the panel auto-expands while thinking
  and collapses to a "Reasoning" summary once done.
- **No more fake progress percentages.** AI work has no measurable percentage, so the
  agent's "0%…100% / Done" bar is gone. In-progress states read as an indeterminate
  shimmer + activity (reasoning/plan/tools); the header shows a small loading spinner
  **only while a run is in flight** and nothing when idle or finished.
- **Clearer tool-call cards.** A tool's status is now an icon with a tooltip (spinner /
  check / warning / cross) rather than a text badge; each card shows a concise summary
  with a **View details** action that opens a popup containing the full input, result,
  logs, warnings, and errors, plus a **Copy** button. A failed plan step reveals its
  error on hover of its cross.
- **A calmer composer.** The message box now grows to fit multi-line input (keeping the
  add and send controls in place instead of clipping them), and the stop control is a
  clearer, pulsing danger button.

### Added
- **Interrupt and Resume a long agent run (checkpoint/resume, R3 C2).** When an agent
  run is stopped mid-flight, it now emits a resumable **checkpoint** — the operations
  already applied, the action log, and how many steps had completed — which rides the
  conversation event log (no new store, no project-schema change). The sidebar then
  offers **Resume**, which replays the kept edits and continues from the next step
  instead of restarting from scratch (the old behavior was Retry-only). The resumed run
  ends in one combined, reviewable diff covering both the earlier and the new edits, so a
  single Undo still reverts the whole thing. If the project changed under the run so the
  kept edits no longer apply, Resume says so and starts over rather than applying a stale
  patch. Available on the browser path; the desktop resume hand-off is a follow-up.
  `events.ts` + `orchestrator.ts` stay at 100% coverage (ai-sdk 328 tests).

### Improved
- **The streaming agent now runs the same robust loop as the non-streaming
  `agent()`.** Previously the app drove `Orchestrator.streamAgent` with no agent
  options, so it silently lost the blast-radius caps, the up-front plan, and the
  bounded self-repair that `agent()` already had — a long, multi-step run (e.g. a
  podcast edit) had none of those safety rails. `streamAgent` now honors
  `agentOptions` end to end: **blast-radius caps** (`maxOpsPerTurn`/`maxOpsPerRun`,
  R3 C1) reject a runaway turn with a diagnostic and stop a run that spends its op
  budget; **`planFirst`** (R3 C4) drafts an up-front plan (surfaced as a reasoning
  summary) and threads it into every turn; a **bounded Critic-driven repair pass**
  (R3 C3) runs once at the end when fixable findings remain, surfacing its edits as
  action cards; and the **Critic self-check** is surfaced as a notice + one warning
  per failed check (never faked). The browser `AiSession` now forwards `agentOptions`
  and the current `selection` to the run, so context is scoped on large projects
  (R2 B3) and a UI control can drive plan/repair/duration-target. `Orchestrator.agent`
  and `review` were refactored onto one shared `critiqueOptions` builder so the
  self-check behaves identically on every surface. No project-schema change, no new
  dependency; `orchestrator.ts` stays at 100% coverage (ai-sdk 316 tests).
- **Desktop AI is now in sync with the browser path (cross-surface parity).** The
  `AiStreamRequest` IPC was **additively** extended (`@framepilot/shared-types`) to
  carry conversation **history**, the timeline **selection**, and **agent options**
  (plan-first / blast-radius caps / auto-repair / duration target). The main process
  validates each field from the untrusted renderer (bounded history window, finite
  non-negative selection with `start ≤ end`, allowlisted target platform) and threads
  history + selection into the model context and agent options into the loop — so the
  packaged Electron app gets the same **multi-turn coherence**, **selection-scoped
  context**, and **robust agent** the browser path has, instead of only project +
  prompt. No project-schema change, no new dependency; the new stream module stays at
  100% coverage (desktop 172 tests).
- **Anthropic prompt-caching on the stable prefix.** The Anthropic provider now marks
  the stable prefix — the tool schemas + the system contract — with an `ephemeral`
  cache breakpoint (on the `system` block, or the last tool when no system is present),
  so Anthropic reuses it across turns instead of re-billing/re-processing it every turn.
  On a long, multi-turn run (e.g. a podcast agent) the identical tool schemas dominate a
  turn's fixed cost, so this is a real cost + latency win. The per-turn timeline/
  transcript/prompt lives in the user message and is deliberately not cached. No new
  dependency; NVIDIA (no equivalent) is unchanged; `anthropic.ts` stays at 100% coverage.
- **Agent mode gained a "Plan first" control.** The sidebar now shows a plan-first
  toggle in Agent mode (on by default), wired to the new `agentOptions` end to end
  (browser + desktop): the agent drafts a step-by-step plan before editing and follows
  it, which — together with the blast-radius caps and self-repair above — makes a long,
  multi-step edit (e.g. a full podcast) legible and controllable. Hidden in Chat/Edit
  modes (web-editor 625 tests).

### Fixed
- **License key activation now works in the desktop app.** Activation always failed with
  an "uid too long" error from Freemius because the app generated a 36-character device id
  (a standard UUID includes hyphens) while Freemius caps the id at 32 characters. The app
  now generates a 32-character id, and any device that already stored an over-long id
  heals itself automatically the next time it activates — no reinstall needed.
- **Pricing "Start editing" buttons now open checkout.** The subscribe buttons could
  silently do nothing when the site was built without the Freemius checkout keys in the
  environment. They now reliably open the secure Freemius checkout overlay — and if the
  overlay can't run (e.g. an ad/privacy blocker blocks it), the button falls back to
  Freemius' full-page checkout for the same plan instead of dead-ending.

### Security
- **Hardened license activation against tampering.** The desktop app now stores your
  license in an encrypted, device-bound file instead of plain text, so it can't be
  hand-edited to fake a paid license. A tampered or copied license file safely locks the
  app until you activate a real key, and existing activations upgrade automatically the
  next time you're online — no re-entry needed.

### Added
- **Customer-facing changelog on the marketing website + a `changelog-maintainer`
  agent.** The website now has a `/changelog` page (`apps/website/src/app/changelog/`)
  driven by authored MDX in `apps/website/content/changelog/*.mdx`, loaded and
  validated by a typed loader (`src/lib/changelog.ts`, tags limited to
  New/Improved/Fixed) and rendered through the existing remark→rehype pipeline as a
  clean, gradient-free release timeline (date/version rail + tag chips). It is wired
  into the footer, ⌘K command menu, and sitemap. A new **`changelog-maintainer`**
  subagent + skill (`.agents/skills/changelog-maintainer/SKILL.md`,
  `.agents/agents/{claude,codex}/…`, opencode config) owns this page: it **translates**
  shipped user-visible changes from the developer `CHANGELOG.md` into plain-language,
  benefit-first entries and never leaks engineering detail or repo links. Tests:
  website 15 (added changelog loader spec). This changelog stays engineer-facing; the
  `/changelog` page is its customer-facing counterpart.
- **Marketing website: premium redesign + link cleanup.** The landing page was
  restyled toward a cleaner, cursor.com-like aesthetic — **all decorative gradients
  removed** (ambient aurora canvas, accent glows, gradient headline/shimmer, grid
  overlay, spotlight-glow cards, gradient hairlines/connectors); depth now comes from
  solid layered surfaces, hairline borders, and shadows alone. Removed the now-unused
  `AuroraCanvas`, `TiltCard`, and `useSpotlight` visual helpers. Removed all
  **GitHub/repo links** from the UI (footer icon + links, ⌘K item, download/docs page
  mentions) — downloads still resolve to the release feed; removed the **duplicate
  Pricing button** in the header (kept the nav link); and the author credit now links
  to **rojanacharya.com**. `pnpm typecheck`/`lint`/`test`/`build` green.
- **AI analysis tools `analyze_silence` + `detect_scenes` are now live** (no new
  dependency, no schema change). A new non-mutating **`analysis`** tool kind runs
  in the engine via the existing ffmpeg toolchain — never fabricated in-process:
  `analyze_silence` runs `silencedetect` and returns paired `{start, end, duration}`
  silent ranges; `detect_scenes` runs the ffmpeg scene score
  (`select='gt(scene,…)',showinfo`) and returns sorted scene-cut times. Both follow
  the render-validation design (injectable log-runner + a pure, 100%-testable parser)
  and their subprocess is bounded by `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS`. New
  sidecar routes `/analyze-silence` + `/detect-scenes`; the MCP server delegates via a
  new `AnalysisClient` (validate → save → sidecar) and the tools auto-surface over MCP;
  the TS registry mirrors the Pydantic args (parity guard green). `detect_faces` and
  `generate_mask` remain `available:false` (CV-dependency-gated). Tests: engine 473,
  ai-sdk 306, mcp-server 91; touched engine modules at 100% coverage.
- **Marketing website + Freemius licensing** (ADR 0036). A new statically-exported
  Next.js App Router site (`apps/website`) sells and distributes FramePilot: a
  conversion-focused dark landing page (announcement bar, hero with a CSS rendition
  of the editor, integrations, feature bento, how-it-works, demo video, pricing
  preview, FAQ, CTA), a `/pricing` page selling a **subscription — $25/month or
  $199/year** (~34% off, honest computed savings) via a **Freemius checkout overlay**
  with a Monthly/Annual toggle (`billing_cycle`), a full **`/docs` documentation
  site** (authored markdown in `content/docs/*.mdx`, build-time rendered, grouped
  sidebar + scroll-spy TOC + prev/next), a markdown `/blog` (SEO keyword-researched
  seed posts, JSON-LD, sitemap, robots, RSS), `/download` (OS-detected, resolves to
  the latest GitHub Release), `/thank-you`, and legal pages. The dark UI reuses the
  app's design tokens (Notion/Linear/Cursor) and adds a **dependency-free 3D layer** —
  an ambient aurora `<canvas>`, a perspective **tilt** on the product shot,
  pointer **spotlight** feature cards, and scroll **reveal** — all honouring
  `prefers-reduced-motion`. It is fully keyboard-navigable (skip link, ⌘K command
  palette, accessible FAQ) and ships an offline **OG-image + favicon/PWA-icon
  generator** (`scripts/generate-og.ts`, resvg). Pricing is **never hand-faked** — a
  build step fetches live Freemius **monthly + annual** prices
  (`scripts/fetch-pricing.ts`) with a typed fallback ($25/$199), and the JSON-LD
  `AggregateOffer` is fed from the same numbers. **The app is now 100%-paid:** an
  Electron **license gate** (`apps/desktop/electron/license/`) requires a valid
  subscription on launch — device-`uid` activation + daily revalidation with a
  **7-day offline-grace** window; a lapsed/cancelled subscription surfaces a
  dedicated **renew** screen (masked key + end date + renew CTA) while still
  accepting a different key. Three sandboxed IPC channels
  (`framepilot:license:{status,activate,deactivate}`) were added to the single-source
  contract; **the license key/token never cross the bridge** (only a masked status
  projection), and the AI/render/export handlers refuse when unlicensed
  (defense-in-depth). No project-schema change, no new dependency. Tests: desktop
  161, web-editor LicenseGate 6 (+renew), website 12 (billing-cycle/savings math);
  `pnpm typecheck`/`lint`/`test`/`license:scan` green.
- **Reliable AI transport + multi-turn context** (plan
  `AGENT-ORCHESTRATION-RELIABILITY.md` R0/R1/R2·B1, ADR 0035). A dependency-free
  reliability core (`packages/ai-sdk/src/reliability/*`) now wraps every AI provider:
  transient failures (429/503/network) are **retried transparently** with exponential
  backoff + jitter, honoring `Retry-After`; permanent ones (401/400) **fail fast** with
  a typed `ProviderError` whose `retryable` flag drives the sidebar's Retry affordance.
  A stalled stream is caught by a **connect/idle timeout** instead of hanging until the
  desktop hub's 10-minute cap. The policy lives in one `ResilientProvider` decorator
  wired at every surface (browser `createOrchestrator`/`createAiSession`/agent, desktop
  `getOrchestrator`) so all three inherit it identically. Providers emit token-`usage`
  chunks captured for a new `TurnTracer` seam. **Conversation history now reaches the
  model**: `buildContext` threads a bounded window of prior user/assistant turns, so
  "make it shorter" resolves its referent (web sidebar path; desktop threading is a
  follow-up needing the IPC contract to carry history). No schema, dependency, or IPC
  change; new pure-logic modules at 100% coverage.
- **Token-budgeted, tiered AI context** (R2 B2). Context is now assembled in priority
  tiers and, when it would exceed the model's window, the lowest-priority tiers are
  dropped first (transcript → timeline → memory → history → selection) — with an
  **honest `notification`** naming each trimmed tier, never a silent drop. A pure
  `estimateTokens` heuristic (≈4 chars/token, no dependency) drives it; the default
  budget is generous so small/medium projects are unaffected. Bounds prompt size (and
  latency/cost) for very large timelines.
- **Bounded agent-run context + blast-radius caps** (R2 B4 / R3 C1). The agent loop's
  fed-back action log is compacted (recent steps verbatim + a digest of older ones) so
  a long run's prompt stays bounded; new `maxOpsPerTurn` (40) and `maxOpsPerRun` (200)
  caps reject a runaway turn and stop a run that exceeds its operation budget, each with
  a clear diagnostic — the combined patch stays reviewable and nothing auto-applies.
- **Selection-scoped AI timeline context** (R2 B3). When an edit targets a selection,
  the timeline the model sees now shows the clips overlapping that range plus their
  immediate neighbours in full and collapses the rest to a count/span — keeping context
  relevant and bounded on large timelines instead of dumping every clip.
- **Bounded Critic-driven auto-repair + up-front agent plan** (R3 C3/C4). After an agent
  run, if the self-check reports a *fixable* finding (duration off target, no change
  made, audio clipping), the agent gets **one** bounded repair pass targeting only those
  findings — still human-approved, never auto-applied (opt out with `autoRepair:false`).
  Optionally (`planFirst`) the agent drafts a numbered plan up front, surfaced on the run
  and threaded into each step so it follows its own committed plan.
- **AI composer input starts flush after the "+" control** — removed the redundant
  horizontal padding on the composer textarea (the flex `gap` already spaced it), so the
  placeholder/caret no longer sits behind unnecessary leading whitespace.

### Changed
- **AI sidebar header restructured to a minimal layout.** The three-segment mode
  control (Agent/Chat/Edit) is now a single quiet dropdown showing the active mode
  with a one-line hint per option; New chat, History, and the active model/Settings
  link collapse into one overflow (⋯) menu; the run-status chip is hidden while idle
  so the header stays silent until something is happening. A not-ready model (no API
  key saved) is flagged with a small warning dot on the overflow trigger. Both menus
  reuse the existing accessible `Menu` primitive (Escape / outside-click / ARIA
  menu-button), so keyboard and screen-reader behaviour is preserved.
- **Editor no longer re-renders playhead-free panels on every seek.** Playback advances
  the playhead ~60fps and ruler-scrub moves it per pointer sample; previously each update
  re-rendered the whole workspace because the churning editor object was prop-drilled into
  every panel. The panels that don't display the live playhead (Media bin, Effects,
  Overlays, AI sidebar, toasts) are now memoised on every editor-state slice **except** the
  playhead, so a pure seek reuses their elements and React skips those subtrees — cutting
  the per-frame work behind the reported lag on the media/asset bin and side panels during
  playback and scrubbing. Live components (program monitor, toolbar timecode, timeline,
  inspector, transcript, caption highlight) still update on seek. Behaviour is unchanged;
  a `getPlayhead()` accessor keeps "insert/place at playhead" actions reading the live
  position. (No schema/engine change; view-state only.)
- **Timeline zoom and clip-drag are smoother under rapid input.** Cmd/Ctrl+wheel (and
  trackpad pinch) previously committed one zoom store-update per wheel event — a burst
  meant many whole-editor re-renders and lane rebuilds per gesture; the burst is now
  coalesced into one `setZoom` per animation frame (the point under the cursor still stays
  fixed). Dragging a clip previously rebuilt every lane on every pointer sample (high-Hz
  trackpads fire many per frame); a leading-edge frame throttle now caps that to about one
  rebuild per frame while keeping the drop position frame-accurate. The timeline overview
  minimap is memoised (and its geometry cached) so it no longer re-walks every clip on each
  playback frame, and the ruler ticks / duration are memoised out of the per-frame render
  path. No behavior change; view-state only.
- **The timeline and toolbar no longer re-render on every playback/scrub frame.** The live
  playhead now lives in a small dedicated clock store; the marker, the sr-only scrubber, and
  the ruler value subscribe to it directly, so a seek updates only those tiny nodes while the
  timeline, toolbar, and side panels stay put. The program monitor and its timecode still
  update live. Additionally, each timeline clip is memoised, so dragging a clip on a
  many-layer timeline re-renders only the clip being dragged instead of every clip on every
  layer. No behavior change; view-state only.

### Security
- **`/asset-media` derivation is now time-bounded** so a crafted or looping media file
  can no longer hang thumbnail/waveform/probe generation. A new env var
  `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS` (default **60s**, tighter than the 900s render
  ceiling) is threaded through the route into `inspect_media`, `extract_waveform`, and
  `generate_thumbnails`. On timeout the probe fails cleanly (HTTP 422) and
  waveform/thumbnail derivation degrades to `null` rather than blocking import. Touched
  modules (`config.py`, `media/derive.py`, `service.py`) at 100% coverage; no new
  dependency. (Add `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS=60` to `.env.example`.)
- **MCP server now steers external AI agents to its tools and stops leaking the project's
  filesystem path.** Running an external agent (e.g. Claude Code) against the FramePilot
  MCP server could result in the agent editing `project.fp.json` directly on disk —
  bypassing validation, atomic writes, and the reversible patch history — because the
  server sent no guidance and returned the absolute project path. The server now ships
  authoritative MCP `instructions` telling the client to make **all** edits through the
  validated, reversible tools and never to read/write the project file or media directly,
  and its session-tool results return a stable `projectId`/`projectName` instead of the
  absolute on-disk path. Tool descriptions (`get_project_state` and the session tools,
  including the Python mirror) were tightened to reinforce the required edit path. No
  schema change; the editing path (assemble → validate → commit → atomic save) and the
  path sandbox are unchanged.
- **MCP server hardened for safe use at scale** (ADR 0034). The loopback HTTP transport
  now validates both Host **and** `Origin` (closing a DNS-rebinding gap; 403 on a
  cross-origin request), caps the request body (413 past `FRAMEPILOT_MCP_MAX_BODY_BYTES`,
  default 4 MB) and returns 400 (not 500) for malformed JSON, and caps concurrent MCP
  sessions (503 past `FRAMEPILOT_MCP_MAX_SESSIONS`, default 64). **Optional bearer-token
  auth** is available and **off by default**: set `FRAMEPILOT_MCP_TOKEN` and every request
  must present a matching `Authorization: Bearer <token>` (constant-time compare) or get
  401 — unset preserves today's loopback-only behavior. `save_project` no longer silently
  overwrites external changes: it re-reads the file and raises a typed `conflict` error if
  the on-disk project changed since it was loaded (e.g. a GUI autosave), and the
  active-project pointer is now resolved through the path sandbox so a locally-writable
  pointer can't coerce the server into opening or saving a file outside the projects root.
  No schema change, no new dependency.

### Fixed
- **Agent mode no longer stops after a no-op "organize" step — it proceeds to the
  real edit.** When the media bin was already foldered, the agent's first turn
  (`manage_assets`) produced zero operations, and the loop treated any non-read turn
  that made no progress as a dead end — so the run halted at "Organizing assets → 0
  operations → no changes" without ever placing clips or editing the timeline. A turn
  that produces **no** operations (a no-op organize, a pure inspection, or a call the
  model can now retry from the surfaced error) no longer aborts the run; it continues to
  the actual edit. The loop still stops on a genuine dead end — real operations rejected
  by the validator/repeat-guard — and now also stops on *spinning* (a turn that repeats a
  tool-call signature that already made no progress), bounded by the step cap. A mutating
  tool that legitimately has nothing to do is surfaced honestly as "…— nothing to change"
  (a warning) instead of implying an edit happened, and the agent instruction now says to
  edit the timeline directly and only organize the bin when it is actually disorganized.
- **Conversation saves no longer crash with `ENOENT … index.json.<pid>.tmp` during
  agent streaming.** The atomic-write helpers (`temp file + rename`) built the temp path
  from the pid alone, which is constant within a process — so two overlapping writes to
  the same file (rapid conversation-index saves while the agent streamed) shared one temp
  file; the first `rename` consumed it and the second failed with `ENOENT`. Each in-flight
  write now uses a process-unique temp path (pid + monotonic counter); the final rename is
  still atomic (last write wins).
- **AI tool rejections now name the offending argument instead of a bare "Invalid
  arguments".** When the model called an editing tool with args that failed the tool's
  Zod schema (e.g. `add_transition` without `fromClipId`/`toClipId`, or an extra key
  under a `.strict()` schema), the orchestrator threw away the `ZodError` and surfaced
  only `Invalid arguments for "add_transition".` — so the review card showed "0
  operations / no changes" and, in agent mode, the model was fed a note with no field
  detail and could not self-correct. `ToolInvocationError` (and the agent-loop note for
  both mutating and read tools) now include the field-level detail from the validation
  error, e.g. `Invalid arguments for "add_transition": fromClipId: Required; toClipId:
  Required`. The misleading `add_transition` description ("Add a transition onto a
  clip") was also corrected to state it joins **two adjacent clips** and to list the
  required fields, so the model supplies valid args in the first place. Behavior of
  valid calls is unchanged.
- **Project parse no longer rejects engine-emitted `null` media (Zod↔Pydantic parity).**
  Opening a project could fail with `assets[N].media.thumbnailPaths: expected array,
  received null`. The Python engine derives `AssetMedia` with Pydantic (`str | None`,
  `list[…] | None`) and `model_dump(by_alias=True)` serializes an absent value as JSON
  `null` — not an omitted key — so live engine payloads and already-saved project files
  carry `thumbnailPaths: null` (and, for an asset with no derived media, `media: null`).
  The Zod schema used `.optional()`, which accepts `undefined` but not `null`, so the
  whole parse threw. `AssetMediaSchema`'s fields and `Asset.media` are now `.nullish()`,
  making "null == absent" an explicit part of the cross-language contract — it mirrors
  the Pydantic `| None` exactly (`project.schema.json` regenerated to `anyOf: [T, null]`;
  the schema-parity test unwraps the nullable wrapper). Readers already treat
  null/undefined alike via optional chaining. No data migration needed — existing files
  already conform.
- **Seamless cuts — the preview clock bridges each swap so the playhead never pins.**
  The double buffer removed the black-frame remount, but a sub-frame hitch remained:
  at a cut the freshly-swapped `<video>` sits paused at its in-point and takes a frame
  or two to spin up, and the clock rode its `currentTime` immediately — so the playhead
  froze for those milliseconds, a micro-stutter felt against steady music. The clock now
  rides the element's own clock **only while it is genuinely progressing** (playing, not
  seeking, past its in-point); every not-yet-progressing moment (a fresh swap, a seek,
  the initial play) is bridged with the wall clock, then hands back once the element is
  truly advancing (times agree to sub-frame → no visible jump). Steady single-clip
  playback still rides the media clock as the truth, so there is no cumulative drift.
- **Smooth montage playback — preview double-buffers video cuts (no more flicker).**
  A fast montage cuts between many *different* video files. The monitor mounted a
  fresh `<video>` at every cut, so each boundary flashed a black frame while the new
  element cold-decoded — constant flicker (and the remount jank also stuttered audio).
  The monitor now keeps **two persistent video slots**: the FRONT slot plays the
  active clip while the BACK slot pre-loads and pre-seeks the *upcoming* clip, so a cut
  is an instant slot swap of already-decoded media, never a remount. A pure, unit-tested
  `nextBuffers` reducer decides which slot is front and what each must (re)load
  (swap-on-arrival vs. cold-load-on-scrub); the master clock rides the front slot and
  falls to the wall clock during any load bridge. Still images / empty timelines mount
  no `<video>` at all. Presentation-only; the 60 fps memo and clock-correction logic
  are preserved.
- **Preview and export now mix all audio, not just one source (audio-bus root fix).**
  The program monitor rode a single `<video>` element, so only *footage* audio played
  and audio-only tracks (music/VO/SFX — e.g. a `Rise_Up.mp3` music layer) were silent
  in preview. It now renders a hidden `PreviewAudioMixer`: one `<audio>` per audio-only
  clip active at the playhead (the pure `audibleAudioClipsAt` projection), seeked to the
  right source offset, volume from the clip's `audio_gain`/mute, honoring `track.muted`,
  played/paused with the shared transport. The monitor's `<video>` now also honors its
  track's mute + clip gain for footage audio. On the render side, the compiler used to
  **overwrite** the composited footage audio with `with_audio(CompositeAudioClip(...))`
  built from only audio-only clips — silently dropping footage audio whenever a music
  track existed. Footage audio (and any `adjust_audio` gain on a video clip) now flows
  through the **same master bus** as audio-only clips and mixes correctly; a muted
  picture track drops its footage audio. Regression-tested TS (selector + mixer) and
  Python (footage+music mix, muted-track drop). Preview volume stays an approximate live
  monitor; the Python engine remains the truth for the final mix (fades/duck/normalize).

### Added
- **AI orchestration clarity, full tool coverage & model picker (Phase 11 follow-up).**
  Three things that make running the agent legible and capable:
  1. **Real, specific progress.** The agent stream no longer shows a hardcoded
     "Step N: analyzing the timeline" with a generic "Agent progress" bar. Reasoning
     summaries, the plan checklist, the single progress bar, tool titles, and
     timeline-action cards are now **derived from the actual tool calls, their
     arguments, and resolved clip/track/asset names** — e.g. "Trimming Intro.mp4",
     "Mute Audio 1", "Reading the timeline" — via a new pure `projectNames` resolver
     and an extended `describeOperation`/`describeToolCall` (`packages/ai-sdk`; 100%
     covered; raw chain-of-thought is still never exposed). `emit.progress` gained an
     optional stable `key` so one bar updates in place instead of stacking.
  2. **Full tool coverage — `set_track_flags`.** The AI can now mute/lock/hide a track,
     matching the UI. Registered in the TS tool registry **and** mirrored end-to-end in
     the Python engine (Pydantic args + handler + a `SetTrackFlags` operation with
     apply/invert + validator support), so parity stays green and the op is reversible.
     Exposed automatically over MCP. (No schema change — `Track` already carries the
     flags since v4.)
  3. **Provider/model + API keys configured in Settings → AI.** The provider, model,
     and API keys now live in one place — a new **Settings → AI** panel — instead of a
     sidebar-header picker and environment variables. Enter each provider's API key and
     model there; keys persist to a plaintext `ai-config.json` in the app data dir on
     desktop (environment variables remain a fallback) and to `localStorage` in the
     browser. **Keys are write-only over the bridge** — the renderer sets them but never
     reads them back; `ai:providers`/`ai:config-get` return only names/labels/models and
     a `ready` flag. The sidebar header now shows a compact, read-only **active-model
     badge** that opens Settings → AI when clicked. The choice still drives the streaming
     IPC path via a validated optional `provider` on `AiStreamRequest`. Also refreshed
     the sidebar **empty state** into a Cursor-style intro with example starter prompts.
     No project-schema change; edits still flow only through the validated
     `validate→apply→record` patch path.
- **Full-height AI/inspector rail.** The right AI rail now runs the entire editor
  height alongside the timeline (a sibling of the left+center main column) instead of
  being confined to the top region above the timeline dock. The timeline dock spans the
  main column's width; the rail width stays user-resizable and persisted. Gives the AI
  conversation and inspector far more vertical room on tall edits.
- **AI sidebar performance, a11y, E2E & docs (Phase 11 M9 — completes the sub-plan).**
  Committed the reducer perf-budget test (20k deltas fold in one pass), added sidebar
  a11y assertions (landmark region, mode `tablist`, `aria-live` stream, accessible
  control names), rewrote the offline Playwright flow for the streaming sidebar
  (Edit/Chat modes → streamed diff → Accept → global Undo; reject; chat text) with new
  visual baselines (idle + streamed diff), and added the user guide
  [`docs/guides/ai-sidebar.md`](docs/guides/ai-sidebar.md). Removed the retired
  single-shot `AiPanel` and its legacy styles.
- **Composer power features & context panel (Phase 11 M8).** The AI composer became a
  workspace input: a **slash-command palette** (FramePilot task commands — `/create-short`,
  `/remove-silence`, `/add-captions`, …, filtered as you type), **quick actions** (Improve
  Edit, Create B-roll, Fix Audio, Generate Titles, Make Viral, Trim Silence, Animate
  Captions — one tap pre-fills a prompt), **attachment chips** with a paste handler
  (pasted image/file → chip), and a removable **included-context panel** that shows the
  context the orchestrator's `context-builder` genuinely receives (Current Timeline /
  Project / Transcript / Open Assets — accurate, not decorative; the panel never claims
  context the AI doesn't get). **Voice/mic is intentionally absent (Approval A5).** 13
  tests (slash filtering, quick-action prefill, context derivation, chip lifecycle, paste).
- **Conversation history & global search (Phase 11 M7).** A History drawer (toggled from
  the sidebar header) lists conversations grouped **Today / Yesterday / Previous 7 / 30 /
  Older**, each row with title, model, agent badge, unread dot, pinned state and hover
  actions: **Rename (inline) · Duplicate · Delete · Pin · Favorite · Export (Markdown)**.
  A single input does **instant global search** across titles, message text, tool output,
  timeline-edit summaries, and file names (`searchConversations` — in-house substring
  index per Approval A6), collapsing the grouped view to flat hits with a highlighted
  snippet. Export serializes a conversation to a Markdown transcript or its exact JSON
  record (round-trippable). 14 tests (search/export helpers, store duplicate, drawer
  interactions).
- **Diff review, batch accept & interruptibility (Phase 11 M6).** Diff cards gained
  **Accept / Reject / Jump to timeline**. Accept commits through `useEditor.applyPatch`
  (validate→apply→record) so **global Undo reverts it**; Reject records the
  `recordRejected` learning signal. Decisions are owned by the sidebar per node id, so a
  **batch "Apply all"** (`applyDiffsInOrder` — transactional, **stops at the first invalid
  edit**, never half-applies) and single accepts stay consistent. Live progress bars drive
  off `ProgressEvent`; interruptibility ships **Stop** (abort) + **Retry** (re-runs the
  last turn) and the composer never locks. **Honestly gated (not faked):** **Preview**
  (renders via the engine — not yet wired to this surface; render-vs-preview rule) and
  **Resume** (the streaming engine doesn't checkpoint a partial agent run yet — Retry
  re-runs instead). 17 tests.
- **Tool cards, reference chips & timeline-action cards (Phase 11 M5).** Every tool in
  the canonical `TOOL_REGISTRY` now maps to an icon + label (`toolMeta.ts`, exhaustively
  tested so a new tool can't render generically), and an `available:false` tool renders
  **visibly gated ("Coming soon")** instead of faking capability. Tool cards expand to
  show input · summary · result · affected **clips/tracks/files** (as clickable chips) ·
  logs · warnings. **Reference chips** dispatch an `onReveal` intent — wired in the editor
  to select the referenced clip. Diff cards now list **per-operation action cards**
  ("Deleted range", "Trimmed clip", …) derived from the patch ops via `describeOperation`,
  each with its own reference chips. Tests: registry-mapping exhaustiveness, chip-click →
  reveal, gated-tool rendering, action-card derivation.
- **Streaming AI sidebar — the visible product (Phase 11 M4).** The right-rail
  single-shot `AiPanel` is replaced by **`AiSidebar`** (`components/ai/`): a fixed header
  (Agent/Chat/Edit segmented control + run-status pill + New Chat), a scrollable
  **conversation/activity area**, and a docked composer. The view is a pure function of
  the active conversation's event log (`reduceEvents`) — streaming just appends events and
  each row updates **in place by id**. One renderer per event type with a distinct
  treatment (`UserMessage`, `AssistantMessage` with **progressive markdown** via
  `react-markdown` [MIT, license-scanned], collapsible `Reasoning`, `PlanChecklist`,
  `ToolCard`, `TimelineActionCard` with clickable reference chips, `DiffCard`,
  `ProgressBar`, `Notice`). **Status colors map to the existing semantic tokens** (ADR
  0028 — no invented colors); auto-scroll with a **Jump to Latest** affordance;
  reduced-motion-gated caret/spinner animations; ARIA roles + `aria-live` on the stream.
  Long conversations virtualize (`@tanstack/react-virtual`, already a dep — the 20k-event
  budget lands in M9); short ones render plainly. Wired to the M3 `AiSession` transport
  and the M2 conversation store. Only honest affordances ship (History/Search/Settings
  arrive in M7/M8 — no dead buttons). 16 renderer + shell tests.
- **Streaming AI transport — `AiSession` + IPC push channel (Phase 11 M3).** One
  `AiSession` interface (`apps/web-editor/src/editor/ai.ts`) is now the only thing the
  sidebar depends on: `run(mode, input)` yields `AiEvent`s + `abort()`. In the browser it
  streams the M1 orchestrator directly; on desktop it drives a new **requestId-scoped IPC
  push channel** (`framepilot:ai:stream-start` invoke, `…stream-event` main→renderer push,
  `…stream-abort` send) so the upstream fetch runs in the main process (no sandbox). The
  abort signal threads all the way to the provider's `stream()` (→ the fetch reader), so
  cancelling actually stops the network call and no event is forwarded after; the renderer
  filters by `requestId` so runs never cross. Only `AiEvent`s cross the bridge — the API
  key stays in main. The main-process core (`electron/ai/ai-stream.ts`) is unit-tested
  with the offline mock; the renderer queue is tested through a fake bridge (ordering,
  buffered race, foreign-id filtering, error, abort). Channels single-sourced in
  `@framepilot/shared-types`. **Security-reviewed:** run ids are `randomUUID()` and abort
  is scoped to the owning sender (no cross-renderer cancellation), runs are aborted on
  `webContents` destroy and bounded by a timeout, the renderer request is validated, and
  the abort signal threads into the provider `fetch` itself. No UI yet — the shell is M4.
- **Conversation store + persistence (Phase 11 M2).** The AI sidebar now has a
  persistent, append-only conversation store — **separate from `project.fp.json`**. New
  pure helpers (`conversation.ts`: create/append/`deriveTitle`/`groupByDate`/`markRead`)
  + an in-memory store (`conversationStore.ts`) + a `useConversations` React adapter with
  **debounced autosave** and `hydrate`-on-open. Persistence sits behind one
  `ConversationPersistence` interface with three interchangeable adapters reading/writing
  the **same JSON shape** (Approval A1): `Desktop` (canonical, JSON file per conversation
  via new sandboxed `conversations:list/load/save/delete` IPC channels — id is
  traversal-guarded in the main process), `IndexedDb` (browser/dev, for 20k-event logs),
  and `Memory` (tests/fallback). Per-conversation UI state (scroll/draft/collapsed tools/
  attachments/context) persists so a reload restores where you were. 52 new tests
  (web-editor ai + desktop store + shared-types contract); the 20k-event round-trip is
  asserted. Nothing yet renders it — the sidebar shell is M4.
- **Streaming AI engine (Phase 11 M1, `packages/ai-sdk`).** The SDK now *emits events*
  instead of only returning final values. New `events.ts` defines the append-only
  `AiEvent` union (user/assistant-delta/assistant/reasoning/plan/tool-call/tool-result/
  timeline-action/diff/progress/reference/notice/error/status) plus a pure
  `reduceEvents()` reducer that folds the log into a render-ready view, merging streamed
  deltas into their parent message and tool results into their tool call **in place by
  id**. `AiProvider` gains an optional `stream()` (`ProviderChunk` = text-delta | tool-call
  | done); the deterministic `MockProvider.stream()` is the offline test backbone, and the
  Anthropic + NVIDIA providers parse their SSE wire formats (exercised against captured
  fixtures, no network) through a minimal `FetchLike` `body` seam. The orchestrator gains
  `streamChat`/`streamPlan`/`streamEdit`/`streamAgent` that yield `AiEvent`s and honor an
  `AbortSignal` — `streamEdit` still ends in a validated `DiffEvent` and `streamAgent`
  streams live plan/reasoning/tool/progress/action events with a terminal combined diff,
  emitting a `cancelled` status + valid partial on abort. The validated tool→patch path is
  unchanged; nothing auto-applies. 100% coverage; no UI yet.
- **Streaming AI sidebar — architecture locked (Phase 11 M0, ADR 0033).** Recorded the
  decision to upgrade the single-shot right-rail `AiPanel` into a streaming, persistent,
  interruptible sidebar where **everything the AI does becomes a typed, append-only
  `AiEvent`** and the UI is a pure function of an ordered event log. ADR 0033 locks the
  event model, the `AiSession` transport facade, JSON-file conversation persistence
  (separate from `project.fp.json`), the streaming-IPC approach, and the minimal
  `FetchLike` SSE seam (optional `body` stream) — with the §9 approvals resolved (voice
  dropped, fuzzy-search optional). No production code yet; M1 builds the streaming engine.
- **Interactive on-cut transitions (Timeline Revamp M3).** Transitions now live ON the cut:
  a draggable **transition pill** straddles the junction between two adjacent clips (centred
  on the cut, width = duration), selectable by click/Enter and **resizable by dragging either
  edge** — the resize commits as one reversible patch and is **clamped to the shorter
  neighbour**, so a drag can never produce a transition the engine would reject. Empty
  butt-joined cuts show a hover affordance that **adds a default cross-dissolve on
  double-click or on a drop** from the transitions browser (whose tiles are now draggable onto
  a cut). The Inspector gained a **Transition** section to swap the kind, set the duration, or
  remove the transition. A disabled **Beat-synced** tile is shown with "Coming soon — requires
  beat detection" (never silently absent or faked). Under the hood, the patch validator's
  **`transition_overlap`** check (TS + Python parity) and the now-**idempotent
  `add_transition`** op (replace-in-place, never stacking) keep every resize/swap correct and
  reversible. No schema change, no new dependency; the 60fps playhead invariant is preserved.
- **Multi-select, marquee & edit modes on the timeline (Timeline Revamp M2).** The timeline
  now selects like a pro NLE: Shift-click extends, Cmd/Ctrl-click toggles, and a **marquee**
  rubber-band selects every clip it covers; **delete and drag-move act on the whole
  selection as one reversible patch** (one undo reverts the batch). An **Insert/Overwrite**
  mode (Insert pushes downstream clips right) and a **Ripple** toggle (delete closes the gap;
  Shift inverts) live in the timeline tools and persist across sessions. Track lanes gained
  **height-resize, collapse/expand, and audio solo**, a **minimap** overview strip, and
  **playhead-follow** auto-scroll during playback; the lane list is **virtualized** for large
  projects. All of M2 is presentation/session-state only — no schema/engine change, no new
  dependency, and the 60fps playhead invariant is preserved (solo is a derived preview-mute,
  not a schema flag; per-track view state lives in localStorage, never in the project file).
- **Real video thumbnail previews on the timeline (Timeline Revamp M1).** Importing media
  on the desktop now derives **waveform peaks + thumbnail frames** through the engine and
  stores them on the asset, so video clips show real frames (and audio shows real peaks)
  instead of a skeleton. The engine `/asset-media` route generates thumbnails into a
  sandboxed `.framepilot-derived/` cache (idempotent per source); a new sandboxed
  `importAsset` desktop IPC channel carries the derived media to the renderer, which serves
  frames through the existing `fp-media://` scheme. Security-reviewed (every path hop is
  sandboxed and the media scheme re-validates containment at read time); the upstream
  sandbox-error body is never forwarded to the renderer. No project-schema change
  (`Asset.media.thumbnailPaths` already existed); no new dependency. Browser builds keep the
  skeleton (derivation is desktop-only — render-vs-preview rule).
- **Clip anatomy v2 — CapCut-style clip cards (Timeline Revamp M1).** Clips now read at a
  glance like a premium NLE. Video clips show a **filmstrip picture layer** filling the body
  plus a **waveform band** along the bottom; image clips show the picture layer; audio clips
  keep the full-height waveform. A top **header strip** carries the title (ellipsized) +
  duration + a `⋯` actions control (opens the existing clip menu), and **width-adaptive
  density** degrades gracefully — sliver clips collapse to a bare colored block, narrow clips
  show the title only, then duration, then the `⋯` button as width allows, so labels never
  overflow. The picture layer draws from `Asset.media.thumbnailPaths` when present and falls
  back to a **skeleton** until the desktop media-import path populates thumbnails (no
  browser-side media derivation — render-vs-preview rule). Presentation-only: new pure
  `clipFilmstripFrames` + `clipHeaderDensity` selectors, a `ClipFilmstrip` component, and a
  `variant="band"` mode on `ClipWaveform`; no schema/engine/patch change, no new dependency,
  no new mutation path, and the 60fps playhead-tick memo is preserved. Spec + remaining
  milestones in `plan/TIMELINE-REVAMP.md`.
- **Type-agnostic timeline layers — Phase 2 complete (ADR 0032).** The timeline is now
  a CapCut-style stack of generic layers: **any clip kind lives on any layer**, and a
  clip's behaviour comes from its *content* (derived `clipKind` — video/audio/image by
  asset, text/caption by synthetic id), never from a layer's type. **Adding a different
  kind, or a clip that would overlap, spawns a new layer on top** (auto-layering);
  **index 0 is the visual front** and the render composites front→back to match. Ships
  end-to-end across all milestones: reversible `add_layer` / `remove_layer` / `move_layer`
  operations (lossless inverses) with an **"Add layer"** tool and per-layer z-order
  chevrons; preview and the MoviePy compiler both route by clip kind (stills now render via
  `ImageClip`); the validator (TS + Python) no longer constrains text/captions to a layer
  type; drag-drop and "add to timeline" use the shared auto-layering path; each layer's
  header icon/label/colour and each clip's colour derive from content (new image colour);
  and the AI context now describes layers by z-order + content kind. No schema-shape change
  (`Track.type` is an advisory role only; `SCHEMA_VERSION` stays 4). Progress and design in
  `plan/PHASE2-type-agnostic-layers.md` / `docs/adr/0032-type-agnostic-layers.md`.
- **Functional per-track lock / hide / mute controls (schema v4, ADR 0031).** The
  left-rail track controls are now live, CapCut-style toggles backed by three new
  optional `Track` flags. **Lock** blocks move/trim/split/drop on a lane (selection
  still works); **hide** drops a visual track's picture from the preview *and* the
  render; **mute** silences an audio track in the render. Each toggle is one
  reversible `set_track_flags` patch; "off" is stored as absent so undo is exact and
  files stay lean. Schema bumps to **v4** with an additive `v3 → v4` migration (older
  projects open unchanged); Zod + Pydantic + the JSON Schema contract stay in sync.
- **Cmd/Ctrl + scroll to zoom the timeline.** Holding the modifier while scrolling
  zooms in/out **around the cursor** (the time under the pointer stays fixed),
  alongside the existing zoom-to-fit.
- **Grabbable playhead with a live time bubble (ADR 0031).** The playhead gains a
  draggable head — scrub by dragging it like the ruler — with a time readout, over a
  crisper full-height line.
- **Live project-file sync — external edits appear instantly (ADR 0030).** When the
  open `project.fp.json` is edited from outside the renderer — most importantly by
  an AI agent driving the MCP server — the desktop app now reflects it **live**, no
  re-open required. The main process watches the open file's directory (robust
  across atomic-rename saves), suppresses the app's own writes by canonical-content
  dedup, validates the on-disk document, and pushes it to the renderer over a new
  `framepilot:project:changed` IPC channel + `onProjectChanged` bridge method. The
  editor auto-reloads from disk (the file is the source of truth). New tested
  `ProjectFileWatcher` (dedup + debounce); no schema change.

### Fixed
- **Smoother timeline playback with many layers/clips.** The timeline's track lanes
  (every clip, waveform, badge and keyframe) are now memoised and no longer rebuilt
  on each playhead tick — during playback the playhead advances ~60×/s, and previously
  that re-rendered the entire clip tree every frame, which janked on projects with
  many layers/clips. The lanes are now reused untouched while only the playhead moves;
  gesture handlers were made referentially stable (and read the playhead via a ref) so
  the memo holds across frames. Drag/trim/split/drop/selection behaviour is unchanged.
- **Reduced preview flicker at clip boundaries.** The program monitor now pre-loads the
  *next* picture clip's media in a hidden, muted, clock-independent `<video>`, so when
  playback cuts to a clip on a different source the element swaps to already-buffered
  media instead of stalling on a cold fetch/decode at the boundary (the stall is what
  read as a flicker). Same-source cuts already played without a reload and are
  unaffected. The master playback clock is deliberately untouched. *Note:* this targets
  the load-stall; a fully flash-free cross-source swap (double-buffered `<video>` with
  clock role-swap) remains a follow-up that needs in-app verification.
- **Export/render no longer fails with "schemaVersion 4, but this engine supports up
  to 3".** The schema v4 work bumped the TS `SCHEMA_VERSION` and added the Track
  `locked`/`hidden`/`muted` flags to the Pydantic models, but the Python engine's
  `SCHEMA_VERSION` constant was left at 3 — so the render engine rejected *every*
  freshly-saved project (the TS serializer stamps v4) on export, even brand-new ones.
  The engine constant now equals the TS one (4), and a new cross-language parity test
  (`test_schema_version_matches_ts`) reads the TS `SCHEMA_VERSION` straight from source
  and pins the two together so this specific desync can never silently recur — the
  field-name parity tests did not catch it because the v4 fields *were* mirrored.
- **Image clips no longer freeze playback (ADR 0031).** A still image placed on the
  timeline is now shown in the preview as an `<img>` rather than a `<video>`; the
  playhead advances on the wall clock and plays cleanly through the image's full
  duration instead of sticking when it reaches the still.
- **Drag-drop now places a clip at the cursor.** Dropping a bin asset on the timeline
  lands it at the dropped position (lane-relative cursor + snap), not at a stale
  offset; an incompatible drop routes to the asset's natural lane.

### Changed
- **Premiere-style editor layout — full-width timeline dock.** The editor moved from a
  three-column grid (timeline nested in the center column) to a top region (assets rail ·
  program monitor · inspector/AI rail) over a **full-width timeline dock** spanning the
  entire bottom of the window, so the ruler and lanes get the whole width. A full-width
  horizontal splitter resizes the dock; its height now persists across reloads
  (`framepilot.timelineDock.height`), mirroring the rail-width persistence.
- **Cursor-class AI sidebar restyle (Phase 11).** The sidebar was reskinned to match
  Cursor: user turns are quiet full-width cards (no accent-filled bubbles), assistant
  text flows flush/borderless (no per-message avatar), the mode control is a subtle
  raised-segment control (accent reserved for the primary action), tool/diff cards and
  JSON blocks flattened to hairline surfaces with the mono token, and the composer is a
  single rounded well that lights its border on focus. CSS-only — all component
  behaviour and test hooks unchanged.
- **Cursor/Linear design-token retune (amends ADR 0028).** The `:root` palette moved to
  a cooler, flatter near-black surface ramp (`--bg-app` `#161618`, `--bg-panel` `#19191c`,
  …) and a Cursor-blue accent (`--accent` `#3d7eff`), with crisper semantic colours and
  new typography tokens (`--font-mono`, `--font-size-xs..xl`, `--leading-*`). Only token
  *values* changed — names are untouched, so the whole app restyled from one edit.
- **CapCut-style audio waveform.** Audio clips render a solid, mirrored waveform body
  (filled polygon) instead of a thin outline.
- **Virtualized media bin for large libraries (ADR 0030).** The media bin now
  flattens its folder tree and windows it with `@tanstack/react-virtual`, mounting
  only the rows in view, so dozens of clips/images stay smooth. Asset tiles are
  memoized and client-side video-thumbnail capture is concurrency-gated (max 4) so
  a fast scroll no longer spawns dozens of `<video>` decodes at once. Drag-drop,
  foldering, inline rename, and every `aria` hook are unchanged.
- **UI revamp: panel-by-panel rebuilds (presentation-only, ADR 0029).** Building on
  the 0028 token system, every left/right panel was rebuilt to its target pattern
  (not recolored), with no change to any hard-protected flow (render/export, AI
  calls + JSON contract, timeline data model, `.fp.json` persistence, undo/redo,
  shortcuts) and every `data-testid`/`aria` hook preserved. New **in-house
  primitives** (no new deps): a token-styled `Tooltip` (shortcut keycap, works on
  disabled controls) applied to every icon-only action app-wide, and a
  keyboard-operable `Select` listbox (icons + active check) replacing bare
  `<select>`s. **Media bin:** Import/New-folder are icon buttons; the new-folder
  flow inserts an inline-edit **folder tile** (filled `FolderGlyph`, not a bottom
  input); media tiles show a **real client-side thumbnail** (captured video frame /
  image) with a glyph fallback. **Effects:** a CapCut-style category-tabbed,
  searchable **preview-tile browser** with applied-state markers. **Overlays:** type
  selector, template gallery, 9-point position picker with live preview, editable
  timing, and an existing-overlays list (seek/edit/delete). **Captions:** visual
  template gallery, keyword chips, style controls, and a timeline-synced caption-clip
  list. **AI:** a Cursor-style composer (stream above, prompt docked at the bottom)
  with a refined mode segmented control (icons + ⌘I hint + active check) and a model/
  preset selector. **Inspector:** Select primitives + reset-to-default scrub fields +
  truncated clip name. **Transcript:** a search field. **Timeline:** the orphan
  scissors/zoom row folded into the corner; per-track header controls added as
  disabled stubs (schema wiring deferred). Documented in `PROGRESS.md`,
  `DESIGN_SYSTEM.md`, `UI_AUDIT.md`, and ADR 0029.
- **Notion-style dark design system (presentation-only, ADR 0028).** A calm, layered
  redesign of the web editor's look — no behavior, logic, IPC, schema, render/AI pipeline,
  or keyboard binding changed. The `:root` token system was retuned to a Notion-grade
  palette (warm `#191919` surfaces, a single restrained `#2383e2` accent, text hierarchy by
  opacity, low-opacity-white hairline borders, muted semantic + per-media-type `--clip-*`
  tokens, conventional red playhead), with the existing token names aliased so the change
  cascaded through every styled surface at once; all previously hardcoded colors are now
  tokens. Clips render as flat muted fills with brighter type-coloured borders (no
  gradients), selection is an accent **outline + glow** rather than a fill, the topbar logo
  drops its gradient, and the save indicator becomes a quiet dot + label (with a spinner
  while saving). The `Button` primitive's `primary` / `secondary` / `ghost` variants are now
  actually styled (full hover / active / focus-visible / disabled coverage). The duplicate
  "Playhead" scrubber row is hidden from the visible chrome (kept screen-reader/keyboard/test
  accessible) so there is one authoritative `current / total` timecode and scrubbing happens
  on the ruler. **All emoji used as icons were replaced with `lucide-react`** (media-bin
  asset kinds + folder/add/rename/delete/remove controls, the AI self-check badges, and the
  topbar brand mark), so the UI now uses one consistent icon family with no emoji. The
  program monitor's empty state is now a designed icon + label. New `UI_AUDIT.md` and
  `DESIGN_SYSTEM.md` document the audit and tokens.
  - **Segmented controls no longer use a solid accent block.** The shared `.segmented`
    primitive (Settings) and the AI mode selector (Chat / Plan / Edit / Agent) now show
    the active segment as a subtle raised surface (`--bg-elevated` + `--shadow-sm`), per
    the design spec, pulling back accent overuse. AI mode buttons gained hover and
    focus-visible states.
  - **`Button` primitive extended (additive, no API break):** new `danger` and `icon`
    variants, `sm`/`md` sizes, and a width-preserving `loading` state (spinner + `disabled`
    + `aria-busy`, respects reduced-motion). The AI panel's primary action is now full-width
    and drives its spinner from this loading state.
  - **Inspector sections are now collapsible** (§5.6). Each panel (Transform & motion,
    Color, Effects, Mask, Audio) is a native `<details>` (default open) with a custom
    rotating disclosure chevron and hover/focus-visible affordances — purely presentational
    (no JS state, no handler change; content stays in the DOM and every `aria-label`/test
    hook is preserved).
  - **Transcript shows timestamped lines** (§5.6). Words are grouped into lines (reusing the
    existing caption line-grouping), each with a monospace `m:ss` seek timecode in a left
    gutter; the active line gets a quiet accent rail while the spoken word stays highlighted.
    Individual words remain click-to-seek. (A transcript search field is intentionally
    deferred — it is new behavior, not a paint-pass item.)
  - **AI panel loading + idle states** (§5.6/§5.7). The "Thinking…/Running…" busy state is
    now a shimmering **skeleton** (announced to screen readers via an sr-only status), and
    each mode shows a muted idle **hint** describing what it does before any request. Added a
    reusable `.skeleton` primitive (respects reduced-motion).
  - **Unified native form controls** (§5.7, "kill ad-hoc styles"). Replaced four divergent
    per-panel `<select>` rules with one token-driven baseline — custom disclosure chevron,
    surface well, hover + focus-visible ring, disabled state — so every dropdown (Inspector,
    AI preset, captions, export) matches. Checkboxes are tinted to the single accent via
    `accent-color` with a focus ring, and Firefox gets slim themed scrollbars
    (`scrollbar-width`/`scrollbar-color`) to match the existing webkit treatment.
  - **Removed stale hardcoded color fallbacks** (§7 "zero hardcoded colors"). Swept the dead
    pre-Notion fallback values out of `var(--token, …)` references in `styles.css` (the old
    periwinkle `#5b6cff` accent, `#1c1c28`, `#0c0c12`, `#b3261e`) — the `:root` tokens are
    always defined, so these were dead but would have rendered the wrong color if ever hit.
    The design tokens are now the single source of truth; the only literal colors left are
    the inline SVG chevron icon asset and data-driven caption-template previews.
  - **Text-input baseline** (§5.7 "no raw input left"). Added a zero-specificity `:where()`
    fallback for `text`/`number`/`search` inputs (token well, muted placeholder,
    focus-visible accent ring) so any unclassed input (e.g. the New Project name field) is
    themed; every existing component input rule overrides it untouched.
  - **Clean clip names on the timeline** (§6 — the raw `clip__…` label defect). Timeline
    clips now display the source media's clean basename (e.g. `intro.mp4`) with the full name
    in a tooltip, instead of the raw clip id. Added a pure, unit-tested `assetDisplayName`
    selector; ids remain the canonical handle for selection/drag/patch (presentation only).
  - **Track headers de-boxed** (§5.5/§6 — bordered V·A·C badge defect). The filled letter
    badge is replaced with a subtle per-type **Lucide glyph** (`Film`/`Type`/`Captions`/
    `AudioLines`, colored by track type), and the header is now a hairline divider instead of
    a full bordered box.
  - **Clean media-bin names** (§5.2). Asset cards now show the clean file basename (via the
    shared `assetDisplayName`) with the full name in a tooltip, matching the timeline clips;
    the `asset …` id remains the drag/aria handle.

### Added
- **MCP server edits the project you have open in the app, in the right folder (ADR 0027).**
  Two fixes so an external AI agent operates on the *right* project: (1) the server's
  projects-folder sandbox now **defaults to `~/Documents/FramePilot Projects`** — the same
  folder the desktop app saves into — instead of requiring `FRAMEPILOT_PROJECTS_ROOT` (it
  used to throw when unset; the env var is now an optional override, and a shared resolver
  keeps the app and server in lock-step). (2) The app publishes which project the GUI has
  open via a tiny `.framepilot-active.json` pointer in the projects folder, so
  `open_project` **with no path** — and any tool when nothing is open yet — **auto-targets
  the project currently open in the app**. The recorded path is sandbox-checked like any
  other open (a project opened from outside the projects folder is reported but rejected,
  never reached). See [ADR 0027](docs/adr/0027-mcp-active-project-pointer.md).
- **Media-bin asset folders + AI asset management (schema v3, ADR 0026).** The media bin
  now supports nested, Finder/Explorer-style **folders**: create / rename / delete,
  drag an asset (or a folder) between folders, an empty-folder state, and OS-like motion
  (expand/collapse, drop-in, drag-over lift) that degrades under
  `prefers-reduced-motion`. Folder names are edited with an **inline text field**
  (create and rename), and files can be imported by **dragging them from the OS** onto the
  bin or straight into a folder — both the picker and drag-drop paths run through the same
  undoable `add_asset` patch. Foldering is organizational only — it never touches a clip or
  a render. Two new AI/MCP tools back this: **`add_asset`** (add a media asset to the
  project — the path AI-generated media takes when an MCP model produces a file) and
  **`manage_assets`** (organize the bin into folders, via an explicit semantic plan or a
  deterministic `strategy:"by-kind"`). Both are reversible, validated patches; an agent
  run can now *"manage my assets and edit the video"* end to end — fold the bin, place
  clips, and edit — in one reviewable, undoable patch. The patch engine was generalized
  to **project scope** (asset/folder ops alongside timeline ops in one history) and the
  `add_asset` path is sandbox-checked over MCP. See
  [ADR 0026](docs/adr/0026-project-scoped-operations-and-asset-folders.md).

### Fixed
- **MCP host returns spec-compliant `404` for unknown sessions, so clients re-list tools
  after a restart.** The Streamable HTTP router previously answered a POST carrying an
  unknown/expired `mcp-session-id` (e.g. the host restarted and wiped its in-memory session
  map while Claude Code kept its cached id) with `400 "No valid session"`. A spec-compliant
  client treats `400` as a hard error and stops listing tools until it is itself restarted;
  it re-initializes only on `404`. The router now distinguishes *session id present but
  unknown* (→ **404**, triggering transparent re-init) from *no session id and not an
  initialize* (→ 400). A bare `GET`/`curl` with no handshake still correctly reports an
  expired session. Added an integration test booting a real loopback listener to lock the
  404/400/200 contract. (ADR 0015/0019.)

### Changed
- **`project.fp.json` schema v3 — media-bin folders (Phase 8).** The Zod source of truth
  bumps `SCHEMA_VERSION` 2 → 3: `Project` gains a `folders` tree
  (`{ id, name, parentId }`) and `Asset` gains an optional `folderId`. Purely additive —
  a v2 project has no folders and its assets sit at the bin root — so the v2→v3 migration
  only stamps the envelope version. Mirrored in the Python Pydantic models and the
  cross-language `project.schema.json` (drift + parity tests updated).

### Security
- **`add_asset` media-path containment (ADR 0026).** The MCP editing session resolves an
  agent-supplied `add_asset` path through the projects sandbox (`resolveWithin`) before it
  is persisted into the project file, rejecting any path that escapes containment — the
  only untrusted, filesystem-bound field a mutating tool can introduce.
- **Phase 8 — TS path-sandbox unification, Electron IPC sandboxing & renderer CSP
  (findings 1.1/1.4 CRITICAL, 3.2 HIGH).** The TS `resolveWithin`/`PathTraversalError`
  sandbox is now a single source in `@framepilot/shared-types/safety` (node-only
  subpath; mirrors the engine's `resolve_within`), re-exported by the MCP server — no
  more two divergent copies (1.4). The Electron IPC handlers (`projectOpen`/
  `projectSave`/`projectReveal`/`renderExport`), which previously accepted arbitrary
  renderer-supplied paths, now resolve every path through the projects sandbox via a
  tested `sandboxProjectPath` helper before any disk access (1.1). The renderer now
  gets a strict Content-Security-Policy on every response, and clip media is served
  through a privileged `fp-media://` scheme whose handler resolves each request through
  the sandbox before streaming — replacing raw `file://` (3.2). No new dependency, no
  schema or IPC-contract change. A user-chosen save location *outside* the projects
  folder via a main-process native dialog is a documented follow-up. See
  [ADR 0025](docs/adr/0025-path-sandbox-unification-and-renderer-csp.md) and the
  [security-hardening runbook](docs/runbooks/security-hardening.md) audit record.
- **Phase 8 — sidecar path-sandbox containment (CRITICAL, finding 1.2).** Every Python
  FastAPI sidecar route that accepts a caller-supplied filesystem path (`/render`,
  `/render/preview`, `/inspect-media`, `/validate-render`) now resolves it through
  `resolve_within(projects_root, …)` before any disk access, returning HTTP 400 on a
  traversal/escape attempt. Previously these routes used the raw path verbatim, so a
  local process could probe arbitrary files (e.g. `/etc/passwd`) or render from anywhere
  on disk despite `Settings.projects_root` existing for this purpose. When
  `FRAMEPILOT_PROJECTS_ROOT` is unset the prior un-contained behaviour is preserved for
  backward-compat but a warning is logged; the packaged shell always sets it, so
  containment is strict in production. See
  [security-hardening runbook](docs/runbooks/security-hardening.md) incident note.

### Changed
- **`project.fp.json` schema v2 — engine-derived `Asset.media` (Phase 8).** The Zod
  source of truth bumps `SCHEMA_VERSION` 1 → 2 and adds an optional, read-only
  `AssetMedia` sub-object on `Asset` (`proxyPath?`, `peaks?`, `peaksPerSecond?`,
  `thumbnailPaths?`) so the timeline can draw real waveforms/thumbnails from
  engine-derived media instead of skeletons (the renderer never computes media —
  render-vs-preview). Populated by the desktop import path. The change is purely
  additive — a v1 asset without `media` stays valid — but a v1 → v2 migration is still
  registered (an identity transform that stamps the new envelope version), per the
  project rule "no schema change without a migration". The committed JSON Schema was
  regenerated and the Python Pydantic mirror (`AssetMedia` + `Asset.media`) + parity
  test updated. See
  [ADR 0024](docs/adr/0024-asset-media-schema-v2.md).
- **Phase 8 hardening — single-source IPC contract (`@framepilot/shared-types`).**
  The desktop↔renderer IPC request/response shapes (sidecar status, recent projects,
  open/save/reveal/export results, AI request + result types, and the
  `FramePilotBridge` interface) now live once in
  `packages/shared-types/src/ipc.ts` and are consumed by both apps. The renderer's
  hand-maintained copy in `apps/web-editor/src/editor/bridge.ts` is deleted, and the
  desktop `ipc/contract.ts` re-exports the shapes (keeping the channel-name registry
  local), so its importers and the preload are unchanged. A drift between the two apps
  is now a **compile error** rather than a silent risk. No behavior, schema, or
  runtime-dependency change. See
  [ADR 0023](docs/adr/0023-shared-ipc-contract.md).
- **MCP server transport: stdio → Streamable HTTP (`packages/mcp-server`).** The
  `framepilot-mcp` host now serves over the MCP Streamable HTTP transport on the
  loopback address `http://127.0.0.1:19789/mcp` (overridable with
  `FRAMEPILOT_MCP_HOST` / `FRAMEPILOT_MCP_PORT` / `FRAMEPILOT_MCP_PATH`) instead of
  stdio. Clients now **attach by URL** (`{ "type": "http", "url": "…/mcp" }`) and the
  server is a long-lived process started once, rather than spawned per client. Wired to
  Node's built-in `http` (no new dependency; the SDK's `@hono/node-server` is already
  transitive), bound loopback-only with DNS-rebinding protection (`allowedHosts`). All
  ADR-0015 invariants are unchanged. See
  [ADR 0019](docs/adr/0019-mcp-server-streamable-http-transport.md) and the
  [MCP server guide](docs/guides/mcp-server.md).

### Added
- **Browser E2E test suite + visual regression (Phase 8, PRD §16.1).** The Playwright
  `webServer` is enabled (Vite dev on the IPv4 loopback via `--host 127.0.0.1`;
  `reuseExistingServer` locally, fresh in CI) and the placeholder smoke `test.fixme` is
  replaced with real, deterministic, **offline** specs under `tests/e2e/specs/` that run
  against the in-browser web build — offline **mock** AI provider, no Electron, no Python
  engine, no network. Coverage of the browser-reachable critical flows: load/New project,
  transport (Space/J/K/L, Home/End), transcript view + Generate captions, the mock-AI
  propose→review-diff→apply→undo loop (plus reject and chat), and pointer-driven timeline
  gestures (select → split → drag-trim → drag-move → delete → undo/redo → ruler seek →
  zoom). Specs assert **real outcomes** (clip count, clip pixel geometry as a `secondsToPx`
  proxy for start/duration, the exact AI diff summary, caption-clip count, playhead
  readout) and that undo reverts each edit. A `@visual` screenshot-regression suite
  (`visual.spec.ts`) covers the timeline, captions, color, keyframe/transform, mask, and
  AI panels with `toHaveScreenshot()` under a pinned 1280x800 viewport and
  `reducedMotion: 'reduce'`. `pnpm test:e2e` runs the functional flows (20 tests, green)
  and excludes `@visual`; a dedicated `e2e-visual` CI job regenerates the Linux baselines
  (committed baselines are macOS-only — screenshots are platform-sensitive). Real
  export/render + output validation are desktop-only and documented out-of-scope for
  browser e2e (covered by the engine golden-media/validation tests). See
  [writing-tests guide](docs/guides/writing-tests.md#browser-e2e-suite-layout-testse2especs).
- **Onboarding docs, sample projects, and a v1.0.0 release checklist (Phase 8).**
  - **Onboarding guide** ([docs/guides/onboarding.md](docs/guides/onboarding.md)):
    a "from zero to first exported video" guide for both new contributors and new
    end-users — prerequisites (Node 20 + pnpm 9; Python **3.13** + uv, with the
    note that the system 3.14 is broken so engine commands run via `uv run`),
    install (`pnpm install` + `pnpm engine:sync`), a monorepo tour, the core
    mental model (every edit is a typed/validated/reversible patch; AI edits via
    registered tools only; render-vs-preview; auto-validated renders), a
    first-export walkthrough, and where to go next.
  - **Sample projects** (`examples/`): two schema-valid `*.fp.json` projects —
    `hello-world.fp.json` (minimal single-clip) and `product-demo-short.fp.json`
    (multi-track 9:16: graded + punch-in video, mixed music bed, caption + word
    transcript, title overlay) — plus an `examples/README.md` explaining each and
    how to open them.
  - **v1.0.0 release checklist**
    ([docs/guides/release-checklist-v1.md](docs/guides/release-checklist-v1.md)):
    a concrete, tickable gate covering all CI gates, 100% core-module coverage,
    security sign-off, signed + notarized desktop builds (Apple Developer ID +
    Windows cert as CI secrets), auto-update verification, CHANGELOG/version
    finalization, sample-project open, and docs review — linked from the
    [release runbook](docs/runbooks/release.md).
- **Phase 7 — full agent mode & the Critic (`packages/ai-sdk`, `apps/web-editor`).**
  See [ADR 0022](docs/adr/0022-phase7-agent-mode-and-critic.md).
  - **Agent mode (PRD §7.4):** `Orchestrator.agent()` runs a bounded multi-step
    tool-calling loop — the model plans, calls tools, and each turn's mutating calls
    become a validated, reversible patch applied to a working copy. The loop logs
    every action, stops on no-progress (invalid or repeated edits) or a step cap, and
    returns a reviewable `AgentRun`: the step log, a **combined** edit (one patch,
    diffed against the original), and a self-check report. The run is **not**
    auto-applied — the human approves it, and because it is one patch, a single Undo
    is a **one-click revert**.
  - **Critic / Review agent (PRD §8.6):** a pure, deterministic `critique()` runs the
    eight checks (request match, duration target, caption alignment, safe area, audio
    clipping, black frames, missing assets, export settings). Pixel/sample checks
    (black frames, audio clipping) consume the existing `validate_render` result when
    a preview render was run and report `skipped` otherwise — never a faked pass.
    `Orchestrator.review()` wraps it (no model call).
  - **Style presets:** named, deterministic styles (Clean SaaS demo, High-energy
    Reel, Talking-head explainer) seed project-memory preferences + export platform
    (no schema change) and pre-fill the agent goal.
  - **Web editor:** the AI panel's **Agent** mode is now live — a style-preset
    selector, **Run agent**, and an agent-run review (goal, self-check badges,
    collapsible step log, combined edit with **Apply all** / **Reject**) wired through
    the same validate→apply→record store. Agent runs locally via the offline mock
    provider; a real-provider IPC path is a Phase 8 follow-up.
  - **No schema change, no migration, no new dependency.** Built entirely on the
    existing tool registry, patch engine, `aiMemory` field, and render validator.
- **Phase 6 (2–3/3) — sound & transitions (`engine/python`, `apps/web-editor`,
  `apps/desktop`).** See [ADR 0021](docs/adr/0021-phase6-sound-and-transitions.md).
  - **Sound:** pure `audio/mixing.py` primitives (fade, peak-normalize, presence
    duck, gain) compose into one per-clip time-varying gain in the compiler. The
    `adjust_audio` op (TS + Python) gained optional fade in/out, mute, normalize, and
    duck-under-track (no new op, no schema change). A master-bus ffmpeg pass
    (`audio/filters.py`: de-noise `afftdn`, loudness presets via `loudnorm`, limiter
    `alimiter`) is threaded through `RenderOptions`, the sidecar `/render` route, the
    CLI (`--denoise`/`--loudness`/`--limiter`), the export IPC/bridge, and the Export
    dialog. The Inspector **Audio** panel sets it all as one reversible patch.
  - **Transitions:** `render/transitions.py` eases the incoming clip in over its
    duration — fade / cross-dissolve (opacity), push / zoom (geometry), blur. The
    compiler combines geometric mask × opacity × transition fade into one alpha mask
    and sets the composite `bg_color` so partial alpha blends. **Opacity now
    renders** (closing the Phase 5 deferral). EffectsPanel adds the Blur transition.
  - **Gated (no new dependency):** advanced sound (EQ, compression, buses, auto-SFX)
    and advanced transitions (beat detection, rhythm/motion-matched, whoosh-sync)
    stay deferred — they need a richer master spec or a new dep (e.g. `librosa`).
- **Phase 6 (1/3) — deterministic color grading (`engine/python`, `apps/web-editor`).**
  Color now renders: a pure `render/color.py` applies a parametric grade
  (exposure / contrast / saturation / temperature / tint / shadows / highlights) to
  each frame via MoviePy `image_transform`, and the compiler wires a clip's
  `color_grade` effect in before the resize/mask. `apply_color_grade` is now
  idempotent by effect id (replace-in-place, mirrored TS + Python) so a grade panel or
  re-applied preset never stacks compounding effects. The Inspector gains a **Color**
  panel (seven controls + Apply/Reset, one reversible patch), and the program monitor
  shows an **approximate** live CSS-filter preview with a **before/after compare**
  toggle (the exact result is the engine render). A pure `.cube` 3D-LUT parser +
  trilinear applier ship and are tested; LUT *file* import wiring is deferred (needs a
  sandboxed-path decision). No schema change, no new dependency. See
  [ADR 0020](docs/adr/0020-phase6-color-grading.md).
- **Phase 5 — motion, masking & object tracking (`engine/python`, `packages/*`,
  `apps/web-editor`).** Five no-dependency slices on top of the keyframe engine; see
  [ADR 0018](docs/adr/0018-phase5-motion-masking-tracking.md).
  - **Animated transforms render.** The compiler applies `scale`/`x`/`y`/`rotation`
    keyframes as time-varying functions (zoom/punch-in, reframing, rotation) and
    static **audio gain** in the mixer. `opacity` is evaluated but its render is
    deferred to Phase 6 fades (reported, not dropped).
  - **AI `punch_in` tool** (TS + Python, parity-tested, surfaced over MCP) and an
    Inspector **keyframe editor** (one-click punch-in + manual add-keyframe) — both
    build keyframes with the same generator and route through validate→apply→record.
  - **Masking.** `add_mask` now carries geometry (bounds/points/feather/opacity/
    invert) + effect keyframes in free-form params (no schema change); a pure
    Pillow rasterizer composites rectangle/ellipse/polygon masks, static or
    **animated** (mask keyframes), with an Inspector mask panel.
  - **Arbitrary-object tracking seam.** `track_object` generalized to any picked
    region; a pluggable tracker (deterministic manual tracker with correction
    interpolation) drives an animated mask/transform via `boxes_to_keyframes`.
    Automatic detection/segmentation is a documented seam pending a CV dependency
    decision (`detect_faces`/`generate_mask` stay unavailable, not faked).
  - No schema change/migration and no new dependency; 100% coverage on the touched
    deterministic modules.
- **Keyframe evaluation engine — easing + interpolation (`packages/editor-core`,
  `engine/python`).** First slice of Phase 5 (Professional Motion). A pure,
  deterministic engine turns a clip's stored `Keyframe` list into a concrete value
  at any time, mirrored in TypeScript (`editor-core/keyframes.ts`) and Python
  (`effects/keyframes.py`). See
  [ADR 0017](docs/adr/0017-keyframe-evaluation-engine.md).
  - Six easing curves (`linear`, `ease-in`, `ease-out`, `ease-in-out`, `hold`,
    `bezier`) with fixed `0→0`/`1→1` endpoints; `interpolate`/`applyEasing` clamp
    out-of-range progress and fall back to `linear` for unknown names.
  - `evaluateKeyframes(keyframes, property, time)`: holds before the first and
    after the last keyframe, eases between two by the **earlier** keyframe's curve
    ("easing into the next keyframe").
  - `punchInKeyframes(...)`: a pure generator for the canonical zoom/punch-in move
    (two `scale` keyframes), fed into `add_keyframes` by the UI/AI layer.
  - No schema change/migration (pure behavior over the existing `Keyframe` shape).
    Both engines stay at 100% coverage.
  - **Fixed along the way:** the Python `Easing` enum used underscored values
    (`ease_in`, …) that could never match the canonical hyphenated easing names in
    the Zod/JSON schema and AI tools; corrected to
    `ease-in`/`ease-out`/`ease-in-out`.
- **Autosave, projects-folder surfacing, and video export (`apps/web-editor`,
  `apps/desktop`).** Three editor-shell gaps closed; works in both the desktop shell
  and a plain browser, degrading gracefully where a capability is absent. See
  [ADR 0016](docs/adr/0016-autosave-folder-surfacing-and-export-ipc.md).
  - **Correct save.** The `useEditor` store's working timeline is now lifted back
    into the app-level `Project`, so Save (and the AI context) persist the *edited*
    timeline rather than the initial seed. Fixes the Phase 8 "Persist edited timeline
    on Save" defect.
  - **Debounced autosave + no manual path.** Edits autosave ~2 s after you stop; a
    path-less project saves under the default projects folder
    (`FRAMEPILOT_PROJECTS_ROOT` or `~/Documents/FramePilot Projects`) with a safe,
    sandboxed file name — no need to pick a location first. In the browser, autosave
    persists to `localStorage` and restores the last project on reload. A save-state
    chip (Saved / Unsaved / Saving…) replaces the old "Draft" chip.
  - **Surface the folder.** The status-bar location is now clickable and the File
    menu gains "Reveal in folder" / "Open projects folder" (Electron
    `shell.showItemInFolder` / `openPath`).
  - **Export video.** A new Export dialog (preset + caption burn-in) renders through
    the desktop bridge → Python sidecar (`POST /render`), reusing the deterministic,
    auto-validated render path and the existing caption burn-in; it saves first
    (the engine renders from disk) and can reveal the output. A failed/invalid render
    is reported, never returned as a usable file. Browser builds explain that export
    is desktop-only instead of failing opaquely.
  - **IPC surface (approved per CLAUDE.md §5).** Four sandboxed channels added to the
    closed contract: `project:save-default`, `project:dir`, `project:reveal`,
    `render:export`. No timeline/project schema change.
- **MCP server — external AI agents can edit FramePilot (`packages/mcp-server`).** A
  new TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server
  (stdio) lets Claude Desktop, Claude Code, or any MCP client open a project, edit the
  timeline, undo/redo, save, and render. The editing tools are **derived from the
  canonical tool registry** (`@framepilot/ai-sdk`) — adding a registered tool exposes
  it over MCP automatically (parity-tested) — plus session tools (`open_project`,
  `save_project`, `undo`, `redo`, `get_patch_history`). Every edit flows through the
  same `validate → apply → atomic save` pipeline as the app (typed reversible patches,
  never raw JSON mutation); project paths are sandboxed to `FRAMEPILOT_PROJECTS_ROOT`;
  rendering delegates to the Python sidecar (no MoviePy in the MCP process). A shared
  `assembleEdit` helper (extracted from the AI orchestrator) is now the single
  patch-assembly path. A new `mcp-engineer` subagent owns the server and its docs. Adds
  the MIT `@modelcontextprotocol/sdk` dependency (`pnpm license:scan` green). See
  [ADR 0015](docs/adr/0015-mcp-server-over-stdio.md) and the
  [MCP server guide](docs/guides/mcp-server.md).
- **Premium, minimal editor UI/UX pass (`apps/web-editor`).** A UI/UX-only
  refinement toward a flagship NLE feel (Premiere/Resolve/CapCut precision, Linear/
  Things restraint). No engine, schema, or validation change — every gesture still
  commits one validated, reversible patch through `useEditor`. See ADR 0014.
  - **Design system + icons.** Consolidated CSS tokens (4px spacing scale, radii,
    elevation, motion `--dur*/--ease*`, track-type hues, z-scale) with a global
    `prefers-reduced-motion` guard; emoji replaced by `lucide-react` (ISC) icons
    centralised in `components/icons.tsx`. Frame-accurate `formatTimecode(s, fps)
    → HH:MM:SS:FF` everywhere (ruler, clips, transport).
  - **Timeline direct manipulation.** Drag-move (incl. cross-track onto compatible
    lanes), edge-trim handles, razor split-on-click, magnetic snapping to clip
    edges/markers/playhead/origin (Alt disables) with a snap-guide, a draggable
    playhead + click-to-seek, an adaptive frame→second→minute ruler, and
    zoom-to-fit / zoom-to-selection — all via existing patch builders.
  - **Keyboard.** A typed shortcut registry (`editor/shortcuts.ts`) drives the key
    handler, tooltips, and a searchable `?` help overlay (single source of truth):
    transport (Space/J/K/L, frame/second steps, Home/End), editing (split, lift/
    ripple delete, ⌘D duplicate, ⌘C/⌘X/⌘V as patches, [ ] trim, , . nudge),
    selection/nav (Tab, ↑/↓ track, Esc), markers, view, history.
  - **Program monitor.** Frame-step, loop, aspect-ratio letterboxing, and a 9:16
    safe-area guide for Reels framing.
  - **Panels & feedback.** Resizable + collapsible side rails (persisted to
    `localStorage`, view-only), a drag-to-scrub number field (inspector gain), a
    clip right-click context menu (split/duplicate/delete/ripple), and non-blocking
    toasts that replace the inline error list (rejected edit → error toast;
    committed edit → success toast with inline Undo).
  - Audio clips show a waveform **skeleton**; real waveforms/thumbnails are deferred
    pending an `Asset`/bridge contract change (no browser-side media compute).
- **Professional editor UI — three-column NLE workspace (`apps/web-editor`).** The
  renderer was reorganized into a Premiere Pro / DaVinci Resolve / Cursor-style
  layout: a top menu bar, a left **library rail** (Media bin · Effects · Overlays ·
  Captions), a center **stage** (program monitor · toolbar · multi-track timeline), a
  right **AI/inspector rail** (AI chat/plan/edit/agent · clip Inspector · Transcript),
  and a bottom status bar. Every panel drives the same patch-engine-backed store, so
  manual and AI edits share one `validate → apply → record` path. See ADR 0013.
  - **Raw-footage import + asset handling.** A new Media bin imports video/audio/image
    files (intrinsic duration probed from an `HTMLMediaElement` over a session-scoped
    object URL), lists them with kind + duration, and places them on the timeline by an
    "Add" button or by dragging a clip onto a lane. Import appends a schema-validated
    `Asset`; placement is a separate, undoable `add_clip` patch (`import.ts`,
    `MediaBin`, `project.ts#addAsset`, `patch-builders.ts#addClipPatch`).
  - **Effects & Overlays panels.** One-click color-grade presets (warm/cool/high
    contrast/B&W) and transitions (fade/cross-dissolve/push/zoom) on the selected clip,
    and text-overlay insertion at the playhead — each a reversible engine patch
    (`EffectsPanel`, `OverlaysPanel`, `applyColorGradePatch`/`addTransitionPatch`/
    `addTextOverlayPatch`).
  - **AI mode selector** surfaces chat / plan / edit / agent; agent stays an explicit
    Phase-7 informational stub (build order, not faked).
  - **Working program monitor (smooth playback).** The preview `<video>` now follows
    the transport: it plays/pauses with the shared play state. During playback the
    element is the **master clock** — the loop reads its `currentTime` and derives the
    playhead, so the two never fight; `currentTime` is only written when paused
    (scrubbing) or on a real source discontinuity. This fixes both the original
    "stuck on one frame" preview and the subsequent flicker from per-frame re-seeks
    (`PreviewPlayer`, `store.ts#setPlaying`).
  - **Keyboard shortcuts (Premiere / Resolve conventions).** Space/K/L/J transport,
    Backspace/Delete lift-delete (Shift = ripple), S or ⌘K split at the playhead,
    ←/→ frame nudge (Shift = one second), Home/End, M marker, =/- zoom, and
    ⌘Z / ⌘⇧Z / ⌘Y undo-redo — each builds a typed patch through the same store path
    as the toolbar; text fields are never hijacked (`editor/useShortcuts.ts`).
  - **Asset deletion.** Each media-bin item has a remove control that lifts the
    asset's timeline clips (one undoable patch) and then drops the bin entry, so
    deleting media never strands a clip on a missing source (`MediaBin`,
    `project.ts#removeAsset`, `patch-builders.ts#removeAssetClipsPatch`).
  - Coverage held at 100% on the core deterministic modules; the web-editor suite grew
    to 164 tests (import logic, panels, asset deletion, timeline drag-drop, keyboard
    shortcuts, AI agent-mode, transport/preview sync).
- **AI layer — Phase 4 (AI infrastructure, modes, and Review UX).** The AI editing
  layer now sits on top of the timeline/patch engine, enforcing AGENTS.md invariant 5
  end to end: the AI edits **only** through registered, schema-validated tools and the
  human reviews every patch before it applies.
  - **Tool registry (`packages/ai-sdk` + `engine/python/.../ai_tools` mirror).** Each
    tool carries a Zod (TS) / Pydantic (PY) input schema that both validates untrusted
    arguments (strict — unknown args rejected) and is the source the advertised JSON
    Schema is derived from, so the two cannot drift. Mutating tools return typed,
    reversible `Operation`s; read tools return project data; `render_preview`/
    `export_video` are actions. `analyze_silence`, `detect_scenes`, `detect_faces`, and
    `generate_mask` are registered but `available: false` (their engine is Phase 5+) —
    the orchestrator refuses to invoke them rather than fake a result (build order).
  - **Orchestrator (PRD §8.2).** Implements `chat`, `plan`, `edit`, and `autocomplete`.
    It is the **sole** component that turns a model's tool calls into a patch: it
    validates each call's args, runs the tool handler, assembles the `Patch`, runs
    `validatePatch`, and computes a before/after diff. A provider can never return a
    patch, so the tool boundary is structural. `agent`/`review` remain Phase 7 stubs.
  - **Context builder + memory store.** The context builder assembles a deterministic
    `[system, context]` prompt (timeline summary, transcript, selection, platform,
    learned memory). The memory store (PRD §8.7) reads/writes the **existing**
    `Project.aiMemory` field — brand/caption style, pacing, audience, platforms, and
    accepted/rejected edits — with **no schema change / no migration**.
  - **Providers via `fetch` (no SDK dependency).** The Anthropic (Messages API) and
    NVIDIA NIM (OpenAI-compatible) providers call the HTTP APIs directly with an
    injected `fetch` (unit-tested offline); the deterministic `mock` provider stays the
    default. No new runtime dependency added.
  - **Review UX (`apps/web-editor`).** A new **AI** rail panel runs chat/plan/edit
    against the orchestrator and shows a proposed edit as **what / why / before-after**
    with **Apply / Reject**. Apply routes through the same `validate → apply → record`
    store path as a manual edit (so Undo works); Apply/Reject are recorded to project
    memory as learning signals.
  - **Coverage.** TS ai-sdk deterministic modules and the Python `ai_tools`
    schemas/validation/handlers are at **100%**; `pnpm verify` is green (all TS suites +
    268 engine tests). See [ADR 0012](docs/adr/0012-ai-tool-boundary-and-orchestrator.md).
- **Caption burn-in render-wiring — Phase 3.3 (completes Phase 3).** The
  deterministic render engine can now burn caption-track text into a rendered
  output. A new pure module `engine/python/.../render/captions.py` reconstructs a
  caption's text from `project.transcript` by time-range overlap (the same rule
  the editor preview uses) and rasterizes it to an overlay with Pillow's bundled
  font (deterministic, no system-font/ImageMagick dependency, no new package).
  `compile_timeline(..., burn_captions=…)` composites the overlays in the lower
  safe area; the flag is threaded through `RenderOptions`,
  `render`/`render_preview`/`export_video`, the sidecar `/render` and
  `/render/preview` routes, and the CLI (`framepilot render --burn-captions`).
  Soft captions remain the default, so existing renders/goldens are unchanged. A
  caption-timing golden asserts captions appear **only** during their range. **No
  schema change** — caption *style/template* persistence is still deferred to a
  future migration. See
  [ADR 0011](docs/adr/0011-caption-burn-in-render-wiring.md).
- **Cross-language schema sync via an exported JSON Schema (PLAN §1.1).** The TS
  Zod schema (`packages/timeline-schema`) is now the single source of truth for
  the project/timeline data model, and the cross-language contract is a JSON
  Schema *exported from it* (not hand-maintained): `buildProjectJsonSchema()`
  uses `zod/v4`'s native `z.toJSONSchema` (no new dependency), output committed at
  `packages/timeline-schema/schema/project.schema.json` and regenerated via
  `pnpm --filter @framepilot/timeline-schema schema:generate`. A TS drift guard
  (`src/json-schema.test.ts`) asserts regenerated == committed, and a Python
  parity guard (`engine/python/tests/test_schema_parity.py`) asserts the Pydantic
  field-name sets equal the JSON Schema property sets at every level. See
  [ADR 0008](docs/adr/0008-cross-language-schema-sync-via-json-schema.md).
- **Electron desktop shell — Phase 3.1.** The main process is split into small,
  dependency-injected, unit-tested modules under `apps/desktop/electron/` with
  `main.ts` as thin glue: a typed, secure IPC contract (`ipc/contract.ts` — closed
  channel set + `window.framepilot` bridge type, no Electron import); a Python
  sidecar lifecycle manager (`sidecar/manager.ts` — `SidecarManager`
  spawn/health-poll/shutdown state machine with injected spawn/probe/sleep);
  recent-files + crash-recovery stores (`projects/recent-files.ts`,
  `projects/recovery.ts` — injected IO; recovery snapshots the last validated +
  saved project, cleared on clean quit so it survives a crash); and an auto-update
  channel scaffold (`updater/channel.ts` — channel resolution + provider seam, no
  updater dependency yet). 30 tests, 100% coverage on the logic modules. See
  [ADR 0009](docs/adr/0009-desktop-main-process-architecture.md).
- **Manual editor UI — Phase 3.2/3.3.** `apps/web-editor` is now a full manual
  non-linear editor: import a video or create a project, scrub a preview, edit a
  multi-track timeline (trim / split / delete / ripple / move / snap / zoom /
  markers), inspect clips (transform / effects / audio, with audio gain wired to
  `adjust_audio`), and build captions from a transcript (word-level timestamps,
  templates, keyword highlight, burn-in preview, playhead-synced transcript with
  click-to-seek). It is structured as a **pure, framework-agnostic core**
  (`src/editor/`: `store`, `selectors`, `patch-builders`, `captions`, `project`,
  `bridge`) at 100% unit-test coverage plus **thin React components**
  (`src/components/`: Toolbar, TimelineView, PreviewPlayer, Inspector,
  TranscriptView, CaptionEditor, Editor, App). **Every edit — manual or AI —
  flows through one validated, reversible pipeline:** `store.applyUserPatch` runs
  validate → apply → record via `@framepilot/editor-core`, so a manual edit is
  validated before apply and recorded with its inverse (undo/redo), exactly like an
  AI-proposed patch (AGENTS invariant 3); there is no second, unchecked path that
  mutates the timeline. Preview honors render-vs-preview (HTML `<video>` + overlay
  text, never MoviePy — PRD §9.2), and project New/Open/Save go through the desktop
  bridge (`window.framepilot`) with a graceful non-Electron fallback and schema
  validation of opened projects. 92 tests, 100% coverage on the pure core. See
  [editor-ui.md](docs/architecture/editor-ui.md) and
  [ADR 0010](docs/adr/0010-renderer-editor-pure-core-thin-shell.md).
- **Deterministic render & media pipeline (Phase 2).** The Python engine can now
  take a project from file to a validated rendered video, end to end:
  - **Media inspection (PLAN §2.1):** `inspect-media` ffprobe wrapper returning a
    typed `MediaInfo` (duration/fps/resolution/streams), and a sandboxed asset
    indexer (`index_assets`) that resolves every asset through the path sandbox.
  - **Render engine (PLAN §2.2):** a deterministic Timeline→MoviePy compiler
    (video + audio tracks, letterbox-fit to the export preset; caption/overlay/
    effect tracks reported as deferred, never silently dropped) and a `render`
    driver that walks the full job lifecycle (queued → preparing_assets →
    rendering_frames → encoding → validating_output → completed/failed), plus
    `render_preview`/`export_video` wrappers and the 9:16 / 1:1 / 16:9 presets.
  - **Render validation (PLAN §2.3, PRD §9.4):** every render is checked before it
    is reported complete — file exists / non-empty, expected duration within
    tolerance, video/audio streams present, near-fully-black detection
    (`blackdetect`), and audio-clipping detection (`volumedetect`).
  - **Sidecar & CLI (PLAN §2.4):** a FastAPI service (`/render`, `/render/preview`,
    `/validate-render`, `/inspect-media`, `/health`) and the `framepilot`
    CLI (`render`/`validate-render`/`inspect-media`/`serve`) with typed pydantic
    IPC models and JSON output.
  - **Python `ProjectFile` atomic IO (PLAN §1.1 prerequisite):** `load`/`save`
    with temp-file + fsync + atomic rename and the `schemaVersion` envelope
    mirrored from the TS serializer.
  - **Derived media (PLAN §2.1):** low-res proxy generation, audio waveform
    extraction (decoded-PCM → normalised per-bucket peaks), and single-frame /
    evenly-spaced thumbnail extraction.
  - **Background render queue (PLAN §2.2):** `RenderQueue` — submit / poll / list,
    cancel (queued *and* running), retry + bounded auto-retry, and a
    multiprocessing executor that enforces timeouts/cancellation by terminating
    the encode process.
  - **Golden-media tests (PLAN §2.3):** perceptual average-hash + Hamming-distance
    frame comparison with a committed fixture, so a deterministic render is
    asserted frame-correct within tolerance (robust to ffmpeg/codec drift).
  - **Python operation + patch-validator mirror (PLAN §1.2/§1.4):** the full
    `apply`/`invert` operation set and `validate_patch` ported to Python from the
    TS `editor-core` (apply→invert round-trips proven), so the render engine and
    the editor share one operation + validation semantics.

  100% test coverage on every new/implemented module; engine ruff/mypy clean;
  216 tests pass.
- Canonical `.agents/` layout for agent assets: shared skills, rules, slash
  commands, Claude/Codex subagents, and OpenCode config now live under one tree,
  with harness folders acting as adapters.
- **Timeline + patch engine (Phase 1, no AI).** The `@framepilot/editor-core`
  engine: 14 typed, pure, immutable timeline operations plus a `restore_clips`
  inverse primitive, each with `apply` and `invert` (PRD §8.3, PLAN §1.2);
  transactional `applyPatch`, `invertPatch`/`revertPatch`, before/after
  `diffTimeline`, and an undo/redo history stack persisted in the project file
  (PRD §8.4, PLAN §1.3); and `validatePatch` covering every PRD §8.5 check with
  typed, actionable errors (PLAN §1.4). 100% test coverage on all four core
  modules.
- **Schema versioning, migrations, and `project.fp.json` IO (PLAN §1.1).** A
  forward-migration framework keyed on a `schemaVersion` envelope, pure
  serialize/deserialize helpers, atomic (temp-file + rename) file read/write
  exposed via the `@framepilot/timeline-schema/file` subpath, and golden-fixture
  round-trip tests.
- Reversibility design recorded in
  [ADR 0006](docs/adr/0006-reversible-operations-via-restore-clips.md).

### Fixed
- **Python timeline model drift vs the TS source of truth**, caught by the new
  schema-parity guard: the transcript word field was `text` (now `word`),
  `Keyframe.id` was missing (now present), and `assets` was an untyped
  `list[dict]` (now a typed `Asset` model). See
  [ADR 0008](docs/adr/0008-cross-language-schema-sync-via-json-schema.md).
- **`tsc -b --noEmit` TS6310 failure.** Composite-package `typecheck` scripts ran
  `tsc -b --noEmit`, but `--noEmit` is illegally forced onto *referenced* composite
  projects (TS6310: "Referenced project may not disable emit"); they now run
  `tsc -b`. ESLint also now honors `_`-prefixed intentionally-unused bindings.
- Root `pyproject.toml` declared the same package name (`framepilot-engine`) as
  its `engine/python` workspace member, breaking `uv sync` ("two workspace
  members…"). The root is now the non-package workspace root `framepilot-workspace`
  (`package = false`), hosting only shared tooling config. Engine enums modernised
  to `StrEnum` and the `Union[...]` operation alias to `X | Y` to satisfy the
  pinned ruff; a scoped mypy override ignores missing stubs for the untyped
  `moviepy`/`imageio_ffmpeg` libraries.

- Initial production-ready project scaffold (Phase 0): monorepo layout, build/lint/
  typecheck/test tooling, Electron desktop + React web-editor + shared packages,
  Python render-engine package, multi-provider AI config (Anthropic, NVIDIA, mock),
  agent instruction files and skills (incl. security & correctness), `plan/PLAN.md`
  master plan, full `docs/` tree, CI/CD quality gates, Playwright E2E harness,
  governance docs, and MIT license.

