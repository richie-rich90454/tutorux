import {
    For,
    Show,
    createEffect,
    createResource,
    createSignal,
    on,
    onCleanup,
    type JSX,
} from "solid-js";
import {
    chooseMaterialFiles,
    chooseTextExport,
    cues as cuesApi,
    errorMessage,
    evidence as evidenceApi,
    guides as guidesApi,
    journal as journalApi,
    materials as materialsApi,
    observations as observationsApi,
    recordings as recordingsApi,
    sessions as sessionsApi,
    students as studentsApi,
    writeExportFile,
} from "../../api/client";
import type {
    Evidence,
    Guide,
    JournalEntry,
    Material,
    Observation,
    Recording,
    Session,
    SessionDetail,
    SessionInput,
    TranscriptCue,
} from "../../api/types";
import {
    Badge,
    Button,
    ConfirmButton,
    EmptyState,
    Field,
    InlineNotice,
    Panel,
    PanelHeader,
    Select,
    Tabs,
    TextArea,
    TextInput,
} from "../../design-system/ui";
import {
    formatBytes,
    formatDate,
    formatDateTime,
    formatTime,
    formatTimestampUs,
    parseTimestampUs,
    plural,
    todayIso,
} from "../../shared/format";
import { transcribeAudio, WHISPER_LANGUAGES } from "../../api/whisper";
import { Icon } from "../../shared-ui";
import { guidePath, navigate, sessionPath, useRoute } from "../../app/router";
import { SessionForm } from "./SessionsPage";

type CaptureState = "idle" | "recording" | "saving";

function sessionInput(session: Session, overrides: Partial<SessionInput> = {}): SessionInput {
    return {
        studentId: session.studentId,
        title: session.title,
        subject: session.subject,
        scheduledAt: session.scheduledAt,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        status: session.status,
        notes: session.notes,
        ...overrides,
    };
}

function parseTranscript(
    text: string,
    sessionId: string,
): Array<Pick<TranscriptCue, "sessionId" | "startUs" | "endUs" | "speaker" | "body" | "verified">> {
    const normalized = text.replace(/\r\n/gu, "\n").trim();
    const result: Array<
        Pick<TranscriptCue, "sessionId" | "startUs" | "endUs" | "speaker" | "body" | "verified">
    > = [];
    const blocks = normalized.split(/\n{2,}/u);
    for (const block of blocks) {
        const lines = block
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        const timeLine = lines.find((line) => line.includes("-->"));
        if (timeLine) {
            const [startRaw, endRaw] = timeLine
                .split("-->")
                .map((part) => part.trim().split(/\s+/u)[0] ?? "");
            const body = lines
                .slice(lines.indexOf(timeLine) + 1)
                .join(" ")
                .replace(/<[^>]+>/gu, "")
                .trim();
            if (!body) continue;
            result.push({
                sessionId,
                startUs: parseTimestampUs((startRaw ?? "").replace(",", ".")),
                endUs: parseTimestampUs((endRaw ?? "").replace(",", ".")),
                speaker: "",
                body,
                verified: false,
            });
            continue;
        }
        for (const line of lines) {
            const match =
                /^(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*)?(?:([^:]{1,40}):\s*)?(.+)$/u.exec(line);
            if (!match?.[3]) continue;
            const time = match[1];
            const speaker = match[2] ?? "";
            const body = match[3].trim();
            if (!body) continue;
            const start = time ? parseTimestampUs(time) : 0;
            result.push({
                sessionId,
                startUs: start,
                endUs: start + 5_000_000,
                speaker,
                body,
                verified: false,
            });
        }
    }
    return result;
}

function toSrt(cues: TranscriptCue[]): string {
    const stamp = (microseconds: number): string => {
        const total = Math.floor(microseconds / 1000);
        const hours = Math.floor(total / 3_600_000);
        const minutes = Math.floor((total % 3_600_000) / 60_000);
        const seconds = Math.floor((total % 60_000) / 1000);
        const millis = total % 1000;
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
    };
    return cues
        .map(
            (cue, index) =>
                `${index + 1}\n${stamp(cue.startUs)} --> ${stamp(cue.endUs)}\n${cue.speaker ? `${cue.speaker}: ` : ""}${cue.body}`,
        )
        .join("\n\n");
}

function toVtt(cues: TranscriptCue[]): string {
    const stamp = (microseconds: number): string => {
        const total = Math.floor(microseconds / 1000);
        const hours = Math.floor(total / 3_600_000);
        const minutes = Math.floor((total % 3_600_000) / 60_000);
        const seconds = Math.floor((total % 60_000) / 1000);
        const millis = total % 1000;
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
    };
    return `WEBVTT\n\n${cues
        .map(
            (cue) =>
                `${stamp(cue.startUs)} --> ${stamp(cue.endUs)}\n${cue.speaker ? `${cue.speaker}: ` : ""}${cue.body}`,
        )
        .join("\n\n")}`;
}

function buildGuide(detail: SessionDetail): string {
    const lines: string[] = [`# ${detail.session.title}`, ""];
    if (detail.session.subject) lines.push(`Subject: ${detail.session.subject}`, "");
    if (detail.session.notes) lines.push("## Session focus", detail.session.notes, "");
    if (detail.observations.length) {
        lines.push("## What stood out");
        for (const observation of detail.observations) {
            lines.push(`- ${observation.title || "Observation"}: ${observation.body}`);
        }
        lines.push("");
    }
    if (detail.cues.length) {
        lines.push("## Transcript highlights");
        for (const cue of detail.cues.slice(0, 60)) {
            lines.push(
                `- ${formatTimestampUs(cue.startUs)} ${cue.speaker ? `${cue.speaker}: ` : ""}${cue.body}`,
            );
        }
        lines.push("");
    }
    if (detail.materials.length) {
        lines.push("## Materials");
        for (const material of detail.materials)
            lines.push(`- ${material.title || material.filename}`);
        lines.push("");
    }
    return lines.join("\n").trim();
}

