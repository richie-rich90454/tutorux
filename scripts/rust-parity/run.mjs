import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firstDifference, matchShape, normalizeSemantic, normalizeText } from "./normalize.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const corpusPath = join(repositoryRoot, "tests", "rust-parity", "corpus.json");
const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const tsCli = join(repositoryRoot, "cli", "main.ts");
const rustCli = join(
    repositoryRoot,
    "src-tauri",
    "target",
    "debug",
    process.platform === "win32" ? "tutorux-cli.exe" : "tutorux-cli",
);
const compareArchive = join(scriptDirectory, "compare-archive.ts");
const capabilityDirectory = join(repositoryRoot, "src-tauri", "src", "core", "capability");

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        env: { ...process.env, ...(options.env ?? {}) },
        encoding: "utf8",
        timeout: options.timeout ?? 180_000,
        windowsHide: true,
    });
    if (result.error) {
        return {
            error: result.error,
            code: 1,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
        };
    }
    return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

function sideCommand(side, args, cwd) {
    if (side === "ts") {
        return run(process.execPath, [tsxCli, tsCli, ...args], { cwd });
    }
    return run(rustCli, args, { cwd });
}

function parseJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    return JSON.parse(trimmed);
}

function getPath(value, path) {
    let current = value;
    for (const part of path.split(".")) {
        if (part === "") continue;
        if (current === undefined || current === null) return undefined;
        current = current[Number.isInteger(Number(part)) ? Number(part) : part];
    }
    return current;
}

function substitute(value, context) {
    return value
        .replaceAll("{archive}", context.archive)
        .replaceAll("{dir}", context.dir)
        .replace(/\{capture\.([^}]+)\}/gu, (_, name) => {
            if (!(name in context.captures)) throw new Error(`missing capture \`${name}\``);
            return String(context.captures[name]);
        });
}

function normalizedResult(result, context, roots) {
    return {
        exitCode: result.code,
        stderr: normalizeText(result.stderr, [context.archive, context.dir, ...roots]),
        stdout: result.stdout,
        json: parseJson(result.stdout),
    };
}

function checkExpectation(expect, result, context, label) {
    const issues = [];
    if (expect.exitCode !== undefined && result.code !== expect.exitCode) {
        issues.push(`${label}: exit ${result.code}, expected ${expect.exitCode}`);
    }
    const stderr = normalizeText(result.stderr, [context.archive, context.dir, context.root]);
    for (const needle of expect.stderrContains ?? []) {
        if (!stderr.includes(needle))
            issues.push(`${label}: stderr is missing \`${needle}\` (got \`${stderr}\`)`);
    }
    for (const needle of expect.stderrNotContains ?? []) {
        if (stderr.includes(needle))
            issues.push(`${label}: stderr unexpectedly contains \`${needle}\``);
    }
    if (expect.stdoutEmpty === true && result.stdout.trim() !== "") {
        issues.push(`${label}: expected empty stdout`);
    }
    if ("stdoutJson" in expect) {
        if (expect.stdoutJson === null) {
            if (result.stdout.trim() !== "") {
                issues.push(`${label}: expected no JSON stdout, got \`${result.stdout.trim()}\``);
            }
        } else {
            let actual;
            try {
                actual = parseJson(result.stdout);
            } catch (error) {
                issues.push(`${label}: stdout is not JSON: ${error.message}`);
                actual = undefined;
            }
            if (actual !== undefined) {
                issues.push(...matchShape(actual, expect.stdoutJson, `${label}.stdout`));
            }
        }
    }
    if (expect.file) {
        const filePath = substitute(expect.file.path, context);
        try {
            const text = readFileSync(filePath, "utf8");
            if (expect.file.text !== undefined && text !== expect.file.text) {
                issues.push(`${label}: file ${filePath} contains ${JSON.stringify(text)}`);
            }
        } catch (error) {
            issues.push(`${label}: ${error.message}`);
        }
    }
    return issues;
}

