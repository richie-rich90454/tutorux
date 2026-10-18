#!/bin/sh
# Deletes the build tree (and optionally dist/) of this repository and reports the freed space.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -f "$root/CMakeLists.txt" ]; then
    echo "clean.sh must be located in the repository root (next to CMakeLists.txt)." >&2
    exit 1
fi

include_dist=0
dry_run=0
for arg in "$@"; do
    case "$arg" in
        --dist|-Dist) include_dist=1 ;;
        --dry-run|-DryRun) dry_run=1 ;;
        -h|--help)
            echo "usage: ./clean.sh [--dist] [--dry-run]"
            exit 0
            ;;
        *)
            echo "clean.sh: unknown option: $arg" >&2
            exit 2
            ;;
    esac
done

freed_kb=0

to_mb() {
    awk -v kb="$1" 'BEGIN { printf "%.1f", kb / 1024 }'
}

clean_one() {
    target=$1
    case "$target" in
        "$root"/*) ;;
        *)
            echo "refusing to delete $target" >&2
            exit 1
            ;;
    esac
    if [ ! -e "$target" ]; then
        echo "skip    $target (not present)"
        return 0
    fi
    kb=$(du -sk "$target" 2>/dev/null | awk 'NR == 1 { print $1 }')
    [ -n "$kb" ] || kb=0
    if [ "$dry_run" -eq 1 ]; then
        printf 'would delete %s (%s MB)\n' "$target" "$(to_mb "$kb")"
        return 0
    fi
    rm -rf -- "$target"
    freed_kb=$((freed_kb + kb))
    printf 'deleted %s (%s MB freed)\n' "$target" "$(to_mb "$kb")"
}

clean_one "$root/build"
if [ "$include_dist" -eq 1 ]; then
    clean_one "$root/dist"
fi

if [ "$dry_run" -eq 1 ]; then
    echo "dry run: nothing deleted."
elif [ "$freed_kb" -gt 0 ]; then
    echo "total freed: $(to_mb "$freed_kb") MB"
else
    echo "nothing to delete."
fi
