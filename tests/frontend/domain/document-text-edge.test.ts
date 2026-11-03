import { deflateSync, strToU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { crc32 } from "../../../frontend/archive/format";
import {
    configurePdfWorkerSource,
    extractDocumentText,
} from "../../../frontend/domain/document-text";

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

interface ZipEntry {
    name: string;
    content: Uint8Array;
    method?: number;
    flags?: number;
    compressed?: Uint8Array;
    crc?: number;
}

interface BuiltZip {
    bytes: Uint8Array;
    localOffsets: number[];
    centralOffsets: number[];
    eocdOffset: number;
}

function buildZip(
    entries: readonly ZipEntry[],
    overrides: {
        disk?: number;
        directoryDisk?: number;
        diskEntries?: number;
        entryCount?: number;
        directorySize?: number;
        directoryOffset?: number;
    } = {},
): BuiltZip {
    const localOffsets: number[] = [];
    const centralOffsets: number[] = [];
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = strToU8(entry.name);
        const data = entry.compressed ?? entry.content;
        const crc = entry.crc ?? crc32(entry.content);
        const local = new Uint8Array(30 + name.byteLength);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, entry.flags ?? 0, true);
        localView.setUint16(8, entry.method ?? 0, true);
        localView.setUint32(14, crc, true);
        localView.setUint32(18, data.byteLength, true);
        localView.setUint32(22, entry.content.byteLength, true);
        localView.setUint16(26, name.byteLength, true);
        local.set(name, 30);
        localOffsets.push(offset);
        localParts.push(local, data);
        offset += local.byteLength + data.byteLength;
    }

    const directoryOffset = offset;
    for (const [index, entry] of entries.entries()) {
        const name = strToU8(entry.name);
        const data = entry.compressed ?? entry.content;
        const crc = entry.crc ?? crc32(entry.content);
        const central = new Uint8Array(46 + name.byteLength);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, entry.flags ?? 0, true);
        centralView.setUint16(10, entry.method ?? 0, true);
        centralView.setUint32(16, crc, true);
        centralView.setUint32(20, data.byteLength, true);
        centralView.setUint32(24, entry.content.byteLength, true);
        centralView.setUint16(28, name.byteLength, true);
        centralView.setUint32(42, localOffsets[index]!, true);
        central.set(name, 46);
        centralOffsets.push(offset);
        centralParts.push(central);
        offset += central.byteLength;
    }

    const directorySize = offset - directoryOffset;
    const eocdOffset = offset;
    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, overrides.disk ?? 0, true);
    view.setUint16(6, overrides.directoryDisk ?? 0, true);
    view.setUint16(8, overrides.diskEntries ?? entries.length, true);
    view.setUint16(10, overrides.entryCount ?? entries.length, true);
    view.setUint32(12, overrides.directorySize ?? directorySize, true);
    view.setUint32(16, overrides.directoryOffset ?? directoryOffset, true);

    const bytes = concat([...localParts, ...centralParts, eocd]);
    return { bytes, localOffsets, centralOffsets, eocdOffset };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    return bytes;
}

function mutate(zip: BuiltZip): Uint8Array {
    return zip.bytes.slice();
}