async function runSide(side, testCase, seedPath, caseRoot, roots) {
    const context = {
        side,
        root: caseRoot,
        dir: join(caseRoot, side),
        archive: join(caseRoot, side, "archive.tux"),
        captures: {},
    };
    await mkdir(context.dir, { recursive: true });
    if (testCase.seed !== false) {
        await copyFile(seedPath, context.archive);
    }
    for (const [relativePath, contents] of Object.entries(testCase.files ?? {})) {
        const filePath = join(context.dir, relativePath);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, contents, "utf8");
    }

    const setupResults = [];
    for (const [index, step] of (testCase.setup ?? []).entries()) {
        const args = step.args.map((argument) => substitute(argument, context));
        const result = sideCommand(side, args, context.dir);
        const parsed = parseJson(result.stdout);
        if (result.code !== 0) {
            return {
                context,
                error: `${side} setup ${index} exited ${result.code}: ${normalizeText(result.stderr, [context.archive, context.dir, ...roots])}`,
                setupResults,
                results: [],
            };
        }
        for (const [name, path] of Object.entries(step.capture ?? {})) {
            const captured = getPath(parsed, path);
            if (captured === undefined) {
                return {
                    context,
                    error: `${side} setup ${index} did not return capture \`${name}\` at ${path}`,
                    setupResults,
                    results: [],
                };
            }
            context.captures[name] = captured;
        }
        setupResults.push({ code: result.code, stdout: result.stdout, stderr: result.stderr });
    }

    const results = [];
    const issues = [];
    for (const [index, step] of testCase.steps.entries()) {
        const label = `${side} step ${index} (${step.id ?? testCase.id})`;
        let result;
        try {
            const args = step.args.map((argument) => substitute(argument, context));
            result = sideCommand(side, args, context.dir);
        } catch (error) {
            issues.push(`${label}: ${error.message}`);
            results.push({ exitCode: -1, stderr: "", stdout: "", json: undefined });
            continue;
        }
        const normalized = normalizedResult(result, context, roots);
        results.push(normalized);
        issues.push(...checkExpectation(step.expect ?? {}, result, context, label));
        for (const [name, path] of Object.entries(step.capture ?? {})) {
            const captured = getPath(normalized.json, path);
            if (captured === undefined) {
                issues.push(`${label}: did not return capture \`${name}\` at ${path}`);
            } else {
                context.captures[name] = captured;
            }
        }
    }
    return { context, setupResults, results, issues };
}

function compareSides(left, right) {
    const issues = [];
    const count = Math.max(left.results.length, right.results.length);
    for (let index = 0; index < count; index += 1) {
        const leftResult = left.results[index];
        const rightResult = right.results[index];
        if (!leftResult || !rightResult) {
            issues.push(`step ${index}: only one adapter produced a result`);
            continue;
        }
        if (leftResult.exitCode !== rightResult.exitCode) {
            issues.push(
                `step ${index}: TS exit ${leftResult.exitCode}, Rust exit ${rightResult.exitCode}`,
            );
        }
        if (leftResult.stderr !== rightResult.stderr) {
            issues.push(
                `step ${index}: stderr differs\n  TS:   ${leftResult.stderr}\n  Rust: ${rightResult.stderr}`,
            );
        }
        if (leftResult.json !== undefined || rightResult.json !== undefined) {
            if (leftResult.json === undefined || rightResult.json === undefined) {
                issues.push(`step ${index}: one adapter produced JSON and the other did not`);
            } else {
                const difference = firstDifference(
                    normalizeSemantic(leftResult.json),
                    normalizeSemantic(rightResult.json),
                    `step ${index} stdout`,
                );
                issues.push(...difference);
            }
        }
    }
    return issues;
}

