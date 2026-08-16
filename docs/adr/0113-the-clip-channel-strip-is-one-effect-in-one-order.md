# ADR 0113 — The clip channel strip is one effect, in one stated order

- Status: Accepted
- Date: 2026-08-12
- Supersedes: none
- Related: [ADR 0111](0111-audio-track-roles-are-authored-never-inferred.md),
  `plan/PROFESSIONAL-EDITOR-CONTROL-PLANE.md` §P2 Audio

## Context

Per-clip audio already carried gain, mute, peak normalization, fades, and sidechain ducking, all
stored on one canonical `audio_gain` effect and composed by the render compiler into a single
per-sample envelope. Finishing professional audio required two more processors — EQ and compression
— plus automation: a level that moves over time rather than sitting at one value.

Three questions had to be answered before any of it could be written, and none of them has a
neutral default.

**Where do the new settings live?** They could each become their own effect type (`audio_eq`,
`audio_dynamics`), or extend the existing one.

**How is a lane persisted?** As a new array of points in the effect's params, or as keyframes on
the effect's existing `keyframes` lane.

**What order does the renderer run them in, and what happens when a lane and a static gain both
claim the same parameter?** Both orderings are defensible and both are wrong for someone.

## Decision

**One effect.** EQ and compressor settings extend the canonical `audio_gain` effect's params. A
clip's audio is a channel strip: the parts are edited together, inverted together, and read together
by the renderer. Three effects would mean three canonical ids to keep in step, three merge rules, and
a real possibility of a clip carrying a compressor whose gain layer has been replaced out from under
it.

**Lanes are keyframes.** An automation lane is written to `Effect.keyframes` with the property name
`gainDb`. That field is already the schema's lane shape, with an easing vocabulary and an evaluator
that TypeScript and Python share point for point. A parallel array of points would be a second curve
format to keep in sync with the first, and the keyframe UI could never show it.

**One order, stated once:**

```
mute → normalize → EQ → compressor → fader (gain or automation, fades, ducking)
```

**Gain is a fader move.** It runs after the compressor, so the threshold is measured against the clip
at its recorded level. Lowering a clip's level does not quietly stop it compressing.

**An automation lane supersedes the static gain** for as long as it runs, rather than multiplying
with it. Authoring both in one command is refused; so is setting a static level on a clip that
already has a lane. The rejection names the fix — clear or re-author the lane.

## Consequences

A clip with no EQ and no compressor renders byte-identically to before: the scalar-gain fast path is
untouched, and samples are only materialised when a processor genuinely needs the whole buffer (an
FFT has no meaning on an arbitrary time slice, and a compressor's envelope depends on what preceded
it).

The refusal to accept a lane and a static level together is the one place this design is less
permissive than a mixer. It is deliberate, and it is the same rule the rest of this initiative
follows: when one parameter has two authored answers, fail closed and name the fix rather than pick
silently. Picking silently would mean a level change that does nothing audible — the failure mode
that is invisible in the timeline and only discovered on playback.

EQ is a zero-phase magnitude curve built from the analog (RBJ) prototypes and applied through the
real FFT. No group delay, so corrective EQ cannot smear a transient or shift sound against picture;
no cramping near Nyquist, so a 16 kHz shelf means the same thing at 44.1 kHz and 48 kHz. It is not a
phase-accurate model of an analog desk and does not claim to be.

The compressor's detector runs on 1 ms block peaks rather than per sample. The attack/release
recursion is genuinely sequential — the two time constants depend on whether the signal is rising or
falling, so no vectorised form exists — and a per-sample Python loop would be unusable. 1 ms is
therefore also the contract's minimum attack: every attack an editor can author is one the envelope
can actually follow, instead of a setting the export quietly rounds away.

## Correction (2026-08-13, from code review)

The first implementation rebuilt the canonical effect from the operation alone, which meant the
legacy gain-only `adjust_audio` — whose tool emits exactly `{clipId, gainDb}` — silently deleted any
EQ, compressor, or lane on the clip. The doc comment already claimed "absent leaves it untouched";
the code did not. Both runtimes now carry the processors forward when the operation omits them, and
removal is said explicitly with an empty `eq.bands` or an empty `automation.points`.

The general rule this is an instance of: when one verb's vocabulary grows, the verbs that predate
the growth keep their old scope. Silence about a processor is not a request to remove it.

## Alternatives considered

**A trim lane that multiplies with the fader.** Both controls would stay meaningful and no refusal
would be needed. Rejected because a point reading "-6 dB at 0:03" would then not mean the clip plays
at -6 dB there, which is what an editor authoring a lane expects and what the reviewer's evidence
measures.

**Separate effect types per processor.** Cleaner-looking, and genuinely better if the processors
were independently orderable. They are not: the order is fixed by this ADR, so the separation would
buy nothing and cost three canonical ids.

**A digital biquad EQ via `scipy.signal.lfilter`.** The conventional implementation, and phase
behaviour closer to hardware. Rejected because scipy is not a dependency and adding one for this
needs a licence review it does not merit, and because IIR recursion in pure numpy is not viable at
audio rates.

**Bumping the schema version.** Considered and rejected: `Effect.params` is an open record and
`Effect.keyframes` already exists, so nothing in the persisted shape changes. A version bump with a
no-op migration would be ceremony, and would force every fixture to move for no gain in safety. The
typed contract still exists — it lives in the operation contract and its Python mirror, which is
where the other audio rules already live.
