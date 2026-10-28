import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";

export const GUIDE_BLOCK_KINDS = [
  "paragraph",
  "list-item",
  "quote",
  "code",
  "equation",
  "table",
  "image",
  "figure",
  "example",
  "instruction",
  "recommendation",
  "worked-example",
] as const;

export const GUIDE_BLOCK_ORIGINS = [
  "tutor-authored",
  "session-evidence",
  "ai-generated",
  "human-edited",
  "uncertain",
  "system-generated",
  "unknown",
] as const;

export type GuideBlockKind = (typeof GUIDE_BLOCK_KINDS)[number];
export type GuideBlockOrigin = (typeof GUIDE_BLOCK_ORIGINS)[number];

export interface GuideBlockDraft {
  kind: GuideBlockKind;
  text: string;
  sourceIds: string;
  stale: boolean;
  origin: GuideBlockOrigin;
}

export interface GuideSectionDraft {
  id: string;
  heading: string;
  blocks: GuideBlockDraft[];
}

export interface GuideDraft {
  title: string;
  sessionId: string;
  templateId: string;
  sections: GuideSectionDraft[];
}

export interface GuideExportImage {
  readonly assetId: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface GuideTemplate {
  id: string;
  name: string;
  subject: string;
  description: string;
  sections: readonly string[];
  body: string;
}

export interface GuideSourceScope {
  session: ArchiveRecord;
  records: readonly ArchiveRecord[];
}

export const GUIDE_TEMPLATES: readonly GuideTemplate[] = [
  {
    id: "general",
    name: "General tutoring",
    subject: "general",
    description: "Concepts, explanations, corrections, examples, and thoughtful next steps.",
    body: "Explain important concepts clearly, preserve corrections and explicit tutor instructions, and end with evidence-based next steps.",
    sections: [
      "Session overview",
      "Learning objectives",
      "Key concepts",
      "Detailed explanations",
      "Student misconceptions",
      "Errors and corrections",
      "Worked examples",
      "Practice recommendations",
      "Next-session priorities",
      "Sources",
    ],
  },
  {
    id: "english",
    name: "English",
    subject: "English",
    description: "Writing, rhetorical choices, grammar, evidence, and revision.",
    body: "For writing, connect rhetorical choices to audience and purpose. Distinguish a claim from its evidence and commentary. Preserve grammar corrections and show revision examples only when supported by the session.",
    sections: [
      "Session overview",
      "Learning objectives",
      "Argumentative writing",
      "Rhetorical analysis",
      "Grammar",
      "Evidence integration",
      "Revision examples",
      "Student misconceptions",
      "Tutor instructions",
      "Practice recommendations",
      "Next-session priorities",
      "Sources",
    ],
  },
  {
    id: "mathematics",
    name: "Mathematics",
    subject: "mathematics",
    description: "Formulas, derivations, worked solutions, misconceptions, and practice.",
    body: "Preserve formulas and notation. Explain each solution step and why it is valid. Separate verified session examples from newly suggested practice.",
    sections: [
      "Session overview",
      "Learning objectives",
      "Concepts and formulas",
      "Derivations",
      "Step-by-step solutions",
      "Student misconceptions",
      "Worked examples",
      "Practice recommendations",
      "Next-session priorities",
      "Sources",
    ],
  },
  {
    id: "science",
    name: "Science",
    subject: "science",
    description: "Definitions, experiments, reasoning, calculations, and limitations.",
    body: "State definitions and relationships precisely. Preserve experimental conditions, calculation steps, uncertainty, and scientific limitations present in the evidence.",
    sections: [
      "Session overview",
      "Learning objectives",
      "Definitions and relationships",
      "Experiments",
      "Scientific reasoning",
      "Calculations",
      "Limitations",
      "Student misconceptions",
      "Practice recommendations",
      "Next-session priorities",
      "Sources",
    ],
  },
  {
    id: "programming",
    name: "Programming",
    subject: "programming",
    description: "Errors, debugging, algorithms, examples, alternatives, and complexity.",
    body: "Explain observed errors and the debugging process. Keep code examples tied to session evidence; identify generated examples as new examples. Discuss complexity only when the session supports it.",
    sections: [
      "Session overview",
      "Learning objectives",
      "Errors and debugging",
      "Algorithm explanations",
      "Code examples",
      "Alternative implementations",
      "Complexity",
      "Student misconceptions",
      "Practice recommendations",
      "Next-session priorities",
      "Sources",
    ],
  },
  {
    id: "language-learning",
    name: "Language learning",
    subject: "language-learning",
    description: "Vocabulary, pronunciation, grammar, usage, corrections, and practice.",
    body: "Preserve vocabulary and usage in the language studied. Mark uncertain pronunciation or transcription explicitly, and distinguish observed corrections from suggested practice.",
    sections: [
      "Session overview",
      "Learning objectives",
      "Vocabulary",
      "Pronunciation",
      "Grammar and usage",
      "Corrections",
      "Worked examples",
      "Practice recommendations",
      "Next-session priorities",
      "Sources",
    ],
  },
];

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const INLINE_SOURCE_PATTERN = /\[\[source:([^\]]+)\]\]/gu;
const guideFieldPattern = /^section\.\d+(?:\.block\.\d+)?\./u;
const nowUs = (): string => (BigInt(Date.now()) * 1000n).toString();

