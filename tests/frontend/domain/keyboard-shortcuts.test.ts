import { describe, expect, it } from "vitest";
import {
    keyboardShortcutRows,
    resolveKeyboardShortcut,
    type KeyboardShortcutContext,
} from "../../../frontend/domain/keyboard-shortcuts";

function event(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
        key: "o",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        repeat: false,
        isComposing: false,
        ...overrides,
    } as KeyboardEvent;
}

function context(overrides: Partial<KeyboardShortcutContext> = {}): KeyboardShortcutContext {
    return {
        platform: "browser",
        pageSearchAvailable: false,
        pageSearchFocused: false,
        page: "session",
        editableTarget: false,
        modalOpen: false,
        paletteOpen: false,
        markerKeys: ["1", "2"],
        markerEnabled: true,
        ...overrides,
    };
}

describe("keyboard shortcut resolution", () => {
    it("ignores held, composition, and unmodified keys", () => {
        expect(resolveKeyboardShortcut(event({ repeat: true, ctrlKey: true }), context())).toBe(
            null,
        );
        expect(resolveKeyboardShortcut(event({ altKey: true, ctrlKey: true }), context())).toBe(
            null,
        );
        expect(
            resolveKeyboardShortcut(event({ isComposing: true, ctrlKey: true }), context()),
        ).toBe(null);
        expect(resolveKeyboardShortcut(event({ key: "o" }), context())).toBe(null);
    });

    it("switches appearance in the browser only", () => {
        expect(
            resolveKeyboardShortcut(event({ key: "l", ctrlKey: true, shiftKey: true }), context()),
        ).toEqual({ type: "toggle-appearance" });
        expect(
            resolveKeyboardShortcut(
                event({ key: "l", ctrlKey: true, shiftKey: true }),
                context({ platform: "desktop" }),
            ),
        ).toBe(null);
        expect(
            resolveKeyboardShortcut(event({ key: "x", ctrlKey: true, shiftKey: true }), context()),
        ).toBe(null);
    });

    it("defers native menu chords on desktop", () => {
        for (const key of ["o", "s", ",", "q"]) {
            expect(
                resolveKeyboardShortcut(
                    event({ key, ctrlKey: true }),
                    context({ platform: "desktop" }),
                ),
            ).toBe(null);
        }
        expect(
            resolveKeyboardShortcut(
                event({ key: "n", ctrlKey: true }),
                context({ platform: "desktop" }),
            ),
        ).toEqual({ type: "new-session" });
    });

    it("keeps quick actions ahead of palette and modal precedence", () => {
        expect(resolveKeyboardShortcut(event({ key: "k", metaKey: true }), context())).toEqual({
            type: "quick-actions",
        });
        expect(
            resolveKeyboardShortcut(
                event({ key: "k", metaKey: true }),
                context({ paletteOpen: true }),
            ),
        ).toEqual({ type: "quick-actions" });
        expect(
            resolveKeyboardShortcut(
                event({ key: "o", metaKey: true }),
                context({ modalOpen: true }),
            ),
        ).toBe(null);
        expect(
            resolveKeyboardShortcut(
                event({ key: ",", metaKey: true }),
                context({ paletteOpen: true }),
            ),
        ).toBe(null);
    });

    it("opens preferences and page search", () => {
        expect(resolveKeyboardShortcut(event({ key: ",", ctrlKey: true }), context())).toEqual({
            type: "preferences",
        });
        expect(
            resolveKeyboardShortcut(
                event({ key: "f", ctrlKey: true }),
                context({ pageSearchAvailable: true }),
            ),
        ).toEqual({ type: "find" });
        expect(
            resolveKeyboardShortcut(
                event({ key: "f", ctrlKey: true }),
                context({
                    pageSearchAvailable: true,
                    editableTarget: true,
                    pageSearchFocused: true,
                }),
            ),
        ).toEqual({ type: "find" });
        expect(
            resolveKeyboardShortcut(
                event({ key: "f", ctrlKey: true }),
                context({ pageSearchAvailable: true, editableTarget: true }),
            ),
        ).toBe(null);
        expect(resolveKeyboardShortcut(event({ key: "f", ctrlKey: true }), context())).toBe(null);
    });

    it("resolves annotation marker shortcuts only on the annotations page", () => {
        expect(
            resolveKeyboardShortcut(
                event({ key: "2", ctrlKey: true }),
                context({ page: "annotations" }),
            ),
        ).toEqual({ type: "quick-marker", index: 1 });
        expect(
            resolveKeyboardShortcut(
                event({ key: "2", ctrlKey: true }),
                context({ page: "annotations", markerEnabled: false }),
            ),
        ).toBe(null);
        expect(
            resolveKeyboardShortcut(
                event({ key: "9", ctrlKey: true }),
                context({ page: "annotations" }),
            ),
        ).toBe(null);
        expect(
            resolveKeyboardShortcut(
                event({ key: "2", ctrlKey: true }),
                context({ page: "annotations", paletteOpen: true }),
            ),
        ).toBe(null);
        expect(
            resolveKeyboardShortcut(
                event({ key: "2", ctrlKey: true }),
                context({ page: "annotations", editableTarget: true }),
            ),
        ).toBe(null);
        expect(
            resolveKeyboardShortcut(
                event({ key: "2", ctrlKey: true }),
                context({ page: "annotations", markerKeys: ["k"] }),
            ),
        ).toBe(null);
        expect(
            resolveKeyboardShortcut(
                event({ key: "3", ctrlKey: true }),
                context({ page: "session", markerKeys: ["3"] }),
            ),
        ).toBe(null);
        expect(
            resolveKeyboardShortcut(
                event({ key: "o", ctrlKey: true }),
                context({ page: "annotations" }),
            ),
        ).toEqual({ type: "open-archive" });
    });

    it("resolves archive, save, and session commands", () => {
        expect(resolveKeyboardShortcut(event({ key: "o", ctrlKey: true }), context())).toEqual({
            type: "open-archive",
        });
        expect(resolveKeyboardShortcut(event({ key: "s", ctrlKey: true }), context())).toEqual({
            type: "save-archive",
        });
        expect(resolveKeyboardShortcut(event({ key: "n", ctrlKey: true }), context())).toEqual({
            type: "new-session",
        });
        expect(resolveKeyboardShortcut(event({ key: "x", ctrlKey: true }), context())).toBe(null);
    });
});

