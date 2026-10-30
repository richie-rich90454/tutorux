import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import { parseTranscriptTimestamp } from "./transcript";

export const ANNOTATION_TYPES = [
    "general-note",
    "important-concept",
    "student-mistake",
    "tutor-correction",
    "explicit-instruction",
    "worked-example",
    "follow-up-priority",
    "student-question",
    "learning-outcome",
    "custom",
] as const;

export const ANNOTATION_PRIORITIES = ["low", "normal", "high", "critical"] as const;

export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type AnnotationPriority = (typeof ANNOTATION_PRIORITIES)[number];

export interface AnnotationInput {
    sessionId: string;
    start: string;
    end: string;
    type: AnnotationType;
    priority: AnnotationPriority;
    title: string;
    content: string;
}

export function makeAnnotationRecord(input: AnnotationInput): ArchiveRecord {
    validateSessionId(input.sessionId);
    const startTimeUs = parseTranscriptTimestamp(input.start);
    const endTimeUs = input.end.trim() ? parseTranscriptTimestamp(input.end) : startTimeUs;
    if (endTimeUs < startTimeUs) throw new Error("Annotation end time precedes its start.");
    const timestamp = nowUs();
    return {
        type: RecordType.annotation,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map([
            ["session_id", input.sessionId.toLowerCase()],
            ["start_time_us", startTimeUs.toString()],
            ["end_time_us", endTimeUs.toString()],
            ["type", validateAnnotationType(input.type)],
            ["priority", validateAnnotationPriority(input.priority)],
            ["title", cleanText(input.title, "Annotation title", 512)],
            ["content", cleanText(input.content, "Annotation text", 16 * 1024 * 1024, true)],
            ["origin", "tutor-authored"],
            ["created_at_us", timestamp],
            ["updated_at_us", timestamp],
        ]),
    };
}

export function updateAnnotationRecord(
    current: ArchiveRecord,
    input: AnnotationInput,
): ArchiveRecord {
    ensureAnnotationRecord(current);
    validateSessionId(input.sessionId);
    const startTimeUs = parseTranscriptTimestamp(input.start);
    const endTimeUs = input.end.trim() ? parseTranscriptTimestamp(input.end) : startTimeUs;
    if (endTimeUs < startTimeUs) throw new Error("Annotation end time precedes its start.");
    const fields = new Map(current.fields);
    fields.set("session_id", input.sessionId.toLowerCase());
    fields.set("start_time_us", startTimeUs.toString());
    fields.set("end_time_us", endTimeUs.toString());
    fields.set("type", validateAnnotationType(input.type));
    fields.set("priority", validateAnnotationPriority(input.priority));
    fields.set("title", cleanText(input.title, "Annotation title", 512));
    fields.set("content", cleanText(input.content, "Annotation text", 16 * 1024 * 1024, true));
    fields.set("updated_at_us", nowUs());
    return { ...current, fields };
}

export function removeAnnotationRecord(current: ArchiveRecord): ArchiveRecord {
    ensureAnnotationRecord(current);
    if (current.fields.get("_deleted") === "true")
        throw new Error("Annotation is already removed.");
    const fields = new Map(current.fields);
    const timestamp = nowUs();
    fields.set("_deleted", "true");
    fields.set("deleted_at_us", timestamp);
    fields.set("updated_at_us", timestamp);
    return { ...current, fields };
}

export function duplicateAnnotationRecord(current: ArchiveRecord): ArchiveRecord {
    ensureAnnotationRecord(current);
    if (current.fields.get("_deleted") === "true")
        throw new Error("A removed annotation cannot be duplicated.");
    const fields = new Map(current.fields);
    const timestamp = nowUs();
    fields.delete("_deleted");
    fields.delete("deleted_at_us");
    fields.set("created_at_us", timestamp);
    fields.set("updated_at_us", timestamp);
    return { ...current, id: newUuid(), revision: 0n, previousOffset: 0n, fields };
}

export function validateAnnotationType(value: string): AnnotationType {
    if ((ANNOTATION_TYPES as readonly string[]).includes(value)) return value as AnnotationType;
    throw new Error("Unsupported annotation type.");
}

export function validateAnnotationPriority(value: string): AnnotationPriority {
    if ((ANNOTATION_PRIORITIES as readonly string[]).includes(value))
        return value as AnnotationPriority;
    throw new Error("Priority must be low, normal, high, or critical.");
}

function ensureAnnotationRecord(record: ArchiveRecord): void {
    if (record.type !== RecordType.annotation)
        throw new Error("Only annotation records can be changed here.");
}

function validateSessionId(value: string): void {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value)) {
        throw new Error("Session ID must be a valid UUID.");
    }
}

function cleanText(value: string, label: string, maxBytes: number, allowMultiline = false): string {
    if (hasUnpairedSurrogate(value)) throw new Error(`${label} must contain valid Unicode.`);
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > maxBytes) throw new Error(`${label} must be ${maxBytes} UTF-8 bytes or fewer.`);
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code === 0x7f || (code < 0x20 && code !== 0x09 && !(allowMultiline && code === 0x0a))) {
            throw new Error(`${label} contains unsupported control characters.`);
        }
    }
    return value;
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

function nowUs(): string {
    return (BigInt(Date.now()) * 1000n).toString();
}
