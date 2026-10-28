import { inflateSync } from "fflate";

const DOCUMENT_INPUT_LIMIT = 16 * 1024 * 1024;
const DOCUMENT_TEXT_LIMIT = 2 * 1024 * 1024;
const DOCX_XML_LIMIT = 4 * 1024 * 1024;
const DOCX_ENTRY_LIMIT = 2048;
const PDF_PAGE_LIMIT = 512;
const PDF_TEXT_ITEM_LIMIT = 200_000;
const encoder = new TextEncoder();
const crc32Table = makeCrc32Table();
let pdfWorkerSource: string | undefined;

export interface DocumentTextExtraction {
  readonly status: "extracted" | "no-text" | "size-limit";
  readonly text: string;
}

export function configurePdfWorkerSource(source: string): void {
  pdfWorkerSource = source;
}

/** Extract bounded text from supported office documents without unpacking unrelated package files. */
export async function extractDocumentText(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<DocumentTextExtraction | null> {
  const isPdf = mimeType === "application/pdf";
  const isDocx =
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (!isPdf && !isDocx) return null;
  if (bytes.byteLength > DOCUMENT_INPUT_LIMIT) return { status: "size-limit", text: "" };
  if (isPdf) return extractPdfText(bytes);
  return extractDocxText(bytes);
}

function extractDocxText(bytes: Uint8Array): DocumentTextExtraction {
  const xml = extractDocxXml(bytes);
  if (xml.status === "size-limit") return { status: "size-limit", text: "" };
  return finishExtraction(xml.text);
}

function extractDocxXml(archiveBytes: Uint8Array): DocumentTextExtraction {
  const END_SIGNATURE = 0x06054b50;
  const CENTRAL_SIGNATURE = 0x02014b50;
  const LOCAL_SIGNATURE = 0x04034b50;
  if (archiveBytes.byteLength < 22) throw docxError("DOCX ZIP directory is missing.");

  const searchBegin = Math.max(0, archiveBytes.byteLength - 65_557);
  let endOffset = -1;
  for (let cursor = archiveBytes.byteLength - 22; cursor >= searchBegin; cursor -= 1) {
    if (readLe32(archiveBytes, cursor) !== END_SIGNATURE) continue;
    if (cursor + 22 + readLe16(archiveBytes, cursor + 20) === archiveBytes.byteLength) {
      endOffset = cursor;
      break;
    }
  }
  if (endOffset < 0) throw docxError("DOCX ZIP end directory is invalid.");

  const disk = readLe16(archiveBytes, endOffset + 4);
  const directoryDisk = readLe16(archiveBytes, endOffset + 6);
  const diskEntries = readLe16(archiveBytes, endOffset + 8);
  const entryCount = readLe16(archiveBytes, endOffset + 10);
  const directorySize = readLe32(archiveBytes, endOffset + 12);
  const directoryOffset = readLe32(archiveBytes, endOffset + 16);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0 ||
    entryCount > DOCX_ENTRY_LIMIT ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize > endOffset
  ) {
    throw docxError("DOCX ZIP directory uses unsupported or invalid bounds.");
  }

  const directoryEnd = directoryOffset + directorySize;
  let cursor = directoryOffset;
  let documentLocalOffset = -1;
  let expectedCrc = 0;
  let compressedSize = 0;
  let uncompressedSize = 0;
  let compressionMethod = 0;
  let generalFlags = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor > directoryEnd ||
      directoryEnd - cursor < 46 ||
      readLe32(archiveBytes, cursor) !== CENTRAL_SIGNATURE
    ) {
      throw docxError("DOCX ZIP central directory entry is invalid.");
    }
    const flags = readLe16(archiveBytes, cursor + 8);
    const method = readLe16(archiveBytes, cursor + 10);
    const crc = readLe32(archiveBytes, cursor + 16);
    const packed = readLe32(archiveBytes, cursor + 20);
    const unpacked = readLe32(archiveBytes, cursor + 24);
    const nameLength = readLe16(archiveBytes, cursor + 28);
    const extraLength = readLe16(archiveBytes, cursor + 30);
    const commentLength = readLe16(archiveBytes, cursor + 32);
    const diskStart = readLe16(archiveBytes, cursor + 34);
    const localOffset = readLe32(archiveBytes, cursor + 42);
    const recordSize = 46 + nameLength + extraLength + commentLength;
    if (recordSize > directoryEnd - cursor || diskStart !== 0) {
      throw docxError("DOCX ZIP central directory entry exceeds its bounds.");
    }
    if (asciiEquals(archiveBytes, cursor + 46, nameLength, "word/document.xml")) {
      if (documentLocalOffset >= 0) {
        throw docxError("DOCX ZIP contains duplicate main document entries.");
      }
      documentLocalOffset = localOffset;
      expectedCrc = crc;
      compressedSize = packed;
      uncompressedSize = unpacked;
      compressionMethod = method;
      generalFlags = flags;
    }
    cursor += recordSize;
  }
  if (cursor !== directoryEnd || documentLocalOffset < 0) {
    throw docxError("DOCX ZIP has no valid word/document.xml entry.");
  }
  if (
    (generalFlags & 1) !== 0 ||
    (generalFlags & 0x40) !== 0 ||
    (compressionMethod !== 0 && compressionMethod !== 8) ||
    compressedSize > DOCUMENT_INPUT_LIMIT ||
    uncompressedSize > DOCX_XML_LIMIT ||
    compressedSize === 0 ||
    uncompressedSize === 0 ||
    documentLocalOffset > directoryOffset ||
    documentLocalOffset > archiveBytes.byteLength ||
    archiveBytes.byteLength - documentLocalOffset < 30 ||
    readLe32(archiveBytes, documentLocalOffset) !== LOCAL_SIGNATURE
  ) {
    if (uncompressedSize > DOCX_XML_LIMIT) {
      return { status: "size-limit", text: "" };
    }
    throw docxError("DOCX main document uses unsupported or invalid ZIP features.");
  }

  const localFlags = readLe16(archiveBytes, documentLocalOffset + 6);
  const localMethod = readLe16(archiveBytes, documentLocalOffset + 8);
  const localNameLength = readLe16(archiveBytes, documentLocalOffset + 26);
  const localExtraLength = readLe16(archiveBytes, documentLocalOffset + 28);
  const dataOffset = documentLocalOffset + 30 + localNameLength + localExtraLength;
  if (
    localFlags !== generalFlags ||
    localMethod !== compressionMethod ||
    localNameLength !== "word/document.xml".length ||
    dataOffset > directoryOffset ||
    compressedSize > directoryOffset - dataOffset ||
    !asciiEquals(archiveBytes, documentLocalOffset + 30, localNameLength, "word/document.xml")
  ) {
    throw docxError("DOCX main document local header is inconsistent.");
  }

  const compressed = archiveBytes.subarray(dataOffset, dataOffset + compressedSize);
  let xmlBytes: Uint8Array;
  if (compressionMethod === 0) {
    if (compressedSize !== uncompressedSize) {
      throw docxError("DOCX stored document has inconsistent sizes.");
    }
    xmlBytes = compressed.slice();
  } else {
    try {
      // One extra byte detects a forged size while keeping inflate memory bounded.
      xmlBytes = inflateSync(compressed, { out: new Uint8Array(uncompressedSize + 1) });
    } catch {
      throw docxError("DOCX main document deflate stream is invalid.");
    }
    if (xmlBytes.byteLength !== uncompressedSize) {
      throw docxError("DOCX main document deflate stream has inconsistent sizes.");
    }
  }
  if (calculateCrc32(xmlBytes) !== expectedCrc) {
    throw docxError("DOCX main document checksum does not match.");
  }

  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes);
  } catch {
    throw docxError("DOCX main document is not valid UTF-8.");
  }
  if (xml.startsWith("\uFEFF")) xml = xml.slice(1);
  for (const character of xml) {
    const point = character.codePointAt(0)!;
    if (!isValidXmlCodePoint(point)) {
      throw docxError("DOCX main document contains an invalid XML character.");
    }
  }
  return extractDocxXmlText(xml);
}

