import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    access,
    copyFile,
    cp,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { constants as fsConstants, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchShape, matchSubset, normalizeText } from "./normalize.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const corpusDirectory = join(repositoryRoot, "tests", "rust-parity");
const corpusPartsDirectory = join(corpusDirectory, "corpus");
const coveragePath = join(corpusDirectory, "coverage.json");
const defaultReportPath = join(corpusDirectory, "last-report.json");
const rustCli = join(
    repositoryRoot,
    "src-tauri",
    "target",
    "debug",
    process.platform === "win32" ? "tutorux-cli.exe" : "tutorux-cli",
);
const capabilityDirectory = join(repositoryRoot, "src-tauri", "src", "core", "capability");

const argumentsList = process.argv.slice(2);
function argumentValue(name) {
    const index = argumentsList.indexOf(name);
    return index === -1 ? undefined : argumentsList[index + 1];
}
const onlyArgument = argumentValue("--only");
const patterns = onlyArgument
    ? onlyArgument
          .split(",")
          .map((pattern) => pattern.trim())
          .filter(Boolean)
    : [];
const listOnly = argumentsList.includes("--list");
const concise = argumentsList.includes("--concise") || argumentsList.includes("--failures-only");
const showSummary = !argumentsList.includes("--no-summary");
const reportPath = argumentsList.includes("--no-report")
    ? undefined
    : resolve(argumentValue("--report") ?? defaultReportPath);
const keepWorkspace = process.env.TUTORUX_PARITY_KEEP === "1";

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

function runCli(args, cwd, env, timeout) {
    return run(rustCli, args, { cwd, env, timeout });
}

function parseJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
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
        .replaceAll("{root}", context.root)
        .replace(/\{env\.([^}]+)\}/gu, (_, name) => context.env[name] ?? "")
        .replace(/\{capture\.([^}]+)\}/gu, (_, name) => {
            if (!(name in context.captures)) throw new Error(`missing capture \`${name}\``);
            return String(context.captures[name]);
        });
}

function stepCapabilities(step, testCase) {
    return [
        ...(step.capability ? [step.capability] : []),
        ...(step.capabilities ?? []),
        ...(step.capability || step.capabilities
            ? []
            : testCase.capability
              ? [testCase.capability]
              : []),
    ];
}

function normalizeResult(result, context, roots) {
    const json = parseJson(result.stdout);
    return {
        exitCode: result.code,
        stderr: normalizeText(result.stderr, [
            context.archive,
            context.dir,
            context.root,
            ...roots,
        ]),
        stdout: normalizeText(result.stdout, [
            context.archive,
            context.dir,
            context.root,
            ...roots,
        ]),
        json,
    };
}

function regexMatches(testValue, patterns) {
    return patterns.map((pattern) => {
        try {
            return new RegExp(pattern, "u");
        } catch (error) {
            return { error };
        }
    });
}

