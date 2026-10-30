import { unzlibSync, zlibSync } from "fflate";
import { RecordType, type ArchiveRecord } from "../archive/format";
import {
    field,
    guideBlockLabel,
    guideDraftFromRecord,
    parseGuideImageReference,
    type GuideExportImage,
} from "./guides";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_LIMIT = 42;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_DIMENSION = 100_000;
const MAX_IMAGE_STREAM_BYTES = 128 * 1024 * 1024;
const MAX_PAGES = 10_000;
const encoder = new TextEncoder();

interface PdfImage {
    assetId: string;
    resourceName: string;
    width: number;
    height: number;
    colorSpace: string;
    filter: string;
    bytes: Uint8Array;
    alphaBytes?: Uint8Array;
}

interface PdfPage {
    content: string;
    imageIndexes: number[];
    y: number;
}

interface RgbaImage {
    width: number;
    height: number;
    pixels: Uint8Array;
}

export type GuidePdfWebpDecoder = (bytes: Uint8Array) => Promise<RgbaImage>;

/** Render a saved guide to a self-contained PDF using the portable CID font set. */
export async function renderGuidePdf(
    record: ArchiveRecord,
    imageAssets: ReadonlyMap<string, GuideExportImage>,
    decodeWebp?: GuidePdfWebpDecoder,
): Promise<Uint8Array> {
    if (record.type !== RecordType.guide) throw new Error("Only a study guide can be exported.");
    const guide = guideDraftFromRecord(record);
    if (!guide.title.trim()) throw new Error("A guide needs a title before PDF export.");

    const pages: PdfPage[] = [];
    const images: PdfImage[] = [];
    const imageIndexes = new Map<string, number>();
    let totalImageStreamBytes = 0;
    let current: PdfPage;

    const startPage = (cover: boolean): PdfPage => {
        if (pages.length >= MAX_PAGES)
            throw new Error("The guide exceeds the 10,000-page PDF export limit.");
        const page: PdfPage = { content: "", imageIndexes: [], y: PAGE_HEIGHT - MARGIN };
        pages.push(page);
        current = page;
        if (cover) {
            fillRect(page, 0.24, 0.4, 0.34, 0, PAGE_HEIGHT - 13, PAGE_WIDTH, 13);
        } else {
            drawText(page, "TUTORUX | STUDY GUIDE", MARGIN, page.y, 8.5, 0.31, 0.43, 0.37);
            drawText(page, guide.title, PAGE_WIDTH - MARGIN - 210, page.y, 8.5, 0.4, 0.45, 0.43);
            page.y -= 14;
            drawRule(page, page.y);
            page.y -= 24;
        }
        return page;
    };

    const finishPage = (page: PdfPage): void => {
        line(page, MARGIN, 31, PAGE_WIDTH - MARGIN, 31, 0.72, 0.77, 0.73, 0.6);
        drawText(
            page,
            `Tutorux | ${field(record, "approval_state", "draft")}`,
            MARGIN,
            18,
            8,
            0.42,
            0.48,
            0.45,
        );
        drawText(
            page,
            `Page ${pages.indexOf(page) + 1}`,
            PAGE_WIDTH - MARGIN - 62,
            18,
            8,
            0.42,
            0.48,
            0.45,
        );
    };

    const ensureSpace = (height: number): void => {
        if (current.y - height < FOOTER_LIMIT) {
            finishPage(current);
            startPage(false);
        }
    };

    const drawWrapped = (
        text: string,
        x: number,
        width: number,
        size: number,
        lineHeight: number,
        color: readonly [number, number, number],
    ): void => {
        for (const textLine of wrapText(text, width, size)) {
            ensureSpace(lineHeight);
            drawText(current, textLine, x, current.y, size, ...color);
            current.y -= lineHeight;
        }
    };

    const drawCover = (): void => {
        current.y -= 58;
        drawText(current, "TUTORUX | TEACHING GUIDE", MARGIN, current.y, 9.5, 0.24, 0.4, 0.34);
        current.y -= 56;
        drawWrapped(guide.title, MARGIN, CONTENT_WIDTH, 29, 37, [0.13, 0.2, 0.19]);
        current.y -= 18;
        drawText(
            current,
            "A session-linked learning guide",
            MARGIN,
            current.y,
            12,
            0.35,
            0.43,
            0.39,
        );
        current.y -= 34;
        drawRule(current, current.y);
        current.y -= 28;
        drawText(current, "SESSION", MARGIN, current.y, 8, 0.46, 0.53, 0.49);
        current.y -= 17;
        drawWrapped(guide.sessionId, MARGIN, CONTENT_WIDTH, 10, 14, [0.18, 0.25, 0.23]);
        current.y -= 23;
        drawText(current, "TEMPLATE", MARGIN, current.y, 8, 0.46, 0.53, 0.49);
        current.y -= 17;
        drawWrapped(guide.templateId, MARGIN, CONTENT_WIDTH, 10, 14, [0.18, 0.25, 0.23]);
        current.y -= 23;
        drawText(current, "REVIEW STATE", MARGIN, current.y, 8, 0.46, 0.53, 0.49);
        current.y -= 17;
        drawWrapped(
            field(record, "approval_state", "draft"),
            MARGIN,
            CONTENT_WIDTH,
            10,
            14,
            [0.18, 0.25, 0.23],
        );
        current.y -= 28;
        drawText(
            current,
            `${guide.sections.length} sections`,
            MARGIN,
            current.y,
            9,
            0.38,
            0.46,
            0.42,
        );
        current.y -= 40;
        drawRule(current, current.y);
        current.y -= 42;
    };

    const drawSectionHeading = (heading: string): void => {
        ensureSpace(48);
        current.y -= 10;
        drawWrapped(heading, MARGIN, CONTENT_WIDTH, 16.5, 22, [0.22, 0.4, 0.34]);
        current.y -= 5;
        drawRule(current, current.y);
        current.y -= 18;
    };

    const drawTable = (rows: readonly (readonly string[])[]): void => {
        if (!rows.length || !rows[0]!.length) return;
        const fontSize = 8.4;
        const lineHeight = 10.4;
        const cellPadding = 5;
        const columnCount = rows[0]!.length;
        const columnWidth = CONTENT_WIDTH / columnCount;
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            const row = rows[rowIndex]!;
            if (row.length !== columnCount)
                throw new Error("A guide table has inconsistent column counts.");
            const cellLines = row.map((cell) =>
                wrapText(
                    cell.replace(/\[\[source:([^\]]+)\]\]/gu, "[source: $1]"),
                    columnWidth - 2 * cellPadding,
                    fontSize,
                ),
            );
            const maxLines = Math.max(1, ...cellLines.map((lines) => lines.length));
            const rowHeight = maxLines * lineHeight + 2 * cellPadding;
            ensureSpace(rowHeight + 3);
            const rowTop = current.y;
            const rowBottom = rowTop - rowHeight;
            if (rowIndex === 0)
                fillRect(current, 0.91, 0.94, 0.91, MARGIN, rowBottom, CONTENT_WIDTH, rowHeight);
            line(current, MARGIN, rowTop, MARGIN + CONTENT_WIDTH, rowTop, 0.76, 0.81, 0.77, 0.55);
            line(
                current,
                MARGIN,
                rowBottom,
                MARGIN + CONTENT_WIDTH,
                rowBottom,
                0.76,
                0.81,
                0.77,
                0.55,
            );
            for (let column = 0; column <= columnCount; column += 1) {
                const x = MARGIN + column * columnWidth;
                line(current, x, rowTop, x, rowBottom, 0.76, 0.81, 0.77, 0.55);
            }
            for (let column = 0; column < columnCount; column += 1) {
                const x = MARGIN + column * columnWidth + cellPadding;
                let baseline = rowTop - cellPadding - fontSize;
                for (const cellLine of cellLines[column]!) {
                    drawText(current, cellLine, x, baseline, fontSize, 0.18, 0.24, 0.22);
                    baseline -= lineHeight;
                }
            }
            current.y = rowBottom - 3;
        }
    };

    const getImage = async (assetId: string): Promise<number> => {
        const cached = imageIndexes.get(assetId);
        if (cached !== undefined) return cached;
        const asset = imageAssets.get(assetId);
        if (!asset) throw new Error(`Guide image ${assetId} is missing from this archive.`);
        const image = await prepareImage(asset, `Im${images.length + 1}`, decodeWebp);
        const streamBytes = image.bytes.byteLength + (image.alphaBytes?.byteLength ?? 0);
        if (streamBytes > MAX_IMAGE_STREAM_BYTES - totalImageStreamBytes)
            throw new Error(
                "The combined guide image streams exceed the 128 MiB PDF export limit.",
            );
        totalImageStreamBytes += streamBytes;
        const index = images.length;
        images.push(image);
        imageIndexes.set(assetId, index);
        return index;
    };

    const drawBlock = async (
        block: ReturnType<typeof guideDraftFromRecord>["sections"][number]["blocks"][number],
        followingSpace: number,
    ): Promise<void> => {
        const label = guideBlockLabel(block.kind, block.origin);
        const isImage =
            block.kind === "image" || block.kind === "figure" || block.text.startsWith("![");
        if (isImage) {
            const reference = parseGuideImageReference(block.text);
            if (!reference) throw new Error("A guide image must point to one archive asset UUID.");
            const imageIndex = await getImage(reference.assetId);
            const image = images[imageIndex]!;
            const scale = Math.min(1, CONTENT_WIDTH / image.width, 360 / image.height);
            const imageWidth = image.width * scale;
            const imageHeight = image.height * scale;
            const labelHeight = label ? 14 : 0;
            const staleHeight = block.stale ? 14 : 0;
            const captionHeight = reference.alternativeText ? 22 : 0;
            const sourceText = sourceLine(block.sourceIds);
            const sourceHeight = sourceText ? 14 : 0;
            ensureSpace(
                imageHeight +
                    labelHeight +
                    staleHeight +
                    captionHeight +
                    sourceHeight +
                    followingSpace +
                    10,
            );
            if (block.stale)
                drawWrapped(
                    "SOURCE CHANGED — REVIEW",
                    MARGIN,
                    CONTENT_WIDTH,
                    8.1,
                    11,
                    [0.62, 0.22, 0.18],
                );
            if (label) {
                drawWrapped(label, MARGIN, CONTENT_WIDTH, 8.1, 11, [0.4, 0.47, 0.43]);
                current.y -= 3;
            }
            const x = MARGIN + (CONTENT_WIDTH - imageWidth) / 2;
            const y = current.y - imageHeight;
            current.content += `q ${num(imageWidth)} 0 0 ${num(imageHeight)} ${num(x)} ${num(y)} cm /${image.resourceName} Do Q\n`;
            if (!current.imageIndexes.includes(imageIndex)) current.imageIndexes.push(imageIndex);
            current.y -= imageHeight + 7;
            if (reference.alternativeText)
                drawWrapped(
                    reference.alternativeText,
                    MARGIN,
                    CONTENT_WIDTH,
                    8.7,
                    11,
                    [0.4, 0.47, 0.43],
                );
            if (sourceText)
                drawWrapped(sourceText, MARGIN, CONTENT_WIDTH, 8.1, 11, [0.4, 0.47, 0.43]);
            current.y -= 7 + followingSpace;
            return;
        }

        const sourceText = sourceLine(block.sourceIds);
        if (block.kind === "table") {
            if (block.stale) {
                drawWrapped(
                    "SOURCE CHANGED — REVIEW",
                    MARGIN,
                    CONTENT_WIDTH,
                    8.1,
                    11,
                    [0.62, 0.22, 0.18],
                );
                current.y -= 2;
            }
            if (label) {
                drawWrapped(label, MARGIN, CONTENT_WIDTH, 8.1, 11, [0.4, 0.47, 0.43]);
                current.y -= 3;
            }
            drawTable(parseTable(block.text));
            if (sourceText)
                drawWrapped(sourceText, MARGIN, CONTENT_WIDTH, 8.1, 11, [0.4, 0.47, 0.43]);
            current.y -= 7 + followingSpace;
            return;
        }

        const indent = block.kind === "list-item" ? 17 : block.kind === "quote" ? 12 : 0;
        const inlineText = block.text.replace(/\[\[source:([^\]]+)\]\]/gu, "[source: $1]");
        const displayText = label ? `${label}: ${inlineText}` : inlineText;
        const lines = wrapText(displayText, CONTENT_WIDTH - indent, 10.2);
        const sourceLines = sourceText ? wrapText(sourceText, CONTENT_WIDTH - indent, 8.1) : [];
        const staleLines = block.stale ? 1 : 0;
        const blockHeight = staleLines * 11 + lines.length * 15 + sourceLines.length * 11 + 7;
        ensureSpace(blockHeight + followingSpace);
        if (block.stale) {
            drawText(
                current,
                "SOURCE CHANGED — REVIEW",
                MARGIN + indent,
                current.y,
                8.1,
                0.62,
                0.22,
                0.18,
            );
            current.y -= 11;
        }
        let firstLine = true;
        for (const textLine of lines) {
            if (block.kind === "quote") {
                fillRect(current, 0.94, 0.96, 0.93, MARGIN, current.y - 4, CONTENT_WIDTH, 22);
                line(
                    current,
                    MARGIN + 2,
                    current.y + 2,
                    MARGIN + 2,
                    current.y - 14,
                    0.36,
                    0.56,
                    0.45,
                    2,
                );
            } else if (block.kind === "list-item" && firstLine) {
                circle(current, MARGIN + 4, current.y + 3.2, 2, 0.78, 0.48, 0.28);
            }
            const color =
                block.kind === "quote"
                    ? ([0.28, 0.37, 0.33] as const)
                    : ([0.18, 0.24, 0.22] as const);
            drawText(
                current,
                textLine,
                MARGIN + indent,
                current.y,
                10.2,
                color[0],
                color[1],
                color[2],
            );
            current.y -= 15;
            firstLine = false;
        }
        if (sourceText)
            drawWrapped(
                sourceText,
                MARGIN + indent,
                CONTENT_WIDTH - indent,
                8.1,
                11,
                [0.4, 0.47, 0.43],
            );
        current.y -= 7 + followingSpace;
    };

    current = startPage(true);
    drawCover();
    finishPage(current);
    current = startPage(false);
    for (const section of guide.sections) {
        drawSectionHeading(section.heading);
        for (let index = 0; index < section.blocks.length; index += 1) {
            const followingSpace = index + 1 < section.blocks.length ? 48 : 0;
            await drawBlock(section.blocks[index]!, followingSpace);
        }
    }
    finishPage(current);
    return serializePdf(pages, images, guide.title);
}

