import { describe, expect, it } from "vitest";
import {
    buildPcmWavAssetWaveform,
    MAX_MATERIAL_AUDIO_PREVIEW_BYTES,
} from "../../../frontend/domain/asset-waveform";

function ascii(bytes: Uint8Array, offset: number, value: string): void {
    for (let index = 0; index < value.length; index += 1)
        bytes[offset + index] = value.charCodeAt(index);
}

function chunk(id: string, payload: Uint8Array, declaredLength = payload.length): Uint8Array {
    const padded = payload.length + (payload.length & 1);
    const bytes = new Uint8Array(8 + padded);
    ascii(bytes, 0, id);
    new DataView(bytes.buffer).setUint32(4, declaredLength, true);
    bytes.set(payload, 8);
    return bytes;
}

function wav(parts: Uint8Array[], riffSize?: number): Uint8Array {
    const total = 12 + parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    ascii(bytes, 0, "RIFF");
    view.setUint32(4, riffSize ?? total - 8, true);
    ascii(bytes, 8, "WAVE");
    let offset = 12;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}

function fmt(
    options: {
        format?: number;
        channels?: number;
        sampleRate?: number;
        bits?: number;
        blockAlign?: number;
    } = {},
): Uint8Array {
    const channels = options.channels ?? 1;
    const sampleRate = options.sampleRate ?? 8000;
    const bits = options.bits ?? 16;
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setUint16(0, options.format ?? 1, true);
    view.setUint16(2, channels, true);
    view.setUint32(4, sampleRate, true);
    view.setUint32(8, (sampleRate * channels * bits) / 8, true);
    view.setUint16(12, options.blockAlign ?? (channels * bits) / 8, true);
    view.setUint16(14, bits, true);
    return chunk("fmt ", payload);
}

function pcm16(values: number[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, true));
    return bytes;
}

function pcm8(values: number[]): Uint8Array {
    return Uint8Array.from(values);
}

function pcm24(values: number[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 3);
    values.forEach((value, index) => {
        const unsigned = value < 0 ? value + 0x100_0000 : value;
        bytes[index * 3] = unsigned & 0xff;
        bytes[index * 3 + 1] = (unsigned >> 8) & 0xff;
        bytes[index * 3 + 2] = (unsigned >> 16) & 0xff;
    });
    return bytes;
}

function pcm32(values: number[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt32(index * 4, value, true));
    return bytes;
}