function CapturePanel(props: { detail: SessionDetail; onChanged: () => void }): JSX.Element {
    const [consent, setConsent] = createSignal(false);
    const [includeSystem, setIncludeSystem] = createSignal(false);
    const [state, setState] = createSignal<CaptureState>("idle");
    const [elapsed, setElapsed] = createSignal(0);
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");
    const [playback, setPlayback] = createSignal<{ id: string; url: string } | null>(null);
    let recorder: MediaRecorder | undefined;
    let streams: MediaStream[] = [];
    let audioContext: AudioContext | undefined;
    let chunks: Blob[] = [];
    let timer = 0;
    let startedAt = 0;

    onCleanup(() => {
        window.clearInterval(timer);
        streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
        void audioContext?.close();
        const active = playback();
        if (active) URL.revokeObjectURL(active.url);
    });

    function cleanup(): void {
        window.clearInterval(timer);
        timer = 0;
        streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
        streams = [];
        void audioContext?.close();
        audioContext = undefined;
    }

    async function start(): Promise<void> {
        if (!consent()) {
            setError("Confirm that everyone being recorded has agreed.");
            return;
        }
        setError("");
        setMessage("");
        setState("recording");
        setElapsed(0);
        try {
            const microphone = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            streams.push(microphone);
            audioContext = new AudioContext();
            const destination = audioContext.createMediaStreamDestination();
            audioContext.createMediaStreamSource(microphone).connect(destination);
            if (includeSystem()) {
                try {
                    const display = await navigator.mediaDevices.getDisplayMedia({
                        video: true,
                        audio: true,
                    });
                    streams.push(display);
                    const systemAudio = display.getAudioTracks();
                    if (systemAudio.length > 0) {
                        const systemStream = new MediaStream(systemAudio);
                        audioContext.createMediaStreamSource(systemStream).connect(destination);
                    } else {
                        setMessage(
                            "The screen source did not provide system audio. The microphone is still recording.",
                        );
                    }
                    display.getVideoTracks().forEach((track) => track.stop());
                } catch (cause) {
                    setMessage(
                        `System audio was not available. The microphone is still recording. ${errorMessage(cause)}`,
                    );
                }
            }
            const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/webm";
            recorder = new MediaRecorder(destination.stream, { mimeType });
            chunks = [];
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunks.push(event.data);
            };
            recorder.onerror = () => {
                setError("The recorder stopped unexpectedly.");
                cleanup();
                setState("idle");
            };
            recorder.onstop = () => {
                void (async () => {
                    setState("saving");
                    try {
                        const blob = new Blob(chunks, { type: mimeType });
                        if (blob.size === 0)
                            throw new Error("The recording did not contain any audio.");
                        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
                        await recordingsApi.import({
                            sessionId: props.detail.session.id,
                            title: `${props.detail.session.title} · ${new Date().toLocaleString()}`,
                            source: includeSystem() ? "microphone+system" : "microphone",
                            sampleRate: 0,
                            channels: 0,
                            durationUs: elapsed() * 1_000_000,
                            bytes,
                        });
                        setMessage("Recording saved to this session.");
                        setElapsed(0);
                        props.onChanged();
                    } catch (cause) {
                        setError(errorMessage(cause));
                    } finally {
                        cleanup();
                        setState("idle");
                    }
                })();
            };
            startedAt = Date.now();
            recorder.start(1000);
            timer = window.setInterval(
                () => setElapsed(Math.round((Date.now() - startedAt) / 1000)),
                500,
            );
        } catch (cause) {
            cleanup();
            setError(errorMessage(cause));
            setState("idle");
        }
    }

    function stop(): void {
        if (recorder && recorder.state !== "inactive") recorder.stop();
        window.clearInterval(timer);
    }

    async function play(recording: Recording): Promise<void> {
        setError("");
        try {
            const bytes = await recordingsApi.read(recording.id);
            const previous = playback();
            if (previous) URL.revokeObjectURL(previous.url);
            const url = URL.createObjectURL(
                new Blob([Uint8Array.from(bytes)], { type: "audio/webm" }),
            );
            setPlayback({ id: recording.id, url });
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)]">
            <Panel>
                <PanelHeader
                    title="Record this session"
                    detail="Microphone plus optional system audio, mixed into one track."
                />
                <div class="grid gap-3 p-4">
                    <div class="rounded-[5px] border border-line bg-surface-subtle px-3 py-2 text-xs leading-relaxed text-muted">
                        Tutorux records locally. Nothing is uploaded. Stop the recording after the
                        lesson; the audio stays attached to this session.
                    </div>
                    <label class="flex items-start gap-2 text-xs leading-relaxed text-ink-soft">
                        <input
                            type="checkbox"
                            class="mt-0.5"
                            checked={consent()}
                            onChange={(event) => setConsent(event.currentTarget.checked)}
                        />
                        <span>Everyone being recorded has agreed.</span>
                    </label>
                    <label class="flex items-start gap-2 text-xs leading-relaxed text-ink-soft">
                        <input
                            type="checkbox"
                            class="mt-0.5"
                            checked={includeSystem()}
                            onChange={(event) => setIncludeSystem(event.currentTarget.checked)}
                        />
                        <span>
                            Include system audio. You will choose the screen or window to share; no
                            video is saved.
                        </span>
                    </label>
                    <Show when={error()}>
                        <InlineNotice tone="danger">{error()}</InlineNotice>
                    </Show>
                    <Show when={message()}>
                        <InlineNotice tone="success">{message()}</InlineNotice>
                    </Show>
                    <div class="flex flex-wrap items-center gap-3">
                        <Button
                            variant={state() === "recording" ? "danger" : "primary"}
                            disabled={state() === "saving" || !consent()}
                            onClick={() => (state() === "recording" ? stop() : void start())}
                        >
                            <Icon name="microphone" />
                            {state() === "saving"
                                ? "Saving…"
                                : state() === "recording"
                                  ? "Stop recording"
                                  : "Start recording"}
                        </Button>
                        <Show when={state() === "recording"}>
                            <span class="flex items-center gap-2 text-xs font-medium text-danger">
                                <span class="h-2 w-2 rounded-full bg-danger" />
                                {formatTimestampUs(elapsed() * 1_000_000)}
                            </span>
                        </Show>
                    </div>
                </div>
            </Panel>
            <Panel>
                <PanelHeader
                    title="Recordings"
                    detail={plural(props.detail.recordings.length, "recording")}
                />
                <Show
                    when={props.detail.recordings.length}
                    fallback={
                        <EmptyState
                            icon="microphone"
                            title="No recordings yet"
                            text="Record the lesson or import audio from another device."
                        />
                    }
                >
                    <div class="divide-y divide-line-soft">
                        <For each={props.detail.recordings}>
                            {(recording) => (
                                <div class="grid gap-2 px-4 py-3">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <strong class="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                                            {recording.title}
                                        </strong>
                                        <Badge tone="accent">{recording.source}</Badge>
                                        <span class="text-[11px] text-faint">
                                            {formatBytes(recording.byteSize)}
                                        </span>
                                    </div>
                                    <div class="flex items-center gap-2 text-[11px] text-muted">
                                        <span>{formatDateTime(recording.startedAt)}</span>
                                        <span>{formatTimestampUs(recording.durationUs)}</span>
                                    </div>
                                    <div class="flex flex-wrap gap-1.5">
                                        <Button size="sm" onClick={() => void play(recording)}>
                                            <Icon name="play" />
                                            Play
                                        </Button>
                                        <ConfirmButton
                                            label="Delete"
                                            confirmLabel="Delete recording"
                                            onConfirm={() =>
                                                void recordingsApi
                                                    .remove(recording.id)
                                                    .then(props.onChanged)
                                            }
                                        />
                                    </div>
                                    <Show when={playback()?.id === recording.id}>
                                        <audio
                                            class="w-full"
                                            controls
                                            autoplay
                                            src={playback()?.url}
                                        />
                                    </Show>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </Panel>
        </div>
    );
}

