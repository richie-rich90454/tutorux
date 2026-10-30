import { buildAudioTrackWavStream } from "../frontend/domain/audio";
import type { ArchiveSnapshot } from "../frontend/archive/archive";

/** Summarize the same validated PCM stream used by WAV export. */
export async function summarizeWaveform(
    snapshot: ArchiveSnapshot,
    sessionId: string,
    trackId: string,
    bucketLimit: number,
) {
    const metadata = await snapshot.listAudioChunkMetadata(sessionId, trackId);
    if (!metadata.length) throw new Error("This track has no saved audio.");
    const last = metadata.at(-1)!;
    const endFrame =
        BigInt(last.fields.get("first_sample_index") ?? "0") +
        BigInt(last.fields.get("sample_count") ?? "0");
    if (endFrame <= 0n || endFrame > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("The audio timeline cannot be summarized.");
    const frameCount = Number(endFrame);
    const count = Math.min(frameCount, bucketLimit);
    const first = metadata[0]!;
    const format = first.fields.get("sample_format") ?? "";
    const channels = Number(first.fields.get("channel_count"));
    const rate = Number(first.fields.get("sample_rate_hz"));
    const bytesPerSample =
        format === "pcm_u8" ? 1 : format === "pcm_s16le" ? 2 : format === "pcm_s24le" ? 3 : 4;
    const buckets = Array.from({ length: count }, (_, index) => ({
        track_id: trackId,
        sample_rate_hz: rate,
        channel_count: channels,
        bucket: index,
        start_frame: Math.floor((index * frameCount) / count),
        end_frame: Math.floor(((index + 1) * frameCount) / count),
        minimum: 32767,
        maximum: -32768,
        contains_gap: false,
    }));
    for (const chunk of metadata) {
        const start = Number(chunk.fields.get("first_sample_index") ?? "0");
        const gap = Number(chunk.fields.get("gap_before_samples") ?? "0");
        if (gap)
            for (const bucket of buckets)
                if (bucket.start_frame < start && bucket.end_frame > start - gap)
                    bucket.contains_gap = true;
    }
    const reader = (await buildAudioTrackWavStream(snapshot, sessionId, trackId)).getReader();
    let frame = 0;
    let header = true;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (header) {
                header = false;
                continue;
            }
            const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
            const stride = channels * bytesPerSample;
            for (let offset = 0; offset < value.length; offset += stride, frame++) {
                const bucket =
                    buckets[
                        Math.min(count - 1, Math.floor(((frame + 1) * count - 1) / frameCount))
                    ]!;
                for (let channel = 0; channel < channels; channel++) {
                    const at = offset + channel * bytesPerSample;
                    let sample: number;
                    switch (format) {
                        case "pcm_u8":
                            sample = (value[at]! - 128) * 256;
                            break;
                        case "pcm_s16le":
                            sample = view.getInt16(at, true);
                            break;
                        case "pcm_s24le": {
                            let v = value[at]! | (value[at + 1]! << 8) | (value[at + 2]! << 16);
                            if (v & 0x800000) v |= 0xff000000;
                            sample = Math.round(v / 256);
                            break;
                        }
                        case "pcm_s32le":
                            sample = Math.round(view.getInt32(at, true) / 65536);
                            break;
                        case "pcm_f32le": {
                            const v = view.getFloat32(at, true);
                            sample = Number.isFinite(v) ? Math.round(v * 32768) : 0;
                            break;
                        }
                        default:
                            throw new Error("Unsupported audio format.");
                    }
                    sample = Math.max(-32768, Math.min(32767, sample));
                    bucket.minimum = Math.min(bucket.minimum, sample);
                    bucket.maximum = Math.max(bucket.maximum, sample);
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
    return buckets;
}
