import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import { notesEditState } from "./records";
import {
    classificationLabel,
    decodeStudentProgress,
    validateProgressEvidence,
} from "./student-progress";
import { formatTranscriptTimestampUs } from "./transcript";

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

export type GuideBlockKind = (typeof GUIDE_BLOCK_KINDS)[number] | (string & {});
export type GuideBlockOrigin = (typeof GUIDE_BLOCK_ORIGINS)[number] | (string & {});

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

/** Return an immutable section ordering with the requested neighboring move applied. */
export function moveGuideSection(
    sections: readonly GuideSectionDraft[],
    index: number,
    direction: -1 | 1,
): GuideSectionDraft[] {
    const targetIndex = index + direction;
    if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= sections.length ||
        targetIndex < 0 ||
        targetIndex >= sections.length
    ) {
        return [...sections];
    }
    const next = [...sections];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    return next;
}

export interface GuideTextMatch {
    sectionIndex: number;
    blockIndex: number;
    start: number;
    end: number;
}

/** Find non-overlapping, case-sensitive matches in the selected guide block, if supplied. */
export function findGuideTextMatches(
    draft: GuideDraft,
    query: string,
    selectedBlock?: Pick<GuideTextMatch, "sectionIndex" | "blockIndex">,
): GuideTextMatch[] {
    if (!query) return [];
    const matches: GuideTextMatch[] = [];
    draft.sections.forEach((section, sectionIndex) => {
        if (selectedBlock && selectedBlock.sectionIndex !== sectionIndex) return;
        section.blocks.forEach((block, blockIndex) => {
            if (selectedBlock && selectedBlock.blockIndex !== blockIndex) return;
            let start = block.text.indexOf(query);
            while (start !== -1) {
                matches.push({ sectionIndex, blockIndex, start, end: start + query.length });
                start = block.text.indexOf(query, start + query.length);
            }
        });
    });
    return matches;
}

/** Replace one still-current match, preserving its block identity and source links. */
export function replaceGuideTextMatch(
    draft: GuideDraft,
    match: GuideTextMatch,
    query: string,
    replacement: string,
): GuideDraft {
    const section = draft.sections[match.sectionIndex];
    const block = section?.blocks[match.blockIndex];
    if (
        !query ||
        !block ||
        !Number.isInteger(match.start) ||
        !Number.isInteger(match.end) ||
        match.start < 0 ||
        match.end !== match.start + query.length ||
        block.text.slice(match.start, match.end) !== query
    ) {
        return draft;
    }
    const text = block.text.slice(0, match.start) + replacement + block.text.slice(match.end);
    if (text === block.text) return draft;
    return {
        ...draft,
        sections: draft.sections.map((currentSection, sectionIndex) =>
            sectionIndex !== match.sectionIndex
                ? currentSection
                : {
                      ...currentSection,
                      blocks: currentSection.blocks.map((currentBlock, blockIndex) =>
                          blockIndex !== match.blockIndex
                              ? currentBlock
                              : { ...currentBlock, text, stale: false, origin: "human-edited" },
                      ),
                  },
        ),
    };
}

/** Replace non-overlapping matches in the selected block when provided, retaining its citations. */
export function replaceAllGuideText(
    draft: GuideDraft,
    query: string,
    replacement: string,
    selectedBlock?: Pick<GuideTextMatch, "sectionIndex" | "blockIndex">,
): { draft: GuideDraft; replacedCount: number } {
    if (!query || query === replacement) return { draft, replacedCount: 0 };
    const matches = findGuideTextMatches(draft, query, selectedBlock);
    if (!matches.length) return { draft, replacedCount: 0 };
    const matchesByBlock = new Map<string, GuideTextMatch[]>();
    for (const match of matches) {
        const key = `${match.sectionIndex}:${match.blockIndex}`;
        const inBlock = matchesByBlock.get(key) ?? [];
        inBlock.push(match);
        matchesByBlock.set(key, inBlock);
    }
    const sections = draft.sections.map((section, sectionIndex) => ({
        ...section,
        blocks: section.blocks.map((block, blockIndex) => {
            const inBlock = matchesByBlock.get(`${sectionIndex}:${blockIndex}`);
            if (!inBlock) return block;
            let text = block.text;
            for (let index = inBlock.length - 1; index >= 0; index -= 1) {
                const match = inBlock[index]!;
                text = text.slice(0, match.start) + replacement + text.slice(match.end);
            }
            return { ...block, text, stale: false, origin: "human-edited" as const };
        }),
    }));
    return { draft: { ...draft, sections }, replacedCount: matches.length };
}

export interface GuideDraft {
    title: string;
    sessionId: string;
    entryId?: string;
    templateId: string;
    sections: GuideSectionDraft[];
}

/** Prepare the CLI-compatible copy title and a deep immutable draft for a new guide record. */
export function duplicateGuideDraft(draft: GuideDraft): GuideDraft {
    const suffix = " (copy)";
    const encoder = new TextEncoder();
    const maximumPrefixBytes = 240 - encoder.encode(suffix).byteLength;
    let titlePrefix = "";
    for (const character of draft.title.trimEnd()) {
        if (encoder.encode(titlePrefix + character).byteLength > maximumPrefixBytes) break;
        titlePrefix += character;
    }
    return {
        ...draft,
        title: `${titlePrefix.trimEnd()}${suffix}`,
        sections: draft.sections.map((section) => ({
            ...section,
            blocks: section.blocks.map((block) => ({ ...block })),
        })),
    };
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
    session?: ArchiveRecord;
    entry?: ArchiveRecord;
    records: readonly ArchiveRecord[];
}

