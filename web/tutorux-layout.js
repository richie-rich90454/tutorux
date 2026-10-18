(() => {
    "use strict";

    const splitters = document.querySelectorAll("[data-resize-target]");
    const bridge = window.tutoruxJournalBridge;
    const defaults = new Map([...splitters].map((splitter) => [
        splitter,
        Number(splitter.getAttribute("aria-valuenow")),
    ]));
    const pendingSettings = new Map();
    let saveTimer = 0;
    let settingsRequest = 0;
    let saveInFlight = false;

    function boundsFor(splitter) {
        return {
            minimum: Number(splitter.getAttribute("aria-valuemin")),
            maximum: Number(splitter.getAttribute("aria-valuemax")),
            property: splitter.dataset.resizeTarget === "sidebar" ? "--sidebar-width" : "--timeline-width",
            setting: splitter.dataset.resizeTarget === "sidebar"
                ? "ui.layout.sidebar_width"
                : "ui.layout.timeline_width",
        };
    }

    function setSize(splitter, size) {
        const bounds = boundsFor(splitter);
        const value = Math.max(bounds.minimum, Math.min(bounds.maximum, Math.round(size)));
        const container = splitter.parentElement;
        container.style.setProperty(bounds.property, `${value}px`);
        splitter.setAttribute("aria-valuenow", String(value));
    }

    function queueSave(splitter) {
        if (!bridge?.archiveOpen()) return;
        const { setting } = boundsFor(splitter);
        pendingSettings.set(setting, splitter.getAttribute("aria-valuenow"));
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void flushSettings(), 350);
    }

    async function flushSettings() {
        if (saveInFlight || !pendingSettings.size || !bridge?.archiveOpen()) return;
        saveInFlight = true;
        const snapshot = [...pendingSettings];
        for (const [key] of snapshot) pendingSettings.delete(key);
        try {
            for (const [key, value] of snapshot) {
                if (!bridge.archiveOpen()) break;
                await bridge.write(["settings", "set", "--key", key, "--value", value]);
            }
        } catch (error) {
            bridge.notice?.(`Pane sizes could not be saved: ${error.message}`, true);
        } finally {
            saveInFlight = false;
            if (pendingSettings.size) void flushSettings();
        }
    }

    async function loadSettings() {
        const request = ++settingsRequest;
        pendingSettings.clear();
        window.clearTimeout(saveTimer);
        for (const splitter of splitters) setSize(splitter, defaults.get(splitter));
        if (!bridge?.archiveOpen()) return;
        await Promise.all([...splitters].map(async (splitter) => {
            const { minimum, maximum, setting } = boundsFor(splitter);
            try {
                const response = await bridge.read(["settings", "get", setting]);
                const record = JSON.parse(String(response?.output || "{}"));
                const value = Number(record?.value);
                if (request !== settingsRequest || !bridge.archiveOpen()) return;
                if (Number.isFinite(value) && value >= minimum && value <= maximum) {
                    setSize(splitter, value);
                }
            } catch {
                // An archive without a saved pane size uses the accessible default.
            }
        }));
    }

    function sizeAtPointer(splitter, clientX) {
        const target = splitter.dataset.resizeTarget;
        const container = splitter.parentElement;
        const bounds = container.getBoundingClientRect();
        return target === "sidebar" ? clientX - bounds.left : bounds.right - clientX;
    }

    for (const splitter of splitters) {
        let pointerId = null;

        splitter.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            pointerId = event.pointerId;
            splitter.setPointerCapture(pointerId);
            splitter.classList.add("is-dragging");
            document.documentElement.classList.add("is-resizing-pane");
        });

        splitter.addEventListener("pointermove", (event) => {
            if (event.pointerId !== pointerId) return;
            setSize(splitter, sizeAtPointer(splitter, event.clientX));
        });

        const finishDrag = (event) => {
            if (event.pointerId !== pointerId) return;
            pointerId = null;
            splitter.classList.remove("is-dragging");
            document.documentElement.classList.remove("is-resizing-pane");
            queueSave(splitter);
        };
        splitter.addEventListener("pointerup", finishDrag);
        splitter.addEventListener("pointercancel", finishDrag);
        splitter.addEventListener("lostpointercapture", finishDrag);

        splitter.addEventListener("keydown", (event) => {
            const target = splitter.dataset.resizeTarget;
            const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
            if (direction) {
                event.preventDefault();
                const change = target === "timeline" ? -direction : direction;
                setSize(
                    splitter,
                    Number(splitter.getAttribute("aria-valuenow")) + change * (event.shiftKey ? 48 : 16),
                );
                queueSave(splitter);
            } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                const bounds = boundsFor(splitter);
                setSize(splitter, event.key === "Home" ? bounds.minimum : bounds.maximum);
                queueSave(splitter);
            }
        });
    }

    window.addEventListener("tutorux:archive-open", () => void loadSettings());
    void loadSettings();
})();