export function createGuideDraft(
  session: ArchiveRecord,
  templateId = inferGuideTemplateId(field(session, "subject")),
): GuideDraft {
  const template = getGuideTemplate(templateId);
  return createGuideDraftFromSections(session, template.id, template.sections);
}

export function createGuideDraftFromSections(
  session: ArchiveRecord,
  templateId: string,
  headings: readonly string[],
): GuideDraft {
  return {
    title: `${field(session, "title", "Tutoring Session")} — Study Guide`,
    sessionId: session.id,
    templateId,
    sections: headings.map((heading) => ({
      id: newUuid(),
      heading,
      blocks: [],
    })),
  };
}

export function guideDraftFromRecord(record: ArchiveRecord): GuideDraft {
  if (record.type !== RecordType.guide) throw new Error("Only a study guide can be edited here.");
  const sectionCount = boundedCount(field(record, "section_count"), "guide section");
  const sections: GuideSectionDraft[] = [];
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const prefix = `section.${sectionIndex}.`;
    const blockCount = boundedCount(field(record, `${prefix}block_count`), "guide block");
    const blocks: GuideBlockDraft[] = [];
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const blockPrefix = `${prefix}block.${blockIndex}.`;
      blocks.push({
        kind: validKind(field(record, `${blockPrefix}kind`)),
        text: field(record, `${blockPrefix}text`),
        sourceIds: field(record, `${blockPrefix}source_ids`),
        stale: field(record, `${blockPrefix}stale`) === "true",
        origin: validOrigin(field(record, `${blockPrefix}origin`, "unknown")),
      });
    }
    sections.push({
      id: field(record, `${prefix}id`) || newUuid(),
      heading: field(record, `${prefix}heading`),
      blocks,
    });
  }
  return {
    title: field(record, "title"),
    sessionId: field(record, "session_id"),
    templateId: field(record, "template_id", "general"),
    sections,
  };
}

