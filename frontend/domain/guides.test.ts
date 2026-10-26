import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../archive/format";
import { renderGuideHtml } from "./guides";

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
});
