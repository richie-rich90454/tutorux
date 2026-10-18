#!/usr/bin/env python3
"""Read-only monitor for CMake FetchContent source pins."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CMAKE_FILE = ROOT / "CMakeLists.txt"
API_ROOT = "https://api.github.com"


@dataclass(frozen=True)
class Pin:
    dependency: str
    declaration: str
    repository: str
    commit_variable: str
    version_variable: str | None = None
    tag_prefix: str = ""
    github_repository: str | None = None


PINS = (
    Pin("PoDoFo", "PoDoFo", "https://github.com/podofo/podofo.git",
        "TUTORUX_PODOFO_COMMIT_PIN", "TUTORUX_PODOFO_VERSION_PIN", "" , "podofo/podofo"),
    Pin("Slint", "Slint", "https://github.com/slint-ui/slint.git",
        "TUTORUX_SLINT_COMMIT_PIN", "TUTORUX_SLINT_VERSION_PIN", "v", "slint-ui/slint"),
    Pin("Corrosion", "Corrosion", "https://github.com/corrosion-rs/corrosion.git",
        "TUTORUX_CORROSION_COMMIT_PIN", "TUTORUX_CORROSION_VERSION_PIN", "v", "corrosion-rs/corrosion"),
    Pin("whisper.cpp", "whisper_cpp", "https://github.com/ggml-org/whisper.cpp.git",
        "TUTORUX_WHISPER_COMMIT_PIN", "TUTORUX_WHISPER_VERSION_PIN", "v", "ggml-org/whisper.cpp"),
    Pin("FFmpeg", "tutorux_ffmpeg", "https://github.com/FFmpeg/FFmpeg.git",
        "TUTORUX_FFMPEG_COMMIT_PIN", "TUTORUX_FFMPEG_VERSION_PIN", "n", "FFmpeg/FFmpeg"),
    Pin("llama.cpp", "llama_cpp", "https://github.com/ggml-org/llama.cpp.git",
        "TUTORUX_LLAMA_COMMIT_PIN", "TUTORUX_LLAMA_VERSION_PIN", "v", "ggml-org/llama.cpp"),
    Pin("zlib", "tutorux_zlib", "https://github.com/madler/zlib.git",
        "TUTORUX_ZLIB_COMMIT_PIN", github_repository="madler/zlib"),
    Pin("libpng", "tutorux_libpng", "https://github.com/pnggroup/libpng.git",
        "TUTORUX_LIBPNG_COMMIT_PIN", github_repository="pnggroup/libpng"),
    Pin("giflib", "tutorux_giflib", "https://git.code.sf.net/p/giflib/code",
        "TUTORUX_GIFLIB_COMMIT_PIN"),
    Pin("libwebp", "tutorux_libwebp", "https://github.com/webmproject/libwebp.git",
        "TUTORUX_LIBWEBP_COMMIT_PIN", github_repository="webmproject/libwebp"),
)


def parse_cmake(text: str) -> tuple[dict[str, str], dict[str, str]]:
    variables = {
        name: value
        for name, value in re.findall(
            r'^\s*set\(\s*(TUTORUX_[A-Z0-9_]+)\s+"?([^"\s\)]+)"?\s*\)',
            text,
            re.MULTILINE,
        )
    }
    declarations: dict[str, str] = {}
    pattern = re.compile(r"FetchContent_Declare\s*\(\s*([^\s()]+)(.*?)\)", re.DOTALL)
    for match in pattern.finditer(text):
        declaration_name, body = match.groups()
        repository = re.search(r"\bGIT_REPOSITORY\s+([^\s()]+)", body)
        tag = re.search(r"\bGIT_TAG\s+([^\s()]+)", body)
        if repository and tag:
            declarations[declaration_name] = f"{repository.group(1)}\t{tag.group(1)}"
    return variables, declarations


def expand_tag(expression: str, variables: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        variable = match.group(1)
        if variable not in variables:
            raise ValueError(f"CMake tag references unset variable {variable}")
        return variables[variable]

    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", replace, expression)


def github_json(path: str) -> dict:
    request = urllib.request.Request(
        f"{API_ROOT}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "tutorux-fetchcontent-pin-monitor",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def version_tuple(value: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", value)
    if not match:
        return None
    return tuple(int(part or "0") for part in match.groups())


def github_slug(repository: str) -> str:
    match = re.fullmatch(r"https://github\.com/([^/]+/[^/]+?)(?:\.git)?/?", repository)
    if not match:
        raise ValueError(f"Unsupported GitHub repository URL: {repository}")
    return match.group(1)


def main() -> int:
    text = CMAKE_FILE.read_text(encoding="utf-8")
    variables, declarations = parse_cmake(text)
    lines = [
        "# FetchContent dependency monitor",
        "",
        "This read-only check validates pinned source references and reports newer upstream releases.",
        "It does not edit dependency pins or create pull requests.",
        "",
    ]
    failures: list[str] = []
    warnings: list[str] = []

    for pin in PINS:
        declaration = declarations.get(pin.declaration)
        if declaration is None:
            failures.append(f"{pin.dependency}: CMake FetchContent declaration was not found")
            continue
        repository, tag_expression = declaration.split("\t", 1)
        normalized_repository = repository.removesuffix(".git").rstrip("/")
        expected_repository = pin.repository.removesuffix(".git").rstrip("/")
        if normalized_repository.lower() != expected_repository.lower():
            failures.append(
                f"{pin.dependency}: monitored repository {pin.repository} does not match CMake URL {repository}"
            )
            continue
        expected_commit = variables.get(pin.commit_variable)
        if not expected_commit:
            failures.append(f"{pin.dependency}: missing CMake variable {pin.commit_variable}")
            continue

        if pin.version_variable:
            expected_version = variables.get(pin.version_variable)
            if not expected_version:
                failures.append(f"{pin.dependency}: missing CMake variable {pin.version_variable}")
                continue
            expected_tag = f"{pin.tag_prefix}${{{pin.version_variable}}}"
            if tag_expression != expected_tag:
                failures.append(
                    f"{pin.dependency}: expected CMake tag expression {expected_tag}, found {tag_expression}"
                )
                continue
            tag = expand_tag(tag_expression, variables)
        else:
            expected_tag = f"${{{pin.commit_variable}}}"
            if tag_expression != expected_tag:
                failures.append(
                    f"{pin.dependency}: expected CMake commit expression {expected_tag}, found {tag_expression}"
                )
                continue
            tag = ""

        if not pin.github_repository:
            lines.append(
                f"- {pin.dependency}: pinned commit `{expected_commit}` is configured; remote SourceForge "
                "reachability is not checked by this monitor. CMake verifies the commit during configure."
            )
            continue

        slug = pin.github_repository
        try:
            ref = tag if pin.version_variable else expected_commit
            encoded_ref = urllib.parse.quote(ref, safe="")
            commit_data = github_json(f"/repos/{slug}/commits/{encoded_ref}")
            observed_commit = str(commit_data.get("sha", ""))
            if not observed_commit.lower().startswith(expected_commit.lower()):
                failures.append(
                    f"{pin.dependency}: upstream ref `{ref}` now resolves to `{observed_commit}`, "
                    f"expected commit prefix `{expected_commit}`"
                )
                continue
            if pin.version_variable:
                current_version = variables[pin.version_variable]
                status = f"pinned tag `{tag}` still resolves to `{observed_commit}`"
                try:
                    latest = github_json(f"/repos/{slug}/releases/latest").get("tag_name", "")
                except urllib.error.HTTPError as error:
                    latest = ""
                    if error.code != 404:
                        warnings.append(f"{pin.dependency}: latest-release lookup returned HTTP {error.code}")
                latest_value = latest.lstrip("v")
                pinned_tuple = version_tuple(current_version)
                latest_tuple = version_tuple(latest_value)
                if latest_tuple and pinned_tuple and latest_tuple > pinned_tuple:
                    status += f"; newer upstream release `{latest}` is available for manual review"
                    warnings.append(f"{pin.dependency}: newer release {latest} is available")
                elif latest and latest_tuple is None:
                    status += f"; latest tag `{latest}` needs manual version review"
                    warnings.append(f"{pin.dependency}: could not compare latest release tag {latest}")
                lines.append(f"- {pin.dependency} {current_version}: {status}")
            else:
                lines.append(f"- {pin.dependency}: pinned commit `{expected_commit}` exists upstream")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, KeyError) as error:
            failures.append(f"{pin.dependency}: upstream pin check failed: {error}")

    if warnings:
        lines.extend(["", "## Manual review items", ""])
        lines.extend(f"- {warning}" for warning in warnings)
    if failures:
        lines.extend(["", "## Pin check failures", ""])
        lines.extend(f"- {failure}" for failure in failures)

    summary = "\n".join(lines) + "\n"
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8", newline="\n") as output:
            output.write(summary)
    else:
        print(summary)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
