(() => {
    "use strict";

    const elements = Object.fromEntries(
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
        ].map((id) => [id, document.getElementById(id)]),
    );

    const views = [...document.querySelectorAll("[data-panel]")];
    let webWorker = null;
    let workerReady = null;
    let nextWorkerRequestId = 0;
    const workerRequests = new Map();
    let activeArchivePath = "";
    let activeArchiveName = "";
    let sourceFileHandle = null;
    let dirty = false;
    let noticeTimer = 0;
    let browserArchiveDatabase = null;
    let archivePassphrase = "";
    let newArchivePassphrase = "";

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
        elements.saveArchive.disabled = !activeArchivePath || !dirty;
        elements.archiveLabel.textContent = activeArchiveName
            ? `${activeArchiveName}${dirty ? " · unsaved changes" : ""}`
            : "No archive open";
    }

    function setArchive(path, name, handle = null) {
        activeArchivePath = path;
        activeArchiveName = name;
        sourceFileHandle = handle;
        elements.setPassphrase.disabled = !path;
        elements.archiveState.classList.toggle("is-open", Boolean(path));
        setDirty(false);
        elements.studentCount.textContent = "0";
        elements.sessionCount.textContent = "0";
    }

    function startWebWorker() {
        if (workerReady) return workerReady;
        workerReady = new Promise((resolve, reject) => {
            webWorker = new Worker("./tutorux-worker.js");
            webWorker.onmessage = (event) => {
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

    async function requestWorker(type, payload = {}, transfer = []) {
        await startWebWorker();
        return new Promise((resolve, reject) => {
            const id = ++nextWorkerRequestId;
            workerRequests.set(id, { resolve, reject });
            webWorker.postMessage({ id, type, payload }, transfer);
        });
    }

    async function responseFrom(argumentsList) {
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

    function archiveArguments(commandArguments) {
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
            const request = browserArchiveDatabase
                .transaction("workspace", "readonly")
                .objectStore("workspace")
                .get("active");
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error("Browser archive could not be read."));
        });
    }

    async function persistBrowserArchive() {
        if (!browserArchiveDatabase || !activeArchivePath) return;
        const source = await readArchiveBytes();
        return new Promise((resolve, reject) => {
            const request = browserArchiveDatabase
                .transaction("workspace", "readwrite")
                .objectStore("workspace")
                .put({
                    key: "active",
                    name: activeArchiveName,
                    bytes: source.slice().buffer,
                    savedAt: Date.now(),
                });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error("Browser archive could not be saved."));
        });
    }

    async function restoreBrowserArchive() {
        const stored = await readBrowserArchive();
        if (!stored || !(stored.bytes instanceof ArrayBuffer)) {
            return false;
        }
        const safeName = String(stored.name || "Tutorux.tux").replace(/[\\/\0]/g, "_");
        activeArchivePath = `/workspace/${safeName}`;
        activeArchiveName = safeName;
        sourceFileHandle = null;
        await requestWorker("write-file", { path: activeArchivePath, bytes: stored.bytes });
        await responseFrom(["--archive", activeArchivePath, "archive", "verify", "--json"]);
        elements.archiveState.classList.add("is-open");
        elements.setPassphrase.disabled = false;
        setDirty(false);
        await refreshWorkspace();
        showNotice(`${safeName} restored from this browser's local archive copy.`);
        return true;
    }

    async function saveArchive() {
        if (!activeArchivePath || !dirty) {
            return;
        }
        const bytes = await readArchiveBytes();
        let destinationHandle = sourceFileHandle;
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
            const download = document.createElement("a");
            download.href = URL.createObjectURL(
                new Blob([bytes], { type: "application/octet-stream" }),
            );
            download.download = activeArchiveName.endsWith(".tux")
                ? activeArchiveName
                : `${activeArchiveName}.tux`;
            download.click();
            URL.revokeObjectURL(download.href);
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

    function renderRows(container, rows, emptyText, detail) {
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
            container.append(row);
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
        const sessions = parseRows(sessionsResponse.output);
        const guides = parseRows(guideResponse.output);
        elements.studentCount.textContent = String(students.length);
        elements.sessionCount.textContent = String(sessions.length);
        renderRows(elements.studentsList, students, "No students have been added yet.", (record) => {
            const grade = record.grade ? `Grade ${record.grade}` : "Student profile";
            return `${grade} · ${record.id || ""}`;
        });
        renderRows(elements.sessionsList, sessions, "No tutoring sessions have been created yet.", (record) => {
            return `${record.subject || "Tutoring session"} · ${record.id || ""}`;
        });
        renderRows(elements.recentSessions, sessions.slice(0, 5), "No recent sessions.", (record) => {
            return `${record.subject || "Tutoring session"} · ${record.id || ""}`;
        });
        renderRows(elements.guidesList, guides, "No study guides are available in this archive.", (record) => {
            return `${record.status || "Draft"} · ${record.id || ""}`;
        });
    }

    async function runWriteCommand(commandArguments) {
        const response = await responseFrom(archiveArguments(commandArguments));
        setDirty(true);
        await refreshWorkspace();
        try {
            await persistBrowserArchive();
            showNotice(response.output || "Changes saved to this browser's archive copy.");
        } catch (error) {
            showNotice(`Changes are in memory but browser storage failed: ${error.message}`, true);
        }
    }

    async function createArchive() {
        const path = "/workspace/Tutorux.tux";
        await responseFrom(["archive", "init", path, "--name", "Tutorux", "--json"]);
        setArchive(path, "Tutorux.tux");
        await refreshWorkspace();
        await persistBrowserArchive();
        showNotice("Archive created in this browser. Use Save archive to download a portable copy.");
    }

    async function openArchive(file, handle = null) {
        const safeName = file.name.replace(/[\\/\0]/g, "_") || "Tutorux.tux";
        activeArchivePath = `/workspace/${safeName}`;
        activeArchiveName = safeName;
        archivePassphrase = "";
        newArchivePassphrase = "";
        const bytes = await file.arrayBuffer();
        await requestWorker("write-file", { path: activeArchivePath, bytes }, [bytes]);
        sourceFileHandle = handle;
        try {
            await responseFrom(["--archive", activeArchivePath, "archive", "verify", "--json"]);
        } catch (error) {
            if (error.code !== "archive_locked") throw error;
            archivePassphrase = await requestArchivePassphrase();
            await responseFrom(["--archive", activeArchivePath, "archive", "verify", "--json"]);
        }
        elements.archiveState.classList.add("is-open");
        elements.setPassphrase.disabled = false;
        setDirty(false);
        await refreshWorkspace();
        await persistBrowserArchive();
        showNotice(`Opened ${safeName}. Changes are stored in this browser; save a portable copy when needed.`);
    }

    function switchView(viewName) {
        for (const view of views) {
            view.classList.toggle("is-visible", view.dataset.panel === viewName);
        }
        for (const button of document.querySelectorAll("[data-view]")) {
            button.classList.toggle("is-active", button.dataset.view === viewName);
        }
    }

    async function chooseArchive() {
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

    function requestArchivePassphrase() {
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
    elements.createArchive.addEventListener("click", createArchive);
    document.getElementById("welcome-create").addEventListener("click", createArchive);
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
            await runWriteCommand([
                "session",
                "create",
                "--title",
                title,
                ...(subject ? ["--subject", subject] : []),
                ...(studentId ? ["--student-id", studentId] : []),
            ]);
            elements.sessionForm.reset();
        } catch (error) {
            showNotice(error.message, true);
        }
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

    startWebWorker().then(async () => {
            try {
                browserArchiveDatabase = await openBrowserArchiveDatabase();
                if (navigator.storage && navigator.storage.persist) {
                    navigator.storage.persist().catch(() => false);
                }
                if (await restoreBrowserArchive()) {
                    return;
                }
            } catch (error) {
                showNotice(`Browser storage is unavailable: ${error.message}. Save a portable copy after editing.`, true);
            }
            showNotice("Tutorux Web is ready. Open a .tux archive or create one.");
    }).catch((error) => showNotice(`Tutorux Web could not start: ${error.message}`, true));

    window.addEventListener("pagehide", () => {
        archivePassphrase = "";
        newArchivePassphrase = "";
    });
})();
