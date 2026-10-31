import { strToU8, zipSync } from "fflate";
import type { JournalNoteBlock } from "./records";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function escapeMarkup(value: string): string {
    return value.replace(/[&<>"']/gu, (character) => {
        switch (character) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            default:
                return "&apos;";
        }
    });
}

function listItems(block: JournalNoteBlock): string[] {
    return block.text.split("\n").filter((line) => line.length > 0);
}

function checklistText(line: string): string {
    const match = /^\s*\[([ xX])\]\s*/u.exec(line);
    return `${match?.[1]?.toLowerCase() === "x" ? "☑" : "☐"} ${match ? line.slice(match[0].length) : line}`;
}

export function renderNoteMarkdown(title: string, blocks: readonly JournalNoteBlock[]): string {
    const content = blocks.map((block) => {
        switch (block.kind) {
            case "heading":
                return `## ${block.text}`;
            case "bullet-list":
                return listItems(block)
                    .map((line) => `- ${line}`)
                    .join("\n");
            case "numbered-list":
                return listItems(block)
                    .map((line, index) => `${index + 1}. ${line}`)
                    .join("\n");
            case "checklist":
                return listItems(block)
                    .map(
                        (line) =>
                            `- ${/^\s*\[[ xX]\]/u.test(line) ? line.trimStart() : `[ ] ${line}`}`,
                    )
                    .join("\n");
            case "quote":
                return block.text
                    .split("\n")
                    .map((line) => `> ${line}`)
                    .join("\n");
            case "code": {
                const fences = block.text.match(/`+/gu) ?? [];
                const fence = "`".repeat(
                    fences.reduce((length, item) => Math.max(length, item.length + 1), 3),
                );
                return `${fence}\n${block.text}\n${fence}`;
            }
            default:
                return block.text;
        }
    });
    return `# ${title}\n\n${content.join("\n\n")}\n`;
}

export function renderNoteHtml(title: string, blocks: readonly JournalNoteBlock[]): string {
    const content = blocks
        .map((block) => {
            const text = escapeMarkup(block.text);
            switch (block.kind) {
                case "heading":
                    return `<h2>${text}</h2>`;
                case "quote":
                    return `<blockquote>${text}</blockquote>`;
                case "code":
                    return `<pre><code>${text}</code></pre>`;
                case "bullet-list":
                case "numbered-list":
                case "checklist": {
                    const tag = block.kind === "numbered-list" ? "ol" : "ul";
                    const items = listItems(block)
                        .map(
                            (line) =>
                                `<li>${escapeMarkup(block.kind === "checklist" ? checklistText(line) : line)}</li>`,
                        )
                        .join("");
                    return `<${tag}${block.kind === "checklist" ? ' class="checklist"' : ""}>${items}</${tag}>`;
                }
                default:
                    return `<p>${text}</p>`;
            }
        })
        .join("\n");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeMarkup(title)}</title><style>body{font:16px/1.65 "Noto Sans",sans-serif;color:#171a1c;margin:0}main{max-width:760px;margin:auto;padding:48px 32px}h1,h2{line-height:1.2}p,blockquote,pre{white-space:pre-wrap}blockquote{border-left:3px solid #4a6870;margin-left:0;padding-left:1em;color:#303639}pre{background:#f2f4f4;padding:1em;overflow-wrap:anywhere}ul.checklist{list-style:none;padding-left:0}@media print{main{max-width:none;padding:0}pre{white-space:pre-wrap}}</style></head><body><main class="note-document"><h1>${escapeMarkup(title)}</h1>${content}</main></body></html>`;
}

function wordText(value: string): string {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (
            (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
            code === 0xfffe ||
            code === 0xffff
        ) {
            throw new Error("Word cannot represent one of the characters in this document.");
        }
    }
    return value
        .split("\n")
        .map((line) => `<w:t xml:space="preserve">${escapeMarkup(line)}</w:t>`)
        .join("<w:br/>");
}

function wordParagraph(text: string, style = ""): string {
    return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r>${wordText(text)}</w:r></w:p>`;
}

export function renderNoteDocx(title: string, blocks: readonly JournalNoteBlock[]): Uint8Array {
    const paragraphs = [wordParagraph(title, "Title")];
    for (const block of blocks) {
        if (
            block.kind === "bullet-list" ||
            block.kind === "numbered-list" ||
            block.kind === "checklist"
        ) {
            listItems(block).forEach((line, index) => {
                const text =
                    block.kind === "checklist"
                        ? checklistText(line)
                        : `${block.kind === "numbered-list" ? `${index + 1}.` : "•"} ${line}`;
                paragraphs.push(wordParagraph(text));
            });
        } else {
            const style =
                block.kind === "heading"
                    ? "Heading1"
                    : block.kind === "quote"
                      ? "Quote"
                      : block.kind === "code"
                        ? "Code"
                        : "";
            paragraphs.push(wordParagraph(block.text, style));
        }
    }
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style></w:styles>`;
    return zipSync({
        "[Content_Types].xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
        ),
        "_rels/.rels": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
        ),
        "word/document.xml": strToU8(document),
        "word/styles.xml": strToU8(styles),
        "word/_rels/document.xml.rels": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        ),
    });
}
