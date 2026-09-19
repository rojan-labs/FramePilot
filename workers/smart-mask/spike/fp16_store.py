"""Turn an fp32 ONNX model into "fp16-stored, fp32-computed".

Every large float32 initializer is stored as float16 and immediately upcast with a ``Cast``
node, so the graph still computes in float32. onnxruntime's basic (level 1) constant folding
evaluates those Casts once at session creation, before EP partitioning, so at run time the
kernels see ordinary float32 constants. Nothing is computed in fp16.

Before conversion, large ``Constant`` nodes become initializers and byte-identical
initializers are merged (a lossless size fix, applied to the fp32 file too by
``dedupe_fp32``).

Rules (so the conversion can never silently corrupt a value):
- only initializers with at least ``MIN_ELEMENTS`` elements are converted (small constants,
  epsilons and scales stay fp32; their size is irrelevant);
- an initializer with any finite value outside the fp16 range stays fp32;
- the report lists how many were converted, kept, and the worst round-trip error.

Usage: python fp16_store.py in.onnx out.onnx
"""

from __future__ import annotations

import json
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper

MIN_ELEMENTS = 1024
FP16_MAX = float(np.finfo(np.float16).max)


def _constants_to_initializers(graph) -> None:
    """Large ``Constant`` nodes (exporter-folded tables) become initializers so they are stored fp16 too."""
    keep = []
    for node in graph.node:
        tensor_attrs = [a for a in node.attribute if a.name == "value" and a.type == onnx.AttributeProto.TENSOR]
        if node.op_type == "Constant" and tensor_attrs and int(np.prod(tensor_attrs[0].t.dims)) >= MIN_ELEMENTS:
            t = onnx.TensorProto()
            t.CopyFrom(tensor_attrs[0].t)
            t.name = node.output[0]
            graph.initializer.append(t)
            continue
        keep.append(node)
    del graph.node[:]
    graph.node.extend(keep)


def _dedupe_initializers(graph) -> int:
    """Merge byte-identical initializers (the exporter copies RoPE tables per attention call)."""
    import hashlib

    canonical: dict[tuple, str] = {}
    rename: dict[str, str] = {}
    keep = []
    for init in graph.initializer:
        key = (init.data_type, tuple(init.dims), hashlib.sha256(numpy_helper.to_array(init).tobytes()).hexdigest())
        if key in canonical:
            rename[init.name] = canonical[key]
            continue
        canonical[key] = init.name
        keep.append(init)
    del graph.initializer[:]
    graph.initializer.extend(keep)
    graph_outputs = {o.name for o in graph.output}
    for node in graph.node:
        for i, name in enumerate(node.input):
            if name in rename:
                node.input[i] = rename[name]
    assert not (graph_outputs & set(rename)), "an initializer is a graph output"
    return len(rename)


def convert(model: onnx.ModelProto) -> dict:
    graph = model.graph
    _constants_to_initializers(graph)
    deduped = _dedupe_initializers(graph)
    converted = kept_small = kept_range = 0
    worst_abs_err = 0.0
    new_inits = []
    cast_nodes = []
    for init in graph.initializer:
        if init.data_type != onnx.TensorProto.FLOAT:
            new_inits.append(init)
            continue
        arr = numpy_helper.to_array(init)
        if arr.size < MIN_ELEMENTS:
            kept_small += 1
            new_inits.append(init)
            continue
        if np.any(np.abs(arr[np.isfinite(arr)]) > FP16_MAX):
            kept_range += 1
            new_inits.append(init)
            continue
        half = arr.astype(np.float16)
        worst_abs_err = max(worst_abs_err, float(np.max(np.abs(half.astype(np.float32) - arr))))
        stored_name = f"{init.name}__fp16"
        new_inits.append(numpy_helper.from_array(half, stored_name))
        cast_nodes.append(
            helper.make_node("Cast", [stored_name], [init.name], to=onnx.TensorProto.FLOAT, name=f"upcast_{init.name}")
        )
        converted += 1
    del graph.initializer[:]
    graph.initializer.extend(new_inits)
    # Casts must precede their consumers in topological order.
    existing = list(graph.node)
    del graph.node[:]
    graph.node.extend(cast_nodes + existing)
    return {
        "dedupedInitializers": deduped,
        "converted": converted,
        "keptSmall": kept_small,
        "keptOutOfFp16Range": kept_range,
        "worstRoundTripAbsError": worst_abs_err,
    }


def dedupe_fp32(model: onnx.ModelProto) -> int:
    """The same lossless constant hoisting + dedupe, without any fp16 storage."""
    _constants_to_initializers(model.graph)
    return _dedupe_initializers(model.graph)


def strip_trace_metadata(model: onnx.ModelProto) -> None:
    """Drop the exporter's per-node stack traces and doc strings (never read at runtime).

    The dynamo exporter records each node's Python stack trace, absolute file paths included,
    so the same export from two checkout paths produced different bytes and never matched its
    pin (models.lock.toml). Without them the graph hashes the same wherever it is exported.
    """

    def strip_graph(graph: onnx.GraphProto) -> None:
        for node in graph.node:
            del node.metadata_props[:]
            node.doc_string = ""
            for attribute in node.attribute:
                if attribute.type == onnx.AttributeProto.GRAPH:
                    strip_graph(attribute.g)
                for subgraph in attribute.graphs:
                    strip_graph(subgraph)
        del graph.metadata_props[:]
        graph.doc_string = ""

    strip_graph(model.graph)
    for function in model.functions:
        for node in function.node:
            del node.metadata_props[:]
            node.doc_string = ""
        del function.metadata_props[:]
    del model.metadata_props[:]
    model.doc_string = ""


def main(src: str, dst: str) -> None:
    model = onnx.load(src)
    report = convert(model)
    onnx.save(model, dst)
    print(json.dumps(report))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
