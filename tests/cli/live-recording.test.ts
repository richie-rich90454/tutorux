import { describe, expect, it } from "vitest";
import { whisperAudio } from "../../frontend/domain/whisper";
import {
    APPLICATION_CAPTURE_FORMAT,
    buildCapturePreview,
    captureBytesPerSample,
    captureFormatFromNativeDevice,
    parseCaptureFormatLine,
    sameCaptureFormat,
    type LiveCaptureFormat,
} from "../../cli/live-recording";

describe("native capture format metadata", () => {
    it("maps helper device formats to archive sample formats", () => {
        expect(
            captureFormatFromNativeDevice({
                sampleFormat: "F32",
                sampleRateHz: 48_000,
                channelCount: 2,
            }),
        ).toEqual({
            sampleFormat: "pcm_f32le",
            sampleRateHz: 48_000,
            channelCount: 2,
        });
        expect(
            captureFormatFromNativeDevice({
                sampleFormat: "S16LE",
                sampleRateHz: 44_100,
                channelCount: 1,
            }),
        ).toEqual({
            sampleFormat: "pcm_s16le",
            sampleRateHz: 44_100,
            channelCount: 1,
        });
        expect(captureFormatFromNativeDevice({ sampleFormat: "DSD" })).toBeUndefined();
        expect(
            captureFormatFromNativeDevice({ sampleFormat: "F32", sampleRateHz: 0 }),
        ).toBeUndefined();
    });

    it("reads the format announced by the native helper", () => {
        const line =
            'tutorux-audio-helper: capture-format {"sampleFormat":"pcm_s24le","sampleRateHz":44100,"channelCount":2,"bytesPerSample":3}';
        expect(parseCaptureFormatLine(line)).toEqual({
            sampleFormat: "pcm_s24le",
            sampleRateHz: 44_100,
            channelCount: 2,
        });
        expect(
            parseCaptureFormatLine("tutorux-audio-helper: capture-format not-json"),
        ).toBeUndefined();
        expect(
            parseCaptureFormatLine(
                'tutorux-audio-helper: capture-format {"sampleFormat":"pcm_s16le","sampleRateHz":48000,"channelCount":9}',
            ),
        ).toBeUndefined();
    });

    it("keeps the announced application format and sample widths consistent", () => {
        expect(APPLICATION_CAPTURE_FORMAT).toEqual({
            sampleFormat: "pcm_f32le",
            sampleRateHz: 48_000,
            channelCount: 2,
        });
        expect(
            sameCaptureFormat(APPLICATION_CAPTURE_FORMAT, { ...APPLICATION_CAPTURE_FORMAT }),
        ).toBe(true);
        expect(
            sameCaptureFormat(APPLICATION_CAPTURE_FORMAT, {
                ...APPLICATION_CAPTURE_FORMAT,
                channelCount: 1,
            }),
        ).toBe(false);
        expect(captureBytesPerSample("pcm_u8")).toBe(1);
        expect(captureBytesPerSample("pcm_s24le")).toBe(3);
        expect(captureBytesPerSample("pcm_f32le")).toBe(4);
    });
});

describe("live Whisper previews", () => {
    it("keeps native metadata and resamples 48 kHz stereo to 16 kHz mono", () => {
        const frames = 4_800;
        const pcm = new Uint8Array(frames * 2 * 2);
        const view = new DataView(pcm.buffer);
        for (let frame = 0; frame < frames; frame++) {
            view.setInt16(frame * 4, 16_384, true);
            view.setInt16(frame * 4 + 2, 16_384, true);
        }
        const format: LiveCaptureFormat = {
            sampleFormat: "pcm_s16le",
            sampleRateHz: 48_000,
            channelCount: 2,
        };
        const preview = buildCapturePreview(pcm, 1_234n, format);
        expect(preview).toMatchObject({
            sampleRateHz: 48_000,
            channelCount: 2,
            frameCount: frames,
            startFrame: 1_234n,
        });

        const converted = whisperAudio(preview);
        const convertedView = new DataView(converted.buffer);
        expect(convertedView.getUint32(24, true)).toBe(16_000);
        expect(convertedView.getUint16(22, true)).toBe(1);
        expect(convertedView.getUint32(40, true)).toBe(1_600 * 2);
        for (let offset = 44; offset < converted.byteLength; offset += 2) {
            expect(convertedView.getInt16(offset, true)).toBe(16_384);
        }
    });

    it("downmixes mixed channel counts before transcription", () => {
        for (const [channels, samples, expected] of [
            [1, [10_000], 10_000],
            [2, [10_000, 30_000], 20_000],
            [3, [1_000, 2_000, 3_000], 2_000],
        ] as const) {
            const pcm = new Uint8Array(samples.length * 2);
            const view = new DataView(pcm.buffer);
            samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
            const preview = buildCapturePreview(pcm, 0n, {
                sampleFormat: "pcm_s16le",
                sampleRateHz: 16_000,
                channelCount: channels,
            });
            const converted = whisperAudio(preview);
            expect(new DataView(converted.buffer).getInt16(44, true)).toBe(expected);
        }
    });

    it("decodes u8, s24, s32, and f32 capture samples", () => {
        const cases: Array<[LiveCaptureFormat["sampleFormat"], Uint8Array, number]> = [
            ["pcm_u8", Uint8Array.of(192), 16_384],
            ["pcm_s24le", Uint8Array.of(0x00, 0x00, 0x40), 16_384],
            ["pcm_s32le", Uint8Array.of(0x00, 0x00, 0x00, 0x40), 16_384],
            ["pcm_f32le", new Uint8Array(new Float32Array([0.5]).buffer), 16_384],
        ];
        for (const [sampleFormat, pcm, expected] of cases) {
            const preview = buildCapturePreview(pcm, 0n, {
                sampleFormat,
                sampleRateHz: 48_000,
                channelCount: 1,
            });
            expect(preview.frameCount).toBe(1);
            expect(new DataView(preview.wav.buffer).getInt16(44, true)).toBe(expected);
        }
    });
});