function drawText(
    page: PdfPage,
    text: string,
    x: number,
    y: number,
    size: number,
    red: number,
    green: number,
    blue: number,
): void {
    page.content += `BT /F1 ${num(size)} Tf ${num(red)} ${num(green)} ${num(blue)} rg 1 0 0 1 ${num(x)} ${num(y)} Tm <${encodePdfText(text)}> Tj ET\n`;
}

function drawRule(page: PdfPage, y: number): void {
    line(page, MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.81, 0.85, 0.81, 0.8);
}

function fillRect(
    page: PdfPage,
    red: number,
    green: number,
    blue: number,
    x: number,
    y: number,
    width: number,
    height: number,
): void {
    page.content += `q ${num(red)} ${num(green)} ${num(blue)} rg ${num(x)} ${num(y)} ${num(width)} ${num(height)} re f Q\n`;
}

function line(
    page: PdfPage,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    red: number,
    green: number,
    blue: number,
    width: number,
): void {
    page.content += `q ${num(red)} ${num(green)} ${num(blue)} RG ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S Q\n`;
}

function circle(
    page: PdfPage,
    x: number,
    y: number,
    radius: number,
    red: number,
    green: number,
    blue: number,
): void {
    const control = radius * 0.5522847498;
    page.content += `q ${num(red)} ${num(green)} ${num(blue)} rg ${num(x + radius)} ${num(y)} m ${num(x + radius)} ${num(y + control)} ${num(x + control)} ${num(y + radius)} ${num(x)} ${num(y + radius)} c ${num(x - control)} ${num(y + radius)} ${num(x - radius)} ${num(y + control)} ${num(x - radius)} ${num(y)} c ${num(x - radius)} ${num(y - control)} ${num(x - control)} ${num(y - radius)} ${num(x)} ${num(y - radius)} c ${num(x + control)} ${num(y - radius)} ${num(x + radius)} ${num(y - control)} ${num(x + radius)} ${num(y)} c f Q\n`;
}

