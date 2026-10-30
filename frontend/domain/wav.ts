import { crc32, newUuid, RecordType, type ArchiveRecord } from "../archive/format";

const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;
const MAX_FORMAT_CHUNK_BYTES = 1024 * 1024;
const CHUNKS_PER_COMMIT = 8;
const U64_MAX = 18_446_744_073_709_551_615n;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;
const encoder = new TextEncoder();

export interface WaveFile {
    readonly name: string;
    readonly size: number;
    slice(start?: number, end?: number): Blob;
    /** Optional bounded range reader for large files that must not be loaded at once. */
    readRange?(offset: number, length: number): Promise<Uint8Array>;
}

export interface WaveImportResult {
    records: ArchiveRecord[];
    trackId: string;
    takeId: string;
    sampleRateHz: number;
    channelCount: number;
    sampleFormat: string;
    sampleCount: bigint;
    chunkCount: number;
    durationUs: bigint;
    byteCount: number;
}

export interface WaveImportSourceMetadata {
    sourceFilename?: string;
    sourceCodec?: string;
}

export interface WaveImportCommit {
    (records: readonly ArchiveRecord[], expectedGeneration: bigint): Promise<ArchiveRecord[]>;
}

export interface IncrementalWaveImportOptions {
    session: ArchiveRecord;
    file: WaveFile;
    allowAdditionalTrack?: boolean;
    knownTrackIds?: readonly string[];
    sourceMetadata?: WaveImportSourceMetadata;
    expectedGeneration: bigint;
    commit: WaveImportCommit;
    chunksPerCommit?: number;
}

interface DataRange {
    offset: number;
    length: number;
}

interface WaveFormat {
    sampleRateHz: number;
    channelCount: number;
    channelMask: number;
    blockAlign: number;
    sampleFormat: string;
    sourceCodec: string;
    bytesPerSample: number;
    dataRanges: DataRange[];
    dataBytes: number;
}

interface WaveImportPlan {
    session: ArchiveRecord;
    sessionId: string;
    format: WaveFormat;
    filename: string;
    sourceCodec: string;
    trackId: string;
    takeId: string;
    timestamp: string;
    sampleCount: bigint;
    durationUs: bigint;
    alignedChunkBytes: number;
    chunksPerCommit: number;
    expectedChunks: number;
    linkedTrackIds: string[];
    priorTrackIds: Set<string>;
}

interface ImportCounters {
    chunks: number;
    samples: bigint;
    bytes: bigint;
}

/** Import PCM WAV bytes as legacy-compatible, independently checksummed archive audio chunks. */
export async function makeWaveImportRecords(
    session: ArchiveRecord,
    file: WaveFile,
    allowAdditionalTrack = false,
    knownTrackIds: readonly string[] = [],
    sourceMetadata: WaveImportSourceMetadata = {},
): Promise<WaveImportResult> {
    const plan = await prepareWaveImport(
        session,
        file,
        allowAdditionalTrack,
        knownTrackIds,
        sourceMetadata,
    );
    const chunks: ArchiveRecord[] = [];
    let imported: ImportCounters = { chunks: 0, samples: 0n, bytes: 0n };
    for await (const batch of waveChunkBatches(file, plan)) {
        chunks.push(...batch.records);
        imported = batch.counters;
    }
    verifyImportedCount(plan, imported);
    const finalRecords = makeWaveImportFinalRecords(plan, imported);
    return {
        records: [...chunks, ...finalRecords],
        trackId: plan.trackId,
        takeId: plan.takeId,
        sampleRateHz: plan.format.sampleRateHz,
        channelCount: plan.format.channelCount,
        sampleFormat: plan.format.sampleFormat,
        sampleCount: plan.sampleCount,
        chunkCount: imported.chunks,
        durationUs: plan.durationUs,
        byteCount: plan.format.dataBytes,
    };
}

/**
 * Stream a WAV import in bounded batches, committing each batch before reading the next.
 * Committed chunks survive a late failure and the session records enough state to recover.
 */
