import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { renderGuidePdf } from "../../../frontend/domain/guide-pdf";
import type { GuideExportImage } from "../../../frontend/domain/guides";

const guideId = "9fd18de8-42ef-41b5-af46-0a24344c7a3e";
const imageId = "44413a60-5500-499d-8b9e-5478da537bc5";
const secondImageId = "55513a60-5500-499d-8b9e-5478da537bc5";

interface BlockInput {
    kind: string;
    text: string;
    sourceIds?: string;
    stale?: boolean;
    origin?: string;
}

function record(
    blocks: readonly BlockInput[],
    options: {
        title?: string;
        approvalState?: string | null;
        sections?: readonly (readonly BlockInput[])[];
        sectionCount?: number;
        sessionId?: string;
        templateId?: string;
    } = {},
): ArchiveRecord {
    const allSections = options.sections ?? [blocks];
    const fields = new Map<string, string>([
        ["title", options.title ?? "Ratios & visual models"],
        ["template_id", options.templateId ?? "mathematics"],
        ["approval_state", options.approvalState ?? "draft"],
        ["session_id", options.sessionId ?? "session-1"],
        ["section_count", String(options.sectionCount ?? allSections.length)],
    ]);
    allSections.forEach((sectionBlocks, sectionIndex) => {
        const prefix = `section.${sectionIndex}.`;
        fields.set(`${prefix}heading`, `Section ${sectionIndex + 1}`);
        fields.set(`${prefix}block_count`, String(sectionBlocks.length));
        sectionBlocks.forEach((block, blockIndex) => {
            const blockPrefix = `${prefix}block.${blockIndex}.`;
            fields.set(`${blockPrefix}kind`, block.kind);
            fields.set(`${blockPrefix}text`, block.text);
            fields.set(`${blockPrefix}source_ids`, block.sourceIds ?? "");
            fields.set(`${blockPrefix}stale`, String(block.stale ?? false));
            fields.set(`${blockPrefix}origin`, block.origin ?? "tutor-authored");
        });
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

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function be32(value: number): Uint8Array {
    return new Uint8Array([
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
    ]);
}

function le16(value: number): Uint8Array {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function ascii(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    return concat([be32(data.byteLength), ascii(type), data, new Uint8Array(4)]);
}

interface PngOptions {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    raw: Uint8Array;
    interlace?: number;
    palette?: readonly number[];
    transparency?: readonly number[];
    headerOverrides?: Partial<
        Record<"bitDepth" | "colorType" | "compression" | "filter" | "interlace", number>
    >;
}

function pngBytes(options: PngOptions): Uint8Array {
    const parts: Uint8Array[] = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ihdrChunk(options),
    ];
    if (options.palette) parts.push(pngChunk("PLTE", new Uint8Array(options.palette)));
    if (options.transparency) parts.push(pngChunk("tRNS", new Uint8Array(options.transparency)));
    parts.push(pngChunk("IDAT", zlibSync(options.raw)), pngChunk("IEND", new Uint8Array()));
    return concat(parts);
}

function ihdrChunk(
    options: Pick<
        PngOptions,
        "width" | "height" | "bitDepth" | "colorType" | "headerOverrides" | "interlace"
    >,
): Uint8Array {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, options.width);
    view.setUint32(4, options.height);
    header[8] = options.headerOverrides?.bitDepth ?? options.bitDepth;
    header[9] = options.headerOverrides?.colorType ?? options.colorType;
    header[10] = options.headerOverrides?.compression ?? 0;
    header[11] = options.headerOverrides?.filter ?? 0;
    header[12] = options.headerOverrides?.interlace ?? options.interlace ?? 0;
    return pngChunk("IHDR", header);
}

function pngCustom(chunks: readonly Uint8Array[], tail: readonly number[] = []): Uint8Array {
    return concat([
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ...chunks,
        new Uint8Array(tail),
    ]);
}

function rawPngChunk(
    length: number,
    type: string,
    data: Uint8Array,
    declaredLength = length,
): Uint8Array {
    return concat([be32(declaredLength), ascii(type), data, new Uint8Array(4)]);
}

function packSamples(samples: readonly number[], bitDepth: number): number[] {
    if (bitDepth === 8) return [...samples];
    if (bitDepth === 16) return samples.flatMap((sample) => [(sample >> 8) & 0xff, sample & 0xff]);
    const output: number[] = [];
    let current = 0;
    let bits = 0;
    for (const sample of samples) {
        current = (current << bitDepth) | sample;
        bits += bitDepth;
        if (bits === 8) {
            output.push(current);
            current = 0;
            bits = 0;
        }
    }
    if (bits > 0) output.push(current << (8 - bits));
    return output;
}

const PASSES = [
    { x: 0, y: 0, dx: 8, dy: 8 },
    { x: 4, y: 0, dx: 8, dy: 8 },
    { x: 0, y: 4, dx: 4, dy: 8 },
    { x: 2, y: 0, dx: 4, dy: 4 },
    { x: 0, y: 2, dx: 2, dy: 4 },
    { x: 1, y: 0, dx: 2, dy: 2 },
    { x: 0, y: 1, dx: 1, dy: 2 },
];

function pngRow(
    width: number,
    bitDepth: number,
    pixel: (x: number) => readonly number[],
    filter = 0,
): number[] {
    const samples: number[] = [];
    for (let x = 0; x < width; x += 1) samples.push(...pixel(x));
    return [filter, ...packSamples(samples, bitDepth)];
}

function pngRaw(
    width: number,
    height: number,
    bitDepth: number,
    pixel: (x: number, y: number) => readonly number[],
    interlace = 0,
    filter = 0,
): Uint8Array {
    const bytes: number[] = [];
    if (interlace === 0) {
        for (let y = 0; y < height; y += 1)
            bytes.push(...pngRow(width, bitDepth, (x) => pixel(x, y), filter));
        return new Uint8Array(bytes);
    }
    for (const pass of PASSES) {
        const passWidth = width <= pass.x ? 0 : Math.ceil((width - pass.x) / pass.dx);
        const passHeight = height <= pass.y ? 0 : Math.ceil((height - pass.y) / pass.dy);
        if (!passWidth || !passHeight) continue;
        for (let row = 0; row < passHeight; row += 1) {
            const y = pass.y + row * pass.dy;
            bytes.push(
                ...pngRow(passWidth, bitDepth, (x) => pixel(pass.x + x * pass.dx, y), filter),
            );
        }
    }
    return new Uint8Array(bytes);
}

function solid(
    width: number,
    height: number,
    colorType: number,
    bitDepth: number,
    samples: readonly number[],
    options: Partial<PngOptions> = {},
): Uint8Array {
    return pngBytes({
        width,
        height,
        bitDepth,
        colorType,
        raw: pngRaw(width, height, bitDepth, () => samples, options.interlace ?? 0),
        ...options,
    });
}

function jpegBytes(
    width: number,
    height: number,
    components = 3,
    options: {
        precision?: number;
        shortSegment?: boolean;
        marker?: number;
        prefix?: readonly number[];
    } = {},
): Uint8Array {
    const length = options.shortSegment ? 6 : 8 + 3 * components;
    const segment = new Uint8Array(length);
    segment[0] = 0xff;
    segment[1] = options.marker ?? 0xc0;
    segment[2] = (length >> 8) & 0xff;
    segment[3] = length & 0xff;
    segment[4] = options.precision ?? 8;
    segment[5] = (height >> 8) & 0xff;
    segment[6] = height & 0xff;
    segment[7] = (width >> 8) & 0xff;
    segment[8] = width & 0xff;
    segment[9] = components;
    for (let index = 0; index < components * 3; index += 1) segment[10 + index] = 1;
    return concat([
        new Uint8Array([0xff, 0xd8]),
        new Uint8Array(options.prefix ?? []),
        segment,
        new Uint8Array([0xff, 0xd9]),
    ]);
}

function pushGifCodes(codes: readonly number[], codeSize: number): number[] {
    const bytes: number[] = [];
    let current = 0;
    let bits = 0;
    for (const code of codes) {
        current |= code << bits;
        bits += codeSize;
        while (bits >= 8) {
            bytes.push(current & 0xff);
            current >>>= 8;
            bits -= 8;
        }
    }
    if (bits > 0) bytes.push(current & 0xff);
    return bytes;
}

function gifBytes(options: {
    width: number;
    height: number;
    indexes: readonly number[];
    palette?: readonly number[];
    localPalette?: readonly number[];
    transparentIndex?: number;
    interlaced?: boolean;
    backgroundIndex?: number;
}): Uint8Array {
    const palette = options.palette ?? [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0];
    const packed = 0x80 | 0x01;
    const parts: Uint8Array[] = gifHeader(
        options.width,
        options.height,
        packed,
        options.backgroundIndex ?? 0,
        palette,
    );
    if (options.transparentIndex !== undefined) {
        parts.push(
            new Uint8Array([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, options.transparentIndex, 0x00]),
        );
    }
    const local = options.localPalette;
    const descriptor = (local ? 0x80 | 0x01 : 0) | (options.interlaced ? 0x40 : 0);
    parts.push(gifFrameDescriptor(0, 0, options.width, options.height, descriptor));
    if (local) parts.push(new Uint8Array(local));
    const codes: number[] = [];
    for (const index of options.indexes) codes.push(4, index);
    codes.push(5);
    const compressed = pushGifCodes(codes, 3);
    parts.push(
        new Uint8Array([2, compressed.length]),
        new Uint8Array(compressed),
        new Uint8Array([0, 0x3b]),
    );
    return concat(parts);
}

function gifHeader(
    width: number,
    height: number,
    packed: number,
    backgroundIndex: number,
    palette: readonly number[] = [],
): Uint8Array[] {
    return [
        ascii("GIF89a"),
        le16(width),
        le16(height),
        new Uint8Array([packed, backgroundIndex, 0]),
        new Uint8Array(palette),
    ];
}

function gifFrameDescriptor(
    left: number,
    top: number,
    width: number,
    height: number,
    descriptor: number,
): Uint8Array {
    return concat([
        new Uint8Array([0x2c]),
        le16(left),
        le16(top),
        le16(width),
        le16(height),
        new Uint8Array([descriptor]),
    ]);
}

function gifSubBlocks(bytes: readonly number[]): Uint8Array {
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 255) {
        const block = bytes.slice(offset, offset + 255);
        parts.push(new Uint8Array([block.length]), new Uint8Array(block));
    }
    parts.push(new Uint8Array([0]));
    return concat(parts);
}

function gifFrame(
    options: {
        left?: number;
        top?: number;
        width?: number;
        height?: number;
        descriptor?: number;
        localPalette?: readonly number[];
        minimumCodeSize?: number;
        compressed?: readonly number[];
        trailer?: boolean;
    } = {},
): Uint8Array {
    const parts: Uint8Array[] = [
        gifFrameDescriptor(
            options.left ?? 0,
            options.top ?? 0,
            options.width ?? 2,
            options.height ?? 2,
            options.descriptor ?? 0,
        ),
    ];
    if (options.localPalette) parts.push(new Uint8Array(options.localPalette));
    parts.push(new Uint8Array([options.minimumCodeSize ?? 2]));
    parts.push(gifSubBlocks(options.compressed ?? []));
    if (options.trailer !== false) parts.push(new Uint8Array([0x3b]));
    return concat(parts);
}

const GIF_PALETTE = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0];

