import {
    createContext,
    createSignal,
    onCleanup,
    onMount,
    useContext,
    type Accessor,
    type JSX,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { applyDocumentTailwindUtilities } from "../theme";
import {
    chooseNewWorkspaceFile,
    chooseWorkspaceFile,
    errorMessage,
    workspace as workspaceApi,
} from "../api/client";
import type { WorkspaceSummary } from "../api/types";

type Tone = "info" | "success" | "danger";
type ThemeMode = "light" | "dark" | "system";

interface Notice {
    message: string;
    tone: Tone;
}

interface WorkspaceContextValue {
    summary: Accessor<WorkspaceSummary | null>;
    loading: Accessor<boolean>;
    busy: Accessor<boolean>;
    error: Accessor<string>;
    notice: Accessor<Notice | null>;
    simpleMode: Accessor<boolean>;
    dirty: Accessor<boolean>;
    themeMode: Accessor<ThemeMode>;
    encryptedPath: Accessor<string>;
    createWorkspace: (name: string, description: string, passphrase?: string) => Promise<boolean>;
    openWorkspace: () => Promise<boolean>;
    openWorkspacePath: (path: string) => Promise<boolean>;
    unlockWorkspace: (passphrase: string) => Promise<boolean>;
    cancelUnlock: () => void;
    closeWorkspace: () => Promise<void>;
    refresh: () => Promise<void>;
    renameWorkspace: (name: string, description: string) => Promise<boolean>;
    rekeyWorkspace: (newPassphrase: string) => Promise<boolean>;
    setSimpleMode: (simple: boolean) => void;
    setDirty: (dirty: boolean) => void;
    setThemeMode: (mode: ThemeMode) => void;
    notify: (message: string, tone?: Tone) => void;
    dismissNotice: () => void;
    clearError: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue>();

const LAST_PATH_KEY = "tutorux.lastWorkspace";
const MODE_KEY = "tutorux.mode";
const THEME_KEY = "tutorux.theme";

function validTheme(value: string | null): value is ThemeMode {
    return value === "light" || value === "dark" || value === "system";
}

export function WorkspaceProvider(props: { children: JSX.Element }): JSX.Element {
    applyDocumentTailwindUtilities();
    const [summary, setSummary] = createSignal<WorkspaceSummary | null>(null);
    const [loading, setLoading] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal("");
    const [notice, setNotice] = createSignal<Notice | null>(null);
    const [simpleMode, setSimpleModeSignal] = createSignal(
        localStorage.getItem(MODE_KEY) !== "advanced",
    );
    const [dirty, setDirty] = createSignal(false);
    const [encryptedPath, setEncryptedPath] = createSignal("");
    const [themeMode, setThemeModeSignal] = createSignal<ThemeMode>(
        validTheme(localStorage.getItem(THEME_KEY))
            ? (localStorage.getItem(THEME_KEY) as ThemeMode)
            : "system",
    );
    let noticeTimer = 0;

    const applyTheme = (mode: ThemeMode): void => {
        const resolved =
            mode === "system"
                ? window.matchMedia("(prefers-color-scheme: dark)").matches
                    ? "dark"
                    : "light"
                : mode;
        document.documentElement.dataset["theme"] = resolved;
    };

    onMount(() => {
        applyTheme(themeMode());
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = (): void => {
            if (themeMode() === "system") applyTheme("system");
        };
        media.addEventListener("change", onChange);
        const lastPath = localStorage.getItem(LAST_PATH_KEY);
        const openPath = (path: string): Promise<void> => {
            setLoading(true);
            return workspaceApi
                .open(path)
                .then((value) => {
                    localStorage.setItem(LAST_PATH_KEY, path);
                    setSummary(value);
                    setError("");
                })
                .catch((cause: unknown) => {
                    const message = errorMessage(cause);
                    if (message.toLowerCase().includes("encrypted")) {
                        setEncryptedPath(path);
                    } else {
                        localStorage.removeItem(LAST_PATH_KEY);
                    }
                })
                .finally(() => setLoading(false));
        };
        void (lastPath ? openPath(lastPath) : Promise.resolve()).then(() =>
            invoke<string | null>("take_pending_open_archive").then((path) => {
                if (path) return openPath(path);
                return undefined;
            }),
        );
        onCleanup(() => media.removeEventListener("change", onChange));
    });

    const notify = (message: string, tone: Tone = "info"): void => {
        setNotice({ message, tone });
        window.clearTimeout(noticeTimer);
        noticeTimer = window.setTimeout(() => setNotice(null), 4000);
    };

    const acceptOpened = (path: string, value: WorkspaceSummary): void => {
        localStorage.setItem(LAST_PATH_KEY, path);
        setSummary(value);
        setDirty(false);
        setEncryptedPath("");
        setError("");
    };

    const createWorkspace = async (
        name: string,
        description: string,
        passphrase = "",
    ): Promise<boolean> => {
        if (!name.trim()) {
            setError("Enter a workspace name.");
            return false;
        }
        setBusy(true);
        setError("");
        try {
            const path = await chooseNewWorkspaceFile(name);
            if (!path) return false;
            const value = await workspaceApi.create(path, name, description, passphrase || null);
            acceptOpened(path, value);
            notify("Workspace created.", "success");
            return true;
        } catch (cause) {
            setError(errorMessage(cause));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const openWorkspace = async (): Promise<boolean> => {
        setBusy(true);
        setError("");
        let selectedPath = "";
        try {
            const path = await chooseWorkspaceFile();
            if (!path) return false;
            selectedPath = path;
            const value = await workspaceApi.open(path, null);
            acceptOpened(path, value);
            notify("Workspace opened.", "success");
            return true;
        } catch (cause) {
            const message = errorMessage(cause);
            if (message.toLowerCase().includes("encrypted")) {
                setEncryptedPath(selectedPath);
                setError("");
                notify("This workspace is encrypted. Enter its passphrase.", "info");
            } else {
                setError(message);
            }
            return false;
        } finally {
            setBusy(false);
        }
    };

    const openWorkspacePath = async (path: string): Promise<boolean> => {
        setBusy(true);
        setError("");
        try {
            const value = await workspaceApi.open(path, null);
            acceptOpened(path, value);
            notify("Workspace opened.", "success");
            return true;
        } catch (cause) {
            const message = errorMessage(cause);
            if (message.toLowerCase().includes("encrypted")) {
                setEncryptedPath(path);
                notify("This workspace is encrypted. Enter its passphrase.", "info");
            } else {
                setError(message);
            }
            return false;
        } finally {
            setBusy(false);
        }
    };

    const unlockWorkspace = async (passphrase: string): Promise<boolean> => {
        const path = encryptedPath();
        if (!path) return false;
        setBusy(true);
        setError("");
        try {
            const value = await workspaceApi.open(path, passphrase);
            acceptOpened(path, value);
            notify("Workspace unlocked.", "success");
            return true;
        } catch (cause) {
            setError(errorMessage(cause));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const cancelUnlock = (): void => {
        setEncryptedPath("");
        setError("");
    };

    const closeWorkspace = async (): Promise<void> => {
        await workspaceApi.close().catch(() => undefined);
        localStorage.removeItem(LAST_PATH_KEY);
        setSummary(null);
        setDirty(false);
    };

    const refresh = async (): Promise<void> => {
        if (!summary()) return;
        try {
            setSummary(await workspaceApi.summary());
        } catch (cause) {
            setError(errorMessage(cause));
        }
    };

    const renameWorkspace = async (name: string, description: string): Promise<boolean> => {
        setBusy(true);
        setError("");
        try {
            setSummary(await workspaceApi.rename(name, description));
            notify("Workspace updated.", "success");
            return true;
        } catch (cause) {
            setError(errorMessage(cause));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const rekeyWorkspace = async (newPassphrase: string): Promise<boolean> => {
        setBusy(true);
        setError("");
        try {
            setSummary(await workspaceApi.rekey(newPassphrase));
            notify("Workspace passphrase changed. Save a new backup.", "success");
            return true;
        } catch (cause) {
            setError(errorMessage(cause));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const setSimpleMode = (simple: boolean): void => {
        setSimpleModeSignal(simple);
        localStorage.setItem(MODE_KEY, simple ? "simple" : "advanced");
    };

    const setThemeMode = (mode: ThemeMode): void => {
        setThemeModeSignal(mode);
        localStorage.setItem(THEME_KEY, mode);
        applyTheme(mode);
    };

    return (
        <WorkspaceContext.Provider
            value={{
                summary,
                loading,
                busy,
                error,
                notice,
                simpleMode,
                dirty,
                themeMode,
                encryptedPath: encryptedPath,
                createWorkspace,
                openWorkspace,
                openWorkspacePath,
                unlockWorkspace,
                cancelUnlock,
                closeWorkspace,
                refresh,
                renameWorkspace,
                rekeyWorkspace,
                setSimpleMode,
                setDirty,
                setThemeMode,
                notify,
                dismissNotice: () => setNotice(null),
                clearError: () => setError(""),
            }}
        >
            {props.children}
        </WorkspaceContext.Provider>
    );
}

export function useWorkspace(): WorkspaceContextValue {
    const context = useContext(WorkspaceContext);
    if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider.");
    return context;
}
