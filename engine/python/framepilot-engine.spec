# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the bundled FramePilot engine sidecar.
#
# WHY: the packaged desktop app cannot assume `uv`, a Python install, or this
# repo on the user's machine (plan Phase 8 "Desktop packaging completeness").
# This spec freezes the engine + its runtime deps into a self-contained onedir
# bundle that apps/desktop ships under Resources/engine/ and spawns as the
# render sidecar. Driven by apps/desktop/scripts/package-engine.mjs via
# `uv run --extra package pyinstaller framepilot-engine.spec`.
#
# onedir (not onefile): onefile self-extracts to a temp dir on EVERY launch —
# seconds of startup latency and disk churn for a ~200MB bundle; onedir starts
# instantly and lets Electron's differential auto-update ship smaller deltas.
from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)

hiddenimports = [
    # The whole engine: `serve` lazily imports service/ai_tools/analysis modules,
    # so static analysis of the entry script alone would miss them.
    *collect_submodules("framepilot_engine"),
    # uvicorn picks loop/protocol implementations by string at runtime
    # (uvicorn.loops.auto, uvicorn.protocols.*.auto) — invisible to analysis.
    *collect_submodules("uvicorn"),
    # MoviePy resolves fx/plugins dynamically in places; collect it wholesale
    # (pure Python, negligible size) rather than chase individual misses.
    *collect_submodules("moviepy"),
    # sqlite-vec is imported lazily inside a function/try block
    # (brain/vector_store.py:vec_available), so name it explicitly rather than
    # trust analysis to follow the guarded import (plan MI2.4, D4).
    "sqlite_vec",
    # The TwelveLabs SDK (brain/twelvelabs.py facade) is Fern-generated: its
    # top-level __init__ exposes types/resources via lazy __getattr__ import, so
    # static analysis of `from twelvelabs import ...` would miss the resource and
    # type submodules and a frozen desktop build would ImportError the moment a
    # TwelveLabs key is used. Collect it wholesale (pure Python, small) like the
    # other dynamically-dispatched packages above.
    *collect_submodules("twelvelabs"),
]

datas = [
    # Pillow's bundled DejaVu font — caption rasterization uses it
    # (deterministic text rendering); it is package data, not code.
    *collect_data_files("PIL"),
    # The engine's OWN package data — the committed cross-language catalogs
    # (`render/caption_templates.json`, `render/effect_catalog.json`) that
    # `importlib.resources` loads at runtime.
    #
    # WHY this is needed and `collect_submodules` above is not enough:
    # collect_submodules carries MODULES. A .json file inside the package is
    # data, so without this line a frozen sidecar raises
    # FileNotFoundError from `resources.files(...).read_text()` the first time
    # a render touches captions or an effect layer — while `uv run` from the
    # repo works fine, which is exactly the kind of gap that only shows up in
    # a packaged desktop build (the priority-#1 target).
    *collect_data_files("framepilot_engine"),
    # These packages read their own version via importlib.metadata at runtime
    # (verified: a frozen render fails with "No package metadata was found for
    # imageio" without this). Metadata is not code, so collect_submodules alone
    # does not carry it into the bundle.
    *copy_metadata("imageio"),
    *copy_metadata("imageio-ffmpeg"),
    *copy_metadata("moviepy"),
    # sqlite-vec's dist-info: keeps importlib.metadata resolvable in the freeze
    # (parity with the imageio metadata handling above), and pairs with the
    # native lib below so the packaged vec0 backend is discoverable, not just
    # the Python shim.
    *copy_metadata("sqlite_vec"),
    # The TwelveLabs SDK reads its OWN version at import time
    # (twelvelabs/version.py: `metadata.version("twelvelabs")`, run from
    # __init__), and brain/twelvelabs.py imports the SDK at sidecar startup — so
    # without its dist-info a frozen build raises PackageNotFoundError on boot.
    # Metadata is not code, so collect_submodules above does not carry it.
    *copy_metadata("twelvelabs"),
]

# Native loadable SQLite extension for indexed KNN vector search (plan MI2.4,
# D4). collect_dynamic_libs stages `vec0.dylib`/`.so`/`.dll` into the frozen
# bundle's `sqlite_vec/` package dir — the SAME dir sqlite_vec.loadable_path()
# derives from `dirname(__file__)`, so the runtime loader resolves the bundled
# lib without a hardcoded path. Missing this, packaged desktop builds would
# silently degrade to brute-force cosine instead of vec0 KNN.
binaries = [
    *collect_dynamic_libs("sqlite_vec"),
]

a = Analysis(
    ["packaging/pyinstaller_entry.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Never useful in a headless sidecar; excluding them keeps the bundle lean.
    excludes=["tkinter", "pytest", "IPython"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="framepilot-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    # macOS notarization requirements for the embedded binary; harmless elsewhere.
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="framepilot-engine",
)
