"""Golden vectors for the unscaled yuv420p -> rgb24 converter of the macOS arm64 export host (MK6.4).

Runs the ffmpeg MoviePy uses (imageio-ffmpeg's bundled binary) with the export's own argv shape
(`-vf scale=W:H -sws_flags bicubic -pix_fmt rgb24`) on seeded random planes. Only meaningful on
an Apple Silicon Mac: on x86 the same argv takes the SIMD converter instead.

    cd engine/python && uv run python \
      ../../apps/web-editor/src/preview/engine/raster/__fixtures__/swscale-unscaled-arm64-golden.py \
      ../../apps/web-editor/src/preview/engine/raster/__fixtures__/swscale-unscaled-arm64-golden.json
"""
import base64, json, subprocess, sys
import numpy as np
import imageio_ffmpeg

exe = imageio_ffmpeg.get_ffmpeg_exe()
version = subprocess.run([exe, "-version"], capture_output=True, text=True).stdout.splitlines()[0]
rng = np.random.default_rng(20260919)
cases = []
for (w, h) in [(48, 32), (62, 18)]:
    for matrix, tag in [("bt709", "bt709"), ("bt601", "smpte170m")]:
        for rng_name in ["tv", "pc"]:
            y = rng.integers(0, 256, (h, w), dtype=np.uint8)
            u = rng.integers(0, 256, (h // 2, w // 2), dtype=np.uint8)
            v = rng.integers(0, 256, (h // 2, w // 2), dtype=np.uint8)
            raw = y.tobytes() + u.tobytes() + v.tobytes()
            argv = [exe, "-v", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{w}x{h}",
                    "-color_range", rng_name, "-colorspace", tag, "-i", "-",
                    "-vf", f"scale={w}:{h}", "-sws_flags", "bicubic", "-pix_fmt", "rgb24",
                    "-f", "rawvideo", "-"]
            out = subprocess.run(argv, input=raw, capture_output=True, check=True).stdout
            assert len(out) == w * h * 3, (len(out), w, h)
            b64 = lambda a: base64.b64encode(a).decode()
            cases.append({"width": w, "height": h, "matrix": matrix, "range": rng_name,
                          "y": b64(y.tobytes()), "u": b64(u.tobytes()), "v": b64(v.tobytes()),
                          "rgb": b64(out)})
json.dump({"generator": f"{version} ({exe.rsplit('/', 1)[-1]}, imageio-ffmpeg): "
           "-vf scale=W:H -sws_flags bicubic -pix_fmt rgb24 on seeded random yuv420p planes "
           "(swscale-unscaled-arm64-golden.py)",
           "cases": cases}, open(sys.argv[1], "w"), indent=1)
print(version, len(cases))
