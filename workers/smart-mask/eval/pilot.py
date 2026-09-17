"""BR3.15 construction-true pilot: ground truth by construction, built to look like footage.

BR0's pilot (``spike/pilot_generate.py``) made every one of its 256 frames wrong by the 06 rule,
so recall could not tell a detector from "flag everything". Its subjects were unlike footage in
ways that no segmenter handles: 260 one-subpixel hair strands counted as foreground when their
coverage passed 0.5, flat-shaded capsule limbs that crossed at hard angles, and a "low light"
clip at 22% gain with 3% noise, darker than any exposure an editor keeps. This pilot keeps the
construction (subject alpha composited over real Sintel stills, so ground truth is exact) and
changes what is drawn:

* **Bodies** are soft-shaded volumes (torso, limbs, neck, head with a jaw) with cloth texture and
  directional light, anti-aliased by 4× supersampling.
* **Hair** is a mass with a feathered fringe plus a few thicker strands, the structure 720p footage
  of hair actually shows. One category keeps fine flyaways (``hair_busy``).
* **Motion blur** is a real 180° shutter (temporal supersampling), 3–7 samples.
* **Low light** is 40% gain with sensor-like noise.
* Resolution 1280×720, 32 frames at 24 fps (the local real-weight budget: ≤ 64 frames, ≤ 720p).

Categories follow 06 (talking head, walking, hair on a busy background, similar colour, a second
person crossing, leaving and re-entering, fast motion, an identical distractor, low light, a
product). Each is rendered with two seeds: split ``calibration`` (thresholds are fitted here) and
split ``scored`` (reported numbers come only from here).

Licences: subjects are generated here; backgrounds are Sintel stills (© Blender Foundation |
durian.blender.org, CC-BY 3.0).
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

PACK = Path(__file__).resolve().parent.parent
PILOT_DIR = PACK / ".cache" / "pilot-br3"
BG_DIR = PACK / ".cache" / "media" / "bg"
W, H = 1280, 720
FPS = 24
FRAMES = 32
SS = 4
LICENCE_BG = "Sintel still frames, (c) Blender Foundation | durian.blender.org, CC-BY 3.0"
SPLITS = {"calibration": 0, "scored": 1000}

Path2 = Callable[[float], tuple[float, float, float, float]]


@dataclass
class Figure:
    height: float
    skin: tuple[int, int, int]
    hair: tuple[int, int, int]
    top: tuple[int, int, int]
    bottom: tuple[int, int, int]
    seed: int
    hair_style: str = "mass"  # mass | flyaway | none
    head_scale: float = 1.0
    crop_close: bool = False
    texture: Any = None


def load_bg(name: str, scale: float) -> np.ndarray:
    image = cv2.cvtColor(cv2.imread(str(BG_DIR / f"{name}.png")), cv2.COLOR_BGR2RGB)
    image = image[int(image.shape[0] * 0.12) : int(image.shape[0] * 0.88)]
    factor = max(scale, (H + 40) / image.shape[0])
    return (
        cv2.resize(image, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA).astype(
            np.float32
        )
        / 255.0
    )


def bg_frame(bg: np.ndarray, x: float, y: float) -> np.ndarray:
    matrix = np.float32([[1, 0, -x], [0, 1, -y]])
    return cv2.warpAffine(bg, matrix, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def _shade(canvas_rgb: np.ndarray, canvas_a: np.ndarray, mask: np.ndarray, colour: tuple[int, int, int],
           centre: tuple[float, float], radius: float) -> None:  # fmt: skip
    """Paint a part with a soft directional light falloff (light from upper left)."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return
    dx = (xs - centre[0]) / max(radius, 1.0)
    dy = (ys - centre[1]) / max(radius, 1.0)
    light = np.clip(0.78 - 0.22 * dx - 0.18 * dy, 0.45, 1.05)
    base = np.array(colour, np.float32) / 255.0
    canvas_rgb[ys, xs] = base[None, :] * light[:, None]
    canvas_a[ys, xs] = 1.0


