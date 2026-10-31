const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSOLUTE_PATH_PATTERN =
    /(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'<>|]*|(?<![A-Za-z0-9:])\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|]*/gu;

const TIMESTAMP_KEYS = new Set([
    "created_at_us",
    "updated_at_us",
    "deleted_at_us",
    "restored_at_us",
    "started_at_us",
    "ended_at_us",
    "reviewed_at_us",
    "generated_at_us",
    "checked_at_us",
    "discovered_at_us",
    "processing_updated_at_us",
    "capture_consent_at_us",
    "human_edited_at_us",
    "catalog_checked_at_us",
    "reviewed_at_us",
    "createdAt",
    "updatedAt",
]);

const VOLATILE_NUMBER_KEYS = new Set([
    "startup_us",
    "elapsed_us",
    "index_elapsed_us",
    "cpu_elapsed_us",
    "command_elapsed_us",
    "export_elapsed_us",
    "audio_enumeration_elapsed_us",
    "process_uptime_us",
    "process_cpu_time_us",
    "resident_memory_bytes",
    "peak_resident_memory_bytes",
    "available_memory_bytes",
    "total_memory_bytes",
    "catalog_age_seconds",
    "rss_bytes",
    "virtual_bytes",
    "system_process_uptime_us",
    "system_process_cpu_time_us",
    "system_resident_memory_bytes",
    "system_peak_resident_memory_bytes",
    "system_available_memory_bytes",
]);

const PATH_KEYS = new Set([
    "path",
    "output",
    "archive",
    "directory",
    "file",
    "source",
    "destination",
    "temporaryPath",
    "temporary_path",
    "ffmpeg",
]);

function isAbsolutePath(value) {
    return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || /^\//u.test(value);
}

function replaceAbsolutePaths(value) {
    ABSOLUTE_PATH_PATTERN.lastIndex = 0;
    return value.replace(ABSOLUTE_PATH_PATTERN, "<path>");
}

function normalizeAdapterLabel(value) {
    return value.replace(/\((?:TypeScript|Rust)\)/gu, "(<adapter>)");
}

function normalizeString(value, key) {
    if (PATH_KEYS.has(key) || isAbsolutePath(value)) return "<path>";
    let normalized = normalizeAdapterLabel(value);
    if (TIMESTAMP_KEYS.has(key) || key.endsWith("_at_us")) return "<timestamp>";
    if (VOLATILE_NUMBER_KEYS.has(key)) {
        return /^-?\d+$/u.test(normalized) ? "0" : normalized;
    }
    normalized = replaceAbsolutePaths(normalized);
    if (UUID_EXACT.test(normalized)) return "<uuid>";
    UUID_PATTERN.lastIndex = 0;
    if (UUID_PATTERN.test(normalized)) {
        UUID_PATTERN.lastIndex = 0;
        normalized = normalized.replace(UUID_PATTERN, "<uuid>");
    }
    UUID_PATTERN.lastIndex = 0;
    return normalized.replace(/\b\d{16,}\b/gu, "<timestamp>");
}

export function normalizeSemantic(value, key = "") {
    if (value === null) return null;
    if (Array.isArray(value)) return value.map((item) => normalizeSemantic(item, key));
    if (typeof value === "string") return normalizeString(value, key);
    if (typeof value === "number") {
        if (TIMESTAMP_KEYS.has(key) || key.endsWith("_at_us")) return 0;
        if (VOLATILE_NUMBER_KEYS.has(key)) return 0;
        return value;
    }
    if (typeof value === "boolean") return value;
    if (typeof value === "object") {
        const output = {};
        for (const [childKey, child] of Object.entries(value)) {
            output[childKey] = normalizeSemantic(child, childKey);
        }
        return output;
    }
    return value;
}

export function normalizeText(text, replacements = []) {
    let normalized = String(text ?? "").replace(/\r\n/gu, "\n");
    for (const replacement of [...replacements]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)) {
        normalized = normalized.split(replacement).join("<path>");
        normalized = normalized.split(replacement.replace(/\\/gu, "/")).join("<path>");
    }
    normalized = normalizeAdapterLabel(normalized);
    normalized = replaceAbsolutePaths(normalized);
    normalized = normalized.replace(UUID_PATTERN, "<uuid>");
    normalized = normalized.replace(/\b\d{16,}\b/gu, "<timestamp>");
    return normalized
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/u, ""))
        .join("\n")
        .replace(/^\n+|\n+$/gu, "");
}

