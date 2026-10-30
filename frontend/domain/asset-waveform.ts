export const MAX_MATERIAL_AUDIO_PREVIEW_BYTES = 24 * 1024 * 1024;

export interface AssetWaveformBucket {
    readonly position: number;
    readonly width: number;
    readonly minimum: number;
    readonly maximum: number;
}

export interface PcmWavAssetWaveform {
    readonly sampleRateHz: number;
    readonly channelCount: number;
    readonly bitsPerSample: number;
    readonly durationSeconds: number;
    readonly silent: boolean;
    readonly buckets: readonly AssetWaveformBucket[];
}

/** Read a bounded integer PCM WAV into the same compact min/max waveform used by the legacy UI. */
export function buildPcmWavAssetWaveform(bytes: Uint8Array): PcmWavAssetWaveform | null {
    if (
        bytes.byteLength < 44 ||
        bytes.byteLength > MAX_MATERIAL_AUDIO_PREVIEW_BYTES ||
        !hasAscii(bytes, 0, "RIFF") ||
        !hasAscii(bytes, 8, "WAVE")
    ) {
        return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declaredEnd = view.getUint32(4, true) + 8;
    if (declaredEnd > bytes.byteLength || declaredEnd < 44) return null;

    let format = 0;
    let channelCount = 0;
    let bitsPerSample = 0;
    let blockAlign = 0;
    let sampleRateHz = 0;
    let dataOffset = 0;
    let dataLength = 0;
    for (let offset = 12; offset + 8 <= declaredEnd;) {
        const chunkLength = view.getUint32(offset + 4, true);
        const chunkStart = offset + 8;
        if (chunkLength > declaredEnd - chunkStart) return null;
        if (hasAscii(bytes, offset, "fmt ") && chunkLength >= 16) {
            format = view.getUint16(chunkStart, true);
            channelCount = view.getUint16(chunkStart + 2, true);
            sampleRateHz = view.getUint32(chunkStart + 4, true);
            blockAlign = view.getUint16(chunkStart + 12, true);
            bitsPerSample = view.getUint16(chunkStart + 14, true);
        } else if (hasAscii(bytes, offset, "data") && dataLength === 0) {
            dataOffset = chunkStart;
            dataLength = chunkLength;
        }

        const paddedLength = chunkLength + (chunkLength & 1);
        if (paddedLength > declaredEnd - chunkStart) return null;
        offset = chunkStart + paddedLength;
    }

    const bytesPerSample = bitsPerSample / 8;
    if (
        format !== 1 ||
        channelCount < 1 ||
        channelCount > 8 ||
        sampleRateHz === 0 ||
        ![8, 16, 24, 32].includes(bitsPerSample) ||
        bytesPerSample * channelCount !== blockAlign ||
        dataOffset === 0 ||
        dataLength < blockAlign ||
        dataLength % blockAlign !== 0
    ) {
        return null;
    }

    const frameCount = dataLength / blockAlign;
    const bucketCount = Math.min(56, frameCount);
    if (bucketCount === 0) return null;
    const buckets: AssetWaveformBucket[] = [];
    let silent = true;
    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
        const firstFrame = Math.floor((bucketIndex * frameCount) / bucketCount);
        const lastFrame = Math.max(
            firstFrame + 1,
            Math.floor(((bucketIndex + 1) * frameCount) / bucketCount),
        );
        let minimum = 0;
        let maximum = 0;
        for (let frame = firstFrame; frame < Math.min(lastFrame, frameCount); frame += 1) {
            const frameOffset = dataOffset + frame * blockAlign;
            for (let channel = 0; channel < channelCount; channel += 1) {
                const sampleOffset = frameOffset + channel * bytesPerSample;
                const normalized = readNormalizedSample(view, sampleOffset, bitsPerSample);
                minimum = Math.min(minimum, normalized);
                maximum = Math.max(maximum, normalized);
            }
        }
        silent &&= minimum === 0 && maximum === 0;
        buckets.push({
            position: firstFrame / frameCount,
            width: (Math.min(lastFrame, frameCount) - firstFrame) / frameCount,
            minimum,
            maximum,
        });
    }

    return {
        sampleRateHz,
        channelCount,
        bitsPerSample,
        durationSeconds: frameCount / sampleRateHz,
        silent,
        buckets,
    };
}

function readNormalizedSample(view: DataView, offset: number, bits: number): number {
    if (bits === 8) return (view.getUint8(offset) - 128) / 128;
    if (bits === 16) return view.getInt16(offset, true) / 32_768;
    if (bits === 24) {
        let value =
            view.getUint8(offset) |
            (view.getUint8(offset + 1) << 8) |
            (view.getUint8(offset + 2) << 16);
        if (value >= 0x80_0000) value -= 0x100_0000;
        return value / 8_388_608;
    }
    return view.getInt32(offset, true) / 2_147_483_648;
}

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        if (bytes[offset + index] !== value.charCodeAt(index)) return false;
    }
    return true;
}