function encodePdfText(text: string): string {
    let output = "";
    for (const character of text) {
        const point = character.codePointAt(0)!;
        if (point <= 0xffff) {
            output += point.toString(16).padStart(4, "0");
        } else {
            const scalar = point - 0x10000;
            output += (0xd800 + (scalar >> 10)).toString(16).padStart(4, "0");
            output += (0xdc00 + (scalar & 0x3ff)).toString(16).padStart(4, "0");
        }
    }
    return output.toUpperCase();
}

function characterWidth(character: string, size: number): number {
    const point = character.codePointAt(0)!;
    if (character === "\t") return size * 1.5;
    if (
        point <= 0x7f &&
        (character === " " ||
            character === "i" ||
            character === "l" ||
            character === "." ||
            character === "," ||
            character === ":" ||
            character === ";")
    ) {
        return size * 0.28;
    }
    return point <= 0x7f ? size * 0.52 : size;
}

function textWidth(text: string, size: number): number {
    let width = 0;
    for (const character of text) width += characterWidth(character, size);
    return width;
}

function wrapText(text: string, width: number, size: number): string[] {
    const lines: string[] = [];
    let lineText = "";
    for (const character of text) {
        if (character === "\r") continue;
        if (character === "\n") {
            lines.push(lineText.replace(/[ \t]+$/u, ""));
            lineText = "";
            continue;
        }
        const candidate = lineText + character;
        if (textWidth(candidate, size) <= width || lineText.length === 0) {
            lineText = candidate;
            continue;
        }
        const breakAt = Math.max(lineText.lastIndexOf(" "), lineText.lastIndexOf("\t"));
        if (breakAt >= 0) {
            let next = lineText.slice(breakAt + 1).replace(/^[ \t]+/u, "");
            lineText = lineText.slice(0, breakAt).replace(/[ \t]+$/u, "");
            lines.push(lineText);
            next += character;
            lineText = next;
        } else {
            lines.push(lineText);
            lineText = character;
        }
    }
    lineText = lineText.replace(/[ \t]+$/u, "");
    if (lineText || lines.length === 0) lines.push(lineText);
    return lines;
}

