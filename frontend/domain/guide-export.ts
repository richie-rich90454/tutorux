import { strToU8, zipSync } from "fflate";
import { RecordType, recordTypeName, type ArchiveRecord } from "../archive/format";
import {
  field,
  guideBlockLabel,
  guideDraftFromRecord,
  parseGuideImageReference,
  type GuideExportImage,
} from "./guides";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_IMAGE_WIDTH_EMU = 4_572_000;
const MAX_IMAGE_HEIGHT_EMU = 5_486_400;
const EMU_PER_PIXEL = 9_525;

export function serializeGuideJson(record: ArchiveRecord): string {
  if (record.type !== RecordType.guide) throw new Error("Only a study guide can be exported.");
  const fields = Object.fromEntries(
    [...record.fields.entries()].sort(([left], [right]) => compareText(left, right)),
  );
  return `${JSON.stringify(
    {
      id: record.id,
      type: recordTypeName(record.type),
      revision: record.revision.toString(),
      ...fields,
    },
    null,
    2,
  )}\n`;
}

export function guideImageIds(record: ArchiveRecord): string[] {
  const draft = guideDraftFromRecord(record);
  const ids = new Set<string>();
  for (const section of draft.sections) {
    for (const block of section.blocks) {
      const isImage =
        block.kind === "image" || block.kind === "figure" || block.text.startsWith("![");
      if (!isImage) continue;
      const reference = parseGuideImageReference(block.text);
      if (!reference) throw new Error("A guide image must point to one archive asset UUID.");
      ids.add(reference.assetId);
    }
  }
  return [...ids];
}

export function renderGuideDocx(
  record: ArchiveRecord,
  images: ReadonlyMap<string, GuideExportImage>,
): Uint8Array {
  if (record.type !== RecordType.guide) throw new Error("Only a study guide can be exported.");
  const draft = guideDraftFromRecord(record);
  if (!draft.title.trim()) throw new Error("Cannot export a guide without a title.");

  const packageImages = new Map<
    string,
    { image: GuideExportImage; relationshipId: string; fileName: string }
  >();
  const media: Record<string, Uint8Array> = {};
  let nextRelationship = 2;
  let nextDrawing = 1;
  const relationships: string[] = [];
  const imageDefaults = new Set<string>();
  const paragraphs: string[] = [];
  paragraphs.push(paragraphXml(draft.title, "Title"));
  paragraphs.push(
    paragraphXml(
      `Tutorux study guide · ${draft.templateId} template · ${field(record, "approval_state", "draft")}`,
      "Subtitle",
    ),
  );

  for (const section of draft.sections) {
    paragraphs.push(paragraphXml(section.heading, "Heading1"));
    for (const block of section.blocks) {
      const citations = block.sourceIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (block.stale)
        paragraphs.push(paragraphXml("Source changed — review this block.", "Warning"));
      const label = guideBlockLabel(block.kind, block.origin);
      const imageReference = parseGuideImageReference(block.text);
      if (block.kind === "image" || block.kind === "figure" || block.text.startsWith("![")) {
        if (!imageReference) throw new Error("A guide image must point to one archive asset UUID.");
        if (label) paragraphs.push(paragraphXml(label, "Source"));
        const image = images.get(imageReference.assetId);
        if (!image)
          throw new Error(`Guide image ${imageReference.assetId} is missing from this archive.`);
        let packaged = packageImages.get(imageReference.assetId);
        if (!packaged) {
          const extension = imageExtension(image.mimeType);
          const fileName = `${imageReference.assetId}.${extension}`;
          const relationshipId = `rId${nextRelationship++}`;
          packaged = { image, relationshipId, fileName };
          packageImages.set(imageReference.assetId, packaged);
          relationships.push(
            `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`,
          );
          media[`word/media/${fileName}`] = image.bytes;
          imageDefaults.add(extension);
        }
        paragraphs.push(
          imageDrawingXml(
            packaged.image,
            imageReference.alternativeText,
            packaged.relationshipId,
            nextDrawing++,
          ),
        );
        if (imageReference.alternativeText) {
          paragraphs.push(paragraphXml(imageReference.alternativeText, "Caption"));
        }
        if (citations.length) paragraphs.push(paragraphXml(sourceLine(citations), "Source"));
        continue;
      }
      if (block.kind === "table") {
        if (label) paragraphs.push(paragraphXml(label, "Source"));
        paragraphs.push(tableXml(block.text));
        if (citations.length) paragraphs.push(paragraphXml(sourceLine(citations), "Source"));
        continue;
      }
      const style =
        block.kind === "quote"
          ? "Quote"
          : block.kind === "code" || block.kind === "equation"
            ? "Code"
            : "";
      const prefix = label || (block.kind === "list-item" ? "• " : "");
      paragraphs.push(
        paragraphXml(
          renderInlineSources(block.text),
          style,
          prefix ? `${prefix}${label ? ": " : ""}` : "",
        ),
      );
      if (citations.length) paragraphs.push(paragraphXml(sourceLine(citations), "Source"));
    }
  }

  const defaults = [...imageDefaults]
    .map((extension) => `<Default Extension="${extension}" ContentType="${imageMime(extension)}"/>`)
    .join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const documentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${relationships.join("")}</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults}<Override PartName="/word/document.xml" ContentType="${DOCX_MIME}"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const coreProperties = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Tutorux</dc:creator><cp:lastModifiedBy>Tutorux</cp:lastModifiedBy></cp:coreProperties>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRelationships),
    "word/document.xml": strToU8(documentXml),
    "word/styles.xml": strToU8(stylesXml()),
    "word/_rels/document.xml.rels": strToU8(documentRelationships),
    "docProps/core.xml": strToU8(coreProperties),
    ...media,
  };
  return zipSync(files, { level: 0 });
}

