import { newUuid, RecordType, type ArchiveRecord } from "./archive/format";
import { parseTranscriptTimestamp } from "./domain/transcript";

const field = (record: ArchiveRecord, key: string) => record.fields.get(key) ?? "";
const now = () => (BigInt(Date.now()) * 1000n).toString();
const ids = (value: string) =>
    value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

export function splitObservation(
    record: ArchiveRecord,
    offset: number,
    time: string,
): ArchiveRecord[] {
    const content = field(record, "content");
    if (!Number.isInteger(offset) || offset <= 0 || offset >= content.length)
        throw new Error("Choose a split position inside the observation.");
    if (/^[\uDC00-\uDFFF]$/u.test(content[offset]!))
        throw new Error("Choose a position between characters.");
    const start = BigInt(field(record, "start_time_us") || "0");
    const end = BigInt(field(record, "end_time_us") || "0");
    const at = time.trim() ? parseTranscriptTimestamp(time) : start;
    if (at < start || at > end || (start !== end && (at === start || at === end)))
        throw new Error("Choose a split time strictly inside the observation range.");
    const stamp = now();
    const first = new Map(record.fields);
    const second = new Map(record.fields);
    first.set("content", content.slice(0, offset));
    first.set("end_time_us", at.toString());
    first.set("updated_at_us", stamp);
    second.set("content", content.slice(offset));
    second.set("start_time_us", at.toString());
    second.set("created_at_us", stamp);
    second.set("updated_at_us", stamp);
    return [
        { ...record, fields: first },
        { ...record, id: newUuid(), revision: 0n, previousOffset: 0n, fields: second },
    ];
}

export function mergeObservations(records: readonly ArchiveRecord[]): ArchiveRecord[] {
    if (records.length < 2) throw new Error("Select at least two observations to merge.");
    const first = records[0]!;
    const seen = new Set<string>();
    let previous = -1n;
    let latestEnd = 0n;
    const mergedIds = new Map<string, Set<string>>([
        ["linked_asset_ids", new Set()],
        ["linked_evidence_ids", new Set()],
        ["source_segment_ids", new Set()],
    ]);
    const titles = new Set<string>();
    for (const record of records) {
        if (
            record.type !== RecordType.annotation ||
            field(record, "_deleted") === "true" ||
            seen.has(record.id.toLowerCase())
        )
            throw new Error("Select distinct active observations.");
        seen.add(record.id.toLowerCase());
        if (
            field(record, "session_id") !== field(first, "session_id") ||
            field(record, "type") !== field(first, "type") ||
            field(record, "priority") !== field(first, "priority")
        )
            throw new Error(
                "Observations must belong to the same session and have the same type and priority.",
            );
        const start = BigInt(field(record, "start_time_us") || "0");
        if (start < previous) throw new Error("Observations must be in chronological order.");
        previous = start;
        const end = BigInt(field(record, "end_time_us") || "0");
        if (end > latestEnd) latestEnd = end;
        if (field(record, "title")) titles.add(field(record, "title"));
        for (const [key, values] of mergedIds)
            for (const id of ids(field(record, key))) values.add(id);
    }
    const stamp = now();
    const merged = new Map(first.fields);
    merged.set("content", records.map((record) => field(record, "content")).join("\n"));
    merged.set("end_time_us", latestEnd.toString());
    merged.set("merged_titles", [...titles].join("\n"));
    merged.set("source_annotation_ids", records.map((record) => record.id).join(","));
    merged.set("updated_at_us", stamp);
    for (const [key, values] of mergedIds) merged.set(key, [...values].join(","));
    return [
        { ...first, fields: merged },
        ...records.slice(1).map((record) => {
            const fields = new Map(record.fields);
            fields.set("_deleted", "true");
            fields.set("updated_at_us", stamp);
            return { ...record, fields };
        }),
    ];
}

export function setObservationLink(
    record: ArchiveRecord,
    target: ArchiveRecord,
    linked: boolean,
): ArchiveRecord {
    if (
        record.type !== RecordType.annotation ||
        (target.type !== RecordType.assetMetadata && target.type !== RecordType.evidenceNode)
    )
        throw new Error("Choose an asset or evidence record.");
    if (
        field(target, "session_id") &&
        field(target, "session_id").toLowerCase() !== field(record, "session_id").toLowerCase()
    )
        throw new Error("The linked record belongs to another session.");
    const key =
        target.type === RecordType.assetMetadata ? "linked_asset_ids" : "linked_evidence_ids";
    const values = ids(field(record, key)).filter(
        (id) => id.toLowerCase() !== target.id.toLowerCase(),
    );
    if (linked) values.push(target.id);
    const fields = new Map(record.fields);
    fields.set(key, values.join(","));
    fields.set("updated_at_us", now());
    return { ...record, fields };
}