function sourceLine(ids: string): string {
    const values = ids
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    return values.length ? `Source: ${values.join(", ")}` : "";
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
    const separator = (cell: string): boolean => /^:?-{3,}:?$/u.test(cell);
    if (
        rows.length < 2 ||
        rows[0]!.length === 0 ||
        rows[0]!.length !== rows[1]!.length ||
        !rows[1]!.every(separator) ||
        rows.slice(2).some((row) => row.length !== rows[0]!.length)
    ) {
        throw new Error(
            "A guide table needs a header, matching columns, and a Markdown separator row.",
        );
    }
    return [rows[0]!, ...rows.slice(2)];
}

async function prepareImage(
    asset: GuideExportImage,
    resourceName: string,
    decodeWebp?: GuidePdfWebpDecoder,
): Promise<PdfImage> {
    if (!asset.bytes.byteLength || asset.bytes.byteLength > MAX_IMAGE_BYTES)
        throw new Error("The guide image is empty or exceeds 64 MiB.");
    if (asset.mimeType === "image/jpeg" || asset.mimeType === "image/jpg") {
        const dimensions = jpegDimensions(asset.bytes);
        validateDimensions(dimensions.width, dimensions.height, false);
        return {
            assetId: asset.assetId,
            resourceName,
            ...dimensions,
            colorSpace: dimensions.components === 1 ? "/DeviceGray" : "/DeviceRGB",
            filter: "/DCTDecode",
            bytes: asset.bytes,
        };
    }
    let decoded: RgbaImage;
    if (asset.mimeType === "image/png") decoded = decodePng(asset.bytes);
    else if (asset.mimeType === "image/gif") decoded = decodeGif(asset.bytes);
    else if (asset.mimeType === "image/webp") {
        if (!decodeWebp)
            throw new Error(
                "Portable PDF export requires the portable WebP decoder for guide images.",
            );
        decoded = await decodeWebp(asset.bytes);
    } else {
        throw new Error("Portable PDF export supports PNG, JPEG, GIF, and WebP guide images.");
    }
    validateDimensions(decoded.width, decoded.height, true);
    const { rgb, alpha } = splitRgba(decoded.pixels);
    const rgbStream = zlibSync(rgb);
    const alphaStream = alpha ? zlibSync(alpha) : undefined;
    return {
        assetId: asset.assetId,
        resourceName,
        width: decoded.width,
        height: decoded.height,
        colorSpace: "/DeviceRGB",
        filter: "/FlateDecode",
        bytes: rgbStream,
        ...(alphaStream ? { alphaBytes: alphaStream } : {}),
    };
}

function validateDimensions(width: number, height: number, decodedPixels: boolean): void {
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > MAX_IMAGE_DIMENSION ||
        height > MAX_IMAGE_DIMENSION ||
        width * height > (decodedPixels ? MAX_IMAGE_PIXELS : 100_000_000)
    ) {
        throw new Error("The guide image dimensions are invalid or exceed safe limits.");
    }
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number; components: number } {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        throw new Error("The JPEG image header is invalid.");
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) break;
        const marker = bytes[offset++]!;
        if (
            marker === 0xd8 ||
            marker === 0xd9 ||
            marker === 0x01 ||
            (marker >= 0xd0 && marker <= 0xd7)
        )
            continue;
        if (offset + 2 > bytes.length) break;
        const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
        if (segmentLength < 2 || segmentLength > bytes.length - offset) break;
        const startOfFrame =
            marker === 0xc0 ||
            marker === 0xc1 ||
            marker === 0xc2 ||
            marker === 0xc3 ||
            marker === 0xc5 ||
            marker === 0xc6 ||
            marker === 0xc7 ||
            marker === 0xc9 ||
            marker === 0xca ||
            marker === 0xcb ||
            marker === 0xcd ||
            marker === 0xce ||
            marker === 0xcf;
        if (startOfFrame && segmentLength >= 8) {
            const precision = bytes[offset + 2]!;
            const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
            const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
            const components = bytes[offset + 7]!;
            if (precision !== 8 || segmentLength < 8 + 3 * components)
                throw new Error("Portable PDF export supports valid 8-bit JPEG images.");
            if (components !== 1 && components !== 3)
                throw new Error("Portable PDF export supports grayscale and RGB JPEG images.");
            return { width, height, components };
        }
        offset += segmentLength;
    }
    throw new Error("The JPEG image dimensions are invalid.");
}

