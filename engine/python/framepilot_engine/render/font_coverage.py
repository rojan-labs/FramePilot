"""Which writing systems each bundled caption font can draw, read from the font files.

WHY this exists: the caption font catalog (``packages/timeline-schema/src/caption-fonts.ts``)
recorded weights and categories but not which scripts a family has glyphs for. Desktop run
``001be135`` captioned a Hindi narration with "Bebas Neue" as the accent font — a Latin-only
face — so every accented Devanagari word drew as missing-glyph boxes in the export, and the
agent spent five restyles trying to make the second font show with nothing telling it why.
The catalog now carries a ``scripts`` list per family; this module is where those lists come
from, and ``tests/test_caption_font_scripts.py`` re-measures every family against the
committed catalog so a new font cannot ship with a guessed list.

A family covers a script when every file it ships (regular, bold, italic) maps every letter
of that script's CORE alphabet — the letters its main languages cannot be written without —
in its ``cmap`` table. Rare letters (archaic forms, nukta-precomposed consonants, Romanian
T-cedilla) are deliberately left out of the cores: a font that lacks only those still sets
the language. Read with the standard library because only the ``cmap`` table is needed;
formats 4 (BMP) and 12 (full Unicode) are what every bundled face uses.

Run ``uv run python -m framepilot_engine.render.font_coverage`` to print the measured lists
as JSON, to paste into the TypeScript catalog after adding a font.
"""

from __future__ import annotations

import json
import struct
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path

#: Where the bundled caption fonts and their manifest live.
FONTS_DIR = Path(__file__).resolve().parent / "fonts"

#: The script vocabulary, in the order the TypeScript catalog lists it (``CAPTION_FONT_SCRIPTS``).
SCRIPT_ORDER: tuple[str, ...] = (
    "latin",
    "latin-ext",
    "cyrillic",
    "greek",
    "devanagari",
    "bengali",
    "arabic",
    "hebrew",
    "thai",
    "cjk",
)

#: ``cmap`` subtables that map Unicode: (platform, encoding) pairs.
_UNICODE_SUBTABLES = frozenset({(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 6), (3, 1), (3, 10)})


def _span(first: int, last: int) -> tuple[int, ...]:
    return tuple(range(first, last + 1))


def _chars(text: str) -> tuple[int, ...]:
    return tuple(ord(ch) for ch in text)


#: Each script's core alphabet (see the module docstring for what is left out, and why).
SCRIPT_CORES: Mapping[str, frozenset[int]] = {
    # ASCII letters plus the accented letters of French, Spanish, German and Portuguese —
    # not the Nordic eth/thorn/o-slash, which some display faces lack while setting English.
    "latin": frozenset(
        (*_span(0x41, 0x5A), *_span(0x61, 0x7A), *_chars("ÀÁÂÄÇÈÉÊËÍÎÏÑÓÔÖÚÛÜàáâäçèéêëíîïñóôöúûüß"))
    ),
    # Central European, Baltic and Turkish letters (Latin Extended-A).
    "latin-ext": frozenset(
        _chars("ĀāĂăĄąĆćČčĎďĐđĒēĖėĘęĚěĞğĢģĪīĮįİıĶķĹĺĻļĽľŁłŃńŅņŇňŐőŒœŔŕŘřŚśŞşŠšŤťŪūŮůŰűŲųŹźŻżŽž")
    ),
    # The Russian alphabet.
    "cyrillic": frozenset((*_span(0x410, 0x44F), 0x401, 0x451)),
    # The modern Greek alphabet (U+03A2 is unassigned).
    "greek": frozenset((*_span(0x391, 0x3A1), *_span(0x3A3, 0x3A9), *_span(0x3B1, 0x3C9))),
    # Hindi's vowels, consonants, vowel signs, virama, nukta and nasal marks — not the
    # nukta-precomposed U+0929/U+0931/U+0934, which Hindi rarely writes and Poppins lacks.
    "devanagari": frozenset(
        (
            *_span(0x901, 0x903),
            *_span(0x905, 0x90B),
            0x90F,
            0x910,
            0x913,
            0x914,
            *_span(0x915, 0x928),
            *_span(0x92A, 0x930),
            0x932,
            0x933,
            *_span(0x935, 0x939),
            0x93C,
            *_span(0x93E, 0x943),
            0x947,
            0x948,
            0x94B,
            0x94C,
            0x94D,
        )
    ),
    # Bengali's vowels, consonants and vowel signs.
    "bengali": frozenset(
        (
            *_span(0x985, 0x98C),
            0x98F,
            0x990,
            0x993,
            0x994,
            *_span(0x995, 0x9A8),
            *_span(0x9AA, 0x9B0),
            0x9B2,
            *_span(0x9B6, 0x9B9),
            *_span(0x9BE, 0x9C4),
            0x9C7,
            0x9C8,
            0x9CB,
            0x9CC,
            0x9CD,
        )
    ),
    # The Arabic letters (hamza through yeh).
    "arabic": frozenset((*_span(0x621, 0x63A), *_span(0x641, 0x64A))),
    # The Hebrew letters, final forms included.
    "hebrew": frozenset(_span(0x5D0, 0x5EA)),
    # Thai consonants, vowels and tone marks.
    "thai": frozenset((*_span(0xE01, 0xE2E), *_span(0xE30, 0xE3A), *_span(0xE40, 0xE4E))),
    # Hiragana, katakana and a handful of the commonest ideographs.
    "cjk": frozenset(
        (*_span(0x3041, 0x3093), *_span(0x30A1, 0x30F3), *_chars("一人大中国日本年生"))
    ),
}


