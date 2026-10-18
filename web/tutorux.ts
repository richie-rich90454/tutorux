(() => {
    "use strict";

    type WorkerRequest = {
        resolve: (value: any) => void;
        reject: (reason: Error) => void;
    };

    type WorkerResponse = {
        id: number;
        type?: string;
        ok: boolean;
        result?: any;
        bytes?: ArrayBuffer;
        channels?: number;
        frames?: number;
        sampleRate?: number;
        samples?: ArrayBuffer;
        error?: string;
    };

    const elements: Record<string, any> = Object.fromEntries(
        [
            "archive-file",
            "archive-label",
            "archive-recovery",
            "archive-recovery-message",
            "archive-recover-unpublished",
            "archive-discard-tail",
            "archive-state",
            "command-form",
            "command-input",
            "command-output",
            "create-archive",
            "guides-list",
            "notice",
            "notice-message",
            "notice-dismiss",
            "open-archive",
            "recent-sessions",
            "save-archive",
            "set-passphrase",
            "session-count",
            "session-form",
            "session-student",
            "session-subject",
            "session-title",
            "sessions-list",
            "student-count",
            "student-form",
            "student-grade",
            "student-name",
            "students-list",
            "passphrase-dialog",
            "passphrase-form",
            "passphrase-input",
            "new-passphrase-input",
            "browser-storage",
            "storage-status-title",
            "storage-status-detail",
            "download-browser-copy",
            "active-session",
            "session-update-form",
            "edit-session-title",
            "edit-session-subject",
            "annotation-form",
            "annotation-id",
            "annotation-title",
            "annotation-type",
            "annotation-time",
            "annotation-priority",
            "annotation-content",
            "annotation-save",
            "annotation-cancel",
            "annotations-list",
            "annotation-marker-select",
            "annotation-marker-jump",
            "annotation-merge-form",
            "annotation-merge-select",
            "annotation-merge-separator",
            "annotation-merge-submit",
            "transcript-import-form",
            "transcript-file",
            "transcript-format",
            "transcript-export-form",
            "transcript-export-format",
            "transcript-list",
            "recording-import-form",
            "recording-file",
            "recording-import-status",
            "browser-recording-consent",
            "browser-recording-start",
            "browser-recording-stop",
            "browser-recording-status",
            "browser-recording-recover",
            "recording-track-select",
            "recording-tracks-list",
            "browser-playback-stop",
            "asset-import-form",
            "asset-files",
            "assets-list",
            "ai-package-form",
            "ai-package-session",
            "ai-package-format",
            "ai-response-form",
            "ai-response-file",
            "ai-response-title",
            "guide-create-form",
            "guide-source-scope",
            "guide-session",
            "guide-entry-scope",
            "guide-editor",
            "active-guide",
            "guide-title-form",
            "guide-title",
            "guide-approve",
            "guide-sections",
            "guide-section-form",
            "guide-section-heading",
            "guide-section-text",
            "guide-export-form",
            "guide-export-format",
            "archive-create-dialog",
            "archive-create-form",
            "new-archive-name",
        ].map((id) => [id, document.getElementById(id)]),
    );

    const views = [...document.querySelectorAll<HTMLElement>("[data-panel]")];
    let webWorker = null;
    let workerReady = null;
    let nextWorkerRequestId = 0;
    const workerRequests = new Map<number, WorkerRequest>();
    let activeArchivePath = "";
    let activeArchiveName = "";
    let archiveRecoveryNeedsReview = false;
    let archiveRecoveryReport: any = null;
    let sourceFileHandle = null;
    let dirty = false;
    let noticeTimer = 0;
    let browserArchiveDatabase = null;
    let archivePassphrase = "";
    let newArchivePassphrase = "";
    let sessionRecords: any[] = [];
    let guideRecords: any[] = [];
    let activeSessionId = "";
    let activeSessionHasAudio = false;
    let activeSessionAssets: any[] = [];
    let activeSessionEvidence: any[] = [];
    let activeSessionTracks: any[] = [];
    let activeGuideId = "";
    let recoveryArchive: any = null;
    let browserRecordingContext: AudioContext | null = null;
    let browserRecordingSource: MediaStreamAudioSourceNode | null = null;
    let browserRecordingNode: AudioWorkletNode | null = null;
    let browserRecordingStream: MediaStream | null = null;
    let browserRecordingBytes = 0;
    let browserRecordingPath = "";
    let browserRecordingRecoveryPaths: string[] = [];
    let browserRecordingWriteChain: Promise<void> = Promise.resolve();
    let browserRecordingPendingWrites = 0;
    let browserRecordingPendingFrames = 0;
    let browserRecordingSegmentFrames = 0;
    let browserRecordingTotalFrames = 0;
    let browserRecordingSampleRateHz = 0;
    let browserRecordingSegmentIndex = 0;
    let browserRecordingImportedSegments = 0;
    let browserRecordingToken = 0;
    let browserRecordingStopping = false;
    let browserRecordingFlushed = false;
    let browserRecordingFailure: Error | null = null;
    let browserRecordingWriteFailure: Error | null = null;
    let browserRecordingSessionId = "";
    let browserRecordingStartedAt = 0;
    let browserRecordingConsentAtUs = 0;
    let browserRecordingSaving = false;
    let browserPlaybackContext: AudioContext | null = null;
    let browserPlaybackSource: AudioBufferSourceNode | null = null;
    let browserPlaybackPort: MessagePort | null = null;
    let browserPlaybackCancelled = false;

    const browserRecordingCheckpointSeconds = 20;
    const maximumPendingBrowserRecordingSeconds = 7;

    function showNotice(message, isError = false) {
        window.clearTimeout(noticeTimer);
        elements["notice-message"].textContent = message;
        elements.notice.classList.toggle("is-error", isError);
        elements.notice.setAttribute("role", isError ? "alert" : "status");
        elements.notice.setAttribute("aria-live", isError ? "assertive" : "polite");
        elements["notice-dismiss"].hidden = !isError;
        elements.notice.hidden = false;
        if (!isError) {
            noticeTimer = window.setTimeout(() => {
                elements.notice.hidden = true;
            }, 4800);
        }
    }

    function primeBrowserPlayback(): void {
        const AudioContextType = window.AudioContext;
        if (!AudioContextType) return;
        browserPlaybackContext ??= new AudioContextType();
        void browserPlaybackContext.resume().catch(() => {});
    }

    function stopBrowserPlayback(): void {
        browserPlaybackCancelled = true;
        try {
            browserPlaybackPort?.postMessage({ result: 3 });
        } catch {
            // The worker may have completed its playback request between UI events.
        }
        if (browserPlaybackSource) {
            try {
                browserPlaybackSource.stop();
            } catch {
                // The source may have completed between the click and stop request.
            }
        }
    }

    async function playBrowserPcm(message: WorkerResponse, port: MessagePort): Promise<void> {
        try {
            primeBrowserPlayback();
            if (!browserPlaybackContext || !message.samples || !message.frames || !message.channels ||
                !message.sampleRate) {
                port.postMessage({ result: 1 });
                return;
            }
            await browserPlaybackContext.resume();
            const pcm = new Int16Array(message.samples);
            const audio = browserPlaybackContext.createBuffer(
                message.channels,
                message.frames,
                message.sampleRate,
            );
            for (let channel = 0; channel < message.channels; channel += 1) {
                const channelData = audio.getChannelData(channel);
                for (let frame = 0; frame < message.frames; frame += 1) {
                    channelData[frame] = pcm[frame * message.channels + channel] / 32768;
                }
            }
            const source = browserPlaybackContext.createBufferSource();
            source.buffer = audio;
            source.connect(browserPlaybackContext.destination);
            browserPlaybackSource = source;
            browserPlaybackPort = port;
            elements["browser-playback-stop"].disabled = false;
            await new Promise<void>((resolve, reject) => {
                source.onended = () => resolve();
                try {
                    source.start();
                } catch (error) {
                    reject(error);
                }
            });
            if (browserPlaybackSource === source) browserPlaybackSource = null;
            if (browserPlaybackPort === port) browserPlaybackPort = null;
            const cancelled = browserPlaybackCancelled;
            browserPlaybackCancelled = false;
            if (!cancelled) port.postMessage({ result: 0 });
        } catch {
            browserPlaybackSource = null;
            if (browserPlaybackPort === port) browserPlaybackPort = null;
            if (!browserPlaybackCancelled) port.postMessage({ result: 2 });
            browserPlaybackCancelled = false;
        } finally {
            elements["browser-playback-stop"].disabled = true;
            port.close();
        }
    }

    function setDirty(value) {
        dirty = value;
        elements.saveArchive.disabled = !activeArchivePath;
        elements.archiveLabel.textContent = activeArchiveName
            ? `${activeArchiveName}${dirty ? " · portable download needed" : ""}`
            : "No archive open";
    }

    function setWorkspaceAvailability(enabled: boolean): void {
        const available = enabled && !archiveRecoveryNeedsReview;
        for (const requirement of document.querySelectorAll<HTMLElement>("[data-requires-archive]")) {
            const controls = requirement.matches("input, button, select, textarea")
                ? [requirement as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement]
                : [...requirement.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input, button, select, textarea")];
            for (const control of controls) control.disabled = !available;
        }
        if (elements["command-form"]) {
            for (const control of elements["command-form"].querySelectorAll("input, button")) {
                control.disabled = !available;
            }
        }
        updateBrowserRecordingControls();
    }

    function updateBrowserRecordingControls(): void {
        const supported = Boolean(
            window.isSecureContext &&
            navigator.mediaDevices?.getUserMedia &&
            window.AudioContext &&
            typeof AudioWorkletNode !== "undefined",
        );
        const captureActive = Boolean(browserRecordingNode);
        const recording = captureActive && !browserRecordingStopping;
        elements["browser-recording-consent"].disabled = !activeArchivePath || captureActive || browserRecordingSaving;
        elements["browser-recording-start"].disabled =
            !activeArchivePath || !activeSessionId || !supported || captureActive || browserRecordingSaving ||
            browserRecordingRecoveryPaths.length > 0 ||
            !elements["browser-recording-consent"].checked;
        elements["browser-recording-stop"].disabled = !recording || browserRecordingSaving;
        if (!supported && elements["browser-recording-status"]) {
            elements["browser-recording-status"].textContent =
                "Microphone capture requires a secure browser with AudioWorklet support. System audio is not captured.";
        }
    }

    function stopBrowserRecording(): void {
        if (!browserRecordingNode || browserRecordingStopping) return;
        browserRecordingStopping = true;
        browserRecordingStream?.getTracks().forEach((track) => track.stop());
        browserRecordingSource?.disconnect();
        browserRecordingNode.port.postMessage({ type: "flush" });
        elements["browser-recording-status"].textContent = "Stopping and saving the microphone recording…";
        updateBrowserRecordingControls();
    }

    async function importBrowserRecordingSegment(path: string): Promise<void> {
        await runWriteCommand([
            "record", "import",
            "--session", browserRecordingSessionId,
            "--input", path,
            "--additional-track",
            "--capture-source", "browser-microphone",
            "--capture-consent-at-us", String(browserRecordingConsentAtUs),
            "--consent",
        ], { showSuccessNotice: false, requireBrowserPersistence: true });
        browserRecordingImportedSegments += 1;
    }

    async function preserveBrowserRecordingWav(path: string, filename: string): Promise<boolean> {
        try {
            const recovery = await requestWorker("read-file", { path });
            downloadFileBytes(recovery.bytes, filename, "audio/wav");
            await requestWorker("remove-file", { path });
            return true;
        } catch {
            if (!browserRecordingRecoveryPaths.includes(path)) {
                browserRecordingRecoveryPaths.push(path);
            }
            elements["browser-recording-recover"].hidden = false;
            elements["browser-recording-recover"].disabled = false;
            return false;
        }
    }

    async function checkpointBrowserRecordingSegment(): Promise<void> {
        const completedPath = browserRecordingPath;
        if (!completedPath || browserRecordingSegmentFrames === 0) return;
        const nextIndex = browserRecordingSegmentIndex + 1;
        const nextPath =
            `/workspace/tutorux-browser-recording-${browserRecordingToken}-segment-${nextIndex}.wav`;
        await requestWorker("begin-pcm-recording", {
            path: nextPath,
            sampleRateHz: browserRecordingSampleRateHz,
        });
        await requestWorker("finish-pcm-recording", { path: completedPath });
        browserRecordingPath = nextPath;
        browserRecordingSegmentIndex = nextIndex;
        browserRecordingSegmentFrames = 0;
        browserRecordingBytes = 0;
        try {
            await importBrowserRecordingSegment(completedPath);
            await requestWorker("remove-file", { path: completedPath });
            const savedSeconds = Math.floor(browserRecordingTotalFrames / browserRecordingSampleRateHz);
            elements["browser-recording-status"].textContent =
                `Saved ${browserRecordingImportedSegments} audio segment(s) · ${savedSeconds.toLocaleString()} seconds archived. Recording continues.`;
        } catch (error) {
            browserRecordingFailure = error;
            const recovered = await preserveBrowserRecordingWav(
                completedPath,
                `tutorux-browser-recording-segment-${nextIndex - 1}-recovery.wav`,
            );
            const recoveryMessage = recovered
                ? " A WAV copy of the unsaved segment was downloaded."
                : " Download the retained WAV recovery before closing this page.";
            elements["browser-recording-status"].textContent = `${error.message}${recoveryMessage}`;
            stopBrowserRecording();
        }
    }

    function receiveBrowserRecordingMessage(event: MessageEvent): void {
        const message = event.data;
        if (message?.type === "pcm" && message.samples instanceof ArrayBuffer) {
            const frameCount = message.samples.byteLength / 2;
            if (browserRecordingPendingFrames + frameCount >
                browserRecordingSampleRateHz * maximumPendingBrowserRecordingSeconds) {
                browserRecordingFailure = new Error(
                    "Archive saving could not keep up with microphone capture. Recording stopped after preserving the saved segments.",
                );
                stopBrowserRecording();
                return;
            }
            browserRecordingPendingWrites += 1;
            browserRecordingPendingFrames += frameCount;
            const samples = message.samples as ArrayBuffer;
            browserRecordingWriteChain = browserRecordingWriteChain
                .then(async () => {
                    if (browserRecordingWriteFailure) return;
                    const path = browserRecordingPath;
                    const response = await requestWorker(
                        "append-pcm-recording",
                        { path, samples },
                        [samples],
                    );
                    browserRecordingBytes = Number(response.result?.dataBytes || browserRecordingBytes);
                    browserRecordingSegmentFrames += frameCount;
                    browserRecordingTotalFrames += frameCount;
                    elements["browser-recording-status"].textContent =
                        `Recording microphone audio · ${browserRecordingBytes.toLocaleString()} bytes in the current archive segment.`;
                    if (browserRecordingSegmentFrames >=
                        browserRecordingSampleRateHz * browserRecordingCheckpointSeconds) {
                        await checkpointBrowserRecordingSegment();
                    }
                })
                .catch((error: Error) => {
                    browserRecordingWriteFailure = error;
                    browserRecordingFailure = error;
                    elements["browser-recording-status"].textContent =
                        "Microphone storage stopped unexpectedly. Recovering the audio already saved.";
                    stopBrowserRecording();
                })
                .finally(() => {
                    browserRecordingPendingWrites -= 1;
                    browserRecordingPendingFrames -= frameCount;
                });
            return;
        }
        if (message?.type === "flushed") {
            browserRecordingFlushed = true;
            window.dispatchEvent(new CustomEvent("tutorux:recording-state", {
                detail: {
                    active: false,
                    sessionId: browserRecordingSessionId,
                    startedAt: browserRecordingStartedAt,
                    stoppedAt: Date.now(),
                },
            }));
            void saveBrowserRecording();
        }
    }

    async function saveBrowserRecording(): Promise<void> {
        if (!browserRecordingFlushed || browserRecordingSaving) return;
        browserRecordingSaving = true;
        updateBrowserRecordingControls();

        let finalized = false;
        let inputPath = "";
        let fallbackFilename = "";
        try {
            await browserRecordingWriteChain;
            if (browserRecordingPendingWrites !== 0 || browserRecordingPendingFrames !== 0) {
                throw new Error("The browser microphone still has audio blocks waiting to be saved.");
            }
            inputPath = browserRecordingPath;
            fallbackFilename = `tutorux-browser-recording-segment-${browserRecordingSegmentIndex}-recovery.wav`;
            if (browserRecordingBytes > 0) {
                await requestWorker("finish-pcm-recording", { path: inputPath });
                finalized = true;
                if (browserRecordingWriteFailure) throw browserRecordingWriteFailure;
                await importBrowserRecordingSegment(inputPath);
            } else if (browserRecordingImportedSegments === 0) {
                throw browserRecordingFailure || new Error("The browser did not capture any microphone audio.");
            }
            const recoveryNotice = browserRecordingFailure
                ? " Capture stopped early after preserving the completed audio segments."
                : "";
            elements["browser-recording-status"].textContent = browserRecordingImportedSegments > 0
                ? `Microphone capture saved as ${browserRecordingImportedSegments} archive-native audio segment(s).${recoveryNotice}`
                : `Microphone capture saved as an archive-native audio segment.${recoveryNotice}`;
            elements["browser-recording-consent"].checked = false;
            showNotice("Browser microphone audio is saved as archive-native audio chunks.");
        } catch (error) {
            let recoveryMessage = "";
            inputPath ||= browserRecordingPath;
            fallbackFilename ||= `tutorux-browser-recording-segment-${browserRecordingSegmentIndex}-recovery.wav`;
            if (inputPath && browserRecordingBytes > 0) {
                try {
                    if (!finalized) {
                        await requestWorker("finish-pcm-recording", { path: inputPath });
                        finalized = true;
                    }
                    const recovery = await requestWorker("read-file", { path: inputPath });
                    downloadFileBytes(recovery.bytes, fallbackFilename, "audio/wav");
                    recoveryMessage = " A WAV copy was downloaded for recovery.";
                    await requestWorker("remove-file", { path: inputPath });
                } catch {
                    if (finalized && !browserRecordingRecoveryPaths.includes(inputPath)) {
                        browserRecordingRecoveryPaths.push(inputPath);
                    }
                    recoveryMessage = finalized
                        ? " The WAV remains available here; download recovery audio before closing this page."
                        : " The temporary capture could not be finalized for recovery.";
                }
            }
            elements["browser-recording-status"].textContent = `${error.message}${recoveryMessage}`;
            showNotice(`${error.message}${recoveryMessage}`, true);
        } finally {
            browserRecordingSaving = false;
            if (inputPath && !browserRecordingRecoveryPaths.includes(inputPath)) {
                requestWorker("remove-file", { path: inputPath }).catch(() => {});
            }
            if (browserRecordingRecoveryPaths.length > 0) {
                elements["browser-recording-recover"].hidden = false;
                elements["browser-recording-recover"].disabled = false;
            }
            browserRecordingNode?.disconnect();
            browserRecordingNode = null;
            browserRecordingSource = null;
            browserRecordingStream?.getTracks().forEach((track) => track.stop());
            browserRecordingStream = null;
            if (browserRecordingContext) await browserRecordingContext.close().catch(() => {});
            browserRecordingContext = null;
            browserRecordingPath = "";
            browserRecordingSegmentFrames = 0;
            browserRecordingSampleRateHz = 0;
            browserRecordingPendingFrames = 0;
            browserRecordingTotalFrames = 0;
            browserRecordingSegmentIndex = 0;
            browserRecordingImportedSegments = 0;
            browserRecordingWriteFailure = null;
            browserRecordingSessionId = "";
            browserRecordingConsentAtUs = 0;
            browserRecordingStopping = false;
            browserRecordingFlushed = false;
            browserRecordingFailure = null;
            browserRecordingBytes = 0;
            elements["browser-recording-consent"].checked = false;
            updateBrowserRecordingControls();
        }
    }

    async function startBrowserRecording(): Promise<void> {
        if (!activeArchivePath || !activeSessionId) {
            throw new Error("Open an archive and choose a session before recording.");
        }
        if (!elements["browser-recording-consent"].checked) {
            throw new Error("Confirm permission to record microphone audio before starting.");
        }
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia ||
            !window.AudioContext || typeof AudioWorkletNode === "undefined") {
            throw new Error("This browser does not support secure microphone recording.");
        }

        const pendingStream = (window as any).tutoruxPendingRecordingStream as MediaStream | null;
        const stream = pendingStream ?? await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        });
        (window as any).tutoruxPendingRecordingStream = null;
        browserRecordingStream = stream;
        browserRecordingSessionId = activeSessionId;
        browserRecordingConsentAtUs = Date.now() * 1000;
        browserRecordingBytes = 0;
        browserRecordingToken = Date.now();
        browserRecordingSegmentIndex = 1;
        browserRecordingImportedSegments = 0;
        browserRecordingSegmentFrames = 0;
        browserRecordingTotalFrames = 0;
        browserRecordingPendingFrames = 0;
        browserRecordingWriteFailure = null;
        browserRecordingPath =
            `/workspace/tutorux-browser-recording-${browserRecordingToken}-segment-1.wav`;
        browserRecordingWriteChain = Promise.resolve();
        browserRecordingPendingWrites = 0;
        browserRecordingStopping = false;
        browserRecordingFlushed = false;
        browserRecordingFailure = null;
        try {
            browserRecordingContext = new AudioContext();
            await browserRecordingContext.resume();
            await browserRecordingContext.audioWorklet.addModule(
                new URL("./tutorux-recorder-worklet.js", window.location.href),
            );
            browserRecordingSampleRateHz = browserRecordingContext.sampleRate;
            await requestWorker("begin-pcm-recording", {
                path: browserRecordingPath,
                sampleRateHz: browserRecordingSampleRateHz,
            });
            browserRecordingSource = browserRecordingContext.createMediaStreamSource(stream);
            browserRecordingNode = new AudioWorkletNode(browserRecordingContext, "tutorux-pcm-recorder", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCountMode: "max",
                channelInterpretation: "speakers",
            });
            browserRecordingNode.port.addEventListener("message", receiveBrowserRecordingMessage);
            browserRecordingNode.port.start();
            browserRecordingNode.addEventListener("processorerror", () => {
                browserRecordingFailure = new Error("The browser audio processor stopped unexpectedly.");
                stopBrowserRecording();
            }, { once: true });
            for (const track of stream.getAudioTracks()) {
                track.addEventListener("ended", () => {
                    if (browserRecordingStopping) return;
                    browserRecordingFailure = new Error("The microphone disconnected during recording.");
                    stopBrowserRecording();
                }, { once: true });
            }
            browserRecordingSource.connect(browserRecordingNode);
            browserRecordingNode.connect(browserRecordingContext.destination);
        } catch (error) {
            browserRecordingStream?.getTracks().forEach((track) => track.stop());
            browserRecordingStream = null;
            browserRecordingNode?.disconnect();
            browserRecordingNode = null;
            browserRecordingSource?.disconnect();
            browserRecordingSource = null;
            if (browserRecordingContext) await browserRecordingContext.close().catch(() => {});
            browserRecordingContext = null;
            if (browserRecordingPath) requestWorker("remove-file", { path: browserRecordingPath }).catch(() => {});
            browserRecordingPath = "";
            browserRecordingSampleRateHz = 0;
            browserRecordingSegmentFrames = 0;
            browserRecordingPendingFrames = 0;
            browserRecordingTotalFrames = 0;
            browserRecordingSegmentIndex = 0;
            browserRecordingImportedSegments = 0;
            browserRecordingWriteFailure = null;
            browserRecordingSessionId = "";
            browserRecordingConsentAtUs = 0;
            elements["browser-recording-consent"].checked = false;
            throw error;
        }
        browserRecordingStartedAt = Date.now();
        window.dispatchEvent(new CustomEvent("tutorux:recording-state", {
            detail: { active: true, sessionId: browserRecordingSessionId, startedAt: browserRecordingStartedAt },
        }));
        elements["browser-recording-status"].textContent =
            `Recording microphone audio at ${browserRecordingContext.sampleRate.toLocaleString()} Hz. ` +
            "Audio is checkpointed into the archive every 20 seconds. Keep this page open until it is saved.";
        updateBrowserRecordingControls();
    }

    function setStorageStatus(title: string, detail: string, canDownload = false): void {
        elements["storage-status-title"].textContent = title;
        elements["storage-status-detail"].textContent = detail;
        elements["download-browser-copy"].disabled = !canDownload;
        elements["browser-storage"].classList.toggle("is-warning", !canDownload && Boolean(activeArchivePath));
    }

    function setArchive(path, name, handle = null, notify = true) {
        activeArchivePath = path;
        activeArchiveName = name;
        sourceFileHandle = handle;
        archiveRecoveryNeedsReview = false;
        archiveRecoveryReport = null;
        elements["archive-recovery"].hidden = true;
        activeSessionId = "";
        activeSessionHasAudio = false;
        activeSessionAssets = [];
        activeSessionEvidence = [];
        activeSessionTracks = [];
        activeGuideId = "";
        elements.setPassphrase.disabled = !path;
        elements.archiveState.classList.toggle("is-open", Boolean(path));
        setWorkspaceAvailability(Boolean(path));
        setDirty(false);
        elements.studentCount.textContent = "0";
        elements.sessionCount.textContent = "0";
        updateBrowserRecordingControls();
        renderAnnotations([]);
        renderRecordingTracks([]);
        if (notify) window.dispatchEvent(new CustomEvent("tutorux:archive-open"));
    }

    function startWebWorker(): Promise<void> {
        if (workerReady) return workerReady;
        workerReady = new Promise((resolve, reject) => {
            webWorker = new Worker("./tutorux-worker.js");
            webWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
                const message = event.data;
                if (message.type === "play-audio") {
                    const port = event.ports[0];
                    if (port) void playBrowserPcm(message, port);
                    return;
                }
                if (message.type === "ready") {
                    resolve();
                    return;
                }
                const pending = workerRequests.get(message.id);
                if (!pending) return;
                workerRequests.delete(message.id);
                if (!message.ok) pending.reject(new Error(message.error || "Browser worker failed."));
                else pending.resolve(message);
            };
            webWorker.onerror = (event) => reject(new Error(event.message || "Browser worker failed."));
            webWorker.postMessage({ id: 0, type: "initialize" });
        });
        return workerReady;
    }

    async function requestWorker(type: string, payload: Record<string, any> = {}, transfer: Transferable[] = []): Promise<WorkerResponse> {
        await startWebWorker();
        return new Promise((resolve, reject) => {
            const id = ++nextWorkerRequestId;
            workerRequests.set(id, { resolve, reject });
            webWorker.postMessage({ id, type, payload }, transfer);
        });
    }

    async function responseFrom(
        argumentsList: string[],
        options: { synchronizeArchive?: boolean } = {},
    ): Promise<any> {
        const message = await requestWorker("dispatch", {
            arguments: argumentsList,
            passphrase: archivePassphrase,
            newPassphrase: newArchivePassphrase,
            synchronizeArchive: options.synchronizeArchive !== false,
        });
        const response = message.result;
        if (response.archive_persistence_error) {
            setStorageStatus(
                "Browser recovery storage unavailable",
                response.archive_persistence_error,
                Boolean(activeArchivePath),
            );
        }
        if (response.ok !== true && response.ok !== "true") {
            const error = new Error(response.error || response.output || "The command failed.");
            error.code = response.error_code || "command_failed";
            throw error;
        }
        return response;
    }

    function archiveArguments(commandArguments: string[]): string[] {
        if (!activeArchivePath) {
            throw new Error("Open or create a Tutorux archive first.");
        }
        return ["--archive", activeArchivePath, ...commandArguments, "--json"];
    }

    function updateArchiveRecovery(report: any): void {
        archiveRecoveryReport = report;
        archiveRecoveryNeedsReview = Number(report?.trailing_bytes || 0) > 0;
        elements["archive-recovery"].hidden = !archiveRecoveryNeedsReview;
        elements["archive-recover-unpublished"].hidden =
            !archiveRecoveryNeedsReview || !Boolean(report?.recoverable);
        elements["archive-discard-tail"].hidden = !archiveRecoveryNeedsReview;
        if (!archiveRecoveryNeedsReview) {
            elements["archive-recovery-message"].textContent = "";
            setWorkspaceAvailability(Boolean(activeArchivePath));
            return;
        }

        const details = [
            `Committed generation ${Number(report?.committed_generation || 0)}; ` +
                `${Number(report?.trailing_bytes || 0).toLocaleString()} trailing bytes.`,
        ];
        if (report?.has_unpublished_commit) {
            details.push(`Unpublished generation ${Number(report?.candidate_generation || 0)} was found.`);
            if (report?.recoverable) {
                details.push("Full integrity verification passed. You can publish this generation.");
            } else if (report?.requires_passphrase) {
                details.push("Enter the archive passphrase before Tutorux can verify it for recovery.");
            } else {
                details.push("The candidate did not pass full integrity verification and cannot be recovered.");
            }
        } else {
            details.push("No complete unpublished generation is available.");
        }
        if (Array.isArray(report?.issues)) details.push(...report.issues.map(String));
        elements["archive-recovery-message"].textContent = details.join(" ");
        setWorkspaceAvailability(Boolean(activeArchivePath));
    }

    async function refreshArchiveRecovery(): Promise<any> {
        const response = await responseFrom(
            archiveArguments(["archive", "recover"]),
            { synchronizeArchive: false },
        );
        let report: any;
        try {
            report = JSON.parse(String(response.output || ""));
        } catch {
            throw new Error("The archive recovery inspection returned invalid JSON.");
        }
        updateArchiveRecovery(report);
        return report;
    }

    async function performArchiveRecovery(action: "recover-unpublished" | "discard-tail") {
        if (!archiveRecoveryNeedsReview || !archiveRecoveryReport) {
            throw new Error("This archive does not need recovery.");
        }
        if (action === "recover-unpublished" && !archiveRecoveryReport.recoverable) {
            throw new Error("No unpublished generation passed full integrity verification.");
        }
        const buttons = [elements["archive-recover-unpublished"], elements["archive-discard-tail"]];
        for (const button of buttons) button.disabled = true;
        try {
            await responseFrom(archiveArguments(["archive", "recover", `--${action}`]));
            setDirty(true);
            await refreshArchiveRecovery();
            await refreshWorkspace();
            await persistBrowserArchive();
            window.dispatchEvent(new CustomEvent("tutorux:archive-change"));
            showNotice(action === "recover-unpublished"
                ? "The verified archive generation is now committed. Download the updated archive to keep the recovery."
                : "The incomplete archive tail was discarded. Download the updated archive to keep this copy.");
        } catch (error) {
            showNotice(error.message, true);
        } finally {
            for (const button of buttons) button.disabled = false;
            setWorkspaceAvailability(Boolean(activeArchivePath));
        }
    }

    async function readArchiveBytes() {
        const result = await requestWorker("read-archive", { path: activeArchivePath });
        return new Uint8Array(result.bytes);
    }

    function openBrowserArchiveDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("tutorux-portable-archive", 1);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains("workspace")) {
                    database.createObjectStore("workspace", { keyPath: "key" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Browser archive storage failed."));
            request.onblocked = () => reject(new Error("Close another Tutorux tab to open browser storage."));
        });
    }

    function archiveStorageKey(bytes: ArrayBuffer | Uint8Array): string {
        const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const magic = [0x54, 0x55, 0x54, 0x4f, 0x52, 0x55, 0x58, 0x00];
        if (view.byteLength < 32 || magic.some((byte, index) => view[index] !== byte)) {
            throw new Error("The selected file does not have a valid Tutorux archive header.");
        }
        const archiveId = Array.from(view.subarray(16, 32), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
        return `archive:${archiveId}`;
    }

    function readBrowserArchive(archiveKey = "") {
        return new Promise((resolve, reject) => {
            if (!browserArchiveDatabase) {
                reject(new Error("Browser archive storage is unavailable."));
                return;
            }
            const store = browserArchiveDatabase
                .transaction("workspace", "readonly")
                .objectStore("workspace");
            if (archiveKey) {
                const request = store.get(archiveKey);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(
                    request.error || new Error("Browser archive could not be read."),
                );
                return;
            }
            const activeRequest = store.get("active");
            activeRequest.onsuccess = () => {
                const active = activeRequest.result;
                if (!active) {
                    recoveryArchive = null;
                    resolve(null);
                    return;
                }
                if (typeof active.archiveKey !== "string") {
                    recoveryArchive = active;
                    resolve(active);
                    return;
                }
                const archiveRequest = store.get(active.archiveKey);
                archiveRequest.onsuccess = () => {
                    recoveryArchive = archiveRequest.result || null;
                    resolve(recoveryArchive);
                };
                archiveRequest.onerror = () => reject(
                    archiveRequest.error || new Error("Browser archive could not be read."),
                );
            };
            activeRequest.onerror = () => reject(
                activeRequest.error || new Error("Browser archive could not be read."),
            );
        });
    }

    async function persistBrowserArchive() {
        if (!browserArchiveDatabase || !activeArchivePath) return;
        const source = await readArchiveBytes();
        const stored = await readBrowserArchive(archiveStorageKey(source));
        if (!stored || !(stored.bytes instanceof ArrayBuffer)) {
            throw new Error("The browser could not retain the latest archive snapshot.");
        }
        const storedBytes = new Uint8Array(stored.bytes);
        if (storedBytes.length !== source.length ||
            storedBytes.some((byte, index) => byte !== source[index])) {
            throw new Error("The browser recovery copy is older than the current archive in memory.");
        }
        recoveryArchive = stored;
        setStorageStatus(
            "Browser recovery copy updated",
            "The current .tux archive is stored in this browser. Browser storage can be cleared or evicted; download a portable copy to keep it independently.",
            true,
        );
    }

    async function restoreBrowserArchive() {
        const stored = await readBrowserArchive();
        if (!stored || !(stored.bytes instanceof ArrayBuffer)) {
            setStorageStatus(
                "No browser recovery copy",
                "Open a .tux archive or create one. The browser will keep a working copy after each archive edit.",
            );
            return false;
        }
        const safeName = String(stored.name || "Tutorux.tux")
            .replace(/[\\/\0]/g, "_")
            .replace(/^\.+/, "_");
        activeArchivePath = `/workspace/${safeName}`;
        activeArchiveName = safeName;
        sourceFileHandle = null;
        await requestWorker("write-file", { path: activeArchivePath, bytes: stored.bytes });
        try {
            await responseFrom(["--archive", activeArchivePath, "archive", "verify", "--json"]);
        } catch (error) {
            if (error.code === "archive_locked") {
                try {
                    archivePassphrase = await requestArchivePassphrase();
                    await responseFrom(["--archive", activeArchivePath, "archive", "verify", "--json"]);
                } catch (unlockError) {
                    setArchive("", "");
                    recoveryArchive = stored;
                    setStorageStatus(
                        "Encrypted recovery copy retained",
                        "The browser copy is encrypted and has not been opened. Enter its passphrase when you are ready, or download the unchanged .tux copy for recovery on another device.",
                        true,
                    );
                    showNotice(unlockError.message, true);
                    return true;
                }
            } else {
                setArchive("", "");
                recoveryArchive = stored;
                setStorageStatus(
                    "Recovery copy needs attention",
                    `Tutorux retained the browser copy from ${new Date(stored.savedAt || 0).toLocaleString()}, but the shared archive engine could not open it: ${error.message}. Download the copy before trying recovery elsewhere.`,
                    true,
                );
                showNotice("The saved browser archive could not be opened. Its recovery copy is still available to download.", true);
                return true;
            }
        }
        elements.archiveState.classList.add("is-open");
        elements.setPassphrase.disabled = false;
        setDirty(false);
        await refreshArchiveRecovery();
        await refreshWorkspace();
        setWorkspaceAvailability(true);
        window.dispatchEvent(new CustomEvent("tutorux:archive-open"));
        setStorageStatus(
            "Browser recovery copy restored",
            `Restored ${safeName} from ${new Date(stored.savedAt || 0).toLocaleString()}. This copy remains subject to browser storage policies; download a portable .tux archive for independent safekeeping.`,
            true,
        );
        showNotice(`${safeName} restored from this browser's recovery copy.`);
        if (archiveRecoveryNeedsReview) {
            showNotice("The restored archive needs recovery review before editing. Choose a verified recovery or explicitly discard the incomplete tail.", true);
        }
        return true;
    }

    function downloadFileBytes(
        bytes: ArrayBuffer | Uint8Array,
        name: string,
        mediaType = "application/octet-stream",
    ): void {
        const download = document.createElement("a");
        download.href = URL.createObjectURL(
            new Blob([bytes], { type: mediaType }),
        );
        download.download = name;
        download.click();
        window.setTimeout(() => URL.revokeObjectURL(download.href), 1000);
    }

    function downloadArchiveBytes(bytes: ArrayBuffer | Uint8Array, name: string): void {
        downloadFileBytes(bytes, name.endsWith(".tux") ? name : `${name}.tux`);
    }

    async function downloadBrowserRecoveryCopy(): Promise<void> {
        if (activeArchivePath) {
            const bytes = await readArchiveBytes();
            downloadArchiveBytes(bytes, activeArchiveName);
            showNotice(`Downloaded the current recovery copy of ${activeArchiveName}.`);
            return;
        }
        const stored = await readBrowserArchive() || recoveryArchive;
        if (!stored || !(stored.bytes instanceof ArrayBuffer)) {
            throw new Error("There is no retained browser recovery copy to download.");
        }
        const name = String(stored.name || "Tutorux.tux")
            .replace(/[\\/\0]/g, "_")
            .replace(/^\.+/, "_");
        downloadArchiveBytes(stored.bytes, name);
        showNotice(`Downloaded the browser recovery copy of ${name}.`);
    }

    async function saveArchive() {
        if (!activeArchivePath) {
            return;
        }
        const bytes = await readArchiveBytes();
        let destinationHandle = sourceFileHandle;
        if (destinationHandle) {
            let permission = "granted";
            if (destinationHandle.queryPermission) {
                permission = await destinationHandle.queryPermission({ mode: "readwrite" });
                if (permission !== "granted" && destinationHandle.requestPermission) {
                    permission = await destinationHandle.requestPermission({ mode: "readwrite" });
                }
            }
            if (permission !== "granted") destinationHandle = null;
        }
        if (!destinationHandle && window.showSaveFilePicker) {
            destinationHandle = await window.showSaveFilePicker({
                suggestedName: activeArchiveName.endsWith(".tux")
                    ? activeArchiveName
                    : `${activeArchiveName}.tux`,
                types: [
                    {
                        description: "Tutorux portable archive",
                        accept: { "application/octet-stream": [".tux"] },
                    },
                ],
            });
        }
        if (destinationHandle) {
            const writable = await destinationHandle.createWritable();
            await writable.write({ type: "write", position: 0, data: bytes });
            await writable.truncate(bytes.byteLength);
            await writable.close();
            sourceFileHandle = destinationHandle;
        } else {
            downloadArchiveBytes(bytes, activeArchiveName);
        }
        setDirty(false);
        showNotice("Archive saved.");
    }

    function parseRows(output) {
        try {
            const parsed = JSON.parse(output);
            if (Array.isArray(parsed)) {
                return parsed;
            }
            if (Array.isArray(parsed.records)) {
                return parsed.records;
            }
        } catch {
            return [];
        }
        return [];
    }

    function rowLabel(record, fallback) {
        return record.name || record.title || record.display_name || record.id || fallback;
    }

    function renderRows(
        container: HTMLElement,
        rows: any[],
        emptyText: string,
        detail: (record: any) => string,
        actionLabel = "",
        onAction: (record: any) => void = () => {},
    ): void {
        container.replaceChildren();
        if (rows.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty-row";
            empty.textContent = emptyText;
            container.append(empty);
            return;
        }
        for (const [index, record] of rows.entries()) {
            const row = document.createElement("article");
            row.className = "record-row";
            const marker = document.createElement("span");
            marker.className = "record-marker";
            marker.textContent = String(index + 1).padStart(2, "0");
            const copy = document.createElement("div");
            copy.className = "record-copy";
            const title = document.createElement("strong");
            title.textContent = rowLabel(record, "Untitled");
            const subtitle = document.createElement("span");
            subtitle.textContent = detail(record);
            copy.append(title, subtitle);
            row.append(marker, copy);
            if (actionLabel) {
                const action = document.createElement("button");
                action.className = "button button-quiet row-action";
                action.type = "button";
                action.textContent = actionLabel;
                action.setAttribute("aria-label", `${actionLabel}: ${rowLabel(record, "record")}`);
                action.addEventListener("click", () => onAction(record));
                row.append(action);
            }
            container.append(row);
        }
    }

    function fillSelect(select: HTMLSelectElement, rows: any[], placeholder: string, selectedId = ""): void {
        select.replaceChildren();
        const emptyOption = document.createElement("option");
        emptyOption.value = "";
        emptyOption.textContent = placeholder;
        select.append(emptyOption);
        for (const record of rows) {
            const option = document.createElement("option");
            option.value = String(record.id || "");
            option.textContent = rowLabel(record, "Untitled");
            select.append(option);
        }
        select.value = rows.some((record) => String(record.id) === selectedId) ? selectedId : "";
    }

    function parseRecord(output: string): any | null {
        try {
            const parsed = JSON.parse(output);
            return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : null;
        } catch {
            return null;
        }
    }

    function formatTimestamp(value: any): string {
        const microseconds = Number(value);
        if (!Number.isFinite(microseconds) || microseconds < 0) return "00:00:00";
        const totalMilliseconds = Math.floor(microseconds / 1000);
        const hours = Math.floor(totalMilliseconds / 3_600_000);
        const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
        const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
        const milliseconds = totalMilliseconds % 1000;
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
    }

    function makeEmptyRow(text: string): HTMLElement {
        const row = document.createElement("div");
        row.className = "empty-row";
        row.textContent = text;
        return row;
    }

    function beginAnnotationEdit(record: any): void {
        elements["annotation-id"].value = record.id || "";
        elements["annotation-title"].value = record.title || "";
        elements["annotation-type"].value = record.type || "general-note";
        elements["annotation-time"].value = formatTimestamp(record.start_time_us).split(".")[0];
        elements["annotation-priority"].value = record.priority || "normal";
        elements["annotation-content"].value = record.content || "";
        elements["annotation-save"].textContent = "Save note changes";
        elements["annotation-cancel"].hidden = false;
        elements["annotation-content"].focus();
    }

    function annotationManageButton(
        label: string,
        handler: () => void | Promise<void>,
        disabled = false,
    ): HTMLButtonElement {
        const button = document.createElement("button");
        button.className = "text-button";
        button.type = "button";
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener("click", handler);
        return button;
    }

    function targetRecordLabel(record: any, fallback: string): string {
        const title = record.filename || record.title || record.name ||
            (record.record_role === "audio-track" ? `${record.source || "Audio"} recording track` : "") ||
            record.content || record.type || record.id || fallback;
        const concise = String(title).replace(/\s+/g, " ").trim();
        return concise.length > 72 ? `${concise.slice(0, 69)}…` : concise;
    }

    function annotationManagementPanel(record: any): HTMLDetailsElement {
        const panel = document.createElement("details");
        panel.className = "annotation-management annotation-row-tools";
        const summary = document.createElement("summary");
        summary.textContent = "History and links";
        panel.append(summary);

        const history = document.createElement("div");
        history.className = "annotation-history-list";
        history.setAttribute("aria-live", "polite");
        const historyButton = annotationManageButton("Load revision history", async () => {
            historyButton.disabled = true;
            history.replaceChildren(makeEmptyRow("Loading annotation history…"));
            try {
                const response = await responseFrom(archiveArguments([
                    "annotation", "history", String(record.id),
                ]));
                const revisions = parseRows(response.output);
                history.replaceChildren();
                if (revisions.length === 0) {
                    history.append(makeEmptyRow("No saved revisions are available."));
                    return;
                }
                for (const revision of revisions) {
                    const row = document.createElement("div");
                    row.className = "annotation-history-row";
                    const description = document.createElement("span");
                    const revisedAt = Number(revision.updated_at_us || revision.created_at_us || 0);
                    const date = Number.isFinite(revisedAt) && revisedAt > 0
                        ? new Date(revisedAt / 1000).toLocaleString()
                        : "Time unavailable";
                    description.textContent = `Revision ${revision.revision || "?"} · ${date} · ${revision.title || revision.type || "Tutor note"}`;
                    const restore = annotationManageButton(
                        `Restore ${revision.revision || "revision"}`,
                        async () => {
                            try {
                                await runWriteCommand([
                                    "annotation", "restore", String(record.id),
                                    "--revision", String(revision.revision),
                                ]);
                            } catch (error: any) {
                                showNotice(error.message, true);
                            }
                        },
                        archiveRecoveryNeedsReview,
                    );
                    row.append(description, restore);
                    history.append(row);
                }
            } catch (error: any) {
                history.replaceChildren(makeEmptyRow(error.message));
            } finally {
                historyButton.disabled = false;
            }
        }, archiveRecoveryNeedsReview);
        panel.append(historyButton, history);

        const linkedAssets = String(record.linked_asset_ids || "").split(",").filter(Boolean);
        const linkedEvidence = String(record.linked_evidence_ids || "").split(",").filter(Boolean);
        const linkedSummary = document.createElement("p");
        linkedSummary.className = "form-help";
        linkedSummary.textContent = `${linkedAssets.length} linked file(s) · ${linkedEvidence.length} linked evidence item(s)`;
        panel.append(linkedSummary);

        const linkForm = document.createElement("form");
        linkForm.className = "annotation-link-form";
        const typeLabel = document.createElement("label");
        typeLabel.textContent = "Source type";
        const typeSelect = document.createElement("select");
        typeSelect.setAttribute("aria-label", "Source type to link");
        typeSelect.append(new Option("Session files", "asset"), new Option("Evidence", "evidence"));
        typeLabel.append(typeSelect);
        const linkTarget = document.createElement("select");
        linkTarget.setAttribute("aria-label", "Source to link to this note");
        const unlinkTarget = document.createElement("select");
        unlinkTarget.setAttribute("aria-label", "Existing source link to remove");
        const linkTargetLabel = document.createElement("label");
        linkTargetLabel.textContent = "Source to link";
        linkTargetLabel.append(linkTarget);
        const unlinkTargetLabel = document.createElement("label");
        unlinkTargetLabel.textContent = "Existing link to remove";
        unlinkTargetLabel.append(unlinkTarget);
        const linkButton = annotationManageButton("Link selected source", async () => {
            try {
                await runWriteCommand([
                    "annotation", "link", String(record.id), "--to", typeSelect.value,
                    "--target-id", linkTarget.value,
                ]);
            } catch (error: any) {
                showNotice(error.message, true);
            }
        }, true);
        const unlinkButton = annotationManageButton("Remove selected link", async () => {
            try {
                await runWriteCommand([
                    "annotation", "unlink", String(record.id), "--to", typeSelect.value,
                    "--target-id", unlinkTarget.value,
                ]);
            } catch (error: any) {
                showNotice(error.message, true);
            }
        }, true);
        function updateLinkButtons(): void {
            linkButton.disabled = archiveRecoveryNeedsReview || !linkTarget.value;
            unlinkButton.disabled = archiveRecoveryNeedsReview || !unlinkTarget.value;
        }
        function refreshLinkTargets(): void {
            const evidenceTarget = typeSelect.value === "evidence";
            const targets = evidenceTarget ? activeSessionEvidence : activeSessionAssets;
            const linkedIds = new Set(evidenceTarget ? linkedEvidence : linkedAssets);
            const available = targets.filter((target) => !linkedIds.has(String(target.id || "")));
            const linked = targets.filter((target) => linkedIds.has(String(target.id || "")));
            linkTarget.replaceChildren(new Option(
                available.length ? "Choose a source to link" : "No unlinked sources available", "",
            ));
            for (const target of available)
                linkTarget.append(new Option(targetRecordLabel(target, "Untitled source"), String(target.id || "")));
            unlinkTarget.replaceChildren(new Option(
                linked.length ? "Choose an existing link" : "No links to remove", "",
            ));
            for (const target of linked)
                unlinkTarget.append(new Option(targetRecordLabel(target, "Untitled source"), String(target.id || "")));
            updateLinkButtons();
        }
        linkForm.append(typeLabel, linkTargetLabel, linkButton, unlinkTargetLabel, unlinkButton);
        typeSelect.addEventListener("change", refreshLinkTargets);
        linkTarget.addEventListener("change", updateLinkButtons);
        unlinkTarget.addEventListener("change", updateLinkButtons);
        linkForm.addEventListener("submit", (event) => event.preventDefault());
        refreshLinkTargets();
        panel.append(linkForm);

        const characters = Array.from(String(record.content || ""));
        if (characters.length > 1) {
            const splitForm = document.createElement("form");
            splitForm.className = "annotation-split-form";
            const splitLabel = document.createElement("label");
            splitLabel.textContent = "Split note after character";
            const splitPosition = document.createElement("input");
            splitPosition.type = "number";
            splitPosition.min = "1";
            splitPosition.max = String(characters.length - 1);
            splitPosition.step = "1";
            splitPosition.required = true;
            splitPosition.value = String(Math.max(1, Math.floor(characters.length / 2)));
            splitPosition.setAttribute("aria-label", "Character boundary for splitting this note");
            splitLabel.append(splitPosition);
            const startUs = Number(record.start_time_us || 0);
            const endUs = Number(record.end_time_us || startUs);
            let splitTime: HTMLInputElement | null = null;
            if (endUs > startUs) {
                const timeLabel = document.createElement("label");
                timeLabel.textContent = "Split timestamp within this note's time range";
                splitTime = document.createElement("input");
                splitTime.type = "text";
                splitTime.inputMode = "numeric";
                splitTime.required = true;
                splitTime.value = formatTimestamp(Math.floor((startUs + endUs) / 2));
                splitTime.setAttribute("aria-label", "Split timestamp");
                timeLabel.append(splitTime);
                splitForm.append(timeLabel);
            }
            const preview = document.createElement("p");
            preview.className = "form-help annotation-split-preview";
            function updateSplitPreview(): void {
                const boundary = Number(splitPosition.value);
                const before = characters.slice(0, boundary).join("");
                const after = characters.slice(boundary).join("");
                preview.textContent = `First note: ${before.slice(0, 56)}${before.length > 56 ? "…" : ""} · Second note: ${after.slice(0, 56)}${after.length > 56 ? "…" : ""}`;
            }
            splitPosition.addEventListener("input", updateSplitPreview);
            updateSplitPreview();
            const splitButton = annotationManageButton("Split note", async () => {
                const boundary = Number(splitPosition.value);
                if (!Number.isInteger(boundary) || boundary < 1 || boundary >= characters.length) {
                    showNotice("Choose a split point inside the note text.", true);
                    return;
                }
                const command = [
                    "annotation", "split", String(record.id),
                    "--before", characters.slice(0, boundary).join(""),
                    "--after", characters.slice(boundary).join(""),
                ];
                if (splitTime) command.push("--at", splitTime.value.trim());
                try {
                    await runWriteCommand(command);
                } catch (error: any) {
                    showNotice(error.message, true);
                }
            }, archiveRecoveryNeedsReview);
            splitForm.append(splitLabel, preview, splitButton);
            splitForm.addEventListener("submit", (event) => event.preventDefault());
            panel.append(splitForm);
        }
        return panel;
    }

    function renderAnnotationMergeOptions(records: any[]): void {
        const select = elements["annotation-merge-select"] as HTMLSelectElement;
        const submit = elements["annotation-merge-submit"] as HTMLButtonElement;
        if (!select || !submit) return;
        select.replaceChildren();
        for (const record of records) {
            const option = new Option(
                `${formatTimestamp(record.start_time_us).split(".")[0]} · ${record.title || record.type || "Tutor note"}`,
                String(record.id || ""),
            );
            option.dataset.annotationType = record.type || "";
            option.dataset.priority = record.priority || "normal";
            select.append(option);
        }
        select.disabled = !activeArchivePath || archiveRecoveryNeedsReview || records.length < 2;
        (elements["annotation-merge-separator"] as HTMLSelectElement).disabled = select.disabled;
        updateAnnotationMergeSubmit();
    }

    function updateAnnotationMergeSubmit(): void {
        const select = elements["annotation-merge-select"] as HTMLSelectElement;
        const submit = elements["annotation-merge-submit"] as HTMLButtonElement;
        if (!select || !submit) return;
        const selected = [...select.selectedOptions];
        const compatible = selected.length >= 2 && selected.every((option) =>
            option.dataset.annotationType === selected[0].dataset.annotationType &&
            option.dataset.priority === selected[0].dataset.priority,
        );
        submit.disabled = select.disabled || !compatible;
    }

    function renderAnnotations(records: any[]): void {
        const container = elements["annotations-list"] as HTMLElement;
        container.replaceChildren();
        const markerSelect = elements["annotation-marker-select"] as HTMLSelectElement;
        const markerJump = elements["annotation-marker-jump"] as HTMLButtonElement;
        const sessionId = activeSessionId;
        const orderedRecords = [...records].sort((left, right) =>
            Number(left.start_time_us || 0) - Number(right.start_time_us || 0),
        );
        renderAnnotationMergeOptions(orderedRecords);
        markerSelect.replaceChildren(new Option(
            orderedRecords.length ? "Choose a marker" : "No markers yet",
            "",
        ));
        for (const record of orderedRecords) {
            const markerId = String(record.id || "");
            if (!markerId) continue;
            const title = record.title || record.type || "Session marker";
            markerSelect.append(new Option(
                `${formatTimestamp(record.start_time_us).split(".")[0]} · ${title}`,
                markerId,
            ));
        }
        markerSelect.disabled = !activeArchivePath || archiveRecoveryNeedsReview ||
            markerSelect.options.length < 2;
        markerJump.disabled = !activeArchivePath || archiveRecoveryNeedsReview || !markerSelect.value;
        if (records.length === 0) {
            container.append(makeEmptyRow("No tutor notes have been added to this session."));
            return;
        }
        for (const record of orderedRecords) {
            const row = document.createElement("article");
            row.className = "material-row annotation-row";
            row.dataset.annotationId = String(record.id || "");
            row.tabIndex = -1;
            row.setAttribute(
                "aria-label",
                `${record.title || record.type || "Session marker"} at ${formatTimestamp(record.start_time_us)}`,
            );
            const heading = document.createElement("div");
            heading.className = "material-row-heading";
            const title = document.createElement("strong");
            title.textContent = record.title || record.type || "Tutor note";
            const time = document.createElement("time");
            time.textContent = formatTimestamp(record.start_time_us).split(".")[0];
            heading.append(title, time);
            const content = document.createElement("p");
            content.textContent = record.content || "";
            const detail = document.createElement("span");
            detail.className = "material-meta";
            detail.textContent = `${record.type || "general-note"} · ${record.priority || "normal"} priority · ${record.id || ""}`;
            const edit = document.createElement("button");
            edit.className = "text-button";
            edit.type = "button";
            edit.textContent = "Edit note";
            edit.addEventListener("click", () => beginAnnotationEdit(record));
            const play = document.createElement("button");
            play.className = "text-button";
            play.type = "button";
            play.textContent = "Play from marker";
            play.setAttribute(
                "aria-label",
                `Play ${record.title || record.type || "session marker"} from ${formatTimestamp(record.start_time_us)}`,
            );
            play.disabled = !activeArchivePath || archiveRecoveryNeedsReview || !activeSessionHasAudio;
            play.addEventListener("click", () => {
                void playSessionFromTimestamp(
                    sessionId,
                    record.start_time_us,
                    `${record.title || record.type || "the marker"} at ${formatTimestamp(record.start_time_us)}`,
                );
            });
            const actions = document.createElement("div");
            actions.className = "form-actions marker-actions";
            actions.append(play, edit);
            row.append(heading, content, detail, actions, annotationManagementPanel(record));
            container.append(row);
        }
    }

    function renderTranscript(records: any[]): void {
        const container = elements["transcript-list"] as HTMLElement;
        const sessionId = activeSessionId;
        container.replaceChildren();
        if (records.length === 0) {
            container.append(makeEmptyRow("No transcript segments are linked to this session."));
            return;
        }
        for (const record of records) {
            const row = document.createElement("article");
            row.className = "transcript-row";
            const heading = document.createElement("div");
            heading.className = "material-row-heading";
            const time = document.createElement("time");
            time.textContent = `${formatTimestamp(record.start_time_us)} – ${formatTimestamp(record.end_time_us)}`;
            const meta = document.createElement("span");
            meta.className = "material-meta";
            meta.textContent = `${record.speaker_label || record.speaker_name || "Unlabeled speaker"} · ${record.verification_state || "needs review"}`;
            heading.append(time, meta);

            const textForm = document.createElement("form");
            textForm.className = "transcript-edit-form";
            const text = document.createElement("textarea");
            text.rows = 3;
            text.maxLength = 20000;
            text.value = record.text || "";
            text.setAttribute("aria-label", `Transcript text at ${time.textContent}`);
            const saveText = document.createElement("button");
            saveText.className = "button button-quiet";
            saveText.type = "submit";
            saveText.textContent = "Save correction";
            textForm.append(text, saveText);
            textForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                try {
                    await runWriteCommand(["transcript", "correct", String(record.id), "--text", text.value]);
                    showNotice("Transcript correction saved in the portable archive.");
                } catch (error) {
                    showNotice(error.message, true);
                }
            });

            const timestampForm = document.createElement("form");
            timestampForm.className = "timestamp-edit-form";
            const start = document.createElement("input");
            start.value = formatTimestamp(record.start_time_us);
            start.inputMode = "numeric";
            start.setAttribute("aria-label", "Segment start timestamp");
            const end = document.createElement("input");
            end.value = formatTimestamp(record.end_time_us);
            end.inputMode = "numeric";
            end.setAttribute("aria-label", "Segment end timestamp");
            const saveTime = document.createElement("button");
            saveTime.className = "button button-outline";
            saveTime.type = "submit";
            saveTime.textContent = "Save timestamps";
            timestampForm.append(start, end, saveTime);
            timestampForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                try {
                    await runWriteCommand([
                        "transcript", "timestamp", String(record.id),
                        "--start", start.value, "--end", end.value,
                    ]);
                    showNotice("Transcript timestamps saved in the portable archive.");
                } catch (error) {
                    showNotice(error.message, true);
                }
            });

            const speakerForm = document.createElement("form");
            speakerForm.className = "speaker-edit-form";
            const speaker = document.createElement("input");
            speaker.value = record.speaker_label || record.speaker_name || "";
            speaker.maxLength = 256;
            speaker.placeholder = "Speaker label";
            speaker.setAttribute("aria-label", "Speaker label");
            const saveSpeaker = document.createElement("button");
            saveSpeaker.className = "button button-outline";
            saveSpeaker.type = "submit";
            saveSpeaker.textContent = "Save speaker";
            speakerForm.append(speaker, saveSpeaker);
            speakerForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                try {
                    await runWriteCommand([
                        "transcript", "speaker", String(record.id), "--name", speaker.value.trim(),
                    ]);
                    showNotice("Transcript speaker label saved.");
                } catch (error) {
                    showNotice(error.message, true);
                }
            });

            const verify = document.createElement("button");
            verify.className = "text-button";
            verify.type = "button";
            verify.textContent = record.verification_state === "human-verified" ? "Verified" : "Mark verified";
            verify.disabled = record.verification_state === "human-verified";
            verify.addEventListener("click", async () => {
                try {
                    await runWriteCommand(["transcript", "verify", String(record.id)]);
                    showNotice("Transcript segment marked as tutor-verified.");
                } catch (error) {
                    showNotice(error.message, true);
                }
            });

            const playAudio = document.createElement("button");
            playAudio.className = "text-button";
            playAudio.type = "button";
            playAudio.textContent = "Play from timestamp";
            playAudio.disabled = !activeArchivePath || archiveRecoveryNeedsReview || !activeSessionHasAudio;
            playAudio.addEventListener("click", async () => {
                await playSessionFromTimestamp(
                    sessionId,
                    record.start_time_us,
                    "this transcript timestamp",
                );
            });

            const addToNotes = document.createElement("button");
            addToNotes.className = "text-button";
            addToNotes.type = "button";
            addToNotes.textContent = "Add passage to entry notes";
            addToNotes.addEventListener("click", () => {
                const selected = text.value.slice(text.selectionStart, text.selectionEnd).trim();
                window.dispatchEvent(new CustomEvent("tutorux:add-passage", {
                    detail: {
                        text: selected || text.value,
                        speaker: record.speaker_label || record.speaker_name || "",
                        timestamp: formatTimestamp(record.start_time_us),
                    },
                }));
            });

            row.append(heading, playAudio, addToNotes, textForm, timestampForm, speakerForm, verify);
            container.append(row);
        }
    }

    function renderAssets(records: any[]): void {
        const container = elements["assets-list"] as HTMLElement;
        container.replaceChildren();
        if (records.length === 0) {
            container.append(makeEmptyRow("No files or media are linked to this session."));
            return;
        }
        for (const record of records) {
            const row = document.createElement("article");
            row.className = "material-row asset-row";
            const heading = document.createElement("div");
            heading.className = "material-row-heading";
            const title = document.createElement("strong");
            title.textContent = record.filename || "Imported file";
            const size = document.createElement("span");
            const byteSize = Number(record.byte_size);
            size.textContent = Number.isFinite(byteSize)
                ? byteSize < 1024
                    ? `${byteSize} B`
                    : byteSize < 1024 * 1024
                        ? `${(byteSize / 1024).toFixed(1)} KiB`
                        : `${(byteSize / (1024 * 1024)).toFixed(1)} MiB`
                : "Archive asset";
            heading.append(title, size);
            const meta = document.createElement("span");
            meta.className = "material-meta";
            meta.textContent = `${record.media_type || "Unknown file type"} · SHA-256 ${record.content_hash || "not listed"}`;
            const actions = document.createElement("div");
            actions.className = "form-actions asset-actions";
            const verify = document.createElement("button");
            verify.className = "text-button";
            verify.type = "button";
            verify.textContent = "Verify content";
            verify.addEventListener("click", async () => {
                try {
                    const response = await responseFrom(archiveArguments(["asset", "verify", String(record.id)]));
                    const report = parseRecord(response.output);
                    showNotice(report?.valid === "true" || report?.valid === true ? "Asset content hash is valid." : "Asset verification completed.");
                } catch (error) {
                    showNotice(error.message, true);
                }
            });
            const download = document.createElement("button");
            download.className = "text-button";
            download.type = "button";
            download.textContent = "Download file";
            download.addEventListener("click", async () => {
                const filename = String(record.filename || "tutorux-asset").replace(/[\\/\0]/g, "_").replace(/^\.+/, "_");
                const outputPath = `/workspace/asset-export-${record.id}-${filename}`;
                try {
                    await responseFrom(archiveArguments(["asset", "extract", String(record.id), "--output", outputPath]));
                    const file = await requestWorker("read-file", { path: outputPath });
                    downloadFileBytes(file.bytes, filename, record.media_type || "application/octet-stream");
                    showNotice(`Downloaded ${filename} from the portable archive.`);
                } catch (error) {
                    showNotice(error.message, true);
                } finally {
                    requestWorker("remove-file", { path: outputPath }).catch(() => {});
                }
            });
            actions.append(verify, download);
            row.append(heading, meta, actions);
            container.append(row);
        }
    }

    function renderRecordingTracks(tracks: any[]): void {
        const select = elements["recording-track-select"] as HTMLSelectElement;
        const list = elements["recording-tracks-list"] as HTMLElement;
        if (!select || !list) return;
        const previousSelection = select.value;
        select.replaceChildren(new Option("Automatic track selection", ""));
        list.replaceChildren();
        activeSessionTracks = tracks.filter((track) => track.record_role === "audio-track" && track.id);
        for (const track of activeSessionTracks) {
            const trackId = String(track.id);
            const source = track.source || "audio";
            const label = `${source[0].toUpperCase()}${source.slice(1)} · ${track.state || "saved"}`;
            select.append(new Option(label, trackId));
            const row = document.createElement("article");
            row.className = "recording-track-row";
            const title = document.createElement("strong");
            title.textContent = label;
            const detail = document.createElement("span");
            const chunks = Number(track.chunk_count || 0);
            const duration = Number(track.duration_us || 0);
            const bytes = Number(track.byte_count || 0);
            const parts: string[] = [];
            if (Number.isFinite(chunks) && chunks > 0) parts.push(`${chunks.toLocaleString()} audio chunk(s)`);
            if (Number.isFinite(duration) && duration > 0) {
                parts.push(`${(duration / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} seconds`);
            }
            if (Number.isFinite(bytes) && bytes > 0) parts.push(`${bytes.toLocaleString()} bytes`);
            detail.textContent = parts.length ? parts.join(" · ") : `Track ${trackId}`;
            const play = document.createElement("button");
            play.className = "text-button";
            play.type = "button";
            play.textContent = "Play this track";
            play.setAttribute("aria-label", `Play ${label} from the beginning`);
            play.disabled = !activeArchivePath || archiveRecoveryNeedsReview;
            play.addEventListener("click", () => {
                void playSessionFromTimestamp(activeSessionId, 0, `${label} from the beginning`, trackId);
            });
            row.append(title, detail, play);
            list.append(row);
        }
        if (activeSessionTracks.length === 0)
            list.append(makeEmptyRow("No individual recording tracks are stored in this session."));
        select.value = activeSessionTracks.some((track) => String(track.id) === previousSelection)
            ? previousSelection
            : "";
        select.disabled = !activeArchivePath || archiveRecoveryNeedsReview || activeSessionTracks.length < 2;
    }

    async function loadSessionWorkspace(sessionId: string): Promise<void> {
        const sessionChanged = activeSessionId !== sessionId;
        activeSessionId = sessionId;
        activeSessionHasAudio = false;
        updateBrowserRecordingControls();
        if (!sessionId) {
            renderAnnotations([]);
            activeSessionAssets = [];
            activeSessionEvidence = [];
            activeSessionTracks = [];
            elements["transcript-list"].replaceChildren(makeEmptyRow("Choose a session to view transcript segments."));
            elements["recording-import-status"].textContent =
                "Choose a session to view or import its recording.";
            elements["recording-tracks-list"].replaceChildren(makeEmptyRow("Choose a session to view its recording tracks."));
            elements["recording-track-select"].replaceChildren(new Option("Automatic track selection", ""));
            elements["recording-track-select"].disabled = true;
            elements["edit-session-title"].value = "";
            elements["edit-session-subject"].value = "";
            return;
        }
        if (sessionChanged) elements["recording-track-select"].value = "";
        const [sessionResponse, annotationsResponse, transcriptResponse, assetsResponse, evidenceResponse, tracksResponse] = await Promise.all([
            responseFrom(archiveArguments(["session", "show", sessionId])),
            responseFrom(archiveArguments(["annotation", "list", "--session", sessionId])),
            responseFrom(archiveArguments(["transcript", "show", "--session", sessionId])),
            responseFrom(archiveArguments(["asset", "list", "--session", sessionId])),
            responseFrom(archiveArguments(["evidence", "list", "--session", sessionId])),
            responseFrom(archiveArguments(["record", "status", "--session", sessionId])),
        ]);
        const session = parseRecord(sessionResponse.output);
        const trackReport = parseRecord(tracksResponse.output);
        const recordingTracks = Array.isArray(trackReport?.tracks) ? trackReport.tracks : [];
        const sessionAssets = parseRows(assetsResponse.output);
        activeSessionAssets = [
            ...sessionAssets,
            ...recordingTracks.filter((track: any) => track.record_role === "audio-track"),
        ];
        activeSessionEvidence = parseRows(evidenceResponse.output);
        activeSessionHasAudio = session?.has_audio === true ||
            String(session?.has_audio || "").toLowerCase() === "true" ||
            Number(session?.audio_chunks_imported || 0) > 0 ||
            Number(session?.recording_audio_chunks || 0) > 0 ||
            Number(session?.recording_duration_us || 0) > 0 ||
            Number(session?.audio_duration_us || 0) > 0 || recordingTracks.length > 0;
        elements["edit-session-title"].value = session?.title || "";
        elements["edit-session-subject"].value = session?.subject || "";
        const audioImportState = session?.audio_import_state || "not-imported";
        const audioChunks = session?.audio_chunks_imported || "0";
        const audioBytes = Number(session?.audio_import_bytes || 0);
        elements["recording-import-status"].textContent = audioImportState === "not-imported"
            ? "No WAV recording has been imported into this session."
            : `Imported audio: ${audioImportState} · ${audioChunks} chunk(s) · ${Number.isFinite(audioBytes) ? audioBytes.toLocaleString() : "0"} bytes.`;
        renderRecordingTracks(recordingTracks);
        renderAnnotations(parseRows(annotationsResponse.output));
        renderTranscript(parseRows(transcriptResponse.output));
        renderAssets(sessionAssets);
    }

    async function playSessionFromTimestamp(
        sessionId: string,
        startTimeUs: string | number,
        description: string,
        trackId = "",
    ): Promise<void> {
        if (!sessionId) {
            showNotice("Choose a session before playing a marker.", true);
            return;
        }
        if (!activeSessionHasAudio) {
            showNotice("This session has no recorded audio to play.", true);
            return;
        }
        primeBrowserPlayback();
        try {
            const command = [
                "record", "play", "--session", sessionId,
                "--start-us", String(startTimeUs || 0),
                "--duration-us", "30000000",
            ];
            const selectedTrackId = trackId || elements["recording-track-select"]?.value || "";
            if (selectedTrackId) command.push("--track", selectedTrackId);
            await responseFrom(archiveArguments(command));
            showNotice(`Audio playback finished from ${description}.`);
        } catch (error) {
            showNotice(error.message, true);
        }
    }

    function guideSectionValues(guide: any): any[] {
        const sections: any[] = [];
        const sectionCount = Math.min(10000, Number.parseInt(guide.section_count || "0", 10) || 0);
        for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
            const sectionPrefix = `section.${sectionIndex}.`;
            const section: any = {
                id: guide[`${sectionPrefix}id`] || "",
                heading: guide[`${sectionPrefix}heading`] || "Untitled section",
                blocks: [],
            };
            const blockCount = Math.min(10000, Number.parseInt(guide[`${sectionPrefix}block_count`] || "0", 10) || 0);
            for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
                const blockPrefix = `${sectionPrefix}block.${blockIndex}.`;
                section.blocks.push({
                    kind: guide[`${blockPrefix}kind`] || "paragraph",
                    text: guide[`${blockPrefix}text`] || "",
                    sourceIds: guide[`${blockPrefix}source_ids`] || "",
                    stale: guide[`${blockPrefix}stale`] === "true",
                });
            }
            sections.push(section);
        }
        return sections;
    }

    async function loadGuide(guideId: string): Promise<void> {
        activeGuideId = guideId;
        const editor = elements["guide-editor"] as HTMLElement;
        if (!guideId) {
            editor.hidden = true;
            return;
        }
        const response = await responseFrom(archiveArguments(["guide", "show", guideId]));
        const guide = parseRecord(response.output);
        if (!guide) throw new Error("The guide command returned an unreadable record.");
        editor.hidden = false;
        elements["guide-title"].value = guide.title || "";
        elements["guide-approve"].disabled = guide.approval_state === "approved";
        const container = elements["guide-sections"] as HTMLElement;
        container.replaceChildren();
        const sections = guideSectionValues(guide);
        if (sections.length === 0) {
            container.append(makeEmptyRow("This guide has no sections yet."));
            return;
        }
        for (const [sectionIndex, section] of sections.entries()) {
            const sectionElement = document.createElement("section");
            sectionElement.className = "guide-section-card";
            const heading = document.createElement("h3");
            heading.textContent = `${sectionIndex + 1}. ${section.heading}`;
            const headingForm = document.createElement("form");
            headingForm.className = "guide-section-heading-form";
            const headingInput = document.createElement("input");
            headingInput.maxLength = 256;
            headingInput.value = section.heading;
            headingInput.setAttribute("aria-label", `Section ${sectionIndex + 1} heading`);
            const saveHeading = document.createElement("button");
            saveHeading.className = "button button-outline";
            saveHeading.type = "submit";
            saveHeading.textContent = "Save heading";
            headingForm.append(headingInput, saveHeading);
            headingForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                try {
                    await runWriteCommand([
                        "guide", "edit", guideId,
                        "--section-index", String(sectionIndex),
                        "--heading", headingInput.value.trim(),
                    ]);
                    await loadGuide(guideId);
                    showNotice("Guide section heading saved as a new revision.");
                } catch (error) {
                    showNotice(error.message, true);
                }
            });
            sectionElement.append(heading, headingForm);
            if (section.blocks.length === 0) {
                sectionElement.append(makeEmptyRow("No content in this section."));
            }
            for (const [blockIndex, block] of section.blocks.entries()) {
                const blockForm = document.createElement("form");
                blockForm.className = "guide-block-form";
                const blockMeta = document.createElement("div");
                blockMeta.className = "material-row-heading";
                const kind = document.createElement("span");
                kind.textContent = block.kind === "instruction" ? "Tutor instruction" : block.kind === "recommendation" ? "AI recommendation" : block.kind;
                const state = document.createElement("span");
                state.className = block.stale ? "stale-state" : "material-meta";
                state.textContent = block.stale ? "Source changed · review required" : "Source-linked draft";
                blockMeta.append(kind, state);
                const text = document.createElement("textarea");
                text.rows = Math.min(12, Math.max(3, Math.ceil((block.text.length || 1) / 95)));
                text.maxLength = 50000;
                text.value = block.text;
                text.setAttribute("aria-label", `Section ${sectionIndex + 1}, block ${blockIndex + 1}`);
                const sources = document.createElement("div");
                sources.className = "source-list";
                sources.textContent = block.sourceIds ? `Sources: ${block.sourceIds}` : "No source links";
                const sourceIds = document.createElement("input");
                sourceIds.maxLength = 20000;
                sourceIds.value = block.sourceIds;
                sourceIds.placeholder = "Source record IDs, separated by commas";
                sourceIds.setAttribute("aria-label", `Source IDs for section ${sectionIndex + 1}, block ${blockIndex + 1}`);
                const save = document.createElement("button");
                save.className = "button button-outline";
                save.type = "submit";
                save.value = "save";
                save.textContent = "Save block";
                const markReviewed = document.createElement("button");
                markReviewed.className = "button button-quiet";
                markReviewed.type = "submit";
                markReviewed.value = "review";
                markReviewed.textContent = "Mark reviewed";
                blockForm.append(blockMeta, text, sources, sourceIds, save, markReviewed);
                blockForm.addEventListener("submit", async (event) => {
                    event.preventDefault();
                    try {
                        const reviewOnly = (event as SubmitEvent).submitter?.value === "review";
                        const command = [
                            "guide", "edit", guideId,
                            "--section-index", String(sectionIndex),
                            "--block-index", String(blockIndex),
                        ];
                        if (reviewOnly) command.push("--mark-reviewed");
                        else command.push("--text", text.value, "--sources", sourceIds.value.trim());
                        await runWriteCommand(command);
                        await loadGuide(guideId);
                        showNotice(reviewOnly ? "Guide block marked reviewed." : "Guide block and source links saved as a new revision.");
                    } catch (error) {
                        showNotice(error.message, true);
                    }
                });
                sectionElement.append(blockForm);
            }
            container.append(sectionElement);
        }
    }

    async function refreshWorkspace() {
        if (!activeArchivePath) {
            return;
        }
        const studentsResponse = await responseFrom(archiveArguments(["student", "list"]));
        const sessionsResponse = await responseFrom(archiveArguments(["session", "list"]));
        const guideResponse = await responseFrom(archiveArguments(["guide", "list"]));
        const students = parseRows(studentsResponse.output);
        sessionRecords = parseRows(sessionsResponse.output);
        guideRecords = parseRows(guideResponse.output);
        const selectedAiSessionId = elements["ai-package-session"].value || activeSessionId;
        elements.studentCount.textContent = String(students.length);
        elements.sessionCount.textContent = String(sessionRecords.length);
        renderRows(elements.studentsList, students, "No students have been added yet.", (record) => {
            const grade = record.grade ? `Grade ${record.grade}` : "Student profile";
            return `${grade} · ${record.id || ""}`;
        });
        renderRows(elements.sessionsList, sessionRecords, "No tutoring sessions have been created yet.", (record) => {
            return `${record.subject || "Tutoring session"} · ${record.id || ""}`;
        }, "Open", (record) => {
            if (record.entry_id) {
                window.dispatchEvent(new CustomEvent("tutorux:open-entry", {
                    detail: { entryId: String(record.entry_id), sessionId: String(record.id || "") },
                }));
                return;
            }
            elements["active-session"].value = String(record.id || "");
            switchView("sessions");
            loadSessionWorkspace(String(record.id || "")).catch((error) => showNotice(error.message, true));
        });
        renderRows(elements.recentSessions, sessionRecords.slice(0, 5), "No recent sessions.", (record) => {
            return `${record.subject || "Tutoring session"} · ${record.id || ""}`;
        }, "Open", (record) => {
            if (record.entry_id) {
                window.dispatchEvent(new CustomEvent("tutorux:open-entry", {
                    detail: { entryId: String(record.entry_id), sessionId: String(record.id || "") },
                }));
                return;
            }
            switchView("sessions");
            elements["active-session"].value = String(record.id || "");
            loadSessionWorkspace(String(record.id || "")).catch((error) => showNotice(error.message, true));
        });
        renderRows(elements.guidesList, guideRecords, "No study guides are available in this archive.", (record) => {
            return `${record.approval_state || "Draft"} · ${record.stale_block_count || "0"} stale blocks · ${record.id || ""}`;
        }, "Review", (record) => {
            elements["active-guide"].value = String(record.id || "");
            loadGuide(String(record.id || "")).catch((error) => showNotice(error.message, true));
        });
        fillSelect(elements["active-session"], sessionRecords, "Choose a session", activeSessionId);
        fillSelect(elements["guide-session"], sessionRecords, "Choose a session");
        fillSelect(
            elements["ai-package-session"],
            sessionRecords,
            "Choose a session",
            selectedAiSessionId,
        );
        fillSelect(elements["active-guide"], guideRecords, "Choose a guide", activeGuideId);
        if (activeSessionId && sessionRecords.some((record) => String(record.id) === activeSessionId)) {
            elements["active-session"].value = activeSessionId;
        }
    }

    async function runWriteCommand(
        commandArguments,
        { showSuccessNotice = true, requireBrowserPersistence = false } = {},
    ) {
        if (archiveRecoveryNeedsReview) {
            throw new Error("Review archive recovery before editing this workspace.");
        }
        const response = await responseFrom(archiveArguments(commandArguments));
        setDirty(true);
        await refreshWorkspace();
        if (activeSessionId) await loadSessionWorkspace(activeSessionId);
        try {
            await persistBrowserArchive();
            if (showSuccessNotice) {
                showNotice(response.output || "Changes saved to this browser's archive copy.");
            }
        } catch (error) {
            if (requireBrowserPersistence) throw error;
            showNotice(`Changes are in memory but browser storage failed: ${error.message}`, true);
        }
        window.dispatchEvent(new CustomEvent("tutorux:archive-change"));
        return response;
    }

    function beginCreateArchive(): void {
        if (dirty) {
            showNotice("Save or download the current archive before creating another one.", true);
            return;
        }
        elements["new-archive-name"].value = "Tutorux";
        elements["archive-create-dialog"].showModal();
        elements["new-archive-name"].focus();
    }

    async function createArchive(name: string): Promise<void> {
        if (browserRecordingNode || browserRecordingSaving || browserRecordingRecoveryPaths.length > 0) {
            throw new Error("Save or download the active microphone recovery before creating another archive.");
        }
        const displayName = name.trim().replace(/[\\/\0]/g, "_").replace(/\.tux$/i, "") || "Tutorux";
        const archiveName = `${displayName}.tux`;
        const path = `/workspace/${archiveName}`;
        await responseFrom(
            ["archive", "init", path, "--name", displayName, "--json"],
            { synchronizeArchive: false },
        );
        setArchive(path, archiveName, null, false);
        activeSessionId = "";
        activeGuideId = "";
        await refreshArchiveRecovery();
        await refreshWorkspace();
        window.dispatchEvent(new CustomEvent("tutorux:archive-open"));
        setDirty(true);
        try {
            await persistBrowserArchive();
            showNotice(`Created ${archiveName}. Download the .tux archive to keep an independent copy.`);
        } catch (error) {
            setStorageStatus("Browser recovery storage unavailable", `The archive exists in this page, but IndexedDB could not retain it: ${error.message}. Download a portable copy before closing this page.`, false);
            showNotice(`Archive created, but browser recovery storage failed: ${error.message}`, true);
        }
    }

    async function openArchive(file, handle = null) {
        if (browserRecordingNode || browserRecordingSaving || browserRecordingRecoveryPaths.length > 0) {
            throw new Error("Save or download the active microphone recovery before opening another archive.");
        }
        if (dirty) {
            throw new Error("Save or download the current archive before opening another one.");
        }
        const safeName = file.name.replace(/[\\/\0]/g, "_").replace(/^\.+/, "_") || "Tutorux.tux";
        const path = `/workspace/${safeName}`;
        archivePassphrase = "";
        newArchivePassphrase = "";
        const bytes = await file.arrayBuffer();
        await requestWorker("write-file", { path, bytes }, [bytes]);
        activeArchivePath = path;
        activeArchiveName = safeName;
        sourceFileHandle = handle;
        try {
            await responseFrom(
                ["--archive", activeArchivePath, "archive", "verify", "--json"],
                { synchronizeArchive: false },
            );
        } catch (error) {
            if (error.code !== "archive_locked") throw error;
            archivePassphrase = await requestArchivePassphrase();
            await responseFrom(
                ["--archive", activeArchivePath, "archive", "verify", "--json"],
                { synchronizeArchive: false },
            );
        }
        setArchive(path, safeName, handle, false);
        activeSessionId = "";
        activeGuideId = "";
        await refreshArchiveRecovery();
        setDirty(false);
        await refreshWorkspace();
        window.dispatchEvent(new CustomEvent("tutorux:archive-open"));
        await persistBrowserArchive();
        showNotice(`Opened ${safeName}. Changes are retained by this browser; download the .tux archive for independent storage.`);
        if (archiveRecoveryNeedsReview) {
            showNotice("The archive needs recovery review before editing. Choose a verified recovery or explicitly discard the incomplete tail.", true);
        }
    }

    function switchView(viewName: string): void {
        for (const view of views) {
            view.classList.toggle("is-visible", view.dataset.panel === viewName);
        }
        for (const button of document.querySelectorAll("[data-view]")) {
            button.classList.toggle("is-active", button.dataset.view === viewName);
        }
    }

    async function chooseArchive() {
        if (browserRecordingNode || browserRecordingSaving || browserRecordingRecoveryPaths.length > 0) {
            showNotice("Stop and save the microphone recording or download its recovery before opening another archive.", true);
            return;
        }
        if (dirty) {
            showNotice("Save or download the current archive before opening another one.", true);
            return;
        }
        if (window.showOpenFilePicker) {
            const [handle] = await window.showOpenFilePicker({
                multiple: false,
                types: [
                    {
                        description: "Tutorux portable archive",
                        accept: { "application/octet-stream": [".tux"] },
                    },
                ],
            });
            const file = await handle.getFile();
            await openArchive(file, handle);
            return;
        }
        elements.archiveFile.click();
    }

    function requestArchivePassphrase(): Promise<string> {
        const dialog = elements.passphraseDialog;
        const form = elements.passphraseForm;
        const input = elements.passphraseInput;
        return new Promise((resolve, reject) => {
            const onClose = () => {
                dialog.removeEventListener("close", onClose);
                const value = dialog.returnValue;
                const passphrase = input.value;
                input.value = "";
                elements.newPassphraseInput.value = "";
                if (value === "unlock" && passphrase.length > 0) resolve(passphrase);
                else reject(new Error("Archive unlock was cancelled."));
            };
            dialog.addEventListener("close", onClose, { once: true });
            form.addEventListener("submit", (event) => {
                event.preventDefault();
                dialog.close("unlock");
            }, { once: true });
            dialog.showModal();
            input.focus();
        });
    }

    elements.setPassphrase.addEventListener("click", () => {
        const dialog = elements.passphraseDialog;
        const form = elements.passphraseForm;
        const input = elements.passphraseInput;
        input.required = false;
        input.value = archivePassphrase;
        elements.newPassphraseInput.value = newArchivePassphrase;
        const onClose = () => {
            dialog.removeEventListener("close", onClose);
            input.required = true;
            if (dialog.returnValue === "set") {
                archivePassphrase = input.value;
                newArchivePassphrase = elements.newPassphraseInput.value;
                showNotice("Passphrases are held in memory for archive commands until this page closes.");
            }
            input.value = "";
            elements.newPassphraseInput.value = "";
        };
        dialog.addEventListener("close", onClose, { once: true });
        elements.passphraseSetAction.onclick = () => dialog.close("set");
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            dialog.close("unlock");
        }, { once: true });
        dialog.showModal();
        input.focus();
    });

    elements.openArchive.addEventListener("click", () => {
        chooseArchive().catch((error) => {
            if (error.name !== "AbortError") showNotice(error.message, true);
        });
    });
    elements["archive-recover-unpublished"].addEventListener("click", () => {
        void performArchiveRecovery("recover-unpublished");
    });
    elements["archive-discard-tail"].addEventListener("click", () => {
        void performArchiveRecovery("discard-tail");
    });
    document.getElementById("welcome-open").addEventListener("click", () => {
        chooseArchive().catch((error) => {
            if (error.name !== "AbortError") showNotice(error.message, true);
        });
    });
    elements.createArchive.addEventListener("click", beginCreateArchive);
    document.getElementById("welcome-create").addEventListener("click", beginCreateArchive);
    elements["archive-create-form"].addEventListener("submit", (event) => {
        event.preventDefault();
        const name = elements["new-archive-name"].value;
        elements["archive-create-dialog"].close("create");
        createArchive(name).catch((error) => showNotice(error.message, true));
    });
    elements.saveArchive.addEventListener("click", () => {
        saveArchive().catch((error) => showNotice(error.message, true));
    });
    elements.archiveFile.addEventListener("change", (event) => {
        const [file] = event.currentTarget.files;
        if (file) {
            openArchive(file).catch((error) => showNotice(error.message, true));
        }
    });

    elements.studentForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            const name = elements.studentName.value.trim();
            const grade = elements.studentGrade.value.trim();
            await runWriteCommand([
                "student",
                "create",
                "--name",
                name,
                ...(grade ? ["--grade", grade] : []),
            ]);
            elements.studentForm.reset();
        } catch (error) {
            showNotice(error.message, true);
        }
    });

    elements.sessionForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            const title = elements.sessionTitle.value.trim();
            const subject = elements.sessionSubject.value.trim();
            const studentId = elements.sessionStudent.value.trim();
            const response = await responseFrom(archiveArguments([
                "session",
                "create",
                "--title",
                title,
                ...(subject ? ["--subject", subject] : []),
                ...(studentId ? ["--student-id", studentId] : []),
            ]));
            const createdSession = parseRecord(response.output);
            if (createdSession?.id) activeSessionId = createdSession.id;
            setDirty(true);
            await refreshWorkspace();
            if (activeSessionId) {
                elements["active-session"].value = activeSessionId;
                await loadSessionWorkspace(activeSessionId);
            }
            await persistBrowserArchive();
            elements.sessionForm.reset();
        } catch (error) {
            showNotice(error.message, true);
        }
    });

    elements["active-session"].addEventListener("change", () => {
        loadSessionWorkspace(elements["active-session"].value).catch((error) => showNotice(error.message, true));
    });

    elements["browser-recording-consent"].addEventListener("change", updateBrowserRecordingControls);
    elements["notice-dismiss"].addEventListener("click", () => {
        window.clearTimeout(noticeTimer);
        elements.notice.hidden = true;
    });
    elements["browser-recording-start"].addEventListener("click", () => {
        startBrowserRecording().catch((error) => {
            browserRecordingStream?.getTracks().forEach((track) => track.stop());
            browserRecordingStream = null;
            browserRecordingNode?.disconnect();
            browserRecordingNode = null;
            browserRecordingSource?.disconnect();
            browserRecordingSource = null;
            if (browserRecordingContext) void browserRecordingContext.close().catch(() => {});
            browserRecordingContext = null;
            if (browserRecordingPath) requestWorker("remove-file", { path: browserRecordingPath }).catch(() => {});
            browserRecordingPath = "";
            browserRecordingBytes = 0;
            browserRecordingSampleRateHz = 0;
            browserRecordingSegmentFrames = 0;
            browserRecordingPendingFrames = 0;
            browserRecordingTotalFrames = 0;
            browserRecordingSegmentIndex = 0;
            browserRecordingImportedSegments = 0;
            browserRecordingWriteFailure = null;
            browserRecordingSessionId = "";
            browserRecordingConsentAtUs = 0;
            elements["browser-recording-consent"].checked = false;
            elements["browser-recording-status"].textContent = error.message;
            updateBrowserRecordingControls();
            showNotice(error.message, true);
        });
    });
    elements["browser-recording-stop"].addEventListener("click", () => {
        stopBrowserRecording();
    });
    elements["browser-recording-recover"].addEventListener("click", async () => {
        if (browserRecordingRecoveryPaths.length === 0) return;
        try {
            while (browserRecordingRecoveryPaths.length > 0) {
                const path = browserRecordingRecoveryPaths[0];
                const recovery = await requestWorker("read-file", { path });
                const name = path.split("/").pop() || `tutorux-recording-recovery-${Date.now()}.wav`;
                downloadFileBytes(recovery.bytes, name, "audio/wav");
                await requestWorker("remove-file", { path });
                browserRecordingRecoveryPaths.shift();
            }
            elements["browser-recording-recover"].hidden = true;
            updateBrowserRecordingControls();
            showNotice("Downloaded the recovered WAV microphone recording segments.");
        } catch (error) {
            showNotice(`Recovery WAVs are still available in this page: ${error.message}`, true);
        }
    });
    elements["browser-playback-stop"].addEventListener("click", stopBrowserPlayback);
    elements["annotation-marker-select"].addEventListener("change", () => {
        elements["annotation-marker-jump"].disabled =
            !activeArchivePath || archiveRecoveryNeedsReview ||
            !elements["annotation-marker-select"].value;
    });
    elements["annotation-marker-jump"].addEventListener("click", () => {
        const markerId = elements["annotation-marker-select"].value;
        const marker = [...elements["annotations-list"].querySelectorAll<HTMLElement>("[data-annotation-id]")]
            .find((row) => row.dataset.annotationId === markerId);
        if (!marker) return;
        marker.scrollIntoView({ block: "center", behavior: "smooth" });
        marker.focus({ preventScroll: true });
    });
    window.addEventListener("beforeunload", (event) => {
        if (!browserRecordingNode && !browserRecordingSaving && browserRecordingRecoveryPaths.length === 0) return;
        event.preventDefault();
        event.returnValue = "";
    });

    elements["session-update-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!activeSessionId) return;
        try {
            await runWriteCommand([
                "session", "update", activeSessionId,
                "--title", elements["edit-session-title"].value.trim(),
                "--subject", elements["edit-session-subject"].value.trim(),
            ]);
            showNotice("Session details saved in the portable archive.");
        } catch (error) {
            showNotice(error.message, true);
        }
    });

    elements["annotation-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!activeSessionId) {
            showNotice("Choose a session before adding a note.", true);
            return;
        }
        const annotationId = elements["annotation-id"].value;
        const commandArguments = annotationId
            ? [
                "annotation", "update", annotationId,
                "--title", elements["annotation-title"].value.trim(),
                "--type", elements["annotation-type"].value,
                "--at", elements["annotation-time"].value.trim(),
                "--priority", elements["annotation-priority"].value,
                "--text", elements["annotation-content"].value.trim(),
            ]
            : [
                "annotation", "add",
                "--session", activeSessionId,
                "--type", elements["annotation-type"].value,
                "--at", elements["annotation-time"].value.trim(),
                "--priority", elements["annotation-priority"].value,
                "--title", elements["annotation-title"].value.trim(),
                "--text", elements["annotation-content"].value.trim(),
            ];
        try {
            await runWriteCommand(commandArguments);
            resetAnnotationForm();
        } catch (error) {
            showNotice(error.message, true);
        }
    });

    function resetAnnotationForm(): void {
        elements["annotation-form"].reset();
        elements["annotation-id"].value = "";
        elements["annotation-type"].value = "general-note";
        elements["annotation-priority"].value = "normal";
        elements["annotation-save"].textContent = "Save note";
        elements["annotation-cancel"].hidden = true;
    }

    elements["annotation-cancel"].addEventListener("click", resetAnnotationForm);
    elements["annotation-merge-select"].addEventListener("change", updateAnnotationMergeSubmit);
    elements["annotation-merge-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        const select = elements["annotation-merge-select"] as HTMLSelectElement;
        const submit = elements["annotation-merge-submit"] as HTMLButtonElement;
        const selectedOptions = [...select.selectedOptions];
        if (selectedOptions.length < 2 || submit.disabled) {
            showNotice("Choose two or more notes with matching type and priority to merge.", true);
            return;
        }
        const separatorChoice = (elements["annotation-merge-separator"] as HTMLSelectElement).value;
        const separator = separatorChoice === "paragraph"
            ? "\n\n"
            : separatorChoice === "line" ? "\n" : " ";
        try {
            await runWriteCommand([
                "annotation", "merge",
                ...selectedOptions.map((option) => option.value),
                "--separator", separator,
            ]);
            select.selectedIndex = -1;
            updateAnnotationMergeSubmit();
        } catch (error: any) {
            showNotice(error.message, true);
        }
    });

    elements["transcript-import-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        const file = elements["transcript-file"].files?.[0];
        if (!activeSessionId || !file) {
            showNotice("Choose a session and a transcript file first.", true);
            return;
        }
        if (file.size > 64 * 1024 * 1024) {
            showNotice("Browser transcript imports are limited to 64 MiB per file.", true);
            return;
        }
        const importPath = `/workspace/transcript-import-${Date.now()}-${file.name.replace(/[\\/\0]/g, "_")}`;
        try {
            const bytes = await file.arrayBuffer();
            await requestWorker("write-file", { path: importPath, bytes }, [bytes]);
            await runWriteCommand([
                "transcript", "import",
                "--session", activeSessionId,
                "--input", importPath,
                "--format", elements["transcript-format"].value,
            ]);
            elements["transcript-import-form"].reset();
        } catch (error) {
            showNotice(error.message, true);
        } finally {
            requestWorker("remove-file", { path: importPath }).catch(() => {});
        }
    });

    elements["transcript-export-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!activeSessionId) {
            showNotice("Choose a session before downloading its transcript.", true);
            return;
        }
        const format = elements["transcript-export-format"].value;
        const extension = format === "text" ? "txt" : format;
        const filename = `tutorux-session-${activeSessionId}-transcript.${extension}`;
        const outputPath = `/workspace/${filename}`;
        try {
            await responseFrom(archiveArguments([
                "transcript", "export",
                "--session", activeSessionId,
                "--format", format,
                "--output", outputPath,
            ]));
            const file = await requestWorker("read-file", { path: outputPath });
            const mediaType = format === "json"
                ? "application/json"
                : format === "vtt"
                    ? "text/vtt"
                    : format === "srt"
                        ? "application/x-subrip"
                        : "text/plain";
            downloadFileBytes(file.bytes, filename, mediaType);
            showNotice(`Downloaded the session transcript as ${format.toUpperCase()}.`);
        } catch (error) {
            showNotice(error.message, true);
        } finally {
            requestWorker("remove-file", { path: outputPath }).catch(() => {});
        }
    });

    elements["recording-import-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        const file = elements["recording-file"].files?.[0];
        if (!activeSessionId || !file) {
            showNotice("Choose a session and a WAV recording first.", true);
            return;
        }
        if (!file.name.toLowerCase().endsWith(".wav")) {
            showNotice("Recording import currently accepts WAV files only.", true);
            return;
        }
        if (file.size > 64 * 1024 * 1024) {
            showNotice("Browser recording imports are limited to 64 MiB per file.", true);
            return;
        }

        const safeName = file.name
            .replace(/[\\/\0]/g, "_")
            .replace(/^\.+/, "_");
        const inputPath = `/workspace/recording-import-${Date.now()}-${safeName}`;
        try {
            const bytes = await file.arrayBuffer();
            await requestWorker("write-file", { path: inputPath, bytes }, [bytes]);
            const response = await runWriteCommand([
                "record", "import",
                "--session", activeSessionId,
                "--input", inputPath,
            ]);
            const report = parseRecord(response.output);
            const durationSeconds = Math.floor(Number(report?.duration_us || 0) / 1_000_000);
            elements["recording-import-status"].textContent =
                `Imported WAV recording: ${report?.sample_rate_hz || "unknown"} Hz · ` +
                `${report?.channel_count || "unknown"} channel(s) · ` +
                `${durationSeconds.toLocaleString()} seconds · ${report?.chunk_count || "0"} chunk(s).`;
            elements["recording-import-form"].reset();
            showNotice("WAV recording imported into the selected session archive.");
        } catch (error) {
            showNotice(error.message, true);
        } finally {
            requestWorker("remove-file", { path: inputPath }).catch(() => {});
        }
    });

    elements["asset-import-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        const files = [...elements["asset-files"].files];
        if (!activeSessionId || files.length === 0) {
            showNotice("Choose a session and one or more files first.", true);
            return;
        }
        const oversized = files.find((file) => file.size > 64 * 1024 * 1024);
        if (oversized) {
            showNotice(`${oversized.name} exceeds the browser import limit of 64 MiB per file.`, true);
            return;
        }
        const temporaryPaths: string[] = [];
        let importedCount = 0;
        let importError: Error | null = null;
        try {
            for (const [index, file] of files.entries()) {
                const safeName = file.name.replace(/[\\/\0]/g, "_").replace(/^\.+/, "_");
                const path = `/workspace/asset-import-${Date.now()}-${index}-${safeName}`;
                const bytes = await file.arrayBuffer();
                temporaryPaths.push(path);
                await requestWorker("write-file", { path, bytes }, [bytes]);
                await responseFrom(archiveArguments(["asset", "add", path, "--session", activeSessionId]));
                importedCount += 1;
            }
        } catch (error) {
            importError = error;
        } finally {
            await Promise.all(temporaryPaths.map((path) => requestWorker("remove-file", { path }).catch(() => {})));
            if (importedCount > 0) {
                try {
                    setDirty(true);
                    await refreshWorkspace();
                    await loadSessionWorkspace(activeSessionId);
                    await persistBrowserArchive();
                } catch (error) {
                    if (!importError) importError = error;
                }
            }
        }
        elements["asset-import-form"].reset();
        if (importError) {
            showNotice(`Imported ${importedCount} file(s); ${importError.message}`, true);
        } else {
            showNotice(`Imported ${importedCount} file(s) into the portable archive.`);
        }
    });

    elements["ai-package-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        const sessionId = elements["ai-package-session"].value;
        if (!sessionId) {
            showNotice("Choose a session before creating an AI handoff package.", true);
            return;
        }
        const format = elements["ai-package-format"].value;
        const extension = format === "markdown" ? "md" : format === "zip" ? "zip" : "json";
        const filename = `tutorux-session-${sessionId}-ai-package.${extension}`;
        const outputPath = `/workspace/${filename}`;
        try {
            const command = [
                "ai", "package",
                "--session", sessionId,
                "--mode", "manual",
                "--format", format,
                "--output", outputPath,
            ];
            if (format === "zip") command.push("--confirm-sensitive");
            await runWriteCommand(command);
            const file = await requestWorker("read-file", { path: outputPath });
            const mediaType = format === "markdown"
                ? "text/markdown"
                : format === "zip"
                  ? "application/zip"
                  : "application/json";
            downloadFileBytes(file.bytes, filename, mediaType);
            showNotice("Downloaded the manual AI package. Review the response before importing it.");
        } catch (error) {
            showNotice(error.message, true);
        } finally {
            requestWorker("remove-file", { path: outputPath }).catch(() => {});
        }
    });

    elements["ai-response-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        const file = elements["ai-response-file"].files?.[0];
        const sessionId = elements["ai-package-session"].value;
        if (!sessionId || !file) {
            showNotice("Choose the source session and a JSON guide response first.", true);
            return;
        }
        if (file.size > 16 * 1024 * 1024) {
            showNotice("AI response imports are limited to 16 MiB per file.", true);
            return;
        }

        const safeName = file.name
            .replace(/[\\/\0]/g, "_")
            .replace(/^\.+/, "_");
        const inputPath = `/workspace/ai-response-${Date.now()}-${safeName}`;
        const title = elements["ai-response-title"].value.trim();
        const command = [
            "ai", "import",
            "--session", sessionId,
            "--input", inputPath,
        ];
        if (title) command.push("--title", title);
        try {
            const bytes = await file.arrayBuffer();
            await requestWorker("write-file", { path: inputPath, bytes }, [bytes]);
            const response = await runWriteCommand(command);
            const report = parseRecord(response.output);
            if (!report?.guide_id) {
                throw new Error("The AI import completed without returning a guide ID.");
            }
            activeGuideId = report.guide_id;
            elements["active-guide"].value = activeGuideId;
            await loadGuide(activeGuideId);
            elements["ai-response-form"].reset();
            const needsReview = report.status === "response-needs-correction";
            showNotice(
                needsReview
                    ? "Response imported as a proposed guide. Resolve source or schema warnings before approval."
                    : "Response imported as a proposed guide. Review its evidence and content before approval.",
            );
        } catch (error) {
            showNotice(error.message, true);
        } finally {
            requestWorker("remove-file", { path: inputPath }).catch(() => {});
        }
    });

    elements["guide-create-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        const sourceScope = elements["guide-source-scope"].value;
        const sourceId = sourceScope === "entry"
            ? elements["guide-entry-scope"].value
            : elements["guide-session"].value;
        if (!sourceId) return;
        try {
            const response = await runWriteCommand([
                "guide",
                "generate",
                sourceScope === "entry" ? "--entry-id" : "--session",
                sourceId,
            ]);
            const guide = parseRecord(response.output);
            if (guide?.id) {
                activeGuideId = guide.id;
                elements["active-guide"].value = activeGuideId;
                await loadGuide(activeGuideId);
            }
            showNotice("Evidence-linked guide draft created. Review the sources and edit before approval.");
        } catch (error) {
            if (sourceScope === "entry") {
                window.dispatchEvent(new CustomEvent("tutorux:entry-guide-error", {
                    detail: { message: error.message },
                }));
            }
            showNotice(error.message, true);
        }
    });

    elements["active-guide"].addEventListener("change", () => {
        loadGuide(elements["active-guide"].value).catch((error) => showNotice(error.message, true));
    });

    elements["guide-title-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!activeGuideId) return;
        try {
            await runWriteCommand(["guide", "edit", activeGuideId, "--title", elements["guide-title"].value.trim()]);
            await loadGuide(activeGuideId);
            showNotice("Guide title saved as a new archive revision.");
        } catch (error) {
            showNotice(error.message, true);
        }
    });

    elements["guide-section-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!activeGuideId) {
            showNotice("Choose a guide before adding a section.", true);
            return;
        }
        try {
            await runWriteCommand([
                "guide", "section", activeGuideId,
                "--heading", elements["guide-section-heading"].value.trim(),
                "--text", elements["guide-section-text"].value.trim(),
            ]);
            elements["guide-section-form"].reset();
            await loadGuide(activeGuideId);
            showNotice("Tutor-written section added to the guide.");
        } catch (error) {
            showNotice(error.message, true);
        }
    });

    elements["guide-approve"].addEventListener("click", async () => {
        if (!activeGuideId) return;
        try {
            await runWriteCommand(["guide", "approve", activeGuideId]);
            await loadGuide(activeGuideId);
            showNotice("Guide validated and approved in the portable archive.");
        } catch (error) {
            showNotice(error.message, true);
        }
    });

    elements["guide-export-form"].addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!activeGuideId) return;
        const format = elements["guide-export-format"].value;
        const extension = format === "markdown" ? "md" : format;
        const outputPath = `/workspace/tutorux-guide-${activeGuideId}.${extension}`;
        try {
            await responseFrom(archiveArguments([
                "guide", "export", activeGuideId,
                "--format", format,
                "--output", outputPath,
            ]));
            const file = await requestWorker("read-file", { path: outputPath });
            const mediaType = format === "html"
                ? "text/html"
                : format === "pdf"
                  ? "application/pdf"
                  : format === "docx"
                    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    : "text/markdown";
            downloadFileBytes(file.bytes, `tutorux-guide-${activeGuideId}.${extension}`, mediaType);
            showNotice(`Downloaded ${format.toUpperCase()} guide export.`);
        } catch (error) {
            showNotice(error.message, true);
        } finally {
            requestWorker("remove-file", { path: outputPath }).catch(() => {});
        }
    });

    elements["download-browser-copy"].addEventListener("click", () => {
        downloadBrowserRecoveryCopy().catch((error) => showNotice(error.message, true));
    });

    elements.commandForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            const commandArguments = JSON.parse(elements.commandInput.value);
            if (!Array.isArray(commandArguments) ||
                commandArguments.some((argument) => typeof argument !== "string")) {
                throw new Error("Enter a JSON array containing only command argument strings.");
            }
            const response = await responseFrom(archiveArguments(commandArguments));
            elements.commandOutput.textContent = response.output || "Command completed.";
            const commandName = commandArguments.slice(0, 2).join(" ");
            const readOnlyCommands = new Set([
                "student list", "student show", "session list", "session show",
                "guide list", "guide show", "guide validate", "asset list",
                "annotation history", "evidence list", "record status",
                "transcript list", "transcript show", "settings list", "settings get",
                "archive verify", "archive status", "record devices", "help", "--version",
            ]);
            if (!readOnlyCommands.has(commandName)) {
                setDirty(true);
                await persistBrowserArchive();
            }
            await refreshWorkspace();
        } catch (error) {
            elements.commandOutput.textContent = error.message;
            showNotice(error.message, true);
        }
    });

    for (const button of document.querySelectorAll("[data-view], [data-open-view]")) {
        button.addEventListener("click", async () => {
            const viewName = button.dataset.view || button.dataset.openView;
            switchView(viewName);
            if (activeArchivePath) {
                try {
                    await refreshWorkspace();
                } catch (error) {
                    showNotice(error.message, true);
                }
            }
        });
    }

    setWorkspaceAvailability(false);
    setStorageStatus(
        "Browser archive copy",
        "Browser storage is temporary and can be cleared by browser settings. Download the .tux archive to keep a portable copy.",
    );

    startWebWorker().then(async () => {
            try {
                browserArchiveDatabase = await openBrowserArchiveDatabase();
                if (navigator.storage && navigator.storage.persist) {
                    const persistenceGranted = await navigator.storage.persist().catch(() => false);
                    if (!persistenceGranted) {
                        setStorageStatus(
                            "Browser storage may be cleared",
                            "The browser did not grant persistent storage. The IndexedDB copy is still available for recovery, but browser settings or storage pressure may remove it. Download a portable .tux copy.",
                        );
                    }
                }
                if (await restoreBrowserArchive()) {
                    return;
                }
            } catch (error) {
                setStorageStatus(
                    "Browser storage unavailable",
                    `IndexedDB could not be opened: ${error.message}. Changes will stay in page memory until you download the .tux archive.`,
                );
                showNotice(`Browser storage is unavailable: ${error.message}. Save a portable copy after editing.`, true);
            }
            showNotice("Tutorux Web is ready. Open a .tux archive or create one.");
    }).catch((error) => showNotice(`Tutorux Web could not start: ${error.message}`, true));

    window.addEventListener("pagehide", () => {
        archivePassphrase = "";
        newArchivePassphrase = "";
    });

    window.addEventListener("beforeunload", (event) => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = "";
    });

    (window as any).tutoruxJournalBridge = {
        read: (commandArguments: string[]) =>
            responseFrom(archiveArguments(commandArguments)),
        write: (commandArguments: string[]) => runWriteCommand(commandArguments),
        refresh: () => refreshWorkspace(),
        archiveOpen: () => Boolean(activeArchivePath) && !archiveRecoveryNeedsReview,
        setDirty: (value: boolean) => setDirty(value),
        selectSession: (sessionId: string) => {
            activeSessionId = sessionId;
            elements["active-session"].value = sessionId;
            elements["active-session"].dispatchEvent(new Event("change", { bubbles: true }));
        },
        startRecording: () => startBrowserRecording(),
        writeFile: (path: string, bytes: ArrayBuffer) =>
            requestWorker("write-file", { path, bytes }, [bytes]),
        removeFile: (path: string) => requestWorker("remove-file", { path }),
        notice: (message: string, isError = false) => showNotice(message, isError),
    };
})();
