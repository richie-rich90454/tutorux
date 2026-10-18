#!/usr/bin/env python3
"""Write a compact build artifact report for static release qualification."""

from __future__ import annotations

import argparse
import hashlib
import platform
from pathlib import Path


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--preset", required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    binary = args.binary.resolve()
    artifact = args.artifact.resolve()
    inventory = args.inventory.resolve()
    if not binary.is_file():
        parser.error(f"binary does not exist: {binary}")
    if not artifact.exists():
        parser.error(f"artifact does not exist: {artifact}")
    if not inventory.is_file():
        parser.error(f"package inventory does not exist: {inventory}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = [
        "# Static Release Qualification Build Report",
        "",
        f"- Preset: `{args.preset}`",
        f"- Runner platform: `{platform.platform()}`",
        f"- Runner architecture: `{platform.machine()}`",
        f"- Binary: `{binary}`",
        f"- Binary size: {binary.stat().st_size:,} bytes",
        f"- Binary SHA-256: `{file_sha256(binary)}`",
        f"- Artifact: `{artifact}`",
        f"- Artifact size: {tree_size(artifact):,} bytes",
        "",
        "The package inventory below describes the runner environment. Consult the platform SBOM "
        "and packaged notices for release distribution review.",
        "",
        "## Package inventory",
        "",
        "```text",
        inventory.read_text(encoding="utf-8", errors="replace").rstrip(),
        "```",
        "",
    ]
    args.output.write_text("\n".join(report), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
