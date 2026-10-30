import { invoke, isTauri } from "@tauri-apps/api/core";
import { makeWaveImportRecords, type WaveFile, type WaveImportResult } from "../domain/wav";
import type { ArchiveRecord } from "../archive/format";

/** Formats the desktop audio picker may offer. Compressed sources require FFmpeg on the host. */
export const DESKTOP_AUDIO_IMPORT_EXTENSIONS = [".wav", ".wave", ".flac", ".mp3", ".m4a"] as const;
export const DESKTOP_AUDIO_IMPORT_ACCEPT =
    ".wav,.wave,.flac,.mp3,.m4a,audio/wav,audio/x-wav,audio/flac,audio/mpeg,audio/mp4";

export interface PreparedCompressedAudio {
    waveFile: WaveFile;
    sourceFilename: string;
    sourceCodec?: "flac" | "mp3" | "m4a";
    cleanup: () => Promise<void>;
}

interface CompressedPcmChunk {
    sequence: number;
    firstSampleIndex: string;
    frameCount: string;
    pcmBase64: string;
}

interface CompressedAudioResult {
    sourceFilename: string;
    sourceCodec: string;
    sampleRateHz: number;
    channelCount: number;
    channelMask: number;
    sampleFormat: string;
    sampleCount: string;
    byteCount: number;
    chunkCount: number;
    durationUs: string;
    chunks: CompressedPcmChunk[];
}

export function compressedAudioCodec(filename: string): "flac" | "mp3" | "m4a" | undefined {
    const extension = filename.toLowerCase().split(".").at(-1);
    return extension === "flac" || extension === "mp3" || extension === "m4a"
        ? extension
        : undefined;
}

/**
 * Ask the Tauri backend to decode FLAC, MP3, or M4A audio through FFmpeg.
 * Command contract: `import_compressed_audio({ path, ffmpegPath? })` returns the
 * chunked PCM object produced by `src-tauri/src/audio_import.rs`.
 */