export async function makeWaveImportRecordsIncremental(
    options: IncrementalWaveImportOptions,
): Promise<WaveImportResult> {
    const plan = await prepareWaveImport(
        options.session,
        options.file,
        options.allowAdditionalTrack ?? false,
        options.knownTrackIds ?? [],
        options.sourceMetadata ?? {},
        options.chunksPerCommit,
    );
    let generation = options.expectedGeneration;
    let imported: ImportCounters = { chunks: 0, samples: 0n, bytes: 0n };
    let session = options.session;
    const commit = async (records: readonly ArchiveRecord[]): Promise<ArchiveRecord[]> => {
        const saved = await options.commit(records, generation);
        generation += 1n;
        const savedSession = saved.find(
            (record) =>
                record.type === RecordType.session &&
                record.id.toLowerCase() === options.session.id.toLowerCase(),
        );
        if (savedSession) session = savedSession;
        return saved;
    };

    await commit(makeWaveImportStartRecords(plan));
    try {
        for await (const batch of waveChunkBatches(options.file, plan)) {
            await commit([
                ...batch.records,
                makeRecord(
                    RecordType.assetMetadata,
                    plan.trackId,
                    makeTrackFields(plan, batch.counters, "importing"),
                ),
                makeWaveImportProgressRecord(plan, session, batch.counters),
            ]);
            imported = batch.counters;
        }
        verifyImportedCount(plan, imported);
        await commit(makeWaveImportFinalRecords(plan, imported));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
            await commit(makeWaveImportInterruptedRecords(plan, session, imported, message));
        } catch (persistError) {
            const detail =
                persistError instanceof Error ? persistError.message : String(persistError);
            throw new Error(`${message} Unable to persist interrupted state: ${detail}`, {
                cause: persistError,
            });
        }
        throw error;
    }
    return {
        records: [],
        trackId: plan.trackId,
        takeId: plan.takeId,
        sampleRateHz: plan.format.sampleRateHz,
        channelCount: plan.format.channelCount,
        sampleFormat: plan.format.sampleFormat,
        sampleCount: plan.sampleCount,
        chunkCount: imported.chunks,
        durationUs: plan.durationUs,
        byteCount: plan.format.dataBytes,
    };
}

async function prepareWaveImport(
    session: ArchiveRecord,
    file: WaveFile,
    allowAdditionalTrack: boolean,
    knownTrackIds: readonly string[],
    sourceMetadata: WaveImportSourceMetadata,
    chunksPerCommit = CHUNKS_PER_COMMIT,
): Promise<WaveImportPlan> {
    if (session.type !== RecordType.session || session.fields.get("_deleted") === "true") {
        throw new Error("Choose an active tutoring session before importing audio.");
    }
    if (!Number.isSafeInteger(file.size) || file.size < 12) {
        throw new Error("The WAV file size is invalid.");
    }
    const state = session.fields.get("recording_state") ?? "";
    if (["initializing", "recording", "paused", "finalizing"].includes(state)) {
        throw new Error("Stop the active recording before importing a WAV track.");
    }
    const sessionAlreadyHasAudio =
        knownTrackIds.length > 0 ||
        ["recording_track_id", "recording_track_ids", "audio_import_track_id"].some((key) =>
            Boolean(session.fields.get(key)?.trim()),
        );
    if (sessionAlreadyHasAudio && !allowAdditionalTrack) {
        throw new Error("Choose ‘keep existing tracks’ to add this WAV as a separate audio track.");
    }

    const format = await inspectWave(file);
    const sampleCount = BigInt(format.dataBytes / format.blockAlign);
    const durationUs = (sampleCount * 1_000_000n) / BigInt(format.sampleRateHz);
    const filename = cleanFilename(sourceMetadata.sourceFilename ?? file.name);
    const sourceCodec = sourceMetadata.sourceCodec ?? format.sourceCodec;
    const timestamp = (BigInt(Date.now()) * 1_000n).toString();
    const trackId = newUuid();
    const takeId = newUuid();
    const priorTrackIds = new Set<string>();
    for (const value of [
        session.fields.get("recording_track_ids"),
        session.fields.get("recording_track_id"),
        session.fields.get("audio_import_track_id"),
    ]) {
        for (const id of (value ?? "").split(",")) {
            const normalized = id.trim().toLowerCase();
            if (UUID_PATTERN.test(normalized)) priorTrackIds.add(normalized);
        }
    }
    for (const id of knownTrackIds) {
        const normalized = id.trim().toLowerCase();
        if (UUID_PATTERN.test(normalized)) priorTrackIds.add(normalized);
    }
    const linkedTrackIds = [...priorTrackIds];
    if (!linkedTrackIds.includes(trackId)) linkedTrackIds.push(trackId);
    const alignedChunkBytes =
        Math.floor(MAX_AUDIO_CHUNK_BYTES / format.blockAlign) * format.blockAlign;
    const expectedChunks = format.dataRanges.reduce(
        (total, range) => total + Math.ceil(range.length / alignedChunkBytes),
        0,
    );
    return {
        session,
        sessionId: session.id.toLowerCase(),
        format,
        filename,
        sourceCodec,
        trackId,
        takeId,
        timestamp,
        sampleCount,
        durationUs,
        alignedChunkBytes,
        chunksPerCommit: Math.max(1, Math.min(64, chunksPerCommit)),
        expectedChunks,
        linkedTrackIds,
        priorTrackIds,
    };
}

