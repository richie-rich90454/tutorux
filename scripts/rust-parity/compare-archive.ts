import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openArchiveBytes, verifyArchiveSnapshot } from "../../frontend/archive/archive";
import { recordTypeName, type ArchiveRecord } from "../../frontend/archive/format";

const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

type NormalizedRecord = {
    type: string;
    revision: string;
    fields: Record<string, string>;
    blob_sha256: string;
    blob_bytes: number;
};

type ArchiveModel = {
    path: string;
    verification: unknown;
    records: NormalizedRecord[];
    history: Array<{ record: string; revisions: string[] }> | null;
    indexKeys: string[];
};

function hashBlob(blob: Uint8Array, recordType = ""): string {
    if (recordType === "ai-job" && blob.byteLength > 0) {
        try {
            const parsed = JSON.parse(new TextDecoder().decode(blob));
            const normalized = JSON.stringify(normalizePackageBlob(parsed));
            return createHash("sha256").update(normalized).digest("hex");
        } catch {
            // Fall through to the raw byte hash for non-JSON blobs.
        }
    }
    return createHash("sha256").update(blob).digest("hex");
}

function normalizePackageBlob(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalizePackageBlob);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, normalizePackageBlob(child)]),
        );
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) >= 10 ** 15) {
        return "<timestamp>";
    }
    if (typeof value === "string") {
        return value.replace(/\b\d{16,}\b/gu, "<timestamp>");
    }
    return value;
}

function isAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

function normalizeFieldValue(key: string, value: string, typesById: Map<string, string>): string {
    if (isAbsolutePath(value)) return "<path>";
    if (key === "path" || key === "output" || key === "source_path" || key === "file_path") {
        return "<path>";
    }
    if (key.endsWith("_at_us") || key === "generated_at_us") return "<timestamp>";
    if (key.endsWith("_hash") || key === "content_hash") return "<hash>";
    const normalized = value
        .replace(UUID_GLOBAL, (uuid) => {
            const type = typesById.get(uuid.toLowerCase());
            return type ? `<ref:${type}>` : "<uuid>";
        })
        .replace(/\b\d{16,}\b/gu, "<timestamp>");
    if (key === "source_index_history" || key.endsWith("_ids") || key === "chunk_ids") {
        return normalized
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .sort()
            .join(",");
    }
    return normalized;
}

function normalizedFields(
    record: ArchiveRecord,
    typesById: Map<string, string>,
): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [key, value] of [...record.fields.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
    )) {
        fields[key] = normalizeFieldValue(key, value, typesById);
    }
    return fields;
}

function normalizedRecord(
    record: ArchiveRecord,
    typesById: Map<string, string>,
): NormalizedRecord {
    return {
        type: recordTypeName(record.type),
        revision: record.revision.toString(),
        fields: normalizedFields(record, typesById),
        blob_sha256: hashBlob(record.blob, recordTypeName(record.type)),
        blob_bytes: record.blob.byteLength,
    };
}

function recordSignature(record: NormalizedRecord): string {
    return JSON.stringify(record);
}

async function loadArchive(path: string, passphrase: string | undefined, includeHistory: boolean) {
    const bytes = new Uint8Array(await readFile(path));
    let snapshot = await openArchiveBytes(bytes);
    if (snapshot.locked) {
        if (!passphrase) {
            throw new Error(
                `archive ${path} is encrypted; set TUTORUX_PARITY_ARCHIVE_PASSPHRASE`,
            );
        }
        snapshot = await snapshot.unlock(passphrase);
    }
    const verification = await verifyArchiveSnapshot(snapshot);
    const records: ArchiveRecord[] = [];
    for (const key of snapshot.allIndexEntries().keys()) {
        const separator = key.indexOf(":");
        if (separator < 1 || key.indexOf(":", separator + 1) !== -1) continue;
        const id = key.slice(separator + 1);
        if (!UUID_EXACT.test(id)) continue;
        const record = await snapshot.getRecordByIndexKey(key);
        if (record) records.push(record);
    }
    const typesById = new Map(
        records.map((record) => [
            record.id.toLowerCase(),
            recordTypeName(record.type),
        ]),
    );
    const normalized = records.map((record) => normalizedRecord(record, typesById));
    let history: Array<{ record: string; revisions: string[] }> | null = null;
    if (includeHistory) {
        history = [];
        for (const record of records) {
            const revisions = await snapshot.getRecordHistory(record.type, record.id);
            history.push({
                record: recordSignature(normalizedRecord(record, typesById)),
                revisions: revisions
                    .map((revision) => recordSignature(normalizedRecord(revision, typesById)))
                    .sort(),
            });
        }
        history.sort((left, right) => {
            if (left.record !== right.record) return left.record < right.record ? -1 : 1;
            const leftRevisions = left.revisions.join("\u0000");
            const rightRevisions = right.revisions.join("\u0000");
            return leftRevisions < rightRevisions ? -1 : leftRevisions > rightRevisions ? 1 : 0;
        });
    }
    return { snapshot, verification, records: normalized, history };
}

