import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = resolve(root, "src-tauri", "target", "release", "bundle");
const targetDirectory = resolve(root, "src-tauri", "target", "release");
const releaseDirectory = resolve(root, "release");
const appVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;

if (!existsSync(bundleDirectory)) {
    console.error("No desktop bundle found. Run `pnpm run desktop:build` first.");
    process.exit(1);
}

const artifacts = [];
for (const family of await readdir(bundleDirectory, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    const familyDirectory = join(bundleDirectory, family.name);
    for (const entry of await readdir(familyDirectory, { withFileTypes: true })) {
        if (entry.isFile() || entry.name.endsWith(".app")) {
            artifacts.push({ source: join(familyDirectory, entry.name), name: entry.name });
        }
    }
}

// The desktop executable contains the Tauri frontend assets and runs directly. Collect it
// alongside the installers so Windows users can use a one-file portable build.
if (process.platform === "win32") {
    const portableExecutable = join(targetDirectory, "tutorux-desktop.exe");
    if (!existsSync(portableExecutable)) {
        console.error(`No portable desktop executable found at ${portableExecutable}.`);
        process.exit(1);
    }
    artifacts.push({
        source: portableExecutable,
        name: `Tutorux_${appVersion}_x64_portable.exe`,
    });
}

if (artifacts.length === 0) {
    console.error(`No installers found in ${bundleDirectory}.`);
    process.exit(1);
}

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

for (const artifact of artifacts) {
    const destination = join(releaseDirectory, artifact.name || basename(artifact.source));
    await cp(artifact.source, destination, { recursive: true });
    console.log(relative(root, destination));
}
