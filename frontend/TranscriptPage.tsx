import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./TranscriptPage.tailwind";
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
import { errorMessage, field, formatTimestamp, safeBigInt, safeFileName } from "./shared-utils";

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
    const selectedSession = createMemo(
        () =>
            props.sessions.find((session) => session.id === props.selectedSessionId) ??
            props.sessions[0] ??
            null,
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
        if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
        setAudioUrl(null);
        setAudioPreview(null);
        setPlaybackError("");
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
            const preview = await buildAudioPreview(
                props.snapshot,
                session.id,
                track.id,
                startTimeUs,
            );
            clearAudio();
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
        <div class={twClasses("page-body transcript-page", jsxTailwindStyles, "div")}>
            <section
                class={twClasses("record-heading transcript-heading", jsxTailwindStyles, "section")}
            >
                <div class={twClasses("", jsxTailwindStyles, "div")}>
                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                        Capture a lesson, then keep the useful words
                    </span>
                    <h1 class={twClasses("", jsxTailwindStyles, "h1")}>Record and transcribe</h1>
                    <p class={twClasses("", jsxTailwindStyles, "p")}>
                        Choose a session, record or import its audio, then create and review
                        transcript cues alongside the recording.
                    </p>
                </div>
                <div class={twClasses("transcript-heading-actions", jsxTailwindStyles, "div")}>
                    <Show when={props.sessions.length > 0}>
                        <button
                            class={twClasses("button button-outline", jsxTailwindStyles, "button")}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onNewSession()}
                        >
                            <Icon name="plus" />
                            New session
                        </button>
                    </Show>
                    <span
                        class={twClasses("transcript-page-mark", jsxTailwindStyles, "span")}
                        aria-hidden="true"
                    >
                        <Icon name="microphone" />
                    </span>
                </div>
            </section>

            <Show when={props.sessions.length === 0}>
                <section
                    class={twClasses("record-onboarding", jsxTailwindStyles, "section")}
                    aria-labelledby="record-onboarding-title"
                >
                    <span
                        class={twClasses("record-onboarding-mark", jsxTailwindStyles, "span")}
                        aria-hidden="true"
                    >
                        <Icon name="microphone" />
                    </span>
                    <div class={twClasses("", jsxTailwindStyles, "div")}>
                        <h2
                            id="record-onboarding-title"
                            class={twClasses("", jsxTailwindStyles, "h2")}
                        >
                            Start with a tutoring session
                        </h2>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            Create the session first. Tutorux will keep its recording, transcript,
                            notes, and materials together in this archive.
                        </p>
                    </div>
                    <button
                        class={twClasses("button button-primary", jsxTailwindStyles, "button")}
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
                    class={twClasses("transcript-controls", jsxTailwindStyles, "section")}
                    aria-label="Transcript actions"
                >
                    <label
                        class={twClasses("transcript-session-picker", jsxTailwindStyles, "label")}
                    >
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>Session</span>
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
                            class={twClasses("", jsxTailwindStyles, "select")}
                        >
                            <Show when={props.sessions.length === 0}>
                                <option value="">No sessions yet</option>
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
                        <label
                            class={twClasses(
                                "transcript-audio-add-checkbox",
                                jsxTailwindStyles,
                                "label",
                            )}
                        >
                            <input
                                type="checkbox"
                                checked={addSeparateTrack()}
                                disabled={props.disabled}
                                onChange={(event) =>
                                    setAddSeparateTrack(event.currentTarget.checked)
                                }
                                class={twClasses("", jsxTailwindStyles, "input")}
                            />
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                Keep existing audio and add this as a separate track
                            </span>
                        </label>
                    </Show>
                    <div class={twClasses("transcript-control-actions", jsxTailwindStyles, "div")}>
                        <input
                            ref={(element) => (fileInput = element)}
                            class={twClasses("visually-hidden", jsxTailwindStyles, "input")}
                            type="file"
                            accept=".txt,.srt,.vtt,text/plain,text/vtt,application/x-subrip"
                            onChange={receiveFile}
                            aria-label="Choose transcript source file"
                        />
                        <input
                            ref={(element) => (audioFileInput = element)}
                            class={twClasses("visually-hidden", jsxTailwindStyles, "input")}
                            type="file"
                            accept=".wav,audio/wav,audio/x-wav"
                            onChange={receiveAudioFile}
                            aria-label="Choose WAV audio file"
                        />
                        <button
                            class={twClasses("button button-primary", jsxTailwindStyles, "button")}
                            type="button"
                            disabled={props.disabled || !selectedSession()}
                            onClick={chooseImport}
                        >
                            <Icon name="plus" />
                            Import cues
                        </button>
                        <button
                            class={twClasses("button button-outline", jsxTailwindStyles, "button")}
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
                                class={twClasses(
                                    "button button-outline",
                                    jsxTailwindStyles,
                                    "button",
                                )}
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
                                class={twClasses(
                                    "button button-outline",
                                    jsxTailwindStyles,
                                    "button",
                                )}
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
                                class={twClasses(
                                    "button button-outline",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={props.disabled || captureRecorder?.state === "recording"}
                                onClick={() => {
                                    const session = selectedSession();
                                    if (session) props.onRecoverNativeAudio(session.id);
                                }}
                            >
                                Recover saved recording
                            </button>
                        </Show>
                        <label
                            class={twClasses(
                                "transcript-export-picker",
                                jsxTailwindStyles,
                                "label",
                            )}
                        >
                            <span class={twClasses("visually-hidden", jsxTailwindStyles, "span")}>
                                Export format
                            </span>
                            <select
                                value={exportFormat()}
                                disabled={props.disabled || !selectedSession()}
                                onChange={(event) =>
                                    setExportFormat(
                                        event.currentTarget.value as TranscriptExportFormat,
                                    )
                                }
                                aria-label="Transcript export format"
                                class={twClasses("", jsxTailwindStyles, "select")}
                            >
                                <option value="text">Text</option>
                                <option value="srt">SubRip</option>
                                <option value="vtt">WebVTT</option>
                                <option value="json">JSON</option>
                            </select>
                        </label>
                        <button
                            class={twClasses("button button-outline", jsxTailwindStyles, "button")}
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
                    class={twClasses("transcript-capture-panel", jsxTailwindStyles, "section")}
                    aria-label="Microphone recording"
                >
                    <div class={twClasses("transcript-capture-copy", jsxTailwindStyles, "div")}>
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            Session audio
                        </span>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            Record from microphone
                        </strong>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Save the recording to this session, then use “Transcribe this recording”
                            below to create timestamped cues.
                        </span>
                    </div>
                    <label
                        class={twClasses("transcript-capture-consent", jsxTailwindStyles, "label")}
                    >
                        <input
                            type="checkbox"
                            checked={captureConsent()}
                            disabled={props.disabled || captureState() !== "idle"}
                            onChange={(event) => setCaptureConsent(event.currentTarget.checked)}
                            class={twClasses("", jsxTailwindStyles, "input")}
                        />
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            I have permission to record this session
                        </span>
                    </label>
                    <div class={twClasses("transcript-capture-state", jsxTailwindStyles, "div")}>
                        <Show when={captureState() === "recording"}>
                            <span
                                class={twClasses(
                                    "transcript-capture-live",
                                    jsxTailwindStyles,
                                    "span",
                                )}
                                role="timer"
                                aria-live="off"
                            >
                                <i
                                    aria-hidden="true"
                                    class={twClasses("", jsxTailwindStyles, "i")}
                                />
                                Recording
                                <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                    {`${Math.floor(captureElapsed() / 60)
                                        .toString()
                                        .padStart(
                                            2,
                                            "0",
                                        )}:${(captureElapsed() % 60).toString().padStart(2, "0")}`}
                                </strong>
                            </span>
                        </Show>
                        <div
                            class={twClasses(
                                "transcript-capture-actions",
                                jsxTailwindStyles,
                                "div",
                            )}
                        >
                            <Show when={captureState() === "idle"}>
                                <button
                                    class={twClasses(
                                        "button button-primary",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
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
                                <button
                                    class={twClasses(
                                        "button button-danger",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
                                    type="button"
                                    onClick={stopCapture}
                                >
                                    Stop and save
                                </button>
                            </Show>
                            <Show when={captureState() === "saving"}>
                                <span
                                    class={twClasses(
                                        "transcript-capture-saving",
                                        jsxTailwindStyles,
                                        "span",
                                    )}
                                    role="status"
                                    aria-live="polite"
                                >
                                    Saving recording…
                                </span>
                            </Show>
                            <Show when={captureState() === "requesting"}>
                                <span
                                    class={twClasses(
                                        "transcript-capture-saving",
                                        jsxTailwindStyles,
                                        "span",
                                    )}
                                    role="status"
                                    aria-live="polite"
                                >
                                    Waiting for microphone permission…
                                </span>
                            </Show>
                        </div>
                    </div>
                    <Show when={!microphoneAvailable()}>
                        <span
                            class={twClasses("transcript-capture-note", jsxTailwindStyles, "span")}
                        >
                            Microphone recording is not available in this window.
                        </span>
                    </Show>
                    <Show when={captureError()}>
                        <span
                            class={twClasses("transcript-capture-error", jsxTailwindStyles, "span")}
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
                    class={twClasses("transcript-takes-panel", jsxTailwindStyles, "section")}
                    aria-label="Recording takes"
                >
                    <div class={twClasses("transcript-takes-heading", jsxTailwindStyles, "div")}>
                        <div class={twClasses("", jsxTailwindStyles, "div")}>
                            <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                Session audio
                            </span>
                            <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                Recording takes
                            </strong>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                Rename takes and tracks, then move individual items to Trash or
                                restore them here.
                            </span>
                        </div>
                        <span
                            class={twClasses("transcript-takes-count", jsxTailwindStyles, "span")}
                        >
                            {sessionRecordingTakes().length} active takes ·{" "}
                            {trashedSessionRecordingTakes().length} takes and{" "}
                            {trashedSessionRecordingTracks().length} tracks in Trash
                        </span>
                    </div>
                    <div class={twClasses("transcript-takes-list", jsxTailwindStyles, "div")}>
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
                                <article
                                    class={twClasses(
                                        "transcript-take-card transcript-take-card-trashed",
                                        jsxTailwindStyles,
                                        "article",
                                    )}
                                >
                                    <div
                                        class={twClasses(
                                            "transcript-take-copy",
                                            jsxTailwindStyles,
                                            "div",
                                        )}
                                    >
                                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                            {field(take, "label", "Recording take")}
                                        </strong>
                                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                                            Moved to Trash with its audio tracks and timeline data.
                                        </span>
                                    </div>
                                    <button
                                        class={twClasses(
                                            "button button-outline",
                                            jsxTailwindStyles,
                                            "button",
                                        )}
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
                    class={twClasses(
                        "transcript-audio-panel grid min-w-0 gap-4 rounded-panel border border-line bg-surface p-4",
                        jsxTailwindStyles,
                        "section",
                    )}
                    aria-label="Session recording playback"
                >
                    <div
                        class={twClasses("transcript-audio-copy min-w-0", jsxTailwindStyles, "div")}
                    >
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            Session recording
                        </span>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {selectedTrack()?.label ?? "Recording"}
                        </strong>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Load up to 30 seconds from the beginning or a transcript cue.
                        </span>
                    </div>
                    <div
                        class={twClasses(
                            "transcript-audio-controls flex min-w-0 flex-wrap items-center justify-end gap-2",
                            jsxTailwindStyles,
                            "div",
                        )}
                    >
                        <Show when={sessionTracks().length > 1}>
                            <label
                                class={twClasses(
                                    "transcript-audio-picker min-w-0",
                                    jsxTailwindStyles,
                                    "label",
                                )}
                            >
                                <span
                                    class={twClasses("visually-hidden", jsxTailwindStyles, "span")}
                                >
                                    Audio track
                                </span>
                                <select
                                    value={selectedTrack()?.id ?? ""}
                                    aria-label="Audio track"
                                    onChange={(event) => {
                                        clearAudio();
                                        setTrackId(event.currentTarget.value);
                                    }}
                                    class={twClasses("", jsxTailwindStyles, "select")}
                                >
                                    <For each={sessionTracks()}>
                                        {(track) => <option value={track.id}>{track.label}</option>}
                                    </For>
                                </select>
                            </label>
                        </Show>
                        <button
                            class={twClasses("button button-outline", jsxTailwindStyles, "button")}
                            type="button"
                            disabled={!selectedTrack()}
                            onClick={() => void playAudioAt("0")}
                        >
                            Play from start
                        </button>
                    </div>
                    <div
                        class={twClasses(
                            "transcript-audio-export-actions",
                            jsxTailwindStyles,
                            "div",
                        )}
                    >
                        <button
                            class={twClasses(
                                "button button-outline transcript-audio-export",
                                jsxTailwindStyles,
                                "button",
                            )}
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
                            class={twClasses(
                                "button button-outline transcript-audio-export",
                                jsxTailwindStyles,
                                "button",
                            )}
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
                    <p class={twClasses("transcript-audio-export-note", jsxTailwindStyles, "p")}>
                        Export WAV requires a continuous track. If audio is missing from the
                        timeline, choose “Export with gap silence” to preserve timing by inserting
                        silence. Tracks over 4 GiB use RF64, which currently requires Tutorux for
                        desktop because browser downloads cannot safely save files this large.
                    </p>
                    <Show when={audioUrl() && audioPreview()}>
                        <AudioWaveform
                            preview={audioPreview()!}
                            url={audioUrl()!}
                            onPlayer={(element) => (audioPlayer = element)}
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
                            class={twClasses("transcript-audio-error", jsxTailwindStyles, "span")}
                            role="alert"
                        >
                            {playbackError()}
                        </span>
                    </Show>
                </section>
            </Show>

            <Show when={props.sessions.length > 0}>
                <section
                    class={twClasses(
                        "record-list-shell transcript-list-shell",
                        jsxTailwindStyles,
                        "section",
                    )}
                >
                    <div class={twClasses("record-list-toolbar", jsxTailwindStyles, "div")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                {sessionRecords().length}
                            </strong>{" "}
                            transcript cues
                            <Show when={selectedSession()}>
                                {(session) => (
                                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                                        {" "}
                                        · {field(session(), "title", "Untitled session")}
                                    </span>
                                )}
                            </Show>
                        </span>
                        <span class={twClasses("list-view-label", jsxTailwindStyles, "span")}>
                            <Icon name="shield" />
                            Review before reuse
                        </span>
                        <button
                            class={twClasses(
                                "button button-outline transcript-merge-button",
                                jsxTailwindStyles,
                                "button",
                            )}
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
                            <EmptyState
                                icon="sessions"
                                title="Start with a session"
                                text="Transcript cues belong to a tutoring session, so create or open one first."
                                action="Create a session"
                                onAction={props.onNewSession}
                                disabled={props.disabled}
                            />
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
                            <div class={twClasses("transcript-list", jsxTailwindStyles, "div")}>
                                <For each={sessionRecords()}>
                                    {(record, index) => (
                                        <TranscriptCueCard
                                            record={record}
                                            displayIndex={index() + 1}
                                            disabled={props.disabled}
                                            audioAvailable={sessionTracks().length > 0}
                                            selected={selectedCueIds().includes(record.id)}
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
        <article class={twClasses("transcript-take-card", jsxTailwindStyles, "article")}>
            <div class={twClasses("transcript-take-card-heading", jsxTailwindStyles, "div")}>
                <label class={twClasses("", jsxTailwindStyles, "label")}>
                    <span class={twClasses("", jsxTailwindStyles, "span")}>Take name</span>
                    <input
                        value={label()}
                        maxLength={120}
                        onInput={(event) => setLabel(event.currentTarget.value)}
                        aria-label="Recording take name"
                        class={twClasses("", jsxTailwindStyles, "input")}
                    />
                </label>
                <button
                    class={twClasses("button button-outline", jsxTailwindStyles, "button")}
                    type="button"
                    disabled={props.disabled || label().trim() === field(props.take, "label")}
                    onClick={() => props.onRenameTake(props.take, label())}
                >
                    Save name
                </button>
                <button
                    class={twClasses(
                        "button button-outline transcript-take-trash",
                        jsxTailwindStyles,
                        "button",
                    )}
                    type="button"
                    disabled={props.disabled}
                    onClick={() => props.onTrash(props.take)}
                >
                    Move to Trash
                </button>
            </div>
            <div class={twClasses("transcript-take-meta", jsxTailwindStyles, "div")}>
                <span class={twClasses("", jsxTailwindStyles, "span")}>
                    {field(props.take, "state", "saved")}
                </span>
                <span class={twClasses("", jsxTailwindStyles, "span")}>
                    {props.tracks.length} {props.tracks.length === 1 ? "track" : "tracks"}
                </span>
                <span class={twClasses("", jsxTailwindStyles, "span")}>
                    {field(props.take, "source", "saved audio")}
                </span>
            </div>
            <Show when={props.tracks.length > 0}>
                <div
                    class={twClasses("transcript-take-tracks", jsxTailwindStyles, "div")}
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
                    class={twClasses(
                        "transcript-take-tracks transcript-take-trashed-tracks",
                        jsxTailwindStyles,
                        "div",
                    )}
                    aria-label="Tracks in Trash"
                >
                    <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                        Tracks in Trash
                    </strong>
                    <For each={props.trashedTracks}>
                        {(track) => (
                            <div
                                class={twClasses(
                                    "transcript-take-trashed-track-row",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {field(track, "label", "Recording track")}
                                </span>
                                <button
                                    class={twClasses(
                                        "button button-outline",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
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
        <div class={twClasses("transcript-take-track-row", jsxTailwindStyles, "div")}>
            <label class={twClasses("", jsxTailwindStyles, "label")}>
                <span class={twClasses("", jsxTailwindStyles, "span")}>Track name</span>
                <input
                    value={draft()}
                    maxLength={120}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    aria-label={`Track name: ${props.track.label}`}
                    class={twClasses("", jsxTailwindStyles, "input")}
                />
            </label>
            <button
                class={twClasses("button button-outline", jsxTailwindStyles, "button")}
                type="button"
                disabled={props.disabled || !changed()}
                onClick={() => props.onRename(props.track, draft().trim() || props.track.label)}
            >
                Save track name
            </button>
            <button
                class={twClasses(
                    "button button-outline transcript-take-trash",
                    jsxTailwindStyles,
                    "button",
                )}
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
        setText(field(props.record, "text"));
        setStart(transcriptTimeInput(field(props.record, "start_time_us")));
        setEnd(transcriptTimeInput(field(props.record, "end_time_us")));
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
        <article class={twClasses("transcript-cue", jsxTailwindStyles, "article")}>
            <div class={twClasses("transcript-cue-marker", jsxTailwindStyles, "div")}>
                <input
                    type="checkbox"
                    aria-label={"Select cue " + props.displayIndex + " to merge"}
                    checked={props.selected}
                    disabled={props.disabled}
                    onChange={(event) =>
                        props.onToggleSelection(props.record, event.currentTarget.checked)
                    }
                    class={twClasses("", jsxTailwindStyles, "input")}
                />
                <span class={twClasses("", jsxTailwindStyles, "span")}>
                    {String(props.displayIndex).padStart(2, "0")}
                </span>
            </div>
            <div class={twClasses("transcript-cue-content", jsxTailwindStyles, "div")}>
                <div class={twClasses("transcript-cue-meta", jsxTailwindStyles, "div")}>
                    <span class={twClasses("transcript-time", jsxTailwindStyles, "span")}>
                        {field(props.record, "timestamp_state") === "not-timestamped"
                            ? "Time not provided"
                            : transcriptTimeRangeLabel(props.record)}
                    </span>
                    <span
                        class={twClasses(
                            `transcript-status status-${verification()}`,
                            jsxTailwindStyles,
                            "span",
                        )}
                    >
                        <span class={twClasses("", jsxTailwindStyles, "span")} />
                        {statusLabel()}
                    </span>
                </div>
                <Show
                    when={field(props.record, "speaker_label", field(props.record, "speaker_name"))}
                >
                    <span class={twClasses("transcript-speaker", jsxTailwindStyles, "span")}>
                        {field(props.record, "speaker_label", field(props.record, "speaker_name"))}
                    </span>
                </Show>
                <p class={twClasses("transcript-cue-text", jsxTailwindStyles, "p")}>
                    {field(props.record, "text")}
                </p>
                <div class={twClasses("transcript-cue-actions", jsxTailwindStyles, "div")}>
                    <Show when={props.audioAvailable}>
                        <button
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
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
                        class={twClasses(
                            "button button-outline record-action",
                            jsxTailwindStyles,
                            "button",
                        )}
                        type="button"
                        disabled={props.disabled}
                        onClick={beginEditing}
                    >
                        Correct cue
                    </button>
                    <button
                        class={twClasses(
                            "button button-outline record-action",
                            jsxTailwindStyles,
                            "button",
                        )}
                        type="button"
                        disabled={props.disabled}
                        onClick={() => (splitting() ? setSplitting(false) : beginSplitting())}
                    >
                        {splitting() ? "Cancel split" : "Split cue"}
                    </button>
                    <Show when={availableAssets().length > 0}>
                        <button
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
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
                            class={twClasses(
                                "button button-quiet record-action",
                                jsxTailwindStyles,
                                "button",
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
                            class={twClasses(
                                "button button-quiet record-action",
                                jsxTailwindStyles,
                                "button",
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
                        class={twClasses("transcript-history-panel", jsxTailwindStyles, "section")}
                        aria-label="Transcript cue version history"
                    >
                        <div
                            class={twClasses(
                                "transcript-history-heading",
                                jsxTailwindStyles,
                                "div",
                            )}
                        >
                            <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                Version history
                            </span>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                {Math.max(0, (history()?.length ?? 1) - 1)} earlier versions
                            </span>
                        </div>
                        <Show
                            when={(history()?.length ?? 0) > 1}
                            fallback={
                                <p
                                    class={twClasses(
                                        "transcript-history-empty",
                                        jsxTailwindStyles,
                                        "p",
                                    )}
                                >
                                    This transcript cue has no earlier versions.
                                </p>
                            }
                        >
                            <div
                                class={twClasses(
                                    "transcript-history-list",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
                                <For
                                    each={(history()?.slice(1) ?? []).map((revision, index) => ({
                                        revision,
                                        historyIndex: index + 1,
                                    }))}
                                >
                                    {(entry) => (
                                        <article
                                            class={twClasses(
                                                "transcript-history-entry",
                                                jsxTailwindStyles,
                                                "article",
                                            )}
                                        >
                                            <div class={twClasses("", jsxTailwindStyles, "div")}>
                                                <strong
                                                    class={twClasses(
                                                        "",
                                                        jsxTailwindStyles,
                                                        "strong",
                                                    )}
                                                >
                                                    Version {entry.historyIndex}
                                                </strong>
                                                <small
                                                    class={twClasses(
                                                        "",
                                                        jsxTailwindStyles,
                                                        "small",
                                                    )}
                                                >
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
                                            <p class={twClasses("", jsxTailwindStyles, "p")}>
                                                {field(entry.revision, "text")}
                                            </p>
                                            <button
                                                class={twClasses(
                                                    "button button-outline record-action",
                                                    jsxTailwindStyles,
                                                    "button",
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
                        class={twClasses("transcript-linked-materials", jsxTailwindStyles, "div")}
                        aria-label="Linked materials"
                    >
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Linked materials
                        </span>
                        <For each={linkedAssets()}>
                            {(asset) => (
                                <span
                                    class={twClasses(
                                        "transcript-material-chip",
                                        jsxTailwindStyles,
                                        "span",
                                    )}
                                >
                                    {field(asset, "filename", "Material")}
                                </span>
                            )}
                        </For>
                    </div>
                </Show>
                <Show when={linkingAssets()}>
                    <section
                        class={twClasses(
                            "transcript-material-editor",
                            jsxTailwindStyles,
                            "section",
                        )}
                        aria-label="Link materials to cue"
                    >
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            Materials for this cue
                        </strong>
                        <For each={availableAssets()}>
                            {(asset) => (
                                <label class={twClasses("", jsxTailwindStyles, "label")}>
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
                                        class={twClasses("", jsxTailwindStyles, "input")}
                                    />
                                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                                        {field(asset, "filename", "Untitled material")}
                                    </span>
                                </label>
                            )}
                        </For>
                        <button
                            class={twClasses(
                                "button button-primary record-action",
                                jsxTailwindStyles,
                                "button",
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
                        class={twClasses("transcript-split-editor", jsxTailwindStyles, "section")}
                        aria-label="Split transcript cue"
                    >
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            Before
                            <textarea
                                rows={3}
                                value={beforeText()}
                                onInput={(event) => setBeforeText(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "textarea")}
                            />
                        </label>
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            After
                            <textarea
                                rows={3}
                                value={afterText()}
                                onInput={(event) => setAfterText(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "textarea")}
                            />
                        </label>
                        <Show when={field(props.record, "timestamp_state") !== "not-timestamped"}>
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                Split time
                                <input
                                    type="text"
                                    inputmode="decimal"
                                    value={splitAt()}
                                    onInput={(event) => setSplitAt(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "input")}
                                />
                            </label>
                        </Show>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            Keep the words unchanged; the two parts must join to the original cue.
                        </p>
                        <button
                            class={twClasses(
                                "button button-primary record-action",
                                jsxTailwindStyles,
                                "button",
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
                    <div class={twClasses("transcript-editor", jsxTailwindStyles, "div")}>
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            Cue text
                            <textarea
                                rows={4}
                                value={text()}
                                onInput={(event) => setText(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "textarea")}
                            />
                        </label>
                        <div class={twClasses("transcript-time-fields", jsxTailwindStyles, "div")}>
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                Start time
                                <input
                                    type="text"
                                    inputmode="decimal"
                                    placeholder="HH:MM:SS"
                                    value={start()}
                                    onInput={(event) => setStart(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "input")}
                                />
                            </label>
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                End time
                                <input
                                    type="text"
                                    inputmode="decimal"
                                    placeholder="HH:MM:SS"
                                    value={end()}
                                    onInput={(event) => setEnd(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "input")}
                                />
                            </label>
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                Speaker
                                <input
                                    type="text"
                                    value={speaker()}
                                    onInput={(event) => setSpeaker(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "input")}
                                />
                            </label>
                        </div>
                        <div
                            class={twClasses("transcript-editor-actions", jsxTailwindStyles, "div")}
                        >
                            <button
                                class={twClasses(
                                    "button button-primary record-action",
                                    jsxTailwindStyles,
                                    "button",
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
                                class={twClasses(
                                    "button button-quiet record-action",
                                    jsxTailwindStyles,
                                    "button",
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