def render_figure(
    fig: Figure, x: float, y: float, phase: float, sway: float
) -> tuple[np.ndarray, np.ndarray]:
    """Premultiplied RGB and alpha (full frame) of a figure whose feet centre is (x, y)."""
    h = fig.height
    pad = int(h * 0.5)
    x0, y0 = max(int(x - pad), 0), max(int(y - h - pad * 0.5), 0)
    x1, y1 = min(int(x + pad), W), min(int(y + pad * 0.3), H)
    full_p = np.zeros((H, W, 3), np.float32)
    full_a = np.zeros((H, W), np.float32)
    if x1 <= x0 or y1 <= y0:
        return full_p, full_a
    bw, bh = x1 - x0, y1 - y0
    ss = SS if bw * bh <= 400_000 else 3
    cw, ch = bw * ss, bh * ss
    rgb = np.zeros((ch, cw, 3), np.float32)
    alpha = np.zeros((ch, cw), np.float32)

    def P(px: float, py: float) -> tuple[float, float]:
        return ((px - x0) * ss, (py - y0) * ss)

    def capsule(a: tuple[float, float], b: tuple[float, float], r0: float, r1: float) -> np.ndarray:
        mask = np.zeros((ch, cw), np.uint8)
        steps = 12
        for i in range(steps + 1):
            t = i / steps
            cx, cy = P(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            cv2.circle(
                mask,
                (int(cx), int(cy)),
                max(int((r0 + (r1 - r0) * t) * ss), 1),
                255,
                -1,
                cv2.LINE_8,
            )
        return mask > 0

    swing = math.sin(phase) * 0.42
    hip = (x + sway * 0.03 * h, y - 0.48 * h)
    neck = (x + sway * 0.06 * h, y - 0.82 * h)
    head_r = 0.068 * h * fig.head_scale
    head = (neck[0] + sway * 0.02 * h, neck[1] - head_r * 1.15)
    leg, arm = 0.48 * h, 0.35 * h
    knee_l = (hip[0] + math.sin(swing) * leg * 0.5, hip[1] + leg * 0.5)
    knee_r = (hip[0] - math.sin(swing) * leg * 0.5, hip[1] + leg * 0.5)
    foot_l = (knee_l[0] + math.sin(swing * 0.6) * leg * 0.5, y)
    foot_r = (knee_r[0] - math.sin(swing * 0.6) * leg * 0.5, y)
    shoulder_l = (neck[0] - 0.09 * h, neck[1] + 0.04 * h)
    shoulder_r = (neck[0] + 0.09 * h, neck[1] + 0.04 * h)
    elbow_l = (shoulder_l[0] - math.sin(swing) * arm * 0.45, shoulder_l[1] + arm * 0.48)
    elbow_r = (shoulder_r[0] + math.sin(swing) * arm * 0.45, shoulder_r[1] + arm * 0.48)
    hand_l = (elbow_l[0] - math.sin(swing) * arm * 0.3, elbow_l[1] + arm * 0.5)
    hand_r = (elbow_r[0] + math.sin(swing) * arm * 0.3, elbow_r[1] + arm * 0.5)
    parts = [
        (
            capsule(hip, knee_l, 0.05 * h, 0.042 * h)
            | capsule(knee_l, foot_l, 0.042 * h, 0.034 * h),
            fig.bottom,
            knee_l,
            0.2 * h,
        ),
        (
            capsule(hip, knee_r, 0.05 * h, 0.042 * h)
            | capsule(knee_r, foot_r, 0.042 * h, 0.034 * h),
            fig.bottom,
            knee_r,
            0.2 * h,
        ),
        (
            capsule(hip, neck, 0.105 * h, 0.1 * h)
            | capsule(shoulder_l, shoulder_r, 0.05 * h, 0.05 * h),
            fig.top,
            ((hip[0] + neck[0]) / 2, (hip[1] + neck[1]) / 2),
            0.25 * h,
        ),
        (
            capsule(shoulder_l, elbow_l, 0.036 * h, 0.03 * h)
            | capsule(elbow_l, hand_l, 0.03 * h, 0.024 * h),
            fig.top,
            elbow_l,
            0.15 * h,
        ),
        (
            capsule(shoulder_r, elbow_r, 0.036 * h, 0.03 * h)
            | capsule(elbow_r, hand_r, 0.03 * h, 0.024 * h),
            fig.top,
            elbow_r,
            0.15 * h,
        ),
        (
            capsule(neck, (head[0], head[1] + head_r * 0.6), 0.03 * h, 0.03 * h),
            fig.skin,
            neck,
            0.05 * h,
        ),
    ]
    for mask, colour, centre, radius in parts:
        _shade(rgb, alpha, mask, colour, P(*centre), radius * ss)
    head_mask = np.zeros((ch, cw), np.uint8)
    hc = P(*head)
    cv2.ellipse(
        head_mask,
        ((hc[0], hc[1] + head_r * 0.1 * ss), (2 * head_r * ss * 0.9, 2 * head_r * ss * 1.15), 0),
        255,
        -1,
    )
    _shade(rgb, alpha, head_mask > 0, fig.skin, hc, head_r * ss)
    if fig.texture is None:
        rng = np.random.default_rng(fig.seed)
        fig.texture = cv2.GaussianBlur(
            rng.uniform(0.82, 1.1, (96, 96)).astype(np.float32), (3, 3), 0.8
        )
    ys = (np.arange(ch, dtype=np.float32) / ss + y0 - (y - h)) / (h / 60.0)
    xs = (np.arange(cw, dtype=np.float32) / ss + x0 - (x - pad)) / (h / 60.0)
    tex = cv2.remap(
        fig.texture,
        *np.meshgrid(xs, ys),
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_WRAP,
    )
    rgb *= tex[..., None]
    if fig.hair_style != "none":
        rng = np.random.default_rng(fig.seed + 7)
        hair_mask = np.zeros((ch, cw), np.uint8)
        top_centre = (hc[0] + sway * 2 * ss, hc[1] - head_r * 0.35 * ss)
        cv2.ellipse(
            hair_mask,
            ((top_centre[0], top_centre[1]), (2.25 * head_r * ss, 1.55 * head_r * ss), 0),
            255,
            -1,
        )
        cv2.ellipse(
            hair_mask,
            (
                (hc[0] - head_r * 0.85 * ss, hc[1] + head_r * 0.2 * ss),
                (0.5 * head_r * ss, 1.6 * head_r * ss),
                8,
            ),
            255,
            -1,
        )
        strands = 12 if fig.hair_style == "mass" else 70
        for i in range(strands):
            angle = math.pi * (1.1 + 0.8 * i / max(strands - 1, 1)) + rng.uniform(-0.15, 0.15)
            sx = top_centre[0] + math.cos(angle) * head_r * ss * 1.05
            sy = top_centre[1] + math.sin(angle) * head_r * ss * 0.75
            length = head_r * ss * rng.uniform(0.25, 0.6 if fig.hair_style == "mass" else 0.9)
            ex = sx + math.cos(angle + 0.3 * math.sin(phase + i)) * length
            ey = sy + math.sin(angle + 0.3 * math.sin(phase + i)) * length
            thickness = (
                int(rng.integers(2 * ss // 2, 3 * ss // 2 + 1))
                if fig.hair_style == "mass"
                else int(rng.integers(ss // 2, ss + 1))
            )
            cv2.line(
                hair_mask,
                (int(sx), int(sy)),
                (int(ex), int(ey)),
                255,
                max(thickness, 1),
                cv2.LINE_AA,
            )
        soft = cv2.GaussianBlur(hair_mask.astype(np.float32) / 255.0, (0, 0), 0.6 * ss)
        hair_alpha = np.clip(soft * 1.15, 0.0, 1.0)
        hair_rgb = np.array(fig.hair, np.float32) / 255.0
        rgb = rgb * (1 - hair_alpha[..., None]) + hair_rgb * hair_alpha[..., None]
        alpha = np.maximum(alpha, hair_alpha)
    prem = cv2.resize(rgb * alpha[..., None], (bw, bh), interpolation=cv2.INTER_AREA)
    small_alpha = cv2.resize(alpha, (bw, bh), interpolation=cv2.INTER_AREA)
    full_p[y0:y1, x0:x1] = prem
    full_a[y0:y1, x0:x1] = small_alpha
    return full_p, full_a


def render_product(t: float, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """A mug with a handle on a slowly turning table: rigid, glossy, with a thin handle."""
    canvas_w, canvas_h = W * 2, H * 2
    rgb = np.zeros((canvas_h, canvas_w, 3), np.float32)
    alpha = np.zeros((canvas_h, canvas_w), np.float32)
    cx = canvas_w // 2 + int(60 * math.sin(t / 8))
    body = np.zeros((canvas_h, canvas_w), np.uint8)
    cv2.rectangle(body, (cx - 200, 460), (cx + 200, 1060), 255, -1)
    cv2.ellipse(body, (cx, 1060), (200, 60), 0, 0, 180, 255, -1)
    cv2.ellipse(body, (cx + 200, 760), (120, 170), 0, -90, 90, 255, 46)
    ys, xs = np.nonzero(body)
    shade = np.clip(0.95 - 0.35 * np.abs(xs - (cx - 60)) / 260.0, 0.45, 1.0)
    colour = np.array([0.72, 0.18, 0.16] if seed % 2 == 0 else [0.16, 0.42, 0.7], np.float32)
    rgb[ys, xs] = colour * shade[:, None]
    alpha[ys, xs] = 1.0
    prem = cv2.resize(rgb * alpha[..., None], (W, H), interpolation=cv2.INTER_AREA)
    return prem, cv2.resize(alpha, (W, H), interpolation=cv2.INTER_AREA)


def blurred(
    render: Callable[[float], tuple[np.ndarray, np.ndarray]], t: float, samples: int
) -> tuple[np.ndarray, np.ndarray]:
    acc_p = np.zeros((H, W, 3), np.float32)
    acc_a = np.zeros((H, W), np.float32)
    for s in range(samples):
        p, a = render(t + ((s + 0.5) / samples - 0.5) * 0.5)
        acc_p += p
        acc_a += a
    return acc_p / samples, acc_a / samples


PERSON = {
    "skin": (214, 170, 140),
    "hair": (58, 38, 26),
    "top": (48, 88, 150),
    "bottom": (46, 46, 56),
}
WARM = {
    "skin": (170, 118, 88),
    "hair": (104, 66, 40),
    "top": (150, 100, 70),
    "bottom": (104, 72, 52),
}


def palette(seed: int, base: dict[str, tuple[int, int, int]]) -> dict[str, tuple[int, int, int]]:
    rng = np.random.default_rng(seed)
    return {
        k: tuple(int(np.clip(c + rng.integers(-18, 19), 0, 255)) for c in v)
        for k, v in base.items()
    }  # type: ignore[misc]


def walker(x0: float, vx: float, y: float, cadence: float = 0.35) -> Path2:
    return lambda t: (x0 + vx * t, y, t * cadence, 0.0)


def specs(seed: int) -> dict[str, dict[str, Any]]:
    j = np.random.default_rng(seed)
    dx = float(j.uniform(-40, 40))

    def fig(
        height: float, base: dict, style: str = "mass", head: float = 1.0, offset: int = 0
    ) -> Figure:
        colours = palette(seed + offset, base)
        return Figure(
            height,
            colours["skin"],
            colours["hair"],
            colours["top"],
            colours["bottom"],
            seed + offset,
            style,
            head,
        )

    return {
        "talking_head": dict(
            bg="bg_000110",
            bg_path=lambda t: (200, 60),
            blur=3,
            subject=(
                fig(1500, PERSON, head=1.5, offset=1),
                lambda t: (640 + dx + 25 * math.sin(t / 7), 1450, 0.1, 0.6 * math.sin(t / 5)),
            ),
        ),
        "walk_pan": dict(
            bg="bg_000330",
            bg_path=lambda t: (150 + 5 * t, 40),
            blur=3,
            subject=(fig(520, PERSON, offset=2), walker(420 + dx, 7, 660)),
        ),
        "hair_busy": dict(
            bg="bg_000920",
            bg_path=lambda t: (300 + 2 * t, 70 + 2 * math.sin(t / 4)),
            blur=3,
            subject=(
                fig(1300, PERSON, style="flyaway", head=1.7, offset=3),
                lambda t: (640 + dx + 40 * math.sin(t / 9), 1300, 0.15, math.sin(t / 6)),
            ),
        ),
        "similar_colour": dict(
            bg="bg_001130",
            bg_path=lambda t: (300 + 3 * t, 90),
            blur=3,
            subject=(fig(500, WARM, offset=4), walker(360 + dx, 8, 670)),
        ),
        "crossing": dict(
            bg="bg_000440",
            bg_path=lambda t: (250, 70),
            blur=3,
            subject=(fig(500, PERSON, offset=5), walker(560 + dx, 2, 660)),
            occluder=(
                fig(540, {**PERSON, "top": (150, 44, 40)}, offset=50),
                walker(1180, -24, 690),
            ),
        ),
        "leave_reenter": dict(
            bg="bg_000330",
            bg_path=lambda t: (420, 60),
            blur=3,
            subject=(
                fig(500, PERSON, offset=6),
                lambda t: (1000 + 460 * math.sin(t * math.pi / 30), 660, t * 0.4, 0.0),
            ),
        ),
        "fast_motion": dict(
            bg="bg_000550",
            bg_path=lambda t: (80 + 18 * t, 40),
            blur=7,
            subject=(fig(520, PERSON, offset=7), walker(180 + dx, 22, 665, 0.6)),
        ),
        "twin_distractor": dict(
            bg="bg_000440",
            bg_path=lambda t: (400 + 2 * t, 70),
            blur=3,
            subject=(fig(500, PERSON, offset=8), walker(460 + dx, 8, 665)),
            behind=(fig(500, PERSON, offset=8), walker(980, -7, 655)),
        ),
        "low_light": dict(
            bg="bg_000330",
            bg_path=lambda t: (560 - 3 * t, 40),
            blur=3,
            gain=0.4,
            noise=0.012,
            subject=(fig(520, WARM, offset=9), walker(880 + dx, -8, 665)),
        ),
        "product_table": dict(
            bg="bg_000920", bg_path=lambda t: (500 + 1.5 * t, 200), blur=1, product=True
        ),
    }


def encode(path: Path, frames: list[np.ndarray]) -> None:
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
         "-i", "-", "-c:v", "ffv1", str(path)],
        input=b"".join(frame.tobytes() for frame in frames), check=True,
    )  # fmt: skip


def render_clip(category: str, split: str) -> Path:
    seed = SPLITS[split] + sorted(specs(0)).index(category) * 17 + 3
    spec = specs(seed)[category]
    out = PILOT_DIR / f"{category}__{split}"
    if (out / "meta.json").is_file():
        return out
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    bg = load_bg(spec["bg"], 1.3)
    frames: list[np.ndarray] = []
    truth = np.zeros((FRAMES, H, W), np.uint8)
    for t in range(FRAMES):
        frame = bg_frame(bg, *spec["bg_path"](t))
        if "behind" in spec:
            figure, path = spec["behind"]
            p, a = blurred(lambda s, f=figure, q=path: render_figure(f, *q(s)), t, spec["blur"])
            frame = p + (1 - a[..., None]) * frame
        if spec.get("product"):
            sp, sa = blurred(lambda s: render_product(s, seed), t, spec["blur"])
        else:
            figure, path = spec["subject"]
            sp, sa = blurred(lambda s, f=figure, q=path: render_figure(f, *q(s)), t, spec["blur"])
        frame = sp + (1 - sa[..., None]) * frame
        visible = sa
        if "occluder" in spec:
            figure, path = spec["occluder"]
            op, oa = blurred(lambda s, f=figure, q=path: render_figure(f, *q(s)), t, spec["blur"])
            frame = op + (1 - oa[..., None]) * frame
            visible = sa * (1 - oa)
        if "gain" in spec:
            luma_noise = rng.normal(0, spec["noise"], (H, W, 1)).astype(np.float32)
            chroma_noise = rng.normal(0, spec["noise"] * 0.5, (H, W, 3)).astype(np.float32)
            frame = frame * spec["gain"] + luma_noise + chroma_noise
        truth[t] = np.clip(np.round(visible * 255), 0, 255).astype(np.uint8)
        frames.append((np.clip(frame, 0, 1) * 255 + 0.5).astype(np.uint8))
    encode(out / "frames.mkv", frames)
    np.savez_compressed(out / "gt_alpha.npz", alpha=truth)
    first = truth[0] >= 128
    ys, xs = np.nonzero(first)
    box = None
    if len(xs):
        box = {"x": float(xs.min()) / W, "y": float(ys.min()) / H,
               "width": float(xs.max() + 1 - xs.min()) / W, "height": float(ys.max() + 1 - ys.min()) / H}  # fmt: skip
    (out / "meta.json").write_text(json.dumps({
        "category": category, "split": split, "seed": seed, "frames": FRAMES, "fps": FPS, "width": W, "height": H,
        "box": box, "licence": {"subject": "generated (eval/pilot.py)", "background": LICENCE_BG},
        "foregroundFractionMean": round(float((truth >= 128).mean()), 4),
    }, indent=2))  # fmt: skip
    return out


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("categories", nargs="*")
    parser.add_argument("--split", choices=[*SPLITS, "both"], default="both")
    arguments = parser.parse_args()
    categories = arguments.categories or sorted(specs(0))
    splits = list(SPLITS) if arguments.split == "both" else [arguments.split]
    for split in splits:
        for category in categories:
            out = render_clip(category, split)
            meta = json.loads((out / "meta.json").read_text())
            print(out.name, meta["foregroundFractionMean"], flush=True)


if __name__ == "__main__":
    main()