function extractDocxXmlText(xml: string): DocumentTextExtraction {
  const output: string[] = [];
  const elements: string[] = [];
  let outputBytes = 0;
  let cursor = 0;
  let sawDocumentRoot = false;
  let sawRootClose = false;
  let insideWordText = false;
  let textLimitExceeded = false;

  const append = (value: string): boolean => {
    const byteLength = encoder.encode(value).byteLength;
    if (byteLength > DOCUMENT_TEXT_LIMIT - outputBytes) {
      textLimitExceeded = true;
      return false;
    }
    output.push(value);
    outputBytes += byteLength;
    return true;
  };
  const appendXmlText = (value: string): boolean => append(decodeXmlEntities(value));
  const appendParagraphBreak = (): void => {
    if (
      output.length > 0 &&
      outputBytes < DOCUMENT_TEXT_LIMIT &&
      !lastCharacter(output).endsWith("\n")
    ) {
      append("\n");
    }
  };

  while (cursor < xml.length) {
    const tagStart = xml.indexOf("<", cursor);
    if (tagStart < 0) {
      if (insideWordText && !appendXmlText(xml.slice(cursor))) {
        return { status: "size-limit", text: "" };
      }
      break;
    }
    if (insideWordText && !appendXmlText(xml.slice(cursor, tagStart))) {
      if (textLimitExceeded) return { status: "size-limit", text: "" };
      throw docxError("DOCX text contains an invalid XML entity.");
    }

    if (xml.startsWith("<!--", tagStart)) {
      const commentEnd = xml.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) throw docxError("DOCX XML contains an unterminated comment.");
      cursor = commentEnd + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = xml.indexOf("]]>", tagStart + 9);
      if (cdataEnd < 0) throw docxError("DOCX XML contains an unterminated CDATA section.");
      if (insideWordText && !append(xml.slice(tagStart + 9, cdataEnd))) {
        return { status: "size-limit", text: "" };
      }
      cursor = cdataEnd + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      const instructionEnd = xml.indexOf("?>", tagStart + 2);
      if (instructionEnd < 0) {
        throw docxError("DOCX XML contains an unterminated processing instruction.");
      }
      cursor = instructionEnd + 2;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      throw docxError("DOCX XML declarations and doctypes are unsupported.");
    }

    const tagEnd = xml.indexOf(">", tagStart + 1);
    if (tagEnd < 0) throw docxError("DOCX XML contains an unterminated tag.");
    let tag = xml.slice(tagStart + 1, tagEnd);
    let closing = false;
    let selfClosing = false;
    if (tag.startsWith("/")) {
      closing = true;
      tag = tag.slice(1);
    }
    if (tag.endsWith("/")) {
      selfClosing = true;
      tag = tag.slice(0, -1);
    }
    const nameEnd = tag.search(/[\s/]/u);
    const name = nameEnd < 0 ? tag : tag.slice(0, nameEnd);
    if (!name || name.length > 256) throw docxError("DOCX XML contains an invalid element name.");

    if (closing) {
      if (selfClosing || elements.at(-1) !== name) {
        throw docxError("DOCX XML element nesting is invalid.");
      }
      if (name === "w:t") insideWordText = false;
      if (name === "w:p") appendParagraphBreak();
      if (elements.length === 1) sawRootClose = true;
      elements.pop();
    } else {
      if (!sawDocumentRoot && elements.length === 0) {
        if (name !== "w:document") {
          throw docxError("DOCX package does not contain a Word document root.");
        }
        sawDocumentRoot = true;
      }
      if (sawRootClose || elements.length >= 256) {
        throw docxError("DOCX XML nesting exceeds the supported limit.");
      }
      if (name === "w:t") insideWordText = !selfClosing;
      if (name === "w:tab" && outputBytes < DOCUMENT_TEXT_LIMIT) append("\t");
      if ((name === "w:br" || name === "w:cr") && outputBytes < DOCUMENT_TEXT_LIMIT) {
        append("\n");
      }
      if (!selfClosing) elements.push(name);
      else if (name === "w:p") appendParagraphBreak();
    }

    let quote = "";
    for (let position = name.length; position < tag.length; position += 1) {
      const character = tag[position]!;
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "'" || character === '"') {
        quote = character;
      } else if (character === "<") {
        throw docxError("DOCX XML contains an invalid attribute.");
      }
    }
    if (quote) throw docxError("DOCX XML contains an unterminated attribute.");
    cursor = tagEnd + 1;
  }

  if (elements.length !== 0 || !sawDocumentRoot || !sawRootClose) {
    throw docxError("DOCX XML document is incomplete.");
  }
  let text = output.join("");
  text = text.replace(/[\r\n]+$/u, "");
  if (textLimitExceeded) return { status: "size-limit", text: "" };
  return finishExtraction(text);
}