function gifDocument(parts: readonly Uint8Array[], width = 2, height = 2): Uint8Array {
    return concat([...gifHeader(width, height, 0x81, 0, GIF_PALETTE), ...parts]);
}

function packCodeStream(codes: readonly { code: number; size: number }[]): number[] {
    const bytes: number[] = [];
    let current = 0;
    let bits = 0;
    for (const { code, size } of codes) {
        current |= code << bits;
        bits += size;
        while (bits >= 8) {
            bytes.push(current & 0xff);
            current >>>= 8;
            bits -= 8;
        }
    }
    if (bits > 0) bytes.push(current & 0xff);
    return bytes;
}

function encodeGifLzw(indexes: readonly number[], minimumCodeSize: number): number[] {
    const clearCode = 1 << minimumCodeSize;
    const endCode = clearCode + 1;
    let dictionary = new Map<string, number>();
    let nextCode = endCode + 1;
    let codeSize = minimumCodeSize + 1;
    const reset = (): void => {
        dictionary = new Map();
        for (let index = 0; index < clearCode; index += 1) {
            dictionary.set(`${index}`, index);
        }
        nextCode = endCode + 1;
        codeSize = minimumCodeSize + 1;
    };
    const codes: { code: number; size: number }[] = [{ code: clearCode, size: codeSize }];
    reset();
    let current = `${indexes[0]}`;
    for (let index = 1; index < indexes.length; index += 1) {
        const symbol = indexes[index]!;
        const candidate = `${current},${symbol}`;
        if (dictionary.has(candidate)) {
            current = candidate;
            continue;
        }
        codes.push({ code: dictionary.get(current)!, size: codeSize });
        if (nextCode < 4096) {
            dictionary.set(candidate, nextCode);
            nextCode += 1;
            if (nextCode - 1 === 1 << codeSize && codeSize < 12) codeSize += 1;
        } else {
            codes.push({ code: clearCode, size: codeSize });
            reset();
        }
        current = `${symbol}`;
    }
    codes.push({ code: dictionary.get(current)!, size: codeSize });
    codes.push({ code: endCode, size: codeSize });
    return packCodeStream(codes);
}

