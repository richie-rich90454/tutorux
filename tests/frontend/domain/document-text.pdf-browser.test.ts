// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import * as pdfjs from "pdfjs-dist";
import {
    configurePdfWorkerSource,
    extractDocumentText,
} from "../../../frontend/domain/document-text";

vi.mock("pdfjs-dist", () => ({
    GlobalWorkerOptions: {},
    getDocument: vi.fn(() => ({
        promise: Promise.resolve({
            numPages: 1,
            getPage: () =>
                Promise.resolve({
                    streamTextContent: () =>
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue({ items: [{ str: "Browser PDF text" }] });
                                controller.close();
                            },
                        }),
                    cleanup: () => undefined,
                }),
        }),
        destroy: () => Promise.resolve(),
    })),
}));

describe("PDF text extraction in the browser runtime", () => {
    it("uses the browser PDF.js build when a window is available", async () => {
        configurePdfWorkerSource("/pdf.worker.mjs");
        const bytes = new TextEncoder().encode("%PDF-1.4 browser fixture");
        await expect(extractDocumentText("browser.pdf", "application/pdf", bytes)).resolves.toEqual(
            { status: "extracted", text: "Browser PDF text" },
        );
        expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/pdf.worker.mjs");
        expect(pdfjs.getDocument).toHaveBeenCalledWith(
            expect.objectContaining({ data: new Uint8Array(bytes) }),
        );
    });
});