export function makeGuideRecord(
  draft: GuideDraft,
  scope: GuideSourceScope,
  current: ArchiveRecord | null = null,
): ArchiveRecord {
  if (current && current.type !== RecordType.guide)
    throw new Error("Only a study guide can be updated here.");
  if (scope.session.type !== RecordType.session || scope.session.fields.get("_deleted") === "true")
    throw new Error("Choose an active session for this study guide.");
  if (draft.sessionId !== scope.session.id)
    throw new Error("The selected session changed. Reopen the guide editor.");

  const title = cleanText(draft.title, "Guide title", 240).trim();
  if (!title) throw new Error("Guide title is required.");
  const templateId = cleanText(draft.templateId, "Template ID", 128).trim() || "general";
  if (draft.sections.length === 0) throw new Error("Add at least one section to the guide.");
  if (draft.sections.length > 250) throw new Error("A guide can contain at most 250 sections.");

  const sections = draft.sections.map((section, sectionIndex) => {
    const heading = cleanText(section.heading, `Section ${sectionIndex + 1} heading`, 256).trim();
    if (!heading) throw new Error("Every guide section needs a heading.");
    if (section.blocks.length > 1_000)
      throw new Error("A section can contain at most 1,000 blocks.");
    const blocks = section.blocks.map((block, blockIndex) => {
      const kind = validKind(block.kind);
      const text = cleanText(block.text, `Block ${blockIndex + 1} text`, 16 * 1024 * 1024, true);
      const origin = validOrigin(block.origin);
      const sourceIds = parseSourceIds(block.sourceIds, text, kind);
      for (const sourceId of sourceIds) {
        if (!isSourceInScope(sourceId, scope)) {
          throw new Error(`Source ${sourceId} is missing or does not belong to this session.`);
        }
      }
      return { kind, text, sourceIds, stale: block.stale, origin };
    });
    return { ...section, heading, blocks };
  });

  const fields = new Map(current?.fields ?? []);
  for (const key of fields.keys()) {
    if (guideFieldPattern.test(key)) fields.delete(key);
  }
  const sessionId = scope.session.id.toLowerCase();
  const entryId = field(scope.session, "entry_id");
  const staleBlockCount = sections.reduce(
    (count, section) => count + section.blocks.filter((block) => block.stale).length,
    0,
  );
  const timestamp = nowUs();
  fields.set("entry_id", entryId);
  fields.set("session_id", sessionId);
  fields.set("title", title);
  fields.set("template_id", templateId);
  fields.set("approval_state", "draft");
  fields.set("section_count", sections.length.toString());
  fields.set("stale_block_count", staleBlockCount.toString());
  fields.set("updated_at_us", timestamp);
  if (!fields.has("created_at_us")) fields.set("created_at_us", timestamp);

  sections.forEach((section, sectionIndex) => {
    const prefix = `section.${sectionIndex}.`;
    fields.set(`${prefix}id`, section.id);
    fields.set(`${prefix}heading`, section.heading);
    fields.set(`${prefix}block_count`, section.blocks.length.toString());
    section.blocks.forEach((block, blockIndex) => {
      const blockPrefix = `${prefix}block.${blockIndex}.`;
      fields.set(`${blockPrefix}kind`, block.kind);
      fields.set(`${blockPrefix}text`, block.text);
      fields.set(`${blockPrefix}source_ids`, block.sourceIds.join(","));
      fields.set(`${blockPrefix}stale`, block.stale ? "true" : "false");
      fields.set(`${blockPrefix}origin`, block.origin);
    });
  });

  return {
    type: RecordType.guide,
    id: current?.id ?? newUuid(),
    revision: current?.revision ?? 0n,
    previousOffset: current?.previousOffset ?? 0n,
    fields,
    blob: current?.blob ?? new Uint8Array(),
  };
}

export function approveGuideRecord(record: ArchiveRecord): ArchiveRecord {
  if (record.type !== RecordType.guide) throw new Error("Only a study guide can be approved.");
  if (field(record, "_deleted") === "true") throw new Error("A guide in Trash cannot be approved.");
  const staleCount = boundedCount(field(record, "stale_block_count", "0"), "stale guide block");
  if (staleCount > 0)
    throw new Error("Review every source-changed block before approving this guide.");
  const fields = new Map(record.fields);
  fields.set("approval_state", "approved");
  fields.set("approved_at_us", nowUs());
  fields.set("updated_at_us", nowUs());
  return { ...record, fields };
}

