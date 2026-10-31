import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { arch as hostArchitecture, platform as hostPlatform, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
    chmod,
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "v24.21.0";
const maximumNodeArchiveBytes = 200 * 1024 * 1024;
const maximumRuntimeClosureBytes = 2 * 1024 * 1024 * 1024;
const maximumRuntimePackageCount = 256;
const targetDefinitions = [
    {
        key: "win-x64",
        platform: "win32",
        architecture: "x64",
        triples: ["x86_64-pc-windows-msvc", "x86_64-pc-windows-gnullvm"],
        nodeArchive: `node-${version}-win-x64.zip`,
        nodeExecutable: "node.exe",
        llamaPackage: "@node-llama-cpp/win-x64",
        sharpPackages: ["@img/sharp-win32-x64"],
    },
    {
        key: "win-arm64",
        platform: "win32",
        architecture: "arm64",
        triples: ["aarch64-pc-windows-msvc", "aarch64-pc-windows-gnullvm"],
        nodeArchive: `node-${version}-win-arm64.zip`,
        nodeExecutable: "node.exe",
        llamaPackage: "@node-llama-cpp/win-arm64",
        sharpPackages: ["@img/sharp-win32-arm64"],
    },
    {
        key: "macos-x64",
        platform: "darwin",
        architecture: "x64",
        triples: ["x86_64-apple-darwin"],
        nodeArchive: `node-${version}-darwin-x64.tar.gz`,
        nodeExecutable: "node",
        llamaPackage: "@node-llama-cpp/mac-x64",
        sharpPackages: ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"],
    },
    {
        key: "macos-arm64",
        platform: "darwin",
        architecture: "arm64",
        triples: ["aarch64-apple-darwin"],
        nodeArchive: `node-${version}-darwin-arm64.tar.gz`,
        nodeExecutable: "node",
        llamaPackage: "@node-llama-cpp/mac-arm64-metal",
        sharpPackages: ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"],
    },
    {
        key: "linux-x64",
        platform: "linux",
        architecture: "x64",
        triples: ["x86_64-unknown-linux-gnu"],
        nodeArchive: `node-${version}-linux-x64.tar.gz`,
        nodeExecutable: "node",
        llamaPackage: "@node-llama-cpp/linux-x64",
        sharpPackages: ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"],
    },
    {
        key: "linux-arm64",
        platform: "linux",
        architecture: "arm64",
        triples: ["aarch64-unknown-linux-gnu"],
        nodeArchive: `node-${version}-linux-arm64.tar.gz`,
        nodeExecutable: "node",
        llamaPackage: "@node-llama-cpp/linux-arm64",
        sharpPackages: ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64"],
    },
];

function nativeTargetForHost() {
    const normalizedPlatform = hostPlatform();
    const normalizedArchitecture = hostArchitecture();
    return targetDefinitions.find(
        (target) =>
            target.platform === normalizedPlatform &&
            target.architecture === normalizedArchitecture,
    );
}

const hostTarget = nativeTargetForHost();
if (!hostTarget) {
    throw new Error(
        `Tutorux's bundled command runtime does not support this build host (${hostPlatform()} ${hostArchitecture()}). Supported hosts are Windows, macOS, and glibc Linux on x64 or arm64.`,
    );
}

const targetTriple = process.env["TAURI_ENV_TARGET_TRIPLE"]?.trim() || hostTarget.triples[0];
const target = targetDefinitions.find((candidate) => candidate.triples.includes(targetTriple));
if (!target) {
    throw new Error(
        `Tutorux cannot bundle its command runtime for target ${targetTriple}. Supported target triples: ${targetDefinitions.flatMap((candidate) => candidate.triples).join(", ")}.`,
    );
}
if (target.key !== hostTarget.key) {
    throw new Error(
        `Tutorux's command runtime and native CLI dependencies must match the Tauri build host. Host: ${hostTarget.key}; target: ${target.key}. Build this target on a matching machine.`,
    );
}

const outputDirectory = resolve(root, "src-tauri", "binaries", "console-runtime");
const runtimeCacheDirectory = resolve(root, "src-tauri", "binaries", "console-runtime-cache");
const targetCacheDirectory = resolve(runtimeCacheDirectory, version, target.key);
const allowedOptionalPackages = new Set([target.llamaPackage, ...target.sharpPackages]);

const cachedNode = join(targetCacheDirectory, target.nodeExecutable);
const cachedNodeLicense = join(targetCacheDirectory, "NODE-LICENSE.txt");
if (!(await hasExpectedNodeVersion(cachedNode)) || !(await exists(cachedNodeLicense))) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "tutorux-node-runtime-"));
    const stagedCacheDirectory = join(runtimeCacheDirectory, `${randomUUID()}.staging`);
    try {
        const downloadedNode = await downloadNodeRuntime(target, temporaryDirectory);
        await mkdir(stagedCacheDirectory, { recursive: true });
        await cp(downloadedNode.executable, join(stagedCacheDirectory, target.nodeExecutable));
        await cp(downloadedNode.license, join(stagedCacheDirectory, "NODE-LICENSE.txt"));
        if (target.platform !== "win32") {
            await chmod(join(stagedCacheDirectory, target.nodeExecutable), 0o755);
        }
        await mkdir(dirname(targetCacheDirectory), { recursive: true });
        await removeManagedDirectory(targetCacheDirectory);
        await rename(stagedCacheDirectory, targetCacheDirectory);
    } finally {
        await rm(stagedCacheDirectory, { recursive: true, force: true });
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
}