function normalizedArchive(
    path: string,
    snapshot: Awaited<ReturnType<typeof loadArchive>>["snapshot"],
    records: NormalizedRecord[],
    verification: unknown,
    history: ArchiveModel["history"],
): ArchiveModel {
    const sortedRecords = [...records].sort((left, right) => {
        const leftSignature = recordSignature(left);
        const rightSignature = recordSignature(right);
        return leftSignature < rightSignature ? -1 : leftSignature > rightSignature ? 1 : 0;
    });
    const indexKeys = [...snapshot.allIndexEntries().keys()]
        .map((key) => key.replace(UUID_GLOBAL, "<uuid>"))
        .sort();
    return { path, verification, records: sortedRecords, history, indexKeys };
}

function multiset(values: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
}

function compareMultisets(label: string, left: string[], right: string[]): string[] {
    const issues: string[] = [];
    const leftCounts = multiset(left);
    const rightCounts = multiset(right);
    const keys = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
    const missingOnRight: string[] = [];
    const missingOnLeft: string[] = [];
    for (const key of keys) {
        const leftCount = leftCounts.get(key) ?? 0;
        const rightCount = rightCounts.get(key) ?? 0;
        if (leftCount === rightCount) continue;
        const detail = key.length > 600 ? `${key.slice(0, 600)}…` : key;
        if (leftCount > rightCount) {
            missingOnRight.push(`x${leftCount - rightCount} ${detail}`);
        } else {
            missingOnLeft.push(`x${rightCount - leftCount} ${detail}`);
        }
    }
    if (missingOnRight.length) {
        issues.push(
            `${label} entries only on the TypeScript side: ${missingOnRight.slice(0, 3).join(" | ")}`,
        );
    }
    if (missingOnLeft.length) {
        issues.push(
            `${label} entries only on the Rust side: ${missingOnLeft.slice(0, 3).join(" | ")}`,
        );
    }
    return issues;
}

async function main() {
    const includeHistory = process.argv.includes("--history");
    const [leftPath, rightPath] = process.argv.slice(2).filter((value) => value !== "--history");
    if (!leftPath || !rightPath) {
        throw new Error("usage: compare-archive.ts <left.tux> <right.tux> [--history]");
    }
    const passphrase = process.env["TUTORUX_PARITY_ARCHIVE_PASSPHRASE"];
    const left = await loadArchive(leftPath, passphrase, includeHistory);
    const right = await loadArchive(rightPath, passphrase, includeHistory);
    const normalizedLeft = normalizedArchive(
        leftPath,
        left.snapshot,
        left.records,
        left.verification,
        left.history,
    );
    const normalizedRight = normalizedArchive(
        rightPath,
        right.snapshot,
        right.records,
        right.verification,
        right.history,
    );
    const issues: string[] = [];

    if (
        JSON.stringify(normalizedLeft.verification) !== JSON.stringify(normalizedRight.verification)
    ) {
        issues.push(
            `verification differs: ${JSON.stringify(normalizedLeft.verification)} != ${JSON.stringify(normalizedRight.verification)}`,
        );
    }
    if (normalizedLeft.records.length !== normalizedRight.records.length) {
        issues.push(
            `record count differs: ${normalizedLeft.records.length} != ${normalizedRight.records.length}`,
        );
    }
    issues.push(
        ...compareMultisets(
            "record",
            normalizedLeft.records.map((record) => JSON.stringify(record)),
            normalizedRight.records.map((record) => JSON.stringify(record)),
        ),
    );
    if (includeHistory) {
        issues.push(
            ...compareMultisets(
                "record history",
                (normalizedLeft.history ?? []).map((row) => JSON.stringify(row)),
                (normalizedRight.history ?? []).map((row) => JSON.stringify(row)),
            ),
        );
    }
    if (normalizedLeft.indexKeys.join("\n") !== normalizedRight.indexKeys.join("\n")) {
        issues.push(
            ...compareMultisets("index key", normalizedLeft.indexKeys, normalizedRight.indexKeys),
        );
    }

    const result = {
        ok: issues.length === 0,
        left: normalizedLeft.path,
        right: normalizedRight.path,
        records: normalizedLeft.records.length,
        historicalRevisions: includeHistory
            ? (normalizedLeft.history?.reduce((sum, row) => sum + row.revisions.length, 0) ?? 0)
            : null,
        verification: normalizedLeft.verification,
        issues,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (issues.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
    process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
});