function decodePng(bytes: Uint8Array): RgbaImage {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value))
        throw new Error("The PNG image header is invalid.");
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = -1;
    let headerSeen = false;
    let endSeen = false;
    const idat: Uint8Array[] = [];
    let idatBytes = 0;
    let palette: Uint8Array | undefined;
    let transparency: Uint8Array | undefined;
    while (offset < bytes.length) {
        if (bytes.length - offset < 12) throw new Error("The PNG contains a truncated chunk.");
        const length = readBigEndian32(bytes, offset);
        const dataOffset = offset + 8;
        if (length > bytes.length - dataOffset - 4)
            throw new Error("A PNG chunk exceeds the image data.");
        const type = ascii(bytes, offset + 4, 4);
        const chunk = bytes.subarray(dataOffset, dataOffset + length);
        if (type === "IHDR") {
            if (headerSeen || offset !== 8 || length !== 13)
                throw new Error("The PNG image header is invalid.");
            width = readBigEndian32(chunk, 0);
            height = readBigEndian32(chunk, 4);
            bitDepth = chunk[8]!;
            colorType = chunk[9]!;
            if (chunk[10] !== 0 || chunk[11] !== 0)
                throw new Error("The PNG uses unsupported compression or filtering.");
            interlace = chunk[12]!;
            headerSeen = true;
        } else if (type === "IDAT") {
            if (!headerSeen || endSeen) throw new Error("The PNG image data is out of order.");
            idat.push(chunk);
            idatBytes += chunk.length;
        } else if (type === "PLTE") {
            if (length === 0 || length > 768 || length % 3 !== 0)
                throw new Error("The PNG palette is invalid.");
            palette = chunk.slice();
        } else if (type === "tRNS") {
            transparency = chunk.slice();
        } else if (type === "IEND") {
            if (length !== 0 || idatBytes === 0)
                throw new Error("The PNG image data is incomplete.");
            endSeen = true;
            break;
        } else if (
            (bytes[offset + 4]! & 0x20) === 0 &&
            type !== "sRGB" &&
            type !== "gAMA" &&
            type !== "cHRM" &&
            type !== "iCCP"
        ) {
            throw new Error("The PNG contains an unsupported critical chunk.");
        }
        offset = dataOffset + length + 4;
    }
    if (!headerSeen || !endSeen) throw new Error("The PNG image is incomplete.");
    validateDimensions(width, height, true);
    const channelsByType: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const channels = channelsByType[colorType];
    const validDepth = [1, 2, 4, 8, 16].includes(bitDepth) && (colorType !== 3 || bitDepth !== 16);
    if (!channels || !validDepth || (colorType === 3 && !palette))
        throw new Error("The PNG color format is unsupported.");
    const compressed = concatBytes(idat, idatBytes);
    let inflated: Uint8Array;
    try {
        inflated = unzlibSync(compressed);
    } catch {
        throw new Error("The PNG image data could not be decoded.");
    }
    const pixels = new Uint8Array(width * height * 4);
    const passes =
        interlace === 0
            ? [{ x: 0, y: 0, dx: 1, dy: 1 }]
            : interlace === 1
              ? [
                    { x: 0, y: 0, dx: 8, dy: 8 },
                    { x: 4, y: 0, dx: 8, dy: 8 },
                    { x: 0, y: 4, dx: 4, dy: 8 },
                    { x: 2, y: 0, dx: 4, dy: 4 },
                    { x: 0, y: 2, dx: 2, dy: 4 },
                    { x: 1, y: 0, dx: 2, dy: 2 },
                    { x: 0, y: 1, dx: 1, dy: 2 },
                ]
              : undefined;
    if (!passes) throw new Error("The PNG interlace method is unsupported.");
    let cursor = 0;
    for (const pass of passes) {
        const passWidth = width <= pass.x ? 0 : Math.ceil((width - pass.x) / pass.dx);
        const passHeight = height <= pass.y ? 0 : Math.ceil((height - pass.y) / pass.dy);
        if (!passWidth || !passHeight) continue;
        const rowBytes = Math.ceil((passWidth * channels * bitDepth) / 8);
        const filterBytesPerPixel = Math.max(1, Math.ceil((channels * bitDepth) / 8));
        let previous = new Uint8Array(rowBytes);
        for (let passY = 0; passY < passHeight; passY += 1) {
            if (cursor + rowBytes + 1 > inflated.length)
                throw new Error("The PNG image data is truncated.");
            const filter = inflated[cursor++]!;
            const row = inflated.slice(cursor, cursor + rowBytes);
            cursor += rowBytes;
            for (let index = 0; index < rowBytes; index += 1) {
                const left = index >= filterBytesPerPixel ? row[index - filterBytesPerPixel]! : 0;
                const above = previous[index]!;
                const upperLeft =
                    index >= filterBytesPerPixel ? previous[index - filterBytesPerPixel]! : 0;
                if (filter === 1) row[index] = (row[index]! + left) & 0xff;
                else if (filter === 2) row[index] = (row[index]! + above) & 0xff;
                else if (filter === 3)
                    row[index] = (row[index]! + Math.floor((left + above) / 2)) & 0xff;
                else if (filter === 4)
                    row[index] = (row[index]! + paeth(left, above, upperLeft)) & 0xff;
                else if (filter !== 0) throw new Error("The PNG uses an unknown row filter.");
            }
            for (let passX = 0; passX < passWidth; passX += 1) {
                const targetX = pass.x + passX * pass.dx;
                const targetY = pass.y + passY * pass.dy;
                const rgbaOffset = (targetY * width + targetX) * 4;
                const samples = Array.from({ length: channels }, (_, channel) =>
                    pngSample(row, passX * channels + channel, bitDepth),
                );
                const scale = (sample: number): number =>
                    bitDepth === 16
                        ? sample >>> 8
                        : bitDepth < 8
                          ? Math.round((sample * 255) / ((1 << bitDepth) - 1))
                          : sample;
                if (colorType === 0) {
                    const gray = scale(samples[0]!);
                    pixels[rgbaOffset] = gray;
                    pixels[rgbaOffset + 1] = gray;
                    pixels[rgbaOffset + 2] = gray;
                    pixels[rgbaOffset + 3] =
                        transparency?.length === 2 &&
                        samples[0] === ((transparency[0]! << 8) | transparency[1]!)
                            ? 0
                            : 255;
                } else if (colorType === 2) {
                    pixels[rgbaOffset] = scale(samples[0]!);
                    pixels[rgbaOffset + 1] = scale(samples[1]!);
                    pixels[rgbaOffset + 2] = scale(samples[2]!);
                    const transparentRgb =
                        transparency?.length === 6 &&
                        samples[0] === ((transparency[0]! << 8) | transparency[1]!) &&
                        samples[1] === ((transparency[2]! << 8) | transparency[3]!) &&
                        samples[2] === ((transparency[4]! << 8) | transparency[5]!);
                    pixels[rgbaOffset + 3] = transparentRgb ? 0 : 255;
                } else if (colorType === 3) {
                    const paletteOffset = samples[0]! * 3;
                    if (paletteOffset + 2 >= palette!.length)
                        throw new Error("A PNG pixel refers to a missing palette entry.");
                    pixels[rgbaOffset] = palette![paletteOffset]!;
                    pixels[rgbaOffset + 1] = palette![paletteOffset + 1]!;
                    pixels[rgbaOffset + 2] = palette![paletteOffset + 2]!;
                    pixels[rgbaOffset + 3] = transparency?.[samples[0]!] ?? 255;
                } else if (colorType === 4) {
                    const gray = scale(samples[0]!);
                    pixels[rgbaOffset] = gray;
                    pixels[rgbaOffset + 1] = gray;
                    pixels[rgbaOffset + 2] = gray;
                    pixels[rgbaOffset + 3] = scale(samples[1]!);
                } else {
                    pixels[rgbaOffset] = scale(samples[0]!);
                    pixels[rgbaOffset + 1] = scale(samples[1]!);
                    pixels[rgbaOffset + 2] = scale(samples[2]!);
                    pixels[rgbaOffset + 3] = scale(samples[3]!);
                }
            }
            previous = row;
        }
    }
    if (cursor !== inflated.length) throw new Error("The PNG image data contains trailing bytes.");
    return { width, height, pixels };
}

