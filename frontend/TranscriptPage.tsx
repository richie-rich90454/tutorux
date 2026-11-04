import {
    buttonDanger,
    buttonOutline,
    buttonPrimary,
    buttonQuiet,
    cn,
    heading1,
    heading2,
    inputBase,
    labelBase,
    pageBody,
    selectBase,
    textareaBase,
} from "./ui";
import {
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    untrack,
    type JSX,
} from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { AudioWaveform } from "./AudioWaveform";
import { AudioMixer } from "./AudioMixer";
import { WhisperTranscription } from "./WhisperTranscription";
import { MicrophoneTrackRecorder } from "./MicrophoneTrackRecorder";
import { SynchronizedRecorder } from "./SynchronizedRecorder";
import { FullTrackWaveform } from "./FullTrackWaveform";
import { MAX_ASSET_BYTES } from "./domain/assets";
import { buildAudioPreview, type AudioPreview, type AudioTrackDescriptor } from "./domain/audio";
import {
    formatTranscriptTimestampUs,
    sortTranscriptRecords,
    type TranscriptExportFormat,
} from "./domain/transcript";
import { platform } from "@platform";
import { EmptyState, Icon } from "./shared-ui";
import {
    errorMessage,
    field,
    formatTimestamp,
    pluralize,
    safeBigInt,
    safeFileName,
} from "./shared-utils";

