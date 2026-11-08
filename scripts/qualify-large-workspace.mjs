import { spawnSync } from "node:child_process";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";

const gigabytes = Number(process.argv[2] ?? process.env["TUTORUX_QUALIFY_GB"] ?? 100);
if (!Number.isInteger(gigabytes) || gigabytes < 1) {
    console.error("Usage: node scripts/qualify-large-workspace.mjs [gigabytes]");
    process.exit(2);
}

const stats = await statfs(tmpdir());
const freeBytes = Number(stats.bsize) * Number(stats.bavail);
const requiredBytes = gigabytes * 1024 * 1024 * 1024 * 1.2;
if (freeBytes < requiredBytes) {
    console.error(
        `Not enough free space in ${tmpdir()}: need about ${(requiredBytes / 1024 ** 3).toFixed(1)} GiB.`,
    );
    process.exit(1);
}

console.log(
    `Free space: ${(freeBytes / 1024 ** 3).toFixed(1)} GiB. Running a ${gigabytes} GiB qualification...`,
);
const started = Date.now();
const result = spawnSync(
    "cargo",
    [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--lib",
        "store::tests::qualifies_a_large_workspace",
        "--",
        "--ignored",
        "--nocapture",
    ],
    {
        stdio: "inherit",
        env: { ...process.env, TUTORUX_QUALIFY_GB: String(gigabytes) },
    },
);
const minutes = ((Date.now() - started) / 60_000).toFixed(1);
if (result.status !== 0) {
    console.error(`Qualification failed after ${minutes} minutes.`);
    process.exit(result.status ?? 1);
}
console.log(`Qualification passed in ${minutes} minutes.`);
