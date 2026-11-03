import { describe, expect, it } from "vitest";
import {
    formatMarkdownSelection,
    type InlineMarkdownFormat,
} from "../../../frontend/domain/markdown-shortcuts";

describe("Markdown inline formatting", () => {
    it("wraps and unwraps bold selections", () => {
        expect(formatMarkdownSelection("hello", 0, 5, "bold")).toEqual({
            text: "**hello**",
            selectionStart: 2,
            selectionEnd: 7,
            selectionDirection: "forward",
        });
        expect(formatMarkdownSelection("**hello**", 2, 7, "bold")).toEqual({
            text: "hello",
            selectionStart: 0,
            selectionEnd: 5,
            selectionDirection: "forward",
        });
    });

    it("inserts empty markers at a caret", () => {
        expect(formatMarkdownSelection("hello", 2, 2, "bold")).toEqual({
            text: "he****llo",
            selectionStart: 4,
            selectionEnd: 4,
            selectionDirection: "none",
        });
        expect(formatMarkdownSelection("", 0, 0, "italic")).toEqual({
            text: "**",
            selectionStart: 1,
            selectionEnd: 1,
            selectionDirection: "none",
        });
    });

    it("preserves selection direction", () => {
        expect(formatMarkdownSelection("**hello**", 7, 2, "bold")).toEqual({
            text: "hello",
            selectionStart: 0,
            selectionEnd: 5,
            selectionDirection: "backward",
        });
        expect(formatMarkdownSelection("hello", 5, 0, "italic")).toEqual({
            text: "*hello*",
            selectionStart: 1,
            selectionEnd: 6,
            selectionDirection: "backward",
        });
    });

    it("unwraps italic, strike, and code spans", () => {
        expect(formatMarkdownSelection("*hi*", 1, 3, "italic").text).toBe("hi");
        expect(formatMarkdownSelection("~~hi~~", 2, 4, "strike").text).toBe("hi");
        expect(formatMarkdownSelection("`hi`", 1, 3, "code").text).toBe("hi");
    });

    it("does not strip bold markers when applying italic", () => {
        expect(formatMarkdownSelection("**bold**", 2, 6, "italic").text).toBe("***bold***");
    });

    it("wraps without stripping when the markers do not surround the selection", () => {
        expect(formatMarkdownSelection("*hi*", 0, 2, "italic").text).toBe("**h*i*");
        expect(formatMarkdownSelection("xhi*x", 1, 3, "italic").text).toBe("x*hi**x");
        expect(formatMarkdownSelection("hi**", 0, 2, "bold").text).toBe("**hi****");
    });

    it("unwraps an existing link in both directions", () => {
        expect(formatMarkdownSelection("[hello](https://example.test)", 1, 6, "link")).toEqual({
            text: "hello",
            selectionStart: 0,
            selectionEnd: 5,
            selectionDirection: "forward",
        });
        expect(formatMarkdownSelection("[hello](https://example.test)", 6, 1, "link")).toEqual({
            text: "hello",
            selectionStart: 0,
            selectionEnd: 5,
            selectionDirection: "backward",
        });
    });

    it("wraps links that are not well formed", () => {
        expect(formatMarkdownSelection("[hello](", 1, 6, "link").text).toBe("[[hello](url)](");
        expect(formatMarkdownSelection("[hi](x)", 0, 3, "link").text).toBe("[[hi](url)](x)");
        expect(formatMarkdownSelection("[hi]", 1, 3, "link").text).toBe("[[hi](url)]");
        expect(formatMarkdownSelection("xhi](y)", 1, 3, "link").text).toBe("x[hi](url)](y)");
        expect(formatMarkdownSelection("[hi(x)", 1, 3, "link").text).toBe("[[hi](url)(x)");
        expect(formatMarkdownSelection("[hi]x)", 1, 3, "link").text).toBe("[[hi](url)]x)");
    });

    it("inserts a link placeholder for an empty selection", () => {
        expect(formatMarkdownSelection("abc", 1, 1, "link")).toEqual({
            text: "a[](url)bc",
            selectionStart: 4,
            selectionEnd: 7,
            selectionDirection: "forward",
        });
    });

    it("wraps a non-empty selection as link text", () => {
        expect(formatMarkdownSelection("abc", 0, 3, "link")).toEqual({
            text: "[abc](url)",
            selectionStart: 6,
            selectionEnd: 9,
            selectionDirection: "forward",
        });
    });

    it("clamps offsets to valid text boundaries", () => {
        expect(
            formatMarkdownSelection("abc", Number.NaN, Number.POSITIVE_INFINITY, "bold"),
        ).toEqual({
            text: "****abc",
            selectionStart: 2,
            selectionEnd: 2,
            selectionDirection: "none",
        });
        expect(formatMarkdownSelection("abc", -5, 99, "bold").text).toBe("**abc**");
        expect(formatMarkdownSelection("abc", 1.9, 2.9, "bold").text).toBe("a**b**c");
        expect(formatMarkdownSelection("a😀b", 1, 3, "bold").text).toBe("a**😀**b");
        expect(formatMarkdownSelection("a😀b", 2, 2, "bold")).toEqual({
            text: "a****😀b",
            selectionStart: 3,
            selectionEnd: 3,
            selectionDirection: "none",
        });
    });

    it("handles unknown format identifiers without markers", () => {
        expect(formatMarkdownSelection("abc", 0, 3, "unknown" as InlineMarkdownFormat).text).toBe(
            "abc",
        );
        expect(formatMarkdownSelection("abc", 1, 1, "unknown" as InlineMarkdownFormat).text).toBe(
            "abc",
        );
    });
});
