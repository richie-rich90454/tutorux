import { createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { newUuid, RecordType } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import type { ArchiveRecord } from "./archive/format";
import {
    makeSynchronizedCaptureChunkRecords,
    makeSynchronizedCaptureFinishRecords,
    makeSynchronizedCaptureStartRecords,
    makeSynchronizedCaptureStateRecords,
    makeSynchronizedRecordingRecords,
    SynchronizedRecording,
    type SynchronizedCaptureTrackIdentity,
} from "./domain/synchronized-recording";
import type { CaptureSampleFormat, MicrophoneArchiveSource } from "./domain/microphone-recording";
import {
    listNativeSynchronizedAudioDevices,
    preflightNativeMicrophone,
    startNativeSynchronizedAudioCapture,
} from "./platform/synchronized-audio";
import type {
    MicrophonePreflightLevel,
    MicrophonePreflightSummary,
    SynchronizedAudioTrack,
} from "./platform/synchronized-audio";
import { hasDesktopArchiveCapability, persistMicrophoneArchiveGeneration } from "./platform/tauri";
import { platform } from "@platform";

function parseCaptureFormat(value: string | undefined): CaptureSampleFormat {
    switch (value) {
        case "pcm_u8":
        case "pcm_s16le":
        case "pcm_s24le":
        case "pcm_s32le":
        case "pcm_f32le":
            return value;
        default:
            return "pcm_s16le";
    }
}

interface AudioDeviceOption {
    id: string;
    label: string;
    source?: "system-audio" | "application-audio";
}

interface CaptureStopResult {
    files?: [File | null, File | null];
    archiveCommitted?: true;
    pauseCount: number;
    pausedDurationUs: string;
    warnings: string[];
}

interface ActiveCapture {
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<CaptureStopResult>;
    discard(): Promise<void>;
}

interface CaptureDetails {
    sessionId: string;
    archiveId: string;
    startedAtUs: string;
    consentAtUs: string;
    captureSourceBackend: string;
    consentConfirmedBy: string;
}

interface Pending extends CaptureDetails, CaptureStopResult {}

interface Props {
    snapshot: ArchiveSnapshot;
    session: ArchiveRecord;
    trackIds: readonly string[];
    disabled: boolean;
    onSave: (
        records: ArchiveRecord[],
        message: string,
        snapshot: ArchiveSnapshot,
    ) => Promise<boolean>;
    onCheckpointPersisted?: (snapshot: ArchiveSnapshot) => void;
}

async function preflightBrowserMicrophone(
    deviceId: string,
    onLevel: (level: Omit<MicrophonePreflightLevel, "probeId">) => void,
): Promise<MicrophonePreflightSummary> {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
        throw new Error("This browser cannot check microphone input levels.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
    });
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    try {
        context = new AudioContext();
        if (context.state === "suspended") await context.resume();
        source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const durationMs = 1_800;
        const startedAt = performance.now();
        let previousAt = startedAt;
        let totalPeak = 0;
        let totalSquares = 0;
        let totalCount = 0;
        let intervalPeak = 0;
        let intervalSquares = 0;
        let intervalCount = 0;

        while (performance.now() - startedAt < durationMs) {
            analyser.getFloatTimeDomainData(samples);
            for (const sample of samples) {
                const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
                const magnitude = Math.abs(value);
                totalPeak = Math.max(totalPeak, magnitude);
                intervalPeak = Math.max(intervalPeak, magnitude);
                totalSquares += value * value;
                intervalSquares += value * value;
                totalCount += 1;
                intervalCount += 1;
            }
            const now = performance.now();
            if (now - previousAt >= 100) {
                const elapsedMs = Math.min(durationMs, Math.round(now - startedAt));
                const rms = intervalCount ? Math.sqrt(intervalSquares / intervalCount) : 0;
                onLevel({
                    elapsedMs,
                    framesInInterval: Math.round(((now - previousAt) * context.sampleRate) / 1_000),
                    framesMeasured: Math.round(((now - startedAt) * context.sampleRate) / 1_000),
                    peakLevel: intervalPeak,
                    rmsLevel: rms,
                    peakDbfs: intervalPeak > 0 ? 20 * Math.log10(intervalPeak) : -120,
                    rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : -120,
                });
                previousAt = now;
                intervalPeak = 0;
                intervalSquares = 0;
                intervalCount = 0;
            }
            await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
        }

        const rms = totalCount ? Math.sqrt(totalSquares / totalCount) : 0;
        return {
            deviceId,
            measuredDurationMs: Math.min(durationMs, Math.round(performance.now() - startedAt)),
            framesMeasured: Math.round((durationMs * context.sampleRate) / 1_000),
            peakLevel: totalPeak,
            rmsLevel: rms,
            peakDbfs: totalPeak > 0 ? 20 * Math.log10(totalPeak) : -120,
            rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : -120,
            signalDetected: rms >= 0.001,
        };
    } finally {
        source?.disconnect();
        for (const track of stream.getTracks()) track.stop();
        await context?.close().catch(() => undefined);
    }
}

