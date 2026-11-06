import { describe, expect, it } from "vitest";
import {
    daysUntil,
    formatBytes,
    formatDate,
    formatDateTime,
    formatDuration,
    formatShortDate,
    formatTime,
    formatTimestampUs,
    fromDateTimeLocal,
    initials,
    parseTimestampUs,
    plural,
    toDateTimeLocal,
    todayIso,
} from "../../frontend/shared/format";

describe("format helpers", () => {
    it("formats bytes", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(1024)).toBe("1.0 KB");
        expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
        expect(formatBytes(Number.NaN)).toBe("0 B");
    });

    it("formats dates and times", () => {
        const stamp = Date.UTC(2026, 10, 5, 14, 30);
        expect(formatDate(stamp)).toContain("2026");
        expect(formatShortDate(stamp)).toContain("Nov");
        expect(formatTime(stamp)).toContain(":");
        expect(formatDateTime(stamp)).toContain("2026");
        expect(formatDate(null)).toBe("No date");
        expect(formatDate("2026-11-05T00:00:00.000Z")).toContain("2026");
        expect(formatDate("not-a-date")).toBe("No date");
        expect(formatShortDate(null)).toBe("No date");
        expect(formatShortDate("2026-11-05T00:00:00.000Z")).toContain("Nov");
        expect(formatShortDate("not-a-date")).toBe("No date");
        expect(formatTime(null)).toBe("");
        expect(formatTime("not-a-date")).toBe("");
        expect(formatDateTime(null)).toBe("No date");
    });

    it("formats durations", () => {
        expect(formatDuration(0)).toBe("0 min");
        expect(formatDuration(300)).toBe("5 min");
        expect(formatDuration(3600)).toBe("1 h");
        expect(formatDuration(5400)).toBe("1 h 30 min");
    });

    it("formats and parses timestamps", () => {
        expect(formatTimestampUs(0)).toBe("0:00");
        expect(formatTimestampUs(65_000_000)).toBe("1:05");
        expect(formatTimestampUs(3_665_000_000)).toBe("1:01:05");
        expect(parseTimestampUs("1:05")).toBe(65_000_000);
        expect(parseTimestampUs("1:01:05")).toBe(3_665_000_000);
        expect(parseTimestampUs("bad")).toBe(0);
        expect(parseTimestampUs("1:bad")).toBe(0);
        expect(parseTimestampUs("1")).toBe(0);
    });

    it("handles date inputs", () => {
        const local = toDateTimeLocal(Date.UTC(2026, 10, 5, 14, 30));
        expect(fromDateTimeLocal(local)).toBeTypeOf("number");
        expect(fromDateTimeLocal("")).toBeNull();
        expect(fromDateTimeLocal("not-a-date")).toBeNull();
        expect(toDateTimeLocal(null)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u);
        expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    });

    it("builds initials and plurals", () => {
        expect(initials("Maya Ortiz")).toBe("MO");
        expect(initials("Maya")).toBe("M");
        expect(initials("")).toBe("?");
        expect(plural(1, "cue")).toBe("1 cue");
        expect(plural(2, "cue")).toBe("2 cues");
    });

    it("describes days", () => {
        expect(daysUntil(null)).toBe("No date");
        expect(daysUntil(Date.now())).toBe("Today");
        expect(daysUntil(Date.now() + 86_400_000)).toMatch(/Tomorrow|In 1 days/u);
        expect(daysUntil(Date.now() - 86_400_000)).toMatch(/Yesterday|In -1 days/u);
        expect(daysUntil(Date.now() + 3 * 86_400_000)).toMatch(/In 2 days|In 3 days/u);
        expect(daysUntil(Date.now() - 3 * 86_400_000)).toMatch(/3 days ago/u);
    });
});
