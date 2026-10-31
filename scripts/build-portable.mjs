import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const source = resolve(
    root,
    "src-tauri",
    "target",
    "release",
    windows ? "tutorux-desktop.exe" : "tutorux-desktop",
);
const output = resolve(root, "release", windows ? "Tutorux.exe" : "Tutorux");

const details = await stat(source).catch(() => null);
if (!details?.isFile() || details.size === 0) {
    throw new Error(`The desktop executable is missing: ${source}. Build it before copying.`);
}
await mkdir(dirname(output), { recursive: true });
await copyFile(source, output);
const portable = await stat(output);
process.stdout.write(
    `Portable Tutorux executable: ${output} (${(portable.size / (1024 * 1024)).toFixed(1)} MiB)\n`,
);
