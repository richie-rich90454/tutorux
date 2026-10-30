import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
} from "../../frontend/archive/archive";
import { crc32, RecordType } from "../../frontend/archive/format";
import { sourceStream } from "../../frontend/archive/source";

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, "showOpenFilePicker", {
            configurable: true,
            value: undefined,
        });
        Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            value: undefined,
        });
    });
    await page.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.hostname !== "127.0.0.1" || requestUrl.port !== "1420") {
            await route.continue();
            return;
        }
        const response = await fetch(requestUrl);
        await route.fulfill({
            status: response.status,
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            body: Buffer.from(await response.arrayBuffer()),
        });
    });
});

test("plays the matching archive audio from a transcript timestamp", async ({ page }, testInfo) => {
    const archivePath = testInfo.outputPath("audio-session.tux");
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, await makeAudioArchive());

    await page.goto("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await (await chooser).setFiles(archivePath);
    await expect(page.locator(".archive-status.is-open")).toBeVisible();

    await page.getByRole("button", { name: "Transcripts", exact: true }).click();
    await expect(page.locator(".transcript-cue-text")).toHaveText(
        "A short audio sample for playback.",
    );
    await expect(page.locator(".transcript-audio-copy strong")).toHaveText("Microphone");
    await page.getByRole("button", { name: "Listen from cue" }).click();

    const player = page.locator(".transcript-audio-panel audio");
    await expect(player).toHaveAttribute("src", /^blob:/u);
    await expect
        .poll(() => player.evaluate((element: HTMLAudioElement) => element.duration))
        .toBeGreaterThan(0.7);
    await expect
        .poll(() => player.evaluate((element: HTMLAudioElement) => element.duration))
        .toBeLessThan(0.8);
});

test("imports a WAV file into a session and plays it from a cue", async ({ page }, testInfo) => {
    const archivePath = testInfo.outputPath("empty-audio-session.tux");
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, await makeAudioArchive(false));

    await page.goto("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await (await chooser).setFiles(archivePath);
    await page.locator(".archive-status.is-open").waitFor();
    await page.getByRole("button", { name: "Transcripts", exact: true }).click();
    await page.getByLabel("Choose WAV audio file").setInputFiles({
        name: "lesson.wav",
        mimeType: "audio/wav",
        buffer: makeWaveBytes(),
    });

    await expect(page.locator(".transcript-audio-copy strong")).toHaveText("lesson.wav");
    await page.getByRole("button", { name: "Listen from cue" }).click();
    const player = page.locator(".transcript-audio-panel audio");
    await expect(player).toHaveAttribute("src", /^blob:/u);
    await expect
        .poll(() => player.evaluate((element: HTMLAudioElement) => element.duration))
        .toBeGreaterThan(0.7);
    const wavDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export WAV" }).click();
    const downloaded = await wavDownload;
    expect(downloaded.suggestedFilename()).toBe("lesson.wav");
    const downloadPath = await downloaded.path();
    if (!downloadPath) throw new Error("The WAV export did not create a download file.");
    const exported = await readFile(downloadPath);
    expect(exported.toString("ascii", 0, 4)).toBe("RIFF");
    expect(exported.readUInt32LE(40)).toBe(16_000);
});

