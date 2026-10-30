import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_CUE_BYTES = 16 * 1024 * 1024;
const utf8 = new TextEncoder();

export type TranscriptSourceFormat = "text" | "srt" | "vtt";
export type TranscriptExportFormat = TranscriptSourceFormat | "json";

export interface TranscriptCue {
    text: string;
    startTimeUs?: bigint;
    endTimeUs?: bigint;
    sourceIndex: number;
    sourceId: string;
}

export function resolveTranscriptFormat(format: string, filename = ""): TranscriptSourceFormat {
    if (format === "auto") {
        const extension = filename.toLocaleLowerCase().split(".").at(-1);
        return extension === "srt" ? "srt" : extension === "vtt" ? "vtt" : "text";
    }
    if (format === "text" || format === "srt" || format === "vtt") return format;
    throw new Error("Transcript format must be text, srt, vtt, or auto.");
}

/** Parse plain text, SubRip, or WebVTT into the same cues used by the legacy importer. */
export function parseTranscriptSource(
    source: string,
    format: TranscriptSourceFormat,
): TranscriptCue[] {
    validateSource(source);
    const lines = source
        .split("\n")
        .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (lines[0]?.startsWith("\uFEFF")) lines[0] = lines[0].slice(1);
    return format === "text" ? parseTextLines(lines) : parseSubtitleLines(lines, format);
}

function parseTextLines(lines: string[]): TranscriptCue[] {
    const cues: TranscriptCue[] = [];
    for (const [lineIndex, line] of lines.entries()) {
        if (!line) continue;
        validateCueText(line);
        cues.push({ text: line, sourceIndex: cues.length, sourceId: String(lineIndex + 1) });
    }
    return cues;
}

function parseSubtitleLines(lines: string[], format: "srt" | "vtt"): TranscriptCue[] {
    let cursor = 0;
    if (format === "vtt") {
        const header = lines[0] ?? "";
        if (
            header !== "WEBVTT" &&
            !header.startsWith("WEBVTT ") &&
            !header.startsWith("WEBVTT\t")
        ) {
            throw new Error("WebVTT source must begin with a valid WEBVTT header.");
        }
        cursor = 1;
        while (cursor < lines.length && lines[cursor]!.trim() !== "") cursor += 1;
        if (cursor >= lines.length)
            throw new Error("WebVTT header metadata must end with a blank line.");
        cursor += 1;
    }

    const cues: TranscriptCue[] = [];
    let block: string[] = [];
    let cueBytes = 0;
    const flush = (): void => {
        if (block.length === 0) return;
        if (format === "vtt" && isVttMetadataBlock(block)) {
            block = [];
            cueBytes = 0;
            return;
        }
        const timingIndex = block.findIndex((line) => line.includes("-->"));
        if (timingIndex < 0 || timingIndex > 1) {
            throw new Error(
                "Subtitle cue must have an optional identifier followed by a timestamp.",
            );
        }
        const range = parseSubtitleTimeRange(block[timingIndex]!);
        const textLines = block.slice(timingIndex + 1);
        if (textLines.length === 0) throw new Error("Subtitle cue contains no text.");
        const text = textLines.join("\n");
        validateCueText(text);
        const sourceId = timingIndex === 1 ? block[0]! : "";
        validateCueText(sourceId);
        cues.push({
            text,
            startTimeUs: range[0],
            endTimeUs: range[1],
            sourceIndex: cues.length,
            sourceId,
        });
        block = [];
        cueBytes = 0;
    };

    for (; cursor < lines.length; cursor += 1) {
        const line = lines[cursor]!;
        if (line.trim() === "") {
            flush();
            continue;
        }
        const nextBytes = utf8.encode(line).byteLength + (block.length === 0 ? 0 : 1);
        if (nextBytes > MAX_CUE_BYTES - cueBytes) throw new Error("Subtitle cue exceeds 16 MiB.");
        cueBytes += nextBytes;
        block.push(line);
    }
    flush();
    return cues;
}

function isVttMetadataBlock(lines: string[]): boolean {
    if (lines.some((line) => line.includes("-->"))) return false;
    const first = lines[0] ?? "";
    return (
        first === "NOTE" ||
        first.startsWith("NOTE ") ||
        first.startsWith("NOTE\t") ||
        first === "STYLE" ||
        first === "REGION"
    );
}