function matchString(actual, expected, path) {
    if (expected === "<uuid>") {
        return typeof actual === "string" && UUID_EXACT.test(actual)
            ? []
            : [`${path}: expected a UUID, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<timestamp>") {
        return (typeof actual === "string" && /^\d+$/u.test(actual)) ||
            (typeof actual === "number" && Number.isFinite(actual))
            ? []
            : [`${path}: expected a timestamp, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<path>") {
        return typeof actual === "string" && actual.length > 0
            ? []
            : [`${path}: expected a path, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<number>") {
        return typeof actual === "number" && Number.isFinite(actual)
            ? []
            : [`${path}: expected a number, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<number-string>") {
        return typeof actual === "string" && /^-?\d+$/u.test(actual)
            ? []
            : [`${path}: expected a numeric string, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<string>" || expected === "<any-string>") {
        return typeof actual === "string"
            ? []
            : [`${path}: expected a string, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<boolean>") {
        return typeof actual === "boolean"
            ? []
            : [`${path}: expected a boolean, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<boolean-string>") {
        return actual === "true" || actual === "false"
            ? []
            : [`${path}: expected a boolean string, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<sha256>") {
        return typeof actual === "string" && /^[0-9a-f]{64}$/u.test(actual)
            ? []
            : [`${path}: expected a SHA-256 hex string, got ${JSON.stringify(actual)}`];
    }
    if (expected === "<json-string>") {
        if (typeof actual !== "string") return [`${path}: expected a JSON string`];
        try {
            JSON.parse(actual);
            return [];
        } catch {
            return [`${path}: expected a parseable JSON string`];
        }
    }
    return actual === expected
        ? []
        : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

export function matchShape(actual, expected, path = "$") {
    if (typeof expected === "string" && expected.startsWith("<") && expected.endsWith(">")) {
        return matchString(actual, expected, path);
    }
    if (expected === null) {
        return actual === null ? [] : [`${path}: expected null, got ${JSON.stringify(actual)}`];
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return [`${path}: expected an array`];
        if (actual.length !== expected.length) {
            return [`${path}: expected ${expected.length} items, got ${actual.length}`];
        }
        return expected.flatMap((item, index) =>
            matchShape(actual[index], item, `${path}[${index}]`),
        );
    }
    if (typeof expected === "object") {
        if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
            return [`${path}: expected an object`];
        }
        const issues = [];
        for (const key of Object.keys(expected)) {
            if (!(key in actual)) {
                issues.push(`${path}.${key}: missing`);
            } else {
                issues.push(...matchShape(actual[key], expected[key], `${path}.${key}`));
            }
        }
        for (const key of Object.keys(actual)) {
            if (!(key in expected)) issues.push(`${path}.${key}: unexpected field`);
        }
        return issues;
    }
    if (
        typeof expected === "number" ||
        typeof expected === "boolean" ||
        typeof expected === "string"
    ) {
        return actual === expected
            ? []
            : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    }
    return [`${path}: unsupported expected value ${JSON.stringify(expected)}`];
}

export function matchSubset(actual, expected, path = "$") {
    if (typeof expected === "string" && expected.startsWith("<") && expected.endsWith(">")) {
        return matchString(actual, expected, path);
    }
    if (expected === null) {
        return actual === null ? [] : [`${path}: expected null, got ${JSON.stringify(actual)}`];
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return [`${path}: expected an array`];
        if (actual.length !== expected.length) {
            return [`${path}: expected ${expected.length} items, got ${actual.length}`];
        }
        return expected.flatMap((item, index) =>
            matchSubset(actual[index], item, `${path}[${index}]`),
        );
    }
    if (typeof expected === "object") {
        if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
            return [`${path}: expected an object`];
        }
        const issues = [];
        for (const key of Object.keys(expected)) {
            if (!(key in actual)) issues.push(`${path}.${key}: missing`);
            else issues.push(...matchSubset(actual[key], expected[key], `${path}.${key}`));
        }
        return issues;
    }
    if (
        typeof expected === "number" ||
        typeof expected === "boolean" ||
        typeof expected === "string"
    ) {
        return actual === expected
            ? []
            : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    }
    return [`${path}: unsupported expected value ${JSON.stringify(expected)}`];
}

export function firstDifference(actual, expected, path = "$") {
    if (typeof actual !== typeof expected) {
        return [`${path}: type ${typeof actual} differs from ${typeof expected}`];
    }
    if (actual === null || expected === null || typeof actual !== "object") {
        return actual === expected
            ? []
            : [`${path}: ${JSON.stringify(actual)} differs from ${JSON.stringify(expected)}`];
    }
    if (Array.isArray(actual) !== Array.isArray(expected)) {
        return [`${path}: array/object shape differs`];
    }
    if (Array.isArray(actual)) {
        if (actual.length !== expected.length) {
            return [`${path}: length ${actual.length} differs from ${expected.length}`];
        }
        for (let index = 0; index < actual.length; index += 1) {
            const difference = firstDifference(actual[index], expected[index], `${path}[${index}]`);
            if (difference.length) return difference;
        }
        return [];
    }
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.join("\u0000") !== expectedKeys.join("\u0000")) {
        return [`${path}: fields ${actualKeys.join(",")} differ from ${expectedKeys.join(",")}`];
    }
    for (const key of actualKeys) {
        const difference = firstDifference(actual[key], expected[key], `${path}.${key}`);
        if (difference.length) return difference;
    }
    return [];
}

function splitPath(path) {
    return path
        .replace(/\[(\d+)\]/gu, ".$1")
        .split(".")
        .filter(Boolean);
}

function canonicalArrayKey(value) {
    return JSON.stringify(value);
}

function sortAtPath(value, parts) {
    if (parts.length === 0) {
        if (Array.isArray(value)) {
            return [...value].sort((left, right) =>
                canonicalArrayKey(left).localeCompare(canonicalArrayKey(right)),
            );
        }
        return value;
    }
    const [head, ...rest] = parts;
    if (Array.isArray(value)) {
        if (head === "*") return value.map((item) => sortAtPath(item, rest));
        const index = Number(head);
        if (!Number.isInteger(index) || index < 0 || index >= value.length) return value;
        const copy = [...value];
        copy[index] = sortAtPath(copy[index], rest);
        return copy;
    }
    if (value !== null && typeof value === "object" && head in value) {
        return { ...value, [head]: sortAtPath(value[head], rest) };
    }
    return value;
}

export function sortJsonPaths(value, paths = []) {
    return paths.reduce((current, path) => sortAtPath(current, splitPath(path)), value);
}