async function* waveChunkBatches(
    file: WaveFile,
    plan: WaveImportPlan,
): AsyncGenerator<{ records: ArchiveRecord[]; counters: ImportCounters }> {
    let sequence = 0;
    let firstSample = 0n;
    let pending: ArchiveRecord[] = [];
    for (const range of plan.format.dataRanges) {
        for (let rangeOffset = 0; rangeOffset < range.length;) {
            const chunkLength = Math.min(plan.alignedChunkBytes, range.length - rangeOffset);
            const raw = await readRange(file, range.offset + rangeOffset, chunkLength);
            if (
                raw.byteLength !== chunkLength ||
                raw.byteLength === 0 ||
                raw.byteLength % plan.format.blockAlign
            ) {
                throw new Error("The WAV source changed or contains an incomplete sample frame.");
            }
            const frameCount = BigInt(raw.byteLength / plan.format.blockAlign);
            const nextSample = firstSample + frameCount;
            if (nextSample > U64_MAX)
                throw new Error("The WAV sample timeline exceeds archive limits.");
            const chunkFields = new Map<string, string>([
                ["session_id", plan.sessionId],
                ["track_id", plan.trackId],
                ["sequence_number", String(sequence)],
                ["first_sample_index", firstSample.toString()],
                ["sample_count", frameCount.toString()],
                [
                    "timeline_start_us",
                    samplesToMicroseconds(firstSample, plan.format.sampleRateHz).toString(),
                ],
                [
                    "timeline_end_us",
                    samplesToMicroseconds(nextSample, plan.format.sampleRateHz).toString(),
                ],
                ["sample_format", plan.format.sampleFormat],
                ["sample_rate_hz", String(plan.format.sampleRateHz)],
                ["channel_count", String(plan.format.channelCount)],
                ["channel_mask", String(plan.format.channelMask)],
                ["codec", "none"],
                ["source_codec", plan.sourceCodec],
                ["payload_checksum", String(crc32(raw))],
                ["source_filename", plan.filename],
            ]);
            pending.push(
                makeRecord(RecordType.audioChunk, newUuid(), chunkFields, new Uint8Array(raw)),
            );
            sequence += 1;
            firstSample = nextSample;
            rangeOffset += chunkLength;
            if (pending.length >= plan.chunksPerCommit) {
                yield {
                    records: pending,
                    counters: {
                        chunks: sequence,
                        samples: firstSample,
                        bytes: firstSample * BigInt(plan.format.blockAlign),
                    },
                };
                pending = [];
            }
        }
    }
    if (pending.length) {
        yield {
            records: pending,
            counters: {
                chunks: sequence,
                samples: firstSample,
                bytes: firstSample * BigInt(plan.format.blockAlign),
            },
        };
    }
}

function makeWaveImportStartRecords(plan: WaveImportPlan): ArchiveRecord[] {
    const timestamp = plan.timestamp;
    const trackFields = makeTrackFields(plan, { chunks: 0, samples: 0n, bytes: 0n }, "importing");
    const takeFields = makeTakeFields(plan, "importing", 0n);
    const sessionFields = makeSessionImportFields(plan, {
        chunks: 0,
        samples: 0n,
        bytes: 0n,
    });
    sessionFields.set("recording_state", "recording");
    sessionFields.set("audio_import_state", "importing");
    sessionFields.set("audio_import_error", "");
    sessionFields.delete("audio_imported_at_us");
    sessionFields.set("updated_at_us", timestamp);
    return [
        makeRecord(RecordType.assetMetadata, plan.trackId, trackFields),
        makeRecord(RecordType.assetMetadata, plan.takeId, takeFields),
        { ...plan.session, fields: sessionFields },
    ];
}

