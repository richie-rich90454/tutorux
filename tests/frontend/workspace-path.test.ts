import { describe, expect, it } from "vitest";
import {
    isInsideDirectory,
    isRestorableWorkspacePath,
    normalizePath,
    workspaceFileName,
} from "../../frontend/app/workspace-path";

describe("workspace path helpers", () => {
    it("normalizes separators and trailing slashes", () => {
        expect(normalizePath("C:\\Users\\Maya\\Temp\\")).toBe("C:/Users/Maya/Temp");
        expect(normalizePath("C://Users//Maya")).toBe("C:/Users/Maya");
        expect(normalizePath("/")).toBe("/");
        expect(normalizePath("")).toBe("");
    });

    it("detects paths inside a temporary directory", () => {
        const temp = "C:\\Users\\Maya\\AppData\\Local\\Temp";
        expect(isInsideDirectory("C:\\Users\\Maya\\AppData\\Local\\Temp\\a.tutor", temp)).toBe(
            true,
        );
        expect(isInsideDirectory("C:/Users/Maya/AppData/Local/Temp/opencode/a.tutor", temp)).toBe(
            true,
        );
        expect(isInsideDirectory(temp, temp)).toBe(true);
        expect(isInsideDirectory("C:\\Users\\Maya\\AppData\\Local\\Temp2\\a.tutor", temp)).toBe(
            false,
        );
        expect(isInsideDirectory("C:\\Users\\Maya\\Documents\\a.tutor", temp)).toBe(false);
    });

    it("ignores missing or empty paths", () => {
        expect(isInsideDirectory("", "C:/Temp")).toBe(false);
        expect(isInsideDirectory("C:/Temp/a.tutor", "")).toBe(false);
    });

    it("only restores non-temporary workspaces", () => {
        const temp = "C:\\Users\\Maya\\AppData\\Local\\Temp";
        expect(isRestorableWorkspacePath("C:\\Users\\Maya\\Documents\\a.tutor", temp)).toBe(true);
        expect(
            isRestorableWorkspacePath("C:\\Users\\Maya\\AppData\\Local\\Temp\\a.tutor", temp),
        ).toBe(false);
        expect(isRestorableWorkspacePath("", temp)).toBe(false);
        expect(isRestorableWorkspacePath("C:\\Users\\Maya\\Documents\\a.tutor", "")).toBe(true);
    });

    it("extracts a display filename", () => {
        expect(workspaceFileName("C:\\Users\\Maya\\Practice.tutor")).toBe("Practice.tutor");
        expect(workspaceFileName("C:/Users/Maya/Practice.tutor")).toBe("Practice.tutor");
        expect(workspaceFileName("Practice.tutor")).toBe("Practice.tutor");
    });
});
