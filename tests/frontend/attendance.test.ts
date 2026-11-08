import { describe, expect, it } from "vitest";
import { attendanceStats } from "../../frontend/shared/attendance";

describe("attendanceStats", () => {
    it("counts completed lessons and no-shows", () => {
        expect(
            attendanceStats([
                { status: "completed" },
                { status: "completed" },
                { status: "no_show" },
                { status: "cancelled" },
                { status: "planned" },
            ]),
        ).toEqual({ completed: 2, noShows: 1, rate: 67 });
    });

    it("returns no rate before any attended or missed lesson", () => {
        expect(attendanceStats([{ status: "planned" }])).toEqual({
            completed: 0,
            noShows: 0,
            rate: null,
        });
    });
});