const consoleEntryGuard =
    /\nif \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\) \{\r?\n\s+process\.exitCode = await executeCli\(process\.argv\.slice\(2\)\);\r?\n\}\s*$/u;
const consoleEntryPlugin = {
    name: "tutorux-command-console-entry",
    transform(source, id) {
        if (resolve(id.split("?")[0]) !== resolve(root, "cli", "main.ts")) return null;
        const code = source.replace(consoleEntryGuard, "\n");
        if (code === source) {
            throw new Error(
                "Could not isolate the standalone CLI entry while preparing the in-app command bundle.",
            );
        }
        return { code, map: null };
    },
};

await mkdir(outputDirectory, { recursive: true });
await build({
    configFile: false,
    root,
    logLevel: "info",
    build: {
        target: "node24",
        outDir: outputDirectory,
        emptyOutDir: true,
        sourcemap: false,
        minify: true,
        lib: {
            entry: resolve(root, "cli", "console-entry.ts"),
            formats: ["es"],
            fileName: () => "tutorux-cli.mjs",
        },
        rolldownOptions: {
            external: [/^node:/u, "node-llama-cpp", "sharp"],
            output: { codeSplitting: false },
            plugins: [consoleEntryPlugin],
        },
    },
});

await cp(cachedNode, join(outputDirectory, target.nodeExecutable));
await cp(join(targetCacheDirectory, "NODE-LICENSE.txt"), join(outputDirectory, "NODE-LICENSE.txt"));
if (target.platform !== "win32") {
    await chmod(join(outputDirectory, target.nodeExecutable), 0o755);
}

const installationDirectory = await installHoistedRuntime();
try {
    const packages = await collectRuntimePackages(installationDirectory, allowedOptionalPackages);
    if (packages.length > maximumRuntimePackageCount) {
        throw new Error(
            `The Tutorux CLI dependency closure contains ${packages.length} packages; the supported maximum is ${maximumRuntimePackageCount}.`,
        );
    }
    let closureBytes = 0;
    for (const entry of packages) {
        closureBytes += await measureDirectoryBytes(entry.source);
        if (closureBytes > maximumRuntimeClosureBytes) {
            throw new Error(
                `The Tutorux CLI dependency closure exceeds the 2 GiB packaging limit (${entry.name}).`,
            );
        }
        const destination = join(outputDirectory, "node_modules", entry.relativePath);
        await mkdir(dirname(destination), { recursive: true });
        await cp(entry.source, destination, { recursive: true, dereference: true });
    }
    const bundledPackageLicenses = await collectBundledPackageLicenses();
    const licenseEntries = [
        ...packages.map((entry) => ({
            name: entry.name,
            version: entry.metadata.version,
            license: entry.metadata.license ?? "See included license files",
            directory: entry.source,
        })),
        ...bundledPackageLicenses,
    ];
    await writeThirdPartyNotices(outputDirectory, licenseEntries);
} finally {
    await rm(installationDirectory, { recursive: true, force: true });
}

