# TypeScript performance baseline

The old executable size/startup budgets measured a different product and toolchain. They remain historical C++ release data and are not performance claims for the TypeScript application.

## Current reproducible workloads

Run:

```sh
npm run benchmark:archive
npm run build
```

The archive benchmark builds an in-memory v1 archive with 10,000 student records in one append-only generation, then lists and decodes those records. It prints the Node/V8 version, elapsed times, final archive bytes, and resident memory delta. It is a smoke baseline, not a claim of parity with the C++ implementation.

The Vite production build reports uncompressed and gzip JavaScript/CSS sizes. Those are build artifact measurements, not runtime startup or RSS. Browser and desktop startup measurements are not yet established.

## Baseline evidence

The first recorded build in this migration emitted roughly 103 kB of web JavaScript before gzip. The exact size changes with the current source and dependency lockfile; rerun `npm run build` for the current number.

One Windows run on 2026-10-26 with Node v24.13.0 / V8 13.6.233.17-node.37 produced:

| Workload                                        |            Result |
| ----------------------------------------------- | ----------------: |
| 10,000 student record archive size              |   4,941,968 bytes |
| Create and open empty archive                   |           6.44 ms |
| Append one generation containing 10,000 records |         556.72 ms |
| Decode and list 10,000 records                  |         130.08 ms |
| Process RSS delta during the run                | 133,070,848 bytes |

This is one in-memory run on the development machine, without warmup or repeated samples. The RSS delta includes Node/V8 runtime and allocations that have not been isolated; use it as a baseline, not as a stable memory budget.

One compression-enabled run on 2026-10-27 used Windows x64 (NT 10.0.26200.0), an Intel Core Ultra 7 255H, Node v24.13.0, and V8 13.6.233.17-node.37:

| Workload                                        |            Result |
| ----------------------------------------------- | ----------------: |
| 10,000 student record archive size              |   4,621,968 bytes |
| Create and open empty archive                   |          14.40 ms |
| Append one generation containing 10,000 records |       1,291.52 ms |
| Decode and list 10,000 records                  |         293.02 ms |
| Process RSS delta during the run                | 130,564,096 bytes |

This single non-warmed sample produced an archive 320,000 bytes smaller than the prior run, while append time was about 2.3 times longer. Treat both measurements as directional until repeated runs use a warmed and otherwise identical workload.

## Limits and next gates

- Benchmarking is currently on Windows only.
- There is no comparable C++ versus TypeScript workload suite yet.
- Encryption, media, guide export, and large asset workloads are not ported, so they cannot be measured.
- Browser fallback export materializes a Blob and is capped at 512 MiB.
- Desktop/CLI archive reads and writes use bounded chunks; memory budgets still need measurements on Windows, macOS, and Linux.
