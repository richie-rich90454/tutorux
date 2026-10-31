import { describe, expect, it } from "vitest";
import { extractDocumentText } from "../../../frontend/domain/document-text";

function makePdf(text: string): Uint8Array {
    const stream = `BT /F1 18 Tf 10 80 Td (${text}) Tj ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) {
        pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return new TextEncoder().encode(pdf);
}

describe("PDF text extraction integration", () => {
    it("extracts text with PDF.js in the Node runtime used by the CLI", async () => {
        await expect(
            extractDocumentText("lesson.pdf", "application/pdf", makePdf("PDF text works")),
        ).resolves.toEqual({ status: "extracted", text: "PDF text works" });
        await expect(
            extractDocumentText(
                "broken.pdf",
                "application/pdf",
                new TextEncoder().encode("%PDF-1.4 invalid"),
            ),
        ).rejects.toThrow("malformed, encrypted, or cannot be parsed");
    });
});