async function corpusCapabilityIds() {
    const files = (await readdir(capabilityDirectory)).filter((name) => name.endsWith(".rs"));
    const sources = await Promise.all(
        files.map((name) => readFile(join(capabilityDirectory, name), "utf8")),
    );
    return new Set(
        sources.flatMap((source) =>
            [...source.matchAll(/cap!\("([^"]+)"/gu)].map((match) => match[1]),
        ),
    );
}

async function main() {
    try {
        await access(rustCli, fsConstants.X_OK);
    } catch {
        fail(
            `Rust CLI is missing at ${rustCli}.\nBuild it with:\n  cargo build --manifest-path src-tauri/Cargo.toml --features cli --bin tutorux-cli`,
        );
        return;
    }
    try {
        await access(tsxCli, fsConstants.R_OK);
    } catch {
        fail(`tsx is missing at ${tsxCli}. Run \`pnpm install\` first.`);
        return;
    }
    if (!process.execPath) {
        fail("node is not available on PATH.");
        return;
    }

    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    const capabilityIds = await corpusCapabilityIds();
    const cases = corpus.cases.filter((testCase) => !only || testCase.id === only);
    if (cases.length === 0) {
        fail(`No parity cases matched${only ? ` --only ${only}` : ""}.`);
        return;
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "tutorux-rust-parity-"));
    const seedPath = join(temporaryRoot, "seed.tux");
    try {
        const seed = sideCommand(
            "ts",
            ["archive", "init", seedPath, "--name", "Parity seed"],
            temporaryRoot,
        );
        if (seed.code !== 0) {
            fail(`Could not create the parity seed archive: ${seed.stderr.trim()}`);
            return;
        }

        let passed = 0;
        const failures = [];
        for (const testCase of cases) {
            const caseIssues = [];
            if (!capabilityIds.has(testCase.capability)) {
                caseIssues.push(`unknown capability id \`${testCase.capability}\``);
            }
            const caseRoot = join(temporaryRoot, testCase.id.replace(/[^A-Za-z0-9_.-]/gu, "_"));
            const roots = [caseRoot, temporaryRoot];
            const tsSide = await runSide("ts", testCase, seedPath, caseRoot, roots);
            if (tsSide.error) caseIssues.push(tsSide.error);
            caseIssues.push(...(tsSide.issues ?? []));
            const rustSide = await runSide("rust", testCase, seedPath, caseRoot, roots);
            if (rustSide.error) caseIssues.push(rustSide.error);
            caseIssues.push(...(rustSide.issues ?? []));

            if (tsSide.error || rustSide.error) {
                // A side that never ran cannot supply comparable results.
            } else {
                caseIssues.push(...compareSides(tsSide, rustSide));
                if (testCase.compareArchive !== false && testCase.seed !== false) {
                    const comparison = run(
                        process.execPath,
                        [tsxCli, compareArchive, tsSide.context.archive, rustSide.context.archive],
                        { cwd: repositoryRoot },
                    );
                    let comparisonResult;
                    try {
                        comparisonResult = parseJson(comparison.stdout);
                    } catch {
                        comparisonResult = undefined;
                    }
                    if (comparison.code !== 0 || !comparisonResult?.ok) {
                        const detail =
                            comparisonResult?.issues?.join("\n  ") ?? comparison.stderr.trim();
                        caseIssues.push(`archive comparison failed:\n  ${detail}`);
                    }
                }
            }

            if (caseIssues.length === 0) {
                passed += 1;
                process.stdout.write(`PASS ${testCase.id}\n`);
            } else {
                failures.push({ id: testCase.id, issues: caseIssues });
                process.stdout.write(`FAIL ${testCase.id}\n`);
                for (const issue of caseIssues) process.stdout.write(`  ${issue}\n`);
            }
        }

        process.stdout.write(
            `\n${passed} passed, ${failures.length} failed, ${cases.length} total\n`,
        );
        if (failures.length > 0) process.exitCode = 1;
    } finally {
        if (process.env.TUTORUX_PARITY_KEEP !== "1") {
            await rm(temporaryRoot, { recursive: true, force: true });
        } else {
            process.stdout.write(`Parity workspace kept at ${temporaryRoot}\n`);
        }
    }
}

main().catch((error) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
