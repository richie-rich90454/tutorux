import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = resolve(root, "src-tauri", "target", "release", "bundle");
const releaseDirectory = resolve(root, "release");

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
            artifacts.push(join(familyDirectory, entry.name));
        }
    }
}

if (artifacts.length === 0) {
    console.error(`No installers found in ${bundleDirectory}.`);
    process.exit(1);
}

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

for (const artifact of artifacts) {
    const destination = join(releaseDirectory, basename(artifact));
    await cp(artifact, destination, { recursive: true });
    console.log(relative(root, destination));
}
