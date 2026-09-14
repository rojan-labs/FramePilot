"""The structured shot description — one schema, three producers (plan VU6.2/VU6.3).

WHY THIS MODULE EXISTS AT ALL

Tier 2 used to be a free-text caption. The prompt asked for "≤2 sentences" of prose, the
answer was stored as a string, and everything downstream had to guess: a filter could not
ask "which shots are wide", a solver could not read on-screen text, and two producers (the
hosted captioner and TwelveLabs) emitted subtly different prose that nothing could compare.
The prose prompt is deleted; this module is what replaced it.

The contract is a **JSON schema**, not a sentence. It is used three ways, and the point is
that all three are the same object:

- the local ``framepilot.visual-describe`` Capability Pack constrains generation with
  llama.cpp's JSON-schema grammar, so a small VLM *cannot* emit anything else;
- the hosted captioner passes it as an Anthropic tool ``input_schema`` or an OpenAI
  ``response_format: json_schema``;
- TwelveLabs, which produces span prose and nothing else, maps that prose into ``summary``
  and leaves every other field empty rather than inventing one.

Every producer's output goes through :func:`parse_described`, which is the only place that
turns a model's JSON into :class:`~framepilot_engine.brain.ledger_models.DescribedFacts`.
Normalisation lives there so a field can never mean one thing locally and another thing
hosted: unknown vocabulary is DROPPED rather than stored, and the confidence bucket is a
three-way enum rather than a float the model would invent precision for.

**Nothing here claims caption quality.** The vocabularies and the prompt are a starting
calibration; no weight has been run through them and the VU6.5 accuracy targets are
unmeasured.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final

from framepilot_engine.brain.ledger_models import (
    TIER2_VERSION,
    CameraFacts,
    CameraMovement,
    DescribedFacts,
    ShotSize,
)

__all__ = [
    "CAMERA_ANGLES",
    "CONFIDENCE_BUCKETS",
    "DESCRIBED_JSON_SCHEMA",
    "DESCRIBED_SCHEMA_NAME",
    "DESCRIBE_INSTRUCTION",
    "MAX_FIELD_CHARS",
    "MAX_KEYFRAMES_PER_SHOT",
    "MAX_ON_SCREEN_TEXT_ITEMS",
    "MAX_QUALITY_ITEMS",
    "MAX_SUMMARY_CHARS",
    "MIN_ECHO_CHARS",
    "MIN_MULTI_FRAME_SPAN",
    "MIN_ON_SCREEN_ECHO_CHARS",
    "PLACEHOLDER_ON_SCREEN_TEXT",
    "QUALITY_VOCABULARY",
    "UNKNOWN",
    "DescribedParseError",
    "described_from_summary",
    "keyframe_times",
    "parse_described",
]

#: The sentinel a closed-vocabulary field carries when the model has nothing to say. An
#: explicit value rather than an omitted key because OpenAI's strict JSON-schema mode
#: requires every property to be present — and because "the model declined" and "the field
#: was lost in transport" must not look the same. It is mapped to ``None`` on the way into
#: the ledger, where absence is the honest representation.
UNKNOWN: Final = "unknown"

#: Closed vocabulary for ``quality``. Editorially useful and observable from one frame;
#: deliberately small, because a list a model can enumerate is a list it can be scored
#: against. Anything else the model emits is dropped, not stored.
QUALITY_VOCABULARY: Final[tuple[str, ...]] = (
    "well-lit",
    "dim",
    "overexposed",
    "underexposed",
    "backlit",
    "sharp",
    "soft-focus",
    "motion-blur",
    "noisy",
    "shaky",
    "high-contrast",
    "flat",
)

#: Closed vocabulary for ``camera.angle``. ``camera.shotSize`` and ``camera.movement``
#: reuse the ledger's own enums, so a tier-2 shot size is directly comparable with tier 1's.
CAMERA_ANGLES: Final[tuple[str, ...]] = (
    "eye-level",
    "high",
    "low",
    "overhead",
    "dutch",
    "over-the-shoulder",
    "pov",
)

#: The model's self-rated confidence, as three words rather than a number. A small VLM
#: asked for a float invents precision it does not have; three buckets is what the plan
#: (VU6.2) specifies, and ``p`` is a hint the renderer may print — never a gate.
CONFIDENCE_BUCKETS: Final[dict[str, float]] = {"low": 0.5, "medium": 0.7, "high": 0.9}

#: Hard caps applied after whitespace collapse. A description is stored on every shot of
#: every asset, so a runaway field is a bloated ledger rather than a richer one.
#: ``MAX_ON_SCREEN_TEXT_ITEMS`` is also the schema's array bound, so the grammar and the
#: parser agree on one number rather than trimming to a limit generation never reached.
MAX_SUMMARY_CHARS: Final = 400
MAX_FIELD_CHARS: Final = 160
MAX_ON_SCREEN_TEXT_ITEMS: Final = 16
MAX_ON_SCREEN_TEXT_CHARS: Final = 200
MAX_QUALITY_ITEMS: Final = 6

#: Shorter than this, a field matching the instruction (or the shot's own prose) is a
#: coincidence ("sky"), not a copy. Mirrored in the worker's ``policy.py``.
MIN_ECHO_CHARS: Final = 8

#: Same idea, one field over: an ``onScreenText`` line this short can share every token
#: with the shot's own narrated prose by pure coincidence ("EXIT", "STOP"), and the cost of
#: dropping something real is worse than keeping one short coincidental line. A longer line
#: that is STILL a pure subset of the prose is almost never real on-screen text — a sign,
#: slate or lower-third virtually always contributes at least one token (a proper noun, a
#: number) the model's own summary/subject/action/setting never used.
MIN_ON_SCREEN_ECHO_CHARS: Final = 8

#: Sentinel values a model emits when it has nothing to transcribe but the grammar forbids
#: an empty string in the array (``minLength: 1``, see the schema below). Normalised to
#: "no line", never stored as content: a literal "unknown" quoted back to the editor as
#: on-screen text is exactly the invented-caption failure this module exists to close.
PLACEHOLDER_ON_SCREEN_TEXT: Final[frozenset[str]] = frozenset({
    "unknown",
    "none",
    "n/a",
    "na",
    "no text",
    "no visible text",
    "no on-screen text",
    "nothing",
    "empty",
    "no text visible",
    "not applicable",
})

DESCRIBED_SCHEMA_NAME: Final = "shot_description"

#: The instruction every producer sends. It keeps the discipline the deleted
#: ``CAPTION_INSTRUCTION`` had — state only what is visible, no intent, no narration — and
#: adds the two rules the structure needs: on-screen text is transcribed verbatim, and the
#: closed vocabularies are closed. Changing this wording changes what the whole tier-2
#: surface can be asked about, so it is versioned with ``TIER2_VERSION``.
#:
#: WHY IT NAMES NO FIELD. The previous wording carried a ``field: hint.`` line per field
#: ("summary: at most two sentences…", "subject: who or what the shot is of."). Under a
#: JSON grammar a small VLM treats those as the values to emit: the local SmolVLM2-2.2B
#: pack, on real camera keyframes at temperature 0, returned the hints VERBATIM in every
#: free-text field of every shot — "subject": "who or what the shot is of". The same frames
#: with this wording are described correctly. The field meanings already live in the
#: schema's own ``description``s, which the grammar sees and the model does not copy.
DESCRIBE_INSTRUCTION: Final = (
    "Describe this video shot from its keyframes for an editor's index. "
    "State only what is visibly on screen: no intent, no story, no narration, no guessing "
    "at what happens next. Transcribe any legible on-screen text VERBATIM, never "
    "paraphrased, and leave that list empty when there is none. For camera and quality "
    "choose only from the allowed values, and choose unknown rather than guessing."
)


def _enum(values: Sequence[str], *, allow_unknown: bool = True) -> list[str]:
    return [*values, UNKNOWN] if allow_unknown else list(values)


#: The wire schema. Every property is required and ``additionalProperties`` is false at
#: every level, because that is what OpenAI's strict mode and llama.cpp's grammar
#: conversion both need; optionality is expressed with :data:`UNKNOWN`, not by omission.
DESCRIBED_JSON_SCHEMA: Final[dict[str, Any]] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "summary",
        "subject",
        "action",
        "setting",
        "camera",
        "mood",
        "onScreenText",
        "quality",
        "confidence",
    ],
    "properties": {
        "summary": {
            "type": "string",
            "description": "At most two sentences describing only what is visible.",
        },
        "subject": {"type": "string", "description": "Who or what the shot is of."},
        "action": {"type": "string", "description": "What the subject is doing."},
        "setting": {"type": "string", "description": "Where the shot takes place."},
        "camera": {
            "type": "object",
            "additionalProperties": False,
            "required": ["shotSize", "angle", "movement"],
            "properties": {
                "shotSize": {"type": "string", "enum": _enum([s.value for s in ShotSize])},
                "angle": {"type": "string", "enum": _enum(CAMERA_ANGLES)},
                "movement": {
                    "type": "string",
                    "enum": _enum([m.value for m in CameraMovement]),
                },
            },
        },
        "mood": {"type": "string", "description": "The visual feel of the frame."},
        # WHY BOTH ARRAYS ARE BOUNDED, AND WHY onScreenText FORBIDS AN EMPTY STRING:
        # these are grammar constraints, not documentation. An unbounded array of strings
        # lets a decoder that has run out of things to say keep emitting `""`, forever,
        # because the grammar says another item is always legal. Measured on
        # SmolVLM2-2.2B: it filled `onScreenText` with empty strings until `--n-predict`
        # ran out, leaving the object unterminated and every describe call failing as
        # "not valid JSON". The bound is what makes closing the array reachable.
        "onScreenText": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
            "maxItems": MAX_ON_SCREEN_TEXT_ITEMS,
            "description": "Text legible in frame, verbatim. Empty when there is none.",
        },
        "quality": {
            "type": "array",
            "items": {"type": "string", "enum": list(QUALITY_VOCABULARY)},
            "maxItems": len(QUALITY_VOCABULARY),
            "description": "Observable defects or virtues, from the closed list only.",
        },
        "confidence": {"type": "string", "enum": list(CONFIDENCE_BUCKETS)},
    },
}


#: Keyframes a shot is described from, and the rules for choosing them. Shared by BOTH
#: producers on purpose: the hosted arm and the local pack must be handed the same
#: evidence, or their rows are not comparable and "hosted and local agree" is untestable.
#: The local pack mirrors these in ``workers/visual-describe/src/.../policy.py`` and
#: ``tests/test_described_drift.py`` proves the two agree frame for frame.
MAX_KEYFRAMES_PER_SHOT: Final = 3
#: A span shorter than this is described from ONE frame: three frames of a third of a
#: second are the same picture three times.
MIN_MULTI_FRAME_SPAN: Final = 0.5
#: Kept off both ends of a span. The first and last frames of a shot are the ones a cut or
#: a dissolve contaminates, and a description of a half-faded frame describes the
#: transition rather than the shot.
EDGE_INSET: Final = 0.08


def keyframe_times(
    t0: float, t1: float, *, max_frames: int = MAX_KEYFRAMES_PER_SHOT
) -> list[float]:
    """The 1-3 source seconds a shot is described from (VU6.2).

    First, middle and last of the span — a single keyframe cannot show what a shot *does*,
    and "man at a desk" and "man stands up and leaves" have the same first frame. A still,
    or any span too short for three distinct pictures, gets one frame at its midpoint.

    Every returned time lies strictly inside ``[t0, t1)``, so a frame is never decoded from
    the next shot.

    :raises ValueError: If the span is not positive, or ``max_frames`` is out of range.
    """
    if t1 <= t0:
        raise ValueError(f"a shot span must be positive, got [{t0}, {t1})")
    if not 1 <= max_frames <= MAX_KEYFRAMES_PER_SHOT:
        raise ValueError(f"max_frames must be 1..{MAX_KEYFRAMES_PER_SHOT}, got {max_frames}")
    duration = t1 - t0
    middle = t0 + duration / 2.0
    if duration < MIN_MULTI_FRAME_SPAN or max_frames == 1:
        return [middle]
    inset = min(EDGE_INSET, duration / 4.0)
    times = [t0 + inset, t1 - inset] if max_frames == 2 else [t0 + inset, middle, t1 - inset]
    ordered: list[float] = []
    for time in times:
        bounded = min(max(time, t0), t1 - 1e-6)
        if not ordered or bounded > ordered[-1]:
            ordered.append(bounded)
    return ordered


class DescribedParseError(Exception):
    """A producer returned something that is not a shot description.

    Raised only for a body that cannot be read at all — a non-object, or a missing/empty
    ``summary``. Everything else is normalised: an out-of-vocabulary quality word is a
    model being loose, not a protocol violation, and dropping it is a better answer than
    failing a whole batch of shots.
    """


def _text(value: Any, limit: int) -> str:
    """Whitespace-collapse and hard-cap one free-text field. Non-strings become ``''``."""
    if not isinstance(value, str):
        return ""
    collapsed = " ".join(value.split())
    return collapsed[:limit].rstrip() if len(collapsed) > limit else collapsed


def _described(value: Any, limit: int) -> str:
    """A free-text field, or ``""`` when the model only repeated the instruction back.

    Mirrors the worker's ``policy._described`` (VU6.2 local pack, R2): measured on the
    local SmolVLM2-2.2B pack with real camera keyframes, the model returned the prompt's
    own wording as every free-text value under the grammar. A hosted producer is far less
    likely to do this, but ``parse_described`` is the ONE funnel all three producers pass
    through, so the guard belongs here too rather than only in the local pack's own
    pre-filter.
    """
    text = _text(value, limit)
    probe = text.lower().rstrip(".")
    if len(probe) >= MIN_ECHO_CHARS and probe in DESCRIBE_INSTRUCTION.lower():
        return ""
    return text


def _closed(value: Any, vocabulary: Sequence[str]) -> str | None:
    """One closed-vocabulary value, or ``None`` for unknown/out-of-vocabulary.

    ``None`` rather than a nearest match: a shot size the model did not choose must not be
    invented here, or tier 2 would disagree with tier 1 for a reason no one can trace.
    """
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if candidate in vocabulary else None



def _is_placeholder_on_screen_text(text: str) -> bool:
    """Whether ``text`` is a sentinel for "nothing legible" rather than real content.

    The schema forbids an empty string in the array (``minLength: 1``), so a model with
    nothing to transcribe sometimes writes the word for that instead — ``"unknown"``,
    ``"none"``, ``"n/a"`` — rather than leaving the array empty as instructed. Quoting that
    back to the editor as on-screen text IS the invented-caption failure this module
    exists to close, so it is normalised to absent here, at the one funnel every producer
    passes through.
    """
    normalised = text.strip().lower().rstrip(".")
    return normalised in PLACEHOLDER_ON_SCREEN_TEXT


def _is_prose_echo(text: str, prose_tokens: frozenset[str]) -> bool:
    """Whether ``text`` looks copied from the shot's own narrated fields, not read off-frame.

    A model that has nothing to transcribe sometimes fills ``onScreenText`` with words
    lifted from its own ``summary``/``subject``/``action``/``setting``/``mood`` rather than
    leaving the array empty. Real on-screen text — a sign, a lower-third, a slate — is
    almost never a pure subset of the model's own narration of the shot: it almost always
    contributes at least one token (a name, a number, a distinct word) the prose never
    used. A short line is exempted (:data:`MIN_ON_SCREEN_ECHO_CHARS`): it is too easy to
    overlap by coincidence ("EXIT", "STOP"), and dropping something real costs more than
    keeping one short coincidental line.
    """
    if len(text) < MIN_ON_SCREEN_ECHO_CHARS or not prose_tokens:
        return False
    tokens = {token for token in text.lower().split() if token.isalnum()}
    return bool(tokens) and tokens.issubset(prose_tokens)


def _on_screen_text(raw: Any, *, prose: str = "") -> list[str]:
    """Normalise ``onScreenText``: verbatim per line, deduplicated, bounded, not invented.

    Verbatim: only whitespace is collapsed and the length capped. Nothing here may "tidy" a
    rendered lower-third, or a solver reading a title would be reading our paraphrase of it.

    Deduplicated, first occurrence winning, for the same reason ``quality`` is: a
    constrained decoder that has said everything it has to say fills the array to its bound
    with the SAME line rather than closing it. Measured on SmolVLM2-2.2B against
    ``workers/visual-describe/eval/media/slate.mp4``, a card reading "SCENE 4 TAKE 2":
    sixteen identical copies, exactly :data:`MAX_ON_SCREEN_TEXT_ITEMS`. The bound stops the
    runaway; it does not make the value useful. Verbatim is a promise about each line's
    CONTENT — never to tidy or paraphrase it — not a promise to repeat a decoder's stutter
    back to the editor as sixteen separate readings.

    Not invented: a line that is a bare placeholder (:func:`_is_placeholder_on_screen_text`)
    or that reads as a copy of the shot's own narrated prose (:func:`_is_prose_echo`) is
    dropped rather than stored — this module has no per-frame pixel signal to corroborate a
    borderline line against, so the conservative default is to treat an unsubstantiated
    echo as invented, never as evidence.

    :param raw: The model's ``onScreenText`` value, of any shape.
    :param prose: The shot's own narrated fields (summary/subject/action/setting/mood),
        space-joined, used only to detect an echo. Empty disables the echo check.
    :returns: The distinct legible lines, in the order first seen, at most
        :data:`MAX_ON_SCREEN_TEXT_ITEMS`.
    """
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return []
    prose_tokens = frozenset(token for token in prose.lower().split() if token.isalnum())
    seen: list[str] = []
    for item in raw:
        text = _text(item, MAX_ON_SCREEN_TEXT_CHARS)
        if not text or text in seen:
            continue
        if _is_placeholder_on_screen_text(text) or _is_prose_echo(text, prose_tokens):
            continue
        seen.append(text)
        if len(seen) >= MAX_ON_SCREEN_TEXT_ITEMS:
            break
    return seen


def parse_described(
    payload: Mapping[str, Any] | Any, *, model: str, tier2_version: int = TIER2_VERSION
) -> DescribedFacts:
    """Normalise one producer's JSON object into the ledger's tier-2 record.

    The single funnel every producer passes through (VU6.3). It is deliberately forgiving
    about extra keys and loose vocabulary and unforgiving about the one field that carries
    the meaning: a description with no ``summary`` is not a description.

    :param payload: The model's JSON object.
    :param model: The producing model id, stored on the row so two producers never read as
        one.
    :param tier2_version: The tier version these fields were produced against.
    :returns: A :class:`DescribedFacts` with unknown vocabulary dropped and ``p`` bucketed.
    :raises DescribedParseError: If ``payload`` is not an object or has no usable summary.
    """
    if not isinstance(payload, Mapping):
        raise DescribedParseError("a shot description must be a JSON object.")
    summary = _text(payload.get("summary"), MAX_SUMMARY_CHARS)
    if not summary:
        raise DescribedParseError("a shot description must carry a non-empty summary.")
    raw_camera = payload.get("camera")
    camera_map: Mapping[str, Any] = raw_camera if isinstance(raw_camera, Mapping) else {}
    shot_size = _closed(camera_map.get("shotSize"), [s.value for s in ShotSize])
    movement = _closed(camera_map.get("movement"), [m.value for m in CameraMovement])
    subject = _described(payload.get("subject"), MAX_FIELD_CHARS)
    action = _described(payload.get("action"), MAX_FIELD_CHARS)
    setting = _described(payload.get("setting"), MAX_FIELD_CHARS)
    mood = _described(payload.get("mood"), MAX_FIELD_CHARS)
    prose = " ".join((summary, subject, action, setting, mood))
    on_screen = _on_screen_text(payload.get("onScreenText"), prose=prose)
    quality_raw = payload.get("quality")
    quality: list[str] = []
    if isinstance(quality_raw, Sequence) and not isinstance(quality_raw, (str, bytes)):
        for item in quality_raw:
            word = _closed(item, QUALITY_VOCABULARY)
            if word is not None and word not in quality and len(quality) < MAX_QUALITY_ITEMS:
                quality.append(word)
    confidence = payload.get("confidence")
    probability = CONFIDENCE_BUCKETS.get(
        confidence.strip().lower() if isinstance(confidence, str) else "", 0.7
    )
    return DescribedFacts(
        tier2_version=tier2_version,
        model=model,
        summary=summary,
        subject=subject,
        action=action,
        setting=setting,
        camera=CameraFacts(
            shot_size=ShotSize(shot_size) if shot_size else None,
            angle=_closed(camera_map.get("angle"), CAMERA_ANGLES),
            movement=CameraMovement(movement) if movement else None,
        ),
        mood=mood,
        on_screen_text=on_screen,
        quality=quality,
        p=probability,
    )


def described_from_summary(
    summary: str, *, model: str, p: float = 0.7, tier2_version: int = TIER2_VERSION
) -> DescribedFacts:
    """The TwelveLabs arm's mapping: span prose into ``summary``, nothing else (VU6.3).

    Every structured field is left empty on purpose. TwelveLabs returns a sentence, not a
    schema, and filling ``subject``/``camera`` by parsing that sentence would manufacture
    facts with a provenance nobody could check. One schema, three producers — and one of
    them can only fill one field.

    :raises DescribedParseError: If the prose is empty after whitespace collapse.
    """
    text = _text(summary, MAX_SUMMARY_CHARS)
    if not text:
        raise DescribedParseError("a shot description must carry a non-empty summary.")
    return DescribedFacts(tier2_version=tier2_version, model=model, summary=text, p=p)