function makeWaveImportProgressRecord(
    plan: WaveImportPlan,
    session: ArchiveRecord,
    counters: ImportCounters,
): ArchiveRecord {
    const fields = makeSessionImportFields(plan, counters);
    fields.set("recording_state", "recording");
    fields.set("audio_import_state", "importing");
    fields.set("audio_import_error", "");
    fields.set("updated_at_us", (BigInt(Date.now()) * 1_000n).toString());
    return { ...session, fields };
}

function makeWaveImportFinalRecords(
    plan: WaveImportPlan,
    counters: ImportCounters,
): ArchiveRecord[] {
    const trackFields = makeTrackFields(plan, counters, "completed");
    const takeFields = makeTakeFields(plan, "completed", plan.durationUs);
    const sessionFields = makeSessionImportFields(plan, counters);
    sessionFields.set("recording_state", "completed");
    sessionFields.set("audio_import_state", "completed");
    sessionFields.set("audio_import_error", "");
    sessionFields.set("audio_imported_at_us", plan.timestamp);
    sessionFields.set("recording_ended_at_us", plan.timestamp);
    sessionFields.set("updated_at_us", plan.timestamp);
    return [
        makeRecord(RecordType.assetMetadata, plan.trackId, trackFields),
        makeRecord(RecordType.assetMetadata, plan.takeId, takeFields),
        { ...plan.session, fields: sessionFields },
    ];
}

function makeWaveImportInterruptedRecords(
    plan: WaveImportPlan,
    session: ArchiveRecord,
    counters: ImportCounters,
    reason: string,
): ArchiveRecord[] {
    const fields = makeSessionImportFields(plan, counters, session);
    fields.set("recording_state", "interrupted");
    fields.set("audio_import_state", "interrupted");
    fields.set("audio_import_error", reason);
    fields.delete("audio_imported_at_us");
    fields.set("updated_at_us", (BigInt(Date.now()) * 1_000n).toString());
    const takeFields = makeTakeFields(
        plan,
        counters.chunks === 0 ? "failed" : "partial",
        samplesToMicroseconds(counters.samples, plan.format.sampleRateHz),
    );
    return [
        makeRecord(
            RecordType.assetMetadata,
            plan.trackId,
            makeTrackFields(plan, counters, counters.chunks === 0 ? "failed" : "partial"),
        ),
        makeRecord(RecordType.assetMetadata, plan.takeId, takeFields),
        { ...session, fields },
    ];
}

function makeTrackFields(
    plan: WaveImportPlan,
    counters: ImportCounters,
    state: string,
): Map<string, string> {
    return new Map<string, string>([
        ["record_role", "audio-track"],
        ["session_id", plan.sessionId],
        ["track_id", plan.trackId],
        ["recording_take_id", plan.takeId],
        ["label", plan.filename],
        ["source", "imported-file"],
        ["state", state],
        ["message", ""],
        ["sample_format", plan.format.sampleFormat],
        ["sample_rate_hz", String(plan.format.sampleRateHz)],
        ["channel_count", String(plan.format.channelCount)],
        ["channel_mask", String(plan.format.channelMask)],
        ["sample_count", counters.samples.toString()],
        ["timeline_sample_count", counters.samples.toString()],
        [
            "duration_us",
            samplesToMicroseconds(counters.samples, plan.format.sampleRateHz).toString(),
        ],
        ["chunk_count", String(counters.chunks)],
        ["byte_count", counters.bytes.toString()],
        ["source_filename", plan.filename],
        ["updated_at_us", plan.timestamp],
    ]);
}

function makeTakeFields(
    plan: WaveImportPlan,
    state: string,
    durationUs: bigint,
): Map<string, string> {
    return new Map<string, string>([
        ["record_role", "recording-take"],
        ["session_id", plan.sessionId],
        ["label", plan.filename],
        ["source", "imported-file"],
        ["state", state],
        ["track_ids", plan.trackId],
        ["started_at_us", plan.timestamp],
        ["ended_at_us", state === "completed" ? plan.timestamp : ""],
        ["duration_us", durationUs.toString()],
        ["created_at_us", plan.timestamp],
        ["updated_at_us", plan.timestamp],
    ]);
}

