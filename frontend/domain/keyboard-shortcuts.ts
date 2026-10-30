export type KeyboardShortcutAction =
    | { type: "open-archive" }
    | { type: "save-archive" }
    | { type: "quick-actions" }
    | { type: "new-session" }
    | { type: "find" }
    | { type: "preferences" }
    | { type: "toggle-appearance" }
    | { type: "quick-marker"; index: number };

export interface KeyboardShortcutContext {
    platform: "browser" | "desktop";
    pageSearchAvailable: boolean;
    pageSearchFocused: boolean;
    page: string;
    editableTarget: boolean;
    modalOpen: boolean;
    paletteOpen: boolean;
    markerKeys: readonly string[];
    markerEnabled: boolean;
}

/** Resolve app-owned key commands once, with editor and native-menu precedence kept explicit. */
export function resolveKeyboardShortcut(
    event: KeyboardEvent,
    context: KeyboardShortcutContext,
): KeyboardShortcutAction | null {
    if (event.repeat || event.altKey || event.isComposing) return null;

    const command = event.metaKey || event.ctrlKey;
    if (!command) return null;

    const key = event.key.toLocaleLowerCase();
    const desktopNativeMenuOwns = context.platform === "desktop";

    if (event.shiftKey) {
        if (key === "l" && !desktopNativeMenuOwns) return { type: "toggle-appearance" };
        return null;
    }

    // The webview resolves K so the note editor can own its contextual link shortcut.
    if (desktopNativeMenuOwns && ["o", "s", ",", "q"].includes(key)) return null;

    if (key === "k") return { type: "quick-actions" };
    if (context.modalOpen) return null;
    if (context.paletteOpen) return null;
    if (key === ",") return { type: "preferences" };

    if (key === "f" && context.pageSearchAvailable) {
        if (!context.editableTarget || context.pageSearchFocused) return { type: "find" };
    }

    if (!context.paletteOpen && context.page === "annotations" && !context.editableTarget) {
        if (!["k", "o", "s", "n"].includes(key)) {
            const index = context.markerKeys.indexOf(key);
            if (context.markerEnabled && index >= 0) return { type: "quick-marker", index };
        }
    }

    if (key === "o") {
        return { type: "open-archive" };
    } else if (key === "s") {
        return { type: "save-archive" };
    } else if (key === "n") {
        return { type: "new-session" };
    }

    return null;
}

export interface KeyboardShortcutRow {
    action: string;
    keys: string;
}

/** User-facing shortcut reference shared by Preferences and platform-specific labels. */
export function keyboardShortcutRows(
    isMac: boolean,
    isDesktop: boolean,
    markerKeys: readonly string[],
): KeyboardShortcutRow[] {
    const command = isMac ? "⌘" : "Ctrl";
    const chord = (key: string): string => (isMac ? `${command} ${key}` : `${command}+${key}`);
    return [
        { action: "Quick actions", keys: chord("K") },
        { action: "Move through quick actions", keys: "↑ / ↓ · Enter" },
        { action: "Cycle focus or close quick actions", keys: "Tab / Shift+Tab · Esc" },
        { action: "Open archive", keys: chord("O") },
        { action: "Save archive", keys: chord("S") },
        { action: "Create a session", keys: chord("N") },
        { action: "Find on this page or in notes", keys: chord("F") },
        { action: "Open preferences", keys: chord(",") },
        { action: "Switch appearance", keys: isMac ? "⌘ ⇧ L" : "Ctrl+Shift+L" },
        { action: "Seek audio preview", keys: "← / ↓ · → / ↑ · Shift+arrow: 10 sec" },
        {
            action: "Add an observation",
            keys: `${command}${isMac ? " " : "+"}${markerKeys
                .map((key) => key.toLocaleUpperCase())
                .join(" / ")}`,
        },
        {
            action: "Format selected note text",
            keys: `${chord("B")} bold · ${chord("I")} italic · ${chord("K")} link`,
        },
        {
            action: "Undo / redo note edits",
            keys: `${chord("Z")} undo · ${isMac ? "⌘ ⇧ Z" : "Ctrl+Shift+Z"} or ${chord("Y")} redo`,
        },
        ...(isDesktop ? [{ action: "Quit Tutorux", keys: chord("Q") }] : []),
    ];
}