export async function importCompressedAudio(
    sourcePath: string,
    ffmpegPath?: string,
): Promise<PreparedCompressedAudio> {
    if (!isTauri()) {
        throw new Error("Compressed audio import is available in the desktop app.");
    }
    let result: unknown;
    try {
        result = await invoke<unknown>("import_compressed_audio", {
            path: sourcePath,
            ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/ffmpeg/iu.test(detail)) {
            throw new Error(
                `Compressed audio import requires FFmpeg with the FLAC, MP3, and M4A decoders. WAV import works without FFmpeg. ${detail}`,
                { cause: error },
            );
        }
        throw error instanceof Error ? error : new Error(detail, { cause: error });
    }
    const decoded = parseCompressedAudioResult(result);
    const sourceCodec = compressedAudioCodec(decoded.sourceFilename);
    return {
        waveFile: compressedWaveFile(decoded),
        sourceFilename: decoded.sourceFilename,
        ...(sourceCodec === undefined ? {} : { sourceCodec }),
        cleanup: async () => undefined,
    };
}

/** Decode with FFmpeg, then build the same archive records as a WAV import. */
export async function importCompressedAudioRecords(
    session: ArchiveRecord,
    sourcePath: string,
    options: {
        allowAdditionalTrack?: boolean;
        knownTrackIds?: readonly string[];
        ffmpegPath?: string;
    } = {},
): Promise<WaveImportResult> {
    const prepared = await importCompressedAudio(sourcePath, options.ffmpegPath);
    try {
        return await makeWaveImportRecords(
            session,
            prepared.waveFile,
            options.allowAdditionalTrack ?? false,
            options.knownTrackIds ?? [],
            {
                sourceFilename: prepared.sourceFilename,
                ...(prepared.sourceCodec === undefined
                    ? {}
                    : { sourceCodec: prepared.sourceCodec }),
            },
        );
    } finally {
        await prepared.cleanup();
    }
}

function parseCompressedAudioResult(value: unknown): CompressedAudioResult {
    if (!isRecord(value) || !Array.isArray(value["chunks"])) {
        throw new Error("The desktop audio importer returned an unsupported result.");
    }
    const sourceFilename = text(value["sourceFilename"]);
    const sourceCodec = text(value["sourceCodec"]);
    const sampleRateHz = integer(value["sampleRateHz"]);
    const channelCount = integer(value["channelCount"]);
    const channelMask = integer(value["channelMask"]);
    const sampleFormat = text(value["sampleFormat"]);
    const sampleCount = unsigned(value["sampleCount"]);
    const byteCount = integer(value["byteCount"]);
    const chunkCount = integer(value["chunkCount"]);
    if (
        !sourceFilename ||
        !sourceCodec ||
        !sampleRateHz ||
        !channelCount ||
        sampleFormat !== "pcm_s16le" ||
        !sampleCount ||
        byteCount < 2 ||
        chunkCount < 1
    ) {
        throw new Error("The desktop audio importer returned invalid decoded audio metadata.");
    }
    const chunks = value["chunks"].map((item, index): CompressedPcmChunk => {
        if (!isRecord(item))
            throw new Error("The desktop audio importer returned an invalid audio chunk.");
        const sequence = integer(item["sequence"]);
        const firstSampleIndex = unsigned(item["firstSampleIndex"]);
        const frameCount = unsigned(item["frameCount"]);
        const pcmBase64 = text(item["pcmBase64"]);
        if (
            sequence !== index ||
            !firstSampleIndex ||
            !frameCount ||
            !pcmBase64 ||
            pcmBase64.length > 2 * 1024 * 1024
        ) {
            throw new Error("The desktop audio importer returned an invalid audio chunk.");
        }
        return { sequence, firstSampleIndex, frameCount, pcmBase64 };
    });
    if (chunks.length !== chunkCount) {
        throw new Error("The desktop audio importer returned an incomplete audio chunk list.");
    }
    return {
        sourceFilename,
        sourceCodec,
        sampleRateHz,
        channelCount,
        channelMask,
        sampleFormat,
        sampleCount,
        byteCount,
        chunkCount,
        durationUs: unsigned(value["durationUs"]) ?? "0",
        chunks,
    };
}

function compressedWaveFile(result: CompressedAudioResult): WaveFile {
    const blockAlign = result.channelCount * 2;
    if (BigInt(result.byteCount) !== BigInt(result.sampleCount) * BigInt(blockAlign)) {
        throw new Error("The decoded audio byte count does not match its sample count.");
    }
    const header = makeVirtualWavHeader(result, blockAlign);
    const dataOffset = header.byteLength;
    let cachedIndex = -1;
    let cachedPcm = new Uint8Array();
    const chunkStarts = result.chunks.map((chunk) =>
        Number(BigInt(chunk.firstSampleIndex) * BigInt(blockAlign)),
    );
    return {
        name: result.sourceFilename,
        size: dataOffset + result.byteCount,
        slice: () => {
            throw new Error("Use the bounded range reader for decoded audio.");
        },
        readRange: async (offset, length) => {
            if (offset < dataOffset) {
                return header.subarray(offset, Math.min(header.byteLength, offset + length));
            }
            const output = new Uint8Array(length);
            let written = 0;
            let dataPosition = offset - dataOffset;
            while (written < length) {
                const index = findChunk(chunkStarts, dataPosition);
                const chunk = result.chunks[index];
                if (!chunk)
                    throw new Error("Decoded audio ended before the requested data could be read.");
                if (cachedIndex !== index) {
                    cachedPcm = decodeBase64(chunk.pcmBase64);
                    cachedIndex = index;
                    if (cachedPcm.byteLength !== Number(chunk.frameCount) * blockAlign) {
                        throw new Error("A decoded audio chunk has an invalid length.");
                    }
                }
                const local = dataPosition - chunkStarts[index]!;
                const count = Math.min(cachedPcm.byteLength - local, length - written);
                if (count <= 0) throw new Error("Decoded audio chunk boundaries are inconsistent.");
                output.set(cachedPcm.subarray(local, local + count), written);
                written += count;
                dataPosition += count;
            }
            return output;
        },
    };
}

function makeVirtualWavHeader(result: CompressedAudioResult, blockAlign: number): Uint8Array {
    const extensible = result.channelMask !== 0;
    const formatBytes = extensible ? 40 : 16;
    const header = new Uint8Array(12 + 8 + formatBytes + 8);
    const view = new DataView(header.buffer);
    writeAscii(header, 0, "RIFF");
    view.setUint32(4, header.byteLength - 8 + result.byteCount, true);
    writeAscii(header, 8, "WAVE");
    writeAscii(header, 12, "fmt ");
    view.setUint32(16, formatBytes, true);
    view.setUint16(20, extensible ? 0xfffe : 1, true);
    view.setUint16(22, result.channelCount, true);
    view.setUint32(24, result.sampleRateHz, true);
    view.setUint32(28, result.sampleRateHz * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    if (extensible) {
        view.setUint16(36, 22, true);
        view.setUint16(38, 16, true);
        view.setUint32(40, result.channelMask, true);
        view.setUint32(44, 1, true);
        header.set([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 48);
    }
    const dataHeader = 12 + 8 + formatBytes;
    writeAscii(header, dataHeader, "data");
    view.setUint32(dataHeader + 4, result.byteCount, true);
    return header;
}

function findChunk(starts: readonly number[], position: number): number {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (starts[middle]! <= position) low = middle;
        else high = middle - 1;
    }
    return low;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
    for (let index = 0; index < value.length; index++)
        bytes[offset + index] = value.charCodeAt(index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function unsigned(value: unknown): string | undefined {
    return typeof value === "string" && /^\d+$/u.test(value) ? value : undefined;
}