function parseSubtitleTimeRange(line: string): [bigint, bigint] {
    const separator = line.indexOf("-->");
    if (separator < 0 || line.indexOf("-->", separator + 3) >= 0) {
        throw new Error("Subtitle cue must contain exactly one '-->' timestamp separator.");
    }
    const startText = line.slice(0, separator).trim();
    let endText = line.slice(separator + 3).trim();
    endText = endText.split(/[\t ]/u, 1)[0] ?? "";
    const start = parseSubtitleTimestamp(startText);
    const end = parseSubtitleTimestamp(endText);
    if (end < start)
        throw new Error("Subtitle cue timestamps are invalid or end before they start.");
    return [start, end];
}

function parseSubtitleTimestamp(value: string): bigint {
    let normalized = value.replace(",", ".");
    if ((normalized.match(/:/gu) ?? []).length === 1) normalized = `00:${normalized}`;
    const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,6}))?$/u.exec(normalized);
    if (!match) throw new Error("Subtitle cue timestamps are invalid or end before they start.");
    const hours = BigInt(match[1]!);
    const minutes = BigInt(match[2]!);
    const seconds = BigInt(match[3]!);
    if (minutes > 59n || seconds > 59n)
        throw new Error("Subtitle cue timestamps are invalid or end before they start.");
    const fraction = (match[4] ?? "").padEnd(6, "0");
    const micros = fraction ? BigInt(fraction) : 0n;
    const result = hours * 3_600_000_000n + minutes * 60_000_000n + seconds * 1_000_000n + micros;
    if (result > 9_223_372_036_854_775_807n)
        throw new Error("Subtitle cue timestamp exceeds the supported range.");
    return result;
}

export function parseTranscriptTimestamp(value: string): bigint {
    const normalized = value.trim().replace(",", ".");
    if (!normalized.includes(":")) {
        if (!/^\d+$/u.test(normalized)) throw new Error("Use HH:MM:SS[.ffffff] or whole seconds.");
        const seconds = BigInt(normalized);
        if (seconds > 9_223_372_036_854n) throw new Error("Timestamp exceeds the supported range.");
        return seconds * 1_000_000n;
    }
    const converted =
        (normalized.match(/:/gu) ?? []).length === 1 ? `00:${normalized}` : normalized;
    return parseSubtitleTimestamp(converted);
}

function validateSource(source: string): void {
    if (hasUnpairedSurrogate(source))
        throw new Error("Transcript text must contain valid Unicode.");
    if (utf8.encode(source).byteLength > MAX_SOURCE_BYTES) {
        throw new Error("Transcript source exceeds the configured 256 MiB limit.");
    }
}

function validateCueText(value: string): void {
    if (hasUnpairedSurrogate(value)) throw new Error("Transcript text must contain valid Unicode.");
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a)) {
            throw new Error("Transcript text contains unsupported control characters.");
        }
    }
    if (utf8.encode(value).byteLength > MAX_CUE_BYTES) {
        throw new Error("Transcript cue exceeds 16 MiB.");
    }
}

function hasUnpairedSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            if (index + 1 >= value.length) return true;
            const next = value.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff) return true;
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) return true;
    }
    return false;
}

export function makeTranscriptRecords(
    sessionId: string,
    cues: readonly TranscriptCue[],
    format: TranscriptSourceFormat,
    filename: string,
    importedAtUs = (BigInt(Date.now()) * 1000n).toString(),
): ArchiveRecord[] {
    const importId = newUuid();
    return cues.map((cue) => {
        const hasTimestamp = cue.startTimeUs !== undefined && cue.endTimeUs !== undefined;
        return {
            type: RecordType.transcriptSegment,
            id: newUuid(),
            revision: 0n,
            previousOffset: 0n,
            blob: new Uint8Array(),
            fields: new Map([
                ["session_id", sessionId],
                ["start_time_us", hasTimestamp ? cue.startTimeUs!.toString() : "0"],
                ["end_time_us", hasTimestamp ? cue.endTimeUs!.toString() : "0"],
                ["text", cue.text],
                ["verification_state", "provisional"],
                ["timestamp_state", hasTimestamp ? "timestamped" : "not-timestamped"],
                ["source_import_id", importId],
                ["source_imported_at_us", importedAtUs],
                ["source_index", String(cue.sourceIndex)],
                ["origin", "manual-transcript-import"],
                ["source_format", format],
                ["source_filename", filename],
                ["created_at_us", String((BigInt(Date.now()) * 1000n).toString())],
                ...(cue.sourceId
                    ? [
                          [format === "text" ? "source_line" : "source_cue_id", cue.sourceId] as [
                              string,
                              string,
                          ],
                      ]
                    : []),
            ]),
        };
    });
}

