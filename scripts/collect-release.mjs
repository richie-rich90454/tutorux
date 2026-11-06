import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = resolve(root, "src-tauri", "target", "release", "bundle");
const targetDirectory = resolve(root, "src-tauri", "target", "release");
const releaseDirectory = resolve(root, "release");
const packageJsonPath = join(root, "package.json");
const tauriConfigPath = join(root, "src-tauri", "tauri.conf.json");
const cargoManifestPath = join(root, "src-tauri", "Cargo.toml");

const argumentsList = process.argv.slice(2);
if (argumentsList.includes("--help")) {
    process.stdout.write(
        [
            "Usage: node scripts/collect-release.mjs [--check-versions]",
            "",
            "Copies built desktop bundles into release/ using the version from",
            "src-tauri/tauri.conf.json (falling back to package.json).",
            "--check-versions verifies that package.json, src-tauri/Cargo.toml,",
            "and src-tauri/tauri.conf.json declare the same version.",
            "",
        ].join("\n"),
    );
    process.exit(0);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
let tauriConfig;
try {
    tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}

const cargoManifest = await readFile(cargoManifestPath, "utf8");
const cargoPackage = cargoManifest.split(/^\[/mu).find((section) => section.startsWith("package]"));
const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];

if (argumentsList.includes("--check-versions")) {
    const versions = {
        "package.json": packageJson.version,
        "src-tauri/Cargo.toml": cargoVersion,
        "src-tauri/tauri.conf.json": tauriConfig?.version,
    };
    const declared = new Set(Object.values(versions));
    if (Object.values(versions).some((version) => !version) || declared.size !== 1) {
        console.error(`Version mismatch: ${JSON.stringify(versions, null, 2)}`);
        process.exit(1);
    }
    console.log(`All manifests declare version ${packageJson.version}.`);
    process.exit(0);
}

const appVersion = tauriConfig?.version || packageJson.version;
if (!appVersion) {
    console.error("No application version found in src-tauri/tauri.conf.json or package.json.");
    process.exit(1);
}

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
