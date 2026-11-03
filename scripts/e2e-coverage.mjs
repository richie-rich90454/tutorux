import { createCoverageMap } from "@vitest/istanbul-lib-coverage";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(".");
const rawDirectory = resolve("coverage-e2e/raw");
const map = createCoverageMap({});

if (existsSync(rawDirectory)) {
    for (const name of readdirSync(rawDirectory)) {
        if (!name.endsWith(".json")) continue;
        map.merge(JSON.parse(readFileSync(join(rawDirectory, name), "utf8")));
    }
}

const normalize = (file) => {
    const absolute = resolve(root, file).split(sep).join("/");
    return relative(root, absolute).split(sep).join("/");
};

const normalized = createCoverageMap({});
for (const file of map.files()) {
    if (!file.includes(`${sep}frontend${sep}`)) continue;
    const target = normalize(file);
    const data = map.fileCoverageFor(file).data;
    normalized.merge(
        createCoverageMap({
            [target]: { ...data, path: target },
        }),
    );
}

const files = normalized.files().filter((file) => file.startsWith("frontend/"));
mkdirSync("coverage-e2e", { recursive: true });
writeFileSync("coverage-e2e/coverage-final.json", JSON.stringify(normalized.toJSON(), null, 2));

const summary = normalized.getCoverageSummary();
const percent = (value) => `${Number(value.pct).toFixed(2)}%`;
console.log(`E2E files with coverage: ${files.length}`);
console.log(
    `E2E coverage: statements ${percent(summary.statements)} branches ${percent(summary.branches)} functions ${percent(summary.functions)} lines ${percent(summary.lines)}`,
);

const uncovered = [];
const pct = (value) => Number(value.pct);
for (const file of files) {
    const coverage = normalized.fileCoverageFor(file);
    const fileSummary = coverage.toSummary();
    if (
        pct(fileSummary.statements) === 100 &&
        pct(fileSummary.branches) === 100 &&
        pct(fileSummary.functions) === 100 &&
        pct(fileSummary.lines) === 100
    ) {
        continue;
    }
    const data = coverage.data;
    const missedLines = Object.entries(data.statementMap)
        .filter(([id, location]) => data.s[id] === 0 && location)
        .map(([, location]) => location.start.line);
    uncovered.push({
        file,
        statements: pct(fileSummary.statements),
        branches: pct(fileSummary.branches),
        functions: pct(fileSummary.functions),
        lines: pct(fileSummary.lines),
        missedLines: [...new Set(missedLines)].slice(0, 40),
    });
}

uncovered.sort((left, right) => left.lines - right.lines);
for (const file of uncovered.slice(0, 60)) {
    console.log(
        `${file.lines.toFixed(1).padStart(6)}% lines ${file.branches.toFixed(1).padStart(6)}% branches ${file.functions.toFixed(1).padStart(6)}% funcs  ${file.file}`,
    );
    if (process.env["E2E_COVERAGE_DETAIL"]) {
        console.log(`        missed lines: ${file.missedLines.join(", ")}`);
    }
}
console.log(`Files below 100%: ${uncovered.length}`);

// E2E coverage ratchet. Raise these floors whenever the suite earns more real coverage;
// never lower them. Desktop-only and hardware paths are covered by the Rust and unit suites.
const thresholds = { statements: 48, branches: 34, functions: 58, lines: 48 };
if (process.argv.includes("--check")) {
    let failed = files.length === 0;
    if (files.length === 0) console.error("No E2E coverage was collected.");
    for (const [metric, minimum] of Object.entries(thresholds)) {
        const actual = Number(summary[metric].pct);
        if (!Number.isFinite(actual) || actual < minimum) {
            console.error(
                `E2E ${metric} coverage ${Number.isFinite(actual) ? actual.toFixed(2) : "unknown"}% is below the ${minimum}% floor.`,
            );
            failed = true;
        }
    }
    if (failed) process.exitCode = 1;
}