export function correctTranscriptRecord(record: ArchiveRecord, text: string): ArchiveRecord {
    ensureTranscriptRecord(record);
    validateCueText(text);
    const fields = new Map(record.fields);
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    fields.set("text", text);
    fields.set("verification_state", "human-corrected");
    fields.set("updated_at_us", timestamp);
    fields.set("human_edited_at_us", timestamp);
    return { ...record, fields };
}

export function setTranscriptVerification(
    record: ArchiveRecord,
    state: "human-verified" | "provisional" | "needs-review",
): ArchiveRecord {
    ensureTranscriptRecord(record);
    const fields = new Map(record.fields);
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    fields.set("verification_state", state);
    fields.set("verified_at_us", timestamp);
    fields.set("updated_at_us", timestamp);
    fields.set("human_edited_at_us", timestamp);
    return { ...record, fields };
}

export function setTranscriptTimestamp(
    record: ArchiveRecord,
    start: string,
    end: string,
): ArchiveRecord {
    ensureTranscriptRecord(record);
    const startTimeUs = parseTranscriptTimestamp(start);
    const endTimeUs = parseTranscriptTimestamp(end);
    if (endTimeUs < startTimeUs) throw new Error("Transcript end time precedes its start time.");
    const fields = new Map(record.fields);
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    fields.set("start_time_us", startTimeUs.toString());
    fields.set("end_time_us", endTimeUs.toString());
    fields.set("timestamp_state", "timestamped");
    fields.set("updated_at_us", timestamp);
    fields.set("human_edited_at_us", timestamp);
    return { ...record, fields };
}

export function setTranscriptSpeaker(record: ArchiveRecord, label: string | null): ArchiveRecord {
    ensureTranscriptRecord(record);
    const fields = new Map(record.fields);
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const trimmed = label?.trim() ?? "";
    fields.set("speaker_label", trimmed || "Unknown speaker");
    fields.set("speaker_assignment_state", trimmed ? "tutor-labeled" : "unknown");
    fields.set("speaker_identity_verified", "false");
    fields.set("updated_at_us", timestamp);
    fields.set("human_edited_at_us", timestamp);
    return { ...record, fields };
}

/** Split one cue without changing any words, speaker, provenance, or asset links. */
export function splitTranscriptRecord(
    record: ArchiveRecord,
    beforeText: string,
    afterText: string,
    splitAt?: string,
): [ArchiveRecord, ArchiveRecord] {
    ensureTranscriptRecord(record);
    const originalText = field(record, "text");
    validateCueText(beforeText);
    validateCueText(afterText);
    if (!beforeText || !afterText || beforeText + afterText !== originalText) {
        throw new Error("The before and after text must exactly preserve the original cue.");
    }

    const fields = new Map(record.fields);
    const secondFields = new Map(record.fields);
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    fields.set("text", beforeText);
    fields.set("updated_at_us", timestamp);
    fields.set("human_edited_at_us", timestamp);
    secondFields.set("text", afterText);
    secondFields.set("created_at_us", timestamp);
    secondFields.set("updated_at_us", timestamp);
    secondFields.set("human_edited_at_us", timestamp);

    if (field(record, "timestamp_state") !== "not-timestamped") {
        if (splitAt === undefined) {
            throw new Error("Choose a split time for this timestamped cue.");
        }
        const splitTimeUs = parseTranscriptTimestamp(splitAt);
        const startTimeUs = integerField(record, "start_time_us", -1n);
        const endTimeUs = integerField(record, "end_time_us", -1n);
        if (startTimeUs < 0n || splitTimeUs <= startTimeUs || splitTimeUs >= endTimeUs) {
            throw new Error("The split time must fall strictly inside the cue's timestamp range.");
        }
        fields.set("end_time_us", splitTimeUs.toString());
        secondFields.set("start_time_us", splitTimeUs.toString());
    }

    return [
        { ...record, fields },
        {
            ...record,
            id: newUuid(),
            revision: 0n,
            previousOffset: 0n,
            fields: secondFields,
        },
    ];
}