function paragraphXml(text: string, style = "", prefix = ""): string {
  const runs = textRuns(`${prefix}${text}`);
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${styleXml}${runs}</w:p>`;
}

function textRuns(text: string): string {
  return text
    .split("\n")
    .map(
      (line, index) =>
        `${index ? "<w:r><w:br/></w:r>" : ""}${line ? `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>` : ""}`,
    )
    .join("");
}

function tableXml(value: string): string {
  const rows = parseTable(value);
  const cells = rows
    .map(
      (row, rowIndex) =>
        `<w:tr>${row
          .map((cell) => {
            const shading = rowIndex === 0 ? '<w:shd w:fill="E8EEF5"/>' : "";
            return `<w:tc><w:tcPr>${shading}</w:tcPr>${paragraphXml(renderInlineSources(cell))}</w:tc>`;
          })
          .join("")}</w:tr>`,
    )
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:color="CBD5E1"/></w:tblBorders></w:tblPr>${cells}</w:tbl>`;
}

function parseTable(value: string): string[][] {
  const rows = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells: string[] = [];
      let cell = "";
      let escaped = false;
      for (const character of line.replace(/^\|/u, "").replace(/\|$/u, "")) {
        if (escaped) {
          if (character !== "|" && character !== "\\") cell += "\\";
          cell += character;
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "|") {
          cells.push(cell.trim());
          cell = "";
        } else {
          cell += character;
        }
      }
      if (escaped) cell += "\\";
      cells.push(cell.trim());
      return cells;
    });
  const isSeparator = (cell: string): boolean => {
    const normalized = cell.replace(/^:/u, "").replace(/:$/u, "");
    return normalized.length >= 3 && /^-+$/u.test(normalized);
  };
  if (
    rows.length < 2 ||
    rows[0]!.length === 0 ||
    rows[0]!.length !== rows[1]!.length ||
    !rows[1]!.every(isSeparator) ||
    rows.slice(2).some((row) => row.length !== rows[0]!.length)
  ) {
    throw new Error(
      "A guide table needs a header, matching columns, and a Markdown separator row.",
    );
  }
  return [rows[0]!, ...rows.slice(2)];
}

