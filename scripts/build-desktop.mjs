import { spawnSync } from "node:child_process";

const tauriArgs = ["exec", "tauri", "build"];
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

run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", tauriArgs);
run(process.execPath, ["scripts/collect-release.mjs"]);
