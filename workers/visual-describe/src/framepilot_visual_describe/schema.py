"""Mirror of the engine's structured shot-description contract.

The canonical copy is ``engine/python/framepilot_engine/brain/described.py``;
``engine/python/tests/test_described_drift.py`` fails if the two ever disagree. It is
duplicated rather than imported for the same reason the prompt bank is: this worker ships
as a signed, standalone artifact and must not import ``framepilot_engine``.

The schema — not a sentence — is the contract. llama.cpp converts it to a GBNF grammar and
constrains generation with it, so a 2 B parameter model **cannot** emit prose, a missing
field, or a vocabulary word nobody chose. That is the whole reason tier 2 can be run by a
small local model at all.
"""

from __future__ import annotations

from typing import Any, Final

#: Bumping this re-queues tier 2 and nothing else. It is the ledger's ``TIER2_VERSION``;
#: a request naming another version is refused rather than answered approximately.
TIER2_VERSION: Final = 1

#: The sentinel a closed-vocabulary field carries when the model has nothing to say.
UNKNOWN: Final = "unknown"

#: The ledger's framing ladder, coarse to close (``ShotSize``).
SHOT_SIZES: Final[tuple[str, ...]] = ("EWS", "WS", "MWS", "MS", "MCU", "CU", "ECU")

#: The ledger's camera-movement enum (``CameraMovement``).
CAMERA_MOVEMENTS: Final[tuple[str, ...]] = (
    "static",
    "pan",
    "tilt",
    "zoom",
    "handheld",
    "tracking",
)

CAMERA_ANGLES: Final[tuple[str, ...]] = (
    "eye-level",
    "high",
    "low",
    "overhead",
    "dutch",
    "over-the-shoulder",
    "pov",
)

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

CONFIDENCE_LEVELS: Final[tuple[str, ...]] = ("low", "medium", "high")

# `MAX_ON_SCREEN_TEXT_ITEMS` is also the schema's array bound, so the grammar and the
# parser agree on one number rather than trimming to a limit generation never reached.
MAX_SUMMARY_CHARS: Final = 400
MAX_FIELD_CHARS: Final = 160
MAX_ON_SCREEN_TEXT_ITEMS: Final = 16
MAX_ON_SCREEN_TEXT_CHARS: Final = 200
MAX_QUALITY_ITEMS: Final = 6

DESCRIBED_SCHEMA_NAME: Final = "shot_description"

DESCRIBE_INSTRUCTION: Final = (
    "You are describing ONE shot of video from its keyframes, for an editor's index. "
    "Fill every field of the schema. State only what is visibly on screen — no intent, "
    "no story, no narration, no guessing at what happens next. "
    "summary: at most two sentences, the shot as an editor would note it. "
    "subject: who or what the shot is of. action: what they are doing. "
    "setting: where it is. mood: the visual feel, not an emotion you infer. "
    "onScreenText: every piece of text legible in frame, transcribed VERBATIM and never "
    "paraphrased; an empty list when there is none. "
    "camera and quality: choose only from the listed values, and choose 'unknown' rather "
    "than guessing. confidence: how sure you are of this description overall."
)


def _enum(values: tuple[str, ...]) -> list[str]:
    return [*values, UNKNOWN]


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
                "shotSize": {"type": "string", "enum": _enum(SHOT_SIZES)},
                "angle": {"type": "string", "enum": _enum(CAMERA_ANGLES)},
                "movement": {"type": "string", "enum": _enum(CAMERA_MOVEMENTS)},
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
        "confidence": {"type": "string", "enum": list(CONFIDENCE_LEVELS)},
    },
}

__all__ = [
    "CAMERA_ANGLES",
    "CAMERA_MOVEMENTS",
    "CONFIDENCE_LEVELS",
    "DESCRIBED_JSON_SCHEMA",
    "DESCRIBED_SCHEMA_NAME",
    "DESCRIBE_INSTRUCTION",
    "MAX_FIELD_CHARS",
    "MAX_ON_SCREEN_TEXT_CHARS",
    "MAX_ON_SCREEN_TEXT_ITEMS",
    "MAX_QUALITY_ITEMS",
    "MAX_SUMMARY_CHARS",
    "QUALITY_VOCABULARY",
    "SHOT_SIZES",
    "TIER2_VERSION",
    "UNKNOWN",
]