function setU16(bytes: Uint8Array, offset: number, value: number): void {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function storedZip(xml: string, name = "word/document.xml"): BuiltZip {
    return buildZip([{ name, content: strToU8(xml) }]);
}

function docx(xml: string): Uint8Array {
    return storedZip(xml).bytes;
}

function documentXml(inner: string): string {
    return `<w:document><w:body>${inner}</w:body></w:document>`;
}

function textParagraph(text: string): string {
    return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

async function expectFailure(bytes: Uint8Array, pattern: RegExp): Promise<void> {
    await expect(extractDocumentText("bad.docx", DOCX_MIME, bytes)).rejects.toThrow(pattern);
}

describe("document text DOCX structure guards", () => {
    it("rejects missing or malformed ZIP end directories", async () => {
        await expectFailure(new Uint8Array([1, 2, 3]), /ZIP directory is missing/u);
        await expectFailure(new Uint8Array(32), /end directory is invalid/u);

        const zip = storedZip(documentXml(textParagraph("ok")));
        const bytes = mutate(zip);
        setU16(bytes, zip.eocdOffset + 20, 5);
        await expectFailure(bytes, /end directory is invalid/u);
    });

    it("rejects invalid ZIP directory bounds", async () => {
        const zip = storedZip(documentXml(textParagraph("ok")));
        const cases: ((bytes: Uint8Array) => void)[] = [
            (bytes) => setU16(bytes, zip.eocdOffset + 4, 1),
            (bytes) => setU16(bytes, zip.eocdOffset + 6, 1),
            (bytes) => setU16(bytes, zip.eocdOffset + 8, 0),
            (bytes) => {
                setU16(bytes, zip.eocdOffset + 8, 0);
                setU16(bytes, zip.eocdOffset + 10, 0);
            },
            (bytes) => {
                setU16(bytes, zip.eocdOffset + 8, 2049);
                setU16(bytes, zip.eocdOffset + 10, 2049);
            },
            (bytes) => setU32(bytes, zip.eocdOffset + 12, 0xffff_ffff),
            (bytes) => setU32(bytes, zip.eocdOffset + 16, 0xffff_ffff),
            (bytes) => setU32(bytes, zip.eocdOffset + 16, zip.eocdOffset - 4),
        ];
        for (const apply of cases) {
            const bytes = mutate(zip);
            apply(bytes);
            await expectFailure(bytes, /unsupported or invalid bounds/u);
        }
    });

    it("rejects invalid central directory entries", async () => {
        const zip = storedZip(documentXml(textParagraph("ok")));
        const central = zip.centralOffsets[0]!;

        const wrongSignature = mutate(zip);
        setU32(wrongSignature, central, 0x01020304);
        await expectFailure(wrongSignature, /central directory entry is invalid/u);

        const oversizedRecord = mutate(zip);
        setU16(oversizedRecord, central + 32, 0xffff);
        await expectFailure(oversizedRecord, /exceeds its bounds/u);

        const nonzeroDisk = mutate(zip);
        setU16(nonzeroDisk, central + 34, 1);
        await expectFailure(nonzeroDisk, /exceeds its bounds/u);
    });

    it("rejects duplicate or missing main document entries", async () => {
        const duplicate = buildZip([
            { name: "word/document.xml", content: strToU8(documentXml(textParagraph("a"))) },
            { name: "word/document.xml", content: strToU8(documentXml(textParagraph("b"))) },
        ]);
        await expectFailure(duplicate.bytes, /duplicate main document entries/u);

        const missing = buildZip([{ name: "word/other.xml", content: strToU8("<other/>") }]);
        await expectFailure(missing.bytes, /no valid word\/document\.xml entry/u);

        const wrongCharacters = buildZip([
            { name: "word/document.xmX", content: strToU8(documentXml(textParagraph("a"))) },
        ]);
        await expectFailure(wrongCharacters.bytes, /no valid word\/document\.xml entry/u);

        const extraEntry = buildZip(
            [
                { name: "word/other.xml", content: strToU8("<other/>") },
                { name: "word/document.xml", content: strToU8(documentXml(textParagraph("a"))) },
            ],
            { entryCount: 1, diskEntries: 1 },
        );
        await expectFailure(extraEntry.bytes, /no valid word\/document\.xml entry/u);
    });

    it("rejects unsupported central directory features", async () => {
        const zip = storedZip(documentXml(textParagraph("ok")));
        const central = zip.centralOffsets[0]!;
        const cases: ((bytes: Uint8Array) => void)[] = [
            (bytes) => setU16(bytes, central + 8, 1),
            (bytes) => setU16(bytes, central + 8, 0x40),
            (bytes) => setU16(bytes, central + 10, 12),
            (bytes) => setU32(bytes, central + 20, 16 * 1024 * 1024 + 1),
            (bytes) => setU32(bytes, central + 20, 0),
            (bytes) => setU32(bytes, central + 24, 0),
            (bytes) => setU32(bytes, central + 42, zip.eocdOffset),
        ];
        for (const apply of cases) {
            const bytes = mutate(zip);
            apply(bytes);
            await expectFailure(bytes, /unsupported or invalid ZIP features/u);
        }
    });

    it("reports oversized uncompressed documents as a size limit", async () => {
        const zip = storedZip(documentXml(textParagraph("ok")));
        const bytes = mutate(zip);
        setU32(bytes, zip.centralOffsets[0]! + 24, 4 * 1024 * 1024 + 1);
        await expect(extractDocumentText("big.docx", DOCX_MIME, bytes)).resolves.toEqual({
            status: "size-limit",
            text: "",
        });
    });

    it("rejects inconsistent local headers", async () => {
        const zip = storedZip(documentXml(textParagraph("ok")));
        const central = zip.centralOffsets[0]!;
        const local = zip.localOffsets[0]!;
        const cases: { apply: (bytes: Uint8Array) => void; pattern: RegExp }[] = [
            {
                apply: (bytes) => setU32(bytes, local, 0x04034b51),
                pattern: /unsupported or invalid ZIP features/u,
            },
            {
                apply: (bytes) => setU16(bytes, local + 6, 0x800),
                pattern: /local header is inconsistent/u,
            },
            {
                apply: (bytes) => setU16(bytes, local + 8, 12),
                pattern: /local header is inconsistent/u,
            },
            {
                apply: (bytes) => setU16(bytes, local + 26, 10),
                pattern: /local header is inconsistent/u,
            },
            {
                apply: (bytes) => setU16(bytes, local + 28, 0xffff),
                pattern: /local header is inconsistent/u,
            },
            {
                apply: (bytes) => setU32(bytes, central + 20, zip.eocdOffset),
                pattern: /local header is inconsistent/u,
            },
            {
                apply: (bytes) => setU32(bytes, local + 30, 0x7a7a7a7a),
                pattern: /local header is inconsistent/u,
            },
        ];
        for (const { apply, pattern } of cases) {
            const bytes = mutate(zip);
            apply(bytes);
            await expectFailure(bytes, pattern);
        }
    });

    it("rejects stored documents with mismatched sizes", async () => {
        const zip = storedZip(documentXml(textParagraph("ok")));
        const bytes = mutate(zip);
        setU32(bytes, zip.centralOffsets[0]! + 24, zip.bytes.byteLength + 100);
        await expectFailure(bytes, /stored document has inconsistent sizes/u);
    });

    it("rejects invalid deflate streams and inflated size mismatches", async () => {
        const xml = documentXml(textParagraph("deflated"));
        const content = strToU8(xml);
        const invalid = buildZip([
            {
                name: "word/document.xml",
                content,
                method: 8,
                compressed: new Uint8Array([1, 2, 3, 4]),
            },
        ]);
        await expectFailure(invalid.bytes, /deflate stream is invalid/u);

        const deflated = deflateSync(content);
        const mismatch = buildZip([
            { name: "word/document.xml", content, method: 8, compressed: deflated },
        ]);
        const bytes = mutate(mismatch);
        setU32(bytes, mismatch.centralOffsets[0]! + 24, content.byteLength + 5);
        await expectFailure(bytes, /deflate stream has inconsistent sizes/u);
    });

    it("rejects invalid UTF-8 and strips a UTF-8 BOM", async () => {
        const invalid = buildZip([
            { name: "word/document.xml", content: new Uint8Array([0xff, 0xfe]) },
        ]);
        await expectFailure(invalid.bytes, /not valid UTF-8/u);

        const withBom = storedZip(`\uFEFF${documentXml(textParagraph("bom"))}`);
        await expect(extractDocumentText("bom.docx", DOCX_MIME, withBom.bytes)).resolves.toEqual({
            status: "extracted",
            text: "bom",
        });
    });

    it("rejects invalid XML characters", async () => {
        await expectFailure(
            docx(documentXml(textParagraph("bad\u0001char"))),
            /invalid XML character/u,
        );
    });
});

describe("document text DOCX XML parsing", () => {
    it.each([
        {
            name: "unterminated text at the end",
            xml: "<w:document><w:t>abc",
        },
        {
            name: "unterminated comment",
            xml: "<w:document><!-- open",
        },
        {
            name: "unterminated CDATA",
            xml: "<w:document><![CDATA[open",
        },
        {
            name: "unterminated processing instruction",
            xml: "<w:document><?pi",
        },
        {
            name: "unsupported declaration",
            xml: '<?xml version="1.0"?><!DOCTYPE w:document><w:document></w:document>',
        },
        {
            name: "unterminated tag",
            xml: "<w:document><oops",
        },
        {
            name: "invalid element name",
            xml: "<w:document>< >",
        },
        {
            name: "overlong element name",
            xml: `<w:document><${"a".repeat(257)}/>`,
        },
        {
            name: "mismatched closing element",
            xml: "<w:document><w:p></w:t></w:document>",
        },
        {
            name: "wrong document root",
            xml: "<w:body></w:body>",
        },
        {
            name: "content after the root closes",
            xml: "<w:document></w:document><w:p/>",
        },
        {
            name: "invalid attribute",
            xml: "<w:document a=<b></w:document>",
        },
        {
            name: "unterminated attribute",
            xml: '<w:document a="x>',
        },
        {
            name: "incomplete document",
            xml: "<w:document><w:p>",
        },
    ])("rejects $name", async ({ xml }) => {
        await expectFailure(docx(xml), /DOCX/u);
    });

    it("rejects deeper elements than the nesting limit", async () => {
        const nested = `<w:document>${"<a>".repeat(256)}`;
        await expectFailure(docx(nested), /nesting exceeds the supported limit/u);
    });

    it("reads comments, CDATA, and processing instructions", async () => {
        const xml = `<?xml version="1.0"?><w:document><!-- note --><w:body><w:p><w:r><w:t><![CDATA[a & b]]></w:t></w:r></w:p></w:body></w:document>`;
        await expect(extractDocumentText("ok.docx", DOCX_MIME, docx(xml))).resolves.toEqual({
            status: "extracted",
            text: "a & b",
        });
    });

    it("enforces the extracted text limit inside CDATA", async () => {
        const cdata = `<w:document><w:t><![CDATA[${"x".repeat(2 * 1024 * 1024 + 1)}]]></w:t></w:document>`;
        await expect(extractDocumentText("big.docx", DOCX_MIME, docx(cdata))).resolves.toEqual({
            status: "size-limit",
            text: "",
        });
    });

    it("enforces the extracted text limit for an unterminated text run", async () => {
        const tail = `<w:document><w:t>${"x".repeat(2 * 1024 * 1024 + 1)}`;
        await expect(extractDocumentText("big.docx", DOCX_MIME, docx(tail))).resolves.toEqual({
            status: "size-limit",
            text: "",
        });
    });

    it("handles text after the root and self-closing paragraphs", async () => {
        const trailing = "<w:document><w:body></w:body></w:document>ignored";
        await expect(extractDocumentText("ok.docx", DOCX_MIME, docx(trailing))).resolves.toEqual({
            status: "no-text",
            text: "",
        });

        const selfClosing = documentXml(
            `<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>B</w:t></w:r></w:p>`,
        );
        await expect(extractDocumentText("ok.docx", DOCX_MIME, docx(selfClosing))).resolves.toEqual(
            { status: "extracted", text: "A\nB" },
        );

        const leadingBreak = documentXml(`<w:p/><w:p><w:r><w:t>A</w:t></w:r></w:p>`);
        await expect(
            extractDocumentText("ok.docx", DOCX_MIME, docx(leadingBreak)),
        ).resolves.toEqual({ status: "extracted", text: "A" });

        const trailingNewline = documentXml(
            `<w:p><w:r><w:t>A\n</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p>`,
        );
        await expect(
            extractDocumentText("ok.docx", DOCX_MIME, docx(trailingNewline)),
        ).resolves.toEqual({ status: "extracted", text: "A\nB" });
    });

    it("accepts quoted attributes", async () => {
        const xml = `<w:document xmlns="urn:test" data='x y'><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:document>`;
        await expect(extractDocumentText("ok.docx", DOCX_MIME, docx(xml))).resolves.toEqual({
            status: "extracted",
            text: "ok",
        });
    });

    it("decodes every supported XML entity form", async () => {
        const entities = "&amp;&lt;&gt;&quot;&apos;&#65;&#x41;&#X42;";
        await expect(
            extractDocumentText("ok.docx", DOCX_MIME, docx(documentXml(textParagraph(entities)))),
        ).resolves.toEqual({ status: "extracted", text: "&<>\"'AAB" });
    });

    it.each([
        ["&amp", /invalid XML entity/u],
        [`&${"a".repeat(16)};`, /invalid XML entity/u],
        ["&#;", /invalid XML entity/u],
        ["&#x;", /invalid XML entity/u],
        ["&#xZZ;", /invalid XML entity/u],
        ["&#999999999999999999999;", /invalid XML entity/u],
        ["&#0;", /invalid XML entity/u],
        ["&#x110000;", /invalid XML entity/u],
        ["&AMP;", /invalid XML entity/u],
    ])("rejects the XML entity %s", async (entity, pattern) => {
        await expectFailure(docx(documentXml(textParagraph(entity))), pattern);
    });

    it("rejects oversized DOCX input bytes before parsing", async () => {
        await expect(
            extractDocumentText("huge.docx", DOCX_MIME, new Uint8Array(16 * 1024 * 1024 + 1)),
        ).resolves.toEqual({ status: "size-limit", text: "" });
    });

    it("returns null for unrelated documents", async () => {
        await expect(
            extractDocumentText("notes.txt", "text/plain", new Uint8Array([1])),
        ).resolves.toBeNull();
    });
});

describe("document text PDF parsing", () => {
    beforeEach(() => {
        pdfMocks.getDocument.mockReset();
        pdfMocks.destroy.mockReset().mockResolvedValue(undefined);
        vi.unstubAllGlobals();
        configurePdfWorkerSource("");
    });

    function pdfPage(
        items: readonly unknown[],
        options: { close?: boolean; rejectCancel?: boolean } = {},
    ) {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue({ items });
                if (options.close !== false) controller.close();
            },
            cancel() {
                if (options.rejectCancel) return Promise.reject(new Error("cancel failed"));
                return undefined;
            },
        });
        return {
            streamTextContent: () => stream,
            cleanup: vi.fn(),
        };
    }

    function mockDocument(pages: readonly unknown[], destroy = pdfMocks.destroy) {
        pdfMocks.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pages.length,
                getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
            }),
            destroy,
        });
    }

    it("rejects empty PDF input", async () => {
        await expect(
            extractDocumentText("empty.pdf", "application/pdf", new Uint8Array()),
        ).rejects.toThrow(/PDF file is empty/u);
    });

    it("loads the modern PDF module in a browser context and configures its worker", async () => {
        vi.stubGlobal("window", {});
        configurePdfWorkerSource("worker.js");
        mockDocument([pdfPage([{ str: "browser text", hasEOL: false }])]);
        const modern = await import("pdfjs-dist");
        await expect(
            extractDocumentText("browser.pdf", "application/pdf", new Uint8Array([1])),
        ).resolves.toEqual({ status: "extracted", text: "browser text" });
        expect(modern.GlobalWorkerOptions.workerSrc).toBe("worker.js");
    });

    it("loads the legacy PDF module outside a browser context", async () => {
        vi.stubGlobal("window", undefined);
        configurePdfWorkerSource("legacy-worker.js");
        mockDocument([pdfPage([{ str: "node text", hasEOL: false }])]);
        const legacy = await import("pdfjs-dist/legacy/build/pdf.mjs");
        await expect(
            extractDocumentText("node.pdf", "application/pdf", new Uint8Array([1])),
        ).resolves.toEqual({ status: "extracted", text: "node text" });
        expect(legacy.GlobalWorkerOptions.workerSrc).toBe("legacy-worker.js");
    });

    it("detects PDFs by extension when the MIME type is generic", async () => {
        mockDocument([pdfPage([{ str: "extension pdf", hasEOL: false }])]);
        await expect(
            extractDocumentText("extension.pdf", "application/octet-stream", new Uint8Array([1])),
        ).resolves.toEqual({ status: "extracted", text: "extension pdf" });
    });

    it("skips items without text and appends page separators", async () => {
        mockDocument([
            pdfPage([{}, { str: "" }, { str: "first", hasEOL: false }]),
            pdfPage([{ str: "second", hasEOL: false }]),
        ]);
        await expect(
            extractDocumentText("pages.pdf", "application/pdf", new Uint8Array([1])),
        ).resolves.toEqual({ status: "extracted", text: "first\nsecond" });
    });

    it("stops when a single text item exceeds the byte limit", async () => {
        mockDocument([pdfPage([{ str: "x".repeat(2 * 1024 * 1024 + 1), hasEOL: false }])]);
        await expect(
            extractDocumentText("long.pdf", "application/pdf", new Uint8Array([1])),
        ).resolves.toEqual({ status: "size-limit", text: "" });
    });

    it("stops when multibyte text no longer fits", async () => {
        mockDocument([
            pdfPage([
                { str: "x".repeat(2 * 1024 * 1024 - 1), hasEOL: false },
                { str: "é", hasEOL: false },
            ]),
        ]);
        await expect(
            extractDocumentText("bytes.pdf", "application/pdf", new Uint8Array([1])),
        ).resolves.toEqual({ status: "size-limit", text: "" });
    });

    it("cancels an unfinished text stream and ignores cancellation failures", async () => {
        const items = Array.from({ length: 200_001 }, () => ({ str: "", hasEOL: false }));
        mockDocument([pdfPage(items, { close: false, rejectCancel: true })]);
        await expect(
            extractDocumentText("items.pdf", "application/pdf", new Uint8Array([1])),
        ).resolves.toEqual({ status: "size-limit", text: "" });
    });

    it("ignores a destroy failure after parsing", async () => {
        mockDocument(
            [pdfPage([{ str: "destroy", hasEOL: false }])],
            vi.fn().mockRejectedValue(new Error("destroy failed")),
        );
        await expect(
            extractDocumentText("destroy.pdf", "application/pdf", new Uint8Array([1])),
        ).resolves.toEqual({ status: "extracted", text: "destroy" });
    });
});

describe("document text DOCX BOM handling", () => {
    it("strips the additional BOM character left when two BOMs are encoded", async () => {
        const doubleBom = storedZip(`\uFEFF\uFEFF${documentXml(textParagraph("bom"))}`);
        await expect(extractDocumentText("bom.docx", DOCX_MIME, doubleBom.bytes)).resolves.toEqual({
            status: "extracted",
            text: "bom",
        });
    });
});