/** Merge cues in the supplied chronological order and soft-delete the absorbed cues. */
export function mergeTranscriptRecords(
    records: readonly ArchiveRecord[],
    separator = " ",
): ArchiveRecord[] {
    if (records.length < 2) throw new Error("Select at least two transcript cues to merge.");
    validateCueText(separator);
    const first = records[0]!;
    ensureTranscriptRecord(first);
    const sessionId = field(first, "session_id");
    const speaker = field(first, "speaker_label");
    const isTimestamped = field(first, "timestamp_state") !== "not-timestamped";
    const seenIds = new Set<string>();
    let previousStart = integerField(first, "start_time_us", 0n);
    const assetIds = new Set<string>();
    const mergedText: string[] = [];

    for (const [index, record] of records.entries()) {
        ensureTranscriptRecord(record);
        if (record.fields.get("_deleted") === "true") {
            throw new Error("Restore a transcript cue before merging it.");
        }
        if (seenIds.has(record.id.toLowerCase())) {
            throw new Error("A transcript cue can only appear once in a merge.");
        }
        seenIds.add(record.id.toLowerCase());
        if (field(record, "session_id") !== sessionId) {
            throw new Error("All transcript cues must belong to the same session.");
        }
        if (field(record, "speaker_label") !== speaker) {
            throw new Error("Cues with different speaker labels cannot be merged.");
        }
        if ((field(record, "timestamp_state") !== "not-timestamped") !== isTimestamped) {
            throw new Error("Timestamped and untimestamped cues cannot be merged together.");
        }
        if (index > 0 && isTimestamped) {
            const start = integerField(record, "start_time_us", 0n);
            if (start < previousStart) {
                throw new Error("Provide timestamped cues in chronological order.");
            }
            previousStart = start;
        }
        mergedText.push(field(record, "text"));
        for (const id of field(record, "linked_asset_ids").split(",")) {
            const normalized = id.trim();
            if (normalized) assetIds.add(normalized);
        }
    }

    const text = mergedText.reduce((joined, next) => {
        if (!joined) return next;
        const separatorNeeded = separator.length > 0 && !/\s$/u.test(joined) && !/^\s/u.test(next);
        return `${joined}${separatorNeeded ? separator : ""}${next}`;
    }, "");
    validateCueText(text);
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const mergedFields = new Map(first.fields);
    mergedFields.set("text", text);
    mergedFields.set("linked_asset_ids", [...assetIds].join(","));
    if (isTimestamped) {
        mergedFields.set("start_time_us", integerField(first, "start_time_us", 0n).toString());
        mergedFields.set(
            "end_time_us",
            integerField(records.at(-1)!, "end_time_us", 0n).toString(),
        );
    }
    mergedFields.set("updated_at_us", timestamp);
    mergedFields.set("human_edited_at_us", timestamp);

    return [
        { ...first, fields: mergedFields },
        ...records.slice(1).map((record) => {
            const fields = new Map(record.fields);
            fields.set("_deleted", "true");
            fields.set("updated_at_us", timestamp);
            return { ...record, fields };
        }),
    ];
}

/** Link existing archive materials to a cue while enforcing session ownership. */
export function setTranscriptLinkedAssets(
    record: ArchiveRecord,
    assetIds: readonly string[],
    availableAssets: readonly ArchiveRecord[],
): ArchiveRecord {
    ensureTranscriptRecord(record);
    const assets = new Map(
        availableAssets.map((asset) => [asset.id.toLowerCase(), asset] as const),
    );
    const linkedIds = new Set<string>();
    const targetSession = field(record, "session_id").toLowerCase();
    for (const value of assetIds) {
        const id = value.trim().toLowerCase();
        if (!UUID_PATTERN.test(id)) throw new Error("Material link contains an invalid asset ID.");
        const asset = assets.get(id);
        if (
            !asset ||
            asset.type !== RecordType.assetMetadata ||
            asset.fields.get("_deleted") === "true"
        ) {
            throw new Error("Choose a material that exists in the open archive.");
        }
        const assetSession = field(asset, "session_id").toLowerCase();
        if (assetSession && assetSession !== targetSession) {
            throw new Error("A material cannot link to a cue in a different session.");
        }
        linkedIds.add(id);
    }
    const fields = new Map(record.fields);
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    fields.set("linked_asset_ids", [...linkedIds].join(","));
    fields.set("updated_at_us", timestamp);
    fields.set("human_edited_at_us", timestamp);
    return { ...record, fields };
}

function ensureTranscriptRecord(record: ArchiveRecord): void {
    if (record.type !== RecordType.transcriptSegment) {
        throw new Error("Only transcript segments can be reviewed.");
    }
}

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

