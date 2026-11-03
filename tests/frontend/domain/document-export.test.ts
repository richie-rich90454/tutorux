import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { JournalNoteBlock } from "../../../frontend/domain/records";
import {
    DOCX_MIME,
    renderNoteDocx,
    renderNoteHtml,
    renderNoteMarkdown,
} from "../../../frontend/domain/document-export";

function block(kind: JournalNoteBlock["kind"], text: string): JournalNoteBlock {
    return { id: crypto.randomUUID(), kind, text };
}

const richBlocks: JournalNoteBlock[] = [
    block("heading", "Plan & review"),
    block("bullet-list", "first\n\nsecond"),
    block("numbered-list", "one\ntwo"),
    block("checklist", "[x] done\n[ ] pending\ntodo\n  [X] indented"),
    block("quote", "quoted\nlines"),
    block("paragraph", "plain <text>"),
    block("code", "const a = `tick`;"),
    block("code", "````\nblock\n```"),
    block("code", "plain code"),
];

describe("note Markdown export", () => {
    it("renders every block kind", () => {
        const markdown = renderNoteMarkdown("Lesson", richBlocks);
        expect(markdown).toContain("# Lesson");
        expect(markdown).toContain("## Plan & review");
        expect(markdown).toContain("- first\n- second");
        expect(markdown).toContain("1. one\n2. two");
        expect(markdown).toContain("- [x] done\n- [ ] pending\n- [ ] todo\n- [X] indented");
        expect(markdown).toContain("> quoted\n> lines");
        expect(markdown).toContain("plain <text>");
        expect(markdown).toContain("```\nconst a = `tick`;\n```");
        expect(markdown).toContain("`````\n````\nblock\n```\n`````");
        expect(markdown).toContain("```\nplain code\n```");
        expect(markdown.endsWith("\n")).toBe(true);
    });

    it("falls back to raw text for unknown blocks", () => {
        const unknown = block("unknown" as JournalNoteBlock["kind"], "raw text");
        expect(renderNoteMarkdown("Title", [unknown])).toBe("# Title\n\nraw text\n");
    });

    it("renders an empty note", () => {
        expect(renderNoteMarkdown("Empty", [])).toBe("# Empty\n\n\n");
    });
});

describe("note HTML export", () => {
    it("renders and escapes every block kind", () => {
        const html = renderNoteHtml('A & B <"note">', richBlocks);
        expect(html).toContain("<title>A &amp; B &lt;&quot;note&quot;&gt;</title>");
        expect(html).toContain("<h2>Plan &amp; review</h2>");
        expect(html).toContain("<ul><li>first</li><li>second</li></ul>");
        expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
        expect(html).toContain('<ul class="checklist">');
        expect(html).toContain("<li>☑ done</li>");
        expect(html).toContain("<li>☐ pending</li>");
        expect(html).toContain("<li>☐ todo</li>");
        expect(html).toContain("<li>☑ indented</li>");
        expect(html).toContain("<blockquote>quoted\nlines</blockquote>");
        expect(html).toContain("<p>plain &lt;text&gt;</p>");
        expect(html).toContain("<pre><code>const a = `tick`;</code></pre>");
    });

    it("escapes apostrophes and falls back for unknown blocks", () => {
        const html = renderNoteHtml("It's", [block("unknown" as JournalNoteBlock["kind"], "a'b")]);
        expect(html).toContain("<p>a&apos;b</p>");
        expect(html).toContain("<h1>It&apos;s</h1>");
    });

    it("renders an empty note", () => {
        const html = renderNoteHtml("Empty", []);
        expect(html).toContain('<main class="note-document"><h1>Empty</h1></main>');
    });
});

describe("note DOCX export", () => {
    it("produces a valid package with every block kind", () => {
        const bytes = renderNoteDocx("Lesson <1>", richBlocks);
        expect(DOCX_MIME).toBe(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        const files = unzipSync(bytes);
        expect(Object.keys(files).sort()).toEqual([
            "[Content_Types].xml",
            "_rels/.rels",
            "word/_rels/document.xml.rels",
            "word/document.xml",
            "word/styles.xml",
        ]);
        const document = strFromU8(files["word/document.xml"]!);
        expect(document).toContain('<w:pStyle w:val="Title"/>');
        expect(document).toContain('<w:pStyle w:val="Heading1"/>');
        expect(document).toContain('<w:pStyle w:val="Quote"/>');
        expect(document).toContain('<w:pStyle w:val="Code"/>');
        expect(document).toContain('<w:t xml:space="preserve">• first</w:t>');
        expect(document).toContain('<w:t xml:space="preserve">1. one</w:t>');
        expect(document).toContain('<w:t xml:space="preserve">☑ done</w:t>');
        expect(document).toContain('<w:t xml:space="preserve">☐ pending</w:t>');
        expect(document).toContain('<w:t xml:space="preserve">☐ todo</w:t>');
        expect(document).toContain("Lesson &lt;1&gt;");
        expect(document).toContain("<w:br/>");
    });

    it("keeps tabs, carriage returns, and newlines", () => {
        const bytes = renderNoteDocx("Tabbed", [block("paragraph", "a\tb\r\nc")]);
        const document = strFromU8(unzipSync(bytes)["word/document.xml"]!);
        expect(document).toContain("a\tb");
        expect(document).toContain('<w:br/><w:t xml:space="preserve">c</w:t>');
    });

    it.each(["bell\u0001", "noncharacter\ufffe", "noncharacter\uffff"])(
        "rejects characters Word cannot represent: %j",
        (text) => {
            expect(() => renderNoteDocx("Bad", [block("paragraph", text)])).toThrow(
                "Word cannot represent one of the characters in this document.",
            );
        },
    );
});