function checkExpectation(expect, result, context, label) {
    const issues = [];
    if (expect.exitCode !== undefined && result.code !== expect.exitCode) {
        const detail = normalizeText(result.stderr, [context.archive, context.dir, context.root])
            .split("\n")[0]
            .trim();
        issues.push(
            `${label}: exit ${result.code}, expected ${expect.exitCode}${detail ? ` (stderr: ${detail})` : ""}`,
        );
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
    for (const pattern of regexMatches(stderr, expect.stderrMatches ?? [])) {
        if (pattern.error) {
            issues.push(`${label}: invalid stderr regex (${pattern.error.message})`);
        } else if (!pattern.test(stderr)) {
            issues.push(`${label}: stderr does not match /${pattern.source}/u`);
        }
    }
    for (const needle of expect.stdoutContains ?? []) {
        if (!result.stdout.includes(needle))
            issues.push(`${label}: stdout is missing \`${needle}\``);
    }
    for (const needle of expect.stdoutNotContains ?? []) {
        if (result.stdout.includes(needle))
            issues.push(`${label}: stdout unexpectedly contains \`${needle}\``);
    }
    if (expect.stdoutMinLines !== undefined) {
        const lines = result.stdout.split(/\r?\n/gu).filter((line) => line.length > 0).length;
        if (lines < expect.stdoutMinLines) {
            issues.push(
                `${label}: expected at least ${expect.stdoutMinLines} stdout lines, got ${lines}`,
            );
        }
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
                actual = JSON.parse(result.stdout);
            } catch (error) {
                issues.push(`${label}: stdout is not JSON: ${error.message}`);
                actual = undefined;
            }
            if (actual !== undefined) {
                issues.push(...matchShape(actual, expect.stdoutJson, `${label}.stdout`));
            }
        }
    }
    if ("stdoutJsonIncludes" in expect) {
        let actual;
        try {
            actual = JSON.parse(result.stdout);
        } catch (error) {
            issues.push(`${label}: stdout is not JSON: ${error.message}`);
            actual = undefined;
        }
        if (actual !== undefined) {
            issues.push(...matchSubset(actual, expect.stdoutJsonIncludes, `${label}.stdout`));
        }
    }
    for (const fileExpectation of expect.files ?? (expect.file ? [expect.file] : [])) {
        const filePath = substitute(fileExpectation.path, context);
        try {
            const information = statSync(filePath);
            if (fileExpectation.bytes !== undefined && information.size !== fileExpectation.bytes) {
                issues.push(
                    `${label}: file ${filePath} has ${information.size} bytes, expected ${fileExpectation.bytes}`,
                );
            }
            if (fileExpectation.text !== undefined) {
                const text = readFileSync(filePath, "utf8");
                if (text !== fileExpectation.text) {
                    issues.push(`${label}: file ${filePath} contains ${JSON.stringify(text)}`);
                }
            }
            if (fileExpectation.contains) {
                const text = readFileSync(filePath, "utf8");
                for (const needle of fileExpectation.contains) {
                    if (!text.includes(needle)) {
                        issues.push(`${label}: file ${filePath} is missing \`${needle}\``);
                    }
                }
            }
            if (fileExpectation.sha256 !== undefined) {
                const digest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
                if (digest !== fileExpectation.sha256) {
                    issues.push(
                        `${label}: file ${filePath} SHA-256 is ${digest}, expected ${fileExpectation.sha256}`,
                    );
                }
            }
        } catch (error) {
            issues.push(`${label}: ${error.message}`);
        }
    }
    return issues;
}

async function runSide(side, testCase, seedPath, caseRoot, roots, setupSource = null) {
    const context = {
        side,
        root: caseRoot,
        dir: join(caseRoot, side),
        archive: join(caseRoot, side, "archive.tux"),
        captures: {},
        env: {},
    };
    await mkdir(context.dir, { recursive: true });
    if (setupSource) {
        await cp(setupSource.dir, context.dir, { recursive: true });
        context.captures = Object.fromEntries(
            Object.entries(setupSource.captures).map(([name, value]) => [
                name,
                typeof value === "string" ? value.split(setupSource.dir).join(context.dir) : value,
            ]),
        );
    } else if (testCase.seed !== false) {
        await copyFile(seedPath, context.archive);
    }
    if (!setupSource) {
        for (const [relativePath, contents] of Object.entries(testCase.files ?? {})) {
            const filePath = join(context.dir, relativePath);
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, contents, "utf8");
        }
        for (const [relativePath, contents] of Object.entries(testCase.filesBase64 ?? {})) {
            const filePath = join(context.dir, relativePath);
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, Buffer.from(contents, "base64"));
        }
    }
    const caseEnvironment = Object.fromEntries(
        Object.entries(testCase.env ?? {}).map(([name, value]) => [name, String(value)]),
    );

    const setupResults = [];
    for (const [index, step] of (setupSource ? [] : (testCase.setup ?? [])).entries()) {
        const env = { ...caseEnvironment, ...(step.env ?? {}) };
        context.env = env;
        let args;
        try {
            args = step.args.map((argument) => substitute(argument, context));
        } catch (error) {
            return {
                context,
                error: `${side} setup ${index}: ${error.message}`,
                setupResults,
                results: [],
                issues: [],
            };
        }
        const result = runCli(args, context.dir, env, step.timeout);
        const parsed = parseJson(result.stdout);
        if (result.code !== 0) {
            return {
                context,
                error: `${side} setup ${index} (${step.id ?? "setup"}) exited ${result.code}: ${normalizeText(result.stderr, [context.archive, context.dir, ...roots])}`,
                setupResults,
                results: [],
                issues: [],
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
                    issues: [],
                };
            }
            context.captures[name] = captured;
        }
        setupResults.push({ code: result.code, stdout: result.stdout, stderr: result.stderr });
    }

    const results = [];
    const issues = [];
    const setupDir = join(caseRoot, `${side}-setup`);
    await rm(setupDir, { recursive: true, force: true });
    await cp(context.dir, setupDir, { recursive: true });
    for (const [index, step] of testCase.steps.entries()) {
        const label = `${side} step ${index} (${step.id ?? testCase.id})`;
        const capabilities = stepCapabilities(step, testCase);
        let result;
        try {
            const env = { ...caseEnvironment, ...(step.env ?? {}) };
            context.env = env;
            const args = step.args.map((argument) => substitute(argument, context));
            result = runCli(args, context.dir, env, step.timeout);
        } catch (error) {
            issues.push({ step: index, capabilities, message: `${label}: ${error.message}` });
            results.push({
                capability: capabilities[0],
                exitCode: -1,
                stderr: "",
                stdout: "",
                json: undefined,
            });
            continue;
        }
        const normalized = normalizeResult(result, context, roots);
        normalized.capability = capabilities[0];
        results.push(normalized);
        const expectationIssues = checkExpectation(step.expect ?? {}, result, context, label);
        for (const message of expectationIssues) {
            issues.push({ step: index, capabilities, message });
        }
        for (const [name, path] of Object.entries(step.capture ?? {})) {
            const captured = getPath(normalized.json, path);
            if (captured === undefined) {
                issues.push({
                    step: index,
                    capabilities,
                    message: `${label}: did not return capture \`${name}\` at ${path}`,
                });
            } else {
                context.captures[name] = captured;
            }
        }
    }
    return { context, setupResults, results, issues, setupDir };
}