function imageDrawingXml(
  image: GuideExportImage,
  alternativeText: string,
  relationshipId: string,
  drawingId: number,
): string {
  const { width, height } = imageDimensions(image);
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH_EMU / (width * EMU_PER_PIXEL),
    MAX_IMAGE_HEIGHT_EMU / (height * EMU_PER_PIXEL),
  );
  const widthEmu = Math.max(1, Math.round(width * EMU_PER_PIXEL * scale));
  const heightEmu = Math.max(1, Math.round(height * EMU_PER_PIXEL * scale));
  const id = String(drawingId);
  const alt = escapeXml(alternativeText);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="${id}" name="Tutorux image ${id}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Tutorux image ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function imageDimensions(image: GuideExportImage): { width: number; height: number } {
  const bytes = image.bytes;
  const byte = (index: number): number => bytes[index] ?? 0;
  const big32 = (offset: number): number =>
    byte(offset) * 0x1000000 +
    byte(offset + 1) * 0x10000 +
    byte(offset + 2) * 0x100 +
    byte(offset + 3);
  const little16 = (offset: number): number => byte(offset) | (byte(offset + 1) << 8);
  let dimensions: { width: number; height: number } | undefined;
  if (
    image.mimeType === "image/png" &&
    bytes.length >= 24 &&
    byte(0) === 0x89 &&
    byte(1) === 0x50 &&
    byte(2) === 0x4e &&
    byte(3) === 0x47
  ) {
    dimensions = { width: big32(16), height: big32(20) };
  } else if (
    (image.mimeType === "image/jpeg" || image.mimeType === "image/jpg") &&
    byte(0) === 0xff &&
    byte(1) === 0xd8
  ) {
    dimensions = jpegDimensions(bytes);
  } else if (
    image.mimeType === "image/gif" &&
    bytes.length >= 10 &&
    byte(0) === 0x47 &&
    byte(1) === 0x49 &&
    byte(2) === 0x46
  ) {
    dimensions = { width: little16(6), height: little16(8) };
  } else if (
    image.mimeType === "image/webp" &&
    bytes.length >= 25 &&
    byte(0) === 0x52 &&
    byte(8) === 0x57 &&
    byte(9) === 0x45 &&
    byte(10) === 0x42 &&
    byte(11) === 0x50
  ) {
    if (
      byte(12) === 0x56 &&
      byte(13) === 0x50 &&
      byte(14) === 0x38 &&
      byte(15) === 0x58 &&
      bytes.length >= 30
    ) {
      dimensions = {
        width: 1 + byte(24) + byte(25) * 256 + byte(26) * 65_536,
        height: 1 + byte(27) + byte(28) * 256 + byte(29) * 65_536,
      };
    } else if (
      byte(12) === 0x56 &&
      byte(13) === 0x50 &&
      byte(14) === 0x38 &&
      byte(15) === 0x4c &&
      byte(20) === 0x2f
    ) {
      const bits = (byte(21) | (byte(22) << 8) | (byte(23) << 16) | (byte(24) << 24)) >>> 0;
      dimensions = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    } else if (
      byte(12) === 0x56 &&
      byte(13) === 0x50 &&
      byte(14) === 0x38 &&
      byte(15) === 0x20 &&
      bytes.length >= 30
    ) {
      dimensions = {
        width: (byte(26) | (byte(27) << 8)) & 0x3fff,
        height: (byte(28) | (byte(29) << 8)) & 0x3fff,
      };
    }
  }
  if (
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new Error("The dimensions of a guide image could not be read.");
  }
  return dimensions;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || length > bytes.length - offset) break;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      ) &&
      length >= 7
    ) {
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += length;
  }
  return undefined;
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpeg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      throw new Error("Only PNG, JPEG, GIF, and WebP guide images can be exported to Word.");
  }
}

function imageMime(extension: string): string {
  switch (extension) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      throw new Error("Unsupported image type in the guide.");
  }
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="360"/><w:keepNext/></w:pPr><w:rPr><w:i/><w:color w:val="64748B"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="420" w:after="180"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="315B4A"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="475569"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Source"><w:name w:val="Source"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="64748B"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Warning"><w:name w:val="Review warning"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="9B6E2F"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="647267"/><w:sz w:val="18"/></w:rPr></w:style></w:styles>`;
}

function sourceLine(ids: readonly string[]): string {
  return `Source: ${ids.join(", ")}`;
}

function renderInlineSources(value: string): string {
  return value.replace(/\[\[source:([^\]]+)\]\]/gu, "[source: $1]");
}

function escapeXml(value: string): string {
  let output = "";
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      !(
        point === 0x09 ||
        point === 0x0a ||
        point === 0x0d ||
        (point >= 0x20 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff)
      )
    ) {
      throw new Error("Guide text contains a character that Word cannot represent.");
    }
    switch (character) {
      case "&":
        output += "&amp;";
        break;
      case "<":
        output += "&lt;";
        break;
      case ">":
        output += "&gt;";
        break;
      case '"':
        output += "&quot;";
        break;
      case "'":
        output += "&apos;";
        break;
      default:
        output += character;
    }
  }
  return output;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
