import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperDirectory = resolve(root, "src-tauri");
const cargoManifest = resolve(helperDirectory, "Cargo.toml");
const cargoTargetDirectory = resolve(helperDirectory, "target");
const targetTriple =
    process.env["TAURI_ENV_TARGET_TRIPLE"]?.trim() ||
    execFileSync("rustc", ["--print", "host-tuple"], {
        cwd: root,
        encoding: "utf8",
    }).trim();
if (!targetTriple) throw new Error("Could not determine the Rust target triple.");

const debug = process.env["TAURI_ENV_DEBUG"] === "true";
const profile = debug ? "debug" : "release";
const windowsTarget = targetTriple.includes("windows");
const extension = windowsTarget ? ".exe" : "";
const helperName = "tutorux-audio-helper";
const buildArguments = [
    "build",
    "--manifest-path",
    cargoManifest,
    "--bin",
    helperName,
    "--target",
    targetTriple,
    ...(debug ? [] : ["--release"]),
];
const build = spawnSync("cargo", buildArguments, {
    cwd: root,
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDirectory },
    stdio: "inherit",
    windowsHide: true,
});
if (build.error) throw build.error;
if (build.status !== 0) {
    throw new Error("Building the native application-audio helper failed.");
}

const targetDirectory = resolve(cargoTargetDirectory, targetTriple, profile);
const builtHelper = resolve(targetDirectory, helperName + extension);
const sidecarDirectory = resolve(root, "src-tauri", "binaries");
const sidecarPath = resolve(sidecarDirectory, helperName + "-" + targetTriple + extension);
await mkdir(sidecarDirectory, { recursive: true });
await copyFile(builtHelper, sidecarPath);
if (!windowsTarget) await chmod(sidecarPath, 0o755);
process.stdout.write("Prepared standalone native audio helper for " + targetTriple + ".\n");
