const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    "startup_us",
    "elapsed_us",
    "index_elapsed_us",
    "cpu_elapsed_us",
    "rss_bytes",
    "virtual_bytes",
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
]);

function isAbsolutePath(value) {
    return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith("/");
}

function normalizeString(value, key) {
    if (PATH_KEYS.has(key) || isAbsolutePath(value)) return "<path>";
    if (TIMESTAMP_KEYS.has(key) || key.endsWith("_at_us")) return "<timestamp>";
    if (UUID_EXACT.test(value)) return "<uuid>";
    if (UUID_PATTERN.test(value)) {
        UUID_PATTERN.lastIndex = 0;
        return value.replace(UUID_PATTERN, "<uuid>");
    }
    UUID_PATTERN.lastIndex = 0;
    return value;
}

export function normalizeSemantic(value, key = "") {
    if (value === null) return null;
    if (Array.isArray(value)) return value.map((item) => normalizeSemantic(item, key));
    if (typeof value === "string") return normalizeString(value, key);
    if (typeof value === "number") {
        return TIMESTAMP_KEYS.has(key) || key.endsWith("_at_us") ? 0 : value;
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
