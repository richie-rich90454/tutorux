import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import type { AudioPreview } from "./audio";

interface WhisperSegment {
    text: string;
    offsets: { from: number; to: number };
    speaker_turn_next?: boolean;
}

/** Produce the 16 kHz mono PCM WAV required by whisper.cpp. */
export function whisperAudio(preview: AudioPreview): Uint8Array {
    const rate = 16_000;
    if (
        !preview.sampleRateHz ||
        !preview.channelCount ||
        !preview.frameCount ||
        preview.wav.length < 44 + preview.frameCount * preview.channelCount * 2
    ) {
        throw new Error("The audio preview is invalid.");
    }
    const count = Math.floor((preview.frameCount * rate) / preview.sampleRateHz);
    if (!count || count > rate * 30)
        throw new Error("Transcription previews are limited to 30 seconds.");
    const bytes = new Uint8Array(44 + count * 2);
    const output = new DataView(bytes.buffer);
    const source = new DataView(preview.wav.buffer, preview.wav.byteOffset, preview.wav.byteLength);
    const writeText = (offset: number, text: string) => {
        for (let index = 0; index < text.length; index++)
            bytes[offset + index] = text.charCodeAt(index);
    };
    writeText(0, "RIFF");
    output.setUint32(4, bytes.length - 8, true);
    writeText(8, "WAVEfmt ");
    output.setUint32(16, 16, true);
    output.setUint16(20, 1, true);
    output.setUint16(22, 1, true);
    output.setUint32(24, rate, true);
    output.setUint32(28, rate * 2, true);
    output.setUint16(32, 2, true);
    output.setUint16(34, 16, true);
    writeText(36, "data");
    output.setUint32(40, count * 2, true);
    const sample = (frame: number) => {
        let sum = 0;
        for (let channel = 0; channel < preview.channelCount; channel++) {
            sum += source.getInt16(44 + (frame * preview.channelCount + channel) * 2, true);
        }
        return sum / preview.channelCount;
    };
    for (let index = 0; index < count; index++) {
        const position = (index * preview.sampleRateHz) / rate;
        const frame = Math.floor(position);
        const next = Math.min(frame + 1, preview.frameCount - 1);
        const fraction = position - frame;
        output.setInt16(
            44 + index * 2,
            Math.round(sample(frame) * (1 - fraction) + sample(next) * fraction),
            true,
        );
    }
    return bytes;
}

