import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openArchiveBytes, verifyArchiveSnapshot } from "../../frontend/archive/archive";
import { recordTypeName, type ArchiveRecord } from "../../frontend/archive/format";

const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

type NormalizedRecord = {
    type: string;
    id: string;
    revision: string;
    fields: Record<string, string>;
    blob_sha256: string;
    blob_bytes: number;
};

function hashBlob(blob: Uint8Array): string {
    return createHash("sha256").update(blob).digest("hex");
}

function isAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

function normalizeFieldValue(key: string, value: string, ids: Map<string, string>): string {
    if (isAbsolutePath(value)) return "<path>";
    if (key === "path" || key === "output" || key === "source_path" || key === "file_path") {
        return "<path>";
    }
    if (key.endsWith("_at_us") || key === "generated_at_us") return "<timestamp>";
    return value.replace(UUID_GLOBAL, (uuid) => ids.get(uuid.toLowerCase()) ?? "<uuid>");
}

function signature(record: ArchiveRecord): string {
    const fields = [...record.fields.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${normalizeFieldValue(key, value, new Map())}`)
        .join("\u0000");
    return `${recordTypeName(record.type)}|${record.revision}|${hashBlob(record.blob)}|${fields}`;
}

async function loadArchive(path: string) {
    const bytes = new Uint8Array(await readFile(path));
    const snapshot = await openArchiveBytes(bytes);
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
    return { snapshot, verification, records };
}

function normalizedArchive(
    path: string,
    snapshot: Awaited<ReturnType<typeof loadArchive>>["snapshot"],
    records: ArchiveRecord[],
    verification: unknown,
) {
    const ordered = records
        .map((record, index) => ({ record, index, signature: signature(record) }))
        .sort((left, right) => {
            if (left.signature === right.signature) return left.index - right.index;
            return left.signature < right.signature ? -1 : 1;
        });
    const ids = new Map<string, string>();
    ordered.forEach(({ record }, index) => {
        ids.set(record.id.toLowerCase(), `record:${index}`);
    });
    const normalizedRecords: NormalizedRecord[] = ordered.map(({ record }) => {
        const fields: Record<string, string> = {};
        for (const [key, value] of [...record.fields.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
        )) {
            fields[key] = normalizeFieldValue(key, value, ids);
        }
        return {
            type: recordTypeName(record.type),
            id: ids.get(record.id.toLowerCase()) ?? "<uuid>",
            revision: record.revision.toString(),
            fields,
            blob_sha256: hashBlob(record.blob),
            blob_bytes: record.blob.byteLength,
        };
    });
    const indexKeys = [...snapshot.allIndexEntries().keys()]
        .map((key) => key.replace(UUID_GLOBAL, (uuid) => ids.get(uuid.toLowerCase()) ?? "<uuid>"))
        .sort();
    return { path, verification, records: normalizedRecords, indexKeys };
}

async function main() {
    const [leftPath, rightPath] = process.argv.slice(2);
    if (!leftPath || !rightPath) {
        throw new Error("usage: compare-archive.ts <left.tux> <right.tux>");
    }
    const left = await loadArchive(leftPath);
    const right = await loadArchive(rightPath);
    const normalizedLeft = normalizedArchive(
        leftPath,
        left.snapshot,
        left.records,
        left.verification,
    );
    const normalizedRight = normalizedArchive(
        rightPath,
        right.snapshot,
        right.records,
        right.verification,
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
    const count = Math.max(normalizedLeft.records.length, normalizedRight.records.length);
    for (let index = 0; index < count; index += 1) {
        const leftRecord = normalizedLeft.records[index];
        const rightRecord = normalizedRight.records[index];
        if (!leftRecord || !rightRecord) {
            issues.push(`record ${index}: ${leftRecord ? "missing on right" : "missing on left"}`);
            continue;
        }
        if (JSON.stringify(leftRecord) !== JSON.stringify(rightRecord)) {
            issues.push(
                `record ${index} differs: ${JSON.stringify(leftRecord)} != ${JSON.stringify(rightRecord)}`,
            );
        }
    }
    if (normalizedLeft.indexKeys.join("\n") !== normalizedRight.indexKeys.join("\n")) {
        issues.push("index entries differ");
    }

    const result = {
        ok: issues.length === 0,
        left: normalizedLeft.path,
        right: normalizedRight.path,
        records: normalizedLeft.records.length,
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