process.stdout.write(
    `Prepared the Tutorux command console for ${targetTriple} with Node ${version} and a hoisted dependency tree.\n`,
);

async function hasExpectedNodeVersion(executable) {
    try {
        const details = await stat(executable);
        if (!details.isFile()) return false;
        const result = spawnSync(executable, ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        });
        return result.status === 0 && result.stdout.trim() === version;
    } catch {
        return false;
    }
}

async function downloadNodeRuntime(selectedTarget, temporaryDirectory) {
    const distributionUrl = `https://nodejs.org/dist/${version}`;
    const sums = await fetchBounded(`${distributionUrl}/SHASUMS256.txt`, 1024 * 1024);
    const expectedDigest = sums
        .toString("utf8")
        .split(/\r?\n/u)
        .map((line) => /^([a-f\d]{64})\s+\*?(.+)$/u.exec(line))
        .find((match) => match?.[2] === selectedTarget.nodeArchive)?.[1];
    if (!expectedDigest) {
        throw new Error(
            `Node ${version} did not publish a checksum for ${selectedTarget.nodeArchive}.`,
        );
    }

    const archiveBytes = await fetchBounded(
        `${distributionUrl}/${selectedTarget.nodeArchive}`,
        maximumNodeArchiveBytes,
    );
    const actualDigest = createHash("sha256").update(archiveBytes).digest("hex");
    if (actualDigest !== expectedDigest) {
        throw new Error(
            `The downloaded Node runtime failed its SHA-256 check for ${selectedTarget.key}.`,
        );
    }

    if (selectedTarget.platform === "win32") {
        const files = unzipSync(new Uint8Array(archiveBytes));
        const archivePrefix = `${selectedTarget.nodeArchive.replace(/\.zip$/u, "")}/`;
        const executableEntry = files[`${archivePrefix}node.exe`];
        const licenseEntry = files[`${archivePrefix}LICENSE`];
        if (!executableEntry || !licenseEntry) {
            throw new Error(
                `The verified Node archive is missing its executable or license for ${selectedTarget.key}.`,
            );
        }
        const executable = join(temporaryDirectory, selectedTarget.nodeExecutable);
        const license = join(temporaryDirectory, "NODE-LICENSE.txt");
        await writeFile(executable, executableEntry);
        await writeFile(license, licenseEntry);
        return { executable, license };
    }

    const extractionDirectory = join(temporaryDirectory, "node-files");
    await mkdir(extractionDirectory, { recursive: true });
    const archivePath = join(temporaryDirectory, selectedTarget.nodeArchive);
    await writeFile(archivePath, archiveBytes);
    const archiveFolder = selectedTarget.nodeArchive.replace(/\.tar\.gz$/u, "");
    const extraction = spawnSync(
        "tar",
        [
            "-xzf",
            join(temporaryDirectory, selectedTarget.nodeArchive),
            "-C",
            extractionDirectory,
            "--strip-components=1",
            `${archiveFolder}/bin/node`,
            `${archiveFolder}/LICENSE`,
        ],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (extraction.error || extraction.status !== 0) {
        throw new Error(
            `Could not extract the verified Node runtime with tar: ${extraction.error?.message ?? extraction.stderr.trim() ?? "unknown extraction error"}`,
        );
    }
    const executable = join(extractionDirectory, "bin", "node");
    const license = join(extractionDirectory, "LICENSE");
    if (!(await exists(executable)) || !(await exists(license))) {
        throw new Error(
            `The verified Node archive is missing its executable or license for ${selectedTarget.key}.`,
        );
    }
    return { executable, license };
}

async function fetchBounded(url, maximumBytes) {
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok || !response.body) {
        throw new Error(
            `Could not download the pinned Tutorux command runtime resource (${response.status}).`,
        );
    }
    const advertisedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
        throw new Error("A Node runtime download exceeded its allowed size.");
    }
    const chunks = [];
    let totalBytes = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            totalBytes += result.value.byteLength;
            if (totalBytes > maximumBytes) {
                await reader.cancel();
                throw new Error("A Node runtime download exceeded its allowed size.");
            }
            chunks.push(Buffer.from(result.value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes);
}

