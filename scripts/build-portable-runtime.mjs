import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Zip, ZipDeflate } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetTriple =
    process.env["TAURI_ENV_TARGET_TRIPLE"]?.trim() ||
    execFileSync("rustc", ["--print", "host-tuple"], {
        cwd: root,
        encoding: "utf8",
    }).trim();
if (!targetTriple) throw new Error("Could not determine the Rust target triple.");

const windowsTarget = targetTriple.includes("windows");
const extension = windowsTarget ? ".exe" : "";
const consoleDirectory = resolve(root, "src-tauri", "binaries", "console-runtime");
const sidecarDirectory = resolve(root, "src-tauri", "binaries");
const archivePath = resolve(sidecarDirectory, `tutorux-runtime-${targetTriple}.zip`);
const temporaryPath = `${archivePath}.partial`;

for (const required of [`node${extension}`, "tutorux-cli.mjs"]) {
    const details = await stat(resolve(consoleDirectory, required)).catch(() => null);
    if (!details?.isFile() || details.size === 0) {
        throw new Error(
            `The console runtime is missing ${required}. Run pnpm run build:console-runtime first.`,
        );
    }
}

const entries = await collectFiles(consoleDirectory, "console-runtime");
for (const helper of ["tutorux-audio-helper", "tutorux-embedded-ai"]) {
    const source = resolve(sidecarDirectory, `${helper}-${targetTriple}${extension}`);
    const details = await stat(source).catch(() => null);
    if (!details?.isFile() || details.size === 0) {
        throw new Error(
            `The ${helper} sidecar is missing. Run pnpm run build:${helper === "tutorux-audio-helper" ? "audio-helper" : "embedded-ai"} first.`,
        );
    }
    entries.push({
        name: `${helper}${extension}`,
        source,
    });
}
entries.sort((left, right) => left.name.localeCompare(right.name));

await mkdir(sidecarDirectory, { recursive: true });
await rm(temporaryPath, { force: true });
try {
    await writeArchive(entries, temporaryPath);
    await rename(temporaryPath, archivePath);
} catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
}

const archive = await stat(archivePath);
process.stdout.write(
    `Prepared the portable Tutorux runtime for ${targetTriple} (${entries.length} files, ${formatBytes(archive.size)}).\n`,
);

async function collectFiles(directory, prefix) {
    const files = [];
    const pending = [{ path: directory, name: prefix }];
    while (pending.length > 0) {
        const current = pending.pop();
        const children = await readdir(current.path, { withFileTypes: true });
        for (const child of children) {
            const childPath = join(current.path, child.name);
            const childName = `${current.name}/${child.name}`;
            const details = await lstat(childPath);
            if (details.isSymbolicLink()) {
                throw new Error(
                    `The portable Tutorux runtime contains a symbolic link: ${childPath}`,
                );
            }
            if (details.isDirectory()) {
                pending.push({ path: childPath, name: childName });
            } else if (details.isFile()) {
                files.push({
                    name: childName,
                    source: childPath,
                });
            }
        }
    }
    return files;
}

async function writeArchive(files, destination) {
    const output = createWriteStream(destination);
    const finished = new Promise((resolveFinished, rejectFinished) => {
        output.on("finish", resolveFinished);
        output.on("error", rejectFinished);
    });
    const zip = new Zip((error, chunk, final) => {
        if (error) {
            output.destroy(error);
            return;
        }
        if (output.destroyed) return;
        if (chunk?.length) output.write(chunk);
        if (final) output.end();
    });
    for (const file of files) {
        const contents = await readFile(file.source);
        const entry = new ZipDeflate(file.name, {
            level: 6,
        });
        entry.mtime = new Date(2000, 0, 1, 0, 0, 0);
        zip.add(entry);
        entry.push(contents, true);
    }
    zip.end();
    await finished;
}

function formatBytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
