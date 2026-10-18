#!/usr/bin/env python3
"""Convert unicode-segmentation's generated Unicode tables into Tutorux C++ data."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

CHARACTER = r"'\\u\{([0-9A-Fa-f]+)\}'"


def array_body(source: str, declaration: str) -> str:
    declaration_offset = source.index(declaration)
    start = source.index("&[", declaration_offset) + 2
    end = source.index("];", start)
    return source[start:end]


def parse_ranges(body: str, include_category: bool) -> list[tuple[int, int, str | None]]:
    category = r"\s*,\s*(GC_[A-Za-z_]+)" if include_category else ""
    pattern = re.compile(rf"\(\s*{CHARACTER}\s*,\s*{CHARACTER}{category}\s*\)")
    matches = pattern.findall(body)
    ranges = []
    for match in matches:
        start, end = match[:2]
        value = match[2] if include_category else None
        ranges.append((int(start, 16), int(end, 16), value))
    if not ranges:
        raise ValueError("The source table did not contain any Unicode ranges.")
    return ranges


def parse_linkers(source: str) -> list[int]:
    function = re.search(r"pub fn is_incb_linker\(c: char\).*?matches!\(c,(.*?)\)\s*\}", source, re.S)
    if function is None:
        raise ValueError("The source table did not contain the Indic linker set.")
    values = [int(value, 16) for value in re.findall(CHARACTER, function.group(1))]
    if not values:
        raise ValueError("The Indic linker set was empty.")
    return sorted(values)


def format_ranges(
    values: list[tuple[int, int, str | None]], category_names: dict[str, str] | None = None
) -> str:
    entries = []
    for start, end, category in values:
        fields = [f"0x{start:X}U", f"0x{end:X}U"]
        if category is not None:
            assert category_names is not None
            fields.append(f"GraphemeCategory::{category_names[category]}")
        entries.append("    {" + ", ".join(fields) + "},")
    return "\n".join(entries)


def format_values(values: list[int]) -> str:
    return "\n".join(
        "    " + ", ".join(f"0x{value:X}U" for value in values[start : start + 8]) + ","
        for start in range(0, len(values), 8)
    )


def generate(source_path: Path, output_path: Path) -> None:
    source = source_path.read_text(encoding="utf-8")
    version_match = re.search(r"UNICODE_VERSION: \(u64, u64, u64\) = \((\d+), (\d+), (\d+)\)", source)
    if version_match is None:
        raise ValueError("The source table did not declare a Unicode version.")
    version = ".".join(version_match.groups())

    grapheme_ranges = parse_ranges(array_body(source, "const grapheme_cat_table"), True)
    indic_ranges = parse_ranges(array_body(source, "const InCB_Extend_table"), False)
    linkers = parse_linkers(source)
    category_names = {
        "GC_CR": "cr",
        "GC_Control": "control",
        "GC_Extend": "extend",
        "GC_Extended_Pictographic": "extendedPictographic",
        "GC_InCB_Consonant": "indicConsonant",
        "GC_L": "hangulL",
        "GC_LF": "lf",
        "GC_LV": "hangulLv",
        "GC_LVT": "hangulLvt",
        "GC_Prepend": "prepend",
        "GC_Regional_Indicator": "regionalIndicator",
        "GC_SpacingMark": "spacingMark",
        "GC_T": "hangulT",
        "GC_V": "hangulV",
        "GC_ZWJ": "zeroWidthJoiner",
    }
    missing_categories = {category for _, _, category in grapheme_ranges} - category_names.keys()
    if missing_categories:
        raise ValueError(f"Unknown grapheme categories: {sorted(missing_categories)}")

    output = f'''// Copyright 2012-2018 The Rust Project Developers.
// Generated from unicode-segmentation 1.13.3 (Unicode {version}).
// The data and its upstream attribution are covered by third_party/unicode-segmentation/LICENSE-MIT
// and third_party/unicode-segmentation/LICENSE-APACHE.
#pragma once

#include <array>
#include <cstdint>

namespace tutorux::document::unicode {{

inline constexpr char version[] = "{version}";

enum class GraphemeCategory : std::uint8_t {{
    any,
    cr,
    control,
    extend,
    extendedPictographic,
    indicConsonant,
    hangulL,
    lf,
    hangulLv,
    hangulLvt,
    prepend,
    regionalIndicator,
    spacingMark,
    hangulT,
    hangulV,
    zeroWidthJoiner,
}};

struct GraphemeRange final {{
    char32_t first;
    char32_t last;
    GraphemeCategory category;
}};

struct ScalarRange final {{
    char32_t first;
    char32_t last;
}};

inline constexpr std::array<GraphemeRange, {len(grapheme_ranges)}> graphemeRanges{{{{
{format_ranges(grapheme_ranges, category_names)}
}}}};

inline constexpr std::array<ScalarRange, {len(indic_ranges)}> indicExtendRanges{{{{
{format_ranges(indic_ranges)}
}}}};

inline constexpr std::array<char32_t, {len(linkers)}> indicLinkers{{{{
{format_values(linkers)}
}}}};

}} // namespace tutorux::document::unicode
'''
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(output, encoding="utf-8", newline="\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Path to unicode-segmentation's src/tables.rs")
    parser.add_argument("output", type=Path, help="Output C++ header path")
    arguments = parser.parse_args()
    generate(arguments.source, arguments.output)


if __name__ == "__main__":
    main()