function makeSessionImportFields(
    plan: WaveImportPlan,
    counters: ImportCounters,
    session: ArchiveRecord = plan.session,
): Map<string, string> {
    const fields = new Map(session.fields);
    fields.set("recording_track_ids", plan.linkedTrackIds.join(","));
    fields.set("recording_track_count", String(plan.linkedTrackIds.length));
    if (!fields.get("recording_track_id")) fields.set("recording_track_id", plan.trackId);
    if (plan.priorTrackIds.size === 0) {
        fields.set("recording_source", "imported-file");
        fields.set("recording_sample_format", plan.format.sampleFormat);
        fields.set("recording_sample_rate_hz", String(plan.format.sampleRateHz));
        fields.set("recording_channel_count", String(plan.format.channelCount));
        fields.set("recording_channel_mask", String(plan.format.channelMask));
        fields.set("recording_started_at_us", plan.timestamp);
        fields.set("recording_samples", counters.samples.toString());
        fields.set("recording_timeline_samples", counters.samples.toString());
        fields.set("recording_bytes", counters.bytes.toString());
        fields.set("recording_audio_chunks", String(counters.chunks));
    } else {
        fields.set(
            "recording_audio_chunks",
            (safeCount(session.fields.get("recording_audio_chunks")) + counters.chunks).toString(),
        );
        fields.set(
            "recording_bytes",
            (safeBigInt(session.fields.get("recording_bytes")) + counters.bytes).toString(),
        );
    }
    const priorDuration = safeBigInt(session.fields.get("recording_duration_us"));
    const duration = samplesToMicroseconds(counters.samples, plan.format.sampleRateHz);
    if (duration > priorDuration) fields.set("recording_duration_us", duration.toString());
    fields.set("audio_import_track_id", plan.trackId);
    fields.set("audio_import_take_id", plan.takeId);
    fields.set("audio_import_expected_chunks", String(plan.expectedChunks));
    fields.set("audio_import_expected_samples", plan.sampleCount.toString());
    fields.set("audio_import_expected_bytes", String(plan.format.dataBytes));
    fields.set("audio_import_sample_rate_hz", String(plan.format.sampleRateHz));
    fields.set("audio_import_channel_count", String(plan.format.channelCount));
    fields.set("audio_import_channel_mask", String(plan.format.channelMask));
    fields.set("audio_import_sample_format", plan.format.sampleFormat);
    fields.set("audio_import_source_codec", plan.sourceCodec);
    fields.set("audio_import_bytes", counters.bytes.toString());
    fields.set("audio_chunks_imported", String(counters.chunks));
    fields.set("audio_samples_imported", counters.samples.toString());
    return fields;
}

function verifyImportedCount(plan: WaveImportPlan, counters: ImportCounters): void {
    if (
        counters.chunks !== plan.expectedChunks ||
        counters.samples !== plan.sampleCount ||
        counters.bytes !== BigInt(plan.format.dataBytes)
    ) {
        throw new Error("The WAV sample count changed during import.");
    }
}