export function TranscriptPage(props: {
    snapshot: ArchiveSnapshot;
    sessions: ArchiveRecord[];
    records: ArchiveRecord[];
    assets: ArchiveRecord[];
    tracks: AudioTrackDescriptor[];
    recordingTakes: ArchiveRecord[];
    trashedRecordingTakes: ArchiveRecord[];
    trashedRecordingTracks: ArchiveRecord[];
    selectedSessionId: string;
    disabled: boolean;
    onSelectSession: (sessionId: string) => void;
    onNewSession: () => void;
    onImport: (file: File, sessionId: string) => void;
    onImportAudio: (file: File, sessionId: string, allowAdditionalTrack: boolean) => void;
    onImportCompressedAudio: (sessionId: string, allowAdditionalTrack: boolean) => void;
    onRecoverAudio: (sessionId: string) => void;
    onRecoverNativeAudio: (sessionId: string) => void;
    onRecordAudio: (file: File, sessionId: string, consentAtUs: string) => Promise<void>;
    onExportAudio: (
        sessionId: string,
        trackId: string,
        label: string,
        fillGapsWithSilence: boolean,
    ) => void;
    onRenameRecordingTake: (take: ArchiveRecord, label: string) => void;
    onRenameRecordingTrack: (track: AudioTrackDescriptor, label: string) => void;
    onTrashRecordingTrack: (track: AudioTrackDescriptor) => void;
    onRestoreRecordingTrack: (track: ArchiveRecord) => void;
    onTrashRecordingTake: (take: ArchiveRecord) => void;
    onRestoreRecordingTake: (take: ArchiveRecord) => void;
    onSaveMix: (
        snapshot: ArchiveSnapshot,
        records: ArchiveRecord[],
        message: string,
    ) => Promise<boolean>;
    onCheckpointPersisted: (snapshot: ArchiveSnapshot) => void;
    onSaveWhisper: (
        records: ArchiveRecord[],
        message: string,
        snapshot: ArchiveSnapshot,
    ) => Promise<boolean>;
    onExport: (sessionId: string, format: TranscriptExportFormat) => void;
    onSave: (
        record: ArchiveRecord,
        text: string,
        start: string,
        end: string,
        speaker: string,
    ) => void;
    onVerify: (record: ArchiveRecord) => void;
    onHistory: (record: ArchiveRecord) => Promise<ArchiveRecord[]>;
    onRestore: (record: ArchiveRecord, historyIndex: number) => Promise<boolean>;
    onSplit: (
        record: ArchiveRecord,
        beforeText: string,
        afterText: string,
        splitAt?: string,
    ) => Promise<boolean>;
    onMerge: (records: readonly ArchiveRecord[]) => Promise<boolean>;
    onLinkAssets: (record: ArchiveRecord, assetIds: readonly string[]) => Promise<boolean>;
}): JSX.Element {
    const [exportFormat, setExportFormat] = createSignal<TranscriptExportFormat>("text");
    const [trackId, setTrackId] = createSignal("");
    const [addSeparateTrack, setAddSeparateTrack] = createSignal(false);
    const [selectedCueIds, setSelectedCueIds] = createSignal<string[]>([]);
    const [captureConsent, setCaptureConsent] = createSignal(false);
    const [captureState, setCaptureState] = createSignal<
        "idle" | "requesting" | "recording" | "saving"
    >("idle");
    const [captureElapsed, setCaptureElapsed] = createSignal(0);
    const [captureError, setCaptureError] = createSignal("");
    const [audioUrl, setAudioUrl] = createSignal<string | null>(null);
    const [audioPreview, setAudioPreview] = createSignal<AudioPreview | null>(null);
    const [playbackError, setPlaybackError] = createSignal("");
    const selectedSession = createMemo(() =>
        props.sessions.find((session) => session.id === props.selectedSessionId),
    );
    const sessionRecords = createMemo(() => {
        const session = selectedSession();
        return session
            ? sortTranscriptRecords(
                  props.records.filter((record) => field(record, "session_id") === session.id),
              )
            : [];
    });
    const sessionTracks = createMemo(() => {
        const session = selectedSession();
        return session
            ? props.tracks.filter((track) => track.sessionId === session.id.toLowerCase())
            : [];
    });
    const sessionRecordingTakes = createMemo(() => {
        const session = selectedSession();
        return session
            ? props.recordingTakes.filter(
                  (take) => field(take, "session_id").toLowerCase() === session.id.toLowerCase(),
              )
            : [];
    });
    const trashedSessionRecordingTakes = createMemo(() => {
        const session = selectedSession();
        return session
            ? props.trashedRecordingTakes.filter(
                  (take) => field(take, "session_id").toLowerCase() === session.id.toLowerCase(),
              )
            : [];
    });
    const sessionAssets = createMemo(() => {
        const session = selectedSession();
        if (!session) return [];
        return props.assets.filter((asset) => {
            const role = field(asset, "record_role");
            const assetSessionId = field(asset, "session_id").toLowerCase();
            return (
                asset.type === RecordType.assetMetadata &&
                role !== "recording-take" &&
                role !== "audio-track" &&
                (field(asset, "filename") || field(asset, "blob_id")) &&
                (!assetSessionId || assetSessionId === session.id.toLowerCase())
            );
        });
    });
    const trashedSessionRecordingTracks = createMemo(() => {
        const session = selectedSession();
        if (!session) return [];
        const activeTakeIds = new Set(sessionRecordingTakes().map((take) => take.id.toLowerCase()));
        return props.trashedRecordingTracks.filter(
            (track) =>
                field(track, "session_id").toLowerCase() === session.id.toLowerCase() &&
                activeTakeIds.has(field(track, "recording_take_id").toLowerCase()),
        );
    });
    const [playbackPositionUs, setPlaybackPositionUs] = createSignal(0n);
    const [playbackOriginUs, setPlaybackOriginUs] = createSignal(0n);
    const activeCueId = createMemo(() => {
        const position = playbackPositionUs();
        let previous = "";
        for (const cue of sessionRecords()) {
            if (field(cue, "timestamp_state") === "not-timestamped") continue;
            const start = safeBigInt(field(cue, "start_time_us", "0"));
            const end = safeBigInt(field(cue, "end_time_us", "0"));
            if (start > position) continue;
            previous = cue.id;
            if (end > position) return cue.id;
        }
        return previous;
    });
    const selectedCues = createMemo(() => {
        const selected = new Set(selectedCueIds());
        return sessionRecords().filter((record) => selected.has(record.id));
    });
    const selectedTrack = createMemo(
        () => sessionTracks().find((track) => track.id === trackId()) ?? sessionTracks()[0] ?? null,
    );
    const sessionHasAudio = createMemo(() => {
        const session = selectedSession();
        return (
            sessionTracks().length > 0 ||
            ["recording_track_id", "recording_track_ids", "audio_import_track_id"].some((key) =>
                Boolean(session?.fields.get(key)?.trim()),
            )
        );
    });
    const recoverableWavImport = createMemo(() => {
        const session = selectedSession();
        if (!session || !field(session, "audio_import_track_id")) return false;
        return ["importing", "finalizing", "interrupted", "completed"].includes(
            field(session, "audio_import_state"),
        );
    });
    const recoverableNativeCapture = createMemo(() => {
        const session = selectedSession();
        return Boolean(
            session &&
            ["recording_track_id", "recording_track_ids"].some((key) => field(session, key).trim()),
        );
    });
    let fileInput: HTMLInputElement | undefined;
    let audioFileInput: HTMLInputElement | undefined;
    let audioPlayer: HTMLAudioElement | undefined;
    let detachAudioPlayer: (() => void) | undefined;
    let currentAudioUrl: string | null = null;
    let captureRecorder: MediaRecorder | undefined;
    let captureStream: MediaStream | undefined;
    let captureChunks: Blob[] = [];
    let captureTimer: number | undefined;
    let captureByteCount = 0;
    let captureStartedAt = 0;
    let captureConsentAtUs = "";
    let captureExceededLimit = false;
    let captureFailed = false;
    let captureCancelled = false;

    function clearAudio(): void {
        detachAudioPlayer?.();
        detachAudioPlayer = undefined;
        audioPlayer = undefined;
        if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
        setAudioUrl(null);
        setAudioPreview(null);
        setPlaybackPositionUs(0n);
        setPlaybackOriginUs(0n);
        setPlaybackError("");
    }

    function attachAudioPlayer(element: HTMLAudioElement): void {
        detachAudioPlayer?.();
        audioPlayer = element;
        const origin = playbackOriginUs();
        const update = (): void => {
            setPlaybackPositionUs(
                origin + BigInt(Math.max(0, Math.round(element.currentTime * 1_000_000))),
            );
        };
        element.addEventListener("timeupdate", update);
        element.addEventListener("seeked", update);
        element.addEventListener("loadedmetadata", update);
        detachAudioPlayer = () => {
            element.removeEventListener("timeupdate", update);
            element.removeEventListener("seeked", update);
            element.removeEventListener("loadedmetadata", update);
        };
    }

    onCleanup(() => {
        captureCancelled = true;
        clearAudio();
        if (captureTimer !== undefined) window.clearInterval(captureTimer);
        if (captureRecorder && captureRecorder.state !== "inactive") {
            try {
                captureRecorder.stop();
            } catch {
                captureStream?.getTracks().forEach((track) => track.stop());
            }
        }
        captureStream?.getTracks().forEach((track) => track.stop());
    });

    const microphoneAvailable = () =>
        typeof navigator !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia) &&
        typeof MediaRecorder !== "undefined";

    function resetCapture(): void {
        if (captureTimer !== undefined) window.clearInterval(captureTimer);
        captureTimer = undefined;
        captureStream?.getTracks().forEach((track) => track.stop());
        captureStream = undefined;
        captureRecorder = undefined;
        captureChunks = [];
        captureByteCount = 0;
        setCaptureElapsed(0);
        setCaptureState("idle");
    }

    async function finishCapture(
        sessionId: string,
        sessionTitle: string,
        mimeType: string,
    ): Promise<void> {
        setCaptureState("saving");
        if (captureTimer !== undefined) window.clearInterval(captureTimer);
        captureTimer = undefined;
        captureStream?.getTracks().forEach((track) => track.stop());
        captureStream = undefined;

        if (captureExceededLimit || captureFailed) {
            resetCapture();
            return;
        }
        const blob = new Blob(captureChunks, { type: mimeType });
        if (blob.size === 0) {
            setCaptureError("The microphone did not produce an audio recording.");
            resetCapture();
            return;
        }
        if (blob.size > MAX_ASSET_BYTES) {
            setCaptureError("This recording exceeds the 256 MiB limit and was not saved.");
            resetCapture();
            return;
        }

        const normalizedMimeType = blob.type || mimeType;
        const baseMimeType = normalizedMimeType.split(";", 1)[0]?.toLowerCase() ?? "";
        const extension = baseMimeType.includes("ogg")
            ? "ogg"
            : baseMimeType.includes("mp4")
              ? "m4a"
              : baseMimeType.includes("wav")
                ? "wav"
                : "webm";
        const dateStamp = new Date(captureStartedAt).toISOString().replace(/[:.]/gu, "-");
        const file = new File(
            [blob],
            `${safeFileName(sessionTitle)}-recording-${dateStamp}.${extension}`,
            {
                type: normalizedMimeType,
            },
        );
        setCaptureState("saving");
        try {
            await props.onRecordAudio(file, sessionId, captureConsentAtUs);
        } finally {
            resetCapture();
        }
    }

    async function startCapture(): Promise<void> {
        const session = selectedSession();
        if (!session || !captureConsent()) return;
        setCaptureError("");
        if (!microphoneAvailable()) {
            setCaptureError("Microphone recording is not available in this window.");
            return;
        }

        setCaptureState("requesting");
        captureCancelled = false;
        let stream: MediaStream | undefined;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
                video: false,
            });
            if (captureCancelled) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            const preferredMimeType = [
                "audio/webm;codecs=opus",
                "audio/ogg;codecs=opus",
                "audio/mp4",
                "audio/webm",
            ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
            const recorder = preferredMimeType
                ? new MediaRecorder(stream, { mimeType: preferredMimeType })
                : new MediaRecorder(stream);
            const mimeType = recorder.mimeType || preferredMimeType || "";
            if (!mimeType)
                throw new Error("This system does not provide a supported audio format.");

            captureStream = stream;
            captureRecorder = recorder;
            captureChunks = [];
            captureByteCount = 0;
            captureExceededLimit = false;
            captureFailed = false;
            captureStartedAt = Date.now();
            setCaptureElapsed(0);
            captureConsentAtUs = (BigInt(captureStartedAt) * 1000n).toString();
            recorder.ondataavailable = (event) => {
                if (event.data.size === 0) return;
                captureByteCount += event.data.size;
                if (captureByteCount > MAX_ASSET_BYTES) {
                    captureExceededLimit = true;
                    setCaptureError("Recording reached the 256 MiB limit and is stopping.");
                    if (recorder.state !== "inactive") recorder.stop();
                    return;
                }
                captureChunks.push(event.data);
            };
            recorder.onerror = () => {
                captureFailed = true;
                setCaptureError("The microphone recorder stopped unexpectedly. Try again.");
                if (recorder.state !== "inactive") recorder.stop();
            };
            recorder.onstop = () => {
                void finishCapture(
                    session.id,
                    field(session, "title", "Tutoring session"),
                    mimeType,
                );
            };
            recorder.start(1000);
            setCaptureState("recording");
            captureTimer = window.setInterval(
                () => setCaptureElapsed(Math.floor((Date.now() - captureStartedAt) / 1000)),
                250,
            );
        } catch (error) {
            stream?.getTracks().forEach((track) => track.stop());
            captureStream = undefined;
            captureRecorder = undefined;
            if (captureCancelled) return;
            setCaptureState("idle");
            const name = error instanceof DOMException ? error.name : "";
            setCaptureError(
                name === "NotAllowedError" || name === "SecurityError"
                    ? "Microphone access was denied. Allow it in your system privacy settings and try again."
                    : name === "NotFoundError"
                      ? "No microphone was found. Connect a microphone and try again."
                      : errorMessage(error),
            );
        }
    }

    function stopCapture(): void {
        const recorder = captureRecorder;
        if (!recorder || recorder.state === "inactive") return;
        setCaptureState("saving");
        recorder.stop();
    }

    async function playFromCue(record: ArchiveRecord): Promise<void> {
        await playAudioAt(field(record, "start_time_us", "0"));
    }

    async function playAudioAt(startTimeUs: string): Promise<void> {
        const session = selectedSession();
        const track = selectedTrack();
        if (!session || !track) return;
        setPlaybackError("");
        try {
            const start = BigInt(startTimeUs);
            const preview = await buildAudioPreview(
                props.snapshot,
                session.id,
                track.id,
                start,
                start + 30_000_000n,
            );
            clearAudio();
            setPlaybackOriginUs(start);
            setPlaybackPositionUs(start);
            const url = URL.createObjectURL(
                new Blob([preview.wav.slice().buffer as ArrayBuffer], { type: "audio/wav" }),
            );
            currentAudioUrl = url;
            setAudioPreview(preview);
            setAudioUrl(url);
            queueMicrotask(() => {
                void audioPlayer?.play().catch(() => {
                    setPlaybackError(
                        "Audio is ready. Press Play in the player to start listening.",
                    );
                });
            });
        } catch (error) {
            setPlaybackError(errorMessage(error));
        }
    }

    function chooseImport(): void {
        fileInput?.click();
    }

    function receiveFile(event: Event): void {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        const session = selectedSession();
        if (file && session) props.onImport(file, session.id);
        input.value = "";
    }

    function chooseAudioImport(): void {
        audioFileInput?.click();
    }

    function receiveAudioFile(event: Event): void {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        const session = selectedSession();
        if (file && session) {
            props.onImportAudio(file, session.id, sessionHasAudio() && addSeparateTrack());
        }
        input.value = "";
    }

    return (
        <div class={cn("page-body transcript-page", pageBody)}>
            <section class="record-heading transcript-heading mb-[18px] flex flex-wrap items-center justify-between gap-5 rounded-[5px] border border-line bg-surface px-[22px] py-5 max-sm:flex-col max-sm:items-start max-sm:gap-3 max-sm:p-[17px]">
                <div class="min-w-0">
                    <span class="eyebrow text-xs font-medium tracking-wide text-accent">
                        Capture a lesson, then keep the useful words
                    </span>
                    <h1 class={cn(heading1, "mt-1.5 mb-1")}>Record and transcribe</h1>
                    <p class="m-0 text-[13px] leading-relaxed text-muted">
                        Choose a session, record or import its audio, then create and review
                        transcript cues alongside the recording.
                    </p>
                </div>
                <div class="transcript-heading-actions flex items-center gap-3 max-sm:flex-col max-sm:items-end">
                    <Show when={props.sessions.length > 0}>
                        <button
                            class={buttonOutline}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onNewSession()}
                        >
                            <Icon name="plus" />
                            New session
                        </button>
                    </Show>
                    <span
                        class="transcript-page-mark grid h-14 w-14 flex-none place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent max-sm:h-10 max-sm:w-10"
                        aria-hidden="true"
                    >
                        <Icon name="microphone" />
                    </span>
                </div>
            </section>

            <Show when={props.sessions.length === 0}>
                <section
                    class="record-onboarding mb-[18px] grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-4 rounded-[10px] border border-accent/25 bg-accent-soft/50 px-6 py-[22px] max-md:grid-cols-[48px_minmax(0,1fr)] max-sm:grid-cols-1 max-sm:p-[18px]"
                    aria-labelledby="record-onboarding-title"
                >
                    <span
                        class="record-onboarding-mark grid h-12 w-12 place-items-center rounded-xl border border-accent/20 bg-surface text-accent"
                        aria-hidden="true"
                    >
                        <Icon name="microphone" />
                    </span>
                    <div class="min-w-0">
                        <h2 id="record-onboarding-title" class={heading2}>
                            Start with a tutoring session
                        </h2>
                        <p class="m-0 text-[13px] leading-relaxed text-muted">
                            Create the session first. Tutorux will keep its recording, transcript,
                            notes, and materials together in this archive.
                        </p>
                    </div>
                    <button
                        class={buttonPrimary}
                        type="button"
                        disabled={props.disabled}
                        onClick={() => props.onNewSession()}
                    >
                        <Icon name="plus" />
                        Create session
                    </button>
                </section>
            </Show>

            <Show when={props.sessions.length > 0}>
                <section
                    class="transcript-controls mb-3.5 flex items-end justify-between gap-4 rounded-[5px] border border-line bg-surface px-4 py-3.5 max-lg:flex-col max-lg:items-stretch"
                    aria-label="Transcript actions"
                >
                    <label class="transcript-session-picker grid min-w-[150px] flex-1 gap-1.5 text-xs font-semibold text-muted">
                        <span class="eyebrow text-xs font-medium tracking-wide text-muted">
                            Session
                        </span>
                        <select
                            value={selectedSession()?.id ?? ""}
                            disabled={props.sessions.length === 0 || captureState() !== "idle"}
                            onChange={(event) => {
                                clearAudio();
                                setAddSeparateTrack(false);
                                setSelectedCueIds([]);
                                setCaptureConsent(false);
                                setCaptureError("");
                                setCaptureElapsed(0);
                                props.onSelectSession(event.currentTarget.value);
                            }}
                            aria-label="Transcript session"
                            class={selectBase}
                        >
                            <Show when={!selectedSession()}>
                                <option value="" disabled>
                                    {props.sessions.length === 0
                                        ? "No sessions yet"
                                        : "Select a session"}
                                </option>
                            </Show>
                            <For each={props.sessions}>
                                {(session) => (
                                    <option value={session.id}>
                                        {field(session, "title", "Untitled session")}
                                    </option>
                                )}
                            </For>
                        </select>
                    </label>
                    <Show when={sessionHasAudio()}>
                        <label class="transcript-audio-add-checkbox inline-flex items-center gap-[7px] text-xs leading-relaxed text-muted">
                            <input
                                type="checkbox"
                                checked={addSeparateTrack()}
                                disabled={props.disabled}
                                onChange={(event) =>
                                    setAddSeparateTrack(event.currentTarget.checked)
                                }
                                class="accent-accent"
                            />
                            <span>Keep existing audio and add this as a separate track</span>
                        </label>
                    </Show>
                    <div class="transcript-control-actions flex flex-wrap items-end gap-[7px] max-lg:items-stretch">
                        <input
                            ref={(element) => (fileInput = element)}
                            class="visually-hidden sr-only"
                            type="file"
                            accept=".txt,.srt,.vtt,text/plain,text/vtt,application/x-subrip"
                            onChange={receiveFile}
                            aria-label="Choose transcript source file"
                        />
                        <input
                            ref={(element) => (audioFileInput = element)}
                            class="visually-hidden sr-only"
                            type="file"
                            accept=".wav,audio/wav,audio/x-wav"
                            onChange={receiveAudioFile}
                            aria-label="Choose WAV audio file"
                        />
                        <button
                            class={buttonPrimary}
                            type="button"
                            disabled={props.disabled || !selectedSession()}
                            onClick={chooseImport}
                        >
                            <Icon name="plus" />
                            Import cues
                        </button>
                        <button
                            class={buttonOutline}
                            type="button"
                            disabled={
                                props.disabled ||
                                !selectedSession() ||
                                (sessionHasAudio() && !addSeparateTrack())
                            }
                            onClick={chooseAudioImport}
                        >
                            {sessionHasAudio() ? "Add WAV track" : "Import WAV"}
                        </button>
                        <Show when={platform.kind === "desktop"}>
                            <button
                                class={buttonOutline}
                                type="button"
                                disabled={
                                    props.disabled ||
                                    !selectedSession() ||
                                    (sessionHasAudio() && !addSeparateTrack())
                                }
                                onClick={() => {
                                    const session = selectedSession();
                                    if (session) {
                                        props.onImportCompressedAudio(
                                            session.id,
                                            sessionHasAudio() && addSeparateTrack(),
                                        );
                                    }
                                }}
                            >
                                Import FLAC, MP3, or M4A
                            </button>
                        </Show>
                        <Show when={recoverableWavImport()}>
                            <button
                                class={buttonOutline}
                                type="button"
                                disabled={props.disabled || !selectedSession()}
                                onClick={() => {
                                    const session = selectedSession();
                                    if (session) props.onRecoverAudio(session.id);
                                }}
                            >
                                {selectedSession()?.fields.get("audio_import_state") === "completed"
                                    ? "Verify WAV import"
                                    : "Recover WAV import"}
                            </button>
                        </Show>
                        <Show when={recoverableNativeCapture()}>
                            <button
                                class={buttonOutline}
                                type="button"
                                disabled={props.disabled || captureState() !== "idle"}
                                onClick={() => {
                                    const session = selectedSession();
                                    if (session) props.onRecoverNativeAudio(session.id);
                                }}
                            >
                                Recover saved recording
                            </button>
                        </Show>
                        <label class="transcript-export-picker grid min-w-[150px] gap-1.5 text-xs font-semibold text-muted max-lg:flex-1">
                            <span class="visually-hidden sr-only">Export format</span>
                            <select
                                value={exportFormat()}
                                disabled={props.disabled || !selectedSession()}
                                onChange={(event) =>
                                    setExportFormat(
                                        event.currentTarget.value as TranscriptExportFormat,
                                    )
                                }
                                aria-label="Transcript export format"
                                class={selectBase}
                            >
                                <option value="text">Text</option>
                                <option value="srt">SubRip</option>
                                <option value="vtt">WebVTT</option>
                                <option value="json">JSON</option>
                            </select>
                        </label>
                        <button
                            class={buttonOutline}
                            type="button"
                            disabled={props.disabled || !selectedSession()}
                            onClick={() => {
                                const session = selectedSession();
                                if (session) props.onExport(session.id, exportFormat());
                            }}
                        >
                            Export
                        </button>
                    </div>
                </section>

                <section
                    class="transcript-capture-panel mb-3.5 grid grid-cols-[minmax(220px,1fr)_minmax(210px,auto)_auto] items-center gap-x-[18px] gap-y-[13px] rounded-[9px] border border-accent/20 bg-accent-soft/50 px-[17px] py-[15px] max-md:grid-cols-[minmax(0,1fr)_auto] max-sm:grid-cols-1 max-sm:gap-[11px] max-sm:p-3.5"
                    aria-label="Microphone recording"
                >
                    <div class="transcript-capture-copy grid min-w-0 gap-1 max-md:col-span-full">
                        <span class="eyebrow text-xs font-medium tracking-wide text-muted">
                            Session audio
                        </span>
                        <strong class="font-semibold text-ink-soft">Record from microphone</strong>
                        <span>
                            Save the recording to this session, then use “Transcribe this recording”
                            below to create timestamped cues.
                        </span>
                    </div>
                    <label class="transcript-capture-consent inline-flex items-center gap-2 text-xs leading-relaxed text-muted">
                        <input
                            type="checkbox"
                            checked={captureConsent()}
                            disabled={props.disabled || captureState() !== "idle"}
                            onChange={(event) => setCaptureConsent(event.currentTarget.checked)}
                            class="accent-accent"
                        />
                        <span>I have permission to record this session</span>
                    </label>
                    <div class="transcript-capture-state flex items-center justify-end gap-[13px] max-sm:flex-wrap max-sm:justify-start">
                        <Show when={captureState() === "recording"}>
                            <span
                                class="transcript-capture-live inline-flex items-center gap-2 text-xs font-semibold text-danger"
                                role="timer"
                                aria-live="off"
                            >
                                <i
                                    aria-hidden="true"
                                    class="h-2 w-2 animate-pulse rounded-full bg-danger"
                                />
                                Recording
                                <strong class="font-semibold text-ink-soft">
                                    {`${Math.floor(captureElapsed() / 60)
                                        .toString()
                                        .padStart(
                                            2,
                                            "0",
                                        )}:${(captureElapsed() % 60).toString().padStart(2, "0")}`}
                                </strong>
                            </span>
                        </Show>
                        <div class="transcript-capture-actions flex flex-wrap items-center justify-end gap-2 max-sm:justify-start">
                            <Show when={captureState() === "idle"}>
                                <button
                                    class={buttonPrimary}
                                    type="button"
                                    disabled={
                                        props.disabled ||
                                        !selectedSession() ||
                                        !captureConsent() ||
                                        !microphoneAvailable()
                                    }
                                    onClick={() => void startCapture()}
                                >
                                    <Icon name="microphone" />
                                    Record
                                </button>
                            </Show>
                            <Show when={captureState() === "recording"}>
                                <button class={buttonDanger} type="button" onClick={stopCapture}>
                                    Stop and save
                                </button>
                            </Show>
                            <Show when={captureState() === "saving"}>
                                <span
                                    class="transcript-capture-saving text-xs text-muted"
                                    role="status"
                                    aria-live="polite"
                                >
                                    Saving recording…
                                </span>
                            </Show>
                            <Show when={captureState() === "requesting"}>
                                <span
                                    class="transcript-capture-saving text-xs text-muted"
                                    role="status"
                                    aria-live="polite"
                                >
                                    Waiting for microphone permission…
                                </span>
                            </Show>
                        </div>
                    </div>
                    <Show when={!microphoneAvailable()}>
                        <span class="transcript-capture-note col-span-full text-xs leading-relaxed text-muted">
                            Microphone recording is not available in this window.
                        </span>
                    </Show>
                    <Show when={captureError()}>
                        <span
                            class="transcript-capture-error col-span-full text-xs text-danger"
                            role="alert"
                        >
                            {captureError()}
                        </span>
                    </Show>
                </section>
            </Show>

            <Show
                when={
                    sessionRecordingTakes().length > 0 ||
                    trashedSessionRecordingTakes().length > 0 ||
                    trashedSessionRecordingTracks().length > 0
                }
            >
                <section
                    class="transcript-takes-panel mb-3.5 grid gap-3 rounded-[5px] border border-line bg-surface px-4 py-[15px]"
                    aria-label="Recording takes"
                >
                    <div class="transcript-takes-heading flex items-center justify-between gap-2.5 border-b border-line-soft pb-2.5 max-sm:flex-col max-sm:items-start">
                        <div class="min-w-0">
                            <span class="eyebrow text-xs font-medium tracking-wide text-muted">
                                Session audio
                            </span>
                            <strong class="font-semibold text-ink-soft">Recording takes</strong>
                            <span>
                                Rename takes and tracks, then move individual items to Trash or
                                restore them here.
                            </span>
                        </div>
                        <span class="transcript-takes-count flex-none text-xs tabular-nums text-muted">
                            {sessionRecordingTakes().length} active takes ·{" "}
                            {trashedSessionRecordingTakes().length} takes and{" "}
                            {pluralize(trashedSessionRecordingTracks().length, "track")} in Trash
                        </span>
                    </div>
                    <div class="transcript-takes-list grid gap-2">
                        <For each={sessionRecordingTakes()}>
                            {(take) => {
                                const trackIds = new Set(
                                    field(take, "track_ids")
                                        .split(",")
                                        .map((id) => id.trim().toLowerCase())
                                        .filter(Boolean),
                                );
                                return (
                                    <RecordingTakeRow
                                        take={take}
                                        tracks={sessionTracks().filter((track) =>
                                            trackIds.has(track.id.toLowerCase()),
                                        )}
                                        trashedTracks={trashedSessionRecordingTracks().filter(
                                            (track) =>
                                                field(track, "recording_take_id").toLowerCase() ===
                                                take.id.toLowerCase(),
                                        )}
                                        disabled={props.disabled}
                                        onRenameTake={props.onRenameRecordingTake}
                                        onRenameTrack={props.onRenameRecordingTrack}
                                        onTrashTrack={props.onTrashRecordingTrack}
                                        onRestoreTrack={props.onRestoreRecordingTrack}
                                        onTrash={props.onTrashRecordingTake}
                                    />
                                );
                            }}
                        </For>
                        <For each={trashedSessionRecordingTakes()}>
                            {(take) => (
                                <article class="transcript-take-card transcript-take-card-trashed grid gap-[9px] rounded-[5px] border border-line-soft bg-surface-subtle p-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[9px] rounded-[5px] border border-line-soft bg-surface-subtle p-3 max-sm:grid-cols-1">
                                    <div class="transcript-take-copy grid min-w-0 gap-1">
                                        <strong class="font-semibold text-ink-soft">
                                            {field(take, "label", "Recording take")}
                                        </strong>
                                        <span>
                                            Moved to Trash with its audio tracks and timeline data.
                                        </span>
                                    </div>
                                    <button
                                        class={buttonOutline}
                                        type="button"
                                        disabled={props.disabled}
                                        onClick={() => props.onRestoreRecordingTake(take)}
                                    >
                                        Restore take
                                    </button>
                                </article>
                            )}
                        </For>
                    </div>
                </section>
            </Show>

            <Show when={selectedSession()}>
                {(session) => (
                    <>
                        <MicrophoneTrackRecorder
                            snapshot={props.snapshot}
                            session={session()}
                            trackIds={sessionTracks().map((track) => track.id)}
                            disabled={props.disabled}
                            onSave={(records, message, snapshot) =>
                                props.onSaveMix(snapshot, records, message)
                            }
                        />
                        <SynchronizedRecorder
                            snapshot={props.snapshot}
                            session={session()}
                            trackIds={sessionTracks().map((track) => track.id)}
                            disabled={props.disabled}
                            onSave={(records, message, snapshot) =>
                                props.onSaveMix(snapshot, records, message)
                            }
                            onCheckpointPersisted={props.onCheckpointPersisted}
                        />
                        <AudioMixer
                            snapshot={props.snapshot}
                            sessionId={session().id}
                            takes={props.recordingTakes}
                            tracks={props.tracks}
                            disabled={props.disabled}
                            onSave={props.onSaveMix}
                        />
                    </>
                )}
            </Show>
            <Show when={sessionTracks().length > 0}>
                <section
                    class="transcript-audio-panel grid min-w-0 gap-4 rounded-panel border border-line bg-surface p-4 mb-3.5"
                    aria-label="Session recording playback"
                >
                    <div class="transcript-audio-copy min-w-0 grid gap-1">
                        <span class="eyebrow text-xs font-medium tracking-wide text-muted">
                            Session recording
                        </span>
                        <strong class="font-semibold text-ink-soft">
                            {selectedTrack()?.label ?? "Recording"}
                        </strong>
                        <span>Load up to 30 seconds from the beginning or a transcript cue.</span>
                    </div>
                    <div class="transcript-audio-controls flex min-w-0 flex-wrap items-center justify-end gap-2">
                        <Show when={sessionTracks().length > 1}>
                            <label class="transcript-audio-picker min-w-0 max-w-full flex-1 basis-[180px]">
                                <span class="visually-hidden sr-only">Audio track</span>
                                <select
                                    value={selectedTrack()?.id ?? ""}
                                    aria-label="Audio track"
                                    onChange={(event) => {
                                        clearAudio();
                                        setTrackId(event.currentTarget.value);
                                    }}
                                    class={selectBase}
                                >
                                    <For each={sessionTracks()}>
                                        {(track) => <option value={track.id}>{track.label}</option>}
                                    </For>
                                </select>
                            </label>
                        </Show>
                        <button
                            class={buttonOutline}
                            type="button"
                            disabled={!selectedTrack()}
                            onClick={() => void playAudioAt("0")}
                        >
                            Play from start
                        </button>
                    </div>
                    <div class="transcript-audio-export-actions col-span-full flex flex-wrap items-center gap-2">
                        <button
                            class={cn("transcript-audio-export", buttonOutline)}
                            type="button"
                            disabled={props.disabled || !selectedTrack()}
                            onClick={() => {
                                const session = selectedSession();
                                const track = selectedTrack();
                                if (session && track)
                                    props.onExportAudio(session.id, track.id, track.label, false);
                            }}
                        >
                            Export WAV
                        </button>
                        <button
                            class={cn("transcript-audio-export", buttonOutline)}
                            type="button"
                            disabled={props.disabled || !selectedTrack()}
                            onClick={() => {
                                const session = selectedSession();
                                const track = selectedTrack();
                                if (session && track)
                                    props.onExportAudio(session.id, track.id, track.label, true);
                            }}
                        >
                            Export with gap silence
                        </button>
                    </div>
                    <p class="transcript-audio-export-note col-span-full -mt-1.5 text-xs leading-relaxed text-muted">
                        Export WAV requires a continuous track. If audio is missing from the
                        timeline, choose “Export with gap silence” to preserve timing by inserting
                        silence. Tracks over 4 GiB use RF64, which currently requires Tutorux for
                        desktop because browser downloads cannot safely save files this large.
                    </p>
                    <Show when={audioUrl() && audioPreview()}>
                        <AudioWaveform
                            preview={audioPreview()!}
                            url={audioUrl()!}
                            onPlayer={attachAudioPlayer}
                        />
                    </Show>
                    <Show when={selectedSession() && selectedTrack()}>
                        <FullTrackWaveform
                            snapshot={props.snapshot}
                            sessionId={selectedSession()!.id}
                            trackId={selectedTrack()!.id}
                            disabled={props.disabled}
                            onSave={(record, snapshot) =>
                                props.onSaveMix(snapshot, [record], "Waveform saved.")
                            }
                            onSelectTime={(timeUs) => void playAudioAt(timeUs.toString())}
                        />
                    </Show>
                    <Show when={selectedSession() && selectedTrack()}>
                        <WhisperTranscription
                            snapshot={props.snapshot}
                            preview={audioPreview()}
                            sessionId={selectedSession()!.id}
                            trackId={selectedTrack()!.id}
                            records={sessionRecords()}
                            disabled={props.disabled}
                            onSave={props.onSaveWhisper}
                        />
                    </Show>
                    <Show when={playbackError()}>
                        <span
                            class="transcript-audio-error col-span-full text-xs text-danger"
                            role="alert"
                        >
                            {playbackError()}
                        </span>
                    </Show>
                </section>
            </Show>

            <Show when={props.sessions.length > 0}>
                <section class="record-list-shell transcript-list-shell overflow-hidden rounded-[5px] border-0 bg-transparent">
                    <div class="record-list-toolbar flex min-h-[43px] items-center justify-between border-b border-line-soft px-[15px] text-[13px] text-muted max-sm:min-h-[42px] max-sm:px-[11px]">
                        <span>
                            <strong class="font-semibold text-ink-soft">
                                {sessionRecords().length}
                            </strong>{" "}
                            transcript cues
                            <Show when={selectedSession()}>
                                {(session) => (
                                    <span> · {field(session(), "title", "Untitled session")}</span>
                                )}
                            </Show>
                        </span>
                        <span class="list-view-label inline-flex items-center gap-[5px]">
                            <Icon name="shield" />
                            Review before reuse
                        </span>
                        <button
                            class={cn("transcript-merge-button", buttonOutline, "flex-none")}
                            type="button"
                            disabled={props.disabled || selectedCues().length < 2}
                            onClick={async () => {
                                if (await props.onMerge(selectedCues())) setSelectedCueIds([]);
                            }}
                        >
                            Merge{" "}
                            {selectedCues().length ? `(${selectedCues().length})` : "selected cues"}
                        </button>
                    </div>
                    <Show
                        when={selectedSession()}
                        fallback={
                            <section class="transcript-session-unavailable grid gap-1 rounded-[5px] border border-line bg-surface p-4 text-xs text-muted">
                                <strong class="font-semibold text-ink-soft">
                                    Session unavailable
                                </strong>
                                <span>
                                    The selected session is not in this workspace. Choose another
                                    session from the list above.
                                </span>
                            </section>
                        }
                    >
                        <Show
                            when={sessionRecords().length > 0}
                            fallback={
                                <EmptyState
                                    icon="transcripts"
                                    title="No transcript cues yet"
                                    text="Import a plain text, SubRip, or WebVTT file to begin reviewing what was said."
                                    action="Import a transcript"
                                    onAction={chooseImport}
                                    disabled={props.disabled}
                                />
                            }
                        >
                            <div class="transcript-list grid">
                                <For each={sessionRecords()}>
                                    {(record, index) => (
                                        <TranscriptCueCard
                                            record={record}
                                            displayIndex={index() + 1}
                                            disabled={props.disabled}
                                            audioAvailable={sessionTracks().length > 0}
                                            selected={selectedCueIds().includes(record.id)}
                                            playing={activeCueId() === record.id}
                                            assets={sessionAssets()}
                                            onListen={(cue) => void playFromCue(cue)}
                                            onToggleSelection={(cue, selected) =>
                                                setSelectedCueIds((current) =>
                                                    selected
                                                        ? [...new Set([...current, cue.id])]
                                                        : current.filter((id) => id !== cue.id),
                                                )
                                            }
                                            onSave={props.onSave}
                                            onVerify={props.onVerify}
                                            onHistory={props.onHistory}
                                            onRestore={props.onRestore}
                                            onSplit={props.onSplit}
                                            onLinkAssets={props.onLinkAssets}
                                        />
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Show>
                </section>
            </Show>
        </div>
    );
}

