"""BR0.7 probe: PyTorch CPU fp32 peak RSS and time for one BiRefNet_HR-matting forward at a size.

Run one size per process (peak RSS is per process). Used to extrapolate the 2048² tile
footprint on machines where a 2048² forward does not fit beside other workloads.
"""
import sys, time, json, torch
import common
from export_birefnet import load_birefnet, BiRefNetAlpha
size = int(sys.argv[1])
m = BiRefNetAlpha(load_birefnet())
base = common.peak_rss_mib()
x = torch.rand(1, 3, size, size)
t = time.time()
with torch.inference_mode():
    y = m(x)
dt = time.time() - t
print(json.dumps({"size": size, "weightsLoadedRssMiB": round(base), "peakRssMiB": round(common.peak_rss_mib()), "forwardSeconds": round(dt, 1)}))