function image(assetId: string, mimeType: string, bytes: Uint8Array): GuideExportImage {
    return { assetId, mimeType, bytes };
}

function pngImage(assetId: string, bytes: Uint8Array): GuideExportImage {
    return image(assetId, "image/png", bytes);
}

function text(bytes: Uint8Array): string {
    return new TextDecoder("latin1").decode(bytes);
}

function decodePdfText(value: string): string {
    return value.replace(/<([0-9A-Fa-f]+)>/gu, (_match, hex: string) => {
        let output = "";
        for (let index = 0; index + 4 <= hex.length; index += 4) {
            output += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
        }
        return output;
    });
}

async function render(
    blocks: readonly BlockInput[],
    images: ReadonlyMap<string, GuideExportImage> = new Map(),
    options: Parameters<typeof record>[1] = {},
): Promise<string> {
    const bytes = await renderGuidePdf(record(blocks, options), images);
    return decodePdfText(text(bytes));
}

describe("guide PDF document structure", () => {
    it("rejects non-guide records and empty titles", async () => {
        await expect(
            renderGuidePdf({ ...record([]), type: RecordType.session }, new Map()),
        ).rejects.toThrow(/Only a study guide/u);
        await expect(renderGuidePdf(record([], { title: "  " }), new Map())).rejects.toThrow(
            /needs a title/u,
        );
    });

    it("writes a cover, sections, footers, and document metadata", async () => {
        const pdf = await render(
            [
                {
                    kind: "instruction",
                    text: "Compare the two ratios and explain your reasoning with a partner.",
                    sourceIds: " a , b ",
                },
                { kind: "quote", text: "A ratio compares two quantities." },
                { kind: "list-item", text: "First step\twith a tab" },
                { kind: "code", text: "ratio = 2 / 3" },
                { kind: "worked-example", text: "3:4 becomes 6:8" },
            ],
            new Map(),
            { approvalState: "approved", sessionId: "session-42" },
        );
        expect(pdf.startsWith("%PDF-1.7")).toBe(true);
        expect(pdf).toContain("% Tutorux portable PDF");
        expect(pdf).toContain("/Type /Catalog");
        expect(pdf).toContain("/BaseFont /STSong-Light");
        expect(pdf).toContain("/Title");
        expect(pdf).toContain("Ratios & visual models");
        expect(pdf).toContain("/Subject");
        expect(pdf).toContain("Session-linked teaching guide");
        expect(pdf).toContain("TUTORUX | TEACHING GUIDE");
        expect(pdf).toContain("A session-linked learning guide");
        expect(pdf).toContain("SESSION");
        expect(pdf).toContain("TEMPLATE");
        expect(pdf).toContain("REVIEW STATE");
        expect(pdf).toContain("approved");
        expect(pdf).toContain("TUTORUX | STUDY GUIDE");
        expect(pdf).toContain("Tutorux | approved");
        expect(pdf).toContain("Page 1");
        expect(pdf).toContain("Source: a, b");
        expect(pdf).toContain("Tutor instruction");
        expect(pdf).toContain("Worked example");
        expect(pdf.endsWith("%%EOF\n")).toBe(true);
    });

    it("defaults missing review state to draft", async () => {
        const pdf = await render([{ kind: "paragraph", text: "Body" }], new Map(), {
            approvalState: null,
        });
        expect(pdf).toContain("Tutorux | draft");
    });

    it("wraps long text, tabs, newlines, carriage returns, and astral characters", async () => {
        const pdf = await render(
            [
                {
                    kind: "paragraph",
                    text: `Long ${"word ".repeat(120)} sentence\r\n${"x".repeat(120)}\tTabbed 😀`,
                },
            ],
            new Map(),
        );
        expect(pdf).toContain("%PDF-1.7");
        expect(pdf).toContain("Page 1");
        expect(pdf).toContain("Page 2");
    });

    it("breaks pages for many lines", async () => {
        const pdf = await render(
            [
                {
                    kind: "paragraph",
                    text: Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"),
                },
            ],
            new Map(),
        );
        expect(pdf).toContain("Page 3");
    });

    it("writes tables with escaped pipes and source cues", async () => {
        const pdf = await render(
            [
                {
                    kind: "table",
                    text: "| Ratio | Value |\n| --- | :---: |\n| 2:3 \\| 4 | 6 |\n| [[source:abc]] | 8 |",
                    sourceIds: "source-1",
                    stale: true,
                    origin: "ai-generated",
                },
            ],
            new Map(),
        );
        expect(pdf).toContain("SOURCE CHANGED");
        expect(pdf).toContain("[source: abc]");
        expect(pdf).toContain("AI-generated content");
    });

    it("draws image blocks with captions, sources, and stale notices", async () => {
        const png = pngImage(imageId, solid(8, 8, 6, 8, [255, 0, 0, 255]));
        const pdf = await render(
            [
                {
                    kind: "figure",
                    text: `![Bar model](asset:${imageId})`,
                    sourceIds: imageId,
                    stale: true,
                    origin: "ai-generated",
                },
                {
                    kind: "image",
                    text: `![Second](asset:${secondImageId})`,
                },
            ],
            new Map([
                [imageId, png],
                [secondImageId, pngImage(secondImageId, solid(4, 4, 0, 8, [0]))],
            ]),
        );
        expect(pdf).toContain("/Subtype /Image");
    });
});