describe("PCM WAV waveform building", () => {
    it("rejects files outside the accepted container bounds", () => {
        expect(buildPcmWavAssetWaveform(new Uint8Array(0))).toBe(null);
        expect(buildPcmWavAssetWaveform(new Uint8Array(43))).toBe(null);
        expect(buildPcmWavAssetWaveform(new Uint8Array(MAX_MATERIAL_AUDIO_PREVIEW_BYTES + 1))).toBe(
            null,
        );
    });

    it("rejects non-RIFF and non-WAVE containers", () => {
        const noRiff = wav([fmt(), chunk("data", pcm16([0]))]);
        ascii(noRiff, 0, "RIFX");
        expect(buildPcmWavAssetWaveform(noRiff)).toBe(null);
        const noWave = wav([fmt(), chunk("data", pcm16([0]))]);
        ascii(noWave, 8, "WAVX");
        expect(buildPcmWavAssetWaveform(noWave)).toBe(null);
    });

    it("rejects inconsistent RIFF sizes", () => {
        const tooLong = wav([fmt(), chunk("data", pcm16([0]))]);
        new DataView(tooLong.buffer).setUint32(4, tooLong.byteLength + 100, true);
        expect(buildPcmWavAssetWaveform(tooLong)).toBe(null);
        const tooShort = wav([chunk("junk", new Uint8Array(32))], 4);
        expect(buildPcmWavAssetWaveform(tooShort)).toBe(null);
    });

    it("rejects chunks that exceed the declared container", () => {
        const bytes = wav([fmt(), chunk("data", pcm16([0]), 500)]);
        expect(buildPcmWavAssetWaveform(bytes)).toBe(null);
        const unpadded = wav([fmt(), chunk("data", new Uint8Array(3))], 39);
        expect(buildPcmWavAssetWaveform(unpadded)).toBe(null);
    });

    it("ignores undersized format chunks and later data chunks", () => {
        expect(
            buildPcmWavAssetWaveform(
                wav([chunk("fmt ", new Uint8Array(14)), chunk("junk", new Uint8Array(24))]),
            ),
        ).toBe(null);
        const bytes = wav([fmt(), chunk("data", pcm16([16384])), chunk("data", pcm16([-16384]))]);
        const result = buildPcmWavAssetWaveform(bytes)!;
        expect(result.buckets).toHaveLength(1);
        expect(result.buckets[0]!.maximum).toBeCloseTo(0.5);
    });

    it("builds 16-bit mono waveforms", () => {
        const result = buildPcmWavAssetWaveform(
            wav([fmt(), chunk("data", pcm16([32767, -32768]))]),
        )!;
        expect(result.sampleRateHz).toBe(8000);
        expect(result.channelCount).toBe(1);
        expect(result.bitsPerSample).toBe(16);
        expect(result.durationSeconds).toBe(2 / 8000);
        expect(result.silent).toBe(false);
        expect(result.buckets).toHaveLength(2);
        expect(result.buckets[0]).toEqual({
            position: 0,
            width: 0.5,
            minimum: 0,
            maximum: 32767 / 32768,
        });
        expect(result.buckets[1]!.minimum).toBe(-1);
    });

    it("builds 8-bit unsigned waveforms and detects silence", () => {
        const loud = buildPcmWavAssetWaveform(
            wav([fmt({ bits: 8 }), chunk("data", pcm8([0, 255, 128]))]),
        )!;
        expect(loud.bitsPerSample).toBe(8);
        expect(loud.buckets[0]!.minimum).toBe(-1);
        expect(loud.buckets[1]!.maximum).toBeCloseTo(127 / 128);
        const silent = buildPcmWavAssetWaveform(
            wav([fmt({ bits: 8 }), chunk("data", pcm8([128, 128]))]),
        )!;
        expect(silent.silent).toBe(true);
    });

    it("builds 24-bit signed and 32-bit waveforms", () => {
        const wave24 = buildPcmWavAssetWaveform(
            wav([fmt({ bits: 24 }), chunk("data", pcm24([-0x80_0000, 0x7f_ffff]))]),
        )!;
        expect(wave24.buckets[0]!.minimum).toBe(-1);
        expect(wave24.buckets[1]!.maximum).toBeCloseTo(8_388_607 / 8_388_608);
        const wave32 = buildPcmWavAssetWaveform(
            wav([fmt({ bits: 32 }), chunk("data", pcm32([-2_147_483_648, 2_147_483_647]))]),
        )!;
        expect(wave32.buckets[0]!.minimum).toBe(-1);
        expect(wave32.buckets[1]!.maximum).toBeCloseTo(2_147_483_647 / 2_147_483_648);
    });

    it("combines channels per frame", () => {
        const result = buildPcmWavAssetWaveform(
            wav([fmt({ channels: 2 }), chunk("data", pcm16([16384, -16384, 0, 32767]))]),
        )!;
        expect(result.channelCount).toBe(2);
        expect(result.buckets).toHaveLength(2);
        expect(result.buckets[0]!.minimum).toBe(-0.5);
        expect(result.buckets[0]!.maximum).toBe(0.5);
    });

    it("caps long recordings at 56 buckets", () => {
        const frames = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? 100 : -100));
        const result = buildPcmWavAssetWaveform(wav([fmt(), chunk("data", pcm16(frames))]))!;
        expect(result.buckets).toHaveLength(56);
        expect(result.buckets[0]!.position).toBe(0);
        expect(result.buckets.at(-1)!.position + result.buckets.at(-1)!.width).toBeCloseTo(1);
        expect(result.silent).toBe(false);
    });

    it.each([
        ["unsupported format", { format: 3 }],
        ["no channels", { channels: 0 }],
        ["too many channels", { channels: 9 }],
        ["zero sample rate", { sampleRate: 0 }],
        ["unsupported bit depth", { bits: 12 }],
        ["mismatched block align", { blockAlign: 4 }],
    ] as const)("rejects %s", (_label, options) => {
        const bytes = wav([fmt(options), chunk("data", pcm16([0]))]);
        expect(buildPcmWavAssetWaveform(bytes)).toBe(null);
    });

    it("rejects missing, short, and misaligned data chunks", () => {
        expect(buildPcmWavAssetWaveform(wav([fmt()]))).toBe(null);
        expect(buildPcmWavAssetWaveform(wav([fmt(), chunk("data", new Uint8Array(1))]))).toBe(null);
        expect(buildPcmWavAssetWaveform(wav([fmt(), chunk("data", new Uint8Array(3))]))).toBe(null);
    });
});
