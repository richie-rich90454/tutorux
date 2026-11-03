import { describe, expect, it } from "vitest";
import { prepareArchiveSettingsCopy } from "../../frontend/archive-settings-copy";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";

function setting(id: string, fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type: RecordType.settings,
        id,
        revision: 3n,
        previousOffset: 12n,
        fields: new Map([["record_role", "setting"], ...Object.entries(fields)]),
        blob: new Uint8Array([1, 2, 3]),
    };
}

describe("archive settings copy", () => {
    it("copies ordinary settings, sorted, resetting archive history", () => {
        const plan = prepareArchiveSettingsCopy(
            [setting("a", { key: "zeta", value: "z" }), setting("b", { key: "alpha", value: "a" })],
            [setting("t", { key: "alpha", value: "existing" })],
        );
        expect(plan.keys).toEqual(["alpha", "zeta"]);
        expect(plan.additions).toBe(1);
        expect(plan.replacements).toBe(1);
        expect(plan.withheldSensitive).toBe(0);
        expect(plan.records.map((record) => record.revision)).toEqual([0n, 0n]);
        expect(plan.records.map((record) => record.previousOffset)).toEqual([0n, 0n]);
        expect(plan.records.every((record) => record.blob.byteLength === 0)).toBe(true);
    });

    it("skips records that are not active ordinary settings", () => {
        const plan = prepareArchiveSettingsCopy(
            [
                {
                    ...setting("session", { key: "ignored" }),
                    type: RecordType.session,
                },
                {
                    ...setting("notes", { key: "ignored" }),
                    fields: new Map([
                        ["record_role", "journal-notes"],
                        ["key", "ignored"],
                    ]),
                },
                setting("deleted", { key: "ignored", _deleted: "true" }),
                setting("kept", { key: "kept" }),
            ],
            [],
        );
        expect(plan.keys).toEqual(["kept"]);
    });

    it("counts sensitive settings and credential material as withheld", () => {
        const plan = prepareArchiveSettingsCopy(
            [
                setting("key", { key: "provider_api_key", value: "secret" }),
                setting("material", { key: "provider", value: "x", password: "hunter2" }),
                setting("safe", { key: "theme", value: "dark" }),
            ],
            [],
        );
        expect(plan.withheldSensitive).toBe(2);
        expect(plan.keys).toEqual(["theme"]);
    });

    it("ignores sensitive target settings when counting replacements", () => {
        const plan = prepareArchiveSettingsCopy(
            [setting("source", { key: "theme", value: "dark" })],
            [
                setting("target", { key: "theme", value: "light" }),
                setting("deleted", { key: "theme", _deleted: "true" }),
                setting("sensitive", { key: "provider_api_key", value: "secret" }),
            ],
        );
        expect(plan.replacements).toBe(1);
        expect(plan.additions).toBe(0);
    });

    it.each([
        ["", "empty"],
        ["bad\u0001key", "control characters"],
        ["a".repeat(513), "oversized keys"],
    ])("rejects invalid settings keys: %s", (key) => {
        expect(() =>
            prepareArchiveSettingsCopy([setting("source", { key, value: "v" })], []),
        ).toThrow("The source archive contains an invalid ordinary settings key.");
    });

    it("rejects values that contain NUL or exceed the size limit", () => {
        expect(() =>
            prepareArchiveSettingsCopy([setting("source", { key: "a", value: "x\0y" })], []),
        ).toThrow("exceeds the supported value size");
        expect(() =>
            prepareArchiveSettingsCopy(
                [setting("source", { key: "a", value: "x".repeat(1024 * 1024 + 1) })],
                [],
            ),
        ).toThrow("exceeds the supported value size");
    });

    it("rejects duplicate source settings", () => {
        expect(() =>
            prepareArchiveSettingsCopy(
                [
                    setting("first", { key: "dup", value: "1" }),
                    setting("second", { key: "dup", value: "2" }),
                ],
                [],
            ),
        ).toThrow("The source archive contains more than one setting named “dup”.");
    });
});
