import { describe, expect, it } from "vitest";
import { currentJournalDate, safeFileName } from "../../frontend/shared-utils";

describe("shared date helpers", () => {
    it("uses the local calendar date for new journal entries", () => {
        expect(currentJournalDate(new Date(2026, 0, 2, 23, 30))).toBe("2026-01-02");
        expect(currentJournalDate(new Date(2026, 11, 31, 0, 5))).toBe("2026-12-31");
        expect(currentJournalDate(new Date(2026, 2, 9, 12, 0))).toBe("2026-03-09");
    });

    it("avoids reserved Windows device names", () => {
        expect(safeFileName("CON")).toBe("Tutorux-CON");
        expect(safeFileName("lpt1.tux")).toBe("Tutorux-lpt1.tux");
        expect(safeFileName("Lesson 1")).toBe("Lesson-1");
    });
});
