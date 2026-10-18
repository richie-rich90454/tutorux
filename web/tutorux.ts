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
        error?: string;
    };

    const elements: Record<string, any> = Object.fromEntries(
        [
            "archive-file",
            "archive-label",
            "archive-state",
            "command-form",
            "command-input",
            "command-output",
            "create-archive",
            "guides-list",
            "notice",
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
            "guide-session",
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
    let sourceFileHandle = null;
    let dirty = false;
    let noticeTimer = 0;
    let browserArchiveDatabase = null;
    let archivePassphrase = "";
    let newArchivePassphrase = "";
    let sessionRecords: any[] = [];
    let guideRecords: any[] = [];
    let activeSessionId = "";
    let activeGuideId = "";
    let recoveryArchive: any = null;
    let browserRecordingRecorder: MediaRecorder | null = null;
    let browserRecordingStream: MediaStream | null = null;
    let browserRecordingChunks: Blob[] = [];
    let browserRecordingBytes = 0;
    let browserRecordingSessionId = "";
    let browserRecordingConsentAtUs = 0;
    let browserRecordingSaving = false;

    const maximumBrowserRecordingBytes = 64 * 1024 * 1024;

    function showNotice(message, isError = false) {
        window.clearTimeout(noticeTimer);
        elements.notice.textContent = message;
        elements.notice.classList.toggle("is-error", isError);
        elements.notice.hidden = false;
        noticeTimer = window.setTimeout(() => {
            elements.notice.hidden = true;
        }, 4800);
    }

    function setDirty(value) {
        dirty = value;
        elements.saveArchive.disabled = !activeArchivePath;
        elements.archiveLabel.textContent = activeArchiveName
            ? `${activeArchiveName}${dirty ? " · portable download needed" : ""}`
            : "No archive open";
    }

    function setWorkspaceAvailability(enabled: boolean): void {
        for (const requirement of document.querySelectorAll<HTMLElement>("[data-requires-archive]")) {
            const controls = requirement.matches("input, button, select, textarea")
                ? [requirement as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement]
                : [...requirement.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input, button, select, textarea")];
            for (const control of controls) control.disabled = !enabled;
        }
        updateBrowserRecordingControls();
    }

    function updateBrowserRecordingControls(): void {
        const supported = Boolean(
            window.isSecureContext &&
            navigator.mediaDevices?.getUserMedia &&
            typeof MediaRecorder !== "undefined",
        );
        const recording = Boolean(browserRecordingRecorder && browserRecordingRecorder.state !== "inactive");
        elements["browser-recording-consent"].disabled = !activeArchivePath || recording || browserRecordingSaving;
        elements["browser-recording-start"].disabled =
            !activeArchivePath || !activeSessionId || !supported || recording || browserRecordingSaving ||
            !elements["browser-recording-consent"].checked;
        elements["browser-recording-stop"].disabled = !recording || browserRecordingSaving;
        if (!supported && elements["browser-recording-status"]) {
            elements["browser-recording-status"].textContent =
                "Microphone capture requires a secure browser with MediaRecorder support. System audio is not captured.";
        }
    }

    async function saveBrowserRecording(recorder: MediaRecorder): Promise<void> {
        const sessionId = browserRecordingSessionId;
        const consentAtUs = browserRecordingConsentAtUs;
        const mimeType = recorder.mimeType || browserRecordingChunks[0]?.type || "audio/webm";
        const chunks = browserRecordingChunks;
        browserRecordingChunks = [];
        browserRecordingRecorder = null;
        browserRecordingSaving = true;
        browserRecordingBytes = 0;
        browserRecordingSessionId = "";
        browserRecordingConsentAtUs = 0;
        browserRecordingStream?.getTracks().forEach((track) => track.stop());
        browserRecordingStream = null;
        updateBrowserRecordingControls();

        let inputPath = "";
        let capturedBlob: Blob | null = null;
        let fallbackFilename = "";
        try {
            const recording = new Blob(chunks, { type: mimeType });
            capturedBlob = recording;
            chunks.length = 0;
            if (recording.size === 0) {
                throw new Error("The browser did not capture any microphone audio.");
            }
            if (recording.size > maximumBrowserRecordingBytes) {
                throw new Error("Browser microphone recordings are limited to 64 MiB.");
            }
            const extension = mimeType.includes("mp4")
                ? "m4a"
                : mimeType.includes("ogg")
                  ? "ogg"
                  : "webm";
            fallbackFilename = `tutorux-browser-recording-${Date.now()}.${extension}`;
            inputPath = `/workspace/${fallbackFilename}`;
            const bytes = await recording.arrayBuffer();
            await requestWorker("write-file", { path: inputPath, bytes }, [bytes]);
            const response = await runWriteCommand([
                "asset", "add", inputPath,
                "--session", sessionId,
                "--capture-source", "browser-microphone",
                "--capture-consent-at-us", String(consentAtUs),
                "--consent",
            ]);
            const asset = parseRecord(response.output);
            elements["browser-recording-status"].textContent =
                `Microphone capture saved in this session as ${asset?.filename || fallbackFilename}. ` +
                `The browser stored ${recording.size.toLocaleString()} bytes of ${mimeType} audio.`;
            elements["browser-recording-consent"].checked = false;
            showNotice("Browser microphone recording saved into the selected archive.");
        } catch (error) {
            if (capturedBlob && capturedBlob.size > 0 && fallbackFilename) {
                const fallbackBytes = await capturedBlob.arrayBuffer();
                downloadFileBytes(fallbackBytes, fallbackFilename, mimeType);
                throw new Error(`${error.message} A separate audio copy was downloaded for recovery.`);
            }
            throw error;
        } finally {
            browserRecordingSaving = false;
            if (inputPath) requestWorker("remove-file", { path: inputPath }).catch(() => {});
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
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
            throw new Error("This browser does not support secure microphone recording.");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        });
        browserRecordingStream = stream;
        browserRecordingSessionId = activeSessionId;
        browserRecordingConsentAtUs = Date.now() * 1000;
        browserRecordingChunks = [];
        browserRecordingBytes = 0;
        const supportedType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]
            .find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, {
            ...(supportedType ? { mimeType: supportedType } : {}),
            audioBitsPerSecond: 48_000,
        });
        browserRecordingRecorder = recorder;
        recorder.addEventListener("dataavailable", (event) => {
            if (event.data.size > 0) {
                browserRecordingChunks.push(event.data);
                browserRecordingBytes += event.data.size;
            }
            elements["browser-recording-status"].textContent =
                `Recording microphone audio · ${browserRecordingBytes.toLocaleString()} bytes captured.`;
            if (browserRecordingBytes > maximumBrowserRecordingBytes && recorder.state === "recording") {
                elements["browser-recording-status"].textContent =
                    "The 64 MiB capture limit was reached. Stopping the microphone recording.";
                recorder.stop();
            }
        });
        recorder.addEventListener("error", () => {
            elements["browser-recording-status"].textContent =
                "The browser stopped microphone capture after an error.";
            if (recorder.state === "recording") recorder.stop();
        });
        recorder.addEventListener("stop", () => {
            saveBrowserRecording(recorder).catch((error) => {
                elements["browser-recording-status"].textContent = error.message;
                showNotice(error.message, true);
            });
        }, { once: true });
        recorder.start(1000);
        elements["browser-recording-status"].textContent =
            "Recording microphone audio locally. Keep this page open until you stop and save.";
        updateBrowserRecordingControls();
    }

    function setStorageStatus(title: string, detail: string, canDownload = false): void {
        elements["storage-status-title"].textContent = title;
        elements["storage-status-detail"].textContent = detail;
        elements["download-browser-copy"].disabled = !canDownload;
        elements["browser-storage"].classList.toggle("is-warning", !canDownload && Boolean(activeArchivePath));
    }

    function setArchive(path, name, handle = null) {
        activeArchivePath = path;
        activeArchiveName = name;
        sourceFileHandle = handle;
        activeSessionId = "";
        activeGuideId = "";
        elements.setPassphrase.disabled = !path;
        elements.archiveState.classList.toggle("is-open", Boolean(path));
        setWorkspaceAvailability(Boolean(path));
        setDirty(false);
        elements.studentCount.textContent = "0";
        elements.sessionCount.textContent = "0";
        updateBrowserRecordingControls();
    }

    function startWebWorker(): Promise<void> {
        if (workerReady) return workerReady;
        workerReady = new Promise((resolve, reject) => {
            webWorker = new Worker("./tutorux-worker.js");
            webWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
                const message = event.data;
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

    async function responseFrom(argumentsList: string[]): Promise<any> {
        const message = await requestWorker("dispatch", {
            arguments: argumentsList,
            passphrase: archivePassphrase,
            newPassphrase: newArchivePassphrase,
        });
        const response = message.result;
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

    async function readArchiveBytes() {
        const result = await requestWorker("read-file", { path: activeArchivePath });
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

    function readBrowserArchive() {
        return new Promise((resolve, reject) => {
            if (!browserArchiveDatabase) {
                reject(new Error("Browser archive storage is unavailable."));
                return;
            }
            const request = browserArchiveDatabase
                .transaction("workspace", "readonly")
                .objectStore("workspace")
                .get("active");
            request.onsuccess = () => {
                recoveryArchive = request.result || null;
                resolve(recoveryArchive);
            };
            request.onerror = () => reject(request.error || new Error("Browser archive could not be read."));
        });
    }

    async function persistBrowserArchive() {
        if (!browserArchiveDatabase || !activeArchivePath) return;
        const source = await readArchiveBytes();
        return new Promise((resolve, reject) => {
            const transaction = browserArchiveDatabase.transaction("workspace", "readwrite");
            const request = transaction.objectStore("workspace").put({
                key: "active",
                name: activeArchiveName,
                bytes: source.slice().buffer,
                savedAt: Date.now(),
            });
            request.onerror = () => reject(request.error || new Error("Browser archive could not be saved."));
            transaction.oncomplete = () => {
                recoveryArchive = {
                    name: activeArchiveName,
                    bytes: source.slice().buffer,
                    savedAt: Date.now(),
                };
                setStorageStatus(
                    "Browser recovery copy updated",
                    "The current .tux archive is stored in this browser. Browser storage can be cleared or evicted; download a portable copy to keep it independently.",
                    true,
                );
                resolve();
            };
            transaction.onerror = () => reject(transaction.error || new Error("Browser archive could not be saved."));
            transaction.onabort = () => reject(transaction.error || new Error("Browser archive save was interrupted."));
        });
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
        setWorkspaceAvailability(true);
        setDirty(false);
        await refreshWorkspace();
        setStorageStatus(
            "Browser recovery copy restored",
            `Restored ${safeName} from ${new Date(stored.savedAt || 0).toLocaleString()}. This copy remains subject to browser storage policies; download a portable .tux archive for independent safekeeping.`,
            true,
        );
        showNotice(`${safeName} restored from this browser's recovery copy.`);
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
        const stored = recoveryArchive || await readBrowserArchive();
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

    function renderAnnotations(records: any[]): void {
        const container = elements["annotations-list"] as HTMLElement;
        container.replaceChildren();
        if (records.length === 0) {
            container.append(makeEmptyRow("No tutor notes have been added to this session."));
            return;
        }
        for (const record of records) {
            const row = document.createElement("article");
            row.className = "material-row annotation-row";
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
            row.append(heading, content, detail, edit);
            container.append(row);
        }
    }

    function renderTranscript(records: any[]): void {
        const container = elements["transcript-list"] as HTMLElement;
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

            row.append(heading, textForm, timestampForm, speakerForm, verify);
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

    async function loadSessionWorkspace(sessionId: string): Promise<void> {
        activeSessionId = sessionId;
        updateBrowserRecordingControls();
        if (!sessionId) {
            renderAnnotations([]);
            elements["transcript-list"].replaceChildren(makeEmptyRow("Choose a session to view transcript segments."));
            elements["recording-import-status"].textContent =
                "Choose a session to view or import its recording.";
            elements["edit-session-title"].value = "";
            elements["edit-session-subject"].value = "";
            return;
        }
        const [sessionResponse, annotationsResponse, transcriptResponse, assetsResponse] = await Promise.all([
            responseFrom(archiveArguments(["session", "show", sessionId])),
            responseFrom(archiveArguments(["annotation", "list", "--session", sessionId])),
            responseFrom(archiveArguments(["transcript", "show", "--session", sessionId])),
            responseFrom(archiveArguments(["asset", "list", "--session", sessionId])),
        ]);
        const session = parseRecord(sessionResponse.output);
        elements["edit-session-title"].value = session?.title || "";
        elements["edit-session-subject"].value = session?.subject || "";
        const audioImportState = session?.audio_import_state || "not-imported";
        const audioChunks = session?.audio_chunks_imported || "0";
        const audioBytes = Number(session?.audio_import_bytes || 0);
        elements["recording-import-status"].textContent = audioImportState === "not-imported"
            ? "No WAV recording has been imported into this session."
            : `Imported audio: ${audioImportState} · ${audioChunks} chunk(s) · ${Number.isFinite(audioBytes) ? audioBytes.toLocaleString() : "0"} bytes.`;
        renderAnnotations(parseRows(annotationsResponse.output));
        renderTranscript(parseRows(transcriptResponse.output));
        renderAssets(parseRows(assetsResponse.output));
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
            elements["active-session"].value = String(record.id || "");
            switchView("sessions");
            loadSessionWorkspace(String(record.id || "")).catch((error) => showNotice(error.message, true));
        });
        renderRows(elements.recentSessions, sessionRecords.slice(0, 5), "No recent sessions.", (record) => {
            return `${record.subject || "Tutoring session"} · ${record.id || ""}`;
        }, "Open", (record) => {
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

    async function runWriteCommand(commandArguments) {
        const response = await responseFrom(archiveArguments(commandArguments));
        setDirty(true);
        await refreshWorkspace();
        if (activeSessionId) await loadSessionWorkspace(activeSessionId);
        try {
            await persistBrowserArchive();
            showNotice(response.output || "Changes saved to this browser's archive copy.");
        } catch (error) {
            showNotice(`Changes are in memory but browser storage failed: ${error.message}`, true);
        }
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
        const displayName = name.trim().replace(/[\\/\0]/g, "_").replace(/\.tux$/i, "") || "Tutorux";
        const archiveName = `${displayName}.tux`;
        const path = `/workspace/${archiveName}`;
        await responseFrom(["archive", "init", path, "--name", displayName, "--json"]);
        setArchive(path, archiveName);
        activeSessionId = "";
        activeGuideId = "";
        await refreshWorkspace();
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
            await responseFrom(["--archive", activeArchivePath, "archive", "verify", "--json"]);
        } catch (error) {
            if (error.code !== "archive_locked") throw error;
            archivePassphrase = await requestArchivePassphrase();
            await responseFrom(["--archive", activeArchivePath, "archive", "verify", "--json"]);
        }
        setArchive(path, safeName, handle);
        activeSessionId = "";
        activeGuideId = "";
        setDirty(false);
        await refreshWorkspace();
        await persistBrowserArchive();
        showNotice(`Opened ${safeName}. Changes are retained by this browser; download the .tux archive for independent storage.`);
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
        if (browserRecordingRecorder || browserRecordingSaving) {
            showNotice("Stop and save the microphone recording before opening another archive.", true);
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
    elements["browser-recording-start"].addEventListener("click", () => {
        startBrowserRecording().catch((error) => {
            browserRecordingRecorder = null;
            browserRecordingStream?.getTracks().forEach((track) => track.stop());
            browserRecordingStream = null;
            browserRecordingChunks = [];
            browserRecordingBytes = 0;
            browserRecordingSessionId = "";
            browserRecordingConsentAtUs = 0;
            elements["browser-recording-status"].textContent = error.message;
            updateBrowserRecordingControls();
            showNotice(error.message, true);
        });
    });
    elements["browser-recording-stop"].addEventListener("click", () => {
        if (!browserRecordingRecorder || browserRecordingRecorder.state !== "recording") return;
        elements["browser-recording-status"].textContent = "Stopping and saving the microphone recording…";
        browserRecordingRecorder.stop();
    });
    window.addEventListener("beforeunload", (event) => {
        if (!browserRecordingRecorder && !browserRecordingSaving) return;
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
        const sessionId = elements["guide-session"].value;
        if (!sessionId) return;
        try {
            const response = await runWriteCommand(["guide", "generate", "--session", sessionId]);
            const guide = parseRecord(response.output);
            if (guide?.id) {
                activeGuideId = guide.id;
                elements["active-guide"].value = activeGuideId;
                await loadGuide(activeGuideId);
            }
            showNotice("Evidence-linked guide draft created. Review the sources and edit before approval.");
        } catch (error) {
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
})();
