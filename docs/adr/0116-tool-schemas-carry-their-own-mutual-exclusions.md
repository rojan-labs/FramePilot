# 0116. Tool schemas carry their own mutual exclusions

- Status: Accepted
- Date: 2026-08-14

## Context

`professional_audio` has six intents, and each owns exactly one family of settings:
`level` owns gain and fades, `eq` owns bands, `compress` owns dynamics, `automate_gain`
owns the lane, the ducking intents own `reductionDb` and the roles. The objective schema
was one flat object with every setting optional, and the families were enforced in a
`superRefine`.

Zod cannot express a refinement in JSON Schema, so the schema advertised to the model
said the opposite of the rule: every setting, legal for every intent. A model asked to
mix a montage filled in what looked useful and got back twelve refusals at once —

```
eqBands: eqBands is only valid for the eq intent.; dynamics: dynamics is only valid for
the compress intent.; gainDb: An automation lane sets the level over time; ...
```

— none of which it could have predicted from what it was given. Worse, the bounded repair
pass reads the same schema, so it authored the same call again and the run ended with
"Temporal repair did not produce a valid patch", discarding an edit that was otherwise
complete.

## Decision

A tool whose arguments are mutually exclusive expresses that in the schema the model
reads, not only in the validator behind it. `AudioObjectiveSchema` is now a discriminated
union on `intent` — one strict variant per intent, carrying only its own fields and
requiring what it needs — republished as `{ type: 'object', oneOf: [...] }`, matching
`map_time`'s existing contracted shape and the registry invariant that every tool
advertises an object.

Refusals still teach: a field filed under the wrong intent is answered with the intent
that owns it and the instruction to make a separate call, from one `AUDIO_FIELD_OWNERS`
map rather than a dozen hand-written refinement branches.

The controller keeps reading a single flat `AudioObjective` shape, with a compile-time
assertion that every variant satisfies it, so resolution does not have to narrow before
asking whether a gain was authored.

## Consequences

An illegal combination is no longer representable in the arguments the model can author,
so the most common failure mode of this tool is gone rather than better-explained.

The variants repeat `intent` and `target`, which costs about 480 tokens in the tool
block — roughly 3% of a typical turn's prompt, and it is part of the cache-key prefix, so
the frozen golden sessions were re-recorded. That is worth paying: a rejected call costs
a full turn plus a repair turn, and could cost the whole run.

Field descriptions in these schemas are load-bearing and priced per turn. Keep them
short.
