import { describe, expect, it } from "vitest";
import { ArchiveFormatError, RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
    annotationTypeLabel,
    currentJournalDate,
    dateParts,
    errorMessage,
    field,
    formatBytes,
    formatTimestamp,
    initials,
    pluralize,
    pluralNoun,
    safeBigInt,
    safeFileName,
    safeJournalColor,
} from "../../frontend/shared-utils";

function record(fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type: RecordType.settings,
        id: "11111111-1111-4111-8111-111111111111",
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

describe("shared date helpers", () => {
    it("uses the local calendar date for new journal entries", () => {
        expect(currentJournalDate(new Date(2026, 0, 2, 23, 30))).toBe("2026-01-02");
        expect(currentJournalDate(new Date(2026, 11, 31, 0, 5))).toBe("2026-12-31");
        expect(currentJournalDate(new Date(2026, 2, 9, 12, 0))).toBe("2026-03-09");
        expect(currentJournalDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    });

    it("avoids reserved Windows device names", () => {
        expect(safeFileName("CON")).toBe("Tutorux-CON");
        expect(safeFileName("lpt1.tux")).toBe("Tutorux-lpt1.tux");
        expect(safeFileName("Lesson 1")).toBe("Lesson-1");
    });
});

describe("shared record and text helpers", () => {
    it("reads fields with a default fallback", () => {
        const value = record({ name: "Ada" });
        expect(field(value, "name")).toBe("Ada");
        expect(field(value, "missing")).toBe("");
        expect(field(value, "missing", "fallback")).toBe("fallback");
        expect(field(value, "name", "fallback")).toBe("Ada");
    });

    it("pluralizes counts", () => {
        expect(pluralNoun(1, "session")).toBe("session");
        expect(pluralNoun(2, "session")).toBe("sessions");
        expect(pluralNoun(0, "entry", "entries")).toBe("entries");
        expect(pluralize(1, "material")).toBe("1 material");
        expect(pluralize(1200, "material")).toBe("1,200 materials");
        expect(pluralize(2, "match", "matches")).toBe("2 matches");
    });

    it.each([
        ["CON", "Tutorux-CON"],
        ["prn.notes", "Tutorux-prn.notes"],
        ["COM9", "Tutorux-COM9"],
        ["setup", "setup"],
        ["  ", "Tutorux-workspace"],
        ['a/b\\c:d*e?f"g<h>i|j', "a-b-c-d-e-f-g-h-i-j"],
        [" - padded - ", "padded"],
        ["name.with..dots", "name.with..dots"],
        ["\u0000control\u001f", "control"],
        ["x".repeat(150), "x".repeat(100)],
        ["...", "Tutorux-workspace"],
    ])("sanitizes the file name %j", (value, expected) => {
        expect(safeFileName(value)).toBe(expected);
    });

    it("formats stored microsecond timestamps", () => {
        expect(formatTimestamp("1767225600000000")).toBe("Jan 1, 2026");
        expect(formatTimestamp("0")).toBe("Date not set");
        expect(formatTimestamp("")).toBe("Date not set");
        expect(formatTimestamp("-1000")).toBe("Date not set");
        expect(formatTimestamp("not-a-number")).toBe("Date not set");
        expect(formatTimestamp(`1${"0".repeat(400)}`)).toBe("Date not set");
    });

    it("normalizes unknown errors", () => {
        expect(errorMessage(new ArchiveFormatError("code", "archive failed"))).toBe(
            "archive failed",
        );
        expect(errorMessage(new Error("plain failure"))).toBe("plain failure");
        expect(errorMessage("literal failure")).toBe("literal failure");
        expect(errorMessage(42)).toBe("42");
    });

    it("parses big integers defensively", () => {
        expect(safeBigInt("42")).toBe(42n);
        expect(safeBigInt("")).toBe(0n);
        expect(safeBigInt("nope")).toBe(0n);
    });

    it("labels annotation types from kebab case", () => {
        expect(annotationTypeLabel("observation")).toBe("Observation");
        expect(annotationTypeLabel("strength-improvement")).toBe("Strength Improvement");
    });

    it("formats byte counts across unit boundaries", () => {
        expect(formatBytes(0n)).toBe("0 B");
        expect(formatBytes(1023n)).toBe("1023 B");
        expect(formatBytes(1024n)).toBe("1.00 KB");
        expect(formatBytes(10n * 1024n)).toBe("10.0 KB");
        expect(formatBytes(100n * 1024n)).toBe("100 KB");
        expect(formatBytes(1024n ** 2n)).toBe("1.00 MB");
        expect(formatBytes(1024n ** 3n)).toBe("1.00 GB");
        expect(formatBytes(1024n ** 4n)).toBe("1.00 TB");
        expect(formatBytes(1024n ** 6n)).toBe("1048576 TB");
    });

    it("derives up to two initials", () => {
        expect(initials("ada lovelace")).toBe("AL");
        expect(initials("  ada   lovelace  king ")).toBe("AL");
        expect(initials("Grace")).toBe("G");
        expect(initials("   ")).toBe("T");
    });
});

describe("shared calendar helpers", () => {
    it("splits valid dates", () => {
        expect(dateParts("2026-03-09")).toEqual({ day: "09", month: "MAR", year: "2026" });
    });

    it("returns placeholders for invalid dates", () => {
        expect(dateParts("not-a-date")).toEqual({ day: "–", month: "---", year: "" });
    });

    it("accepts only opaque six digit hex journal colors", () => {
        expect(safeJournalColor(record({ color: "#a1b2c3" }))).toBe("#a1b2c3");
        expect(safeJournalColor(record({ color: "#A1B2C3" }))).toBe("#A1B2C3");
        expect(safeJournalColor(record({ color: "red" }))).toBe("var(--accent)");
        expect(safeJournalColor(record({ color: "#12345" }))).toBe("var(--accent)");
        expect(safeJournalColor(record())).toBe("var(--accent)");
    });
});
