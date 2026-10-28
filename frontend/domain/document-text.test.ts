import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveSnapshot } from "../archive/archive";
import { makeAssetImport } from "./assets";
import { extractDocumentText } from "./document-text";

const pdfMocks = vi.hoisted(() => ({ getDocument: vi.fn(), destroy: vi.fn() }));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfMocks.getDocument,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfMocks.getDocument,
}));

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function makeDocx(xml: string, level: 0 | 6 = 6): Uint8Array {
  return zipSync({ "word/document.xml": strToU8(xml) }, { level });
}

describe("document text extraction", () => {
  beforeEach(() => {
    pdfMocks.getDocument.mockReset();
    pdfMocks.destroy.mockReset().mockResolvedValue(undefined);
  });

  it.each([0, 6] as const)(
    "extracts bounded text from a DOCX ZIP using compression level %i",
    async (level) => {
      const xml =
        "<w:document><w:body><w:p><w:r><w:t>Hello &amp; &#x1F600;</w:t></w:r>" +
        "<w:r><w:tab/></w:r><w:r><w:t>world</w:t><w:br/><w:t>again</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>";
      await expect(
        extractDocumentText("notes.docx", DOCX_MIME, makeDocx(xml, level)),
      ).resolves.toEqual({
        status: "extracted",
        text: "Hello & 😀\tworld\nagain\nSecond",
      });
    },
  );

  it("reports a valid Word document with no readable text", async () => {
    const result = await extractDocumentText(
      "blank.docx",
      DOCX_MIME,
      makeDocx("<w:document><w:body><w:p><w:r><w:tab/></w:r></w:p></w:body></w:document>"),
    );
    expect(result).toEqual({ status: "no-text", text: "" });
  });

  it("stores extracted text on the material metadata record", async () => {
    const bytes = makeDocx(
      "<w:document><w:body><w:p><w:r><w:t>Saved material text</w:t></w:r></w:p></w:body></w:document>",
    );
    const snapshot = {
      getRecordByIndexKey: vi.fn().mockResolvedValue(null),
    } as unknown as ArchiveSnapshot;
    const imported = await makeAssetImport(snapshot, {
      name: "notes.docx",
      size: bytes.byteLength,
      readBytes: async () => bytes,
    });
    expect(imported.metadata.fields.get("text_extraction_status")).toBe("extracted");
    expect(imported.metadata.fields.get("extracted_text")).toBe("Saved material text");
  });

  it("rejects invalid XML entities and mismatched ZIP checksums", async () => {
    const invalidEntity = makeDocx(
      "<w:document><w:body><w:p><w:r><w:t>&unknown;</w:t></w:r></w:p></w:body></w:document>",
    );
    await expect(extractDocumentText("bad.docx", DOCX_MIME, invalidEntity)).rejects.toThrow(
      "invalid XML entity",
    );

    const corrupt = makeDocx(
      "<w:document><w:body><w:p><w:r><w:t>Integrity</w:t></w:r></w:p></w:body></w:document>",
    );
    const centralDirectory = corrupt.findIndex(
      (byte, index) =>
        byte === 0x50 &&
        corrupt[index + 1] === 0x4b &&
        corrupt[index + 2] === 0x01 &&
        corrupt[index + 3] === 0x02,
    );
    expect(centralDirectory).toBeGreaterThanOrEqual(0);
    corrupt[centralDirectory + 16] = (corrupt[centralDirectory + 16] ?? 0) ^ 0xff;
    await expect(extractDocumentText("bad.docx", DOCX_MIME, corrupt)).rejects.toThrow(
      "checksum does not match",
    );
  });

  it("enforces archive and extracted text size limits", async () => {
    const exactLimitXml = `<w:document><w:body><w:p><w:r><w:t>${"x".repeat(2 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`;
    const exactLimitResult = await extractDocumentText(
      "exact-limit.docx",
      DOCX_MIME,
      makeDocx(exactLimitXml),
    );
    expect(exactLimitResult?.status).toBe("extracted");
    expect(exactLimitResult?.text).toHaveLength(2 * 1024 * 1024);

    const oversizedXml = `<w:document><w:body><w:p><w:r><w:t>${"x".repeat(4 * 1024 * 1024 + 1)}</w:t></w:r></w:p></w:body></w:document>`;
    await expect(
      extractDocumentText("large.docx", DOCX_MIME, makeDocx(oversizedXml)),
    ).resolves.toEqual({
      status: "size-limit",
      text: "",
    });
    const oversizedText = `<w:document><w:body><w:p><w:r><w:t>${"x".repeat(2 * 1024 * 1024 + 1)}</w:t></w:r></w:p></w:body></w:document>`;
    await expect(
      extractDocumentText("text-limit.docx", DOCX_MIME, makeDocx(oversizedText)),
    ).resolves.toEqual({
      status: "size-limit",
      text: "",
    });
    await expect(
      extractDocumentText("large.pdf", "application/pdf", new Uint8Array(16 * 1024 * 1024 + 1)),
    ).resolves.toEqual({
      status: "size-limit",
      text: "",
    });
  });

  it("keeps PDF page, text, and item processing within limits", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const pageLimitDocument = {
      numPages: 513,
      getPage: vi.fn(),
    };
    pdfMocks.getDocument.mockReturnValue({
      promise: Promise.resolve(pageLimitDocument),
      destroy: pdfMocks.destroy,
    });
    await expect(extractDocumentText("pages.pdf", "application/pdf", bytes)).resolves.toEqual({
      status: "size-limit",
      text: "",
    });
    expect(pageLimitDocument.getPage).not.toHaveBeenCalled();

    const exactLimitText = "x".repeat(2 * 1024 * 1024);
    const exactLimitPage = {
      streamTextContent: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ items: [{ str: exactLimitText, hasEOL: true }] });
            controller.close();
          },
        }),
      cleanup: vi.fn(),
    };
    pdfMocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue(exactLimitPage) }),
      destroy: pdfMocks.destroy,
    });
    const exactResult = await extractDocumentText("text-limit.pdf", "application/pdf", bytes);
    expect(exactResult?.status).toBe("extracted");
    expect(exactResult?.text).toHaveLength(2 * 1024 * 1024);

    const manyItems = Array.from({ length: 200_001 }, () => ({ str: "", hasEOL: false }));
    const itemLimitPage = {
      streamTextContent: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ items: manyItems });
            controller.close();
          },
        }),
      cleanup: vi.fn(),
    };
    pdfMocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue(itemLimitPage) }),
      destroy: pdfMocks.destroy,
    });
    await expect(extractDocumentText("items.pdf", "application/pdf", bytes)).resolves.toEqual({
      status: "size-limit",
      text: "",
    });
  });

  it("extracts text from a valid PDF and reports malformed documents", async () => {
    const page = {
      streamTextContent: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ items: [{ str: "PDF text works", hasEOL: true }] });
            controller.close();
          },
        }),
      cleanup: vi.fn(),
    };
    const document = { numPages: 1, getPage: vi.fn().mockResolvedValue(page) };
    pdfMocks.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: pdfMocks.destroy,
    });
    await expect(
      extractDocumentText("lesson.pdf", "application/pdf", new Uint8Array([1, 2, 3])),
    ).resolves.toEqual({
      status: "extracted",
      text: "PDF text works",
    });
    expect(pdfMocks.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        data: new Uint8Array([1, 2, 3]),
        stopAtErrors: true,
        enableXfa: false,
        useWorkerFetch: false,
        useSystemFonts: false,
      }),
    );
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(pdfMocks.destroy).toHaveBeenCalledOnce();

    pdfMocks.getDocument.mockReturnValue({
      promise: Promise.reject(new Error("invalid PDF")),
      destroy: pdfMocks.destroy,
    });
    await expect(
      extractDocumentText("broken.pdf", "application/pdf", new TextEncoder().encode("%PDF broken")),
    ).rejects.toThrow("malformed, encrypted, or cannot be parsed");
  });
});