/** Convert whisper.cpp JSON into legacy-shaped provisional transcript records. */
export function makeWhisperRecords(options: {
    json: string;
    sessionId: string;
    trackId: string;
    modelName: string;
    language: string;
    preview: AudioPreview;
    existing: readonly ArchiveRecord[];
    replaceProvisional?: boolean;
    runId?: string;
    diarizeSpeakerTurns?: boolean;
}): { records: ArchiveRecord[]; skipped: number } {
    const parsed: unknown = JSON.parse(options.json);
    if (
        !parsed ||
        typeof parsed !== "object" ||
        !("transcription" in parsed) ||
        !Array.isArray(parsed.transcription)
    ) {
        throw new Error("Whisper returned an invalid transcript.");
    }
    const detectedLanguage = whisperResultLanguage(parsed);
    const language = detectedLanguage ?? options.language;
    const start = (options.preview.startFrame * 1_000_000n) / BigInt(options.preview.sampleRateHz);
    const end = start + options.preview.durationUs;
    const overlaps = (record: ArchiveRecord): boolean => {
        if (
            record.type !== RecordType.transcriptSegment ||
            record.fields.get("_deleted") === "true" ||
            record.fields.get("session_id")?.toLowerCase() !== options.sessionId.toLowerCase() ||
            record.fields.get("source_audio_track_id")?.toLowerCase() !==
                options.trackId.toLowerCase()
        )
            return false;
        const a = record.fields.get("start_time_us") ?? "";
        const b = record.fields.get("end_time_us") ?? "";
        return /^\d+$/.test(a) && /^\d+$/.test(b) && BigInt(a) < end && BigInt(b) > start;
    };
    const existing = options.existing.filter(overlaps);
    if (
        !options.replaceProvisional &&
        existing.some(
            (record) =>
                record.fields.get("origin") === "local-whisper" &&
                record.fields.get("verification_state") === "provisional" &&
                !record.fields.has("human_edited_at_us"),
        )
    ) {
        throw new Error(
            "This audio already has provisional Whisper cues. Review or remove them before transcribing this range again.",
        );
    }
    const protectedRanges = existing.filter(
        (record) =>
            record.fields.has("human_edited_at_us") ||
            ["human-corrected", "human-verified"].includes(
                record.fields.get("verification_state") ?? "",
            ),
    );
    const runId = options.runId ?? newUuid();
    const createdAt = (BigInt(Date.now()) * 1000n).toString();
    let skipped = 0;
    const records: ArchiveRecord[] = [];
    if (options.replaceProvisional) {
        for (const record of existing) {
            if (
                record.fields.get("origin") === "local-whisper" &&
                record.fields.get("verification_state") === "provisional" &&
                !record.fields.has("human_edited_at_us")
            ) {
                const fields = new Map(record.fields);
                fields.set("_deleted", "true");
                fields.set("superseded_by_run", runId);
                fields.set("updated_at_us", createdAt);
                records.push({ ...record, fields });
            }
        }
    }
    for (const value of parsed.transcription as unknown[]) {
        if (!value || typeof value !== "object")
            throw new Error("Whisper returned an invalid segment.");
        const segment = value as Partial<WhisperSegment>;
        const from = segment.offsets?.from;
        const to = segment.offsets?.to;
        if (
            typeof segment.text !== "string" ||
            !Number.isSafeInteger(from) ||
            !Number.isSafeInteger(to) ||
            from! < 0 ||
            to! <= from! ||
            segment.text.length > 1_000_000
        ) {
            throw new Error("Whisper returned an invalid segment.");
        }
        if (options.diarizeSpeakerTurns && typeof segment.speaker_turn_next !== "boolean") {
            throw new Error(
                "Whisper did not return speaker-turn boundaries. Use a compatible whisper.cpp executable and TDRZ model, or turn off tiny diarization.",
            );
        }
        if (!segment.text.trim()) continue;
        const a = start + BigInt(from!) * 1000n;
        const b = start + BigInt(to!) * 1000n;
        if (a >= end || b > end) {
            skipped++;
            continue;
        }
        if (
            protectedRanges.some(
                (record) =>
                    a < BigInt(record.fields.get("end_time_us")!) &&
                    b > BigInt(record.fields.get("start_time_us")!),
            )
        ) {
            skipped++;
            continue;
        }
        const fields = new Map<string, string>([
            ["session_id", options.sessionId],
            ["start_time_us", a.toString()],
            ["end_time_us", b.toString()],
            ["text", segment.text],
            ["verification_state", "provisional"],
            ["timestamp_state", "timestamped"],
            ["origin", "local-whisper"],
            ["source_audio_track_id", options.trackId],
            ["source_model", options.modelName],
            ["source_backend_version", "whisper.cpp CLI"],
            ["source_run_id", runId],
            ["source_window_start_us", start.toString()],
            ["language", language],
            ["created_at_us", createdAt],
        ]);
        if (options.diarizeSpeakerTurns) {
            fields.set("speaker_turn_next", String(segment.speaker_turn_next));
            fields.set("speaker_identity_state", "unassigned");
            fields.set("diarization_enabled", "true");
            fields.set("diarization_scope", "experimental-speaker-turn-boundaries-only");
            fields.set("diarization_method", "whisper.cpp-tinydiarize");
            fields.set("diarization_model_requirement", "TDRZ-compatible Whisper model required");
        }
        records.push({
            type: RecordType.transcriptSegment,
            id: newUuid(),
            revision: 0n,
            previousOffset: 0n,
            blob: new Uint8Array(),
            fields,
        });
    }
    return { records, skipped };
}

/** Read whisper.cpp's detected language from CLI JSON when the model ran language detection. */
function whisperResultLanguage(parsed: object): string | undefined {
    if (!("result" in parsed)) return undefined;
    const result = parsed.result;
    if (!result || typeof result !== "object" || !("language" in result)) return undefined;
    const language = result.language;
    return typeof language === "string" && /^[A-Za-z-]{1,16}$/u.test(language)
        ? language
        : undefined;
}
