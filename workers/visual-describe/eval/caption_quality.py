"""Measure what the local describe pack actually says about frames of known content.

Runs the SIGNED WORKER ENTRYPOINT, not the backend class: one subprocess per fixture
speaking the real JSON-line protocol, exactly as the host drives it. So this measures the
shipped path — schema, grammar, keyframe choice, normalisation and model — end to end.

## What is scored, and why these checks and no others

Each fixture's ground truth is true by construction (see `make_fixtures.py`), so a check is
decidable without a human:

  `no_person`      the frame contains no person. Asserting one is a hallucination — this is
                   the check that exists because a synthetic test frame came back as
                   "a person" when there was nobody in it.
  `no_false_text`  a frame with no legible text must return an EMPTY `onScreenText`.
                   Inventing a caption is the same failure as inventing a person, and it is
                   worse downstream: on-screen text is contracted to be VERBATIM, so an
                   invented line is quoted back to the editor as if it were read.
  `reads_text`     the slate carries one string; `onScreenText` must contain it.
  `schema_valid`   the object parses and conforms. Already covered by the unit suite; kept
                   because a run that fails here invalidates every other number.
  `declines_cleanly`
                   for `flat-grey` ONLY, whose expected outcome is a refusal. SmolVLM2-2.2B
                   returns a parseable object with an EMPTY SUMMARY for a featureless frame,
                   every time, and the protocol has no partial answer — so the request has
                   to fail. What is scored is that it fails as NOT RETRYABLE: the frame will
                   decline identically next pass, and calling it retryable made a fade to
                   black fail its whole batch forever. A frame with nothing in it is allowed
                   to produce nothing; it is not allowed to produce a lie or a retry loop.

Deliberately NOT scored: whether a description of real footage is GOOD. That needs human
labels (VU6.5), and `tests/fixtures/mission/labels/tier2.json` is still a scaffold of
nulls. Passing everything here means the model does not invent people or text and can read
a card. Nothing more may be claimed from it.

Usage:  uv run --extra cv python eval/caption_quality.py [--json] [--fixture slate]
Exit 1 if any check fails, so it can gate.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
MEDIA = HERE / "media"
PACK_ROOT = HERE.parent

sys.path.insert(0, str(PACK_ROOT / "src"))
from make_fixtures import FPS, SECONDS, SLATE_TEXT  # noqa: E402

from framepilot_visual_describe.protocol import PROTOCOL_VERSION  # noqa: E402
from framepilot_visual_describe.schema import TIER2_VERSION  # noqa: E402

#: Words that assert a human being is in frame. Matched whole-word and case-insensitively
#: against `subject` and `action`; `summary` is excluded because it may legitimately say
#: "no people are visible" and a substring match would score that as a hallucination.
PERSON_WORDS = [
    "person", "people", "man", "men", "woman", "women", "boy", "girl",
    "child", "children", "human", "someone", "somebody", "figure", "crowd",
    "face", "guy", "lady", "worker", "speaker", "host", "presenter",
]
PERSON_RE = re.compile(rf"\b({'|'.join(PERSON_WORDS)})\b", re.IGNORECASE)

#: Fixtures with nothing in them: no person, no text, no place.
EMPTY_FIXTURES = ("colour-bars", "noise")
#: Fixtures the model is EXPECTED to decline. Scored on how it declines, not on describing.
DECLINING_FIXTURES = ("flat-grey",)


def _request(path: Path) -> dict[str, Any]:
    return {
        "type": "request",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "caption-quality-eval",
        "projectRevision": 0,
        "capability": "visual.describe",
        "media": {
            "handleId": "caption-quality-eval",
            "assetId": path.stem,
            "absolutePath": str(path),
            "sourceStartSeconds": 0.0,
            "sourceEndSeconds": float(SECONDS),
            "fps": float(FPS),
            "firstFrame": 0,
            "lastFrameExclusive": FPS * SECONDS,
        },
        "parameters": {
            "tier2Version": TIER2_VERSION,
            "shots": [{"shotIndex": 0, "t0": 0.0, "t1": float(SECONDS)}],
        },
    }


def describe(path: Path) -> tuple[dict[str, Any] | None, str, float, dict[str, Any] | None]:
    """Drive one describe request through the signed entrypoint.

    :returns: ``(shot, note, seconds, failure)`` — ``shot`` when one came back, otherwise
        ``failure`` carrying the worker's terminal failure message so a DECLINE can be told
        apart from a crash.
    """
    started = time.monotonic()
    proc = subprocess.run(
        [sys.executable, "-m", "framepilot_visual_describe", "--framepilot-worker-runtime"],
        input=json.dumps(_request(path)) + "\n",
        capture_output=True,
        text=True,
        cwd=PACK_ROOT,
        env={**_env()},
        timeout=600,
    )
    elapsed = time.monotonic() - started
    terminal = None
    for line in proc.stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("type") in {"result", "failure"}:
            terminal = message
    if terminal is None:
        note = f"no terminal message (rc={proc.returncode}): {proc.stderr[-300:]}"
        return None, note, elapsed, None
    if terminal["type"] == "failure":
        return None, f"worker failure: {json.dumps(terminal)[:300]}", elapsed, terminal
    shots = terminal.get("result", {}).get("shots") or terminal.get("shots") or []
    if not shots:
        return None, f"result carried no shots: {json.dumps(terminal)[:300]}", elapsed, None
    return shots[0], "", elapsed, None


def _env() -> dict[str, str]:
    import os

    env = dict(os.environ)
    env["PYTHONPATH"] = str(PACK_ROOT / "src")
    return env


def score(name: str, shot: dict[str, Any]) -> list[dict[str, Any]]:
    """The decidable checks for one fixture."""
    checks: list[dict[str, Any]] = []
    text_items = [t for t in (shot.get("onScreenText") or []) if t.strip()]
    claimed = " ".join(str(shot.get(field) or "") for field in ("subject", "action"))
    person = PERSON_RE.search(claimed)

    if name in EMPTY_FIXTURES:
        checks.append({
            "check": "no_person",
            "ok": person is None,
            "detail": (
                f'claimed "{person.group(0)}" in subject/action'
                if person
                else "no person claimed"
            ),
        })
        checks.append({
            "check": "no_false_text",
            "ok": len(text_items) == 0,
            "detail": f"invented {text_items!r}" if text_items else "onScreenText empty",
        })
    if name == "slate":
        joined = " ".join(text_items).upper()
        checks.append({
            "check": "reads_text",
            "ok": SLATE_TEXT.upper() in joined,
            "detail": f"onScreenText={text_items!r}, wanted {SLATE_TEXT!r}",
        })
    return checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--fixture", action="append")
    args = parser.parse_args()

    names = args.fixture or ["flat-grey", "colour-bars", "noise", "slate"]
    missing = [n for n in names if not (MEDIA / f"{n}.mp4").exists()]
    if missing:
        print(f"missing fixtures {missing}; run: python eval/make_fixtures.py", file=sys.stderr)
        return 2

    rows = []
    for name in names:
        shot, note, elapsed, failure = describe(MEDIA / f"{name}.mp4")
        if shot is None:
            if name in DECLINING_FIXTURES and failure is not None:
                declined = "no summary" in str(failure.get("detail", ""))
                retryable = failure.get("retryable")
                rows.append({"fixture": name, "seconds": elapsed, "failure": failure, "checks": [{
                    "check": "declines_cleanly",
                    "ok": bool(declined) and retryable is False,
                    "detail": (
                        f"declined={declined!r} retryable={retryable!r} — "
                        "wanted a summaryless decline marked NOT retryable"
                    ),
                }]})
                continue
            rows.append({"fixture": name, "seconds": elapsed, "error": note, "checks": [
                {"check": "schema_valid", "ok": False, "detail": note}
            ]})
            continue
        rows.append({
            "fixture": name,
            "seconds": elapsed,
            "described": shot,
            "checks": [
                {"check": "schema_valid", "ok": True, "detail": "parsed and conformed"},
                *score(name, shot),
            ],
        })

    if args.json:
        print(json.dumps({"rows": rows}, indent=2))
    else:
        for row in rows:
            print(f"\n=== {row['fixture']}  ({row['seconds']:.1f}s)")
            if row.get("failure"):
                print(f"    declined: {row['failure'].get('detail')!r} "
                      f"retryable={row['failure'].get('retryable')!r}")
            described = row.get("described")
            if described:
                fields = ("summary", "subject", "action", "setting",
                          "mood", "onScreenText", "confidence")
                for field in fields:
                    print(f"    {field}: {described.get(field)!r}")
            for check in row["checks"]:
                verdict = "PASS" if check["ok"] else "FAIL"
                print(f"  [{verdict}] {check['check']}: {check['detail']}")

    failed = [
        (row["fixture"], c["check"]) for row in rows for c in row["checks"] if not c["ok"]
    ]
    total = sum(len(row["checks"]) for row in rows)
    print(f"\n{total - len(failed)}/{total} checks passed")
    if failed:
        print("FAILED: " + ", ".join(f"{f}:{c}" for f, c in failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
