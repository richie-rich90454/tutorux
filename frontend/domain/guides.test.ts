import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../archive/format";
import { renderGuideHtml, type GuideExportImage } from "./guides";

describe("study guide HTML export", () => {
  it("escapes imported text and keeps source review cues in the document", () => {
    const sourceId = crypto.randomUUID();
    const record: ArchiveRecord = {
      type: RecordType.guide,
      id: crypto.randomUUID(),
      revision: 1n,
      previousOffset: 0n,
      fields: new Map([
        ["title", "<script>review()</script>"],
        ["template_id", "general"],
        ["approval_state", "draft"],
        ["section_count", "1"],
        ["section.0.heading", "Questions & evidence"],
        ["section.0.block_count", "1"],
        ["section.0.block.0.kind", "paragraph"],
        ["section.0.block.0.text", "<img src=x onerror=review()> & discuss"],
        ["section.0.block.0.source_ids", sourceId],
        ["section.0.block.0.stale", "true"],
        ["section.0.block.0.origin", "tutor-authored"],
      ]),
      blob: new Uint8Array(),
    };

    const html = renderGuideHtml(record);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("&lt;script&gt;review()&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=review()&gt; &amp; discuss");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Source changed. Review this block");
    expect(html).toContain(sourceId);
    expect(html).toContain("@media print");
  });

  it("renders Markdown tables and embeds validated archive image bytes", () => {
    const imageId = crypto.randomUUID();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const image: GuideExportImage = { assetId: imageId, mimeType: "image/png", bytes };
    const record: ArchiveRecord = {
      type: RecordType.guide,
      id: crypto.randomUUID(),
      revision: 1n,
      previousOffset: 0n,
      fields: new Map([
        ["title", "Visual review"],
        ["template_id", "general"],
        ["approval_state", "draft"],
        ["section_count", "1"],
        ["section.0.heading", "Examples"],
        ["section.0.block_count", "2"],
        ["section.0.block.0.kind", "table"],
        ["section.0.block.0.text", "| Ratio | Model |\n| --- | --- |\n| 2:3 | Bars |"],
        ["section.0.block.0.source_ids", ""],
        ["section.0.block.0.origin", "tutor-authored"],
        ["section.0.block.1.kind", "figure"],
        ["section.0.block.1.text", `![Bar model <safe>](asset:${imageId})`],
        ["section.0.block.1.source_ids", imageId],
        ["section.0.block.1.origin", "tutor-authored"],
      ]),
      blob: new Uint8Array(),
    };

    const html = renderGuideHtml(record, new Map([[imageId, image]]));
    expect(html).toContain('<table class="guide-table">');
    expect(html).toContain('<th scope="col">Ratio</th>');
    expect(html).toContain('src="data:image/png;base64,iVBORw=="');
    expect(html).toContain('alt="Bar model &lt;safe&gt;"');
    expect(html).toContain("Bar model &lt;safe&gt;");
  });
});