export const GUIDE_TEMPLATES: readonly GuideTemplate[] = [
    {
        id: "general",
        name: "General tutoring",
        subject: "general",
        description: "Concepts, explanations, corrections, instructions, examples, and next steps.",
        body: "Explain important concepts clearly, preserve corrections and explicit tutor instructions, and end with evidence-based next steps.",
        sections: [
            "Session overview",
            "Learning objectives",
            "Key concepts",
            "Detailed explanations",
            "Terminology",
            "Student misconceptions",
            "Errors and corrections",
            "Tutor instructions",
            "Worked examples",
            "Important notices",
            "Supporting materials",
            "Practice recommendations",
            "Progress since previous lessons",
            "Next-session priorities",
            "Sources",
        ],
    },
    {
        id: "english",
        name: "English",
        subject: "English",
        description:
            "Argumentative writing, rhetorical analysis, commentary, grammar, evidence, and revision.",
        body: "For writing, connect rhetorical choices to audience and purpose. Distinguish a claim from its evidence and commentary. Preserve grammar corrections and show revision examples only when supported by the session.",
        sections: [
            "Session overview",
            "Learning objectives",
            "Argumentative writing",
            "Rhetorical analysis",
            "Commentary",
            "Grammar",
            "Evidence integration",
            "Revision examples",
            "Student misconceptions",
            "Errors and corrections",
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
        description:
            "Concepts, formulas, derivations, step-by-step solutions, misconceptions, and practice.",
        body: "Preserve formulas and notation. Explain each solution step and why it is valid. Separate verified session examples from newly suggested practice.",
        sections: [
            "Session overview",
            "Learning objectives",
            "Concepts",
            "Formulas",
            "Derivations",
            "Step-by-step solutions",
            "Student misconceptions",
            "Errors and corrections",
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
        description:
            "Definitions, relationships, experiments, reasoning, calculations, and limitations.",
        body: "State definitions and relationships precisely. Preserve experimental conditions, calculation steps, uncertainty, and scientific limitations present in the evidence.",
        sections: [
            "Session overview",
            "Learning objectives",
            "Definitions",
            "Relationships",
            "Experiments",
            "Scientific reasoning",
            "Calculations",
            "Limitations",
            "Student misconceptions",
            "Errors and corrections",
            "Practice recommendations",
            "Next-session priorities",
            "Sources",
        ],
    },
    {
        id: "programming",
        name: "Programming",
        subject: "programming",
        description: "Errors, debugging, algorithms, code, alternatives, and complexity.",
        body: "Explain observed errors and the debugging process. Keep code examples tied to session evidence; identify generated examples as new examples. Discuss complexity only when the session supports it.",
        sections: [
            "Session overview",
            "Learning objectives",
            "Errors",
            "Debugging steps",
            "Algorithm explanations",
            "Code examples",
            "Alternative implementations",
            "Complexity",
            "Student misconceptions",
            "Corrections",
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
            "Grammar",
            "Usage",
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

function storedGuideTemplateSections(value: string): string[] {
    return value
        .split(/\r\n|\r|\n/u)
        .map((section) => section.trim())
        .filter(Boolean);
}

/** Replace a built-in definition with the archive override when one is stored. */
export function applyGuideTemplateOverride(
    template: GuideTemplate,
    records: readonly ArchiveRecord[],
): GuideTemplate {
    const override = records.find(
        (record) =>
            record.type === RecordType.settings &&
            field(record, "_deleted") !== "true" &&
            field(record, "record_role") === "guide-template" &&
            field(record, "builtin_template_id") === template.id,
    );
    if (!override) return template;
    const sections = storedGuideTemplateSections(field(override, "sections"));
    return {
        ...template,
        name: field(override, "name") || template.name,
        subject: field(override, "subject") || template.subject,
        description: field(override, "description") || template.description,
        sections: sections.length ? sections : template.sections,
        body: field(override, "body") || template.body,
    };
}

export function builtInGuideTemplates(records: readonly ArchiveRecord[]): GuideTemplate[] {
    return GUIDE_TEMPLATES.map((template) => applyGuideTemplateOverride(template, records));
}

export function customGuideTemplates(records: readonly ArchiveRecord[]): GuideTemplate[] {
    return records
        .filter(
            (record) =>
                record.type === RecordType.settings &&
                field(record, "_deleted") !== "true" &&
                field(record, "record_role") === "guide-template" &&
                !field(record, "builtin_template_id"),
        )
        .map((record) => ({
            id: record.id,
            name: field(record, "name", "Untitled template"),
            subject: field(record, "subject", "general"),
            description: field(record, "description"),
            sections: storedGuideTemplateSections(field(record, "sections")),
            body: field(record, "body"),
        }));
}

/** Resolve the full catalog, applying archive-built-in overrides and adding saved custom templates. */
export function resolveGuideTemplates(
    records: readonly ArchiveRecord[],
    templates: readonly GuideTemplate[] = GUIDE_TEMPLATES,
): GuideTemplate[] {
    const resolved = templates.map((template) => applyGuideTemplateOverride(template, records));
    const known = new Set(resolved.map((template) => template.id.toLocaleLowerCase()));
    for (const custom of customGuideTemplates(records)) {
        if (known.has(custom.id.toLocaleLowerCase())) continue;
        known.add(custom.id.toLocaleLowerCase());
        resolved.push(custom);
    }
    return resolved;
}

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
        entryId: field(session, "entry_id"),
        templateId,
        sections: headings.map((heading) => ({
            id: newUuid(),
            heading,
            blocks: [],
        })),
    };
}

/** Build an editable guide draft from session records without inferring unverified learning outcomes. */
export function generateGuideDraftFromSession(
    session: ArchiveRecord,
    templateId: string,
    records: readonly ArchiveRecord[],
    students: readonly ArchiveRecord[],
    templates: readonly GuideTemplate[] = GUIDE_TEMPLATES,
    includeEntryEvidence = false,
): GuideDraft {
    if (session.type !== RecordType.session || field(session, "_deleted") === "true") {
        throw new Error("Choose an active session before generating a study guide.");
    }

    const requestedTemplate = templateId.trim();
    const automatic = !requestedTemplate || requestedTemplate.toLocaleLowerCase() === "auto";
    const studentId = field(session, "student_id").toLocaleLowerCase();
    const student =
        studentId && studentId !== "anonymous"
            ? students.find((record) => record.id.toLocaleLowerCase() === studentId)
            : undefined;
    const inferredTemplateId = inferGuideTemplateId(field(session, "subject"));
    const preferredTemplateId = student ? field(student, "preferred_guide_template") : "";
    const sessionTemplateId = field(session, "guide_template_id").trim();
    const resolvedTemplateId = automatic
        ? sessionTemplateId || preferredTemplateId || inferredTemplateId
        : requestedTemplate;
    const normalizedTemplateId = resolvedTemplateId.toLocaleLowerCase();
    const catalog = resolveGuideTemplates(records, templates);
    const template =
        catalog.find(
            (candidate) =>
                candidate.id.toLocaleLowerCase() === normalizedTemplateId ||
                candidate.name.toLocaleLowerCase() === normalizedTemplateId,
        ) ??
        (automatic && !sessionTemplateId
            ? catalog.find(
                  (candidate) =>
                      candidate.id.toLocaleLowerCase() === inferredTemplateId.toLocaleLowerCase(),
              )
            : undefined);
    if (!template) throw new Error("Choose a study guide template available in this archive.");

    const draft = createGuideDraftFromSections(session, template.id, template.sections);
    const sessionId = session.id.toLocaleLowerCase();
    const entryId = field(session, "entry_id").toLocaleLowerCase();
    const activeRecords = records.filter((record) => field(record, "_deleted") !== "true");
    const sessionRecords = activeRecords.filter((record) => {
        const sourceSessionId = field(record, "session_id").toLocaleLowerCase();
        if (sourceSessionId === sessionId) return true;
        return (
            includeEntryEvidence &&
            Boolean(entryId) &&
            record.type === RecordType.settings &&
            field(record, "record_role") === "journal-notes" &&
            field(record, "entry_id").toLocaleLowerCase() === entryId
        );
    });
    const overview = getOrAddGuideSection(draft, "Session overview");
    const sessionTitle = field(session, "title", "Tutoring Session");
    const subject = field(session, "subject");
    overview.blocks.push({
        kind: "paragraph",
        text: `Session: ${sessionTitle}${subject ? `\nSubject: ${subject}` : ""}`,
        sourceIds: session.id,
        stale: false,
        origin: "session-evidence",
    });
    const objectives = field(session, "learning_objectives");
    if (objectives) {
        overview.blocks.push({
            kind: "paragraph",
            text: `Learning objectives provided for this session:\n${objectives}`,
            sourceIds: session.id,
            stale: false,
            origin: "session-evidence",
        });
    }

    if (student) addTutorProfileContext(draft, student);

    const annotations = sessionRecords
        .filter((record) => record.type === RecordType.annotation)
        .sort(compareGuideRecordTime);
    for (const annotation of annotations) {
        const type = field(annotation, "type", "general-note");
        const heading = annotationHeading(type);
        const section = getOrAddGuideSection(draft, heading);
        const title = field(annotation, "title");
        const priority = field(annotation, "priority", "normal");
        const content = field(annotation, "content");
        section.blocks.push({
            kind: "list-item",
            text: `[${priority} priority] ${title ? `**${title}**\n` : ""}${content}`,
            sourceIds: annotation.id,
            stale: false,
            origin:
                field(annotation, "origin") === "tutor-authored"
                    ? "tutor-authored"
                    : "session-evidence",
        });
    }

    const transcripts = sessionRecords
        .filter((record) => record.type === RecordType.transcriptSegment)
        .sort(compareGuideRecordTime);
    if (transcripts.length) {
        const transcriptSection = getOrAddGuideSection(
            draft,
            "Transcript excerpts — verbatim, review required",
        );
        for (const segment of transcripts) {
            transcriptSection.blocks.push({
                kind: "quote",
                text: `[${transcriptTimeRange(segment)}] ${field(segment, "text")}`,
                sourceIds: segment.id,
                stale: false,
                origin: "session-evidence",
            });
        }
    }

    const currentTranscriptIds = new Set(
        transcripts.map((record) => record.id.toLocaleLowerCase()),
    );
    const verifiedEvidence = sessionRecords
        .filter(
            (record) =>
                record.type === RecordType.evidenceNode &&
                field(record, "origin") === "transcript-derived-candidate" &&
                field(record, "verification_state") === "human-verified" &&
                evidenceSourcesAreCurrentFromRecords(record, activeRecords, sessionId),
        )
        .sort(compareGuideRecordTime);
    const evidenceSections = new Map<string, GuideSectionDraft>();
    for (const node of verifiedEvidence) {
        const sectionDefinition = transcriptEvidenceSection(field(node, "type"));
        const heading = sectionDefinition?.heading ?? "Verified transcript evidence";
        let section = evidenceSections.get(heading);
        if (!section) {
            section = { id: newUuid(), heading, blocks: [] };
            evidenceSections.set(heading, section);
            draft.sections.push(section);
        }
        const segmentIds = splitGuideSourceIds(field(node, "source_segment_ids"));
        const currentSegmentIds = segmentIds.filter((id) =>
            currentTranscriptIds.has(id.toLocaleLowerCase()),
        );
        if (currentSegmentIds.length !== segmentIds.length) continue;
        const sourceIds = [node.id, ...segmentIds].join(",");
        const speaker = field(node, "source_speaker_label");
        const attribution = `[${guideTimestamp(field(node, "start_time_us"))}]${speaker ? ` [${speaker}]` : ""}`;
        section.blocks.push({
            kind: "list-item",
            text: `${attribution} ${field(node, "content")}`,
            sourceIds,
            stale: false,
            origin: "session-evidence",
        });
    }

    if (student) addStudentProgress(draft, student, activeRecords);

    for (const notes of sessionRecords
        .filter(
            (record) =>
                record.type === RecordType.settings &&
                field(record, "record_role") === "journal-notes",
        )
        .sort((left, right) => {
            const leftSession = field(left, "session_id").toLowerCase() === sessionId ? 0 : 1;
            const rightSession = field(right, "session_id").toLowerCase() === sessionId ? 0 : 1;
            return leftSession - rightSession || left.id.localeCompare(right.id);
        })) {
        const notesSessionId = field(notes, "session_id").toLocaleLowerCase();
        const notesEntryId = field(notes, "entry_id").toLocaleLowerCase();
        if (
            !isGuideNotesSource(notes, session, activeRecords) ||
            (notesSessionId !== sessionId && !includeEntryEvidence)
        ) {
            continue;
        }
        const decoded = notesEditState(notes, {
            entryId: notesEntryId,
            sessionId: notesSessionId,
        });
        if (!decoded.editable) continue;
        const noteSession = activeRecords.find(
            (record) =>
                record.type === RecordType.session &&
                record.id.toLocaleLowerCase() === notesSessionId,
        );
        const heading = noteSession
            ? noteSession.id.toLocaleLowerCase() === sessionId
                ? "Session notes"
                : `Session notes · ${field(noteSession, "title", "Related session")}`
            : "Journal reflection";
        const blocks = decoded.blocks
            .filter((block) => block.text.length > 0)
            .map((block) => ({
                kind: "paragraph" as const,
                text: block.text,
                sourceIds: notes.id,
                stale: false,
                origin: "session-evidence" as const,
            }));
        if (blocks.length) draft.sections.push({ id: newUuid(), heading, blocks });
    }

    draft.sections = draft.sections.filter((section) => section.blocks.length > 0);
    if (draft.sections.length === 1) {
        draft.sections.push({
            id: newUuid(),
            heading: "Evidence status",
            blocks: [
                {
                    kind: "paragraph",
                    text: "No tutor-authored observations or transcript segments are linked to this session yet. This draft contains only the session details above; it does not infer lesson outcomes.",
                    sourceIds: session.id,
                    stale: false,
                    origin: "system-generated",
                },
            ],
        });
    }

    orderGeneratedGuideSections(draft, template.sections);
    return draft;
}

/** Build an entry-level guide from every live linked session and the entry's own notes. */
export function generateGuideDraftFromEntry(
    entry: ArchiveRecord,
    templateId: string,
    records: readonly ArchiveRecord[],
    students: readonly ArchiveRecord[],
    templates: readonly GuideTemplate[] = GUIDE_TEMPLATES,
): GuideDraft {
    if (
        entry.type !== RecordType.settings ||
        field(entry, "record_role") !== "journal-entry" ||
        field(entry, "_deleted") === "true"
    ) {
        throw new Error("Choose an active journal entry before generating a study guide.");
    }

    const entryId = entry.id.toLowerCase();
    const sessions = records
        .filter(
            (record) =>
                record.type === RecordType.session &&
                field(record, "_deleted") !== "true" &&
                field(record, "entry_id").toLowerCase() === entryId,
        )
        .sort((left, right) => {
            const leftStart = parseGuideInteger(field(left, "started_at_us"));
            const rightStart = parseGuideInteger(field(right, "started_at_us"));
            return leftStart < rightStart
                ? -1
                : leftStart > rightStart
                  ? 1
                  : left.id.localeCompare(right.id);
        });
    const requestedTemplate = templateId.trim() || "auto";
    const generatedSessions: GuideDraft[] = [];
    for (const session of sessions) {
        generatedSessions.push(
            generateGuideDraftFromSession(
                session,
                generatedSessions[0]?.templateId ?? requestedTemplate,
                records,
                students,
                templates,
            ),
        );
    }
    const selectedTemplateId =
        generatedSessions[0]?.templateId ??
        (() => {
            const automatic =
                requestedTemplate.toLocaleLowerCase() === "auto" || !requestedTemplate;
            const inferred = inferGuideTemplateId(field(entry, "subject"));
            const desired = (automatic ? inferred : requestedTemplate).toLocaleLowerCase();
            const found = resolveGuideTemplates(records, templates).find(
                (candidate) =>
                    candidate.id.toLocaleLowerCase() === desired ||
                    candidate.name.toLocaleLowerCase() === desired,
            );
            if (!found) throw new Error("Choose a study guide template available in this archive.");
            return found.id;
        })();

    const sections: GuideSectionDraft[] = [];
    sessions.forEach((session, index) => {
        const generated = generatedSessions[index]!;
        const sessionTitle = field(session, "title", "Tutoring session");
        for (const section of generated.sections) {
            if (!section.blocks.length) continue;
            sections.push({
                ...section,
                id: `${session.id}-${section.id}`,
                heading: truncateGuideHeading(
                    section.heading === "Session overview"
                        ? `${sessionTitle} — Session overview`
                        : `${sessionTitle} — ${section.heading}`,
                ),
            });
        }
    });

    const entryNotesId = field(entry, "notes_document_id").toLowerCase();
    const entryNotes = records.find(
        (record) =>
            record.type === RecordType.settings &&
            record.id.toLowerCase() === entryNotesId &&
            field(record, "record_role") === "journal-notes" &&
            field(record, "_deleted") !== "true" &&
            field(record, "entry_id").toLowerCase() === entryId &&
            !field(record, "session_id"),
    );
    if (entryNotes) {
        const decoded = notesEditState(entryNotes, { entryId, sessionId: "" });
        const blocks = decoded.blocks
            .filter((block) => block.text.length > 0)
            .map((block) => ({
                kind: "paragraph" as const,
                text: block.text,
                sourceIds: entryNotes.id,
                stale: false,
                origin: "session-evidence" as const,
            }));
        if (decoded.editable && blocks.length) {
            sections.push({ id: newUuid(), heading: "Entry notes", blocks });
        }
    }

    if (!sections.length) {
        sections.push({
            id: newUuid(),
            heading: "Entry overview",
            blocks: [
                {
                    kind: "paragraph",
                    text: "No session or notes material is linked to this entry yet.",
                    sourceIds: "",
                    stale: false,
                    origin: "system-generated",
                },
            ],
        });
    }

    return {
        title: `${field(entry, "title", "Journal entry")} — Study Guide`,
        sessionId: "",
        entryId: entry.id,
        templateId: selectedTemplateId,
        sections,
    };
}

/** Approved guides stay untouched when regenerated; the result is saved as a new draft record. */
export function guideRegenerationTarget(record: ArchiveRecord | null): ArchiveRecord | null {
    if (!record) return null;
    if (record.type !== RecordType.guide) throw new Error("Only a study guide can be regenerated.");
    return field(record, "approval_state") === "approved" ? null : record;
}

/** Replace one section's blocks with freshly generated evidence, preserving every other section. */
export function replaceGuideSectionFromGenerated(
    draft: GuideDraft,
    sectionIndex: number,
    generated: GuideDraft,
): GuideDraft {
    const selected = draft.sections[sectionIndex];
    if (!selected) throw new Error("Choose a guide section to regenerate.");
    const heading = selected.heading.trim().toLocaleLowerCase();
    const matching = generated.sections.find(
        (section) => section.heading.trim().toLocaleLowerCase() === heading,
    );
    if (!matching) throw new Error("No current evidence maps to the selected guide section.");
    return {
        ...draft,
        sections: draft.sections.map((section, index) =>
            index === sectionIndex
                ? { ...section, blocks: matching.blocks.map((block) => ({ ...block })) }
                : section,
        ),
    };
}

/** Insert one archive image as a cited image block in the selected section. */
export function insertGuideImageBlock(
    draft: GuideDraft,
    sectionIndex: number,
    asset: ArchiveRecord,
): GuideDraft {
    const section = draft.sections[sectionIndex];
    if (!section) throw new Error("Choose a guide section for this image.");
    if (asset.type !== RecordType.assetMetadata || field(asset, "_deleted") === "true") {
        throw new Error("Choose an image from this archive.");
    }
    if (!/^image\//u.test(field(asset, "mime_type"))) {
        throw new Error("Choose an image asset for this guide block.");
    }
    const alternativeText = field(asset, "title", "Guide image").replace(/[\\\]]/gu, "\\$&");
    return {
        ...draft,
        sections: draft.sections.map((current, index) =>
            index === sectionIndex
                ? {
                      ...current,
                      blocks: [
                          ...current.blocks,
                          {
                              kind: "image",
                              text: `![${alternativeText}](asset:${asset.id})`,
                              sourceIds: asset.id,
                              stale: false,
                              origin: "tutor-authored",
                          },
                      ],
                  }
                : current,
        ),
    };
}

/** Refuse structurally invalid or out-of-scope guides before any export format is written. */
export function validateGuideForExport(record: ArchiveRecord, scope?: GuideSourceScope): void {
    if (record.type !== RecordType.guide) throw new Error("Only a study guide can be exported.");
    const draft = guideDraftFromRecord(record);
    const title = cleanText(draft.title, "Guide title", 240).trim();
    if (!title) throw new Error("Cannot export a guide without a title.");
    if (!draft.sections.length) throw new Error("A guide must contain at least one section.");
    draft.sections.forEach((section, sectionIndex) => {
        const heading = cleanText(
            section.heading,
            `Section ${sectionIndex + 1} heading`,
            256,
        ).trim();
        if (!heading) throw new Error("Every guide section needs a heading.");
        section.blocks.forEach((block, blockIndex) => {
            const kind = block.kind.trim();
            if (!(GUIDE_BLOCK_KINDS as readonly string[]).includes(kind)) {
                throw new Error(`Guide block kind “${block.kind}” is not supported for export.`);
            }
            cleanText(block.text, `Block ${blockIndex + 1} text`, 16 * 1024 * 1024, true);
            const origin = block.origin || "unknown";
            if (!(GUIDE_BLOCK_ORIGINS as readonly string[]).includes(origin)) {
                throw new Error(
                    `Guide block provenance “${block.origin}” is not supported for export.`,
                );
            }
            const sourceIds = parseSourceIds(block.sourceIds, block.text, kind as GuideBlockKind);
            if (!scope) return;
            const image =
                kind === "image" || kind === "figure" || block.text.startsWith("![")
                    ? parseGuideImageReference(block.text)
                    : null;
            if (image) {
                const asset = scope.records.find(
                    (record) =>
                        record.id.toLowerCase() === image.assetId &&
                        record.type === RecordType.assetMetadata &&
                        field(record, "_deleted") !== "true" &&
                        /^image\/(?:png|jpeg|jpg|gif|webp)$/u.test(field(record, "mime_type")),
                );
                if (!asset) {
                    throw new Error(
                        `Guide image ${image.assetId} is missing or not a supported image.`,
                    );
                }
            }
            for (const sourceId of sourceIds) {
                if (!isGuideSourceInScope(sourceId, scope)) {
                    throw new Error(
                        `Source ${sourceId} is missing or does not belong to this guide.`,
                    );
                }
            }
        });
    });
}

function addTutorProfileContext(draft: GuideDraft, student: ArchiveRecord): void {
    const knownDifficulties = field(student, "known_difficulties");
    const demonstratedImprovements = field(student, "demonstrated_improvements");
    if (!knownDifficulties && !demonstratedImprovements) return;
    let text = "Previously recorded tutor profile context (not a new finding from this session):";
    if (knownDifficulties) text += `\nKnown difficulties: ${knownDifficulties}`;
    if (demonstratedImprovements) {
        text += `\nPreviously recorded improvements (verify against linked evidence before treating them as established):\n${demonstratedImprovements}`;
    }
    draft.sections.push({
        id: newUuid(),
        heading: "Tutor profile context",
        blocks: [
            {
                kind: "paragraph",
                text,
                sourceIds: student.id,
                stale: false,
                origin: "tutor-authored",
            },
        ],
    });
}

function addStudentProgress(
    draft: GuideDraft,
    student: ArchiveRecord,
    records: readonly ArchiveRecord[],
): void {
    const progress = decodeStudentProgress(field(student, "progress_classifications"));
    if (!progress.length) return;
    const sessions = records.filter((record) => record.type === RecordType.session);
    const evidence = records.filter((record) => record.type === RecordType.evidenceNode);
    const section: GuideSectionDraft = {
        id: newUuid(),
        heading: "Progress since previous lessons",
        blocks: [],
    };
    for (const item of progress) {
        let verifiedSources: ArchiveRecord[] | undefined;
        try {
            verifiedSources = validateProgressEvidence(
                student.id,
                item.evidenceSourceIds,
                sessions,
                evidence,
                item.classification,
            );
        } catch {
            verifiedSources = undefined;
        }
        const unverified = item.classification === "unverified-improvement" || !verifiedSources;
        const evidenceSessionCount = new Set(
            verifiedSources?.map((record) => field(record, "session_id")) ?? [],
        ).size;
        let text = `${item.skill}: ${unverified ? "UNVERIFIED CLAIM — " : ""}${classificationLabel(item.classification)}`;
        text += verifiedSources
            ? ` (human-reviewed; ${verifiedSources.length} evidence record(s) across ${evidenceSessionCount} session(s))`
            : " (source evidence is missing or invalid; do not treat improvement as established)";
        if (item.note) text += `\nTutor note: ${item.note}`;
        if (item.evidenceSourceIds.length) {
            text += `\nEvidence record IDs: ${item.evidenceSourceIds.join(", ")}`;
        }
        section.blocks.push({
            kind: "list-item",
            text,
            sourceIds: student.id,
            stale: false,
            origin: unverified ? "uncertain" : "tutor-authored",
        });
    }
    if (section.blocks.length) draft.sections.push(section);
}

function getOrAddGuideSection(draft: GuideDraft, heading: string): GuideSectionDraft {
    const existing = draft.sections.find(
        (section) => section.heading.toLocaleLowerCase() === heading.toLocaleLowerCase(),
    );
    if (existing) return existing;
    const section = { id: newUuid(), heading, blocks: [] };
    draft.sections.push(section);
    return section;
}

function annotationHeading(type: string): string {
    const headings: Record<string, string> = {
        "important-concept": "Key concepts",
        "student-mistake": "Student misconceptions",
        "tutor-correction": "Errors and corrections",
        "explicit-instruction": "Tutor instructions",
        "worked-example": "Worked examples",
        "follow-up-priority": "Next-session priorities",
        "student-question": "Student questions",
        "learning-outcome": "Learning outcomes",
        "general-note": "Tutor notes",
        custom: "Additional tutor notes",
    };
    return headings[type] ?? "Tutor notes";
}

function transcriptEvidenceSection(type: string): { heading: string } | undefined {
    const sections: Record<string, string> = {
        "explicit-instruction-candidate": "Tutor-verified spoken instructions",
        "important-concept-candidate": "Verified spoken concepts",
        "explanation-candidate": "Verified spoken explanations",
        "tutor-correction-candidate": "Verified spoken corrections",
        "student-mistake-candidate": "Verified learner misconceptions",
        "worked-example-candidate": "Verified spoken examples",
        "learning-outcome-candidate": "Verified learning outcomes",
        "follow-up-priority-candidate": "Verified follow-up priorities",
        "student-question-candidate": "Verified questions",
    };
    const heading = sections[type];
    return heading ? { heading } : undefined;
}

function evidenceSourcesAreCurrentFromRecords(
    evidence: ArchiveRecord,
    records: readonly ArchiveRecord[],
    sessionId: string,
): boolean {
    const byId = new Map(records.map((record) => [record.id.toLocaleLowerCase(), record]));
    const validate = (
        type: number,
        ids: readonly string[],
        revisions: ReadonlyMap<string, bigint>,
    ): boolean => {
        for (const rawId of ids) {
            const id = rawId.toLocaleLowerCase();
            if (!isArchiveUuid(id)) return false;
            const source = byId.get(id);
            if (
                !source ||
                source.type !== type ||
                field(source, "_deleted") === "true" ||
                (field(source, "session_id") &&
                    field(source, "session_id").toLocaleLowerCase() !== sessionId)
            ) {
                return false;
            }
            const expectedRevision = revisions.get(id);
            if (expectedRevision !== undefined && source.revision !== expectedRevision)
                return false;
        }
        return true;
    };

    const annotationId = field(evidence, "source_annotation_id");
    if (annotationId) {
        const revision = parseGuideRevision(field(evidence, "source_annotation_revision"));
        if (revision === null) return false;
        if (
            !validate(
                RecordType.annotation,
                [annotationId],
                revision === undefined
                    ? new Map()
                    : new Map([[annotationId.toLocaleLowerCase(), revision]]),
            )
        ) {
            return false;
        }
    }

    const segmentIds = splitGuideSourceIds(field(evidence, "source_segment_ids"));
    const segmentRevisions = parseGuideRevisionMap(field(evidence, "source_segment_revisions"));
    if (segmentRevisions === null) return false;
    if (!validate(RecordType.transcriptSegment, segmentIds, segmentRevisions)) return false;
    const assetIds = splitGuideSourceIds(field(evidence, "source_asset_ids"));
    if (!validate(RecordType.assetMetadata, assetIds, new Map())) return false;
    return Boolean(annotationId || segmentIds.length || assetIds.length);
}

function parseGuideRevision(value: string): bigint | undefined | null {
    if (!value) return undefined;
    if (!/^\d+$/u.test(value)) return null;
    try {
        const revision = BigInt(value);
        return revision >= 0n ? revision : null;
    } catch {
        return null;
    }
}

function parseGuideRevisionMap(value: string): Map<string, bigint> | null {
    const result = new Map<string, bigint>();
    for (const item of splitGuideSourceIds(value)) {
        const separator = item.indexOf("=");
        if (separator < 1 || separator === item.length - 1) return null;
        const id = item.slice(0, separator).toLocaleLowerCase();
        const revision = parseGuideRevision(item.slice(separator + 1));
        if (!isArchiveUuid(id) || revision === undefined || revision === null) return null;
        result.set(id, revision);
    }
    return result;
}

function isArchiveUuid(value: string): boolean {
    return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);
}

function splitGuideSourceIds(value: string): string[] {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function compareGuideRecordTime(left: ArchiveRecord, right: ArchiveRecord): number {
    const leftTime = parseGuideInteger(field(left, "start_time_us"));
    const rightTime = parseGuideInteger(field(right, "start_time_us"));
    return leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0;
}

function parseGuideInteger(value: string): bigint {
    if (!/^-?\d+$/u.test(value)) return 0n;
    try {
        return BigInt(value);
    } catch {
        return 0n;
    }
}

function truncateGuideHeading(value: string): string {
    let result = "";
    let bytes = 0;
    for (const character of value) {
        const size = new TextEncoder().encode(character).byteLength;
        if (bytes + size > 256) break;
        result += character;
        bytes += size;
    }
    return result.trimEnd();
}

function guideTimestamp(value: string): string {
    return formatTranscriptTimestampUs(parseGuideInteger(value));
}

function transcriptTimeRange(segment: ArchiveRecord): string {
    if (field(segment, "timestamp_state") === "not-timestamped") return "time not provided";
    const start = parseGuideInteger(field(segment, "start_time_us"));
    const end = parseGuideInteger(field(segment, "end_time_us"));
    return end > start
        ? `${formatTranscriptTimestampUs(start)}–${formatTranscriptTimestampUs(end)}`
        : formatTranscriptTimestampUs(start);
}

function orderGeneratedGuideSections(
    draft: GuideDraft,
    preferredSections: readonly string[],
): void {
    const rank = (section: GuideSectionDraft): number => {
        const heading = section.heading.toLocaleLowerCase();
        const index = preferredSections.findIndex((preferred) => {
            const candidate = preferred.toLocaleLowerCase();
            return (
                heading === candidate || heading.includes(candidate) || candidate.includes(heading)
            );
        });
        return index < 0 ? preferredSections.length : index;
    };
    draft.sections = draft.sections
        .map((section, index) => ({ section, index }))
        .sort((left, right) => rank(left.section) - rank(right.section) || left.index - right.index)
        .map(({ section }) => section);
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
                kind: field(record, `${blockPrefix}kind`),
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
        entryId: field(record, "entry_id"),
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
    const session = scope.session;
    const entry = scope.entry;
    if (session) {
        if (session.type !== RecordType.session || field(session, "_deleted") === "true")
            throw new Error("Choose an active session for this study guide.");
        if (draft.sessionId !== session.id)
            throw new Error("The selected session changed. Reopen the guide editor.");
        if (
            draft.entryId &&
            draft.entryId.toLowerCase() !== field(session, "entry_id").toLowerCase()
        )
            throw new Error("The selected journal entry changed. Reopen the guide editor.");
        if (entry && entry.id.toLowerCase() !== field(session, "entry_id").toLowerCase())
            throw new Error("The selected session does not belong to this journal entry.");
    } else if (
        !entry ||
        entry.type !== RecordType.settings ||
        field(entry, "record_role") !== "journal-entry" ||
        field(entry, "_deleted") === "true"
    ) {
        throw new Error("Choose an active journal entry or session for this study guide.");
    } else if (
        draft.sessionId ||
        (draft.entryId && draft.entryId.toLowerCase() !== entry.id.toLowerCase())
    ) {
        throw new Error("The selected journal entry changed. Reopen the guide editor.");
    }

    const title = cleanText(draft.title, "Guide title", 240).trim();
    if (!title) throw new Error("Guide title is required.");
    const templateId = cleanText(draft.templateId, "Template ID", 128).trim() || "general";
    if (draft.sections.length === 0) throw new Error("Add at least one section to the guide.");
    if (draft.sections.length > 250) throw new Error("A guide can contain at most 250 sections.");

    const currentSectionIndexById = new Map<string, number>();
    if (current) {
        for (let index = 0; current.fields.has(`section.${index}.id`); index += 1) {
            currentSectionIndexById.set(field(current, `section.${index}.id`), index);
        }
    }
    const sections = draft.sections.map((section, sectionIndex) => {
        const heading = cleanText(
            section.heading,
            `Section ${sectionIndex + 1} heading`,
            256,
        ).trim();
        if (!heading) throw new Error("Every guide section needs a heading.");
        if (section.blocks.length > 1_000)
            throw new Error("A section can contain at most 1,000 blocks.");
        const previousSectionIndex = currentSectionIndexById.get(section.id) ?? sectionIndex;
        const blocks = section.blocks.map((block, blockIndex) => {
            const kind = validKind(block.kind, "Guide block kind");
            const blockPrefix = `section.${previousSectionIndex}.block.${blockIndex}.`;
            const previousKind = current?.fields.get(`${blockPrefix}kind`);
            const previousUnknown =
                previousKind !== undefined &&
                !(GUIDE_BLOCK_KINDS as readonly string[]).includes(previousKind);
            if (
                current &&
                ((!(GUIDE_BLOCK_KINDS as readonly string[]).includes(kind) &&
                    previousKind !== kind) ||
                    (previousUnknown &&
                        (kind !== previousKind ||
                            block.text !== (current.fields.get(`${blockPrefix}text`) ?? "") ||
                            block.sourceIds !==
                                (current.fields.get(`${blockPrefix}source_ids`) ?? "") ||
                            block.stale !==
                                (current.fields.get(`${blockPrefix}stale`) === "true") ||
                            validOrigin(block.origin) !==
                                validOrigin(
                                    current.fields.get(`${blockPrefix}origin`) ?? "unknown",
                                ))))
            ) {
                throw new Error(`Guide block kind “${kind}” is not supported.`);
            }
            const text = cleanText(
                block.text,
                `Block ${blockIndex + 1} text`,
                16 * 1024 * 1024,
                true,
            );
            const origin = validOrigin(block.origin);
            const sourceIds = parseSourceIds(block.sourceIds, text, kind);
            for (const sourceId of sourceIds) {
                if (!isGuideSourceInScope(sourceId, scope)) {
                    throw new Error(
                        `Source ${sourceId} is missing or does not belong to this guide.`,
                    );
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
    const sessionId = session?.id.toLowerCase() ?? "";
    const entryId = session ? field(session, "entry_id") : entry!.id;
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

/** Keep the journal entry's guide list in the same transaction as the guide revision. */
export function guideRecordsWithEntryLinks(
    guide: ArchiveRecord,
    previous: ArchiveRecord | null,
    records: readonly ArchiveRecord[],
): ArchiveRecord[] {
    if (guide.type !== RecordType.guide) throw new Error("Only study guides can be linked here.");
    const oldEntryId = previous ? field(previous, "entry_id").toLowerCase() : "";
    const newEntryId = field(guide, "entry_id").toLowerCase();
    const live = field(guide, "_deleted") !== "true";
    const changes = [guide];
    for (const entryId of new Set([oldEntryId, newEntryId].filter(Boolean))) {
        const shouldLink = live && entryId === newEntryId;
        const entry = records.find(
            (record) =>
                record.type === RecordType.settings &&
                record.id.toLowerCase() === entryId &&
                field(record, "record_role") === "journal-entry" &&
                field(record, "_deleted") !== "true",
        );
        if (!entry) {
            if (shouldLink)
                throw new Error("Restore the source journal entry before saving this guide.");
            continue;
        }
        const existing = field(entry, "study_guide_ids")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
        const contains = existing.some((id) => id.toLowerCase() === guide.id.toLowerCase());
        if (contains === shouldLink) continue;
        const next = shouldLink
            ? [...existing, guide.id.toLowerCase()]
            : existing.filter((id) => id.toLowerCase() !== guide.id.toLowerCase());
        const fields = new Map(entry.fields);
        fields.set("study_guide_ids", next.join(","));
        fields.set("updated_at_us", nowUs());
        changes.push({ ...entry, fields });
    }
    return changes;
}

export function approveGuideRecord(record: ArchiveRecord): ArchiveRecord {
    if (record.type !== RecordType.guide) throw new Error("Only a study guide can be approved.");
    if (field(record, "_deleted") === "true")
        throw new Error("A guide in Trash cannot be approved.");
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
                        block.kind === "image" ||
                        block.kind === "figure" ||
                        block.text.startsWith("![");
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
        ["english", "writing", "literature", "rhetoric", "essay"].some((term) =>
            value.includes(term),
        )
    )
        return "english";
    if (
        ["math", "algebra", "geometry", "calculus", "arithmetic"].some((term) =>
            value.includes(term),
        )
    )
        return "mathematics";
    if (
        ["programming", "coding", "software", "computer science"].some((term) =>
            value.includes(term),
        )
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

export function isGuideNotesSource(
    record: ArchiveRecord,
    session: ArchiveRecord,
    records: readonly ArchiveRecord[],
): boolean {
    if (
        record.type !== RecordType.settings ||
        field(record, "record_role") !== "journal-notes" ||
        field(record, "_deleted") === "true"
    ) {
        return false;
    }
    const noteId = record.id.toLowerCase();
    const sessionId = session.id.toLowerCase();
    const notesSessionId = field(record, "session_id").toLowerCase();
    const entryId = field(session, "entry_id").toLowerCase();
    const notesEntryId = field(record, "entry_id").toLowerCase();

    if (notesSessionId === sessionId) return true;
    if (!entryId || notesEntryId !== entryId) return false;

    if (!notesSessionId) {
        return records.some(
            (candidate) =>
                candidate.type === RecordType.settings &&
                candidate.id.toLowerCase() === entryId &&
                field(candidate, "record_role") === "journal-entry" &&
                field(candidate, "_deleted") !== "true" &&
                field(candidate, "notes_document_id").toLowerCase() === noteId,
        );
    }

    return records.some(
        (candidate) =>
            candidate.type === RecordType.session &&
            candidate.id.toLowerCase() === notesSessionId &&
            field(candidate, "_deleted") !== "true" &&
            field(candidate, "entry_id").toLowerCase() === entryId &&
            field(candidate, "notes_document_id").toLowerCase() === noteId,
    );
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

export function isGuideSourceInScope(sourceId: string, scope: GuideSourceScope): boolean {
    const entryId = scope.entry?.id.toLowerCase() ?? "";
    const sessions = scope.session
        ? [scope.session]
        : scope.records.filter(
              (candidate) =>
                  candidate.type === RecordType.session &&
                  field(candidate, "_deleted") !== "true" &&
                  field(candidate, "entry_id").toLowerCase() === entryId,
          );
    const sessionIds = new Set(sessions.map((candidate) => candidate.id.toLowerCase()));
    const studentIds = new Set(
        sessions
            .map((candidate) => field(candidate, "student_id").toLowerCase())
            .filter((id) => id && id !== "anonymous"),
    );
    if (sessionIds.has(sourceId)) return true;
    const record = scope.records.find((item) => item.id.toLowerCase() === sourceId);
    if (!record || field(record, "_deleted") === "true") return false;
    if (record.type === RecordType.session) return sessionIds.has(record.id.toLowerCase());
    if (record.type === RecordType.student) return studentIds.has(record.id.toLowerCase());
    if (record.type === RecordType.settings) {
        if (field(record, "record_role") !== "journal-notes") return false;
        if (scope.session) return isGuideNotesSource(record, scope.session, scope.records);
        return Boolean(
            scope.entry && isGuideNotesSourceForEntry(record, scope.entry, scope.records),
        );
    }
    if (record.type === RecordType.assetMetadata) {
        return (
            sessionIds.has(field(record, "session_id").toLowerCase()) ||
            studentIds.has(field(record, "student_id").toLowerCase())
        );
    }
    const sessionSourceTypes: readonly number[] = [
        RecordType.transcriptSegment,
        RecordType.annotation,
        RecordType.evidenceNode,
    ];
    return (
        sessionSourceTypes.includes(record.type) &&
        sessionIds.has(field(record, "session_id").toLowerCase())
    );
}

function isGuideNotesSourceForEntry(
    record: ArchiveRecord,
    entry: ArchiveRecord,
    records: readonly ArchiveRecord[],
): boolean {
    if (
        record.type !== RecordType.settings ||
        field(record, "record_role") !== "journal-notes" ||
        field(record, "_deleted") === "true" ||
        field(entry, "record_role") !== "journal-entry" ||
        field(entry, "_deleted") === "true"
    ) {
        return false;
    }
    const entryId = entry.id.toLowerCase();
    const noteId = record.id.toLowerCase();
    const sessionId = field(record, "session_id").toLowerCase();
    if (sessionId) {
        return records.some(
            (candidate) =>
                candidate.type === RecordType.session &&
                candidate.id.toLowerCase() === sessionId &&
                field(candidate, "_deleted") !== "true" &&
                field(candidate, "entry_id").toLowerCase() === entryId,
        );
    }
    if (field(record, "entry_id").toLowerCase() !== entryId) return false;
    return field(entry, "notes_document_id").toLowerCase() === noteId;
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

function validKind(value: string, label: string): GuideBlockKind {
    if (!value.trim()) throw new Error(`${label} is required.`);
    return value;
}

function validOrigin(value: string): GuideBlockOrigin {
    return value || "unknown";
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
