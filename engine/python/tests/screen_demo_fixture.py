"""Generate the screen-demo fixture for the callout evaluation (plan/elements EL4a, 07 section 8).

The case asks "Put a box around the Export button when I say 'export'". Scoring it needs ground
truth no real recording has: where the button is and when the word is said. So this draws a
20-second screen recording of a small editing app — a toolbar with an Export button at a known
box, a cursor that travels to it — and writes a narration transcript that says "export" once,
at a known time. Everything is deterministic; nothing is fetched.

Writes (run from ``engine/python``)::

    uv run python -m tests.screen_demo_fixture

- ``tests/fixtures/mission/screen-demo-20s.mp4`` (gitignored media, like every mission file);
- ``tests/fixtures/mission/labels/screen-demo.json`` (committed): the button box in percent of
  each frame axis, the word's time, and the transcript the fixture project carries.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[3]
MISSION = REPO / "tests" / "fixtures" / "mission"
VIDEO = MISSION / "screen-demo-20s.mp4"
LABELS = MISSION / "labels" / "screen-demo.json"

WIDTH, HEIGHT, FPS, SECONDS = 1280, 720, 30, 20
#: The Export button, in output pixels: left, top, right, bottom.
EXPORT_BUTTON = (1112, 16, 1256, 56)
#: The narration, word by word; "export" is said once, as the cursor arrives on the button.
NARRATION = [
    "In",
    "this",
    "demo",
    "we",
    "cut",
    "the",
    "clip",
    "down",
    "and",
    "save",
    "it",
    ".",
    "First",
    "we",
    "trim",
    "the",
    "start",
    "of",
    "the",
    "clip",
    ".",
    "Now",
    "the",
    "edit",
    "feels",
    "right",
    "and",
    "we",
    "are",
    "happy",
    "with",
    "it",
    ".",
    "Click",
    "export",
    "in",
    "the",
    "top",
    "corner",
    "to",
    "save",
    "your",
    "video",
    ".",
]
FIRST_WORD_AT = 0.6
WORD_SECONDS = 0.34
PAUSE_SECONDS = 0.7
#: The cursor reaches the button this long before the word, as a person would move first.
CURSOR_LEAD_SECONDS = 0.6


def _transcript() -> tuple[list[dict[str, Any]], float]:
    """The narration's words with times, and when "export" starts."""
    words: list[dict[str, Any]] = []
    t = FIRST_WORD_AT
    export_at = -1.0
    for token in NARRATION:
        if token == ".":
            t += PAUSE_SECONDS
            continue
        start, end = round(t, 3), round(t + WORD_SECONDS * 0.9, 3)
        text = token.lower().strip(",")
        if text == "export" and export_at < 0:
            export_at = start
        words.append({"word": token, "start": start, "end": end})
        t += WORD_SECONDS
    return words, export_at


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    fonts = REPO / "engine" / "python" / "framepilot_engine" / "render" / "fonts"
    for candidate in sorted(fonts.glob("Inter*.ttf")):
        return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def _frame(t: float, export_at: float, font: Any) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), (30, 31, 36))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, 72), fill=(43, 45, 51))
    for label, box in (("Import", (24, 16, 144, 56)), ("Trim", (160, 16, 280, 56))):
        draw.rounded_rectangle(box, radius=8, fill=(62, 65, 74))
        draw.text((box[0] + 22, box[1] + 9), label, fill=(230, 230, 235), font=font)
    draw.rounded_rectangle(EXPORT_BUTTON, radius=8, fill=(10, 132, 255))
    draw.text(
        (EXPORT_BUTTON[0] + 36, EXPORT_BUTTON[1] + 9), "Export", fill=(255, 255, 255), font=font
    )
    # The clip being edited, and a sidebar of assets.
    draw.rectangle((24, 96, 240, HEIGHT - 24), fill=(38, 40, 46))
    for row in range(6):
        draw.rounded_rectangle(
            (36, 112 + row * 70, 228, 168 + row * 70), radius=6, fill=(55, 58, 66)
        )
    shade = 70 + int(40 * (t / SECONDS))
    draw.rectangle((264, 96, WIDTH - 24, HEIGHT - 24), fill=(shade, 60, 90))
    # The cursor: parked, then travelling to the Export button, arriving just before the word.
    arrive = export_at - CURSOR_LEAD_SECONDS
    leave = arrive - 2.0
    cx0, cy0 = 640.0, 420.0
    cx1 = (EXPORT_BUTTON[0] + EXPORT_BUTTON[2]) / 2
    cy1 = (EXPORT_BUTTON[1] + EXPORT_BUTTON[3]) / 2
    f = 0.0 if t <= leave else 1.0 if t >= arrive else (t - leave) / (arrive - leave)
    x, y = cx0 + (cx1 - cx0) * f, cy0 + (cy1 - cy0) * f
    draw.polygon([(x, y), (x, y + 22), (x + 6, y + 16), (x + 16, y + 16)], fill=(255, 255, 255))
    return image


def main() -> int:
    words, export_at = _transcript()
    font = _font(18)
    VIDEO.parent.mkdir(parents=True, exist_ok=True)
    encoder = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{WIDTH}x{HEIGHT}",
            "-r",
            str(FPS),
            "-i",
            "-",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            str(VIDEO),
        ],
        stdin=subprocess.PIPE,
    )
    assert encoder.stdin is not None
    for index in range(FPS * SECONDS):
        encoder.stdin.write(_frame(index / FPS, export_at, font).tobytes())
    encoder.stdin.close()
    if encoder.wait() != 0:
        sys.stderr.write("screen_demo_fixture: ffmpeg failed; is it installed?\n")
        return 1
    left, top, right, bottom = EXPORT_BUTTON
    labels = {
        "spec": (
            "Ground truth for the callout evaluation case (plan/elements 07 section 8): the Export "
            "button in percent of each frame axis, and the one time the narration says 'export'. "
            "Generated by engine/python/tests/screen_demo_fixture.py."
        ),
        "video": "screen-demo-20s.mp4",
        "resolution": {"width": WIDTH, "height": HEIGHT},
        "target": {
            "x": round(left / WIDTH * 100, 4),
            "y": round(top / HEIGHT * 100, 4),
            "width": round((right - left) / WIDTH * 100, 4),
            "height": round((bottom - top) / HEIGHT * 100, 4),
        },
        "wordStart": export_at,
        "transcript": words,
    }
    LABELS.write_text(json.dumps(labels, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(f"wrote {VIDEO} and {LABELS}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
