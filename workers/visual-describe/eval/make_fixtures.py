"""Build the caption-quality fixtures, whose ground truth is true BY CONSTRUCTION.

WHY SYNTHETIC, AND WHY THIS IS NOT A SHORTCUT

`plan/visual-understanding/05` §VU6.5 asks for caption quality on 50 labelled shots, and
`tests/fixtures/mission/labels/tier2.json` is a scaffold whose every field is `null`. A
label set nobody has eyeballed scores the model against itself, so that file cannot answer
the question and was never going to.

These clips answer a smaller question that needs no human: for each one, a specific claim
is either true or false *by how the frame was drawn*. Nobody has to agree with a label —

  - `flat-grey`, `colour-bars`, `noise`: contain NO person, NO text and NO place. Any
    description asserting a person is FALSE, whatever a labeller would have said.
  - `slate`: carries exactly the string on it. `onScreenText` is exactly right or it is not.

That is a floor, not a quality score: passing says the model does not invent people and can
read a card. It says nothing about whether a description of real footage is any good, and
this module must not be cited as if it did.

Deterministic: fixed seed, fixed geometry, no clock, no network.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
MEDIA = HERE / "media"

WIDTH, HEIGHT, FPS, SECONDS = 640, 360, 30, 2
#: The slate's text, and the exact string `onScreenText` has to come back with.
SLATE_TEXT = "SCENE 4 TAKE 2"
#: One seed, so noise is the same picture on every machine and every run.
NOISE_SEED = 20260908


def _write(name: str, frame: np.ndarray) -> Path:
    """Encode one still as a short, seekable, losslessly-flat H.264 clip."""
    MEDIA.mkdir(parents=True, exist_ok=True)
    png = MEDIA / f"{name}.png"
    out = MEDIA / f"{name}.mp4"
    cv2.imwrite(str(png), frame)
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-loop", "1", "-framerate", str(FPS), "-i", str(png),
            "-t", str(SECONDS), "-c:v", "libx264", "-preset", "ultrafast",
            # -qp 0 keeps the drawn pixels exactly as drawn: a compression artifact must
            # never be the reason a description is wrong.
            "-qp", "0", "-pix_fmt", "yuv420p", str(out),
        ],
        check=True,
    )
    png.unlink()
    return out


def flat_grey() -> np.ndarray:
    return np.full((HEIGHT, WIDTH, 3), 128, dtype=np.uint8)


def colour_bars() -> np.ndarray:
    bars = [
        (192, 192, 192), (0, 192, 192), (192, 192, 0), (0, 192, 0),
        (192, 0, 192), (0, 0, 192), (192, 0, 0), (0, 0, 0),
    ]
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    step = WIDTH // len(bars)
    for i, colour in enumerate(bars):
        frame[:, i * step : (i + 1) * step] = colour
    return frame


def noise() -> np.ndarray:
    return np.random.default_rng(NOISE_SEED).integers(
        0, 256, (HEIGHT, WIDTH, 3), dtype=np.uint8
    )


def slate() -> np.ndarray:
    """A clapperboard-ish card: white text on black, large enough to be unambiguous."""
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    cv2.putText(
        frame, SLATE_TEXT, (30, HEIGHT // 2),
        cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3, cv2.LINE_AA,
    )
    return frame


FIXTURES = {
    "flat-grey": flat_grey,
    "colour-bars": colour_bars,
    "noise": noise,
    "slate": slate,
}


def main() -> int:
    for name, build in FIXTURES.items():
        path = _write(name, build())
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