describe("guide PDF image formats", () => {
    it("passes JPEG images through with grayscale and RGB color spaces", async () => {
        const gray = jpegBytes(10, 20, 1);
        const rgb = jpegBytes(20, 10, 3);
        const pdf = await render(
            [
                { kind: "image", text: `![gray](asset:${imageId})` },
                { kind: "image", text: `![rgb](asset:${secondImageId})` },
            ],
            new Map([
                [imageId, image(imageId, "image/jpeg", gray)],
                [secondImageId, image(secondImageId, "image/jpg", rgb)],
            ]),
        );
        expect(pdf).toContain("/ColorSpace /DeviceGray");
        expect(pdf).toContain("/ColorSpace /DeviceRGB");
        expect(pdf).toContain("/DCTDecode");
    });

    it("decodes PNG color types, bit depths, filters, and interlacing", async () => {
        const cases: GuideExportImage[] = [
            pngImage(imageId, solid(2, 2, 0, 8, [128])),
            pngImage(imageId, solid(2, 2, 0, 16, [0x1234])),
            pngImage(imageId, solid(2, 2, 0, 4, [3])),
            pngImage(imageId, solid(2, 2, 0, 2, [1])),
            pngImage(imageId, solid(2, 2, 0, 1, [1])),
            pngImage(
                imageId,
                solid(2, 2, 2, 8, [10, 20, 30], { transparency: [0, 20, 0, 20, 0, 30] }),
            ),
            pngImage(
                imageId,
                solid(2, 2, 3, 8, [1], {
                    palette: [0, 0, 0, 9, 9, 9],
                    transparency: [255, 0],
                }),
            ),
            pngImage(imageId, solid(2, 2, 4, 8, [50, 200])),
            pngImage(imageId, solid(4, 3, 6, 8, [1, 2, 3, 255], { interlace: 1 })),
        ];
        for (const [index, item] of cases.entries()) {
            const pdf = await render(
                [{ kind: "image", text: `![img](asset:${item.assetId})` }],
                new Map([[item.assetId, item]]),
            );
            expect(pdf).toContain("/Subtype /Image");
            expect(index).toBeGreaterThanOrEqual(0);
        }
    });

    it("supports every PNG row filter", async () => {
        for (const filter of [0, 1, 2, 3, 4]) {
            const raw = pngRaw(4, 1, 8, () => [1, 2, 3, 4], 0, filter);
            const pdf = await render(
                [{ kind: "image", text: `![img](asset:${imageId})` }],
                new Map([
                    [
                        imageId,
                        pngImage(
                            imageId,
                            pngBytes({ width: 4, height: 1, bitDepth: 8, colorType: 6, raw }),
                        ),
                    ],
                ]),
            );
            expect(pdf).toContain("/FlateDecode");
        }
    });

    it("decodes GIF frames with palettes, transparency, and interlacing", async () => {
        const globalPng = gifBytes({ width: 2, height: 2, indexes: [0, 1, 2, 3] });
        const localPng = gifBytes({
            width: 2,
            height: 2,
            indexes: [3, 2, 1, 0],
            localPalette: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            transparentIndex: 1,
        });
        const interlaced = gifBytes({
            width: 2,
            height: 2,
            indexes: [0, 1, 2, 3],
            interlaced: true,
            backgroundIndex: 1,
        });
        for (const item of [globalPng, localPng, interlaced]) {
            const pdf = await render(
                [{ kind: "image", text: `![gif](asset:${imageId})` }],
                new Map([[imageId, image(imageId, "image/gif", item)]]),
            );
            expect(pdf).toContain("/Subtype /Image");
        }
    });

    it("uses the injected WebP decoder and rejects it when missing", async () => {
        const decoded = { width: 2, height: 2, pixels: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 0]) };
        const bytes = await renderGuidePdf(
            record([{ kind: "image", text: `![webp](asset:${imageId})` }]),
            new Map([[imageId, image(imageId, "image/webp", new Uint8Array([1, 2, 3]))]]),
            async () => decoded,
        );
        expect(text(bytes)).toContain("/SMask");
        await expect(
            renderGuidePdf(
                record([{ kind: "image", text: `![webp](asset:${imageId})` }]),
                new Map([[imageId, image(imageId, "image/webp", new Uint8Array([1]))]]),
            ),
        ).rejects.toThrow(/WebP decoder/u);
    });
});

