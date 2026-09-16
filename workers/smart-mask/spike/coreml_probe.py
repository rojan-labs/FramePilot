"""BR0.2/BR0.7: per-module CoreML EP session build probe.

For each ONNX file, create a CoreML EP session (MLProgram, static shapes) with a given compute
unit setting, record create time (first-run preparation, cache cold), a second create (cache
warm), how many nodes CoreML took, one timed run on random input, or the error.

    python coreml_probe.py --units ALL sam21l_memory_encoder.fp32
"""
import argparse, json, shutil, sys, time
import numpy as np
import onnxruntime as ort
import common

DTYPES = {"tensor(float)": np.float32, "tensor(int32)": np.int32, "tensor(bool)": np.bool_, "tensor(int64)": np.int64}


def feeds(sess):
    out = {}
    for i in sess.get_inputs():
        shape = [d if isinstance(d, int) else 1 for d in i.shape]
        dt = DTYPES[i.type]
        if dt is np.bool_:
            out[i.name] = np.ones(shape, bool)
        elif dt is np.float32:
            out[i.name] = np.random.default_rng(0).standard_normal(shape).astype(np.float32)
        else:
            out[i.name] = np.ones(shape, dt)
    return out


def probe(stem, units):
    cache = common.CACHE / "coreml-probe" / f"{stem}-{units}"
    shutil.rmtree(cache, ignore_errors=True)
    opts = ort.SessionOptions(); opts.log_severity_level = 3
    prov = [("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "RequireStaticInputShapes": "1",
             "MLComputeUnits": units, "ModelCacheDirectory": str(cache)}), "CPUExecutionProvider"]
    rec = {"model": stem, "units": units}
    try:
        t0 = time.time(); s = ort.InferenceSession(str(common.ONNX_DIR / f"{stem}.onnx"), opts, providers=prov)
        rec["createColdSeconds"] = round(time.time() - t0, 1)
        f = feeds(s)
        t0 = time.time(); s.run(None, f); rec["firstRunSeconds"] = round(time.time() - t0, 2)
        t0 = time.time(); s.run(None, f); rec["secondRunSeconds"] = round(time.time() - t0, 2)
        del s
        t0 = time.time(); s = ort.InferenceSession(str(common.ONNX_DIR / f"{stem}.onnx"), opts, providers=prov)
        rec["createWarmSeconds"] = round(time.time() - t0, 1)
        rec["ok"] = True
    except Exception as e:  # recorded, not retried
        rec["ok"] = False; rec["error"] = str(e)[:300]
    rec["peakRssMiB"] = round(common.peak_rss_mib())
    return rec


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--units", default="ALL"); ap.add_argument("stem")
    a = ap.parse_args()
    r = probe(a.stem, a.units)
    print(json.dumps(r), flush=True)
    with open(common.RESULTS / "coreml_probe.jsonl", "a") as fh:
        fh.write(json.dumps({**r, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}) + "\n")
