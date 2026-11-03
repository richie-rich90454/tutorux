import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    guideImageIds,
    renderGuideDocx,
    serializeGuideJson,
} from "../../../frontend/domain/guide-export";
import type { GuideExportImage } from "../../../frontend/domain/guides";

const guideId = "9fd18de8-42ef-41b5-af46-0a24344c7a3e";
const imageId = "44413a60-5500-499d-8b9e-5478da537bc5";
const sourceId = "88f455d6-63cf-4eb3-9628-23271e50f301";

function record(
    blocks: readonly { kind: string; text: string; sourceIds?: string }[],
): ArchiveRecord {
    const fields = new Map<string, string>([
        ["title", "Ratios & visual models"],
        ["template_id", "mathematics"],
        ["approval_state", "draft"],
        ["section_count", "1"],
        ["section.0.heading", "Compare quantities"],
        ["section.0.block_count", String(blocks.length)],
    ]);
    blocks.forEach((block, index) => {
        const prefix = `section.0.block.${index}.`;
        fields.set(`${prefix}kind`, block.kind);
        fields.set(`${prefix}text`, block.text);
        fields.set(`${prefix}source_ids`, block.sourceIds ?? "");
        fields.set(`${prefix}stale`, "false");
        fields.set(`${prefix}origin`, "tutor-authored");
    });
    return {
        type: RecordType.guide,
        id: guideId,
        revision: 7n,
        previousOffset: 128n,
        fields,
        blob: new Uint8Array(),
    };
}

function png(): Uint8Array {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
    bytes.set([0, 0, 0, 64], 16);
    bytes.set([0, 0, 0, 32], 20);
    return bytes;
}

describe("study guide exports", () => {
    it("serializes the complete legacy-compatible record as JSON", () => {
        const guide = record([{ kind: "paragraph", text: "Scale both quantities." }]);
        const parsed = JSON.parse(serializeGuideJson(guide)) as Record<string, unknown>;
        expect(parsed).toMatchObject({
            id: guideId,
            type: "guide",
            revision: "7",
            title: "Ratios & visual models",
            "section.0.block.0.text": "Scale both quantities.",
        });
        expect(serializeGuideJson(guide).endsWith("\n")).toBe(true);
    });

    it("writes Word tables, citation cues, and deduplicated embedded images", () => {
        const guide = record([
            {
                kind: "table",
                text: "| Ratio | Value |\n| --- | --- |\n| 2:3 | 6 |",
                sourceIds: sourceId,
            },
            { kind: "figure", text: `![Bar model](asset:${imageId})`, sourceIds: imageId },
            { kind: "image", text: `![Bar model](asset:${imageId})`, sourceIds: imageId },
        ]);
        const image: GuideExportImage = { assetId: imageId, mimeType: "image/png", bytes: png() };
        expect(guideImageIds(guide)).toEqual([imageId]);

        const files = unzipSync(renderGuideDocx(guide, new Map([[imageId, image]])));
        const document = strFromU8(files["word/document.xml"]!);
        const relationships = strFromU8(files["word/_rels/document.xml.rels"]!);
        const contentTypes = strFromU8(files["[Content_Types].xml"]!);
        expect(document).toContain("<w:tbl>");
        expect(document).toContain("Ratio");
        expect(document).toContain("Source: ");
        expect(document).toContain('r:embed="rId2"');
        expect(relationships.match(/relationships\/image/gu)).toHaveLength(1);
        expect(contentTypes).toContain("image/png");
        expect(files[`word/media/${imageId}.png`]).toEqual(image.bytes);
    });

    it("rejects missing images and XML-invalid text instead of producing broken Word files", () => {
        const imageGuide = record([{ kind: "image", text: `![missing](asset:${imageId})` }]);
        expect(() => renderGuideDocx(imageGuide, new Map())).toThrow(/missing from this archive/u);

        const controlTextGuide = record([{ kind: "paragraph", text: "Invalid\u0001text" }]);
        expect(() => renderGuideDocx(controlTextGuide, new Map())).toThrow(
            /Word cannot represent/u,
        );
    });

    it("rejects JPEG image data that is too short to contain dimensions", () => {
        const guide = record([{ kind: "image", text: `![Odd](asset:${imageId})` }]);
        const image: GuideExportImage = {
            assetId: imageId,
            mimeType: "image/jpeg",
            bytes: new Uint8Array([0xff]),
        };
        expect(() => renderGuideDocx(guide, new Map([[imageId, image]]))).toThrow(
            "dimensions of a guide image could not be read",
        );
    });
});