async function inspectWave(file: WaveFile): Promise<WaveFormat> {
    const header = await readRange(file, 0, 12);
    if (ascii(header.subarray(0, 4)) !== "RIFF" || ascii(header.subarray(8, 12)) !== "WAVE") {
        throw new Error("Choose a little-endian RIFF/WAVE audio file.");
    }
    const riffEnd = 8 + readU32(header, 4);
    if (riffEnd < 12 || riffEnd > file.size) {
        throw new Error("The WAV RIFF length exceeds the selected file.");
    }

    let format: Omit<WaveFormat, "dataRanges" | "dataBytes"> | null = null;
    const dataRanges: DataRange[] = [];
    let dataBytes = 0;
    let cursor = 12;
    while (cursor < riffEnd) {
        if (riffEnd - cursor < 8)
            throw new Error("The WAV file ends with an incomplete chunk header.");
        const chunkHeader = await readRange(file, cursor, 8);
        const chunkName = ascii(chunkHeader.subarray(0, 4));
        const chunkLength = readU32(chunkHeader, 4);
        const payloadOffset = cursor + 8;
        const paddedLength = chunkLength + (chunkLength & 1);
        if (paddedLength > riffEnd - payloadOffset) {
            throw new Error("A WAV chunk extends beyond the declared RIFF file.");
        }

        if (chunkName === "fmt ") {
            if (format || chunkLength < 16 || chunkLength > MAX_FORMAT_CHUNK_BYTES) {
                throw new Error("The WAV format chunk is duplicated or invalid.");
            }
            const bytes = await readRange(file, payloadOffset, Math.min(chunkLength, 40));
            const tag = readU16(bytes, 0);
            const channelCount = readU16(bytes, 2);
            const sampleRateHz = readU32(bytes, 4);
            const byteRate = readU32(bytes, 8);
            const blockAlign = readU16(bytes, 12);
            const bitsPerSample = readU16(bytes, 14);
            let formatTag = tag;
            let channelMask = 0;
            if (tag === 0xfffe) {
                const guidTail = [
                    0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
                ];
                if (
                    chunkLength < 40 ||
                    bytes.byteLength < 40 ||
                    readU16(bytes, 16) < 22 ||
                    readU16(bytes, 18) !== bitsPerSample ||
                    guidTail.some((value, index) => bytes[28 + index] !== value)
                ) {
                    throw new Error(
                        "Only PCM or IEEE-float WAVE extensible formats are supported.",
                    );
                }
                channelMask = readU32(bytes, 20);
                formatTag = readU32(bytes, 24);
            }
            if (
                (formatTag !== 1 && formatTag !== 3) ||
                (formatTag === 1 && ![8, 16, 24, 32].includes(bitsPerSample)) ||
                (formatTag === 3 && bitsPerSample !== 32)
            ) {
                throw new Error("Supported WAV audio is PCM 8/16/24/32-bit or IEEE-float 32-bit.");
            }
            if (
                channelCount < 1 ||
                channelCount > 8 ||
                sampleRateHz < 8_000 ||
                sampleRateHz > 384_000
            ) {
                throw new Error("WAV channel count or sample rate is outside supported limits.");
            }
            const bytesPerSample = bitsPerSample / 8;
            const expectedAlign = channelCount * bytesPerSample;
            if (blockAlign !== expectedAlign || byteRate !== sampleRateHz * expectedAlign) {
                throw new Error("WAV block alignment or byte rate is inconsistent.");
            }
            const sampleFormat =
                formatTag === 3
                    ? "pcm_f32le"
                    : bitsPerSample === 8
                      ? "pcm_u8"
                      : `pcm_s${bitsPerSample}le`;
            format = {
                sampleRateHz,
                channelCount,
                channelMask,
                blockAlign,
                sampleFormat,
                sourceCodec: formatTag === 3 ? "wav-ieee-float" : "wav-pcm",
                bytesPerSample,
            };
        } else if (chunkName === "data" && chunkLength > 0) {
            dataRanges.push({ offset: payloadOffset, length: chunkLength });
            dataBytes += chunkLength;
            if (!Number.isSafeInteger(dataBytes)) {
                throw new Error("WAV audio data exceeds the supported file range.");
            }
        }
        cursor = payloadOffset + paddedLength;
    }

    if (!format || !dataRanges.length || dataBytes === 0) {
        throw new Error("The WAV file must contain one format chunk and nonempty audio data.");
    }
    if (
        dataBytes % format.blockAlign !== 0 ||
        dataRanges.some((range) => range.length % format!.blockAlign !== 0)
    ) {
        throw new Error("WAV sample data contains an incomplete audio frame.");
    }
    return { ...format, dataRanges, dataBytes };
}

async function readRange(file: WaveFile, offset: number, length: number): Promise<Uint8Array> {
    const end = offset + length;
    if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        end > file.size
    ) {
        throw new Error("The WAV file ended before the requested data could be read.");
    }
    const bytes = file.readRange
        ? await file.readRange(offset, length)
        : new Uint8Array(await file.slice(offset, end).arrayBuffer());
    if (bytes.byteLength !== length) throw new Error("The WAV file changed during import.");
    return bytes;
}

function readU16(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function ascii(bytes: Uint8Array): string {
    return String.fromCharCode(...bytes);
}

function samplesToMicroseconds(samples: bigint, sampleRateHz: number): bigint {
    const rate = BigInt(sampleRateHz);
    return (samples / rate) * 1_000_000n + ((samples % rate) * 1_000_000n) / rate;
}

function makeRecord(
    type: number,
    id: string,
    fields: ReadonlyMap<string, string>,
    blob = new Uint8Array(),
): ArchiveRecord {
    return { type, id, revision: 0n, previousOffset: 0n, fields, blob };
}

function cleanFilename(value: string): string {
    const filename = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
    const normalized = [...filename]
        .map((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f ? " " : character;
        })
        .join("")
        .trim()
        .slice(0, 256);
    if (!normalized || encoder.encode(normalized).byteLength > 1024) {
        throw new Error("WAV filename must contain between 1 and 256 characters.");
    }
    return normalized;
}

function safeCount(value: string | undefined): number {
    if (!value || !/^\d+$/u.test(value)) return 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeBigInt(value: string | undefined): bigint {
    return value && /^\d+$/u.test(value) ? BigInt(value) : 0n;
}