async function loadCorpus() {
    const files = [];
    try {
        await access(join(corpusDirectory, "corpus.json"));
        files.push(join(corpusDirectory, "corpus.json"));
    } catch {
        // The corpus may consist only of split files.
    }
    try {
        const entries = await readdir(corpusPartsDirectory);
        for (const name of entries.filter((entry) => entry.endsWith(".json")).sort()) {
            files.push(join(corpusPartsDirectory, name));
        }
    } catch {
        // No split corpus yet.
    }
    if (!files.length) throw new Error(`No parity corpus found under ${corpusDirectory}.`);
    const cases = [];
    for (const file of files) {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        for (const testCase of parsed.cases ?? []) {
            cases.push({ ...testCase, source: relative(repositoryRoot, file) });
        }
    }
    const ids = new Set();
    for (const testCase of cases) {
        if (ids.has(testCase.id)) throw new Error(`Duplicate parity case id: ${testCase.id}`);
        ids.add(testCase.id);
    }
    return cases;
}

function caseCapabilities(testCase) {
    const capabilities = new Set([
        ...(testCase.capability ? [testCase.capability] : []),
        ...(testCase.capabilities ?? []),
    ]);
    for (const step of testCase.steps ?? []) {
        for (const capability of stepCapabilities(step, testCase)) capabilities.add(capability);
    }
    return [...capabilities];
}

async function registryCapabilities() {
    const files = [];
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const entryPath = join(directory, entry.name);
            if (entry.isDirectory()) await walk(entryPath);
            else if (entry.name.endsWith(".rs")) files.push(entryPath);
        }
    }
    await walk(capabilityDirectory);
    const capabilities = new Map();
    for (const file of files) {
        const source = await readFile(file, "utf8");
        for (const match of source.matchAll(/cap!\(\s*"([^"]+)"/gu)) {
            capabilities.set(match[1], { file: relative(repositoryRoot, file) });
        }
    }
    return capabilities;
}

