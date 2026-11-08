import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const version = process.env["PDFIUM_VERSION"] ?? "8125";
const release = encodeURIComponent(`chromium/${version}`);
const platform = process.platform;
const arch = process.arch;

const asset =
    platform === "win32"
        ? arch === "x64"
            ? "pdfium-win-x64.tgz"
            : null
        : platform === "darwin"
          ? arch === "arm64"
              ? "pdfium-mac-arm64.tgz"
              : "pdfium-mac-x64.tgz"
          : platform === "linux"
            ? arch === "arm64"
                ? "pdfium-linux-arm64.tgz"
                : "pdfium-linux-x64.tgz"
            : null;

if (!asset) {
    console.error(`No PDFium build is available for ${platform}/${arch}.`);
    process.exit(1);
}

const libraryName =
    platform === "win32"
        ? "pdfium.dll"
        : platform === "darwin"
          ? "libpdfium.dylib"
          : "libpdfium.so";
const targetDirectory = join(process.cwd(), "src-tauri", "resources", "pdfium");
const target = join(targetDirectory, libraryName);

if (
    await stat(target)
        .then(() => true)
        .catch(() => false)
) {
    console.log(`PDFium already present at ${target}`);
    process.exit(0);
}

const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${release}/${asset}`;
const work = await mkdtemp(join(tmpdir(), "tutorux-pdfium-"));
const archive = join(work, asset);

console.log(`Downloading ${url}`);
const response = await fetch(url, { redirect: "follow" });
if (!response.ok || !response.body) {
    console.error(`PDFium download failed: ${response.status} ${response.statusText}`);
    process.exit(1);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));

const extraction = join(work, "extract");
await mkdir(extraction, { recursive: true });
const untar = spawnSync("tar", ["-xzf", archive, "-C", extraction], { stdio: "inherit" });
if (untar.status !== 0) {
    console.error("The PDFium archive could not be extracted. Ensure `tar` is available.");
    process.exit(untar.status ?? 1);
}

async function findFile(directory, name) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isFile() && entry.name === name) return path;
        if (entry.isDirectory()) {
            const found = await findFile(path, name);
            if (found) return found;
        }
    }
    return null;
}

const library = await findFile(extraction, libraryName);
if (!library) {
    console.error(`The archive did not contain ${libraryName}.`);
    process.exit(1);
}
await mkdir(targetDirectory, { recursive: true });
await copyFile(library, target);

const license = await findFile(extraction, "LICENSE");
if (license) await copyFile(license, join(targetDirectory, "LICENSE"));

await rm(work, { recursive: true, force: true });
console.log(`PDFium installed at ${target}`);