interface RichBlock {
    kind: string;
    text: string;
    sourceIds?: string;
    stale?: boolean;
    origin?: string;
}

function richRecord(blocks: readonly RichBlock[], title = "Guide title"): ArchiveRecord {
    const fields = new Map<string, string>([
        ["title", title],
        ["template_id", "general"],
        ["approval_state", "approved"],
        ["section_count", "1"],
        ["section.0.heading", "Section"],
        ["section.0.block_count", String(blocks.length)],
    ]);
    blocks.forEach((block, index) => {
        const prefix = `section.0.block.${index}.`;
        fields.set(`${prefix}kind`, block.kind);
        fields.set(`${prefix}text`, block.text);
        fields.set(`${prefix}source_ids`, block.sourceIds ?? "");
        fields.set(`${prefix}stale`, block.stale ? "true" : "false");
        fields.set(`${prefix}origin`, block.origin ?? "tutor-authored");
    });
    return {
        type: RecordType.guide,
        id: guideId,
        revision: 1n,
        previousOffset: 0n,
        fields,
        blob: new Uint8Array(),
    };
}

describe("study guide export edge cases", () => {
    it("rejects non-guide records and empty titles", () => {
        const guide = richRecord([]);
        expect(() => serializeGuideJson({ ...guide, type: RecordType.settings })).toThrow(
            "Only a study guide",
        );
        expect(() => renderGuideDocx({ ...guide, type: RecordType.settings }, new Map())).toThrow(
            "Only a study guide",
        );
        expect(() => renderGuideDocx(richRecord([], "   "), new Map())).toThrow("without a title");
    });

    it("rejects images without single asset references", () => {
        expect(() => guideImageIds(richRecord([{ kind: "image", text: "no reference" }]))).toThrow(
            "archive asset UUID",
        );
        expect(() =>
            renderGuideDocx(richRecord([{ kind: "figure", text: "no reference" }]), new Map()),
        ).toThrow("archive asset UUID");
        expect(guideImageIds(richRecord([{ kind: "paragraph", text: "plain" }]))).toEqual([]);
    });

    it("renders every block style, labels, warnings, and citations", () => {
        const guide = richRecord([
            { kind: "instruction", text: "Do this", origin: "tutor-authored", sourceIds: sourceId },
            { kind: "paragraph", text: "line one\n\nline two" },
            { kind: "quote", text: "Quoted" },
            { kind: "code", text: "x = 1" },
            { kind: "equation", text: "a = b" },
            { kind: "list-item", text: "Item" },
            { kind: "list-item", text: "Labeled", origin: "tutor-authored", stale: true },
            {
                kind: "table",
                text: "| A | B |\n| --- | --- |\n| 1 | 2 |",
                origin: "tutor-authored",
                sourceIds: sourceId,
            },
        ]);
        const files = unzipSync(renderGuideDocx(guide, new Map()));
        const document = strFromU8(files["word/document.xml"]!);
        expect(document).toContain("Tutor instruction");
        expect(document).toContain("<w:br/>");
        expect(document).toContain("Quote");
        expect(document).toContain("• Item");
        expect(document).toContain("Source changed");
        expect(document).toContain("approved");
    });

    it("parses escaped table cells and rejects malformed tables", () => {
        const guide = richRecord([
            {
                kind: "table",
                text: "| a\\|b | c\\\\d |\n| --- | :---: |\n| 1 | 2 |",
            },
        ]);
        const files = unzipSync(renderGuideDocx(guide, new Map()));
        expect(strFromU8(files["word/document.xml"]!)).toContain("a|b");

        for (const table of [
            "| A |\n| B |",
            "| A | B |\n| --- | --- |\n| only |",
            "single line",
            "| A | B |\nnot a separator\n| 1 | 2 |",
        ]) {
            expect(() =>
                renderGuideDocx(richRecord([{ kind: "table", text: table }]), new Map()),
            ).toThrow("guide table");
        }
    });

    it("detects JPEG, GIF, and WebP dimensions", () => {
        const jpeg = new Uint8Array([
            0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x40, 0x00, 0x20, 0x00,
        ]);
        const gif = new Uint8Array(10);
        gif.set([0x47, 0x49, 0x46], 0);
        gif[6] = 64;
        gif[8] = 32;
        const vp8x = new Uint8Array(30);
        vp8x.set([0x52, 0x49, 0x46, 0x46], 0);
        vp8x.set([0x57, 0x45, 0x42, 0x50], 8);
        vp8x.set([0x56, 0x50, 0x38, 0x58], 12);
        vp8x[24] = 63;
        vp8x[27] = 31;
        const vp8l = new Uint8Array(30);
        vp8l.set([0x52, 0x49, 0x46, 0x46], 0);
        vp8l.set([0x57, 0x45, 0x42, 0x50], 8);
        vp8l.set([0x56, 0x50, 0x38, 0x4c], 12);
        vp8l[20] = 0x2f;
        vp8l[21] = 63;
        const vp8 = new Uint8Array(30);
        vp8.set([0x52, 0x49, 0x46, 0x46], 0);
        vp8.set([0x57, 0x45, 0x42, 0x50], 8);
        vp8.set([0x56, 0x50, 0x38, 0x20], 12);
        vp8[26] = 63;
        vp8[28] = 31;

        for (const [mimeType, bytes] of [
            ["image/jpeg", jpeg],
            ["image/jpg", jpeg],
            ["image/gif", gif],
            ["image/webp", vp8x],
            ["image/webp", vp8l],
            ["image/webp", vp8],
        ] as const) {
            const guide = richRecord([{ kind: "image", text: `![Alt](asset:${imageId})` }]);
            const files = unzipSync(
                renderGuideDocx(guide, new Map([[imageId, { assetId: imageId, mimeType, bytes }]])),
            );
            expect(
                files[
                    `word/media/${imageId}.${mimeType === "image/gif" ? "gif" : mimeType === "image/webp" ? "webp" : "jpeg"}`
                ],
            ).toBeTruthy();
        }
    });

    it("rejects unreadable or unsupported images", () => {
        const guide = richRecord([{ kind: "image", text: `![Alt](asset:${imageId})` }]);
        expect(() =>
            renderGuideDocx(
                guide,
                new Map([
                    [
                        imageId,
                        { assetId: imageId, mimeType: "image/bmp", bytes: new Uint8Array(4) },
                    ],
                ]),
            ),
        ).toThrow("Only PNG, JPEG, GIF, and WebP");
        expect(() =>
            renderGuideDocx(
                guide,
                new Map([
                    [
                        imageId,
                        { assetId: imageId, mimeType: "image/png", bytes: new Uint8Array(30) },
                    ],
                ]),
            ),
        ).toThrow("dimensions");
        expect(() =>
            renderGuideDocx(
                guide,
                new Map([
                    [
                        imageId,
                        {
                            assetId: imageId,
                            mimeType: "image/jpeg",
                            bytes: new Uint8Array([0xff, 0xd8]),
                        },
                    ],
                ]),
            ),
        ).toThrow("dimensions");
        expect(() =>
            renderGuideDocx(
                guide,
                new Map([
                    [
                        imageId,
                        { assetId: imageId, mimeType: "image/gif", bytes: new Uint8Array(10) },
                    ],
                ]),
            ),
        ).toThrow("dimensions");
    });

    it("labels AI-generated images and tables", () => {
        const guide = richRecord([
            { kind: "image", text: `![Alt](asset:${imageId})`, origin: "ai-generated" },
            { kind: "table", text: "| A |\n| --- |\n| 1 |", origin: "ai-generated" },
        ]);
        const document = strFromU8(
            unzipSync(
                renderGuideDocx(
                    guide,
                    new Map([[imageId, { assetId: imageId, mimeType: "image/png", bytes: png() }]]),
                ),
            )["word/document.xml"]!,
        );
        expect(document).toContain("AI-generated content");
    });

    it("parses escaped table characters", () => {
        const guide = richRecord([
            { kind: "table", text: "| a\\ b | c |\n| --- | --- |\n| 1 | 2 |" },
        ]);
        const document = strFromU8(
            unzipSync(renderGuideDocx(guide, new Map()))["word/document.xml"]!,
        );
        expect(document).toContain("a\\ b");

        const trailing = richRecord([{ kind: "table", text: "|a\\|\n| --- |\n| 1 |" }]);
        const trailingDocument = strFromU8(
            unzipSync(renderGuideDocx(trailing, new Map()))["word/document.xml"]!,
        );
        expect(trailingDocument).toContain("a\\");
    });

    it("handles JPEG marker edge cases", () => {
        const guide = richRecord([{ kind: "image", text: `![Alt](asset:${imageId})` }]);
        const render = (bytes: Uint8Array) =>
            renderGuideDocx(
                guide,
                new Map([[imageId, { assetId: imageId, mimeType: "image/jpeg", bytes }]]),
            );

        const junk = new Uint8Array([
            0xff, 0xd8, 0x00, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x40, 0x00, 0x20, 0x00,
        ]);
        expect(() => render(junk)).not.toThrow();

        const restart = new Uint8Array([
            0xff, 0xd8, 0xff, 0xd0, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x40, 0x00, 0x20,
        ]);
        expect(() => render(restart)).not.toThrow();

        const standalone = new Uint8Array([
            0xff, 0xd8, 0xff, 0x01, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x40, 0x00, 0x20,
        ]);
        expect(() => render(standalone)).not.toThrow();

        expect(() => render(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00]))).toThrow("dimensions");
        expect(() =>
            render(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x09, 0x08, 0x00, 0x40])),
        ).toThrow("dimensions");
    });

    it("escapes private-use and astral characters", () => {
        const guide = richRecord([{ kind: "paragraph", text: "\uE000 😀" }]);
        const document = strFromU8(
            unzipSync(renderGuideDocx(guide, new Map()))["word/document.xml"]!,
        );
        expect(document).toContain("\uE000");
        expect(document).toContain("😀");
    });

    it("sorts JSON fields in both comparator directions", () => {
        const guide = richRecord([{ kind: "paragraph", text: "x" }]);
        const reversed = { ...guide, fields: new Map([...guide.fields].reverse()) };
        expect(() => serializeGuideJson(reversed)).not.toThrow();
        const keys = Object.keys(
            JSON.parse(serializeGuideJson(reversed)) as Record<string, unknown>,
        );
        expect(keys).toContain("title");

        const unsorted = {
            ...guide,
            fields: new Map([
                ["zzz", "1"],
                ["aaa", "2"],
            ]),
        };
        expect(() => serializeGuideJson(unsorted)).not.toThrow();
    });

    it("renders every image with alternative text and scales oversized images", () => {
        const bytes = new Uint8Array(24);
        bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
        bytes.set([0x00, 0x00, 0x27, 0x10], 16);
        bytes.set([0x00, 0x00, 0x27, 0x10], 20);
        const guide = richRecord([
            { kind: "image", text: `![Alt & <text>](asset:${imageId})`, sourceIds: sourceId },
        ]);
        const files = unzipSync(
            renderGuideDocx(
                guide,
                new Map([[imageId, { assetId: imageId, mimeType: "image/png", bytes }]]),
            ),
        );
        const document = strFromU8(files["word/document.xml"]!);
        expect(document).toContain("Alt &amp; &lt;text&gt;");
        expect(document).toContain("Caption");
    });

    it("escapes quotes and apostrophes in text", () => {
        const guide = richRecord([{ kind: "paragraph", text: `He said "it's" fine & done` }]);
        const document = strFromU8(
            unzipSync(renderGuideDocx(guide, new Map()))["word/document.xml"]!,
        );
        expect(document).toContain("&quot;");
        expect(document).toContain("&apos;");
        expect(document).toContain("&amp;");
    });
});

describe("guide export image metadata guards", () => {
    function imageGuide(): ArchiveRecord {
        return record([{ kind: "image", text: `![chart](asset:${imageId})` }]);
    }

    function renderImage(mimeType: string, bytes: Uint8Array): () => Uint8Array {
        return () =>
            renderGuideDocx(
                imageGuide(),
                new Map([[imageId, { assetId: imageId, mimeType, bytes }]]),
            );
    }

    it("walks a JPEG segment that is not a frame header", () => {
        expect(
            renderImage("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02])),
        ).toThrow(/dimensions of a guide image could not be read/u);
    });

    it("stops a JPEG scan when the marker runs past the data", () => {
        expect(
            renderImage("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff])),
        ).toThrow(/dimensions of a guide image could not be read/u);
    });

    it("rejects a WebP image with an unknown subtype", () => {
        const bytes = new Uint8Array(25);
        bytes.set([0x52, 0x49, 0x46, 0x46], 0);
        bytes.set([0x57, 0x45, 0x42, 0x50], 8);
        expect(renderImage("image/webp", bytes)).toThrow(
            /dimensions of a guide image could not be read/u,
        );
    });
});
