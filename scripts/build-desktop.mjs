import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const tauriCli = join(dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");
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
