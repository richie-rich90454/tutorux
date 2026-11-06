// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
    guidePath,
    navigate,
    parseRoute,
    sessionPath,
    startRouter,
    studentPath,
    useRoute,
} from "../../frontend/app/router";

describe("app router", () => {
    it("maps every route shape", () => {
        expect(parseRoute("")).toEqual({ name: "today", id: "", tab: "" });
        expect(parseRoute("#")).toEqual({ name: "today", id: "", tab: "" });
        expect(parseRoute("#students")).toEqual({ name: "students", id: "", tab: "" });
        expect(parseRoute("#/")).toEqual({ name: "today", id: "", tab: "" });
        expect(parseRoute("#/today")).toEqual({ name: "today", id: "", tab: "" });
        expect(parseRoute("students")).toEqual({ name: "students", id: "", tab: "" });
        expect(parseRoute("#/students")).toEqual({ name: "students", id: "", tab: "" });
        expect(parseRoute("#/students/abc")).toEqual({
            name: "student",
            id: "abc",
            tab: "overview",
        });
        expect(parseRoute("#/students/abc/progress")).toEqual({
            name: "student",
            id: "abc",
            tab: "progress",
        });
        expect(parseRoute("#/sessions")).toEqual({ name: "sessions", id: "", tab: "" });
        expect(parseRoute("#/sessions/abc")).toEqual({
            name: "session",
            id: "abc",
            tab: "overview",
        });
        expect(parseRoute("#/sessions/abc/capture")).toEqual({
            name: "session",
            id: "abc",
            tab: "capture",
        });
        expect(parseRoute("#/schedule")).toEqual({ name: "schedule", id: "", tab: "" });
        expect(parseRoute("#/materials")).toEqual({ name: "materials", id: "", tab: "" });
        expect(parseRoute("#/guides")).toEqual({ name: "guides", id: "", tab: "" });
        expect(parseRoute("#/guides/abc")).toEqual({ name: "guide", id: "abc", tab: "edit" });
        expect(parseRoute("#/evidence")).toEqual({ name: "evidence", id: "", tab: "" });
        expect(parseRoute("#/assistant")).toEqual({ name: "assistant", id: "", tab: "" });
        expect(parseRoute("#/archive")).toEqual({ name: "archive", id: "", tab: "" });
        expect(parseRoute("#/settings")).toEqual({ name: "settings", id: "", tab: "" });
        expect(parseRoute("#/unknown")).toEqual({ name: "not-found", id: "", tab: "" });
    });

    it("builds canonical paths", () => {
        expect(sessionPath("abc")).toBe("#/sessions/abc/overview");
        expect(sessionPath("abc", "notes")).toBe("#/sessions/abc/notes");
        expect(studentPath("abc")).toBe("#/students/abc/overview");
        expect(studentPath("abc", "progress")).toBe("#/students/abc/progress");
        expect(guidePath("abc")).toBe("#/guides/abc/edit");
    });

    it("navigates through the hash route", () => {
        navigate("/students/abc/overview");
        expect(window.location.hash).toBe("#/students/abc/overview");
        expect(useRoute()().name).toBe("student");
        navigate("#/today", true);
        expect(useRoute()().name).toBe("today");
        navigate("settings");
        expect(window.location.hash).toBe("#/settings");
    });

    it("starts the hash listener and focuses the main region", () => {
        document.body.innerHTML = '<main id="main-content"></main>';
        const focus = vi.fn();
        const main = document.getElementById("main-content") as HTMLElement;
        main.focus = focus;
        window.requestAnimationFrame = (callback) => {
            callback(0);
            return 1;
        };
        window.history.replaceState(null, "", "/");
        startRouter();
        expect(useRoute()().name).toBe("today");
        window.location.hash = "#/settings";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        expect(useRoute()().name).toBe("settings");
        expect(focus).toHaveBeenCalled();
        document.body.innerHTML = "";
        startRouter();
        window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
});