async function loadCoverage() {
    try {
        return JSON.parse(await readFile(coveragePath, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return { version: 1, tests: {} };
        throw error;
    }
}

function verifyTestCitation(citation) {
    const [file, ...parts] = citation.split("::");
    const title = parts.join("::");
    if (!file || !title) return `invalid test citation \`${citation}\``;
    const absolute = resolve(repositoryRoot, file);
    if (!absolute.startsWith(repositoryRoot))
        return `test citation escapes the repository: ${file}`;
    let source;
    try {
        source = readFileSync(absolute, "utf8");
    } catch {
        return `cited test file is missing: ${file}`;
    }
    const normalizedSource = source.replace(/\s+/gu, " ");
    for (const part of parts) {
        const normalizedPart = part.replace(/\s+/gu, " ");
        if (!normalizedPart) continue;
        if (!normalizedSource.includes(normalizedPart)) {
            return `cited test title is missing from ${file}: ${part}`;
        }
    }
    return undefined;
}

async function checkCoverage(cases) {
    const registry = await registryCapabilities();
    const coverage = await loadCoverage();
    const corpusCovered = new Set();
    for (const testCase of cases) {
        for (const capability of caseCapabilities(testCase)) corpusCovered.add(capability);
    }
    const testCitations = coverage.tests ?? {};
    const testCovered = new Set(Object.keys(testCitations));
    const issues = [];
    for (const [capability, citation] of Object.entries(testCitations)) {
        if (!registry.has(capability))
            issues.push(`test coverage names unregistered capability \`${capability}\``);
        const problem = verifyTestCitation(citation);
        if (problem) issues.push(problem);
    }
    const missing = [...registry.keys()].filter(
        (capability) => !corpusCovered.has(capability) && !testCovered.has(capability),
    );
    for (const capability of missing)
        issues.push(`registry capability has no corpus case or test: ${capability}`);
    const unregisteredCorpus = [...corpusCovered].filter((capability) => !registry.has(capability));
    for (const capability of unregisteredCorpus) {
        issues.push(`corpus names unregistered capability \`${capability}\``);
    }
    return {
        registry,
        corpusCovered,
        testCovered,
        missing,
        unregisteredCorpus,
        issues,
        byCorpus: [...corpusCovered].filter((capability) => registry.has(capability)).length,
        byTest: [...testCovered].filter((capability) => registry.has(capability)).length,
    };
}

function matchesOnly(id) {
    if (!patterns.length) return true;
    return patterns.some((pattern) => {
        if (pattern.includes("*") || pattern.includes("?")) {
            const expression = new RegExp(
                `^${pattern
                    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
                    .replace(/\*/gu, ".*")
                    .replace(/\?/gu, ".")}$`,
                "u",
            );
            return expression.test(id);
        }
        return id === pattern || id.startsWith(`${pattern}.`) || id.includes(pattern);
    });
}

function summarize(cases, results, coverageIssues) {
    const byCapability = new Map();
    const byFamily = new Map();
    for (const testCase of cases) {
        const family = testCase.family ?? (testCase.capability ?? "").split(".")[0] ?? "unknown";
        const familyRow = byFamily.get(family) ?? { passed: 0, failed: 0 };
        const caseResult = results.get(testCase.id);
        const failed = !caseResult || caseResult.issues.length > 0;
        if (failed) familyRow.failed += 1;
        else familyRow.passed += 1;
        byFamily.set(family, familyRow);

        const stepCaps = new Map();
        for (const [index, step] of (testCase.steps ?? []).entries()) {
            for (const capability of stepCapabilities(step, testCase)) {
                if (!stepCaps.has(capability)) stepCaps.set(capability, []);
                stepCaps.get(capability).push(index);
            }
        }
        for (const capability of caseCapabilities(testCase)) {
            const row = byCapability.get(capability) ?? { passed: 0, failed: 0 };
            const indexes = stepCaps.get(capability) ?? [];
            const caseLevelFailure =
                !caseResult ||
                caseResult.issues.some((issue) => issue.step === null || issue.step === undefined);
            const stepFailure =
                caseResult?.issues.some(
                    (issue) => issue.step !== null && indexes.includes(issue.step),
                ) ?? true;
            if (!caseResult || caseLevelFailure || stepFailure) row.failed += 1;
            else row.passed += 1;
            byCapability.set(capability, row);
        }
    }
    return {
        byCapability: [...byCapability.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, row]) => ({ id, ...row })),
        byFamily: [...byFamily.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, row]) => ({ id, ...row })),
        coverageIssues,
    };
}