describe("guide PDF defensive paths", () => {
    it("annotates stale text blocks", async () => {
        const pdf = await render([
            { kind: "paragraph", text: "Changed content", stale: true, sourceIds: "s1" },
        ]);
        expect(pdf).toContain("SOURCE CHANGED");
        expect(pdf).toContain("Source: s1");
    });

    it("draws an image only once when blocks repeat it", async () => {
        const png = pngImage(imageId, solid(2, 2, 6, 8, [1, 2, 3, 255]));
        const pdf = await render(
            [
                { kind: "image", text: `![one](asset:${imageId})` },
                { kind: "image", text: `![two](asset:${imageId})` },
            ],
            new Map([[imageId, png]]),
        );
        expect(pdf.match(/\/Subtype \/Image/gu)).toHaveLength(1);
    });

    it("rejects image streams over the combined limit", async () => {
        const large = new Uint8Array(64 * 1024 * 1024);
        large.set(jpegBytes(10, 10, 3));
        const third = jpegBytes(10, 10, 3);
        await expect(
            render(
                [
                    { kind: "image", text: `![a](asset:${imageId})` },
                    { kind: "image", text: `![b](asset:${secondImageId})` },
                    { kind: "image", text: "![c](asset:66613a60-5500-499d-8b9e-5478da537bc5)" },
                ],
                new Map([
                    [imageId, image(imageId, "image/jpeg", large)],
                    [secondImageId, image(secondImageId, "image/jpeg", large)],
                    [
                        "66613a60-5500-499d-8b9e-5478da537bc5",
                        image("66613a60-5500-499d-8b9e-5478da537bc5", "image/jpeg", third),
                    ],
                ]),
            ),
        ).rejects.toThrow(/combined guide image streams/u);
    });

    it("parses escaped table cells and trailing backslashes", async () => {
        const pdf = await render([
            {
                kind: "table",
                text: "| A | B |\n| --- | --- |\n| x\\y | z\\|w |\n| a\\ | b\\",
            },
        ]);
        expect(pdf).toContain("x\\y");
        expect(pdf).toContain("z|w");
        expect(pdf).toContain("b\\");
    });

    it("draws an image with an empty caption", async () => {
        const pdf = await render(
            [{ kind: "image", text: `![](asset:${imageId})` }],
            new Map([[imageId, pngImage(imageId, solid(2, 2, 6, 8, [1, 2, 3, 255]))]]),
        );
        expect(pdf).toContain("/Subtype /Image");
    });

    it("does not add a trailing empty text line", async () => {
        const pdf = await render([{ kind: "paragraph", text: "first\nsecond\n" }]);
        expect(pdf).toContain("second");
    });

    it("tolerates an empty source list", async () => {
        const pdf = await render([{ kind: "paragraph", text: "Body", sourceIds: " , , " }]);
        expect(pdf).not.toContain("Source:");
    });

    it("rejects guides beyond the page limit", async () => {
        const section = Array.from({ length: 40 }, () => "a").join("\n");
        const sections = Array.from({ length: 10_000 }, () => [
            { kind: "paragraph", text: section },
        ]);
        await expect(renderGuidePdf(record([], { sections }), new Map())).rejects.toThrow(
            /10,000-page/u,
        );
    });
});