export function renderGuideMarkdown(record: ArchiveRecord): string {
  const draft = guideDraftFromRecord(record);
  const sections = draft.sections.map((section) => {
    const blocks = section.blocks.map((block) => {
      const prefix = block.kind === "list-item" ? "- " : block.kind === "quote" ? "> " : "";
      const stale = block.stale ? "**Source changed — review this block.** " : "";
      const label = guideBlockLabel(block.kind, block.origin);
      const text = block.text.replace(/\[\[source:([^\]]+)\]\]/gu, "[source: $1]");
      const citations = block.sourceIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const sourceLine = citations.length
        ? `  \n_Source: ${citations.map((id) => `\`${id}\``).join(", ")}_`
        : "";
      return `${prefix}${stale}${label ? `**${label}:** ` : ""}${text}${sourceLine}`;
    });
    return `## ${section.heading}\n\n${blocks.join("\n\n")}`;
  });
  return `# ${draft.title}\n\n_Tutorux study guide · ${draft.templateId} template · ${field(record, "approval_state", "draft")}_\n\n${sections.join("\n\n")}${sections.length ? "\n" : ""}`;
}

export function renderGuideHtml(
  record: ArchiveRecord,
  images: ReadonlyMap<string, GuideExportImage> = new Map(),
): string {
  const draft = guideDraftFromRecord(record);
  const approval = field(record, "approval_state", "draft");
  const sections = draft.sections
    .map((section) => {
      const blocks = section.blocks
        .map((block) => {
          const label = guideBlockLabel(block.kind, block.origin);
          const imageReference = parseGuideImageReference(block.text);
          const isImage =
            block.kind === "image" || block.kind === "figure" || block.text.startsWith("![");
          if (isImage && !imageReference)
            throw new Error("A guide image must point to one archive asset UUID.");
          const content = imageReference
            ? renderGuideImage(imageReference, images)
            : block.kind === "table"
              ? renderGuideTable(block.text)
              : renderGuideTextBlock(block.kind, block.text);
          const sources = block.sourceIds
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          return `<article class="guide-block">
            <p class="guide-block-kind">${escapeHtml(label || block.kind)}</p>
            ${block.stale ? '<aside class="guide-stale">Source changed. Review this block against the archive before relying on it.</aside>' : ""}
            ${content}
            ${sources.length ? `<p class="guide-sources"><strong>Sources:</strong> ${sources.map(escapeHtml).join(", ")}</p>` : ""}
          </article>`;
        })
        .join("\n");
      return `<section class="guide-section">
        <h2>${escapeHtml(section.heading)}</h2>
        ${blocks}
      </section>`;
    })
    .join("\n");
  const template = escapeHtml(draft.templateId);
  const state = escapeHtml(approval);
  const title = escapeHtml(draft.title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${title} · Tutorux study guide</title>
  <style>
    :root { color-scheme: light; font-family: "Noto Sans", "Segoe UI", sans-serif; color: #18211b; background: #f4f6f3; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px 18px; }
    .document { max-width: 860px; margin: 0 auto; padding: 54px 64px 62px; background: #fff; border: 1px solid #dfe6df; border-radius: 10px; box-shadow: 0 12px 36px rgb(19 39 27 / 8%); }
    .document-header { padding-bottom: 26px; border-bottom: 1px solid #dfe6df; }
    .brand { margin: 0 0 22px; color: #315b4a; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(30px, 5vw, 42px); line-height: 1.12; letter-spacing: -.04em; text-wrap: balance; }
    .document-meta { margin: 12px 0 0; color: #637267; font-size: 13px; }
    .guide-section { margin-top: 34px; break-inside: avoid-page; }
    h2 { margin: 0 0 14px; padding-bottom: 9px; border-bottom: 1px solid #e6ebe6; font-size: 21px; letter-spacing: -.025em; }
    .guide-block { margin: 0 0 18px; break-inside: avoid; }
    .guide-block-kind { margin: 0 0 6px; color: #637267; font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
    .guide-text { margin: 0; color: #35443a; font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
    ul { margin: 0; padding-left: 22px; }
    blockquote { padding-left: 16px; border-left: 3px solid #9bc8aa; }
    pre { padding: 12px 14px; border-radius: 6px; background: #f0f3ef; font: 13px/1.6 ui-monospace, "Cascadia Code", monospace; }
    .guide-stale { margin: 0 0 8px; padding: 9px 11px; border-left: 3px solid #9b6e2f; background: #fbf4e9; color: #704d20; font-size: 12px; line-height: 1.5; }
    .guide-sources { margin: 8px 0 0; color: #637267; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
    .guide-table { width: 100%; margin: 12px 0; border-collapse: collapse; font-size: 13px; line-height: 1.5; }
    .guide-table th, .guide-table td { padding: 8px 10px; border: 1px solid #d9e0d8; text-align: left; vertical-align: top; }
    .guide-table th { background: #edf1eb; color: #28463c; }
    .guide-figure { margin: 16px 0; text-align: center; }
    .guide-figure img { max-width: 100%; max-height: 680px; object-fit: contain; }
    .guide-figure figcaption { margin-top: 7px; color: #637267; font-size: 12px; }
    .document-footer { margin-top: 38px; padding-top: 14px; border-top: 1px solid #dfe6df; color: #637267; font-size: 10px; }
    @media (max-width: 620px) { body { padding: 0; } .document { padding: 32px 22px; border: 0; border-radius: 0; box-shadow: none; } }
    @media print { :root { background: #fff; } body { padding: 0; } .document { max-width: none; margin: 0; padding: 0; border: 0; border-radius: 0; box-shadow: none; } .guide-section { margin-top: 24px; } }
  </style>
</head>
<body>
  <main class="document">
    <header class="document-header">
      <p class="brand">Tutorux · Study guide</p>
      <h1>${title}</h1>
      <p class="document-meta">${template} structure · ${state}</p>
    </header>
    ${sections}
    <footer class="document-footer">Source identifiers refer to records in the Tutorux archive. Check any source-change notices against the original archive.</footer>
  </main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
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
        return "&#39;";
    }
  });
}

interface GuideImageReference {
  assetId: string;
  alternativeText: string;
}

export function parseGuideImageReference(text: string): GuideImageReference | null {
  const match =
    /^!\[((?:\\.|[^\]])*)\]\(asset:([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\)$/iu.exec(
      text,
    );
  if (!match) return null;
  return {
    assetId: match[2]!.toLowerCase(),
    alternativeText: match[1]!.replace(/\\([\\\]])/gu, "$1"),
  };
}

function renderGuideImage(
  reference: GuideImageReference,
  images: ReadonlyMap<string, GuideExportImage>,
): string {
  const image = images.get(reference.assetId);
  if (!image) throw new Error(`Guide image ${reference.assetId} is missing from this archive.`);
  if (!/^image\/(?:png|jpeg|jpg|gif|webp)$/u.test(image.mimeType))
    throw new Error("Only PNG, JPEG, GIF, and WebP guide images can be exported.");
  const source = `data:${image.mimeType};base64,${bytesToBase64(image.bytes)}`;
  const caption = reference.alternativeText
    ? `<figcaption>${escapeHtml(reference.alternativeText)}</figcaption>`
    : "";
  return `<figure class="guide-figure"><img src="${source}" alt="${escapeHtml(reference.alternativeText)}">${caption}</figure>`;
}

function renderGuideTextBlock(kind: string, value: string): string {
  const text = escapeHtml(value);
  switch (kind) {
    case "list-item":
      return `<ul><li class="guide-text">${text}</li></ul>`;
    case "quote":
      return `<blockquote class="guide-text">${text}</blockquote>`;
    case "code":
      return `<pre class="guide-text">${text}</pre>`;
    case "equation":
      return `<div class="guide-equation guide-text">${text}</div>`;
    default:
      return `<p class="guide-text">${text}</p>`;
  }
}

function renderGuideTable(value: string): string {
  const rows = parseGuideTable(value);
  const [headers, ...body] = rows;
  return `<table class="guide-table"><thead><tr>${headers!.map((cell) => `<th scope="col">${escapeHtml(renderInlineSources(cell))}</th>`).join("")}</tr></thead><tbody>${body
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(renderInlineSources(cell))}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function parseGuideTable(value: string): string[][] {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = lines.map((line) => {
    const trimmed = line.replace(/^\|/u, "").replace(/\|$/u, "");
    const cells: string[] = [];
    let cell = "";
    let escaped = false;
    for (const character of trimmed) {
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
    throw new Error("A guide table needs matching columns and a Markdown separator row.");
  }
  return [rows[0]!, ...rows.slice(2)];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)),
    );
  }
  return btoa(binary);
}

function renderInlineSources(value: string): string {
  return value.replace(INLINE_SOURCE_PATTERN, "[source: $1]");
}

export function getGuideTemplate(id: string): GuideTemplate {
  return GUIDE_TEMPLATES.find((template) => template.id === id) ?? GUIDE_TEMPLATES[0]!;
}

export function inferGuideTemplateId(subject: string): string {
  const value = subject.toLocaleLowerCase();
  if (
    ["english", "writing", "literature", "rhetoric", "essay"].some((term) => value.includes(term))
  )
    return "english";
  if (
    ["math", "algebra", "geometry", "calculus", "arithmetic"].some((term) => value.includes(term))
  )
    return "mathematics";
  if (
    ["programming", "coding", "software", "computer science"].some((term) => value.includes(term))
  )
    return "programming";
  if (
    [
      "language",
      "spanish",
      "french",
      "mandarin",
      "chinese",
      "german",
      "japanese",
      "italian",
      "pronunciation",
      "vocabulary",
    ].some((term) => value.includes(term))
  )
    return "language-learning";
  if (
    ["science", "biology", "chemistry", "physics", "experiment"].some((term) =>
      value.includes(term),
    )
  )
    return "science";
  return "general";
}

export function field(record: ArchiveRecord, key: string, fallback = ""): string {
  return record.fields.get(key) ?? fallback;
}

function parseSourceIds(raw: string, text: string, kind: GuideBlockKind): string[] {
  const ids = raw
    .split(/[\s,;]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const validInlineText = text.replace(INLINE_SOURCE_PATTERN, "");
  for (const match of text.matchAll(INLINE_SOURCE_PATTERN)) {
    const id = match[1]!.trim().toLowerCase();
    if (!UUID_PATTERN.test(id))
      throw new Error("Inline sources must use valid archive record IDs.");
    if (!ids.some((existing) => existing.toLowerCase() === id)) ids.push(id);
  }
  if (validInlineText.includes("[[source:")) {
    throw new Error("An inline source reference needs a valid UUID and closing brackets.");
  }
  if (kind === "table") validateGuideTable(text);
  if (kind === "image" || kind === "figure" || text.startsWith("![")) {
    const image =
      /^!\[(?:\\.|[^\]])*\]\(asset:([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\)$/iu.exec(
        text,
      );
    if (!image)
      throw new Error(
        "Image blocks must use one archive asset reference: ![description](asset:UUID).",
      );
    const id = image[1]!.toLowerCase();
    if (!ids.some((existing) => existing.toLowerCase() === id)) ids.push(id);
  }
  for (const id of ids) {
    if (!UUID_PATTERN.test(id)) throw new Error(`Source ID “${id}” is not a valid UUID.`);
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

function isSourceInScope(sourceId: string, scope: GuideSourceScope): boolean {
  const sessionId = scope.session.id.toLowerCase();
  const studentId = field(scope.session, "student_id").toLowerCase();
  const entryId = field(scope.session, "entry_id").toLowerCase();
  const notesId = field(scope.session, "notes_document_id").toLowerCase();
  if (sourceId === sessionId) return true;
  const record = scope.records.find((item) => item.id.toLowerCase() === sourceId);
  if (!record || field(record, "_deleted") === "true") return false;
  if (record.type === RecordType.session) return record.id.toLowerCase() === sessionId;
  if (record.type === RecordType.student) return record.id.toLowerCase() === studentId;
  if (record.type === RecordType.settings) {
    return (
      (field(record, "record_role") === "journal-notes" &&
        (record.id.toLowerCase() === notesId ||
          field(record, "session_id").toLowerCase() === sessionId ||
          (Boolean(entryId) && field(record, "entry_id").toLowerCase() === entryId))) ||
      false
    );
  }
  if (record.type === RecordType.assetMetadata) {
    return (
      field(record, "session_id").toLowerCase() === sessionId ||
      (Boolean(studentId) && field(record, "student_id").toLowerCase() === studentId)
    );
  }
  const sessionSourceTypes: readonly number[] = [
    RecordType.transcriptSegment,
    RecordType.annotation,
    RecordType.evidenceNode,
  ];
  return (
    sessionSourceTypes.includes(record.type) &&
    field(record, "session_id").toLowerCase() === sessionId
  );
}

function validateGuideTable(value: string): void {
  const rows = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split(/(?<!\\)\|/u)
        .map((cell) => cell.trim()),
    );
  const separator = (cell: string): boolean => /^:?-{3,}:?$/u.test(cell);
  if (
    rows.length < 2 ||
    rows[0]!.length === 0 ||
    rows[0]!.length !== rows[1]!.length ||
    !rows[1]!.every(separator) ||
    rows.slice(2).some((row) => row.length !== rows[0]!.length)
  ) {
    throw new Error(
      "A table needs a header row, a matching Markdown separator row, and consistent columns.",
    );
  }
}

function validKind(value: string): GuideBlockKind {
  if ((GUIDE_BLOCK_KINDS as readonly string[]).includes(value)) return value as GuideBlockKind;
  return "paragraph";
}

function validOrigin(value: string): GuideBlockOrigin {
  if ((GUIDE_BLOCK_ORIGINS as readonly string[]).includes(value)) return value as GuideBlockOrigin;
  return "unknown";
}

function boundedCount(raw: string, label: string): number {
  if (!/^\d+$/u.test(raw)) throw new Error(`The ${label} count is invalid.`);
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0 || count > 10_000)
    throw new Error(`The ${label} count is outside supported limits.`);
  return count;
}

function cleanText(value: string, label: string, maxBytes: number, multiline = false): string {
  if (new TextEncoder().encode(value).byteLength > maxBytes)
    throw new Error(`${label} must be ${maxBytes} UTF-8 bytes or fewer.`);
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && !(multiline && code === 0x0a))) {
      throw new Error(`${label} contains unsupported control characters.`);
    }
  }
  return value;
}

export function guideBlockLabel(kind: GuideBlockKind, origin: GuideBlockOrigin): string {
  if (origin === "ai-generated") {
    if (kind === "recommendation") return "AI recommendation";
    if (kind === "instruction") return "AI-drafted instruction";
    if (kind === "example" || kind === "worked-example") return "AI-generated example";
    const semantic = guideBlockLabel(kind, "tutor-authored");
    return semantic ? `AI-generated ${semantic.toLocaleLowerCase()}` : "AI-generated content";
  }
  if (origin === "human-edited") {
    if (kind === "instruction") return "Tutor-edited instruction";
    if (kind === "recommendation") return "Tutor-edited recommendation";
    if (kind === "example" || kind === "worked-example") return "Tutor-edited example";
    return "Tutor-edited content";
  }
  if (origin === "uncertain") return "Uncertain interpretation";
  if (origin === "system-generated") return "Tutorux-generated notice";
  if (origin === "unknown") return "Content with unverified provenance";
  if (kind === "instruction") return "Tutor instruction";
  if (kind === "recommendation") return "AI recommendation";
  if (kind === "worked-example") return "Worked example";
  return "";
}