function decodeXmlEntities(value: string): string {
  let output = "";
  for (let position = 0; position < value.length;) {
    if (value[position] !== "&") {
      output += value[position]!;
      position += 1;
      continue;
    }
    const end = value.indexOf(";", position + 1);
    if (end < 0 || end - position > 16) {
      throw docxError("DOCX text contains an invalid XML entity.");
    }
    const entity = value.slice(position + 1, end);
    const known: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    if (Object.hasOwn(known, entity)) {
      output += known[entity]!;
    } else if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const digits = entity.slice(hex ? 2 : 1);
      if (!digits || !(hex ? /^[\da-f]+$/iu : /^\d+$/u).test(digits)) {
        throw docxError("DOCX text contains an invalid XML entity.");
      }
      const point = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isSafeInteger(point) || !isValidXmlCodePoint(point)) {
        throw docxError("DOCX text contains an invalid XML entity.");
      }
      output += String.fromCodePoint(point);
    } else {
      throw docxError("DOCX text contains an invalid XML entity.");
    }
    position = end + 1;
  }
  return output;
}

async function extractPdfText(bytes: Uint8Array): Promise<DocumentTextExtraction> {
  if (bytes.byteLength === 0) throw new Error("PDF file is empty.");
  const pdfjs =
    typeof window === "undefined"
      ? await import(/* @vite-ignore */ "pdfjs-dist/legacy/build/pdf.mjs")
      : await import("pdfjs-dist");
  if (pdfWorkerSource) pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSource;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    enableXfa: false,
    useWorkerFetch: false,
    useSystemFonts: false,
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages > PDF_PAGE_LIMIT) return { status: "size-limit", text: "" };
    const output: string[] = [];
    let outputBytes = 0;
    let processedTextItems = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      let streamFinished = false;
      let exceeded = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            streamFinished = true;
            break;
          }
          for (const item of value.items) {
            processedTextItems += 1;
            if (processedTextItems > PDF_TEXT_ITEM_LIMIT) {
              exceeded = true;
              break;
            }
            if (!("str" in item) || typeof item.str !== "string" || item.str.length === 0) continue;
            const textBytes = utf8ByteLengthWithinLimit(
              item.str,
              DOCUMENT_TEXT_LIMIT - outputBytes,
            );
            if (textBytes < 0) {
              exceeded = true;
              break;
            }
            output.push(item.str);
            outputBytes += textBytes;
            if (item.hasEOL) {
              if (outputBytes < DOCUMENT_TEXT_LIMIT) {
                output.push("\n");
                outputBytes += 1;
              }
            }
          }
          if (exceeded) break;
        }
      } finally {
        if (!streamFinished) await reader.cancel().catch(() => undefined);
      }
      if (exceeded) return { status: "size-limit", text: "" };
      if (output.length > 0 && !lastCharacter(output).endsWith("\n")) {
        if (outputBytes < DOCUMENT_TEXT_LIMIT) {
          output.push("\n");
          outputBytes += 1;
        }
      }
      page.cleanup();
    }
    return finishExtraction(output.join("").replace(/[\r\n]+$/u, ""));
  } catch {
    throw new Error("PDF is malformed, encrypted, or cannot be parsed.");
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

function utf8ByteLengthWithinLimit(value: string, limit: number): number {
  if (value.length > limit) return -1;
  const length = encoder.encode(value).byteLength;
  return length <= limit ? length : -1;
}

function finishExtraction(text: string): DocumentTextExtraction {
  return [...text].some((character) => !" \t\r\n".includes(character))
    ? { status: "extracted", text }
    : { status: "no-text", text: "" };
}

function lastCharacter(values: readonly string[]): string {
  return values.at(-1) ?? "";
}

function asciiEquals(bytes: Uint8Array, offset: number, length: number, expected: string): boolean {
  if (length !== expected.length || offset < 0 || offset + length > bytes.byteLength) return false;
  for (let index = 0; index < length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function readLe16(bytes: Uint8Array, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 > bytes.byteLength) {
    throw docxError("DOCX ZIP structure exceeds its bounds.");
  }
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readLe32(bytes: Uint8Array, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes.byteLength) {
    throw docxError("DOCX ZIP structure exceeds its bounds.");
  }
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function calculateCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function isValidXmlCodePoint(point: number): boolean {
  return (
    point === 0x09 ||
    point === 0x0a ||
    point === 0x0d ||
    (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff)
  );
}

function docxError(message: string): Error {
  return new Error(message);
}