async function writeReport(report) {
    if (!reportPath) return;
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main() {
    const allCases = await loadCorpus();
    if (listOnly) {
        for (const testCase of allCases) process.stdout.write(`${testCase.id}\n`);
        return;
    }
    const selected = allCases.filter((testCase) => matchesOnly(testCase.id));
    if (selected.length === 0) {
        fail(`No parity cases matched${patterns.length ? ` --only ${patterns.join(",")}` : ""}.`);
        return;
    }
    try {
        await access(rustCli, fsConstants.X_OK);
    } catch {
        fail(
            `Rust CLI is missing at ${rustCli}.\nBuild it with:\n  cargo build --manifest-path src-tauri/Cargo.toml --features cli --bin tutorux-cli`,
        );
        return;
    }

    const coverage = await checkCoverage(allCases);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "tutorux-rust-parity-"));
    const seedPath = join(temporaryRoot, "seed.tux");
    try {
        const seed = runCli(
            ["archive", "init", seedPath, "--name", "Parity seed"],
            temporaryRoot,
            {},
        );
        if (seed.code !== 0) {
            fail(`Could not create the parity seed archive: ${seed.stderr.trim()}`);
            return;
        }

        const results = new Map();
        let passed = 0;
        const failures = [];
        for (const testCase of selected) {
            const caseIssues = [];
            const capabilities = caseCapabilities(testCase);
            const caseRoot = join(temporaryRoot, testCase.id.replace(/[^A-Za-z0-9_.-]/gu, "_"));
            const roots = [caseRoot, temporaryRoot];
            const rustSide = await runSide("rust", testCase, seedPath, caseRoot, roots);
            if (rustSide.error) {
                caseIssues.push({
                    step: null,
                    capabilities,
                    message: `Rust CLI did not run: ${rustSide.error}`,
                });
            }
            caseIssues.push(...(rustSide.issues ?? []));

            results.set(testCase.id, { issues: caseIssues, capabilities });
            if (caseIssues.length === 0) {
                passed += 1;
                if (!concise) process.stdout.write(`PASS ${testCase.id}\n`);
            } else {
                const first = caseIssues[0];
                failures.push({
                    id: testCase.id,
                    capability: first?.capabilities?.[0] ?? capabilities[0] ?? "unregistered",
                    step: first?.step ?? null,
                    issueCount: caseIssues.length,
                    issues: caseIssues.slice(0, 8).map((issue) => issue.message),
                });
                process.stdout.write(`FAIL ${testCase.id}\n`);
                if (concise) {
                    process.stdout.write(`  ${first.message.split("\n")[0]}\n`);
                } else {
                    for (const issue of caseIssues) {
                        for (const line of issue.message.split("\n")) {
                            process.stdout.write(`  ${line}\n`);
                        }
                    }
                }
            }
        }

        const summary = summarize(selected, results, coverage.issues);
        if (showSummary) {
            process.stdout.write("\nSummary by capability:\n");
            for (const row of summary.byCapability) {
                process.stdout.write(`  ${row.id}: ${row.passed} passed, ${row.failed} failed\n`);
            }
        }
        if (showSummary) {
            process.stdout.write("\nSummary by family:\n");
            for (const row of summary.byFamily) {
                process.stdout.write(`  ${row.id}: ${row.passed} passed, ${row.failed} failed\n`);
            }
        }
        process.stdout.write(
            `\n${passed} passed, ${failures.length} failed, ${selected.length} total\n`,
        );
        process.stdout.write(
            `Coverage: ${coverage.registry.size} registry capabilities; ${coverage.byCorpus} by corpus, ${coverage.byTest} by cited tests, ${coverage.missing.length} missing.\n`,
        );
        if (coverage.issues.length) {
            process.stdout.write("Coverage issues:\n");
            for (const issue of coverage.issues) process.stdout.write(`  ${issue}\n`);
        }

        const report = {
            version: 1,
            generatedAt: new Date().toISOString(),
            mode: "contract",
            adapters: {
                rust: relative(repositoryRoot, rustCli),
            },
            totals: {
                cases: selected.length,
                steps: selected.reduce((sum, testCase) => sum + (testCase.steps?.length ?? 0), 0),
                passed,
                failed: failures.length,
                capabilities: coverage.registry.size,
            },
            coverage: {
                registry: coverage.registry.size,
                byCorpus: coverage.byCorpus,
                byCitedTests: coverage.byTest,
                missing: coverage.missing,
                unregistered: coverage.unregisteredCorpus,
                issues: coverage.issues,
            },
            byFamily: summary.byFamily,
            byCapability: summary.byCapability,
            failures,
        };
        await writeReport(report);
        if (reportPath) process.stdout.write(`Report: ${relative(repositoryRoot, reportPath)}\n`);
        if (failures.length > 0 || coverage.issues.length > 0) process.exitCode = 1;
    } finally {
        if (!keepWorkspace) {
            await rm(temporaryRoot, { recursive: true, force: true });
        } else {
            process.stdout.write(`Parity workspace kept at ${temporaryRoot}\n`);
        }
    }
}

main().catch((error) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
