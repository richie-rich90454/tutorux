import { invoke, isTauri } from "@tauri-apps/api/core";
import { createSignal, onCleanup, Show } from "solid-js";
import { newUuid } from "./archive/format";
import type { ArchiveRecord } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import { buildAudioPreview, type AudioPreview } from "./domain/audio";
import { makeWhisperRecords, whisperAudio } from "./domain/whisper";

interface Props {
    snapshot: ArchiveSnapshot;
    preview: AudioPreview | null;
    sessionId: string;
    trackId: string;
    records: readonly ArchiveRecord[];
    disabled: boolean;
    onSave: (
        records: ArchiveRecord[],
        message: string,
        snapshot: ArchiveSnapshot,
    ) => Promise<boolean>;
}

/** Transcribe the current audio preview with the model embedded in the desktop app. */
export function WhisperTranscription(props: Props) {
    const [language, setLanguage] = createSignal("auto");
    const [busy, setBusy] = createSignal(false);
    const [fullTrack, setFullTrack] = createSignal(true);
    const [refine, setRefine] = createSignal(false);
    const [message, setMessage] = createSignal("");
    const [error, setError] = createSignal("");
    let runId: string | undefined;
    let cancelled = false;
    const cancel = () => {
        cancelled = true;
        if (runId) void invoke("cancel_whisper_run", { runId }).catch(() => undefined);
    };
    onCleanup(cancel);
    const transcribe = async () => {
        setBusy(true);
        setError("");
        setMessage("");
        cancelled = false;
        let savedRecords = 0;
        let committedWindows = 0;
        try {
            const sourcePreview = props.preview;
            let snapshot = props.snapshot;
            const sessionId = props.sessionId;
            const trackId = props.trackId;
            const selectedLanguage = language().trim();
            const replacement = refine();
            const wholeTrack = fullTrack();
            const existing = props.records;
            const provenanceRunId = newUuid();
            const preview =
                sourcePreview ??
                (!wholeTrack
                    ? await buildAudioPreview(snapshot, sessionId, trackId, 0n, 30_000_000n)
                    : null);
            let endUs = 0n;
            let windowUs = 20_000_000n;
            if (wholeTrack) {
                const chunks = await snapshot.listAudioChunkMetadata(sessionId, trackId);
                const last = chunks.at(-1);
                const firstFrame = last?.fields.get("first_sample_index") ?? "";
                const frameCount = last?.fields.get("sample_count") ?? "";
                const rate = last?.fields.get("sample_rate_hz") ?? "";
                const channels = last?.fields.get("channel_count") ?? "";
                if (
                    !/^\d+$/.test(firstFrame) ||
                    !/^\d+$/.test(frameCount) ||
                    !/^\d+$/.test(rate) ||
                    !/^\d+$/.test(channels) ||
                    BigInt(rate) === 0n ||
                    BigInt(channels) === 0n
                ) {
                    throw new Error("The selected recording has invalid audio metadata.");
                }
                endUs =
                    ((BigInt(firstFrame) + BigInt(frameCount)) * 1_000_000n + BigInt(rate) - 1n) /
                    BigInt(rate);
                const seconds = (28n * 1024n * 1024n) / (BigInt(rate) * BigInt(channels) * 2n);
                if (seconds < 1n)
                    throw new Error(
                        "This recording format exceeds the transcription window limit.",
                    );
                windowUs = (seconds < 20n ? seconds : 20n) * 1_000_000n;
            }
            runId = await invoke<string>("begin_whisper_run");
            if (cancelled) {
                await invoke("cancel_whisper_run", { runId });
                throw new Error("Transcription cancelled.");
            }
            const changes = new Map<string, ArchiveRecord>();
            let skipped = 0;
            let cursor = 0n;
            let windows = 0;
            const committedIds = new Set<string>();
            const commitChanges = async (): Promise<void> => {
                if (!changes.size) return;
                const records = [...changes.values()].filter(
                    (record) => !committedIds.has(record.id),
                );
                changes.clear();
                if (!records.length) return;
                try {
                    if (
                        !(await props.onSave(
                            records,
                            "Saved completed local transcription windows.",
                            snapshot,
                        ))
                    ) {
                        throw new Error("The completed transcription windows could not be saved.");
                    }
                } catch (error) {
                    for (const record of records) changes.set(record.id, record);
                    throw error;
                }
                for (const record of records) committedIds.add(record.id);
                snapshot = props.snapshot;
                savedRecords += records.length;
                committedWindows += 1;
            };
            do {
                if (cancelled) throw new Error("Transcription cancelled.");
                const current = wholeTrack
                    ? await buildAudioPreview(
                          snapshot,
                          sessionId,
                          trackId,
                          cursor,
                          cursor + windowUs,
                      )
                    : preview!;
                const output = await invoke<{ json: string; modelName: string }>(
                    "transcribe_whisper",
                    {
                        runId,
                        wav: Array.from(whisperAudio(current)),
                        language: selectedLanguage,
                    },
                );
                if (cancelled) throw new Error("Transcription cancelled.");
                if (
                    props.snapshot !== snapshot ||
                    props.preview !== sourcePreview ||
                    props.sessionId !== sessionId ||
                    props.trackId !== trackId
                ) {
                    throw new Error(
                        "The selected audio or archive changed during transcription. Load it again to retry.",
                    );
                }
                const result = makeWhisperRecords({
                    json: output.json,
                    sessionId,
                    trackId,
                    modelName: output.modelName,
                    language: selectedLanguage,
                    preview: current,
                    existing,
                    replaceProvisional: replacement,
                    runId: provenanceRunId,
                });
                for (const record of result.records) {
                    changes.set(record.id, record);
                }
                if (changes.size > 100_000)
                    throw new Error("The transcription produced too many cues for one operation.");
                skipped += result.skipped;
                windows++;
                cursor += windowUs;
                if (wholeTrack) {
                    await commitChanges();
                    setMessage(
                        `Saved ${committedWindows} completed audio window(s); ${savedRecords} cue change(s) durable so far.`,
                    );
                }
            } while (wholeTrack && cursor < endUs);
            if (wholeTrack) {
                await commitChanges();
                if (!savedRecords) {
                    setMessage(
                        `No new cues were found${skipped ? `; ${skipped} overlapped protected or out-of-range audio` : ""}.`,
                    );
                } else {
                    setMessage(
                        `Saved ${savedRecords} cue change(s) from ${windows} audio window(s)${skipped ? `; skipped ${skipped} protected or out-of-range cues` : ""}. Review provisional cues before reuse.`,
                    );
                }
                return;
            }
            const records = [...changes.values()];
            if (!records.length) {
                setMessage(
                    `No new cues were found${skipped ? `; ${skipped} overlapped protected or out-of-range audio` : ""}.`,
                );
                return;
            }
            if (await props.onSave(records, `Saved local transcription.`, snapshot)) {
                setMessage(
                    `Saved transcription${skipped ? `; skipped ${skipped} protected or out-of-range cues` : ""}. Review provisional cues before reuse.`,
                );
            }
        } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            setError(
                committedWindows > 0
                    ? `${message} ${savedRecords} cue change(s) from ${committedWindows} completed window(s) were already saved.`
                    : message,
            );
        } finally {
            if (runId) await invoke("end_whisper_run", { runId }).catch(() => undefined);
            runId = undefined;
            setBusy(false);
        }
    };
    return (
        <div class="transcript-whisper col-span-full min-w-0 rounded-panel border border-line bg-surface-subtle p-4">
            <strong>Transcribe this recording</strong>
            <Show
                when={isTauri()}
                fallback={<p>Local Whisper transcription is available in the desktop app.</p>}
            >
                <p>
                    Create timestamped cues from the full recording with Whisper running locally.
                    Review the cues below before using them.
                </p>
                <p class="transcript-whisper-model" role="status">
                    Bundled multilingual Whisper model · runs offline
                </p>
                <div class="transcript-whisper-actions">
                    <label>
                        <input
                            type="checkbox"
                            checked={fullTrack()}
                            disabled={busy()}
                            onChange={(event) => setFullTrack(event.currentTarget.checked)}
                        />{" "}
                        Entire track
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={refine()}
                            disabled={busy()}
                            onChange={(event) => setRefine(event.currentTarget.checked)}
                        />{" "}
                        Replace provisional Whisper cues
                    </label>
                    <label>
                        Language{" "}
                        <input
                            value={language()}
                            disabled={busy()}
                            onInput={(event) => setLanguage(event.currentTarget.value)}
                            aria-label="Whisper language code"
                        />
                    </label>
                    <button
                        class="button button-primary"
                        type="button"
                        disabled={props.disabled || busy()}
                        onClick={() => void transcribe()}
                    >
                        {busy()
                            ? "Transcribing…"
                            : fullTrack()
                              ? "Transcribe full recording"
                              : "Transcribe preview"}
                    </button>
                    <Show when={busy()}>
                        <button class="button button-outline" type="button" onClick={cancel}>
                            Cancel transcription
                        </button>
                    </Show>
                </div>
                <Show when={message()}>
                    <p role="status">{message()}</p>
                </Show>
                <Show when={error()}>
                    <p role="alert">{error()}</p>
                </Show>
            </Show>
        </div>
    );
}
