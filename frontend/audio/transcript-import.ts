import { makeTranscriptRecords, parseTranscriptTimestamp } from "../domain/transcript";
import type { TranscriptCue, TranscriptSourceFormat } from "../domain/transcript";
import type { ArchiveRecord } from "../archive/format";

const DEFAULT_BATCH_SIZE = 128;
const MAX_CUE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

export interface TranscriptBatchCommit {
    (records: readonly ArchiveRecord[], expectedGeneration: bigint): Promise<ArchiveRecord[]>;
}

/** Read plain text, SRT, or WebVTT cues in bounded batches without loading the source at once. */
export async function* transcriptCueBatches(
    source: AsyncIterable<Uint8Array | string>,
    format: TranscriptSourceFormat,
    batchSize = DEFAULT_BATCH_SIZE,
): AsyncGenerator<TranscriptCue[]> {
    const size = Math.max(1, Math.min(1_024, batchSize));
    let batch: TranscriptCue[] = [];
    const emit = (cue: TranscriptCue): TranscriptCue[] | undefined => {
        batch.push(cue);
        if (batch.length < size) return undefined;
        const ready = batch;
        batch = [];
        return ready;
    };
    for await (const cue of parseTranscriptCues(source, format)) {
        const ready = emit(cue);
        if (ready) yield ready;
    }
    if (batch.length) yield batch;
}

/** Parse cues from a bounded async byte stream while retaining only one cue or block. */
export async function* parseTranscriptCues(
    source: AsyncIterable<Uint8Array | string>,
    format: TranscriptSourceFormat,
): AsyncGenerator<TranscriptCue> {
    if (format === "text") {
        let sourceIndex = 0;
        let lineNumber = 0;
        for await (const line of decodeLines(source)) {
            lineNumber += 1;
            if (!line) continue;
            validateCue(line);
            yield { text: line, sourceIndex: sourceIndex++, sourceId: String(lineNumber) };
        }
        return;
    }
    let sourceIndex = 0;
    let vttHeaderSeen = false;
    let vttHeaderBlock = false;
    let block: string[] = [];
    let cueBytes = 0;
    const flush = (): TranscriptCue | undefined => {
        if (!block.length) return undefined;
        if (format === "vtt" && isVttMetadataBlock(block)) {
            block = [];
            cueBytes = 0;
            return undefined;
        }
        const timingIndex = block.findIndex((line) => line.includes("-->"));
        if (timingIndex < 0 || timingIndex > 1) {
            throw new Error(
                "Subtitle cue must have an optional identifier followed by a timestamp.",
            );
        }
        const range = parseSubtitleTimeRange(block[timingIndex]!);
        const textLines = block.slice(timingIndex + 1);
        if (!textLines.length) throw new Error("Subtitle cue contains no text.");
        const text = textLines.join("\n");
        validateCue(text);
        const sourceId = timingIndex === 1 ? block[0]! : "";
        validateCue(sourceId);
        block = [];
        cueBytes = 0;
        return {
            text,
            startTimeUs: range[0],
            endTimeUs: range[1],
            sourceIndex: sourceIndex++,
            sourceId,
        };
    };

    for await (const line of decodeLines(source)) {
        if (format === "vtt" && !vttHeaderSeen) {
            const validHeader =
                line === "WEBVTT" || line.startsWith("WEBVTT ") || line.startsWith("WEBVTT\t");
            if (!validHeader)
                throw new Error("WebVTT source must begin with a valid WEBVTT header.");
            vttHeaderSeen = true;
            vttHeaderBlock = true;
            continue;
        }
        if (format === "vtt" && vttHeaderBlock) {
            if (line.trim() === "") vttHeaderBlock = false;
            continue;
        }
        if (line.trim() === "") {
            const cue = flush();
            if (cue) yield cue;
            continue;
        }
        const nextBytes = encoder.encode(line).byteLength + (block.length ? 1 : 0);
        if (nextBytes > MAX_CUE_BYTES - cueBytes) throw new Error("Subtitle cue exceeds 16 MiB.");
        cueBytes += nextBytes;
        block.push(line);
    }
    if (format === "vtt" && !vttHeaderSeen) throw new Error("WebVTT source is missing its header.");
    if (format === "vtt" && vttHeaderBlock)
        throw new Error("WebVTT header metadata must end with a blank line.");
    const finalCue = flush();
    if (finalCue) yield finalCue;
}

async function* decodeLines(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let carry = "";
    let firstLine = true;
    try {
        for await (const chunk of source) {
            carry +=
                typeof chunk === "string"
                    ? chunk
                    : decoder.decode(chunk as Uint8Array, { stream: true });
            let newline = carry.indexOf("\n");
            while (newline >= 0) {
                let line = carry.slice(0, newline);
                carry = carry.slice(newline + 1);
                if (line.endsWith("\r")) line = line.slice(0, -1);
                if (firstLine && line.startsWith("\uFEFF")) line = line.slice(1);
                firstLine = false;
                yield line;
                newline = carry.indexOf("\n");
            }
        }
        carry += decoder.decode();
    } catch (error) {
        if (error instanceof TypeError)
            throw new Error("Transcript source must be valid UTF-8.", { cause: error });
        throw error;
    }
    if (carry) {
        if (firstLine && carry.startsWith("\uFEFF")) carry = carry.slice(1);
        if (carry.endsWith("\r")) carry = carry.slice(0, -1);
        yield carry;
    }
}

function parseSubtitleTimeRange(line: string): [bigint, bigint] {
    const separator = line.indexOf("-->");
    if (separator < 0 || line.indexOf("-->", separator + 3) >= 0) {
        throw new Error("Subtitle cue must contain exactly one '-->' timestamp separator.");
    }
    const startText = line.slice(0, separator).trim();
    let endText = line.slice(separator + 3).trim();
    endText = endText.split(/[\t ]/u, 1)[0] ?? "";
    const start = parseTranscriptTimestamp(startText);
    const end = parseTranscriptTimestamp(endText);
    if (end < start)
        throw new Error("Subtitle cue timestamps are invalid or end before they start.");
    return [start, end];
}

function isVttMetadataBlock(lines: readonly string[]): boolean {
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

function validateCue(value: string): void {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff) {
                throw new Error("Transcript text must contain valid Unicode.");
            }
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw new Error("Transcript text must contain valid Unicode.");
        } else if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a)) {
            throw new Error("Transcript text contains unsupported control characters.");
        }
    }
    if (encoder.encode(value).byteLength > MAX_CUE_BYTES) {
        throw new Error("Transcript cue exceeds 16 MiB.");
    }
}

/** Commit parsed cues in bounded batches so earlier cues survive a late malformed record. */
export async function importTranscriptBatches(options: {
    source: AsyncIterable<Uint8Array | string>;
    format: TranscriptSourceFormat;
    sessionId: string;
    filename: string;
    expectedGeneration: bigint;
    commit: TranscriptBatchCommit;
    batchSize?: number;
}): Promise<{ imported: number; records: ArchiveRecord[]; generation: bigint }> {
    let generation = options.expectedGeneration;
    let imported = 0;
    const records: ArchiveRecord[] = [];
    for await (const cues of transcriptCueBatches(
        options.source,
        options.format,
        options.batchSize,
    )) {
        const batch = makeTranscriptRecords(
            options.sessionId,
            cues,
            options.format,
            options.filename,
        );
        const saved = await options.commit(batch, generation);
        generation += 1n;
        records.push(...saved);
        imported += cues.length;
    }
    return { imported, records, generation };
}