function pngSample(row: Uint8Array, sampleIndex: number, bitDepth: number): number {
    if (bitDepth === 16) {
        const offset = sampleIndex * 2;
        return (row[offset]! << 8) | row[offset + 1]!;
    }
    if (bitDepth === 8) return row[sampleIndex]!;
    const bitOffset = sampleIndex * bitDepth;
    const shift = 8 - bitDepth - (bitOffset % 8);
    return (row[Math.floor(bitOffset / 8)]! >> shift) & ((1 << bitDepth) - 1);
}

function paeth(left: number, above: number, upperLeft: number): number {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
        ? left
        : aboveDistance <= upperLeftDistance
          ? above
          : upperLeft;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    let result = "";
    for (let index = 0; index < length; index += 1)
        result += String.fromCharCode(bytes[offset + index]!);
    return result;
}

function readBigEndian32(bytes: Uint8Array, offset: number): number {
    return (
        bytes[offset]! * 0x1000000 +
        (bytes[offset + 1]! << 16) +
        (bytes[offset + 2]! << 8) +
        bytes[offset + 3]!
    );
}

function readLittleEndian16(bytes: Uint8Array, offset: number): number {
    return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function concatBytes(parts: readonly Uint8Array[], length: number): Uint8Array {
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function splitRgba(pixels: Uint8Array): { rgb: Uint8Array; alpha?: Uint8Array } {
    const count = pixels.length / 4;
    const rgb = new Uint8Array(count * 3);
    const alpha = new Uint8Array(count);
    let hasAlpha = false;
    for (let pixel = 0; pixel < count; pixel += 1) {
        const source = pixel * 4;
        const target = pixel * 3;
        rgb[target] = pixels[source]!;
        rgb[target + 1] = pixels[source + 1]!;
        rgb[target + 2] = pixels[source + 2]!;
        alpha[pixel] = pixels[source + 3]!;
        if (alpha[pixel] !== 255) hasAlpha = true;
    }
    return hasAlpha ? { rgb, alpha } : { rgb };
}

function decodeGif(bytes: Uint8Array): RgbaImage {
    if (bytes.length < 13 || (ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a"))
        throw new Error("The GIF image header is invalid.");
    const width = readLittleEndian16(bytes, 6);
    const height = readLittleEndian16(bytes, 8);
    validateDimensions(width, height, true);
    const packed = bytes[10]!;
    const hasGlobalPalette = (packed & 0x80) !== 0;
    const globalPaletteSize = 1 << ((packed & 0x07) + 1);
    let offset = 13;
    const globalPalette = hasGlobalPalette
        ? readGifPalette(bytes, offset, globalPaletteSize)
        : undefined;
    if (hasGlobalPalette) offset += globalPaletteSize * 3;
    const backgroundIndex = bytes[11]!;
    let transparentIndex: number | undefined;
    let image:
        | {
              left: number;
              top: number;
              width: number;
              height: number;
              interlaced: boolean;
              palette?: Uint8Array;
              minimumCodeSize: number;
              compressed: Uint8Array;
          }
        | undefined;

    while (offset < bytes.length && !image) {
        const marker = bytes[offset++]!;
        if (marker === 0x3b) break;
        if (marker === 0x21) {
            if (offset >= bytes.length) throw new Error("The GIF extension is truncated.");
            const label = bytes[offset++]!;
            if (label === 0xf9) {
                if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0)
                    throw new Error("The GIF transparency extension is malformed.");
                const control = bytes[offset + 1]!;
                if ((control & 0x01) !== 0) transparentIndex = bytes[offset + 4]!;
                offset += 6;
            } else {
                offset = skipGifSubBlocks(bytes, offset);
            }
            continue;
        }
        if (marker !== 0x2c || offset + 9 > bytes.length)
            throw new Error("The GIF first frame descriptor is invalid.");
        const left = readLittleEndian16(bytes, offset);
        const top = readLittleEndian16(bytes, offset + 2);
        const frameWidth = readLittleEndian16(bytes, offset + 4);
        const frameHeight = readLittleEndian16(bytes, offset + 6);
        const descriptor = bytes[offset + 8]!;
        offset += 9;
        if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
            throw new Error("The GIF first frame lies outside its canvas.");
        const localPaletteFlag = (descriptor & 0x80) !== 0;
        const paletteSize = 1 << ((descriptor & 0x07) + 1);
        const palette = localPaletteFlag
            ? readGifPalette(bytes, offset, paletteSize)
            : globalPalette;
        if (localPaletteFlag) offset += paletteSize * 3;
        if (!palette) throw new Error("The GIF first frame has no color table.");
        if (offset >= bytes.length) throw new Error("The GIF image data is truncated.");
        const minimumCodeSize = bytes[offset++]!;
        if (minimumCodeSize < 2 || minimumCodeSize > 8)
            throw new Error("The GIF first frame uses an unsupported LZW code size.");
        const subBlocks = readGifSubBlocks(bytes, offset);
        offset = subBlocks.nextOffset;
        image = {
            left,
            top,
            width: frameWidth,
            height: frameHeight,
            interlaced: (descriptor & 0x40) !== 0,
            palette,
            minimumCodeSize,
            compressed: subBlocks.bytes,
        };
    }
    if (!image) throw new Error("The GIF contains no image frame.");

    const rgba = new Uint8Array(width * height * 4);
    if (
        globalPalette &&
        backgroundIndex * 3 + 2 < globalPalette.length &&
        backgroundIndex !== transparentIndex
    ) {
        const background = backgroundIndex * 3;
        for (let position = 0; position < rgba.length; position += 4) {
            rgba[position] = globalPalette[background]!;
            rgba[position + 1] = globalPalette[background + 1]!;
            rgba[position + 2] = globalPalette[background + 2]!;
            rgba[position + 3] = 255;
        }
    }
    const indexes = decodeGifLzw(
        image.compressed,
        image.minimumCodeSize,
        image.width * image.height,
    );
    const rowOrder: number[] = [];
    if (image.interlaced) {
        for (const [start, step] of [
            [0, 8],
            [4, 8],
            [2, 4],
            [1, 2],
        ])
            for (let row = start!; row < image.height; row += step!) rowOrder.push(row);
    } else {
        for (let row = 0; row < image.height; row += 1) rowOrder.push(row);
    }
    let sourceIndex = 0;
    for (const row of rowOrder) {
        for (let x = 0; x < image.width; x += 1) {
            const colorIndex = indexes[sourceIndex++]!;
            const paletteOffset = colorIndex * 3;
            if (paletteOffset + 2 >= image.palette!.length)
                throw new Error("The GIF first frame refers to a missing palette entry.");
            const pixel = ((image.top + row) * width + image.left + x) * 4;
            rgba[pixel] = image.palette![paletteOffset]!;
            rgba[pixel + 1] = image.palette![paletteOffset + 1]!;
            rgba[pixel + 2] = image.palette![paletteOffset + 2]!;
            rgba[pixel + 3] = colorIndex === transparentIndex ? 0 : 255;
        }
    }
    return { width, height, pixels: rgba };
}

function readGifPalette(bytes: Uint8Array, offset: number, count: number): Uint8Array {
    const length = count * 3;
    if (offset + length > bytes.length) throw new Error("The GIF color table is truncated.");
    return bytes.slice(offset, offset + length);
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
    let offset = start;
    while (offset < bytes.length) {
        const length = bytes[offset++]!;
        if (length === 0) return offset;
        if (offset + length > bytes.length) throw new Error("A GIF extension block is truncated.");
        offset += length;
    }
    throw new Error("A GIF extension block is truncated.");
}

function readGifSubBlocks(
    bytes: Uint8Array,
    start: number,
): { bytes: Uint8Array; nextOffset: number } {
    let offset = start;
    const parts: Uint8Array[] = [];
    let totalLength = 0;
    while (offset < bytes.length) {
        const length = bytes[offset++]!;
        if (length === 0) return { bytes: concatBytes(parts, totalLength), nextOffset: offset };
        if (offset + length > bytes.length)
            throw new Error("The GIF compressed data is truncated.");
        const part = bytes.subarray(offset, offset + length);
        parts.push(part);
        totalLength += part.length;
        offset += length;
    }
    throw new Error("The GIF compressed data is truncated.");
}

function decodeGifLzw(
    bytes: Uint8Array,
    minimumCodeSize: number,
    expectedCount: number,
): Uint8Array {
    const clearCode = 1 << minimumCodeSize;
    const endCode = clearCode + 1;
    const output = new Uint8Array(expectedCount);
    let outputOffset = 0;
    let bitOffset = 0;
    let codeSize = minimumCodeSize + 1;
    let nextCode = endCode + 1;
    let dictionary: (Uint8Array | undefined)[] = [];
    let previous: Uint8Array | undefined;
    const reset = (): void => {
        dictionary = Array(4096);
        for (let index = 0; index < clearCode; index += 1) dictionary[index] = Uint8Array.of(index);
        codeSize = minimumCodeSize + 1;
        nextCode = endCode + 1;
        previous = undefined;
    };
    const readCode = (): number | undefined => {
        if (bitOffset + codeSize > bytes.length * 8) return undefined;
        let code = 0;
        for (let bit = 0; bit < codeSize; bit += 1) {
            const absolute = bitOffset + bit;
            code |= ((bytes[absolute >>> 3]! >>> (absolute & 7)) & 1) << bit;
        }
        bitOffset += codeSize;
        return code;
    };
    reset();
    while (true) {
        const code = readCode();
        if (code === undefined) break;
        if (code === clearCode) {
            reset();
            continue;
        }
        if (code === endCode) break;
        let entry = dictionary[code];
        if (!entry && code === nextCode && previous) entry = appendBytes(previous, previous[0]!);
        if (!entry) throw new Error("The GIF first frame contains invalid LZW data.");
        if (outputOffset + entry.length > output.length)
            throw new Error("The GIF first frame contains too many pixels.");
        output.set(entry, outputOffset);
        outputOffset += entry.length;
        if (previous && nextCode < 4096) {
            dictionary[nextCode++] = appendBytes(previous, entry[0]!);
            if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
        }
        previous = entry;
    }
    if (outputOffset !== expectedCount)
        throw new Error("The GIF first frame has incomplete pixel data.");
    return output;
}

function appendBytes(prefix: Uint8Array, suffix: number): Uint8Array {
    const result = new Uint8Array(prefix.length + 1);
    result.set(prefix);
    result[prefix.length] = suffix;
    return result;
}

function serializePdf(
    pages: readonly PdfPage[],
    images: readonly PdfImage[],
    title: string,
): Uint8Array {
    const firstPageId = 6;
    const firstImageId = 5 + pages.length * 2 + 1;
    const imageObjectIds: number[] = [];
    const alphaObjectIds: number[] = [];
    let nextObjectId = firstImageId;
    for (const image of images) {
        imageObjectIds.push(nextObjectId++);
        alphaObjectIds.push(image.alphaBytes ? nextObjectId++ : 0);
    }
    const infoObjectId = nextObjectId++;
    const objects: Uint8Array[] = Array(nextObjectId - 1);
    const setObject = (id: number, value: string | Uint8Array): void => {
        objects[id - 1] = typeof value === "string" ? encoder.encode(value) : value;
    };

    setObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    let kids = "";
    for (let index = 0; index < pages.length; index += 1) kids += ` ${firstPageId + index * 2} 0 R`;
    setObject(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids} ] >>`);
    setObject(
        3,
        "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>",
    );
    setObject(
        4,
        "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>",
    );
    const cmap = makeToUnicodeCMap();
    const cmapBytes = encoder.encode(cmap);
    setObject(5, streamObject("", cmapBytes));

    for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]!;
        const pageId = firstPageId + index * 2;
        const contentId = pageId + 1;
        let resources = "/Font << /F1 3 0 R >>";
        if (page.imageIndexes.length) {
            resources += " /XObject <<";
            for (const imageIndex of page.imageIndexes)
                resources += ` /${images[imageIndex]!.resourceName} ${imageObjectIds[imageIndex]} 0 R`;
            resources += " >>";
        }
        setObject(
            pageId,
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_WIDTH)} ${num(PAGE_HEIGHT)}] /Resources << ${resources} >> /Contents ${contentId} 0 R >>`,
        );
        const content = encoder.encode(page.content);
        setObject(contentId, streamObject(`/Length ${content.length}`, content));
    }

    for (let index = 0; index < images.length; index += 1) {
        const image = images[index]!;
        let dictionary = `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent 8`;
        if (image.filter) dictionary += ` /Filter ${image.filter}`;
        if (alphaObjectIds[index]) dictionary += ` /SMask ${alphaObjectIds[index]} 0 R`;
        setObject(imageObjectIds[index]!, streamObject(dictionary, image.bytes));
        if (alphaObjectIds[index]) {
            setObject(
                alphaObjectIds[index]!,
                streamObject(
                    `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
                    image.alphaBytes!,
                ),
            );
        }
    }

    const titleHex = `FEFF${encodePdfText(title)}`;
    const subjectHex = `FEFF${encodePdfText("Session-linked teaching guide")}`;
    setObject(
        infoObjectId,
        `<< /Title <${titleHex}> /Creator (Tutorux) /Subject <${subjectHex}> >>`,
    );

    const chunks: Uint8Array[] = [encoder.encode("%PDF-1.7\n% Tutorux portable PDF\n")];
    const offsets: number[] = [0];
    let outputLength = chunks[0]!.length;
    for (let index = 0; index < objects.length; index += 1) {
        const objectPrefix = encoder.encode(`${index + 1} 0 obj\n`);
        const objectSuffix = encoder.encode("\nendobj\n");
        offsets.push(outputLength);
        chunks.push(objectPrefix, objects[index]!, objectSuffix);
        outputLength += objectPrefix.length + objects[index]!.length + objectSuffix.length;
    }
    const xrefOffset = outputLength;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id < offsets.length; id += 1) {
        const value = offsets[id]!;
        if (value > 9_999_999_999)
            throw new Error("The PDF export exceeded the supported file size.");
        xref += `${String(value).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(encoder.encode(xref));
    outputLength += encoder.encode(xref).length;
    return concatBytes(chunks, outputLength);
}

function streamObject(dictionary: string, stream: Uint8Array): Uint8Array {
    const prefix = encoder.encode(`<< ${dictionary} /Length ${stream.length} >>\nstream\n`);
    const suffix = encoder.encode("\nendstream");
    return concatBytes([prefix, stream, suffix], prefix.length + stream.length + suffix.length);
}

function makeToUnicodeCMap(): string {
    return (
        "/CIDInit /ProcSet findresource begin\n" +
        "12 dict begin\n" +
        "begincmap\n" +
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
        "/CMapName /TutoruxIdentity def\n" +
        "/CMapType 2 def\n" +
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
        "1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\n" +
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
    );
}

function num(value: number): string {
    return Number.isInteger(value)
        ? String(value)
        : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}