function TranscriptPanel(props: { detail: SessionDetail; onChanged: () => void }): JSX.Element {
    const [start, setStart] = createSignal("0:00");
    const [end, setEnd] = createSignal("0:05");
    const [speaker, setSpeaker] = createSignal("");
    const [body, setBody] = createSignal("");
    const [editing, setEditing] = createSignal<TranscriptCue | null>(null);
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");
    const [language, setLanguage] = createSignal("auto");
    const [transcribing, setTranscribing] = createSignal(false);
    let fileInput: HTMLInputElement | undefined;

    async function saveCue(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            const current = editing();
            const input = {
                sessionId: props.detail.session.id,
                startUs: parseTimestampUs(start()),
                endUs: parseTimestampUs(end()),
                speaker: speaker(),
                body: body(),
                verified: true,
            };
            if (current) await cuesApi.update(current.id, input);
            else await cuesApi.create(input);
            setEditing(null);
            setStart(formatTimestampUs(parseTimestampUs(end())));
            setEnd(formatTimestampUs(parseTimestampUs(end()) + 5_000_000));
            setBody("");
            setSpeaker("");
            props.onChanged();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function importFile(file: File): Promise<void> {
        setError("");
        try {
            const parsed = parseTranscript(await file.text(), props.detail.session.id);
            if (!parsed.length) throw new Error("No transcript cues were found in that file.");
            for (const cue of parsed) await cuesApi.create(cue);
            setMessage(`${parsed.length} cues imported.`);
            props.onChanged();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function exportCues(format: "srt" | "vtt"): Promise<void> {
        setError("");
        try {
            const path = await chooseTextExport(
                `${props.detail.session.title}.${format}`,
                format,
                format === "srt" ? "SubRip transcript" : "WebVTT transcript",
            );
            if (!path) return;
            await writeExportFile(
                path,
                format === "srt" ? toSrt(props.detail.cues) : toVtt(props.detail.cues),
            );
            setMessage("Transcript exported.");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function transcribeLatest(): Promise<void> {
        const recording = props.detail.recordings[0];
        if (!recording) {
            setError("Record a session first. Transcription uses the latest recording.");
            return;
        }
        setTranscribing(true);
        setError("");
        setMessage("Loading the local Whisper model and transcribing the recording…");
        try {
            const bytes = Uint8Array.from(await recordingsApi.read(recording.id));
            const cues = await transcribeAudio(bytes, language());
            if (!cues.length) throw new Error("The local model did not return any speech.");
            for (const cue of cues) {
                await cuesApi.create({
                    sessionId: props.detail.session.id,
                    startUs: cue.startUs,
                    endUs: cue.endUs,
                    speaker: "",
                    body: cue.text,
                    verified: false,
                });
            }
            setMessage(
                `${cues.length} cues created locally. Review and correct them before sharing.`,
            );
            props.onChanged();
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setTranscribing(false);
        }
    }

    return (
        <div class="grid gap-4 lg:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]">
            <Panel>
                <PanelHeader
                    title={editing() ? "Edit cue" : "Add cue"}
                    detail="Timestamps use m:ss or h:mm:ss."
                />
                <form class="grid gap-3 p-4" onSubmit={(event) => void saveCue(event)}>
                    <div class="grid grid-cols-2 gap-2">
                        <Field label="Start">
                            <TextInput value={start()} onInput={setStart} ariaLabel="Cue start" />
                        </Field>
                        <Field label="End">
                            <TextInput value={end()} onInput={setEnd} ariaLabel="Cue end" />
                        </Field>
                    </div>
                    <Field label="Speaker">
                        <TextInput
                            value={speaker()}
                            onInput={setSpeaker}
                            placeholder="Tutor"
                            ariaLabel="Cue speaker"
                        />
                    </Field>
                    <Field label="Text">
                        <TextArea value={body()} onInput={setBody} rows={3} ariaLabel="Cue text" />
                    </Field>
                    <Show when={error()}>
                        <InlineNotice tone="danger">{error()}</InlineNotice>
                    </Show>
                    <Show when={message()}>
                        <InlineNotice tone="success">{message()}</InlineNotice>
                    </Show>
                    <div class="flex flex-wrap justify-end gap-2">
                        <Show when={editing()}>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    setEditing(null);
                                    setSpeaker("");
                                    setBody("");
                                }}
                            >
                                Cancel edit
                            </Button>
                        </Show>
                        <Button variant="primary" size="sm" type="submit">
                            {editing() ? "Save cue" : "Add cue"}
                        </Button>
                    </div>
                </form>
                <div class="grid gap-2 border-t border-line-soft p-4">
                    <div class="flex flex-wrap items-end gap-2">
                        <label class="grid min-w-[180px] flex-1 gap-1 text-xs font-semibold text-ink-soft">
                            <span>Transcription language</span>
                            <Select
                                value={language()}
                                onChange={setLanguage}
                                ariaLabel="Whisper language"
                                options={WHISPER_LANGUAGES.map((item) => ({
                                    value: item.code,
                                    label: item.label,
                                }))}
                            />
                        </label>
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={transcribing() || !props.detail.recordings.length}
                            onClick={() => void transcribeLatest()}
                        >
                            {transcribing() ? "Transcribing…" : "Transcribe latest recording"}
                        </Button>
                    </div>
                    <p class="m-0 text-[11px] leading-relaxed text-muted">
                        Local Whisper runs in the desktop app. The model never downloads or leaves
                        the device.
                    </p>
                    <div class="flex flex-wrap gap-2">
                        <input
                            ref={(element) => (fileInput = element)}
                            type="file"
                            accept=".srt,.vtt,.txt"
                            class="hidden"
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                if (file) void importFile(file);
                                event.currentTarget.value = "";
                            }}
                        />
                        <Button size="sm" onClick={() => fileInput?.click()}>
                            Import SRT, VTT, or text
                        </Button>
                        <Button size="sm" onClick={() => void exportCues("srt")}>
                            Export SRT
                        </Button>
                        <Button size="sm" onClick={() => void exportCues("vtt")}>
                            Export VTT
                        </Button>
                    </div>
                </div>
            </Panel>
            <Panel>
                <PanelHeader title="Transcript" detail={plural(props.detail.cues.length, "cue")} />
                <Show
                    when={props.detail.cues.length}
                    fallback={
                        <EmptyState
                            icon="transcripts"
                            title="No transcript yet"
                            text="Paste or import a transcript, or add cues manually alongside the recording."
                        />
                    }
                >
                    <div class="max-h-[62vh] divide-y divide-line-soft overflow-auto">
                        <For each={props.detail.cues}>
                            {(cue) => (
                                <div class="px-4 py-3">
                                    <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                                        <span class="font-mono">
                                            {formatTimestampUs(cue.startUs)} –{" "}
                                            {formatTimestampUs(cue.endUs)}
                                        </span>
                                        <Show when={cue.speaker}>
                                            <Badge>{cue.speaker}</Badge>
                                        </Show>
                                        <Show when={cue.verified}>
                                            <Badge tone="success">reviewed</Badge>
                                        </Show>
                                        <span class="ml-auto flex gap-1">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => {
                                                    setEditing(cue);
                                                    setStart(formatTimestampUs(cue.startUs));
                                                    setEnd(formatTimestampUs(cue.endUs));
                                                    setSpeaker(cue.speaker);
                                                    setBody(cue.body);
                                                }}
                                            >
                                                Edit
                                            </Button>
                                            <ConfirmButton
                                                label="Delete"
                                                confirmLabel="Delete cue"
                                                onConfirm={() =>
                                                    void cuesApi
                                                        .remove(cue.id)
                                                        .then(props.onChanged)
                                                }
                                            />
                                        </span>
                                    </div>
                                    <p class="mt-1 text-xs leading-relaxed text-ink-soft">
                                        {cue.body}
                                    </p>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </Panel>
        </div>
    );
}

function NotesPanel(props: { detail: SessionDetail; onChanged: () => void }): JSX.Element {
    const [journalTitle, setJournalTitle] = createSignal("");
    const [journalBody, setJournalBody] = createSignal("");
    const [observationTitle, setObservationTitle] = createSignal("");
    const [observationBody, setObservationBody] = createSignal("");
    const [kind, setKind] = createSignal("general-note");
    const [priority, setPriority] = createSignal("normal");
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");

    async function addJournal(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            await journalApi.create({
                sessionId: props.detail.session.id,
                studentId: props.detail.session.studentId,
                entryDate: todayIso(),
                title: journalTitle(),
                body: journalBody(),
            });
            setJournalTitle("");
            setJournalBody("");
            setMessage("Journal entry saved.");
            props.onChanged();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function addObservation(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            await observationsApi.create({
                sessionId: props.detail.session.id,
                studentId: props.detail.session.studentId,
                kind: kind(),
                priority: priority(),
                startUs: 0,
                endUs: 0,
                title: observationTitle(),
                body: observationBody(),
            });
            setObservationTitle("");
            setObservationBody("");
            setMessage("Observation saved.");
            props.onChanged();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="grid gap-4 lg:grid-cols-2">
            <Panel>
                <PanelHeader title="Session journal" detail="A reflection tied to this lesson." />
                <form class="grid gap-3 p-4" onSubmit={(event) => void addJournal(event)}>
                    <Field label="Title">
                        <TextInput
                            value={journalTitle()}
                            onInput={setJournalTitle}
                            placeholder="What I noticed"
                            ariaLabel="Journal title"
                        />
                    </Field>
                    <Field label="Reflection">
                        <TextArea
                            value={journalBody()}
                            onInput={setJournalBody}
                            rows={4}
                            ariaLabel="Journal reflection"
                        />
                    </Field>
                    <div class="flex justify-end">
                        <Button size="sm" variant="primary" type="submit">
                            Save journal entry
                        </Button>
                    </div>
                </form>
                <Show when={props.detail.journal.length}>
                    <div class="divide-y divide-line-soft border-t border-line-soft">
                        <For each={props.detail.journal}>
                            {(entry: JournalEntry) => (
                                <div class="px-4 py-3">
                                    <div class="flex items-center gap-2">
                                        <strong class="text-xs font-medium text-ink">
                                            {entry.title || entry.entryDate}
                                        </strong>
                                        <span class="ml-auto text-[11px] text-faint">
                                            {formatDate(entry.createdAt)}
                                        </span>
                                    </div>
                                    <p class="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
                                        {entry.body}
                                    </p>
                                    <div class="mt-1 flex justify-end">
                                        <ConfirmButton
                                            label="Delete"
                                            confirmLabel="Delete entry"
                                            onConfirm={() =>
                                                void journalApi
                                                    .remove(entry.id)
                                                    .then(props.onChanged)
                                            }
                                        />
                                    </div>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </Panel>
            <Panel>
                <PanelHeader title="Observations" detail="Specific moments worth returning to." />
                <form class="grid gap-3 p-4" onSubmit={(event) => void addObservation(event)}>
                    <div class="grid gap-3 sm:grid-cols-2">
                        <Field label="Type">
                            <Select
                                value={kind()}
                                onChange={setKind}
                                ariaLabel="Observation type"
                                options={[
                                    { value: "general-note", label: "General note" },
                                    { value: "important-concept", label: "Important concept" },
                                    { value: "student-mistake", label: "Student mistake" },
                                    { value: "tutor-correction", label: "Tutor correction" },
                                    {
                                        value: "explicit-instruction",
                                        label: "Explicit instruction",
                                    },
                                    { value: "follow-up-priority", label: "Follow-up priority" },
                                ]}
                            />
                        </Field>
                        <Field label="Priority">
                            <Select
                                value={priority()}
                                onChange={setPriority}
                                ariaLabel="Observation priority"
                                options={[
                                    { value: "low", label: "Low" },
                                    { value: "normal", label: "Normal" },
                                    { value: "high", label: "High" },
                                ]}
                            />
                        </Field>
                    </div>
                    <Field label="Title">
                        <TextInput
                            value={observationTitle()}
                            onInput={setObservationTitle}
                            placeholder="Sign change confusion"
                            ariaLabel="Observation title"
                        />
                    </Field>
                    <Field label="Observation">
                        <TextArea
                            value={observationBody()}
                            onInput={setObservationBody}
                            rows={3}
                            ariaLabel="Observation body"
                        />
                    </Field>
                    <div class="flex justify-end">
                        <Button size="sm" variant="primary" type="submit">
                            Add observation
                        </Button>
                    </div>
                </form>
                <Show when={error()}>
                    <div class="px-4 pb-3">
                        <InlineNotice tone="danger">{error()}</InlineNotice>
                    </div>
                </Show>
                <Show when={message()}>
                    <div class="px-4 pb-3">
                        <InlineNotice tone="success">{message()}</InlineNotice>
                    </div>
                </Show>
                <Show when={props.detail.observations.length}>
                    <div class="divide-y divide-line-soft border-t border-line-soft">
                        <For each={props.detail.observations}>
                            {(observation: Observation) => (
                                <div class="px-4 py-3">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <Badge
                                            tone={
                                                observation.priority === "high"
                                                    ? "warning"
                                                    : "neutral"
                                            }
                                        >
                                            {observation.kind}
                                        </Badge>
                                        <strong class="text-xs font-medium text-ink">
                                            {observation.title || "Observation"}
                                        </strong>
                                        <span class="ml-auto text-[11px] text-faint">
                                            {formatDate(observation.createdAt)}
                                        </span>
                                    </div>
                                    <p class="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
                                        {observation.body}
                                    </p>
                                    <div class="mt-1 flex justify-end">
                                        <ConfirmButton
                                            label="Delete"
                                            confirmLabel="Delete observation"
                                            onConfirm={() =>
                                                void observationsApi
                                                    .remove(observation.id)
                                                    .then(props.onChanged)
                                            }
                                        />
                                    </div>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </Panel>
        </div>
    );
}

function MaterialsPanel(props: { detail: SessionDetail; onChanged: () => void }): JSX.Element {
    const [links, setLinks] = createSignal({ title: "", url: "", notes: "" });
    const [error, setError] = createSignal("");
    const [preview, setPreview] = createSignal<{
        url: string;
        text: string;
        mimeType: string;
    } | null>(null);
    const [previewId, setPreviewId] = createSignal("");

    onCleanup(() => {
        const value = preview();
        if (value?.url) URL.revokeObjectURL(value.url);
    });

    async function importFiles(): Promise<void> {
        setError("");
        try {
            const files = await chooseMaterialFiles();
            for (const path of files) {
                await materialsApi.importFile(
                    path,
                    props.detail.session.id,
                    props.detail.session.studentId,
                );
            }
            if (files.length) props.onChanged();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function addLink(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            const value = links();
            await materialsApi.link({
                sessionId: props.detail.session.id,
                studentId: props.detail.session.studentId,
                title: value.title,
                url: value.url,
                notes: value.notes,
            });
            setLinks({ title: "", url: "", notes: "" });
            props.onChanged();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function openPreview(material: Material): Promise<void> {
        setError("");
        setPreviewId(material.id);
        try {
            if (material.kind === "link") {
                window.open(material.sourceUrl, "_blank", "noopener,noreferrer");
                return;
            }
            const bytes = await materialsApi.read(material.id);
            const active = preview();
            if (active?.url) URL.revokeObjectURL(active.url);
            const isText =
                material.mimeType.startsWith("text/") || material.mimeType === "application/json";
            const text = isText ? new TextDecoder().decode(bytes) : "";
            const url = URL.createObjectURL(new Blob([bytes], { type: material.mimeType }));
            setPreview({ url, text, mimeType: material.mimeType });
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPreviewId("");
        }
    }

    return (
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
            <Panel>
                <PanelHeader
                    title="Materials"
                    detail={plural(props.detail.materials.length, "item")}
                    actions={
                        <Button size="sm" onClick={() => void importFiles()}>
                            Add files
                        </Button>
                    }
                />
                <Show when={error()}>
                    <div class="p-4">
                        <InlineNotice tone="danger">{error()}</InlineNotice>
                    </div>
                </Show>
                <Show
                    when={props.detail.materials.length}
                    fallback={
                        <EmptyState
                            icon="assets"
                            title="No materials attached"
                            text="Add a worksheet, image, document, audio file, video, or link."
                            action={
                                <Button size="sm" onClick={() => void importFiles()}>
                                    Add files
                                </Button>
                            }
                        />
                    }
                >
                    <div class="divide-y divide-line-soft">
                        <For each={props.detail.materials}>
                            {(material) => (
                                <div class="flex flex-wrap items-center gap-2 px-4 py-3">
                                    <Icon
                                        name={material.kind === "link" ? "folder" : "assets"}
                                        class="text-muted"
                                    />
                                    <button
                                        type="button"
                                        class="min-w-0 flex-1 text-left"
                                        onClick={() => void openPreview(material)}
                                        disabled={previewId() === material.id}
                                    >
                                        <strong class="block truncate text-xs font-medium text-ink">
                                            {material.title || material.filename}
                                        </strong>
                                        <span class="text-[11px] text-muted">
                                            {material.kind}
                                            {material.kind === "file"
                                                ? ` · ${formatBytes(material.byteSize)}`
                                                : ""}
                                            {material.notes ? ` · ${material.notes}` : ""}
                                        </span>
                                    </button>
                                    <Button
                                        size="sm"
                                        onClick={() => void openPreview(material)}
                                        disabled={previewId() === material.id}
                                    >
                                        {previewId() === material.id ? "Loading…" : "Open"}
                                    </Button>
                                    <ConfirmButton
                                        label="Delete"
                                        confirmLabel="Delete material"
                                        onConfirm={() =>
                                            void materialsApi
                                                .remove(material.id)
                                                .then(props.onChanged)
                                        }
                                    />
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
                <form
                    class="grid gap-2 border-t border-line-soft p-4"
                    onSubmit={(event) => void addLink(event)}
                >
                    <div class="grid gap-2 sm:grid-cols-2">
                        <TextInput
                            value={links().title}
                            onInput={(value) => setLinks({ ...links(), title: value })}
                            placeholder="Link title"
                            ariaLabel="Link title"
                        />
                        <TextInput
                            value={links().url}
                            onInput={(value) => setLinks({ ...links(), url: value })}
                            placeholder="https://…"
                            ariaLabel="Link URL"
                        />
                    </div>
                    <TextInput
                        value={links().notes}
                        onInput={(value) => setLinks({ ...links(), notes: value })}
                        placeholder="Notes (optional)"
                        ariaLabel="Link notes"
                    />
                    <div class="flex justify-end">
                        <Button size="sm" type="submit">
                            Save link
                        </Button>
                    </div>
                </form>
            </Panel>
            <Panel>
                <PanelHeader
                    title="Preview"
                    detail="Files open in place; links open in the browser."
                />
                <Show
                    when={preview()}
                    fallback={
                        <EmptyState
                            icon="assets"
                            title="Nothing selected"
                            text="Choose a material to preview it here."
                        />
                    }
                >
                    {(value) => (
                        <div class="p-3">
                            <Show when={value().mimeType.startsWith("image/")}>
                                <img
                                    class="max-h-[55vh] w-full object-contain"
                                    src={value().url}
                                    alt="Material preview"
                                />
                            </Show>
                            <Show when={value().mimeType.startsWith("audio/")}>
                                <audio class="w-full" controls src={value().url} />
                            </Show>
                            <Show when={value().mimeType.startsWith("video/")}>
                                <video class="max-h-[55vh] w-full" controls src={value().url} />
                            </Show>
                            <Show when={value().mimeType === "application/pdf"}>
                                <iframe
                                    class="h-[55vh] w-full border-0"
                                    src={value().url}
                                    title="PDF preview"
                                />
                            </Show>
                            <Show when={value().text}>
                                <pre class="max-h-[55vh] whitespace-pre-wrap overflow-auto text-xs leading-relaxed text-ink-soft">
                                    {value().text}
                                </pre>
                            </Show>
                            <Show
                                when={
                                    !value().text &&
                                    !value().mimeType.match(
                                        /^(image|audio|video)\/|application\/pdf/u,
                                    )
                                }
                            >
                                <p class="text-xs text-muted">
                                    This file type has no in-app preview. It is stored safely in the
                                    workspace.
                                </p>
                            </Show>
                        </div>
                    )}
                </Show>
            </Panel>
        </div>
    );
}

function EvidencePanel(props: { detail: SessionDetail; onChanged: () => void }): JSX.Element {
    const [statement, setStatement] = createSignal("");
    const [kind, setKind] = createSignal("observation");
    const [status, setStatus] = createSignal("draft");
    const [error, setError] = createSignal("");

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            await evidenceApi.create({
                studentId: props.detail.session.studentId,
                sessionId: props.detail.session.id,
                sourceType: "session",
                sourceId: props.detail.session.id,
                kind: kind(),
                statement: statement(),
                status: status(),
            });
            setStatement("");
            props.onChanged();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <Panel>
                <PanelHeader
                    title="Add evidence"
                    detail="A concrete statement backed by this session."
                />
                <form class="grid gap-3 p-4" onSubmit={(event) => void submit(event)}>
                    <Field label="Statement">
                        <TextArea
                            value={statement()}
                            onInput={setStatement}
                            rows={4}
                            ariaLabel="Evidence statement"
                        />
                    </Field>
                    <div class="grid gap-3 sm:grid-cols-2">
                        <Field label="Kind">
                            <Select
                                value={kind()}
                                onChange={setKind}
                                ariaLabel="Evidence kind"
                                options={[
                                    { value: "observation", label: "Observation" },
                                    { value: "skill", label: "Skill" },
                                    { value: "goal", label: "Goal" },
                                    { value: "transcript", label: "Transcript" },
                                    { value: "material", label: "Material" },
                                ]}
                            />
                        </Field>
                        <Field label="Status">
                            <Select
                                value={status()}
                                onChange={setStatus}
                                ariaLabel="Evidence status"
                                options={[
                                    { value: "draft", label: "Draft" },
                                    { value: "approved", label: "Approved" },
                                    { value: "rejected", label: "Rejected" },
                                ]}
                            />
                        </Field>
                    </div>
                    <Show when={error()}>
                        <InlineNotice tone="danger">{error()}</InlineNotice>
                    </Show>
                    <div class="flex justify-end">
                        <Button size="sm" variant="primary" type="submit">
                            Add evidence
                        </Button>
                    </div>
                </form>
            </Panel>
            <Panel>
                <PanelHeader
                    title="Evidence"
                    detail={plural(props.detail.evidence.length, "item")}
                />
                <Show
                    when={props.detail.evidence.length}
                    fallback={
                        <EmptyState
                            icon="evidence"
                            title="No evidence yet"
                            text="Add a statement that shows what changed in this session."
                        />
                    }
                >
                    <div class="divide-y divide-line-soft">
                        <For each={props.detail.evidence}>
                            {(item: Evidence) => (
                                <div class="px-4 py-3">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <Badge
                                            tone={
                                                item.status === "approved" ? "success" : "neutral"
                                            }
                                        >
                                            {item.status}
                                        </Badge>
                                        <span class="text-[11px] text-muted">{item.kind}</span>
                                        <span class="ml-auto text-[11px] text-faint">
                                            {formatDate(item.createdAt)}
                                        </span>
                                    </div>
                                    <p class="mt-1 text-xs leading-relaxed text-ink-soft">
                                        {item.statement}
                                    </p>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </Panel>
        </div>
    );
}

function GuidePanel(props: { detail: SessionDetail; onChanged: () => void }): JSX.Element {
    const [error, setError] = createSignal("");
    const [creating, setCreating] = createSignal(false);

    async function createGuide(): Promise<void> {
        setCreating(true);
        setError("");
        try {
            const body = buildGuide(props.detail);
            const guide = await guidesApi.create({
                studentId: props.detail.session.studentId,
                sessionId: props.detail.session.id,
                title: `${props.detail.session.title} study guide`,
                status: "draft",
                body,
                sourceIds: [
                    ...props.detail.cues.map((cue) => cue.id),
                    ...props.detail.observations.map((observation) => observation.id),
                ],
            });
            navigate(guidePath(guide.id));
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setCreating(false);
        }
    }

    return (
        <div class="grid gap-4">
            <Show when={error()}>
                <InlineNotice tone="danger">{error()}</InlineNotice>
            </Show>
            <Panel>
                <PanelHeader
                    title="Study guide"
                    detail="Build a guide from this session's notes, observations, transcript, and materials."
                    actions={
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={creating()}
                            onClick={() => void createGuide()}
                        >
                            {creating() ? "Creating…" : "Generate from session"}
                        </Button>
                    }
                />
                <Show
                    when={props.detail.guides.length}
                    fallback={
                        <EmptyState
                            icon="guides"
                            title="No guide yet"
                            text="Generate a draft from this session, then edit and export it."
                            action={
                                <Button size="sm" onClick={() => void createGuide()}>
                                    Generate guide
                                </Button>
                            }
                        />
                    }
                >
                    <div class="divide-y divide-line-soft">
                        <For each={props.detail.guides}>
                            {(guide: Guide) => (
                                <button
                                    type="button"
                                    class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-inset"
                                    onClick={() => navigate(guidePath(guide.id))}
                                >
                                    <Icon name="guides" class="text-muted" />
                                    <span class="min-w-0 flex-1">
                                        <strong class="block truncate text-xs font-medium text-ink">
                                            {guide.title}
                                        </strong>
                                        <span class="text-[11px] text-muted">
                                            {guide.status} · updated {formatDate(guide.updatedAt)}
                                        </span>
                                    </span>
                                    <Icon name="chevron" class="text-faint" />
                                </button>
                            )}
                        </For>
                    </div>
                </Show>
            </Panel>
        </div>
    );
}

function OverviewPanel(props: {
    detail: SessionDetail;
    students: Array<{ id: string; name: string }>;
    onChanged: () => void;
}): JSX.Element {
    const [editing, setEditing] = createSignal(false);

    async function save(input: SessionInput): Promise<void> {
        await sessionsApi.update(props.detail.session.id, input);
        setEditing(false);
        props.onChanged();
    }

    return (
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
            <Panel>
                <PanelHeader
                    title="Session overview"
                    actions={
                        <Button size="sm" onClick={() => setEditing((value) => !value)}>
                            Edit session
                        </Button>
                    }
                />
                <Show when={editing()}>
                    <SessionForm
                        initial={props.detail.session}
                        students={props.students}
                        submitLabel="Save changes"
                        onCancel={() => setEditing(false)}
                        onSubmit={save}
                    />
                </Show>
                <div class="grid gap-3 p-4 text-xs text-muted">
                    <p class="m-0 whitespace-pre-wrap leading-relaxed text-ink-soft">
                        {props.detail.session.notes || "No session notes yet."}
                    </p>
                    <div class="grid grid-cols-2 gap-3 border-t border-line-soft pt-3 sm:grid-cols-4">
                        <span>
                            <strong class="block text-ink">{props.detail.cues.length}</strong>cues
                        </span>
                        <span>
                            <strong class="block text-ink">
                                {props.detail.observations.length}
                            </strong>
                            observations
                        </span>
                        <span>
                            <strong class="block text-ink">{props.detail.materials.length}</strong>
                            materials
                        </span>
                        <span>
                            <strong class="block text-ink">{props.detail.recordings.length}</strong>
                            recordings
                        </span>
                    </div>
                </div>
            </Panel>
            <Panel>
                <PanelHeader title="Session facts" />
                <div class="grid gap-2 p-4 text-xs text-muted">
                    <div class="flex justify-between gap-3">
                        <span>Student</span>
                        <strong class="text-ink">
                            {props.detail.session.studentName || "Independent"}
                        </strong>
                    </div>
                    <div class="flex justify-between gap-3">
                        <span>Subject</span>
                        <strong class="text-ink">{props.detail.session.subject || "None"}</strong>
                    </div>
                    <div class="flex justify-between gap-3">
                        <span>Status</span>
                        <strong class="text-ink">{props.detail.session.status}</strong>
                    </div>
                    <div class="flex justify-between gap-3">
                        <span>Scheduled</span>
                        <strong class="text-ink">
                            {formatDateTime(props.detail.session.scheduledAt)}
                        </strong>
                    </div>
                    <div class="flex justify-between gap-3">
                        <span>Started</span>
                        <strong class="text-ink">
                            {formatDateTime(props.detail.session.startedAt)}
                        </strong>
                    </div>
                </div>
            </Panel>
        </div>
    );
}

export function SessionDetailPage(): JSX.Element {
    const route = useRoute();
    const [message, setMessage] = createSignal("");
    const [error, setError] = createSignal("");
    const [detail, { refetch }] = createResource(() => route().id, sessionsApi.detail);
    const [students] = createResource(() => studentsApi.list(""));
    const tab = (): string => route().tab || "overview";

    createEffect(
        on(
            () => route().tab,
            () => {
                setMessage("");
                setError("");
            },
            { defer: true },
        ),
    );

    const studentOptions = (): Array<{ id: string; name: string }> =>
        (students() ?? []).map((student) => ({ id: student.id, name: student.displayName }));

    async function startSession(): Promise<void> {
        const value = detail();
        if (!value) return;
        try {
            await sessionsApi.update(
                value.session.id,
                sessionInput(value.session, {
                    status: "active",
                    startedAt: Date.now(),
                    endedAt: null,
                }),
            );
            setMessage("Session started.");
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function completeSession(): Promise<void> {
        const value = detail();
        if (!value) return;
        try {
            await sessionsApi.update(
                value.session.id,
                sessionInput(value.session, {
                    status: "completed",
                    startedAt: value.session.startedAt ?? Date.now(),
                    endedAt: Date.now(),
                }),
            );
            setMessage("Session completed.");
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <Show when={detail()} fallback={<p class="text-sm text-muted">Loading session…</p>}>
                {(value) => (
                    <>
                        <div class="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
                            <button
                                type="button"
                                class="hover:text-ink"
                                onClick={() => navigate("/sessions")}
                            >
                                Sessions
                            </button>
                            <Icon name="chevron" class="h-3 w-3" />
                            <Show when={value().session.studentId}>
                                <button
                                    type="button"
                                    class="hover:text-ink"
                                    onClick={() =>
                                        navigate(
                                            `/students/${value().session.studentId ?? ""}/overview`,
                                        )
                                    }
                                >
                                    {value().session.studentName}
                                </button>
                                <Icon name="chevron" class="h-3 w-3" />
                            </Show>
                            <span class="text-ink">{value().session.title}</span>
                        </div>
                        <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h1 class="text-[25px] font-semibold leading-tight tracking-tight text-ink">
                                        {value().session.title}
                                    </h1>
                                    <Badge
                                        tone={
                                            value().session.status === "active"
                                                ? "accent"
                                                : value().session.status === "completed"
                                                  ? "success"
                                                  : "neutral"
                                        }
                                    >
                                        {value().session.status}
                                    </Badge>
                                </div>
                                <p class="mt-1 text-xs text-muted">
                                    {value().session.studentName || "Independent session"}
                                    {value().session.subject ? ` · ${value().session.subject}` : ""}
                                    {value().session.startedAt
                                        ? ` · ${formatDate(value().session.startedAt)} ${formatTime(value().session.startedAt)}`
                                        : ` · ${formatDate(value().session.scheduledAt ?? value().session.createdAt)}`}
                                </p>
                            </div>
                            <div class="flex flex-wrap gap-2">
                                <Show when={value().session.status === "planned"}>
                                    <Button variant="primary" onClick={() => void startSession()}>
                                        Start session
                                    </Button>
                                </Show>
                                <Show when={value().session.status === "active"}>
                                    <Button
                                        variant="primary"
                                        onClick={() => void completeSession()}
                                    >
                                        Complete session
                                    </Button>
                                </Show>
                                <Button onClick={() => void refetch()}>Refresh</Button>
                            </div>
                        </div>
                        <Show when={error()}>
                            <div class="mb-4">
                                <InlineNotice tone="danger">{error()}</InlineNotice>
                            </div>
                        </Show>
                        <Show when={message()}>
                            <div class="mb-4">
                                <InlineNotice tone="success">{message()}</InlineNotice>
                            </div>
                        </Show>
                        <div class="mb-4">
                            <Tabs
                                active={tab()}
                                onChange={(id) => navigate(sessionPath(value().session.id, id))}
                                tabs={[
                                    { id: "overview", label: "Overview" },
                                    {
                                        id: "capture",
                                        label: "Capture",
                                        count: value().recordings.length,
                                    },
                                    {
                                        id: "transcript",
                                        label: "Transcript",
                                        count: value().cues.length,
                                    },
                                    {
                                        id: "notes",
                                        label: "Notes",
                                        count: value().journal.length + value().observations.length,
                                    },
                                    {
                                        id: "materials",
                                        label: "Materials",
                                        count: value().materials.length,
                                    },
                                    {
                                        id: "evidence",
                                        label: "Evidence",
                                        count: value().evidence.length,
                                    },
                                    { id: "guide", label: "Guide", count: value().guides.length },
                                ]}
                            />
                        </div>
                        <Show when={tab() === "overview"}>
                            <OverviewPanel
                                detail={value()}
                                students={studentOptions()}
                                onChanged={() => void refetch()}
                            />
                        </Show>
                        <Show when={tab() === "capture"}>
                            <CapturePanel detail={value()} onChanged={() => void refetch()} />
                        </Show>
                        <Show when={tab() === "transcript"}>
                            <TranscriptPanel detail={value()} onChanged={() => void refetch()} />
                        </Show>
                        <Show when={tab() === "notes"}>
                            <NotesPanel detail={value()} onChanged={() => void refetch()} />
                        </Show>
                        <Show when={tab() === "materials"}>
                            <MaterialsPanel detail={value()} onChanged={() => void refetch()} />
                        </Show>
                        <Show when={tab() === "evidence"}>
                            <EvidencePanel detail={value()} onChanged={() => void refetch()} />
                        </Show>
                        <Show when={tab() === "guide"}>
                            <GuidePanel detail={value()} onChanged={() => void refetch()} />
                        </Show>
                    </>
                )}
            </Show>
        </div>
    );
}