def cmap_codepoints(data: bytes) -> frozenset[int]:
    """Every code point the font's Unicode ``cmap`` subtables map to a real glyph.

    :param data: The whole font file (TrueType/OpenType, not a collection).
    :raises ValueError: when the file has no ``cmap`` table, or a subtable runs off its end.
    """
    try:
        return _read_cmap(data)
    except struct.error as error:
        raise ValueError(f"Font cmap table is truncated: {error}") from error


def _read_cmap(data: bytes) -> frozenset[int]:
    (table_count,) = struct.unpack_from(">H", data, 4)
    cmap_offset = None
    for index in range(table_count):
        tag, _checksum, offset, _length = struct.unpack_from(">4sIII", data, 12 + 16 * index)
        if tag == b"cmap":
            cmap_offset = offset
            break
    if cmap_offset is None:
        raise ValueError("Font has no cmap table, so no code point can be drawn from it.")
    _version, subtable_count = struct.unpack_from(">HH", data, cmap_offset)
    mapped: set[int] = set()
    for index in range(subtable_count):
        platform, encoding, offset = struct.unpack_from(">HHI", data, cmap_offset + 4 + 8 * index)
        if (platform, encoding) not in _UNICODE_SUBTABLES:
            continue
        start = cmap_offset + offset
        (fmt,) = struct.unpack_from(">H", data, start)
        if fmt == 4:
            mapped.update(_format4(data, start))
        elif fmt == 12:
            mapped.update(_format12(data, start))
    return frozenset(mapped)


def _format4(data: bytes, start: int) -> Iterable[int]:
    """Segment-mapped BMP subtable: a code point counts when its glyph id is not 0."""
    (seg_x2,) = struct.unpack_from(">H", data, start + 6)
    segments = seg_x2 // 2
    ends = struct.unpack_from(f">{segments}H", data, start + 14)
    starts = struct.unpack_from(f">{segments}H", data, start + 16 + seg_x2)
    deltas = struct.unpack_from(f">{segments}h", data, start + 16 + 2 * seg_x2)
    range_offsets_at = start + 16 + 3 * seg_x2
    range_offsets = struct.unpack_from(f">{segments}H", data, range_offsets_at)
    for segment in range(segments):
        for code in range(starts[segment], ends[segment] + 1):
            if code == 0xFFFF:
                continue
            if range_offsets[segment] == 0:
                glyph = (code + deltas[segment]) & 0xFFFF
            else:
                at = (
                    range_offsets_at
                    + 2 * segment
                    + range_offsets[segment]
                    + 2 * (code - starts[segment])
                )
                (glyph,) = struct.unpack_from(">H", data, at)
                if glyph != 0:
                    glyph = (glyph + deltas[segment]) & 0xFFFF
            if glyph != 0:
                yield code


def _format12(data: bytes, start: int) -> Iterable[int]:
    """Segmented-coverage subtable (full Unicode): groups of consecutive code points."""
    (groups,) = struct.unpack_from(">I", data, start + 12)
    for group in range(groups):
        first, last, first_glyph = struct.unpack_from(">III", data, start + 16 + 12 * group)
        for code in range(first, last + 1):
            if first_glyph + (code - first) != 0:
                yield code


def scripts_covered(codepoints: frozenset[int]) -> tuple[str, ...]:
    """The scripts whose whole core alphabet ``codepoints`` maps, in :data:`SCRIPT_ORDER`."""
    return tuple(script for script in SCRIPT_ORDER if SCRIPT_CORES[script] <= codepoints)


def family_scripts(paths: Sequence[Path]) -> tuple[str, ...]:
    """The scripts EVERY file of a family covers — what it can draw at any weight or style.

    :param paths: The family's regular file, then any bold/italic files.
    """
    if not paths:
        raise ValueError("A caption font family needs at least one file to measure.")
    shared = cmap_codepoints(paths[0].read_bytes())
    for path in paths[1:]:
        shared = shared & cmap_codepoints(path.read_bytes())
    return scripts_covered(shared)


def manifest_scripts(fonts_dir: Path = FONTS_DIR) -> dict[str, list[str]]:
    """Measure every family the bundled font manifest lists, keyed by family name."""
    manifest = json.loads((fonts_dir / "manifest.json").read_text(encoding="utf-8"))
    families: Mapping[str, Mapping[str, object]] = manifest["families"]
    measured: dict[str, list[str]] = {}
    for family, entry in families.items():
        files = [entry["file"], *(entry[key] for key in ("boldFile", "italicFile") if key in entry)]
        measured[family] = list(family_scripts([fonts_dir / str(file) for file in files]))
    return measured


def main() -> int:
    """Print every bundled family's measured scripts as JSON (the catalog's ``scripts``)."""
    sys.stdout.write(json.dumps(manifest_scripts(), ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