/** Capture aligned microphone and one optional shared or per-application audio track. */
export function SynchronizedRecorder(props: Props) {
    const [devices, setDevices] = createSignal<AudioDeviceOption[]>([]);
    const [systemAudioDevices, setSystemAudioDevices] = createSignal<AudioDeviceOption[]>([]);
    const [deviceId, setDeviceId] = createSignal("");
    const [systemAudioDeviceId, setSystemAudioDeviceId] = createSignal("");
    const [secondaryAudioUnavailableReason, setSecondaryAudioUnavailableReason] = createSignal("");
    const [microphoneUnavailableReason, setMicrophoneUnavailableReason] = createSignal("");
    const [preflightState, setPreflightState] = createSignal<
        "unchecked" | "checking" | "ready" | "silent"
    >("unchecked");
    const [preflightDeviceId, setPreflightDeviceId] = createSignal("");
    const [inputPeak, setInputPeak] = createSignal(0);
    const [inputRmsDbfs, setInputRmsDbfs] = createSignal(-120);
    const [preflightMessage, setPreflightMessage] = createSignal(
        "Check the selected microphone before recording.",
    );
    const [consent, setConsent] = createSignal(false);
    const [state, setState] = createSignal<
        "idle" | "requesting" | "recording" | "pausing" | "paused" | "resuming" | "saving"
    >("idle");
    const [pending, setPending] = createSignal<Pending>();
    const [error, setError] = createSignal("");
    const [status, setStatus] = createSignal("");
    let active: ActiveCapture | undefined;
    let disposed = false;
    let capture: CaptureDetails;
    let archiveCommitChain: Promise<void> = Promise.resolve();
    let archiveCommitFailure: Error | undefined;
    let captureArchiveId = "";
    let captureSessionId = "";
    let nativeTakeId = "";
    const nativeTrackIds: Partial<Record<MicrophoneArchiveSource, string>> = {};

    const resetMicrophonePreflight = () => {
        setPreflightState("unchecked");
        setPreflightDeviceId("");
        setInputPeak(0);
        setInputRmsDbfs(-120);
        setPreflightMessage("Check the selected microphone before recording.");
    };

    const commitArchiveRecords = (
        prepare: (
            snapshot: ArchiveSnapshot,
            session: ArchiveRecord,
        ) => ArchiveRecord[] | Promise<ArchiveRecord[]>,
        message: string,
    ): Promise<void> => {
        const operation = archiveCommitChain.then(async () => {
            if (archiveCommitFailure) throw archiveCommitFailure;
            const snapshot = props.snapshot;
            if (
                snapshot.header.id.toLowerCase() !== captureArchiveId.toLowerCase() ||
                !snapshot.canMutate ||
                !hasDesktopArchiveCapability(snapshot.source) ||
                props.session.id.toLowerCase() !== captureSessionId.toLowerCase()
            ) {
                throw new Error(
                    "Reopen the original unlocked archive and session to continue this take.",
                );
            }
            const session = await snapshot.getRecord(RecordType.session, captureSessionId);
            if (!session || session.fields.get("_deleted") === "true") {
                throw new Error("The original tutoring session is no longer available.");
            }
            const records = await prepare(snapshot, session);
            if (!(await props.onSave(records, message, snapshot))) {
                throw new Error(
                    "The synchronized audio checkpoint could not be committed to the archive.",
                );
            }
            const committed = props.snapshot;
            if (
                committed.header.id.toLowerCase() !== captureArchiveId.toLowerCase() ||
                committed.commit.generation !== snapshot.commit.generation + 1n ||
                committed.source.size <= snapshot.source.size
            ) {
                const failure = new Error(
                    "The synchronized audio checkpoint was not published as one archive generation.",
                );
                archiveCommitFailure = failure;
                throw failure;
            }
            try {
                const deltaSize = committed.source.size - snapshot.source.size;
                if (deltaSize > 8n * 1024n * 1024n || deltaSize > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new Error(
                        "The synchronized audio checkpoint exceeds the supported archive generation size.",
                    );
                }
                const generationBytes = await committed.source.read(
                    snapshot.source.size,
                    Number(deltaSize),
                );
                if (generationBytes.byteLength !== Number(deltaSize)) {
                    throw new Error(
                        "The synchronized audio checkpoint could not be read back from the archive writer.",
                    );
                }
                await persistMicrophoneArchiveGeneration(
                    committed.source,
                    generationBytes,
                    committed.commit.generation,
                );
                props.onCheckpointPersisted?.(committed);
            } catch (cause) {
                archiveCommitFailure = cause instanceof Error ? cause : new Error(String(cause));
                throw archiveCommitFailure;
            }
        });
        archiveCommitChain = operation.catch(() => undefined);
        return operation;
    };

    const loadNativeTake = async (snapshot: ArchiveSnapshot, session: ArchiveRecord) => {
        if (!nativeTakeId) throw new Error("The synchronized recording metadata has not started.");
        const trackEntries = Object.entries(nativeTrackIds) as [MicrophoneArchiveSource, string][];
        const [tracks, take] = await Promise.all([
            Promise.all(
                trackEntries.map(async ([source, trackId]) => {
                    const track = await snapshot.getRecord(RecordType.assetMetadata, trackId);
                    if (!track)
                        throw new Error(
                            `The ${source} recovery track is missing from the archive.`,
                        );
                    return track;
                }),
            ),
            snapshot.getRecord(RecordType.assetMetadata, nativeTakeId),
        ]);
        if (!take) throw new Error("The synchronized recording take is missing from the archive.");
        return { tracks, take, session };
    };

    onCleanup(() => {
        disposed = true;
        const recorder = active;
        active = undefined;
        if (recorder && platform.kind === "desktop") void recorder.stop().catch(() => undefined);
        else void recorder?.discard();
    });

    const refresh = async () => {
        try {
            if (platform.kind === "desktop") {
                const found = await listNativeSynchronizedAudioDevices();
                const microphones = found.microphones.map((device) => ({
                    id: device.deviceId,
                    label: `${device.label}${device.isDefault ? " · Default" : ""}`,
                }));
                const sharedAudio = [
                    ...found.systemAudio.map((device) => ({
                        id: device.deviceId,
                        label: device.label,
                        source: "system-audio" as const,
                    })),
                    ...found.applicationAudio.map((device) => ({
                        id: device.deviceId,
                        label: device.label,
                        source: "application-audio" as const,
                    })),
                ];
                setDevices(microphones);
                setSystemAudioDevices(sharedAudio);
                setMicrophoneUnavailableReason(
                    found.microphoneAvailable
                        ? ""
                        : "The desktop host did not find an available microphone.",
                );
                const secondaryReasons = [
                    !found.systemAudioAvailable && found.systemAudioUnavailableReason
                        ? `System audio unavailable: ${found.systemAudioUnavailableReason}`
                        : undefined,
                    !found.applicationAudioAvailable && found.applicationAudioUnavailableReason
                        ? `Application audio unavailable: ${found.applicationAudioUnavailableReason}`
                        : undefined,
                ].filter((reason): reason is string => Boolean(reason));
                setSecondaryAudioUnavailableReason(secondaryReasons.join(" "));

                if (!microphones.some((device) => device.id === deviceId())) {
                    const nextDeviceId =
                        microphones.find((device) => device.label.endsWith(" · Default"))?.id ??
                        microphones[0]?.id ??
                        "";
                    setDeviceId(nextDeviceId);
                    resetMicrophonePreflight();
                }
                if (!sharedAudio.some((device) => device.id === systemAudioDeviceId())) {
                    setSystemAudioDeviceId(
                        sharedAudio.find((device) =>
                            found.systemAudio.some(
                                (candidate) =>
                                    candidate.deviceId === device.id && candidate.isDefault,
                            ),
                        )?.id ?? "",
                    );
                }
            } else if (navigator.mediaDevices?.enumerateDevices) {
                const microphones = (await navigator.mediaDevices.enumerateDevices())
                    .filter((device) => device.kind === "audioinput")
                    .filter((device) => device.deviceId)
                    .map((device, index) => ({
                        id: device.deviceId,
                        label: device.label || `Microphone ${index + 1}`,
                    }));
                setDevices(microphones);
                if (deviceId() && !microphones.some((device) => device.id === deviceId())) {
                    setDeviceId("");
                    resetMicrophonePreflight();
                }
                setMicrophoneUnavailableReason(
                    typeof navigator.mediaDevices.getUserMedia === "function"
                        ? ""
                        : "This browser does not support microphone capture.",
                );
            } else {
                setDevices([]);
                setMicrophoneUnavailableReason(
                    typeof navigator.mediaDevices?.getUserMedia === "function"
                        ? ""
                        : "This browser does not support microphone capture.",
                );
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    onMount(() => void refresh());

    const checkMicrophone = async () => {
        if (state() !== "idle" || preflightState() === "checking") return;
        if (nativeDesktop() && !deviceId()) {
            setError(
                microphoneUnavailableReason() ||
                    "Choose an available microphone before checking input.",
            );
            return;
        }
        const selectedDevice = deviceId();
        setError("");
        setPreflightState("checking");
        setPreflightDeviceId(selectedDevice);
        setInputPeak(0);
        setPreflightMessage("Listening for microphone input…");
        const reportLevel = (level: Omit<MicrophonePreflightLevel, "probeId">) => {
            if (disposed) return;
            setInputPeak(level.peakLevel);
            setInputRmsDbfs(level.rmsDbfs);
            setPreflightMessage(
                `Listening… ${level.rmsDbfs.toFixed(1)} dBFS RMS · ${Math.round(level.elapsedMs)} ms`,
            );
        };
        try {
            const summary = nativeDesktop()
                ? await preflightNativeMicrophone(selectedDevice, reportLevel)
                : await preflightBrowserMicrophone(selectedDevice, reportLevel);
            if (disposed || selectedDevice !== deviceId()) return;
            setInputPeak(summary.peakLevel);
            setInputRmsDbfs(summary.rmsDbfs);
            if (summary.signalDetected) {
                setPreflightState("ready");
                setPreflightMessage(
                    `Microphone signal detected · ${summary.rmsDbfs.toFixed(1)} dBFS RMS · ${summary.peakDbfs.toFixed(1)} dBFS peak`,
                );
            } else {
                setPreflightState("silent");
                setPreflightMessage(
                    `No usable microphone signal · ${summary.rmsDbfs.toFixed(1)} dBFS RMS. Speak near the selected microphone and check again.`,
                );
            }
            if (!nativeDesktop()) await refresh();
        } catch (cause) {
            if (!disposed) {
                setPreflightState("unchecked");
                setPreflightMessage("Microphone check did not complete.");
                setError(cause instanceof Error ? cause.message : String(cause));
            }
        }
    };

    const save = async (item: Pending) => {
        if (item.archiveCommitted) {
            setPending(undefined);
            const message = item.warnings.length
                ? "Synchronized recording checkpoints were saved; one or more sources stopped early."
                : "The synchronized audio take was saved progressively to the archive.";
            setStatus(item.warnings.length ? `${message} ${item.warnings.join(" ")}` : message);
            setError("");
            setState("idle");
            return;
        }
        if (
            props.disabled ||
            props.session.id !== item.sessionId ||
            props.snapshot.header.id !== item.archiveId
        ) {
            setError("Select the original archive and session to save this recording.");
            setState("idle");
            return;
        }
        setState("saving");
        setError("");
        try {
            const snapshot = props.snapshot;
            const session = props.session;
            const records = await makeSynchronizedRecordingRecords({
                session,
                files: item.files ?? [null, null],
                knownTrackIds: props.trackIds,
                startedAtUs: item.startedAtUs,
                consentAtUs: item.consentAtUs,
                pauseCount: item.pauseCount,
                pausedDurationUs: item.pausedDurationUs,
                captureSourceBackend: item.captureSourceBackend,
                consentConfirmedBy: item.consentConfirmedBy,
                warnings: item.warnings,
            });
            if (props.snapshot !== snapshot || props.session !== session) {
                throw new Error(
                    "The archive changed while preparing the recording. Save again to use the latest session.",
                );
            }
            const hasMicrophone = Boolean(item.files?.[0]);
            const hasSharedAudio = Boolean(item.files?.[1]);
            const message = item.warnings.length
                ? "Partial synchronized recording saved."
                : hasMicrophone && hasSharedAudio
                  ? "Both synchronized audio tracks were saved in one recording take."
                  : "Microphone recording saved.";
            if (await props.onSave(records, message, snapshot)) {
                setPending(undefined);
                setStatus(item.warnings.length ? `${message} ${item.warnings.join(" ")}` : message);
            } else {
                setError(
                    "The recording could not be saved. Retry saving while this view remains open.",
                );
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            if (!disposed) setState("idle");
        }
    };

    const stop = async (message = "") => {
        if (!active || !["recording", "pausing", "paused", "resuming"].includes(state())) return;
        const recorder = active;
        active = undefined;
        setState("saving");
        try {
            const result = await recorder.stop();
            if (disposed) return;
            const item: Pending = { ...capture, ...result };
            setPending(item);
            if (message) setStatus(message);
            await save(item);
        } catch (cause) {
            if (!disposed) {
                setError(cause instanceof Error ? cause.message : String(cause));
                setState("idle");
            }
        }
    };

    const togglePause = async () => {
        const recorder = active;
        const previous = state();
        if (!recorder || (previous !== "recording" && previous !== "paused")) return;
        setError("");
        setState(previous === "recording" ? "pausing" : "resuming");
        try {
            if (previous === "recording") await recorder.pause();
            else await recorder.resume();
            if (!disposed && active === recorder) {
                setState(previous === "recording" ? "paused" : "recording");
            }
        } catch (cause) {
            if (!disposed && active === recorder) {
                setState(previous);
                setError(cause instanceof Error ? cause.message : String(cause));
            }
        }
    };

    const reportSourceFailure = (track: SynchronizedAudioTrack, message: string) => {
        const source =
            track === "microphone"
                ? "Microphone"
                : track === "system-audio"
                  ? "Shared system audio"
                  : "Application audio";
        setStatus(
            `${source} capture stopped: ${message} The other track will continue if available.`,
        );
    };

    const start = async () => {
        if (!consent() || props.disabled || pending()) return;
        if (preflightState() !== "ready" || preflightDeviceId() !== deviceId()) {
            setError(
                "Check the selected microphone and confirm that it has an input signal before recording.",
            );
            return;
        }
        if (platform.kind === "desktop" && !deviceId()) {
            setError(
                microphoneUnavailableReason() || "Choose an available microphone before recording.",
            );
            return;
        }
        setState("requesting");
        setError("");
        setStatus("");
        const consentAtUs = (BigInt(Date.now()) * 1000n).toString();
        const sessionId = props.session.id;
        const archiveId = props.snapshot.header.id;
        captureSessionId = sessionId;
        captureArchiveId = archiveId;
        archiveCommitFailure = undefined;
        nativeTakeId = "";
        delete nativeTrackIds.microphone;
        delete nativeTrackIds["system-audio"];
        delete nativeTrackIds["application-audio"];
        let recorder: ActiveCapture;
        let details: CaptureDetails;

        try {
            if (platform.kind === "desktop") {
                if (
                    !props.snapshot.canMutate ||
                    !hasDesktopArchiveCapability(props.snapshot.source)
                ) {
                    throw new Error(
                        "Open an unlocked local archive before starting desktop audio capture.",
                    );
                }
                const captureId = newUuid();
                const selectedSecondaryAudio = systemAudioDevices().find(
                    (device) => device.id === systemAudioDeviceId(),
                );
                const nativeRecorder = await startNativeSynchronizedAudioCapture({
                    consentConfirmed: true,
                    consentAtUs,
                    microphoneDeviceId: deviceId(),
                    systemAudioDeviceId:
                        selectedSecondaryAudio?.source === "system-audio"
                            ? selectedSecondaryAudio.id
                            : null,
                    applicationAudioDeviceId:
                        selectedSecondaryAudio?.source === "application-audio"
                            ? selectedSecondaryAudio.id
                            : null,
                    captureId,
                    archive: {
                        onStarted: async (started) => {
                            const tracks: SynchronizedCaptureTrackIdentity[] = [];
                            const trackIdentities: Omit<
                                SynchronizedCaptureTrackIdentity,
                                "trackId"
                            >[] = [
                                {
                                    source: "microphone",
                                    sampleRateHz: started.microphoneSampleRateHz,
                                    sampleFormat: parseCaptureFormat(
                                        started.microphoneSampleFormat,
                                    ),
                                    channelCount: started.microphoneChannelCount ?? 1,
                                    label: "Microphone recording",
                                },
                                {
                                    source: "system-audio",
                                    sampleRateHz: started.systemAudioSampleRateHz,
                                    sampleFormat: parseCaptureFormat(
                                        started.systemAudioSampleFormat,
                                    ),
                                    channelCount: started.systemAudioChannelCount ?? 1,
                                    label: "Shared system audio",
                                    ...(selectedSecondaryAudio?.source === "system-audio"
                                        ? { sourceDeviceId: selectedSecondaryAudio.id }
                                        : {}),
                                },
                                {
                                    source: "application-audio",
                                    sampleRateHz: started.applicationAudioSampleRateHz,
                                    sampleFormat: parseCaptureFormat(
                                        started.applicationAudioSampleFormat,
                                    ),
                                    channelCount: started.applicationAudioChannelCount ?? 1,
                                    label: started.applicationAudioName
                                        ? `${started.applicationAudioName} application audio`
                                        : "Application audio",
                                    ...(started.applicationAudioDeviceId != null
                                        ? { sourceDeviceId: started.applicationAudioDeviceId }
                                        : {}),
                                    ...(started.applicationAudioBackend != null
                                        ? { sourceBackend: started.applicationAudioBackend }
                                        : {}),
                                    ...(started.applicationAudioName != null
                                        ? { applicationName: started.applicationAudioName }
                                        : {}),
                                    ...(started.applicationAudioProcessId != null
                                        ? {
                                              applicationProcessId:
                                                  started.applicationAudioProcessId,
                                          }
                                        : {}),
                                    ...(started.applicationAudioBundleId != null
                                        ? { applicationBundleId: started.applicationAudioBundleId }
                                        : {}),
                                },
                            ];
                            for (const identity of trackIdentities) {
                                const { source, sampleRateHz } = identity;
                                if (sampleRateHz === 0) continue;
                                const trackId = newUuid();
                                nativeTrackIds[source] = trackId;
                                tracks.push({ ...identity, trackId });
                            }
                            nativeTakeId = newUuid();
                            await commitArchiveRecords(
                                (_snapshot, session) =>
                                    makeSynchronizedCaptureStartRecords({
                                        session,
                                        takeId: nativeTakeId,
                                        tracks,
                                        knownTrackIds: props.trackIds,
                                        startedAtUs: started.startedAtUs,
                                        consentAtUs: started.consentAtUs,
                                        captureSourceBackend: started.backend,
                                        consentConfirmedBy: "tutorux-desktop-consent-checkbox",
                                    }),
                                "Started a recoverable synchronized desktop audio take.",
                            );
                        },
                        onChunk: (source, chunk) =>
                            commitArchiveRecords(async (snapshot, session) => {
                                const trackId = nativeTrackIds[source];
                                if (!trackId)
                                    throw new Error(
                                        `The ${source} track was not initialized in the archive.`,
                                    );
                                const track = await snapshot.getRecord(
                                    RecordType.assetMetadata,
                                    trackId,
                                );
                                if (!track)
                                    throw new Error(
                                        `The ${source} track metadata is missing from the archive.`,
                                    );
                                return makeSynchronizedCaptureChunkRecords({
                                    session,
                                    track,
                                    chunk,
                                    source,
                                });
                            }, ""),
                        onPaused: (pause) =>
                            commitArchiveRecords(async (snapshot, session) => {
                                const take = await loadNativeTake(snapshot, session);
                                return makeSynchronizedCaptureStateRecords(
                                    session,
                                    take.tracks,
                                    take.take,
                                    "paused",
                                    pause,
                                );
                            }, "Paused the synchronized desktop audio take."),
                        onResumed: (pause) =>
                            commitArchiveRecords(async (snapshot, session) => {
                                const take = await loadNativeTake(snapshot, session);
                                return makeSynchronizedCaptureStateRecords(
                                    session,
                                    take.tracks,
                                    take.take,
                                    "recording",
                                    pause,
                                );
                            }, "Resumed the synchronized desktop audio take."),
                        onFinished: (result) =>
                            commitArchiveRecords(async (snapshot, session) => {
                                const take = await loadNativeTake(snapshot, session);
                                return makeSynchronizedCaptureFinishRecords({
                                    session,
                                    tracks: take.tracks,
                                    take: take.take,
                                    pauseCount: result.pauseCount,
                                    pausedDurationUs: result.pausedDurationUs,
                                    failures: result.failures,
                                });
                            }, "Finalized the synchronized desktop audio take."),
                    },
                    onSourceFailure: reportSourceFailure,
                });
                details = {
                    sessionId,
                    archiveId,
                    startedAtUs: nativeRecorder.started.startedAtUs,
                    consentAtUs: nativeRecorder.started.consentAtUs,
                    captureSourceBackend: nativeRecorder.started.backend,
                    consentConfirmedBy: "tutorux-desktop-consent-checkbox",
                };
                recorder = {
                    pause: () => nativeRecorder.pause(),
                    resume: () => nativeRecorder.resume(),
                    stop: async () => ({ ...(await nativeRecorder.stop()), files: [null, null] }),
                    discard: () => nativeRecorder.discard(),
                };
            } else {
                const browserWarnings: string[] = [];
                const browserStartedAtUs = (BigInt(Date.now()) * 1000n).toString();
                const stopAtMemoryLimit = () => {
                    const warning =
                        "The browser capture reached its 64 MiB per-track memory limit.";
                    if (!browserWarnings.includes(warning)) browserWarnings.push(warning);
                    void untrack(() => stop(warning));
                };
                const browserRecorder = await SynchronizedRecording.start(
                    deviceId(),
                    stopAtMemoryLimit,
                    (track) =>
                        void untrack(() => {
                            const source =
                                track === "microphone"
                                    ? "Microphone"
                                    : track === "system-audio"
                                      ? "Shared system audio"
                                      : "Application audio";
                            const warning = `${source} capture ended; saving the audio captured before it stopped.`;
                            if (browserWarnings.includes(warning)) return;
                            browserWarnings.push(warning);
                            void stop(warning);
                        }),
                );
                details = {
                    sessionId,
                    archiveId,
                    startedAtUs: browserStartedAtUs,
                    consentAtUs,
                    captureSourceBackend: "web-audio",
                    consentConfirmedBy: "tutorux-browser-consent-checkbox",
                };
                recorder = {
                    pause: () => browserRecorder.pause(),
                    resume: () => browserRecorder.resume(),
                    stop: async () => {
                        const result = await browserRecorder.stop();
                        return { ...result, warnings: [...browserWarnings] };
                    },
                    discard: () => browserRecorder.discard(),
                };
            }

            if (
                disposed ||
                props.disabled ||
                props.session.id !== sessionId ||
                props.snapshot.header.id !== archiveId
            ) {
                if (platform.kind === "desktop") await recorder.stop().catch(() => undefined);
                else await recorder.discard();
                if (!disposed) setError("The session changed before capture started.");
                return;
            }
            capture = details;
            active = recorder;
            setState("recording");
            void refresh();
        } catch (cause) {
            if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            if (!disposed && state() === "requesting") setState("idle");
        }
    };

    const nativeDesktop = () => platform.kind === "desktop";

    return (
        <section class="transcript-capture-panel" aria-label="Synchronized audio recording">
            <div class="transcript-capture-copy">
                <strong>Record microphone with shared or application audio</strong>
                <Show
                    when={nativeDesktop()}
                    fallback={
                        <p>
                            Choose a screen or window and enable audio sharing when prompted. Video
                            is not saved; the microphone and selected shared audio are kept as
                            separate tracks.
                        </p>
                    }
                >
                    <p>
                        The desktop app records from your selected microphone and can add shared
                        system audio or one selected application audio stream. Video is never saved.
                    </p>
                </Show>

                <label>
                    Microphone{" "}
                    <select
                        value={deviceId()}
                        disabled={state() !== "idle" || preflightState() === "checking"}
                        onChange={(event) => {
                            setDeviceId(event.currentTarget.value);
                            resetMicrophonePreflight();
                        }}
                    >
                        <Show when={!nativeDesktop()}>
                            <option value="">System default</option>
                        </Show>
                        <For each={devices()}>
                            {(device) => <option value={device.id}>{device.label}</option>}
                        </For>
                    </select>
                </label>

                <Show when={nativeDesktop()}>
                    <label>
                        Second audio source{" "}
                        <select
                            value={systemAudioDeviceId()}
                            disabled={state() !== "idle"}
                            onChange={(event) => setSystemAudioDeviceId(event.currentTarget.value)}
                        >
                            <option value="">Microphone only</option>
                            <For each={systemAudioDevices()}>
                                {(device) => <option value={device.id}>{device.label}</option>}
                            </For>
                        </select>
                    </label>
                    <Show when={secondaryAudioUnavailableReason()}>
                        <p class="recording-capability-note" role="note">
                            {secondaryAudioUnavailableReason()} Microphone-only recording remains
                            available.
                        </p>
                    </Show>
                </Show>
                <Show when={microphoneUnavailableReason()}>
                    <p class="recording-capability-note" role="note">
                        {microphoneUnavailableReason()}
                    </p>
                </Show>

                <div class="transcript-capture-preflight">
                    <button
                        class="button button-outline"
                        type="button"
                        disabled={
                            state() !== "idle" ||
                            preflightState() === "checking" ||
                            (nativeDesktop() && !deviceId()) ||
                            Boolean(microphoneUnavailableReason())
                        }
                        onClick={() => void checkMicrophone()}
                    >
                        {preflightState() === "checking"
                            ? "Checking microphone…"
                            : "Check microphone"}
                    </button>
                    <div
                        class="transcript-capture-meter"
                        role="meter"
                        aria-label="Microphone input level"
                        aria-valuemin="0"
                        aria-valuemax="1"
                        aria-valuenow={inputPeak()}
                        aria-valuetext={`${inputRmsDbfs().toFixed(1)} dBFS RMS`}
                    >
                        <div
                            style={{ width: `${Math.min(100, Math.round(inputPeak() * 100))}%` }}
                        />
                    </div>
                    <p
                        class="transcript-capture-preflight-message"
                        role={preflightState() === "checking" ? "status" : "note"}
                    >
                        {preflightMessage()}
                    </p>
                </div>

                <button
                    class="button button-outline"
                    type="button"
                    disabled={state() !== "idle" || preflightState() === "checking"}
                    onClick={() => void refresh()}
                >
                    Refresh audio devices
                </button>
                <label class="transcript-capture-consent">
                    <input
                        type="checkbox"
                        checked={consent()}
                        disabled={state() !== "idle"}
                        onChange={(event) => setConsent(event.currentTarget.checked)}
                    />{" "}
                    Everyone being recorded has agreed.
                </label>
            </div>

            <div class="transcript-capture-actions">
                <Show when={state() === "idle" && !pending()}>
                    <button
                        class="button button-primary"
                        type="button"
                        disabled={
                            !consent() ||
                            props.disabled ||
                            preflightState() !== "ready" ||
                            preflightDeviceId() !== deviceId() ||
                            (nativeDesktop() && !deviceId()) ||
                            (!nativeDesktop() && Boolean(microphoneUnavailableReason()))
                        }
                        onClick={() => void start()}
                    >
                        Start synchronized recording
                    </button>
                </Show>
                <Show when={state() === "recording" || state() === "paused"}>
                    <button
                        class="button button-outline"
                        type="button"
                        onClick={() => void togglePause()}
                    >
                        {state() === "paused" ? "Resume recording" : "Pause recording"}
                    </button>
                    <button class="button button-outline" type="button" onClick={() => void stop()}>
                        Stop and save
                    </button>
                </Show>
                <Show when={state() === "paused"}>
                    <span role="status">Recording paused; selected audio sources are muted.</span>
                </Show>
                <Show when={state() === "pausing" || state() === "resuming"}>
                    <span role="status">Changing recording state…</span>
                </Show>
                <Show when={state() === "requesting"}>
                    <span role="status">Waiting for source permissions…</span>
                </Show>
                <Show when={state() === "saving"}>
                    <span role="status">Preparing recording…</span>
                </Show>
                <Show when={state() === "idle" && pending()}>
                    <button
                        class="button button-primary"
                        type="button"
                        onClick={() => {
                            const item = pending();
                            if (item) void save(item);
                        }}
                    >
                        Retry saving
                    </button>
                    <button
                        class="button button-outline"
                        type="button"
                        onClick={() => {
                            setPending(undefined);
                            setError("");
                        }}
                    >
                        Discard recording
                    </button>
                </Show>
            </div>

            <Show when={status()}>
                <p role="status">{status()}</p>
            </Show>
            <Show when={error()}>
                <p role="alert">{error()}</p>
            </Show>
        </section>
    );
}