export function sortTranscriptRecords(records: readonly ArchiveRecord[]): ArchiveRecord[] {
    return [...records].sort((left, right) => {
        const leftTimed = left.fields.get("timestamp_state") !== "not-timestamped";
        const rightTimed = right.fields.get("timestamp_state") !== "not-timestamped";
        if (leftTimed !== rightTimed) return leftTimed ? -1 : 1;
        if (leftTimed) {
            const start = compareIntegerField(left, right, "start_time_us");
            if (start !== 0) return start;
            const end = compareIntegerField(left, right, "end_time_us");
            if (end !== 0) return end;
        }
        const imported = compareIntegerField(left, right, "source_imported_at_us", "created_at_us");
        if (imported !== 0) return imported;
        const importId = field(left, "source_import_id").localeCompare(
            field(right, "source_import_id"),
        );
        if (importId !== 0) return importId;
        const sourceIndex = compareIntegerField(left, right, "source_index", "imported_line");
        return sourceIndex || left.id.localeCompare(right.id);
    });
}

export function formatTranscriptExport(
    records: readonly ArchiveRecord[],
    format: TranscriptExportFormat,
): string {
    const ordered = sortTranscriptRecords(records);
    if (format === "json") {
        return `${JSON.stringify(
            ordered.map((record) => ({
                id: record.id,
                type: "transcript",
                revision: record.revision.toString(),
                ...Object.fromEntries(record.fields),
            })),
            null,
            2,
        )}\n`;
    }
    if (format === "vtt" || format === "srt") {
        const invalidCount = ordered.filter((record) => {
            const start = integerField(record, "start_time_us", -1n);
            const end = integerField(record, "end_time_us", -1n);
            return (
                field(record, "timestamp_state") === "not-timestamped" || start < 0n || end <= start
            );
        }).length;
        if (invalidCount > 0) {
            throw new Error(
                `${invalidCount} transcript segment(s) need valid start and end times before subtitle export.`,
            );
        }
    }
    const output: string[] = format === "vtt" ? ["WEBVTT", ""] : [];
    ordered.forEach((record, index) => {
        const text = field(record, "text");
        const speaker = field(record, "speaker_label") || field(record, "speaker_name");
        if (format === "text") {
            output.push(`[${timeRange(record)}] ${speaker ? `${speaker}: ` : ""}${text}`);
            return;
        }
        if (format === "srt") output.push(String(index + 1));
        else if (field(record, "source_id")) output.push(`cue-${index + 1}`);
        output.push(
            `${formatSubtitleTime(integerField(record, "start_time_us", 0n), format === "srt" ? "," : ".")} --> ${formatSubtitleTime(integerField(record, "end_time_us", 0n), format === "srt" ? "," : ".")}`,
        );
        output.push(
            `${speaker ? `${escapeSubtitleText(speaker, format === "vtt")}: ` : ""}${escapeSubtitleText(text, format === "vtt")}`,
        );
        output.push("");
    });
    return `${output.join("\n")}\n`;
}

function field(record: ArchiveRecord, name: string): string {
    return record.fields.get(name) ?? "";
}

function integerField(
    record: ArchiveRecord,
    name: string,
    fallback: bigint,
    alternate?: string,
): bigint {
    const raw = field(record, name) || (alternate ? field(record, alternate) : "");
    return /^-?\d+$/u.test(raw) ? BigInt(raw) : fallback;
}

function compareIntegerField(
    left: ArchiveRecord,
    right: ArchiveRecord,
    name: string,
    alternate?: string,
): number {
    const a = integerField(left, name, 0n, alternate);
    const b = integerField(right, name, 0n, alternate);
    return a < b ? -1 : a > b ? 1 : 0;
}

function timeRange(record: ArchiveRecord): string {
    if (field(record, "timestamp_state") === "not-timestamped") return "time not provided";
    const start = integerField(record, "start_time_us", 0n);
    const end = integerField(record, "end_time_us", 0n);
    return `${formatLongTime(start)}${end > start ? `–${formatLongTime(end)}` : ""}`;
}

function formatLongTime(value: bigint): string {
    const seconds = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
    const hours = seconds / 3600n;
    const minutes = (seconds / 60n) % 60n;
    const remainder = seconds % 60n;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
}

export function formatTranscriptTimestampUs(value: bigint): string {
    return formatLongTime(value);
}

function formatSubtitleTime(value: bigint, separator: "." | ","): string {
    const milliseconds = value / 1000n;
    const hours = milliseconds / 3_600_000n;
    const minutes = (milliseconds / 60_000n) % 60n;
    const seconds = (milliseconds / 1000n) % 60n;
    const fraction = milliseconds % 1000n;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}${separator}${fraction.toString().padStart(3, "0")}`;
}

function escapeSubtitleText(value: string, escapeMarkup: boolean): string {
    const collapsed = value.replace(/\r\n?/gu, "\n").replace(/\n+/gu, "\n");
    return escapeMarkup
        ? collapsed.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        : collapsed;
}
