# Editor capability and property registry

`EDITOR_CAPABILITIES` is FramePilot's machine-readable answer to “what can the editor do here?” It
describes implemented editorial commands and editable properties without asking a model to infer
support from tool descriptions.

Each entry declares:

- a stable capability id, domain, and target kinds;
- value kind, unit, bounds, and default where applicable;
- whether the capability is keyframeable, inspectable, and editable;
- the semantic command compiler or tool compiler, patch verifier, inverse path, and emitted
  operation types;
- an availability state and a non-empty reason.

An available editable entry is invalid unless all executable links are present. This makes
“available” an engineering claim rather than roadmap prose.

## Current manifest

The initial manifest contains only shipped contracts:

- all 12 professional timeline commands compiled by `compileEditorCommand` and exposed through
  `professional_edit`;
- clip `scale`, `x`, `y`, `rotation`, and `opacity` animation properties from
  `CLIP_KEYFRAME_PROPERTIES`;
- the seven parametric color-grade properties from `COLOR_GRADE_PARAMETER_CONTRACTS`;
- clip gain from `AUDIO_PARAMETER_CONTRACTS`.

Property bounds come directly from editor-core's renderer-facing value contracts. Command types
come from `EDITOR_COMMAND_TYPES`. The manifest therefore cannot gain a second hand-maintained list
of these values.

## Discovery

```ts
import { listEditorCapabilities } from '@framepilot/ai-sdk';

const editableClipMotion = listEditorCapabilities({
  domain: 'motion',
  appliesTo: 'clip',
  availability: 'available',
  editable: true,
});
```

Callers receive a filtered array and never parse model-facing prose. Planned or unavailable
capabilities may be registered later, but must say why they are not available and must not be
presented as executable.

## Drift gate

`editorCapabilityDriftIssues` compares the manifest with the live tool registry and runtime
professional command roster. It reports duplicate ids, missing or unavailable/non-mutating tools,
and implemented commands omitted from discovery. Unit tests also prove the professional tool's
intent enum and command manifest remain one-to-one.

This is the first drift layer. Schema-to-doc and capability-to-professional-eval generation remain
open work in P1.2/P3; they are not implied by this API.