test("manages recording take and track names and restores trashed audio", async ({
    page,
}, testInfo) => {
    const archivePath = testInfo.outputPath("recording-take.tux");
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, await makeAudioArchive());

    await page.goto("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await (await chooser).setFiles(archivePath);
    await page.locator(".archive-status.is-open").waitFor();
    await page.getByRole("button", { name: "Transcripts", exact: true }).click();

    await expect(page.getByRole("region", { name: "Recording takes" })).toBeVisible();
    await page.getByLabel("Recording take name").fill("Review take");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Recording take renamed.")).toBeVisible();
    await expect(page.getByLabel("Recording take name")).toHaveValue("Review take");
    const trackName = page.getByLabel("Track name: Microphone");
    await trackName.fill("Tutor mic");
    await expect(trackName).toHaveValue("Tutor mic");
    const saveTrackName = page.getByRole("button", { name: "Save track name" });
    await expect(saveTrackName).toBeEnabled();
    await saveTrackName.click();
    await expect(page.getByLabel("Track name: Tutor mic")).toHaveValue("Tutor mic");

    await page.getByRole("button", { name: "Move to Trash" }).click();
    await expect(
        page.getByText("Moved to Trash with its audio tracks and timeline data."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Restore take" }).click();
    await expect(page.getByLabel("Recording take name")).toHaveValue("Review take");
    await expect(page.locator(".transcript-audio-copy strong")).toHaveText("Tutor mic");
});

async function makeAudioArchive(includeAudio = true): Promise<Uint8Array> {
    const sessionId = crypto.randomUUID();
    const takeId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const transcriptId = crypto.randomUUID();
    const pcm = new Uint8Array(8_000 * 2);
    const pcmView = new DataView(pcm.buffer);
    for (let frame = 0; frame < 8_000; frame += 1) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / 8_000) * 8_000);
        pcmView.setInt16(frame * 2, sample, true);
    }
    const sessionFields: Record<string, string> = {
        student_id: "anonymous",
        title: "Audio playback sample",
        subject: "Listening check",
        session_state: "completed",
        archived: "false",
        started_at_us: "1000000",
        recording_source: "microphone",
        recording_state: "completed",
    };
    if (includeAudio) {
        Object.assign(sessionFields, {
            recording_track_id: trackId,
            recording_track_ids: trackId,
            recording_track_count: "1",
            recording_sample_format: "pcm_s16le",
            recording_sample_rate_hz: "8000",
            recording_channel_count: "1",
        });
    }
    const session = record(RecordType.session, sessionId, sessionFields);
    const track = record(RecordType.assetMetadata, trackId, {
        record_role: "audio-track",
        session_id: sessionId,
        track_id: trackId,
        recording_take_id: takeId,
        label: "Microphone",
        source: "microphone",
        state: "completed",
        sample_format: "pcm_s16le",
        sample_rate_hz: "8000",
        channel_count: "1",
        chunk_count: "1",
    });
    const take = record(RecordType.assetMetadata, takeId, {
        record_role: "recording-take",
        session_id: sessionId,
        track_ids: trackId,
        label: "Microphone take",
        source: "microphone",
        state: "completed",
    });
    const audio = record(
        RecordType.audioChunk,
        crypto.randomUUID(),
        {
            session_id: sessionId,
            track_id: trackId,
            sequence_number: "0",
            first_sample_index: "0",
            sample_count: "8000",
            gap_before_samples: "0",
            timeline_start_us: "0",
            timeline_end_us: "1000000",
            sample_format: "pcm_s16le",
            sample_rate_hz: "8000",
            channel_count: "1",
            codec: "none",
            payload_checksum: String(crc32(pcm)),
        },
        pcm,
    );
    const transcript = record(RecordType.transcriptSegment, transcriptId, {
        session_id: sessionId,
        source_index: "0",
        text: "A short audio sample for playback.",
        start_time_us: "250000",
        end_time_us: "500000",
        timestamp_state: "source-timestamp",
        verification_state: "human-verified",
    });
    const initial = await openArchiveBytes(await createArchiveBytes("Audio test archive"));
    const records = includeAudio
        ? [session, track, take, audio, transcript]
        : [session, transcript];
    const snapshot = await appendRecords(initial, records);
    const buffer = await new Response(sourceStream(snapshot.source)).arrayBuffer();
    return new Uint8Array(buffer);
}

function makeWaveBytes(): Buffer {
    const sampleRate = 8_000;
    const pcm = Buffer.alloc(sampleRate * 2);
    for (let frame = 0; frame < sampleRate; frame += 1) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 8_000);
        pcm.writeInt16LE(sample, frame * 2);
    }
    const format = Buffer.alloc(16);
    format.writeUInt16LE(1, 0);
    format.writeUInt16LE(1, 2);
    format.writeUInt32LE(sampleRate, 4);
    format.writeUInt32LE(sampleRate * 2, 8);
    format.writeUInt16LE(2, 12);
    format.writeUInt16LE(16, 14);
    const chunk = (name: string, payload: Buffer): Buffer => {
        const header = Buffer.alloc(8);
        header.write(name, 0, "ascii");
        header.writeUInt32LE(payload.byteLength, 4);
        return Buffer.concat([
            header,
            payload,
            ...(payload.byteLength % 2 ? [Buffer.alloc(1)] : []),
        ]);
    };
    const body = Buffer.concat([
        Buffer.from("WAVE", "ascii"),
        chunk("fmt ", format),
        chunk("data", pcm),
    ]);
    const header = Buffer.alloc(8);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(body.byteLength, 4);
    return Buffer.concat([header, body]);
}

function record(type: number, id: string, fields: Record<string, string>, blob = new Uint8Array()) {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob,
    };
}