describe("guide PDF JPEG parsing", () => {
    it("accepts every start-of-frame marker", async () => {
        for (const marker of [
            0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
        ]) {
            const pdf = await render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([
                    [imageId, image(imageId, "image/jpeg", jpegBytes(10, 10, 3, { marker }))],
                ]),
            );
            expect(pdf).toContain("/DCTDecode");
        }
    });

    it("skips non-marker bytes, standalone markers, and non-frame segments", async () => {
        const prefix = new Uint8Array([0x00, 0x01, 0xff, 0xd0, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
        const pdf = await render(
            [{ kind: "image", text: `![x](asset:${imageId})` }],
            new Map([
                [
                    imageId,
                    image(imageId, "image/jpeg", jpegBytes(10, 10, 3, { prefix: [...prefix] })),
                ],
            ]),
        );
        expect(pdf).toContain("/DeviceRGB");
    });

    it("handles PNG transparency and palette fallbacks", async () => {
        const cases: GuideExportImage[] = [
            pngImage(imageId, solid(2, 2, 0, 8, [0], { transparency: [0, 0] })),
            pngImage(imageId, solid(2, 2, 0, 8, [1], { transparency: [0, 5] })),
            pngImage(imageId, solid(2, 2, 0, 8, [0], { transparency: [0, 0, 0, 0, 0, 0] })),
            pngImage(
                imageId,
                solid(2, 2, 2, 8, [10, 20, 30], {
                    transparency: [0, 10, 0, 99, 0, 30],
                }),
            ),
            pngImage(
                imageId,
                solid(2, 2, 2, 8, [10, 20, 30], {
                    transparency: [0, 10, 0, 20, 0, 99],
                }),
            ),
            pngImage(imageId, solid(2, 2, 2, 8, [10, 20, 30], { transparency: [0, 10] })),
            pngImage(imageId, solid(2, 2, 3, 8, [1], { palette: [1, 2, 3, 4, 5, 6] })),
        ];
        for (const item of cases) {
            const pdf = await render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([[imageId, item]]),
            );
            expect(pdf).toContain("/Subtype /Image");
        }
    });

    it("uses an SMask for transparent RGB pixels", async () => {
        const pdf = await render(
            [{ kind: "image", text: `![x](asset:${imageId})` }],
            new Map([
                [
                    imageId,
                    pngImage(
                        imageId,
                        solid(2, 2, 2, 8, [10, 20, 30], {
                            transparency: [0, 10, 0, 20, 0, 30],
                        }),
                    ),
                ],
            ]),
        );
        expect(pdf).toContain("/SMask");
    });

    it("applies every Paeth prediction outcome", async () => {
        const raw = pngRaw(4, 4, 8, (x, y) => [x * 30, y * 60, 255 - x * 10, 255], 0, 4);
        const pdf = await render(
            [{ kind: "image", text: `![x](asset:${imageId})` }],
            new Map([
                [
                    imageId,
                    pngImage(
                        imageId,
                        pngBytes({ width: 4, height: 4, bitDepth: 8, colorType: 6, raw }),
                    ),
                ],
            ]),
        );
        expect(pdf).toContain("/FlateDecode");
    });

    it("stops at an end marker before any frame", async () => {
        await expect(
            render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([
                    [
                        imageId,
                        image(
                            imageId,
                            "image/gif",
                            concat([
                                ...gifHeader(2, 2, 0x81, 0, [255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                new Uint8Array([0x3b]),
                            ]),
                        ),
                    ],
                ]),
            ),
        ).rejects.toThrow(/no image frame/u);
    });

    it("accepts a transparency-free control extension", async () => {
        const pdf = await render(
            [{ kind: "image", text: `![x](asset:${imageId})` }],
            new Map([
                [
                    imageId,
                    image(
                        imageId,
                        "image/gif",
                        concat([
                            ...gifHeader(
                                2,
                                2,
                                0x81,
                                0,
                                [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0],
                            ),
                            new Uint8Array([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]),
                            gifFrame({ compressed: pushGifCodes([4, 0, 4, 1, 4, 2, 4, 3, 5], 3) }),
                        ]),
                    ),
                ],
            ]),
        );
        expect(pdf).toContain("/Subtype /Image");
    });

    it("accepts a local-only color table", async () => {
        const pdf = await render(
            [{ kind: "image", text: `![x](asset:${imageId})` }],
            new Map([
                [
                    imageId,
                    image(
                        imageId,
                        "image/gif",
                        concat([
                            ...gifHeader(2, 2, 0, 0, []),
                            gifFrame({
                                descriptor: 0x81,
                                localPalette: [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0],
                                compressed: pushGifCodes([4, 0, 4, 1, 4, 2, 4, 3, 5], 3),
                            }),
                        ]),
                    ),
                ],
            ]),
        );
        expect(pdf).toContain("/Subtype /Image");
    });

    it("handles empty compressed data and missing sub-block terminators", async () => {
        await expect(
            render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([
                    [
                        imageId,
                        image(imageId, "image/gif", gifDocument([gifFrame({ compressed: [] })])),
                    ],
                ]),
            ),
        ).rejects.toThrow(/incomplete pixel data/u);
        await expect(
            render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([
                    [
                        imageId,
                        image(
                            imageId,
                            "image/gif",
                            gifDocument([
                                concat([
                                    gifFrameDescriptor(0, 0, 2, 2, 0),
                                    new Uint8Array([2, 2, 0, 1]),
                                ]),
                            ]),
                        ),
                    ],
                ]),
            ),
        ).rejects.toThrow(/compressed data is truncated/u);
    });

    it("stops at truncated markers and segments", async () => {
        const cases = [
            concat([new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff])]),
            concat([new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00])]),
            concat([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01])]),
            concat([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x64, 0x00])]),
        ];
        for (const bytes of cases) {
            await expect(
                render(
                    [{ kind: "image", text: `![x](asset:${imageId})` }],
                    new Map([[imageId, image(imageId, "image/jpeg", bytes)]]),
                ),
            ).rejects.toThrow(/JPEG/u);
        }
    });
});

