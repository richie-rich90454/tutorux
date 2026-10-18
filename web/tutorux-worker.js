"use strict";

importScripts("./tutorux-core.js");

let moduleReady = null;

function initializeModule() {
    if (!moduleReady) {
        moduleReady = self.createTutoruxModule().then((module) => {
            try {
                module.FS.mkdir("/workspace");
            } catch (error) {
                if (!String(error).includes("EEXIST")) throw error;
            }
            return module;
        });
    }
    return moduleReady;
}

async function dispatch(payload) {
    const module = await initializeModule();
    const raw = module.ccall(
        "tutorux_web_dispatch_json",
        "string",
        ["string"],
        [JSON.stringify(payload)],
    );
    return JSON.parse(raw);
}

self.onmessage = async (event) => {
    const { id, type, payload } = event.data || {};
    try {
        if (type === "initialize") {
            await initializeModule();
            self.postMessage({ id, ok: true, type: "ready" });
            return;
        }
        if (type === "dispatch") {
            self.postMessage({ id, ok: true, result: await dispatch(payload) });
            return;
        }
        const module = await initializeModule();
        if (type === "write-file") {
            module.FS.writeFile(payload.path, new Uint8Array(payload.bytes));
            self.postMessage({ id, ok: true });
            return;
        }
        if (type === "read-file") {
            const bytes = module.FS.readFile(payload.path, { encoding: "binary" });
            const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            self.postMessage({ id, ok: true, bytes: copy }, [copy]);
            return;
        }
        if (type === "remove-file") {
            if (typeof payload.path !== "string" || !payload.path.startsWith("/workspace/")) {
                throw new Error("Browser worker file operations are limited to the active workspace.");
            }
            try {
                module.FS.unlink(payload.path);
            } catch (error) {
                if (!String(error).includes("ENOENT")) throw error;
            }
            self.postMessage({ id, ok: true });
            return;
        }
        throw new Error(`Unknown worker request: ${type}`);
    } catch (error) {
        self.postMessage({
            id,
            type: id === 0 ? "init-error" : "error",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
