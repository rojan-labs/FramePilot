# Export

Export in FramePilot is **quality-driven**: you choose a resolution, a frame rate, a
quality tier, a codec and a container. There are no platform presets — the output frame
always follows the project's own aspect ratio, and every choice is the same one you would
make in CapCut, Premiere or Resolve.

## The dialog

Topbar → **Export**.

| Field              | Choices                                                 | Default     |
| ------------------ | ------------------------------------------------------- | ----------- |
| Resolution         | 480p · 720p · 1080p · 1440p (2K) · 2160p (4K)           | 1080p       |
| Frame rate         | Project · 24 · 25 · 30 · 50 · 60                        | Project     |
| Quality            | Low · Recommended · High                                | Recommended |
| Codec              | H.264 (plays everywhere) · HEVC / H.265 (smaller files) | H.264       |
| Format             | MP4 · MOV                                               | MP4         |
| Audio (disclosure) | loudness, EQ, compression, de-noise, limiter            | off         |
| Burn captions      | on/off                                                  | off         |

The line under the choices states exactly what you get — e.g.
`1080 × 1920 · 30 fps · MP4 (H.264) · about 31 MB` — computed from the project's aspect,
the programme length and the bitrate ladder the engine uses.

**Never a silent upscale.** The resolution is capped at what your sources hold: a project
built from 720p footage exported at "2160p" produces a 720p file and the dialog says so
("Your sources are 720p, so the export is capped there instead of being upscaled"). Options
above the cap are labelled `(upscaled — sources are 720p)`.

Your last-used settings are remembered per project.

## What the engine does with them

`engine/python/framepilot_engine/render/export_settings.py` turns the settings into an
encode target: the short edge of the frame is the named resolution (portrait: width;
landscape: height), the bitrate comes from a published delivery ladder (1080p Recommended
≈ 8 Mbit/s; HEVC ≈ 65% of that; > 30 fps ≈ 1.5×), audio is AAC at 128/192/256 kbit/s by
tier.

The encoder is chosen at export time (`render/encoders.py`): VideoToolbox on Apple
silicon, NVENC or QSV where present, otherwise x264/x265 with `veryfast` / `medium` /
`slow` for Low / Recommended / High. Every export writes `+faststart`, `yuv420p`, and tags
HEVC as `hvc1` so Apple players open it. Set `FRAMEPILOT_HW_ENCODE=0` to force software
encoding. The job record (`GET /render/jobs/{id}`) carries the target and the exact
encoder string the export ran with.

Sources are decoded by ffmpeg at the size the export needs (a 4K file fitted into a 1080p
frame is decoded at 1080p; a crop is given proportionally more; animated clips are decoded
in full), so the compositor is not handed pixels it will throw away.

## Progress and cancellation

The dialog shows the render stage and percent (`Rendering… 42%`, then
`Checking the file…`). Cancel stops the render process **and** its ffmpeg child (the
render runs in its own process group), then removes nothing you had before — outputs only
ever land in the project's `exports/` folder.

## CLI

```bash
uv run framepilot render project.fp.json --resolution 1080p --fps source --quality recommended --codec h264 --container mp4
```

## Agent

The `/export` command and the `export_video` tool use the same engine path with the
default settings; the agent never chooses a platform.

## Progress, time left and recent exports

While rendering, the status line shows the engine's stage and percentage, and — once
enough of the render has run to measure its pace — "about N s left". The estimate is
derived from progress the engine actually reported; it is never shown before there is a
rate to derive it from.

Each finished export is remembered per project (the last ten) under **Recent exports** in
the Export dialog, with the resolution and container it was rendered at and a **Reveal**
button that opens its folder.

## What the tier actually gets you

The resolution tier is a **request**; your media gives the answer. A 360p source asked to
export at 4K produces 360p — FramePilot never upscales, because inventing pixels costs
time and adds nothing. The summary line above the Export button always shows the exact
frame that will be produced, and warns you before an upscale would have happened.

Measured on the reference fixtures: a 30-second 4K project exports at 1080×1920 in about
11 seconds and at 2160×3840 in about 38; a 360p project takes the same 3.7 seconds whether
you ask for 1080p or 4K, because both produce 640×360.
