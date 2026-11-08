import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const tauriCli = join(dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");

// Tauri treats a present-but-empty signing variable as configured. Remove the
// Apple signing environment when no certificate is supplied so unsigned builds
// still work.
if (process.platform === "darwin" && !process.env["APPLE_CERTIFICATE"]) {
    for (const key of [
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_SIGNING_IDENTITY",
        "APPLE_ID",
        "APPLE_PASSWORD",
        "APPLE_TEAM_ID",
    ]) {
        delete process.env[key];
    }
}

const tauriArgs = [tauriCli, "build"];
const thumbprint = process.env["WINDOWS_CERTIFICATE_THUMBPRINT"];
if (process.platform === "win32" && thumbprint) {
    tauriArgs.push(
        "--config",
        JSON.stringify({
            bundle: {
                windows: {
                    certificateThumbprint: thumbprint,
                    digestAlgorithm: "sha256",
                    timestampUrl:
                        process.env["WINDOWS_TIMESTAMP_URL"] ?? "http://timestamp.digicert.com",
                },
            },
        }),
    );
}

function run(command, args) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, tauriArgs);
run(process.execPath, ["scripts/collect-release.mjs"]);