function RecordingTakeRow(props: {
    take: ArchiveRecord;
    tracks: AudioTrackDescriptor[];
    trashedTracks: ArchiveRecord[];
    disabled: boolean;
    onRenameTake: (take: ArchiveRecord, label: string) => void;
    onRenameTrack: (track: AudioTrackDescriptor, label: string) => void;
    onTrashTrack: (track: AudioTrackDescriptor) => void;
    onRestoreTrack: (track: ArchiveRecord) => void;
    onTrash: (take: ArchiveRecord) => void;
}): JSX.Element {
    const [label, setLabel] = createSignal(
        untrack(() => field(props.take, "label", "Recording take")),
    );

    return (
        <article class="transcript-take-card grid gap-[9px] rounded-[5px] border border-line-soft bg-surface-subtle p-3">
            <div class="transcript-take-card-heading flex flex-wrap items-end justify-between gap-2.5 max-sm:flex-col max-sm:items-stretch">
                <label class={labelBase}>
                    <span>Take name</span>
                    <input
                        value={label()}
                        maxLength={120}
                        onInput={(event) => setLabel(event.currentTarget.value)}
                        aria-label="Recording take name"
                        class={inputBase}
                    />
                </label>
                <button
                    class={buttonOutline}
                    type="button"
                    disabled={props.disabled || label().trim() === field(props.take, "label")}
                    onClick={() => props.onRenameTake(props.take, label())}
                >
                    Save name
                </button>
                <button
                    class={cn("transcript-take-trash", buttonDanger)}
                    type="button"
                    disabled={props.disabled}
                    onClick={() => props.onTrash(props.take)}
                >
                    Move to Trash
                </button>
            </div>
            <div class="transcript-take-meta flex flex-wrap gap-1.5 text-xs text-muted">
                <span>{field(props.take, "state", "saved")}</span>
                <span>
                    {props.tracks.length} {props.tracks.length === 1 ? "track" : "tracks"}
                </span>
                <span>{field(props.take, "source", "saved audio")}</span>
            </div>
            <Show when={props.tracks.length > 0}>
                <div
                    class="transcript-take-tracks grid gap-1.5 border-t border-line-soft pt-2"
                    aria-label="Tracks in this take"
                >
                    <For each={props.tracks}>
                        {(track) => (
                            <RecordingTrackName
                                track={track}
                                disabled={props.disabled}
                                onRename={props.onRenameTrack}
                                onTrash={props.onTrashTrack}
                            />
                        )}
                    </For>
                </div>
            </Show>
            <Show when={props.trashedTracks.length > 0}>
                <div
                    class="transcript-take-tracks transcript-take-trashed-tracks grid gap-1.5 border-t border-line-soft pt-2"
                    aria-label="Tracks in Trash"
                >
                    <strong class="font-semibold text-ink-soft">Tracks in Trash</strong>
                    <For each={props.trashedTracks}>
                        {(track) => (
                            <div class="transcript-take-trashed-track-row flex flex-wrap items-center justify-between gap-2.5 rounded-[5px] border border-line-soft bg-surface px-2 py-[7px] text-xs text-muted max-sm:items-start">
                                <span>{field(track, "label", "Recording track")}</span>
                                <button
                                    class={buttonOutline}
                                    type="button"
                                    disabled={props.disabled}
                                    aria-label={`Restore track: ${field(track, "label", "Recording track")}`}
                                    onClick={() => props.onRestoreTrack(track)}
                                >
                                    Restore track
                                </button>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </article>
    );
}

function RecordingTrackName(props: {
    track: AudioTrackDescriptor;
    disabled: boolean;
    onRename: (track: AudioTrackDescriptor, label: string) => void;
    onTrash: (track: AudioTrackDescriptor) => void;
}): JSX.Element {
    const initialLabel = untrack(() => props.track.label);
    const [draft, setDraft] = createSignal(initialLabel);
    const changed = () => draft().trim() !== props.track.label;
    let lastLabel = initialLabel;
    createEffect(() => {
        const label = props.track.label;
        if (label === lastLabel) return;
        lastLabel = label;
        setDraft(label);
    });

    return (
        <div class="transcript-take-track-row flex flex-wrap items-end justify-between gap-2.5 max-sm:flex-col max-sm:items-stretch">
            <label class={labelBase}>
                <span>Track name</span>
                <input
                    value={draft()}
                    maxLength={120}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    aria-label={`Track name: ${props.track.label}`}
                    class={inputBase}
                />
            </label>
            <button
                class={buttonOutline}
                type="button"
                disabled={props.disabled || !changed()}
                onClick={() => props.onRename(props.track, draft().trim() || props.track.label)}
            >
                Save track name
            </button>
            <button
                class={cn("transcript-take-trash", buttonDanger)}
                type="button"
                disabled={props.disabled}
                aria-label={`Move track to Trash: ${props.track.label}`}
                onClick={() => props.onTrash(props.track)}
            >
                Move to Trash
            </button>
        </div>
    );
}

function TranscriptCueCard(props: {
    record: ArchiveRecord;
    displayIndex: number;
    disabled: boolean;
    audioAvailable: boolean;
    selected: boolean;
    playing: boolean;
    assets: ArchiveRecord[];
    onListen: (record: ArchiveRecord) => void;
    onToggleSelection: (record: ArchiveRecord, selected: boolean) => void;
    onSave: (
        record: ArchiveRecord,
        text: string,
        start: string,
        end: string,
        speaker: string,
    ) => void;
    onVerify: (record: ArchiveRecord) => void;
    onHistory: (record: ArchiveRecord) => Promise<ArchiveRecord[]>;
    onRestore: (record: ArchiveRecord, historyIndex: number) => Promise<boolean>;
    onSplit: (
        record: ArchiveRecord,
        beforeText: string,
        afterText: string,
        splitAt?: string,
    ) => Promise<boolean>;
    onLinkAssets: (record: ArchiveRecord, assetIds: readonly string[]) => Promise<boolean>;
}): JSX.Element {
    const [editing, setEditing] = createSignal(false);
    const [splitting, setSplitting] = createSignal(false);
    const [linkingAssets, setLinkingAssets] = createSignal(false);
    const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
    const [historyLoading, setHistoryLoading] = createSignal(false);
    const [text, setText] = createSignal("");
    const [start, setStart] = createSignal("");
    const [end, setEnd] = createSignal("");
    const [speaker, setSpeaker] = createSignal("");
    const [beforeText, setBeforeText] = createSignal("");
    const [afterText, setAfterText] = createSignal("");
    const [splitAt, setSplitAt] = createSignal("");
    const [draftAssetIds, setDraftAssetIds] = createSignal<string[]>([]);
    const availableAssets = createMemo(() => props.assets);
    const linkedAssetIds = createMemo(() =>
        field(props.record, "linked_asset_ids")
            .split(",")
            .map((id) => id.trim().toLowerCase())
            .filter(Boolean),
    );
    const linkedAssets = createMemo(() => {
        const linked = new Set(linkedAssetIds());
        return props.assets.filter((asset) => linked.has(asset.id.toLowerCase()));
    });
    const verification = createMemo(() => field(props.record, "verification_state", "provisional"));
    const statusLabel = createMemo(() =>
        verification() === "human-verified"
            ? "Human verified"
            : verification() === "human-corrected"
              ? "Corrected · review"
              : verification() === "needs-review"
                ? "Needs review"
                : "Provisional",
    );

    async function toggleHistory(): Promise<void> {
        if (history() !== null) {
            setHistory(null);
            return;
        }
        setHistoryLoading(true);
        try {
            setHistory(await props.onHistory(props.record));
        } finally {
            setHistoryLoading(false);
        }
    }

    async function restoreRevision(historyIndex: number): Promise<void> {
        if (!(await props.onRestore(props.record, historyIndex))) return;
        setHistory(await props.onHistory(props.record));
    }

    function beginEditing(): void {
        const timestamped = field(props.record, "timestamp_state") !== "not-timestamped";
        setText(field(props.record, "text"));
        setStart(timestamped ? transcriptTimeInput(field(props.record, "start_time_us")) : "");
        setEnd(timestamped ? transcriptTimeInput(field(props.record, "end_time_us")) : "");
        setSpeaker(field(props.record, "speaker_label", field(props.record, "speaker_name")));
        setEditing(true);
    }

    function beginSplitting(): void {
        const characters = Array.from(field(props.record, "text"));
        let splitIndex = Math.floor(characters.length / 2);
        for (let index = splitIndex; index < characters.length - 1; index += 1) {
            if (/\s/u.test(characters[index]!)) {
                splitIndex = index + 1;
                break;
            }
        }
        if (splitIndex <= 0 || splitIndex >= characters.length) {
            splitIndex = Math.floor(characters.length / 2);
        }
        setBeforeText(characters.slice(0, splitIndex).join(""));
        setAfterText(characters.slice(splitIndex).join(""));
        const isTimestamped = field(props.record, "timestamp_state") !== "not-timestamped";
        if (isTimestamped) {
            const startTime = safeBigInt(field(props.record, "start_time_us", "0"));
            const endTime = safeBigInt(field(props.record, "end_time_us", "0"));
            setSplitAt(formatTranscriptTimestampUs(startTime + (endTime - startTime) / 2n));
        } else {
            setSplitAt("");
        }
        setSplitting(true);
    }

    async function saveSplit(): Promise<void> {
        const timestamped = field(props.record, "timestamp_state") !== "not-timestamped";
        const saved = await props.onSplit(
            props.record,
            beforeText(),
            afterText(),
            timestamped ? splitAt() : undefined,
        );
        if (saved) setSplitting(false);
    }

    function beginAssetLinking(): void {
        setDraftAssetIds(linkedAssetIds());
        setLinkingAssets(true);
    }

    async function saveAssetLinks(): Promise<void> {
        if (await props.onLinkAssets(props.record, draftAssetIds())) setLinkingAssets(false);
    }

    return (
        <article
            class={cn(
                "transcript-cue grid grid-cols-[35px_minmax(0,1fr)] gap-3 border-b border-line-soft px-[18px] py-[17px] last:border-b-0 border-l-2 border-l-transparent transition-colors",
                props.playing && "is-playing border-l-accent bg-accent-soft/35",
            )}
            aria-current={props.playing ? "true" : undefined}
            data-cue-id={props.record.id}
        >
            <div class="transcript-cue-marker flex flex-col items-center gap-2 pt-0.5 text-xs font-semibold tabular-nums text-faint">
                <input
                    type="checkbox"
                    aria-label={"Select cue " + props.displayIndex + " to merge"}
                    checked={props.selected}
                    disabled={props.disabled}
                    onChange={(event) =>
                        props.onToggleSelection(props.record, event.currentTarget.checked)
                    }
                    class="accent-accent"
                />
                <span>{String(props.displayIndex).padStart(2, "0")}</span>
            </div>
            <div class="transcript-cue-content min-w-0">
                <div class="transcript-cue-meta flex flex-wrap items-center gap-[9px] text-xs text-faint">
                    <span class="transcript-time tabular-nums text-muted">
                        {field(props.record, "timestamp_state") === "not-timestamped"
                            ? "Time not provided"
                            : transcriptTimeRangeLabel(props.record)}
                    </span>
                    <span
                        class={cn(
                            `transcript-status status-${verification()}`,
                            "inline-flex items-center gap-1.5 rounded-[5px] border border-line-soft bg-surface-subtle px-[7px] py-[3px] text-xs font-semibold",
                            verification() === "human-verified"
                                ? "text-[var(--success)]"
                                : verification() === "human-corrected"
                                  ? "text-accent"
                                  : "text-[var(--warning)]",
                        )}
                    >
                        <span class="h-1.5 w-1.5 rounded-full bg-current" />
                        {statusLabel()}
                    </span>
                </div>
                <Show
                    when={field(props.record, "speaker_label", field(props.record, "speaker_name"))}
                >
                    <span class="transcript-speaker mt-[9px] inline-block text-xs font-semibold text-accent">
                        {field(props.record, "speaker_label", field(props.record, "speaker_name"))}
                    </span>
                </Show>
                <p class="transcript-cue-text my-[9px] max-w-[880px] whitespace-pre-wrap break-words text-xs leading-[1.8] text-ink">
                    {field(props.record, "text")}
                </p>
                <div class="transcript-cue-actions mt-2.5 flex flex-wrap gap-1.5">
                    <Show when={props.audioAvailable}>
                        <button
                            class={cn(
                                "record-action",
                                buttonOutline,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={
                                props.disabled ||
                                field(props.record, "timestamp_state") === "not-timestamped"
                            }
                            onClick={() => props.onListen(props.record)}
                            title={
                                field(props.record, "timestamp_state") === "not-timestamped"
                                    ? "Add a timestamp before playing from this cue"
                                    : undefined
                            }
                        >
                            Listen from cue
                        </button>
                    </Show>
                    <button
                        class={cn("record-action", buttonOutline, "min-h-[30px] px-[9px] text-xs")}
                        type="button"
                        disabled={props.disabled}
                        onClick={beginEditing}
                    >
                        Correct cue
                    </button>
                    <button
                        class={cn("record-action", buttonOutline, "min-h-[30px] px-[9px] text-xs")}
                        type="button"
                        disabled={props.disabled}
                        onClick={() => (splitting() ? setSplitting(false) : beginSplitting())}
                    >
                        {splitting() ? "Cancel split" : "Split cue"}
                    </button>
                    <Show when={availableAssets().length > 0}>
                        <button
                            class={cn(
                                "record-action",
                                buttonOutline,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() =>
                                linkingAssets() ? setLinkingAssets(false) : beginAssetLinking()
                            }
                        >
                            {linkingAssets()
                                ? "Cancel links"
                                : `Materials${linkedAssetIds().length ? ` (${linkedAssetIds().length})` : ""}`}
                        </button>
                    </Show>
                    <Show when={props.record.previousOffset > 0n}>
                        <button
                            class={cn(
                                "record-action",
                                buttonQuiet,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={historyLoading()}
                            aria-expanded={history() !== null}
                            onClick={() => void toggleHistory()}
                        >
                            {historyLoading()
                                ? "Loading history…"
                                : history() === null
                                  ? "View history"
                                  : "Hide history"}
                        </button>
                    </Show>
                    <Show when={verification() !== "human-verified"}>
                        <button
                            class={cn(
                                "record-action",
                                buttonQuiet,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onVerify(props.record)}
                        >
                            Mark verified
                        </button>
                    </Show>
                </div>
                <Show when={history() !== null}>
                    <section
                        class="transcript-history-panel mt-3 grid gap-[9px] rounded-[5px] border border-line-soft bg-surface-subtle p-3"
                        aria-label="Transcript cue version history"
                    >
                        <div class="transcript-history-heading flex items-center justify-between gap-2">
                            <span class="eyebrow text-xs font-medium tracking-wide text-muted">
                                Version history
                            </span>
                            <span>
                                {Math.max(0, (history()?.length ?? 1) - 1)} earlier versions
                            </span>
                        </div>
                        <Show
                            when={(history()?.length ?? 0) > 1}
                            fallback={
                                <p class="transcript-history-empty m-0 text-xs text-muted">
                                    This transcript cue has no earlier versions.
                                </p>
                            }
                        >
                            <div class="transcript-history-list grid gap-2">
                                <For
                                    each={(history()?.slice(1) ?? []).map((revision, index) => ({
                                        revision,
                                        historyIndex: index + 1,
                                    }))}
                                >
                                    {(entry) => (
                                        <article class="transcript-history-entry grid gap-[7px] rounded-[5px] border border-line-soft bg-surface p-2.5">
                                            <div class="min-w-0">
                                                <strong class="font-semibold text-ink-soft">
                                                    Version {entry.historyIndex}
                                                </strong>
                                                <small class="text-xs text-faint">
                                                    {formatTimestamp(
                                                        field(
                                                            entry.revision,
                                                            "updated_at_us",
                                                            field(entry.revision, "created_at_us"),
                                                        ),
                                                    )}
                                                    {field(entry.revision, "_deleted") === "true"
                                                        ? " · removed"
                                                        : ""}
                                                </small>
                                            </div>
                                            <p class="m-0 text-[13px] leading-relaxed text-muted">
                                                {field(entry.revision, "text")}
                                            </p>
                                            <button
                                                class={cn(
                                                    "record-action",
                                                    buttonOutline,
                                                    "min-h-[30px] px-[9px] text-xs",
                                                )}
                                                type="button"
                                                disabled={props.disabled}
                                                onClick={() =>
                                                    void restoreRevision(entry.historyIndex)
                                                }
                                            >
                                                Restore version {entry.historyIndex}
                                            </button>
                                        </article>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </section>
                </Show>
                <Show when={linkedAssets().length > 0 && !linkingAssets()}>
                    <div
                        class="transcript-linked-materials mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-faint"
                        aria-label="Linked materials"
                    >
                        <span>Linked materials</span>
                        <For each={linkedAssets()}>
                            {(asset) => (
                                <span class="transcript-material-chip rounded-[5px] border border-line bg-surface-subtle px-2 py-[3px] text-ink-soft">
                                    {field(asset, "filename", "Material")}
                                </span>
                            )}
                        </For>
                    </div>
                </Show>
                <Show when={linkingAssets()}>
                    <section
                        class="transcript-material-editor mt-3 grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-[13px]"
                        aria-label="Link materials to cue"
                    >
                        <strong class="font-semibold text-ink-soft">Materials for this cue</strong>
                        <For each={availableAssets()}>
                            {(asset) => (
                                <label class="flex items-center gap-2 text-xs text-ink-soft">
                                    <input
                                        type="checkbox"
                                        checked={draftAssetIds().includes(asset.id.toLowerCase())}
                                        disabled={props.disabled}
                                        onChange={(event) =>
                                            setDraftAssetIds((current) =>
                                                event.currentTarget.checked
                                                    ? [
                                                          ...new Set([
                                                              ...current,
                                                              asset.id.toLowerCase(),
                                                          ]),
                                                      ]
                                                    : current.filter(
                                                          (id) => id !== asset.id.toLowerCase(),
                                                      ),
                                            )
                                        }
                                        class="accent-accent"
                                    />
                                    <span>{field(asset, "filename", "Untitled material")}</span>
                                </label>
                            )}
                        </For>
                        <button
                            class={cn(
                                "record-action",
                                buttonPrimary,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => void saveAssetLinks()}
                        >
                            Save material links
                        </button>
                    </section>
                </Show>
                <Show when={splitting()}>
                    <section
                        class="transcript-split-editor mt-3 grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-[13px]"
                        aria-label="Split transcript cue"
                    >
                        <label class={labelBase}>
                            Before
                            <textarea
                                rows={3}
                                value={beforeText()}
                                onInput={(event) => setBeforeText(event.currentTarget.value)}
                                class={textareaBase}
                            />
                        </label>
                        <label class={labelBase}>
                            After
                            <textarea
                                rows={3}
                                value={afterText()}
                                onInput={(event) => setAfterText(event.currentTarget.value)}
                                class={textareaBase}
                            />
                        </label>
                        <Show when={field(props.record, "timestamp_state") !== "not-timestamped"}>
                            <label class={labelBase}>
                                Split time
                                <input
                                    type="text"
                                    inputmode="decimal"
                                    value={splitAt()}
                                    onInput={(event) => setSplitAt(event.currentTarget.value)}
                                    class={inputBase}
                                />
                            </label>
                        </Show>
                        <p class="m-0 text-[13px] leading-relaxed text-muted">
                            Keep the words unchanged; the two parts must join to the original cue.
                        </p>
                        <button
                            class={cn(
                                "record-action",
                                buttonPrimary,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={
                                props.disabled ||
                                !beforeText() ||
                                !afterText() ||
                                beforeText() + afterText() !== field(props.record, "text")
                            }
                            onClick={() => void saveSplit()}
                        >
                            Save split
                        </button>
                    </section>
                </Show>
                <Show when={editing()}>
                    <div class="transcript-editor mt-[13px] grid gap-3 rounded-[5px] border border-line bg-surface-subtle p-[13px]">
                        <label class={labelBase}>
                            Cue text
                            <textarea
                                rows={4}
                                value={text()}
                                onInput={(event) => setText(event.currentTarget.value)}
                                class={textareaBase}
                            />
                        </label>
                        <div class="transcript-time-fields grid grid-cols-2 gap-[9px] sm:grid-cols-[1fr_1fr_1.5fr]">
                            <label class={labelBase}>
                                Start time
                                <input
                                    type="text"
                                    inputmode="decimal"
                                    placeholder="HH:MM:SS"
                                    value={start()}
                                    onInput={(event) => setStart(event.currentTarget.value)}
                                    class={inputBase}
                                />
                            </label>
                            <label class={labelBase}>
                                End time
                                <input
                                    type="text"
                                    inputmode="decimal"
                                    placeholder="HH:MM:SS"
                                    value={end()}
                                    onInput={(event) => setEnd(event.currentTarget.value)}
                                    class={inputBase}
                                />
                            </label>
                            <label class={labelBase}>
                                Speaker
                                <input
                                    type="text"
                                    value={speaker()}
                                    onInput={(event) => setSpeaker(event.currentTarget.value)}
                                    class={inputBase}
                                />
                            </label>
                        </div>
                        <div class="transcript-editor-actions flex gap-[7px]">
                            <button
                                class={cn(
                                    "record-action",
                                    buttonPrimary,
                                    "min-h-[30px] px-[9px] text-xs",
                                )}
                                type="button"
                                disabled={props.disabled || !text().trim()}
                                onClick={() =>
                                    props.onSave(props.record, text(), start(), end(), speaker())
                                }
                            >
                                Save correction
                            </button>
                            <button
                                class={cn(
                                    "record-action",
                                    buttonQuiet,
                                    "min-h-[30px] px-[9px] text-xs",
                                )}
                                type="button"
                                onClick={() => setEditing(false)}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </Show>
            </div>
        </article>
    );
}

function transcriptTimeInput(raw: string): string {
    if (!/^\d+$/u.test(raw)) return "";
    return formatTranscriptTimestampUs(BigInt(raw));
}

function transcriptTimeRangeLabel(record: ArchiveRecord): string {
    const start = transcriptTimeInput(field(record, "start_time_us"));
    const end = transcriptTimeInput(field(record, "end_time_us"));
    return end ? `${start} – ${end}` : start;
}
