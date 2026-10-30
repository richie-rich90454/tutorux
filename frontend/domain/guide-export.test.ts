import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../archive/format";
import { guideImageIds, renderGuideDocx, serializeGuideJson } from "./guide-export";
import type { GuideExportImage } from "./guides";

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
});
