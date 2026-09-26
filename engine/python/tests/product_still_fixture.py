"""Generate the product still for the callout evaluation (plan/elements EL8.4, 07 §8, case 4).

The case asks "Underline the headline and put an arrow pointing at the price". Scoring it needs
ground truth no real product shot comes with: exactly where the headline and the price sit. So
this draws an 8-second static product card — a product on the left, a headline, a line of copy,
a price tag and a button on the right — and records the headline's and the price tag's boxes.
Nothing tells the agent where they are: it has to read them off ``get_frame``. Everything is
deterministic; nothing is fetched.

Writes (run from ``engine/python``)::

    uv run python -m tests.product_still_fixture

- ``tests/fixtures/mission/product-still-8s.mp4`` (gitignored media, like every mission file);
- ``tests/fixtures/mission/labels/product-still.json`` (committed): the headline's box and the
  price tag's box, in percent of each frame axis.
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
VIDEO = MISSION / "product-still-8s.mp4"
LABELS = MISSION / "labels" / "product-still.json"

WIDTH, HEIGHT, FPS, SECONDS = 1280, 720, 30, 8
HEADLINE = "Aurora Headphones"
COPY = "Forty hours of quiet, in one charge."
PRICE = "$129"
#: Where the headline's first letter is drawn, in output pixels.
HEADLINE_AT = (660, 250)
#: The price tag, in output pixels: left, top, right, bottom.
PRICE_TAG = (660, 420, 820, 486)
BUTTON = (860, 420, 1100, 486)


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    fonts = REPO / "engine" / "python" / "framepilot_engine" / "render" / "fonts"
    for candidate in sorted(fonts.glob("Inter*.ttf")):
        return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size)


def _frame() -> tuple[Image.Image, tuple[int, int, int, int]]:
    """The card, and the headline's drawn box (left, top, right, bottom)."""
    image = Image.new("RGB", (WIDTH, HEIGHT), (244, 241, 236))
    draw = ImageDraw.Draw(image)
    # The product: a pair of headphones on a soft pedestal, left of centre.
    draw.ellipse((150, 520, 530, 600), fill=(222, 216, 206))
    draw.arc((200, 150, 480, 470), start=180, end=360, fill=(40, 44, 52), width=26)
    for cup in ((176, 330, 276, 500), (404, 330, 504, 500)):
        draw.rounded_rectangle(cup, radius=40, fill=(40, 44, 52))
        inset = (cup[0] + 18, cup[1] + 22, cup[2] - 18, cup[3] - 22)
        draw.rounded_rectangle(inset, radius=30, fill=(90, 96, 110))
    headline_font = _font(54)
    headline_box = draw.textbbox(HEADLINE_AT, HEADLINE, font=headline_font)
    draw.text(HEADLINE_AT, HEADLINE, fill=(24, 24, 28), font=headline_font)
    draw.text((HEADLINE_AT[0], 212), "NEW", fill=(229, 103, 10), font=_font(22))
    draw.text((HEADLINE_AT[0], 336), COPY, fill=(92, 92, 100), font=_font(24))
    draw.rounded_rectangle(PRICE_TAG, radius=12, fill=(255, 255, 255), outline=(24, 24, 28))
    draw.text((PRICE_TAG[0] + 30, PRICE_TAG[1] + 12), PRICE, fill=(24, 24, 28), font=_font(36))
    draw.rounded_rectangle(BUTTON, radius=12, fill=(24, 24, 28))
    draw.text((BUTTON[0] + 50, BUTTON[1] + 18), "Add to cart", fill=(255, 255, 255), font=_font(26))
    left, top, right, bottom = (int(v) for v in headline_box)
    return image, (left, top, right, bottom)


def _percent(box: tuple[int, int, int, int]) -> dict[str, float]:
    left, top, right, bottom = box
    return {
        "x": round(left / WIDTH * 100, 4),
        "y": round(top / HEIGHT * 100, 4),
        "width": round((right - left) / WIDTH * 100, 4),
        "height": round((bottom - top) / HEIGHT * 100, 4),
    }


def main() -> int:
    image, headline_box = _frame()
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
            "18",
            "-pix_fmt",
            "yuv420p",
            str(VIDEO),
        ],
        stdin=subprocess.PIPE,
    )
    assert encoder.stdin is not None
    frame = image.tobytes()
    for _ in range(FPS * SECONDS):
        encoder.stdin.write(frame)
    encoder.stdin.close()
    if encoder.wait() != 0:
        sys.stderr.write("product_still_fixture: ffmpeg failed; is it installed?\n")
        return 1
    labels: dict[str, Any] = {
        "spec": (
            "Ground truth for the product-still callout case (plan/elements 07 section 8, case "
            "4): the headline's drawn box and the price tag's box, in percent of each frame "
            "axis. Generated by engine/python/tests/product_still_fixture.py."
        ),
        "video": VIDEO.name,
        "resolution": {"width": WIDTH, "height": HEIGHT},
        "headline": _percent(headline_box),
        "price": _percent(PRICE_TAG),
    }
    LABELS.write_text(json.dumps(labels, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(f"wrote {VIDEO} and {LABELS}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