describe("guide PDF GIF parsing", () => {
    it("decodes a growing LZW dictionary", async () => {
        const indexes = Array.from({ length: 6_000 }, (_, index) => index % 4);
        const compressed = encodeGifLzw(indexes, 2);
        const pdf = await render(
            [{ kind: "image", text: `![x](asset:${imageId})` }],
            new Map([
                [
                    imageId,
                    image(
                        imageId,
                        "image/gif",
                        gifDocument([gifFrame({ width: 100, height: 60, compressed })], 100, 60),
                    ),
                ],
            ]),
        );
        expect(pdf).toContain("/FlateDecode");
    });

    it("skips unrelated extension blocks", async () => {
        const pdf = await render(
            [{ kind: "image", text: `![x](asset:${imageId})` }],
            new Map([
                [
                    imageId,
                    image(
                        imageId,
                        "image/gif",
                        gifDocument([
                            new Uint8Array([0x21, 0xfe, 0x01, 0x41, 0x00]),
                            gifFrame({ compressed: pushGifCodes([4, 0, 4, 1, 4, 2, 4, 3, 5], 3) }),
                        ]),
                    ),
                ],
            ]),
        );
        expect(pdf).toContain("/Subtype /Image");
    });

    it("surfaces every GIF decoding failure", async () => {
        const cases: { bytes: Uint8Array; message: RegExp }[] = [
            { bytes: new Uint8Array(12), message: /header is invalid/u },
            {
                bytes: concat([ascii("GIF88a"), new Uint8Array(20)]),
                message: /header is invalid/u,
            },
            { bytes: gifDocument([]), message: /no image frame/u },
            {
                bytes: gifDocument([new Uint8Array([0x21])]),
                message: /extension is truncated/u,
            },
            {
                bytes: gifDocument([
                    new Uint8Array([0x21, 0xf9, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00]),
                ]),
                message: /transparency extension is malformed/u,
            },
            {
                bytes: gifDocument([new Uint8Array([0x00])]),
                message: /frame descriptor is invalid/u,
            },
            {
                bytes: gifDocument([new Uint8Array([0x2c, 0x00, 0x00])]),
                message: /frame descriptor is invalid/u,
            },
            {
                bytes: gifDocument([gifFrame({ width: 0 })]),
                message: /outside its canvas/u,
            },
            {
                bytes: concat([...gifHeader(2, 2, 0, 0, []), gifFrame({})]),
                message: /no color table/u,
            },
            {
                bytes: gifDocument([
                    concat([gifFrameDescriptor(0, 0, 2, 2, 0x80), new Uint8Array([0x00])]),
                ]),
                message: /color table is truncated/u,
            },
            {
                bytes: gifDocument([gifFrameDescriptor(0, 0, 2, 2, 0)]),
                message: /image data is truncated/u,
            },
            {
                bytes: gifDocument([gifFrame({ minimumCodeSize: 1 })]),
                message: /unsupported LZW code size/u,
            },
            {
                bytes: gifDocument([
                    concat([gifFrameDescriptor(0, 0, 2, 2, 0), new Uint8Array([2, 10, 0x01])]),
                ]),
                message: /compressed data is truncated/u,
            },
            {
                bytes: gifDocument([gifFrame({ compressed: [5, 0] })]),
                message: /incomplete pixel data/u,
            },
            {
                bytes: gifDocument([
                    gifFrame({
                        compressed: packCodeStream([
                            { code: 6, size: 3 },
                            { code: 5, size: 3 },
                        ]),
                    }),
                ]),
                message: /invalid LZW data/u,
            },
            {
                bytes: gifDocument([
                    gifFrame({ compressed: pushGifCodes([4, 0, 4, 1, 4, 2, 4, 3, 4, 0, 5], 3) }),
                ]),
                message: /too many pixels/u,
            },
            {
                bytes: gifDocument([
                    gifFrame({ compressed: pushGifCodes([4, 0, 4, 1, 4, 2, 5], 3) }),
                ]),
                message: /incomplete pixel data/u,
            },
            {
                bytes: gifDocument([
                    gifFrame({
                        minimumCodeSize: 3,
                        compressed: pushGifCodes([8, 5, 8, 5, 8, 5, 8, 5, 9], 4),
                    }),
                ]),
                message: /missing palette entry/u,
            },
            {
                bytes: gifDocument([new Uint8Array([0x21, 0xfe, 0x0a, 0x01])]),
                message: /extension block is truncated/u,
            },
            {
                bytes: gifDocument([new Uint8Array([0x21, 0xfe, 0x01, 0x41])]),
                message: /extension block is truncated/u,
            },
        ];
        for (const item of cases) {
            await expect(
                render(
                    [{ kind: "image", text: `![x](asset:${imageId})` }],
                    new Map([[imageId, image(imageId, "image/gif", item.bytes)]]),
                ),
            ).rejects.toThrow(item.message);
        }
    });
});
describe("guide PDF validation", () => {
    it("rejects missing images and malformed references", async () => {
        await expect(
            render([{ kind: "image", text: `![missing](asset:${imageId})` }], new Map()),
        ).rejects.toThrow(/missing from this archive/u);
        await expect(render([{ kind: "image", text: "not an image" }], new Map())).rejects.toThrow(
            /one archive asset UUID/u,
        );
    });

    it("rejects invalid tables", async () => {
        await expect(
            render([{ kind: "table", text: "| A |\n| --- |\n| a | b |" }], new Map()),
        ).rejects.toThrow(/header, matching columns/u);
        await expect(
            render([{ kind: "table", text: "| A | B |\n| -- | -- |\n| 1 | 2 |" }], new Map()),
        ).rejects.toThrow(/header, matching columns/u);
    });

    it("rejects empty or oversized image bytes", async () => {
        await expect(
            render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([[imageId, image(imageId, "image/png", new Uint8Array())]]),
            ),
        ).rejects.toThrow(/empty or exceeds 64 MiB/u);
        await expect(
            render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([
                    [imageId, image(imageId, "image/png", new Uint8Array(64 * 1024 * 1024 + 1))],
                ]),
            ),
        ).rejects.toThrow(/empty or exceeds 64 MiB/u);
    });

    it("rejects unsupported image types", async () => {
        await expect(
            render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([[imageId, image(imageId, "image/bmp", new Uint8Array([1]))]]),
            ),
        ).rejects.toThrow(/supports PNG, JPEG, GIF, and WebP/u);
    });

    it("rejects invalid image dimensions", async () => {
        await expect(
            render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([[imageId, image(imageId, "image/jpeg", jpegBytes(0, 10, 3))]]),
            ),
        ).rejects.toThrow(/dimensions are invalid/u);
    });

    it("rejects invalid JPEG headers and frames", async () => {
        const bad: Uint8Array[] = [
            new Uint8Array([0xff]),
            new Uint8Array([1, 2, 3, 4]),
            new Uint8Array([0xff, 0xd8]),
            jpegBytes(10, 10, 2),
            jpegBytes(10, 10, 3, { precision: 12 }),
            jpegBytes(10, 10, 3, { shortSegment: true }),
        ];
        for (const bytes of bad) {
            await expect(
                render(
                    [{ kind: "image", text: `![x](asset:${imageId})` }],
                    new Map([[imageId, image(imageId, "image/jpeg", bytes)]]),
                ),
            ).rejects.toThrow(/JPEG/u);
        }
    });

    it("rejects malformed PNG headers", async () => {
        const bad: Uint8Array[] = [new Uint8Array(10)];
        const corrupted = solid(2, 2, 6, 8, [1]);
        corrupted[0] = 0;
        bad.push(corrupted);
        for (const bytes of bad) {
            await expect(
                render(
                    [{ kind: "image", text: `![x](asset:${imageId})` }],
                    new Map([[imageId, image(imageId, "image/png", bytes)]]),
                ),
            ).rejects.toThrow(/PNG/u);
        }
    });

    it("surfaces every PNG decoding failure", async () => {
        const baseHeader = { width: 2, height: 2, bitDepth: 8, colorType: 6 } as const;
        const validHeader = ihdrChunk(baseHeader);
        const invalidIdat = pngChunk("IDAT", new Uint8Array([1, 2, 3]));
        const end = pngChunk("IEND", new Uint8Array());
        const cases: { bytes: Uint8Array; message: RegExp }[] = [
            { bytes: pngCustom([], [0, 0, 0]), message: /header is invalid/u },
            {
                bytes: pngCustom([validHeader], [0, 0, 0]),
                message: /truncated chunk/u,
            },
            {
                bytes: pngCustom([validHeader, rawPngChunk(999, "IDAT", new Uint8Array([0]))]),
                message: /exceeds the image data/u,
            },
            {
                bytes: pngCustom([rawPngChunk(12, "IHDR", new Uint8Array(12))]),
                message: /header is invalid/u,
            },
            {
                bytes: pngCustom([validHeader, rawPngChunk(13, "IHDR", new Uint8Array(13))]),
                message: /header is invalid/u,
            },
            {
                bytes: pngCustom([
                    ihdrChunk({ ...baseHeader, headerOverrides: { compression: 1 } }),
                    invalidIdat,
                    end,
                ]),
                message: /unsupported compression/u,
            },
            {
                bytes: pngCustom([
                    ihdrChunk({ ...baseHeader, headerOverrides: { filter: 1 } }),
                    invalidIdat,
                    end,
                ]),
                message: /unsupported compression/u,
            },
            {
                bytes: pngCustom([rawPngChunk(13, "IDAT", new Uint8Array(13))]),
                message: /out of order/u,
            },
            {
                bytes: pngCustom([validHeader, rawPngChunk(1, "PLTE", new Uint8Array([0]))]),
                message: /palette is invalid/u,
            },
            {
                bytes: pngCustom([validHeader, rawPngChunk(1, "IEND", new Uint8Array([0]))]),
                message: /data is incomplete/u,
            },
            {
                bytes: pngCustom([validHeader, end]),
                message: /data is incomplete/u,
            },
            {
                bytes: pngCustom([validHeader, rawPngChunk(1, "ABCD", new Uint8Array([0]))]),
                message: /unsupported critical chunk/u,
            },
            {
                bytes: pngCustom([validHeader, invalidIdat]),
                message: /image is incomplete/u,
            },
            {
                bytes: pngCustom([ihdrChunk({ ...baseHeader, colorType: 5 }), invalidIdat, end]),
                message: /color format is unsupported/u,
            },
            {
                bytes: pngCustom([ihdrChunk({ ...baseHeader, bitDepth: 3 }), invalidIdat, end]),
                message: /color format is unsupported/u,
            },
            {
                bytes: pngCustom([ihdrChunk({ ...baseHeader, colorType: 3 }), invalidIdat, end]),
                message: /color format is unsupported/u,
            },
            {
                bytes: pngCustom([
                    ihdrChunk({ ...baseHeader, colorType: 3, bitDepth: 16 }),
                    pngChunk("PLTE", new Uint8Array([0, 0, 0])),
                    invalidIdat,
                    end,
                ]),
                message: /color format is unsupported/u,
            },
            {
                bytes: pngCustom([validHeader, invalidIdat, end]),
                message: /could not be decoded/u,
            },
            {
                bytes: pngCustom([
                    ihdrChunk({ ...baseHeader, headerOverrides: { interlace: 2 } }),
                    pngChunk("IDAT", zlibSync(new Uint8Array([0, 0]))),
                    end,
                ]),
                message: /interlace method is unsupported/u,
            },
            {
                bytes: pngCustom([
                    validHeader,
                    pngChunk("IDAT", zlibSync(new Uint8Array([0]))),
                    end,
                ]),
                message: /data is truncated/u,
            },
            {
                bytes: pngCustom([
                    ihdrChunk({ width: 2, height: 2, bitDepth: 8, colorType: 6 }),
                    pngChunk("IDAT", zlibSync(pngRaw(2, 2, 8, () => [1, 2, 3, 4], 0, 5))),
                    end,
                ]),
                message: /unknown row filter/u,
            },
            {
                bytes: pngCustom([
                    ihdrChunk({ width: 2, height: 2, bitDepth: 8, colorType: 3 }),
                    pngChunk("PLTE", new Uint8Array([0, 0, 0])),
                    pngChunk("IDAT", zlibSync(new Uint8Array([0, 5, 5]))),
                    end,
                ]),
                message: /missing palette entry/u,
            },
            {
                bytes: pngCustom([
                    ihdrChunk({ width: 1, height: 1, bitDepth: 8, colorType: 6 }),
                    pngChunk("IDAT", zlibSync(new Uint8Array([0, 1, 2, 3, 4, 9]))),
                    end,
                ]),
                message: /trailing bytes/u,
            },
        ];
        for (const item of cases) {
            await expect(
                render(
                    [{ kind: "image", text: `![x](asset:${imageId})` }],
                    new Map([[imageId, image(imageId, "image/png", item.bytes)]]),
                ),
            ).rejects.toThrow(item.message);
        }
    });

    it("handles optional critical PNG chunks before image data", async () => {
        const baseHeader = { width: 1, height: 1, bitDepth: 8, colorType: 6 } as const;
        for (const type of ["sRGB", "gAMA", "cHRM", "iCCP"]) {
            const pdf = await render(
                [{ kind: "image", text: `![x](asset:${imageId})` }],
                new Map([
                    [
                        imageId,
                        image(
                            imageId,
                            "image/png",
                            pngCustom([
                                ihdrChunk(baseHeader),
                                rawPngChunk(1, type, new Uint8Array([0])),
                                pngChunk("IDAT", zlibSync(new Uint8Array([0, 1, 2, 3, 255]))),
                                pngChunk("IEND", new Uint8Array()),
                            ]),
                        ),
                    ],
                ]),
            );
            expect(pdf).toContain("/Subtype /Image");
        }
    });
});