describe("keyboard shortcut reference rows", () => {
    it("renders control labels for non-Mac browser users", () => {
        const rows = keyboardShortcutRows(false, false, ["1", "2"]);
        expect(rows.find((row) => row.action === "Quick actions")?.keys).toBe("Ctrl+K");
        expect(rows.find((row) => row.action === "Switch appearance")?.keys).toBe("Ctrl+Shift+L");
        expect(rows.find((row) => row.action === "Add an observation")?.keys).toBe("Ctrl+1 / 2");
        expect(rows.some((row) => row.action === "Quit Tutorux")).toBe(false);
    });

    it("renders command labels and desktop-only rows for Mac users", () => {
        const rows = keyboardShortcutRows(true, true, []);
        expect(rows.find((row) => row.action === "Quick actions")?.keys).toBe("⌘ K");
        expect(rows.find((row) => row.action === "Switch appearance")?.keys).toBe("⌘ ⇧ L");
        expect(rows.find((row) => row.action === "Add an observation")?.keys).toBe("⌘ ");
        expect(rows.find((row) => row.action === "Quit Tutorux")?.keys).toBe("⌘ Q");
        expect(rows.find((row) => row.action === "Undo / redo note edits")?.keys).toContain(
            "⌘ Z undo · ⌘ ⇧ Z",
        );
    });
});