async function installHoistedRuntime() {
    const directory = await mkdtemp(join(tmpdir(), "tutorux-runtime-tree-"));
    try {
        await cp(join(root, "package.json"), join(directory, "package.json"));
        await cp(join(root, "pnpm-lock.yaml"), join(directory, "pnpm-lock.yaml"));
        const configured = process.env["npm_execpath"];
        const executable = configured || (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
        const installation = spawnSync(
            executable,
            [
                "install",
                "--prod",
                "--frozen-lockfile",
                "--node-linker=hoisted",
                "--ignore-scripts",
                "--prefer-offline",
                // The committed lockfile is already used for development.
                // Skip its release-age re-check here; integrity checks remain.
                "--trust-lockfile",
            ],
            {
                cwd: directory,
                encoding: "utf8",
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
                shell: !configured && process.platform === "win32",
            },
        );
        if (installation.error) throw installation.error;
        if (installation.status !== 0) {
            throw new Error(
                `Could not prepare the hoisted Tutorux CLI dependencies: ${installation.stderr.trim()}`,
            );
        }
        return directory;
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

async function collectRuntimePackages(installationDirectory, optionalPackages) {
    const nodeModulesDirectory = join(installationDirectory, "node_modules");
    const packages = new Map();
    const rootRequire = createRequire(join(installationDirectory, "package.json"));

    async function addPackage(packageName, requesterDirectory, required = true) {
        const requesterRequire = requesterDirectory
            ? createRequire(join(requesterDirectory, "package.json"))
            : rootRequire;
        let entryPoint;
        try {
            entryPoint = requesterRequire.resolve(packageName);
        } catch (cause) {
            // Platform packages such as @img/sharp-win32-x64 intentionally have no
            // JavaScript entry point. Resolve their manifest through the installed
            // tree instead.
            const directCandidate = join(
                requesterDirectory ?? installationDirectory,
                "node_modules",
                ...packageName.split("/"),
                "package.json",
            );
            const rootCandidate = join(
                nodeModulesDirectory,
                ...packageName.split("/"),
                "package.json",
            );
            if (await exists(directCandidate)) {
                entryPoint = directCandidate;
            } else if (await exists(rootCandidate)) {
                entryPoint = rootCandidate;
            } else if (!required) {
                return;
            } else {
                throw new Error(
                    `The bundled Tutorux CLI is missing its runtime dependency ${packageName}.`,
                    {
                        cause,
                    },
                );
            }
        }
        const source = await findPackageRoot(entryPoint, packageName);
        const relativePath = relative(nodeModulesDirectory, source);
        if (
            !relativePath ||
            isAbsolute(relativePath) ||
            relativePath === ".." ||
            relativePath.startsWith(`..${sep}`)
        ) {
            throw new Error(
                `The Tutorux CLI dependency ${packageName} resolves outside node_modules.`,
            );
        }
        if (packages.has(relativePath)) return;
        const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
        const entry = { name: metadata.name, source, relativePath, metadata };
        packages.set(relativePath, entry);

        for (const dependencyName of Object.keys(metadata.dependencies ?? {})) {
            await addPackage(dependencyName, source);
        }
        for (const optionalName of Object.keys(metadata.optionalDependencies ?? {})) {
            if (optionalPackages.has(optionalName)) {
                await addPackage(optionalName, source);
            }
        }
    }

    await addPackage("sharp");
    await addPackage("node-llama-cpp");
    for (const optionalName of optionalPackages) {
        const alreadyIncluded = [...packages.values()].some((entry) => entry.name === optionalName);
        if (!alreadyIncluded) {
            throw new Error(
                `The target-specific native dependency ${optionalName} is missing from this dependency installation. Reinstall dependencies on a matching ${hostTarget.key} build machine.`,
            );
        }
    }
    return [...packages.values()].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
    );
}

async function collectBundledPackageLicenses() {
    const bundledPackages = [];
    const requester = createRequire(join(root, "package.json"));
    for (const name of ["fflate", "libsodium-wrappers-sumo", "libsodium-sumo"]) {
        const entryPoint = requester.resolve(name);
        const directory = await findPackageRoot(entryPoint, name);
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        bundledPackages.push({
            name,
            version: metadata.version,
            license: metadata.license ?? "See included license files",
            directory,
        });
    }
    return bundledPackages;
}

async function writeThirdPartyNotices(destinationDirectory, entries) {
    const licensesDirectory = join(destinationDirectory, "licenses");
    await mkdir(licensesDirectory, { recursive: true });
    const notices = [
        "Tutorux command console third-party runtime notices",
        "",
        "The bundled CLI includes or loads the following third-party packages.",
        "License texts found in their installed packages are included in this folder.",
        "Node.js is distributed separately with NODE-LICENSE.txt.",
        "",
    ];
    for (const entry of entries) {
        const files = await readdir(entry.directory, { withFileTypes: true });
        const licenseFiles = files.filter(
            (file) =>
                file.isFile() &&
                /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$/iu.test(file.name),
        );
        notices.push(`${entry.name}@${entry.version} — ${entry.license}`);
        if (licenseFiles.length === 0) {
            notices.push("  No top-level license text file was published in this package.");
            continue;
        }
        for (const licenseFile of licenseFiles) {
            const filePath = join(entry.directory, licenseFile.name);
            const fileMetadata = await stat(filePath);
            if (fileMetadata.size > 2 * 1024 * 1024) {
                throw new Error(`A dependency license file is unexpectedly large: ${filePath}`);
            }
            const packageSlug = entry.name.replace(/[^a-z\d.-]+/giu, "-");
            const destinationName = `${packageSlug}-${entry.version}-${licenseFile.name}`;
            await cp(filePath, join(licensesDirectory, destinationName));
            notices.push(`  ${destinationName}`);
        }
        notices.push("");
    }
    await writeFile(
        join(destinationDirectory, "THIRD-PARTY-NOTICES.txt"),
        `${notices.join("\n")}\n`,
    );
}

async function findPackageRoot(entryPoint, packageName) {
    let candidate = dirname(await realpath(entryPoint));
    while (true) {
        try {
            const metadata = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
            if (metadata.name === packageName) return candidate;
        } catch {
            // Walk up until the package directory is found or resolution leaves node_modules.
        }
        const parent = dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
    }
    throw new Error(`Could not identify the installed package directory for ${packageName}.`);
}

async function measureDirectoryBytes(directory) {
    let totalBytes = 0;
    const pending = [directory];
    while (pending.length > 0) {
        const current = pending.pop();
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = join(current, entry.name);
            const metadata = await lstat(entryPath);
            if (metadata.isSymbolicLink()) {
                throw new Error(
                    `The Tutorux runtime dependency closure contains an unsupported symlink: ${entryPath}`,
                );
            }
            if (metadata.isDirectory()) pending.push(entryPath);
            else if (metadata.isFile()) totalBytes += metadata.size;
            if (totalBytes > maximumRuntimeClosureBytes) return totalBytes;
        }
    }
    return totalBytes;
}

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function removeManagedDirectory(path) {
    const relativePath = relative(runtimeCacheDirectory, path);
    if (
        !relativePath ||
        isAbsolute(relativePath) ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`)
    ) {
        throw new Error("The generated Tutorux runtime cache path is outside its managed folder.");
    }
    await rm(path, { recursive: true, force: true });
}
