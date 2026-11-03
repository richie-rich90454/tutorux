import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    applyGuideTemplateOverride,
    approveGuideRecord,
    builtInGuideTemplates,
    createGuideDraft,
    createGuideDraftFromSections,
    customGuideTemplates,
    duplicateGuideDraft,
    findGuideTextMatches,
    generateGuideDraftFromEntry,
    generateGuideDraftFromSession,
    getGuideTemplate,
    guideBlockLabel,
    guideDraftFromRecord,
    guideRecordsWithEntryLinks,
    guideRegenerationTarget,
    inferGuideTemplateId,
    insertGuideImageBlock,
    isGuideNotesSource,
    isGuideSourceInScope,
    makeGuideRecord,
    moveGuideSection,
    parseGuideImageReference,
    renderGuideHtml,
    renderGuideMarkdown,
    replaceAllGuideText,
    replaceGuideSectionFromGenerated,
    replaceGuideTextMatch,
    resolveGuideTemplates,
    validateGuideForExport,
    type GuideBlockDraft,
    type GuideDraft,
    type GuideSectionDraft,
} from "../../../frontend/domain/guides";
import { encodeStudentProgress } from "../../../frontend/domain/student-progress";

type Fields = Record<string, string>;
type FixtureRecord = ArchiveRecord & { fields: Map<string, string> };

function makeRecord(
    type: number,
    fields: Fields = {},
    id: string = crypto.randomUUID(),
): FixtureRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

function section(
    heading: string,
    blocks: GuideBlockDraft[] = [],
    id: string = crypto.randomUUID(),
) {
    return { id, heading, blocks };
}

function block(text: string, overrides: Partial<GuideBlockDraft> = {}): GuideBlockDraft {
    return {
        kind: "paragraph",
        text,
        sourceIds: "",
        stale: false,
        origin: "tutor-authored",
        ...overrides,
    };
}

function draft(sections: GuideSectionDraft[], overrides: Partial<GuideDraft> = {}): GuideDraft {
    return {
        title: "Fractions guide",
        sessionId: "",
        templateId: "general",
        sections,
        ...overrides,
    };
}

function guideRecord(
    sections: Array<{ id?: string; heading: string; blocks?: Array<Partial<GuideBlockDraft>> }>,
    extra: Fields = {},
    id: string = crypto.randomUUID(),
): FixtureRecord {
    const fields = new Map<string, string>([
        ["title", "Fractions guide"],
        ["template_id", "general"],
        ["approval_state", "draft"],
        ["section_count", String(sections.length)],
    ]);
    sections.forEach((item, sectionIndex) => {
        const prefix = `section.${sectionIndex}.`;
        if (item.id) fields.set(`${prefix}id`, item.id);
        fields.set(`${prefix}heading`, item.heading);
        const blocks = item.blocks ?? [];
        fields.set(`${prefix}block_count`, String(blocks.length));
        blocks.forEach((itemBlock, blockIndex) => {
            const blockPrefix = `${prefix}block.${blockIndex}.`;
            fields.set(`${blockPrefix}kind`, itemBlock.kind ?? "paragraph");
            fields.set(`${blockPrefix}text`, itemBlock.text ?? "");
            fields.set(`${blockPrefix}source_ids`, itemBlock.sourceIds ?? "");
            fields.set(`${blockPrefix}stale`, itemBlock.stale ? "true" : "false");
            fields.set(`${blockPrefix}origin`, itemBlock.origin ?? "tutor-authored");
        });
    });
    for (const [key, value] of Object.entries(extra)) fields.set(key, value);
    return {
        type: RecordType.guide,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields,
        blob: new Uint8Array(),
    };
}

function sessionRecord(fields: Fields = {}, id: string = crypto.randomUUID()): ArchiveRecord {
    return makeRecord(
        RecordType.session,
        {
            title: "Fractions",
            subject: "Math",
            entry_id: crypto.randomUUID(),
            student_id: "anonymous",
            ...fields,
        },
        id,
    );
}

function notesRecord(
    owner: { entryId: string; sessionId: string },
    blocks: Array<{ id: string; kind: string; text: string }>,
    extra: Fields = {},
    id = crypto.randomUUID(),
): ArchiveRecord {
    const fields: Fields = {
        record_role: "journal-notes",
        entry_id: owner.entryId,
        session_id: owner.sessionId,
        block_count: String(blocks.length),
        ...extra,
    };
    blocks.forEach((item, index) => {
        fields[`block.${index}.id`] = item.id;
        fields[`block.${index}.kind`] = item.kind;
        fields[`block.${index}.text`] = item.text;
    });
    return makeRecord(RecordType.settings, fields, id);
}

describe("guide section ordering", () => {
    it("swaps neighboring sections and ignores invalid indices", () => {
        const sections = [section("one"), section("two"), section("three")];
        expect(moveGuideSection(sections, 0, 1).map((item) => item.heading)).toEqual([
            "two",
            "one",
            "three",
        ]);
        expect(moveGuideSection(sections, 2, -1).map((item) => item.heading)).toEqual([
            "one",
            "three",
            "two",
        ]);
        for (const [index, direction] of [
            [1.5, 1],
            [-1, 1],
            [3, 1],
            [0, -1],
            [2, 1],
        ] as const) {
            const unchanged = moveGuideSection(sections, index, direction);
            expect(unchanged).toEqual(sections);
            expect(unchanged).not.toBe(sections);
        }
    });
});

describe("guide text search and replacement", () => {
    it("finds every non-overlapping match in the whole draft or one block", () => {
        const target = draft([
            section("one", [block("cat cat"), block("dog")]),
            section("two", [block("cat")]),
        ]);
        expect(findGuideTextMatches(target, "")).toEqual([]);
        expect(findGuideTextMatches(target, "cat")).toEqual([
            { sectionIndex: 0, blockIndex: 0, start: 0, end: 3 },
            { sectionIndex: 0, blockIndex: 0, start: 4, end: 7 },
            { sectionIndex: 1, blockIndex: 0, start: 0, end: 3 },
        ]);
        expect(
            findGuideTextMatches(target, "cat", { sectionIndex: 0, blockIndex: 0 }),
        ).toHaveLength(2);
        expect(findGuideTextMatches(target, "cat", { sectionIndex: 1, blockIndex: 0 })).toEqual([
            { sectionIndex: 1, blockIndex: 0, start: 0, end: 3 },
        ]);
        expect(findGuideTextMatches(target, "missing")).toEqual([]);
    });

    it("replaces one live match and refuses stale or invalid matches", () => {
        const target = draft([
            section("one", [block("cat"), block("dog")]),
            section("two", [block("cat"), block("cat")]),
        ]);
        const match = { sectionIndex: 1, blockIndex: 0, start: 0, end: 3 };
        const replaced = replaceGuideTextMatch(target, match, "cat", "lion");
        expect(replaced.sections[1]!.blocks[0]).toMatchObject({
            text: "lion",
            stale: false,
            origin: "human-edited",
        });
        expect(replaced.sections[1]!.blocks[1]).toBe(target.sections[1]!.blocks[1]);
        expect(replaced.sections[0]).toBe(target.sections[0]);

        const invalidMatches = [
            { sectionIndex: 9, blockIndex: 0, start: 0, end: 3 },
            { sectionIndex: 0, blockIndex: 0, start: 0.5, end: 3 },
            { sectionIndex: 0, blockIndex: 0, start: 0, end: 1.5 },
            { sectionIndex: 0, blockIndex: 0, start: -1, end: 2 },
            { sectionIndex: 0, blockIndex: 0, start: 0, end: 5 },
            { sectionIndex: 0, blockIndex: 1, start: 0, end: 3 },
        ];
        for (const invalid of invalidMatches) {
            expect(replaceGuideTextMatch(target, invalid, "cat", "lion")).toBe(target);
        }
        expect(replaceGuideTextMatch(target, match, "", "lion")).toBe(target);
        expect(replaceGuideTextMatch(target, match, "cat", "cat")).toBe(target);
    });

    it("replaces every match per block and honors the selected block", () => {
        const target = draft([
            section("one", [block("cat cat"), block("cat")]),
            section("two", [block("cat")]),
        ]);
        expect(replaceAllGuideText(target, "", "x").replacedCount).toBe(0);
        expect(replaceAllGuideText(target, "cat", "cat").replacedCount).toBe(0);
        expect(replaceAllGuideText(target, "zzz", "x").replacedCount).toBe(0);

        const all = replaceAllGuideText(target, "cat", "lion");
        expect(all.replacedCount).toBe(4);
        expect(all.draft.sections[0]!.blocks[0]!.text).toBe("lion lion");
        expect(all.draft.sections[0]!.blocks[1]!.text).toBe("lion");
        expect(all.draft.sections[1]!.blocks[0]!.text).toBe("lion");
        expect(all.draft.sections[0]!.blocks[0]!.origin).toBe("human-edited");

        const selected = replaceAllGuideText(target, "cat", "lion", {
            sectionIndex: 0,
            blockIndex: 1,
        });
        expect(selected.replacedCount).toBe(1);
        expect(selected.draft.sections[0]!.blocks[0]).toBe(target.sections[0]!.blocks[0]);
        expect(selected.draft.sections[1]).toEqual(target.sections[1]);
    });
});

describe("guide duplication", () => {
    it("copies the draft deeply and keeps the copy suffix inside the byte budget", () => {
        const source = draft([section("one", [block("text")])], { title: "Hello   " });
        const copied = duplicateGuideDraft(source);
        expect(copied.title).toBe("Hello (copy)");
        expect(copied.sections).not.toBe(source.sections);
        expect(copied.sections[0]).not.toBe(source.sections[0]);
        expect(copied.sections[0]!.blocks[0]).not.toBe(source.sections[0]!.blocks[0]);

        const long = duplicateGuideDraft({ ...source, title: "a".repeat(300) });
        expect(new TextEncoder().encode(long.title).byteLength).toBeLessThanOrEqual(240);
        expect(long.title.endsWith(" (copy)")).toBe(true);
        expect(long.title).toBe(`${"a".repeat(233)} (copy)`);

        const multibyte = duplicateGuideDraft({ ...source, title: "汉".repeat(120) });
        expect(new TextEncoder().encode(multibyte.title).byteLength).toBeLessThanOrEqual(240);
        expect(multibyte.title.endsWith(" (copy)")).toBe(true);
    });
});

describe("guide templates", () => {
    it("applies stored overrides and ignores unrelated or deleted settings", () => {
        const builtIn = builtInGuideTemplates([]);
        expect(builtIn.map((template) => template.id)).toContain("general");

        const override = makeRecord(RecordType.settings, {
            record_role: "guide-template",
            builtin_template_id: "general",
            name: "Local general",
            subject: "local",
            description: "Local description",
            sections: "\r\n Session overview \r Local section \n",
            body: "Local body",
        });
        const resolved = builtInGuideTemplates([override]).find(
            (template) => template.id === "general",
        )!;
        expect(resolved).toMatchObject({
            name: "Local general",
            subject: "local",
            description: "Local description",
            sections: ["Session overview", "Local section"],
            body: "Local body",
        });

        const blankOverride = makeRecord(RecordType.settings, {
            record_role: "guide-template",
            builtin_template_id: "english",
            name: "",
            subject: "",
            description: "",
            sections: "",
            body: "",
        });
        const blank = applyGuideTemplateOverride(getGuideTemplate("english"), [blankOverride]);
        expect(blank.name).toBe("English");
        expect(blank.subject).toBe("English");
        expect(blank.sections).toEqual(getGuideTemplate("english").sections);

        const deleted = { ...override, fields: new Map(override.fields) };
        deleted.fields.set("_deleted", "true");
        expect(applyGuideTemplateOverride(getGuideTemplate("general"), [deleted])).toEqual(
            getGuideTemplate("general"),
        );
        const wrongRole = makeRecord(RecordType.settings, {
            record_role: "other",
            builtin_template_id: "general",
        });
        expect(applyGuideTemplateOverride(getGuideTemplate("general"), [wrongRole])).toEqual(
            getGuideTemplate("general"),
        );
    });

    it("collects custom templates with fallbacks and de-duplicates ids", () => {
        const custom = makeRecord(RecordType.settings, {
            record_role: "guide-template",
            sections: "One\nTwo",
            body: "Body",
            description: "Description",
            name: "Custom",
            subject: "history",
        });
        const blank = makeRecord(RecordType.settings, { record_role: "guide-template" });
        const withBuiltIn = makeRecord(RecordType.settings, {
            record_role: "guide-template",
            builtin_template_id: "general",
        });
        const deleted = { ...custom, fields: new Map(custom.fields) };
        deleted.fields.set("_deleted", "true");
        const records = [custom, blank, withBuiltIn, deleted, makeRecord(RecordType.session)];

        expect(customGuideTemplates(records).map((template) => template.id)).toEqual([
            custom.id,
            blank.id,
        ]);
        expect(customGuideTemplates([blank])[0]).toMatchObject({
            name: "Untitled template",
            subject: "general",
            description: "",
            sections: [],
            body: "",
        });

        const defaultResolution = resolveGuideTemplates(records);
        expect(defaultResolution.map((template) => template.id)).toContain(custom.id);

        const duplicateId = makeRecord(
            RecordType.settings,
            { record_role: "guide-template" },
            "general",
        );
        const upperDuplicate = makeRecord(
            RecordType.settings,
            { record_role: "guide-template" },
            "GENERAL",
        );
        const resolution = resolveGuideTemplates([duplicateId, upperDuplicate]);
        expect(
            resolution.filter((template) => template.id.toLowerCase() === "general"),
        ).toHaveLength(1);

        const onlyCustom = resolveGuideTemplates([custom], []);
        expect(onlyCustom.map((template) => template.id)).toEqual([custom.id]);
    });

    it("creates drafts from a session and infers the template", () => {
        const entryId = crypto.randomUUID();
        const session = sessionRecord({ entry_id: entryId, subject: "Mathematics" });
        const inferred = createGuideDraft(session);
        expect(inferred.templateId).toBe("mathematics");
        expect(inferred.title).toBe("Fractions — Study Guide");
        expect(inferred.entryId).toBe(entryId);

        const explicit = createGuideDraft(session, "programming");
        expect(explicit.templateId).toBe("programming");

        const sparse = makeRecord(RecordType.session, { subject: "" });
        const fallback = createGuideDraft(sparse);
        expect(fallback.title).toBe("Tutoring Session — Study Guide");
        expect(fallback.templateId).toBe("general");
        expect(fallback.entryId).toBe("");

        expect(createGuideDraftFromSections(session, "custom", ["A", "B"]).sections).toHaveLength(
            2,
        );

        expect(getGuideTemplate("english").id).toBe("english");
        expect(getGuideTemplate("unknown").id).toBe("general");
    });

    it("infers subjects across every supported family", () => {
        expect(inferGuideTemplateId("English Literature")).toBe("english");
        expect(inferGuideTemplateId("Algebra II")).toBe("mathematics");
        expect(inferGuideTemplateId("Computer Science")).toBe("programming");
        expect(inferGuideTemplateId("Spanish vocabulary")).toBe("language-learning");
        expect(inferGuideTemplateId("Chemistry")).toBe("science");
        expect(inferGuideTemplateId("History")).toBe("general");
    });
});

describe("guide generation from a session", () => {
    it("rejects invalid sessions and unavailable templates", () => {
        const settings = makeRecord(RecordType.settings, {});
        expect(() => generateGuideDraftFromSession(settings, "general", [], [])).toThrow(
            "active session",
        );
        const deleted = sessionRecord({ _deleted: "true" });
        expect(() => generateGuideDraftFromSession(deleted, "general", [], [])).toThrow(
            "active session",
        );
        const session = sessionRecord();
        expect(() => generateGuideDraftFromSession(session, "missing", [session], [])).toThrow(
            "available in this archive",
        );
        const invalidSessionTemplate = sessionRecord({ guide_template_id: "missing" });
        expect(() => generateGuideDraftFromSession(invalidSessionTemplate, "auto", [], [])).toThrow(
            "available in this archive",
        );
    });

    it("resolves automatic, named, session, preferred, and inferred templates", () => {
        const template = makeRecord(RecordType.settings, {
            record_role: "guide-template",
            name: "Socratic review",
            sections: "Session overview\nSocratic prompts",
        });
        const student = makeRecord(
            RecordType.student,
            { display_name: "Mina", preferred_guide_template: "Socratic review" },
            crypto.randomUUID(),
        );
        const session = sessionRecord({
            student_id: student.id.toUpperCase(),
            subject: "Unknown subject",
        });
        const records = [session, template, student];

        expect(generateGuideDraftFromSession(session, "auto", records, [student]).templateId).toBe(
            template.id,
        );
        expect(generateGuideDraftFromSession(session, "", records, [student]).templateId).toBe(
            template.id,
        );
        expect(generateGuideDraftFromSession(session, "AUTO", records, [student]).templateId).toBe(
            template.id,
        );
        expect(
            generateGuideDraftFromSession(session, "Socratic review", records, [student])
                .templateId,
        ).toBe(template.id);

        const sessionTemplate = sessionRecord({ guide_template_id: "english" });
        const inferred = generateGuideDraftFromSession(
            sessionTemplate,
            "auto",
            [sessionTemplate],
            [],
        );
        expect(inferred.templateId).toBe("english");

        const mathSession = sessionRecord({ subject: "Geometry" });
        expect(
            generateGuideDraftFromSession(mathSession, "auto", [mathSession], []).templateId,
        ).toBe("mathematics");

        const byName = generateGuideDraftFromSession(mathSession, "Mathematics", [mathSession], []);
        expect(byName.templateId).toBe("mathematics");

        const anonymous = sessionRecord({
            student_id: "anonymous",
            preferred_guide_template: "english",
        });
        expect(
            generateGuideDraftFromSession(anonymous, "auto", [anonymous], [student]).templateId,
        ).toBe("mathematics");

        const missingStudent = sessionRecord({ student_id: crypto.randomUUID() });
        expect(
            generateGuideDraftFromSession(missingStudent, "auto", [missingStudent], [student])
                .templateId,
        ).toBe("mathematics");

        const badPreferred = makeRecord(
            RecordType.student,
            { preferred_guide_template: "nope" },
            crypto.randomUUID(),
        );
        const fallbackSession = sessionRecord({ student_id: badPreferred.id });
        expect(
            generateGuideDraftFromSession(
                fallbackSession,
                "auto",
                [fallbackSession],
                [badPreferred],
            ).templateId,
        ).toBe("mathematics");
    });

    it("builds evidence sections from annotations, transcripts, verified nodes, progress, and notes", () => {
        const entryId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();
        const otherSessionId = crypto.randomUUID();
        const studentId = crypto.randomUUID();
        const segmentId = crypto.randomUUID();
        const otherSegmentId = crypto.randomUUID();
        const evidenceId = crypto.randomUUID();
        const secondEvidenceId = crypto.randomUUID();

        const session = sessionRecord(
            {
                id: sessionId,
                entry_id: entryId,
                student_id: studentId,
                title: "Fractions",
                subject: "Math",
                learning_objectives: "Compare fractions",
            },
            sessionId,
        );
        const otherNotesId = crypto.randomUUID();
        const otherSession = sessionRecord(
            {
                entry_id: entryId,
                student_id: studentId,
                title: "Ratios",
                notes_document_id: otherNotesId,
            },
            otherSessionId,
        );
        const student = makeRecord(
            RecordType.student,
            {
                display_name: "Mina",
                known_difficulties: "Denominators",
                demonstrated_improvements: "Scale factors",
                progress_classifications: encodeStudentProgress([
                    {
                        skill: "Fractions",
                        classification: "recurring",
                        note: "Needs reminders",
                        reviewedBy: "Tutor",
                        reviewedAtUs: "1",
                        evidenceSourceIds: [evidenceId, secondEvidenceId],
                    },
                    {
                        skill: "Ratios",
                        classification: "unverified-improvement",
                        note: "",
                        reviewedBy: "Tutor",
                        reviewedAtUs: "1",
                        evidenceSourceIds: [evidenceId],
                    },
                    {
                        skill: "Decimals",
                        classification: "newly-observed",
                        note: "",
                        reviewedBy: "Tutor",
                        reviewedAtUs: "1",
                        evidenceSourceIds: [crypto.randomUUID()],
                    },
                ]),
            },
            studentId,
        );

        const annotations = [
            makeRecord(RecordType.annotation, {
                session_id: sessionId,
                type: "important-concept",
                title: "Focus",
                priority: "high",
                content: "Scale both quantities.",
                origin: "tutor-authored",
                start_time_us: "2000",
            }),
            makeRecord(RecordType.annotation, {
                session_id: sessionId,
                type: "mystery-type",
                content: "Observed something.",
                start_time_us: "1000",
            }),
            makeRecord(RecordType.annotation, {
                session_id: sessionId,
                type: "student-mistake",
                content: "Deleted annotation.",
                start_time_us: "1000",
                _deleted: "true",
            }),
        ];
        const transcripts = [
            makeRecord(RecordType.transcriptSegment, {
                session_id: sessionId,
                text: "First line.",
                start_time_us: "0",
                end_time_us: "2000000",
            }),
            makeRecord(RecordType.transcriptSegment, {
                session_id: sessionId,
                text: "Second line.",
                start_time_us: "3000000",
                end_time_us: "1000000",
            }),
            makeRecord(RecordType.transcriptSegment, {
                session_id: sessionId,
                text: "Undated line.",
                timestamp_state: "not-timestamped",
                start_time_us: "1",
            }),
        ];
        const annotation = makeRecord(RecordType.annotation, {
            session_id: sessionId,
            start_time_us: "1",
        });
        const currentSegment = makeRecord(
            RecordType.transcriptSegment,
            { session_id: sessionId, text: "Current." },
            segmentId,
        );
        const unlinkedSegment = makeRecord(
            RecordType.transcriptSegment,
            { text: "Unlinked." },
            otherSegmentId,
        );
        const evidenceRecords = [
            makeRecord(
                RecordType.evidenceNode,
                {
                    session_id: sessionId,
                    origin: "transcript-derived-candidate",
                    verification_state: "human-verified",
                    type: "important-concept-candidate",
                    source_segment_ids: segmentId,
                    source_segment_revisions: `${segmentId}=0`,
                    source_speaker_label: "Tutor",
                    start_time_us: "2000000",
                    content: "Verified concept.",
                },
                evidenceId,
            ),
            makeRecord(
                RecordType.evidenceNode,
                {
                    session_id: sessionId,
                    origin: "transcript-derived-candidate",
                    verification_state: "human-verified",
                    type: "mystery-candidate",
                    source_annotation_id: annotation.id,
                    source_annotation_revision: "",
                    start_time_us: "1000000",
                    content: "Verified note.",
                },
                secondEvidenceId,
            ),
            makeRecord(RecordType.evidenceNode, {
                session_id: sessionId,
                origin: "transcript-derived-candidate",
                verification_state: "human-verified",
                type: "explicit-instruction-candidate",
                source_segment_ids: otherSegmentId,
                start_time_us: "3000000",
                content: "Not current.",
            }),
            makeRecord(RecordType.evidenceNode, {
                session_id: sessionId,
                origin: "transcript-derived-candidate",
                verification_state: "human-verified",
                type: "explanation-candidate",
                source_segment_ids: "not-a-uuid",
                start_time_us: "3000000",
                content: "Invalid source.",
            }),
            makeRecord(RecordType.evidenceNode, {
                session_id: sessionId,
                origin: "transcript-derived-candidate",
                verification_state: "human-verified",
                type: "explanation-candidate",
                start_time_us: "3000000",
                content: "No sources.",
            }),
            makeRecord(RecordType.session, {
                session_id: sessionId,
                student_id: studentId,
                entry_id: entryId,
                learning_objectives: "Second session objective",
            }),
        ];
        const progressSessions = [
            makeRecord(
                RecordType.session,
                { student_id: studentId, entry_id: entryId, title: "First" },
                sessionId,
            ),
            makeRecord(
                RecordType.session,
                { student_id: studentId, entry_id: entryId, title: "Second" },
                otherSessionId,
            ),
        ];
        const progressEvidence = [
            makeRecord(
                RecordType.evidenceNode,
                { session_id: sessionId, verification_state: "human-verified" },
                evidenceId,
            ),
            makeRecord(
                RecordType.evidenceNode,
                { session_id: otherSessionId, verification_state: "human-verified" },
                secondEvidenceId,
            ),
        ];

        const sameSessionNotes = notesRecord({ entryId, sessionId }, [
            { id: "one", kind: "paragraph", text: "Same session note." },
        ]);
        const secondSameSessionNotes = notesRecord({ entryId, sessionId }, [
            { id: "two", kind: "paragraph", text: "" },
        ]);
        const otherSessionNotes = notesRecord(
            { entryId, sessionId: otherSessionId },
            [{ id: "three", kind: "paragraph", text: "Related session note." }],
            {},
            otherNotesId,
        );
        const entryNotes = notesRecord({ entryId, sessionId: "" }, [
            { id: "four", kind: "paragraph", text: "Journal reflection." },
        ]);
        const unreadableNotes = notesRecord({ entryId, sessionId }, [], { block_count: "bogus" });
        const journalEntry = makeRecord(
            RecordType.settings,
            { record_role: "journal-entry", title: "Entry", notes_document_id: entryNotes.id },
            entryId,
        );

        const records = [
            session,
            otherSession,
            student,
            ...annotations,
            ...transcripts,
            annotation,
            currentSegment,
            unlinkedSegment,
            ...evidenceRecords,
            ...progressSessions,
            ...progressEvidence,
            sameSessionNotes,
            secondSameSessionNotes,
            otherSessionNotes,
            entryNotes,
            unreadableNotes,
            journalEntry,
        ];

        const generated = generateGuideDraftFromSession(
            session,
            "general",
            records,
            [student],
            undefined,
            true,
        );

        const headings = generated.sections.map((item) => item.heading);
        expect(headings).toContain("Session overview");
        expect(headings).toContain("Tutor profile context");
        expect(headings).toContain("Key concepts");
        expect(headings).toContain("Tutor notes");
        expect(headings).toContain("Transcript excerpts — verbatim, review required");
        expect(headings).toContain("Verified spoken concepts");
        expect(headings).toContain("Verified transcript evidence");
        expect(headings).toContain("Progress since previous lessons");
        expect(headings).toContain("Session notes");
        expect(headings).toContain("Session notes · Ratios");
        expect(headings).toContain("Journal reflection");
        expect(headings.some((heading) => heading.includes("Unlinked"))).toBe(false);

        const overview = generated.sections.find((item) => item.heading === "Session overview")!;
        expect(overview.blocks[0]!.text).toContain("Subject: Math");
        expect(overview.blocks[1]!.text).toContain("Compare fractions");

        const concepts = generated.sections.find((item) => item.heading === "Key concepts")!;
        expect(concepts.blocks[0]!.text).toContain("**Focus**");
        const notesSection = generated.sections.find((item) => item.heading === "Tutor notes")!;
        expect(notesSection.blocks[0]!.origin).toBe("session-evidence");

        const transcriptSection = generated.sections.find((item) =>
            item.heading.startsWith("Transcript excerpts"),
        )!;
        expect(transcriptSection.blocks.map((item) => item.text)).toEqual([
            "[00:00:00–00:00:02] First line.",
            "[00:00:00] Current.",
            "[time not provided] Undated line.",
            "[00:00:03] Second line.",
        ]);

        const transcriptEvidence = generated.sections.find(
            (item) => item.heading === "Verified spoken concepts",
        )!;
        expect(transcriptEvidence.blocks[0]!.text).toContain(
            "[00:00:02] [Tutor] Verified concept.",
        );
        expect(transcriptEvidence.blocks[0]!.sourceIds).toBe(`${evidenceId},${segmentId}`);

        const progress = generated.sections.find(
            (item) => item.heading === "Progress since previous lessons",
        )!;
        expect(progress.blocks).toHaveLength(3);
        expect(progress.blocks[0]!.text).toContain("(human-reviewed; 2 evidence record(s)");
        expect(progress.blocks[0]!.text).toContain("Tutor note: Needs reminders");
        expect(progress.blocks[0]!.text).toContain("Evidence record IDs:");
        expect(progress.blocks[1]!.text).toContain("UNVERIFIED CLAIM");
        expect(progress.blocks[1]!.origin).toBe("uncertain");
        expect(progress.blocks[2]!.text).toContain("source evidence is missing or invalid");
    });

    it("falls back to the evidence status section and excludes entry evidence by default", () => {
        const entryId = crypto.randomUUID();
        const session = sessionRecord({ entry_id: entryId });
        const entryNotes = notesRecord({ entryId, sessionId: "" }, [
            { id: "one", kind: "paragraph", text: "Entry note." },
        ]);
        const journalEntry = makeRecord(
            RecordType.settings,
            { record_role: "journal-entry", notes_document_id: entryNotes.id },
            entryId,
        );
        const generated = generateGuideDraftFromSession(
            session,
            "general",
            [session, entryNotes, journalEntry],
            [],
        );
        expect(generated.sections.map((item) => item.heading)).toEqual([
            "Session overview",
            "Evidence status",
        ]);
        expect(generated.sections[1]!.blocks[0]!.origin).toBe("system-generated");
    });

    it("covers malformed source revision variants for verified evidence", () => {
        const sessionId = crypto.randomUUID();
        const session = sessionRecord({}, sessionId);
        const makeEvidence = (fields: Fields) =>
            makeRecord(RecordType.evidenceNode, {
                session_id: sessionId,
                origin: "transcript-derived-candidate",
                verification_state: "human-verified",
                type: "explanation-candidate",
                ...fields,
            });
        const annotation = makeRecord(RecordType.annotation, { session_id: sessionId });
        const segment = makeRecord(
            RecordType.transcriptSegment,
            { session_id: sessionId },
            crypto.randomUUID(),
        );
        const resource = makeRecord(RecordType.assetMetadata, {
            session_id: sessionId,
            mime_type: "image/png",
        });
        const deletedAnnotation = {
            ...annotation,
            fields: new Map(annotation.fields),
        };
        deletedAnnotation.fields.set("_deleted", "true");
        const wrongType = makeRecord(RecordType.student, { session_id: sessionId });
        const otherSessionAnnotation = makeRecord(RecordType.annotation, {
            session_id: crypto.randomUUID(),
        });

        const records = [
            session,
            annotation,
            wrongType,
            deletedAnnotation,
            otherSessionAnnotation,
            segment,
            resource,
            makeEvidence({ source_annotation_id: "not-a-uuid" }),
            makeEvidence({ source_annotation_id: crypto.randomUUID() }),
            makeEvidence({ source_annotation_id: wrongType.id }),
            makeEvidence({ source_annotation_id: deletedAnnotation.id }),
            makeEvidence({ source_annotation_id: otherSessionAnnotation.id }),
            makeEvidence({ source_annotation_id: annotation.id, source_annotation_revision: "0" }),
            makeEvidence({ source_annotation_id: annotation.id, source_annotation_revision: "5" }),
            makeEvidence({ source_annotation_id: annotation.id, source_annotation_revision: "x" }),
            makeEvidence({ source_segment_revisions: "bad" }),
            makeEvidence({ source_segment_revisions: "=1" }),
            makeEvidence({ source_segment_revisions: `${segment.id}=` }),
            makeEvidence({ source_segment_revisions: "not-a-uuid=1" }),
            makeEvidence({ source_segment_revisions: `${segment.id}=x` }),
            makeEvidence({ source_segment_ids: "not-a-uuid" }),
            makeEvidence({ source_segment_ids: crypto.randomUUID() }),
            makeEvidence({ source_asset_ids: "not-a-uuid" }),
            makeEvidence({ source_asset_ids: resource.id }),
            makeEvidence({ source_segment_ids: segment.id }),
        ];
        const generated = generateGuideDraftFromSession(session, "general", records, []);
        expect(generated.sections.map((item) => item.heading)).toEqual([
            "Session overview",
            "Tutor notes",
            "Transcript excerpts — verbatim, review required",
            "Verified spoken explanations",
        ]);
        expect(
            generated.sections.find((item) => item.heading === "Verified spoken explanations")!
                .blocks.length,
        ).toBeGreaterThanOrEqual(2);
    });

    it("handles notes that are ineligible, unreadable, or empty", () => {
        const entryId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();
        const session = sessionRecord({ entry_id: entryId }, sessionId);
        const ineligible = makeRecord(RecordType.settings, {
            record_role: "journal-notes",
            session_id: sessionId,
            block_count: "0",
            _deleted: "true",
        });
        const unreadable = notesRecord({ entryId, sessionId }, [], { block_count: "x" });
        const emptyText = notesRecord({ entryId, sessionId }, [
            { id: "one", kind: "paragraph", text: "" },
        ]);
        const otherEntryNotes = notesRecord(
            { entryId: crypto.randomUUID(), sessionId: crypto.randomUUID() },
            [{ id: "two", kind: "paragraph", text: "Other entry." }],
        );
        const generated = generateGuideDraftFromSession(
            session,
            "general",
            [session, ineligible, unreadable, emptyText, otherEntryNotes],
            [],
        );
        expect(generated.sections.map((item) => item.heading)).toEqual([
            "Session overview",
            "Evidence status",
        ]);

        expect(
            isGuideNotesSource(
                makeRecord(RecordType.settings, { record_role: "journal-notes" }),
                session,
                [session],
            ),
        ).toBe(false);
        expect(
            isGuideNotesSource(makeRecord(RecordType.settings, { record_role: "other" }), session, [
                session,
            ]),
        ).toBe(false);
        expect(
            isGuideNotesSource(
                makeRecord(RecordType.settings, {
                    record_role: "journal-notes",
                    session_id: sessionId,
                    _deleted: "true",
                }),
                session,
                [session],
            ),
        ).toBe(false);
        expect(
            isGuideNotesSource(
                makeRecord(RecordType.settings, {
                    record_role: "journal-notes",
                    session_id: sessionId,
                }),
                session,
                [session],
            ),
        ).toBe(true);
        expect(
            isGuideNotesSource(
                makeRecord(RecordType.settings, {
                    record_role: "journal-notes",
                    entry_id: entryId,
                }),
                session,
                [session],
            ),
        ).toBe(false);
    });
});

describe("guide generation from an entry", () => {
    const entryId = crypto.randomUUID();

    function entryRecord(fields: Fields = {}): ArchiveRecord {
        return makeRecord(
            RecordType.settings,
            {
                record_role: "journal-entry",
                title: "Journal entry",
                subject: "Math",
                ...fields,
            },
            entryId,
        );
    }

    function linkedSession(fields: Fields = {}): ArchiveRecord {
        return sessionRecord(
            {
                entry_id: entryId,
                student_id: "anonymous",
                title: "Fractions",
                guide_template_id: "general",
                ...fields,
            },
            crypto.randomUUID(),
        );
    }

    it("rejects records that are not active journal entries", () => {
        expect(() =>
            generateGuideDraftFromEntry(makeRecord(RecordType.session), "general", [], []),
        ).toThrow("active journal entry");
        expect(() =>
            generateGuideDraftFromEntry(entryRecord({ _deleted: "true" }), "general", [], []),
        ).toThrow("active journal entry");
        expect(() =>
            generateGuideDraftFromEntry(
                makeRecord(RecordType.settings, { record_role: "journal-notes" }),
                "general",
                [],
                [],
            ),
        ).toThrow("active journal entry");
    });

    it("merges live session sections with entry notes", () => {
        const first = linkedSession({ title: "Fractions", started_at_us: "1" });
        const second = linkedSession({ title: "Ratios", started_at_us: "2" });
        const deleted = linkedSession({ _deleted: "true" });
        const otherEntry = linkedSession({ entry_id: crypto.randomUUID() });
        const notes = notesRecord({ entryId, sessionId: "" }, [
            { id: "note", kind: "paragraph", text: "Entry note." },
        ]);
        const entry = entryRecord({ notes_document_id: notes.id });
        const generated = generateGuideDraftFromEntry(
            entry,
            "general",
            [entry, first, second, deleted, otherEntry, notes],
            [],
        );
        expect(generated.entryId).toBe(entryId);
        expect(generated.sessionId).toBe("");
        expect(generated.sections.some((item) => item.heading === "Entry notes")).toBe(true);
        expect(generated.sections.some((item) => item.heading.includes("Fractions"))).toBe(true);
        expect(generated.sections.some((item) => item.heading.includes("Ratios"))).toBe(true);
        expect(generated.title).toBe("Journal entry — Study Guide");
    });

    it("falls back to an entry overview when there is no material", () => {
        const entry = makeRecord(
            RecordType.settings,
            { record_role: "journal-entry", subject: "Math" },
            entryId,
        );
        const generated = generateGuideDraftFromEntry(entry, "auto", [entry], []);
        expect(generated.templateId).toBe("mathematics");
        expect(generated.title).toBe("Journal entry — Study Guide");
        expect(generated.sections).toHaveLength(1);
        expect(generated.sections[0]!.heading).toBe("Entry overview");
        expect(generated.sections[0]!.blocks[0]!.text).toContain("No session or notes material");
    });

    it("resolves an explicit template and rejects an unknown one", () => {
        const entry = entryRecord({ subject: "Unknown" });
        expect(generateGuideDraftFromEntry(entry, "Mathematics", [entry], []).templateId).toBe(
            "mathematics",
        );
        expect(generateGuideDraftFromEntry(entry, "general", [entry], []).templateId).toBe(
            "general",
        );
        expect(() => generateGuideDraftFromEntry(entry, "missing", [entry], [])).toThrow(
            "available in this archive",
        );
        expect(generateGuideDraftFromEntry(entry, "  ", [entry], []).templateId).toBe("general");
    });

    it("skips missing, unreadable, and empty entry notes", () => {
        const missing = entryRecord({ notes_document_id: crypto.randomUUID() });
        expect(
            generateGuideDraftFromEntry(missing, "general", [missing], []).sections[0]!.heading,
        ).toBe("Entry overview");

        const unreadable = notesRecord({ entryId, sessionId: "" }, [], { block_count: "x" });
        const withUnreadable = entryRecord({ notes_document_id: unreadable.id });
        expect(
            generateGuideDraftFromEntry(withUnreadable, "general", [withUnreadable, unreadable], [])
                .sections[0]!.heading,
        ).toBe("Entry overview");

        const empty = notesRecord({ entryId, sessionId: "" }, [
            { id: "one", kind: "paragraph", text: "" },
        ]);
        const withEmpty = entryRecord({ notes_document_id: empty.id });
        expect(
            generateGuideDraftFromEntry(withEmpty, "general", [withEmpty, empty], []).sections[0]!
                .heading,
        ).toBe("Entry overview");

        const sessionNotes = notesRecord({ entryId, sessionId: crypto.randomUUID() }, [
            { id: "two", kind: "paragraph", text: "Not entry notes." },
        ]);
        const withSessionNotes = entryRecord({ notes_document_id: sessionNotes.id });
        expect(
            generateGuideDraftFromEntry(
                withSessionNotes,
                "general",
                [withSessionNotes, sessionNotes],
                [],
            ).sections[0]!.heading,
        ).toBe("Entry overview");
    });

    it("sorts sessions by start time, ties, and invalid timestamps while truncating headings", () => {
        const longTitle = "a".repeat(300);
        const first = linkedSession({ title: longTitle, started_at_us: "not-a-number" });
        const second = linkedSession({ title: "Second", started_at_us: "1" });
        const third = linkedSession({ title: "Third", started_at_us: "1" });
        const entry = entryRecord({});
        const generated = generateGuideDraftFromEntry(
            entry,
            "general",
            [entry, second, third, first],
            [],
        );
        const sessionHeadings = generated.sections.map((item) => item.heading);
        for (const heading of sessionHeadings) {
            expect(new TextEncoder().encode(heading).byteLength).toBeLessThanOrEqual(256);
        }
        expect(generated.sections.length).toBeGreaterThan(3);
    });
});

describe("guide record decisions", () => {
    it("returns regeneration targets only for non-approved guides", () => {
        expect(guideRegenerationTarget(null)).toBeNull();
        expect(() => guideRegenerationTarget(makeRecord(RecordType.session))).toThrow(
            "Only a study guide",
        );
        const record = guideRecord([]);
        expect(guideRegenerationTarget(record)).toBe(record);
        const approved = { ...record, fields: new Map(record.fields) };
        approved.fields.set("approval_state", "approved");
        expect(guideRegenerationTarget(approved)).toBeNull();
    });

    it("replaces only the mapped section", () => {
        const target = draft([
            section("Key concepts", [block("old")], "one"),
            section("Practice", [block("keep")], "two"),
        ]);
        const generated = draft(
            [
                section("Key concepts", [block("fresh", { kind: "quote" })]),
                section("Other", [block("ignored")]),
            ],
            { title: "Generated" },
        );
        const replaced = replaceGuideSectionFromGenerated(target, 0, generated);
        expect(replaced.sections[0]!.blocks[0]!.text).toBe("fresh");
        expect(replaced.sections[1]).toBe(target.sections[1]);
        expect(() => replaceGuideSectionFromGenerated(target, 5, generated)).toThrow(
            "Choose a guide section",
        );
        expect(() =>
            replaceGuideSectionFromGenerated(target, 0, draft([section("Nothing", [block("x")])])),
        ).toThrow("No current evidence");
    });

    it("inserts escaped image blocks and validates the asset", () => {
        const target = draft([section("Examples"), section("Sources")]);
        const asset = makeRecord(RecordType.assetMetadata, {
            title: "Bar [model] \\ copy",
            mime_type: "image/png",
        });
        const inserted = insertGuideImageBlock(target, 0, asset);
        expect(inserted.sections[0]!.blocks[0]!.text).toBe(
            `![Bar [model\\] \\\\ copy](asset:${asset.id})`,
        );
        expect(inserted.sections[1]!.blocks).toHaveLength(0);
        expect(() => insertGuideImageBlock(target, 9, asset)).toThrow("Choose a guide section");
        expect(() => insertGuideImageBlock(target, 0, makeRecord(RecordType.session))).toThrow(
            "Choose an image from this archive",
        );
        expect(() =>
            insertGuideImageBlock(target, 0, {
                ...asset,
                fields: new Map([...asset.fields, ["_deleted", "true"]]),
            }),
        ).toThrow("Choose an image from this archive");
        expect(() =>
            insertGuideImageBlock(
                target,
                0,
                makeRecord(RecordType.assetMetadata, { mime_type: "text/plain" }),
            ),
        ).toThrow("Choose an image asset");
        expect(
            insertGuideImageBlock(
                target,
                0,
                makeRecord(RecordType.assetMetadata, { mime_type: "image/png" }),
            ).sections[0]!.blocks[0]!.text,
        ).toContain("![Guide image](asset:");
    });
});

describe("guide export validation", () => {
    it("rejects structurally invalid guides", () => {
        expect(() => validateGuideForExport(makeRecord(RecordType.session))).toThrow(
            "Only a study guide",
        );
        expect(() => validateGuideForExport(guideRecord([], { title: "" }))).toThrow(
            "without a title",
        );
        expect(() => validateGuideForExport(guideRecord([]))).toThrow("at least one section");
        expect(() => validateGuideForExport(guideRecord([{ heading: "  " }]))).toThrow(
            "needs a heading",
        );
        expect(() =>
            validateGuideForExport(guideRecord([{ heading: "One", blocks: [{ kind: "future" }] }])),
        ).toThrow("not supported for export");
        expect(() =>
            validateGuideForExport(
                guideRecord([
                    { heading: "One", blocks: [{ kind: "paragraph", origin: "imported-origin" }] },
                ]),
            ),
        ).toThrow("provenance");
        expect(() =>
            validateGuideForExport(
                guideRecord([{ heading: "One", blocks: [{ kind: "table", text: "| one |" }] }]),
            ),
        ).toThrow("separator");
        expect(() =>
            validateGuideForExport(
                guideRecord([
                    { heading: "One", blocks: [{ kind: "paragraph", sourceIds: "not-a-uuid" }] },
                ]),
            ),
        ).toThrow("not a valid UUID");
    });

    it("accepts supported blocks and verifies scope for images and sources", () => {
        const session = sessionRecord();
        const asset = makeRecord(RecordType.assetMetadata, {
            session_id: session.id,
            mime_type: "image/png",
        });
        const valid = guideRecord(
            [
                {
                    heading: "One",
                    blocks: [
                        { kind: "paragraph", text: "Scale.", sourceIds: session.id },
                        { kind: "table", text: "| A | B |\n| --- | --- |\n| 1 | 2 |" },
                        { kind: "image", text: `![Chart](asset:${asset.id})`, sourceIds: asset.id },
                        { kind: "figure", text: `![Chart](asset:${asset.id})` },
                    ],
                },
            ],
            { session_id: session.id },
        );
        expect(() =>
            validateGuideForExport(valid, { session, records: [session, asset] }),
        ).not.toThrow();
        expect(() => validateGuideForExport(valid)).not.toThrow();

        const missingImage = guideRecord([
            {
                heading: "One",
                blocks: [{ kind: "image", text: `![Chart](asset:${crypto.randomUUID()})` }],
            },
        ]);
        expect(() => validateGuideForExport(missingImage, { session, records: [session] })).toThrow(
            "missing or not a supported image",
        );

        const wrongType = makeRecord(RecordType.settings, { session_id: session.id });
        const wrongImage = guideRecord([
            {
                heading: "One",
                blocks: [{ kind: "image", text: `![Chart](asset:${wrongType.id})` }],
            },
        ]);
        expect(() =>
            validateGuideForExport(wrongImage, { session, records: [session, wrongType] }),
        ).toThrow("missing or not a supported image");

        const wrongMime = makeRecord(RecordType.assetMetadata, {
            session_id: session.id,
            mime_type: "image/svg+xml",
        });
        const unsupported = guideRecord([
            {
                heading: "One",
                blocks: [{ kind: "image", text: `![Chart](asset:${wrongMime.id})` }],
            },
        ]);
        expect(() =>
            validateGuideForExport(unsupported, { session, records: [session, wrongMime] }),
        ).toThrow("missing or not a supported image");

        const deletedAsset = {
            ...asset,
            fields: new Map([...asset.fields, ["_deleted", "true"]]),
        };
        const deleted = guideRecord([
            { heading: "One", blocks: [{ kind: "image", text: `![Chart](asset:${asset.id})` }] },
        ]);
        expect(() =>
            validateGuideForExport(deleted, { session, records: [session, deletedAsset] }),
        ).toThrow("missing or not a supported image");

        const badInline = guideRecord([
            { heading: "One", blocks: [{ kind: "paragraph", text: "[[source:bad]]" }] },
        ]);
        expect(() => validateGuideForExport(badInline)).toThrow("valid archive record IDs");

        const unclosedInline = guideRecord([
            { heading: "One", blocks: [{ kind: "paragraph", text: "[[source:" }] },
        ]);
        expect(() => validateGuideForExport(unclosedInline)).toThrow("closing brackets");

        const outOfScope = guideRecord([
            { heading: "One", blocks: [{ kind: "paragraph", sourceIds: crypto.randomUUID() }] },
        ]);
        expect(() => validateGuideForExport(outOfScope, { session, records: [session] })).toThrow(
            "missing or does not belong",
        );
    });
});

describe("guide rendering", () => {
    it("renders Markdown with prefixes, stale markers, labels, and citations", () => {
        const record = guideRecord(
            [
                {
                    heading: "One",
                    blocks: [
                        { kind: "list-item", text: "First [[source:abc]]", sourceIds: "a, b" },
                        { kind: "quote", text: "Second", stale: true, origin: "unknown" },
                        { kind: "code", text: "Third" },
                    ],
                },
            ],
            { title: "Markdown guide", approval_state: "approved" },
        );
        const markdown = renderGuideMarkdown(record);
        expect(markdown).toContain("# Markdown guide");
        expect(markdown).toContain("approved");
        expect(markdown).toContain("- First [source: abc]");
        expect(markdown).toContain("_Source: `a`, `b`_");
        expect(markdown).toContain("> **Source changed — review this block.** ");
        expect(markdown).toContain("**Content with unverified provenance:** Second");
        expect(markdown.endsWith("\n")).toBe(true);

        const empty = guideRecord([], { approval_state: "" });
        empty.fields.delete("approval_state");
        const emptyMarkdown = renderGuideMarkdown(empty);
        expect(emptyMarkdown).toContain("draft");
        expect(emptyMarkdown.endsWith("_\n\n")).toBe(true);
    });

    it("renders HTML blocks, escaping, images, and tables", () => {
        const imageId = crypto.randomUUID();
        const image = {
            assetId: imageId,
            mimeType: "image/png",
            bytes: new Uint8Array(0x8001).fill(0x41),
        };
        const record = guideRecord([
            {
                heading: "Text & <blocks> \"quoted\" 'single'",
                blocks: [
                    { kind: "list-item", text: "list <one>" },
                    { kind: "quote", text: "quote", stale: true },
                    { kind: "code", text: "code" },
                    { kind: "equation", text: "x = 1" },
                    { kind: "paragraph", text: "plain" },
                    { kind: "table", text: "| A | B |\n| --- | --- |\n| 1 | 2 |" },
                    { kind: "image", text: `![Chart <one>](asset:${imageId})`, sourceIds: imageId },
                    { kind: "figure", text: "![No caption](asset:" + imageId + ")" },
                    { kind: "paragraph", text: "", origin: "system-generated" },
                ],
            },
        ]);
        const html = renderGuideHtml(record, new Map([[imageId, image]]));
        expect(html).toContain("&lt;blocks&gt;");
        expect(html).toContain("&quot;quoted&quot;");
        expect(html).toContain("&#39;single&#39;");
        expect(html).toContain("<ul><li");
        expect(html).toContain("<blockquote");
        expect(html).toContain("<pre");
        expect(html).toContain("guide-equation");
        expect(html).toContain('<table class="guide-table">');
        expect(html).toContain('src="data:image/png;base64,');
        expect(html).toContain("<figcaption>Chart &lt;one&gt;</figcaption>");
        expect(html).toContain("<figcaption>No caption</figcaption>");
        expect(html).toContain("Tutorux-generated notice");
        expect(html).toContain("Source changed. Review this block");

        const noCaption = guideRecord([
            { heading: "One", blocks: [{ kind: "image", text: `![](asset:${imageId})` }] },
        ]);
        const noCaptionHtml = renderGuideHtml(noCaption, new Map([[imageId, image]]));
        expect(noCaptionHtml).toContain('alt=""');
        expect(noCaptionHtml).not.toContain("<figcaption>");
    });

    it("rejects invalid image references and missing assets", () => {
        const record = guideRecord([
            { heading: "One", blocks: [{ kind: "image", text: "not an image" }] },
        ]);
        expect(() => renderGuideHtml(record)).toThrow("point to one archive asset UUID");

        const missing = guideRecord([
            {
                heading: "One",
                blocks: [{ kind: "image", text: `![x](asset:${crypto.randomUUID()})` }],
            },
        ]);
        expect(() => renderGuideHtml(missing)).toThrow("missing from this archive");

        const id = crypto.randomUUID();
        const wrongMime = guideRecord([
            { heading: "One", blocks: [{ kind: "image", text: `![x](asset:${id})` }] },
        ]);
        expect(() =>
            renderGuideHtml(
                wrongMime,
                new Map([
                    [id, { assetId: id, mimeType: "image/svg+xml", bytes: new Uint8Array() }],
                ]),
            ),
        ).toThrow("Only PNG, JPEG, GIF, and WebP");
    });

    it("parses escaped image references and malformed references", () => {
        const id = crypto.randomUUID();
        expect(parseGuideImageReference(`![a \\] b \\\\ c](asset:${id.toUpperCase()})`)).toEqual({
            assetId: id,
            alternativeText: "a ] b \\ c",
        });
        expect(parseGuideImageReference("no image")).toBeNull();
        expect(parseGuideImageReference(`![x](asset:not-a-uuid)`)).toBeNull();
    });

    it("validates table shapes and escapes cell content", () => {
        const record = guideRecord([
            {
                heading: "Tables",
                blocks: [
                    {
                        kind: "table",
                        text: "| A\\|B | C |\n| --- | :---: |\n| one\\two | [[source:xyz]] |\n| trailing\\ | end |\n| last | value\\",
                    },
                ],
            },
        ]);
        const html = renderGuideHtml(record);
        expect(html).toContain("A|B");
        expect(html).toContain("[source: xyz]");

        for (const text of [
            "| one |",
            "| a | b |\n| - | - |",
            "| a | b |\n| --- | --- |\n| one |",
            "| a |\n| --- | --- |",
            "| a | b |\n| xxx | --- |",
        ]) {
            const invalid = guideRecord([{ heading: "Tables", blocks: [{ kind: "table", text }] }]);
            expect(() => renderGuideHtml(invalid)).toThrow("guide table");
        }
    });

    it("labels blocks across origins and kinds", () => {
        expect(guideBlockLabel("recommendation", "ai-generated")).toBe("AI recommendation");
        expect(guideBlockLabel("instruction", "ai-generated")).toBe("AI-drafted instruction");
        expect(guideBlockLabel("example", "ai-generated")).toBe("AI-generated example");
        expect(guideBlockLabel("worked-example", "ai-generated")).toBe("AI-generated example");
        expect(guideBlockLabel("paragraph", "ai-generated")).toBe("AI-generated content");
        expect(guideBlockLabel("quote", "ai-generated")).toBe("AI-generated content");
        expect(guideBlockLabel("instruction", "human-edited")).toBe("Tutor-edited instruction");
        expect(guideBlockLabel("recommendation", "human-edited")).toBe(
            "Tutor-edited recommendation",
        );
        expect(guideBlockLabel("worked-example", "human-edited")).toBe("Tutor-edited example");
        expect(guideBlockLabel("paragraph", "human-edited")).toBe("Tutor-edited content");
        expect(guideBlockLabel("paragraph", "uncertain")).toBe("Uncertain interpretation");
        expect(guideBlockLabel("paragraph", "system-generated")).toBe("Tutorux-generated notice");
        expect(guideBlockLabel("paragraph", "unknown")).toBe("Content with unverified provenance");
        expect(guideBlockLabel("instruction", "tutor-authored")).toBe("Tutor instruction");
        expect(guideBlockLabel("recommendation", "tutor-authored")).toBe("AI recommendation");
        expect(guideBlockLabel("worked-example", "tutor-authored")).toBe("Worked example");
        expect(guideBlockLabel("paragraph", "tutor-authored")).toBe("");
    });
});

describe("guide record decoding and saving", () => {
    it("decodes stored sections with fallbacks and rejects other record types", () => {
        expect(() => guideDraftFromRecord(makeRecord(RecordType.session))).toThrow(
            "Only a study guide",
        );
        const record = makeRecord(RecordType.guide, {
            section_count: "1",
            "section.0.block_count": "1",
            "section.0.block.0.kind": "paragraph",
            "section.0.block.0.text": "Hello",
            "section.0.block.0.stale": "true",
            "section.0.block.0.origin": "",
        });
        const decoded = guideDraftFromRecord(record);
        expect(decoded.templateId).toBe("general");
        expect(decoded.sections[0]!.id).toBeTruthy();
        expect(decoded.sections[0]!.blocks[0]).toEqual({
            kind: "paragraph",
            text: "Hello",
            sourceIds: "",
            stale: true,
            origin: "unknown",
        });
        expect(() =>
            guideDraftFromRecord(makeRecord(RecordType.guide, { section_count: "x" })),
        ).toThrow("section count is invalid");
        expect(() =>
            guideDraftFromRecord(
                makeRecord(RecordType.guide, { section_count: "1", "section.0.block_count": "-1" }),
            ),
        ).toThrow("block count is invalid");
        expect(() =>
            guideDraftFromRecord(makeRecord(RecordType.guide, { section_count: "10001" })),
        ).toThrow("outside supported limits");
    });

    it("saves new and existing guides while preserving unknown fields", () => {
        const session = sessionRecord();
        const target = draft(
            [section("Key concepts", [block("Scale.", { sourceIds: session.id })])],
            { sessionId: session.id, title: "Guide" },
        );
        const created = makeGuideRecord(target, { session, records: [session] });
        expect(created.type).toBe(RecordType.guide);
        expect(created.fields.get("session_id")).toBe(session.id);
        expect(created.fields.get("entry_id")).toBe(session.fields.get("entry_id"));
        expect(created.fields.get("stale_block_count")).toBe("0");
        expect(created.fields.get("created_at_us")).toBeTruthy();
        expect(created.fields.get("section.0.block.0.source_ids")).toBe(session.id);

        const existing = { ...created, fields: new Map(created.fields) };
        existing.fields.set("legacy_field", "keep");
        existing.fields.set("section.9.heading", "remove me");
        const updated = makeGuideRecord(target, { session, records: [session] }, existing);
        expect(updated.id).toBe(created.id);
        expect(updated.fields.get("legacy_field")).toBe("keep");
        expect(updated.fields.has("section.9.heading")).toBe(false);
        expect(updated.fields.get("created_at_us")).toBe(created.fields.get("created_at_us"));
    });

    it("rejects mismatched session and entry scope", () => {
        const session = sessionRecord();
        const otherEntry = crypto.randomUUID();
        expect(() =>
            makeGuideRecord(draft([section("One")], { sessionId: session.id }), {
                session,
                entry: makeRecord(
                    RecordType.settings,
                    { record_role: "journal-entry" },
                    otherEntry,
                ),
                records: [session],
            }),
        ).toThrow("does not belong");
        expect(() =>
            makeGuideRecord(draft([section("One")], { sessionId: crypto.randomUUID() }), {
                session,
                records: [session],
            }),
        ).toThrow("selected session changed");
        expect(() =>
            makeGuideRecord(
                draft([section("One")], { sessionId: session.id, entryId: otherEntry }),
                {
                    session,
                    records: [session],
                },
            ),
        ).toThrow("selected journal entry changed");
        expect(() =>
            makeGuideRecord(draft([section("One")]), {
                session: makeRecord(RecordType.session, { _deleted: "true" }),
                records: [],
            }),
        ).toThrow("Choose an active session");
        expect(() =>
            makeGuideRecord(draft([section("One")]), {
                session: makeRecord(RecordType.student),
                records: [],
            }),
        ).toThrow("Choose an active session");
        expect(() =>
            makeGuideRecord(draft([section("One")]), {
                records: [],
                entry: makeRecord(RecordType.session),
            }),
        ).toThrow("Choose an active journal entry");
        expect(() =>
            makeGuideRecord(draft([section("One")]), {
                records: [],
                entry: makeRecord(RecordType.settings, {
                    record_role: "journal-entry",
                    _deleted: "true",
                }),
            }),
        ).toThrow("Choose an active journal entry");
        expect(() =>
            makeGuideRecord(draft([section("One")], { sessionId: session.id }), {
                records: [],
                entry: makeRecord(RecordType.settings, { record_role: "journal-entry" }),
            }),
        ).toThrow("selected journal entry changed");
        expect(() =>
            makeGuideRecord(draft([section("One")], { entryId: crypto.randomUUID() }), {
                records: [],
                entry: makeRecord(RecordType.settings, { record_role: "journal-entry" }),
            }),
        ).toThrow("selected journal entry changed");
    });

    it("validates guide and block field limits", () => {
        const session = sessionRecord();
        const scope = { session, records: [session] };
        const build = (
            sections: GuideSectionDraft[],
            extra: Partial<GuideDraft> = {},
        ): GuideDraft => draft(sections, { sessionId: session.id, ...extra });
        expect(() => makeGuideRecord(build([section("One")], { title: "  " }), scope)).toThrow(
            "title is required",
        );
        expect(() =>
            makeGuideRecord(build([section("One")], { title: "汉".repeat(81) }), scope),
        ).toThrow("UTF-8 bytes");
        expect(() =>
            makeGuideRecord(build([section("One")], { title: "bad\u0000" }), scope),
        ).toThrow("control characters");
        expect(() => makeGuideRecord(build([]), scope)).toThrow("at least one section");
        expect(() =>
            makeGuideRecord(
                build(Array.from({ length: 251 }, (_, index) => section(`S${index}`))),
                scope,
            ),
        ).toThrow("at most 250 sections");
        expect(() => makeGuideRecord(build([section(" ")], { templateId: " " }), scope)).toThrow(
            "needs a heading",
        );
        expect(() =>
            makeGuideRecord(
                build([
                    section(
                        "One",
                        Array.from({ length: 1001 }, () => block("x")),
                    ),
                ]),
                scope,
            ),
        ).toThrow("at most 1,000 blocks");
        expect(() =>
            makeGuideRecord(build([section("One", [block("x", { kind: " " })])]), scope),
        ).toThrow("kind is required");
        expect(
            makeGuideRecord(
                build([section("One", [block("x", { kind: "paragraph", origin: "" })])]),
                scope,
            ).fields.get("section.0.block.0.origin"),
        ).toBe("unknown");
        expect(
            makeGuideRecord(build([section("One")], { templateId: " " }), scope).fields.get(
                "template_id",
            ),
        ).toBe("general");
        expect(() =>
            makeGuideRecord(build([section("One", [block("x", { sourceIds: "bad" })])]), scope),
        ).toThrow("not a valid UUID");
        expect(() =>
            makeGuideRecord(
                build([section("One", [block("x", { kind: "table", text: "| one |" })])]),
                scope,
            ),
        ).toThrow("separator");
        expect(() =>
            makeGuideRecord(
                build([section("One", [block("![x](asset:not-a-uuid)", { kind: "image" })])]),
                scope,
            ),
        ).toThrow("archive asset reference");
        expect(() =>
            makeGuideRecord(
                build([
                    section("One", [
                        block("![x](asset:" + crypto.randomUUID() + ")", { kind: "figure" }),
                    ]),
                ]),
                scope,
            ),
        ).toThrow("missing or does not belong");
    });

    it("preserves unknown block kinds only until they change", () => {
        const session = sessionRecord();
        const current = guideRecord(
            [
                {
                    heading: "One",
                    blocks: [{ kind: "future", text: "Keep", sourceIds: "", origin: "imported" }],
                },
            ],
            { session_id: session.id },
        );
        const draftFromRecord = guideDraftFromRecord(current);
        const saved = makeGuideRecord(draftFromRecord, { session, records: [session] }, current);
        expect(saved.fields.get("section.0.block.0.kind")).toBe("future");

        const changedText = guideDraftFromRecord(current);
        changedText.sections[0]!.blocks[0]!.text = "Changed";
        expect(() =>
            makeGuideRecord(changedText, { session, records: [session] }, current),
        ).toThrow("not supported");
        const changedSource = guideDraftFromRecord(current);
        changedSource.sections[0]!.blocks[0]!.sourceIds = session.id;
        expect(() =>
            makeGuideRecord(changedSource, { session, records: [session] }, current),
        ).toThrow("not supported");
        const changedStale = guideDraftFromRecord(current);
        changedStale.sections[0]!.blocks[0]!.stale = true;
        expect(() =>
            makeGuideRecord(changedStale, { session, records: [session] }, current),
        ).toThrow("not supported");
        const changedOrigin = guideDraftFromRecord(current);
        changedOrigin.sections[0]!.blocks[0]!.origin = "unknown";
        expect(() =>
            makeGuideRecord(changedOrigin, { session, records: [session] }, current),
        ).toThrow("not supported");
        const changedKindToKnown = guideDraftFromRecord(current);
        changedKindToKnown.sections[0]!.blocks[0]!.kind = "paragraph";
        expect(() =>
            makeGuideRecord(changedKindToKnown, { session, records: [session] }, current),
        ).toThrow("not supported");

        const unknownKindWithoutText = guideRecord([
            { heading: "One", blocks: [{ kind: "future", text: "Keep" }] },
        ]);
        const sameCurrent = {
            ...unknownKindWithoutText,
            fields: new Map([...unknownKindWithoutText.fields, ["session_id", session.id]]),
        };
        const sameUnknown = guideDraftFromRecord(sameCurrent);
        expect(() =>
            makeGuideRecord(sameUnknown, { session, records: [session] }, sameCurrent),
        ).not.toThrow();

        const wrongKind = guideDraftFromRecord(current);
        wrongKind.sections[0]!.blocks[0]!.kind = "another-future";
        expect(() => makeGuideRecord(wrongKind, { session, records: [session] }, current)).toThrow(
            "not supported",
        );
    });

    it("keeps section ids stable when sections move", () => {
        const session = sessionRecord();
        const current = guideRecord(
            [
                { heading: "First", id: "one", blocks: [{ kind: "paragraph", text: "One" }] },
                { heading: "Second", id: "two", blocks: [{ kind: "paragraph", text: "Two" }] },
            ],
            { session_id: session.id },
        );
        const target = guideDraftFromRecord(current);
        const reordered = {
            ...target,
            sections: [target.sections[1]!, target.sections[0]!],
        };
        const saved = makeGuideRecord(reordered, { session, records: [session] }, current);
        expect(saved.fields.get("section.0.id")).toBe("two");
        expect(saved.fields.get("section.1.id")).toBe("one");
        expect(saved.fields.get("section.0.block_count")).toBe("1");
    });
});

describe("guide journal entry links", () => {
    function entry(id: string, guideIds: string, extra: Fields = {}): ArchiveRecord {
        return makeRecord(
            RecordType.settings,
            { record_role: "journal-entry", study_guide_ids: guideIds, ...extra },
            id,
        );
    }

    it("adds, removes, and keeps entry links idempotently", () => {
        const guide = makeRecord(RecordType.guide, { entry_id: crypto.randomUUID() });
        const entryId = guide.fields.get("entry_id")!;
        const linkedEntry = entry(entryId, "");
        const linked = guideRecordsWithEntryLinks(guide, null, [linkedEntry]);
        expect(linked).toHaveLength(2);
        expect(linked[1]!.fields.get("study_guide_ids")).toBe(guide.id.toLowerCase());

        const alreadyLinked = entry(entryId, guide.id.toUpperCase());
        expect(guideRecordsWithEntryLinks(guide, null, [alreadyLinked])).toHaveLength(1);

        const deletedGuide = {
            ...guide,
            fields: new Map([...guide.fields, ["_deleted", "true"]]),
        };
        const unlinked = guideRecordsWithEntryLinks(deletedGuide, guide, [linked[1]!]);
        expect(unlinked).toHaveLength(2);
        expect(unlinked[1]!.fields.get("study_guide_ids")).toBe("");

        const missingEntry = guideRecordsWithEntryLinks(deletedGuide, guide, []);
        expect(missingEntry).toHaveLength(1);

        expect(() => guideRecordsWithEntryLinks(makeRecord(RecordType.session), null, [])).toThrow(
            "Only study guides",
        );
        expect(() => guideRecordsWithEntryLinks(guide, null, [])).toThrow(
            "Restore the source journal entry",
        );

        const previous = makeRecord(RecordType.guide, { entry_id: crypto.randomUUID() });
        const changed = makeRecord(RecordType.guide, { entry_id: entryId });
        const oldEntry = entry(previous.fields.get("entry_id")!, changed.id);
        const newEntry = entry(entryId, "");
        const changedLinks = guideRecordsWithEntryLinks(changed, previous, [oldEntry, newEntry]);
        expect(changedLinks).toHaveLength(3);
    });

    it("approves only clean guides and rejects stale or deleted guides", () => {
        expect(() => approveGuideRecord(makeRecord(RecordType.session))).toThrow(
            "Only a study guide",
        );
        expect(() =>
            approveGuideRecord(makeRecord(RecordType.guide, { _deleted: "true" })),
        ).toThrow("A guide in Trash");
        expect(() =>
            approveGuideRecord(makeRecord(RecordType.guide, { stale_block_count: "1" })),
        ).toThrow("Review every source-changed block");
        expect(() =>
            approveGuideRecord(makeRecord(RecordType.guide, { stale_block_count: "x" })),
        ).toThrow("stale guide block count is invalid");
        const approved = approveGuideRecord(makeRecord(RecordType.guide, {}));
        expect(approved.fields.get("approval_state")).toBe("approved");
        expect(approved.fields.get("approved_at_us")).toBeTruthy();
        expect(approved.fields.get("updated_at_us")).toBeTruthy();
    });
});

describe("guide source scope", () => {
    it("accepts only records linked to the selected session or entry", () => {
        const entryId = crypto.randomUUID();
        const session = sessionRecord({ entry_id: entryId, student_id: crypto.randomUUID() });
        const otherSession = sessionRecord({ entry_id: entryId });
        const notes = notesRecord({ entryId, sessionId: session.id }, [
            { id: "one", kind: "paragraph", text: "Note" },
        ]);
        const otherNotes = notesRecord({ entryId, sessionId: otherSession.id }, [
            { id: "two", kind: "paragraph", text: "Other" },
        ]);
        const deletedSession = {
            ...otherSession,
            fields: new Map([...otherSession.fields, ["_deleted", "true"]]),
        };
        const student = makeRecord(RecordType.student, {}, session.fields.get("student_id")!);
        const assetForSession = makeRecord(RecordType.assetMetadata, { session_id: session.id });
        const assetForStudent = makeRecord(RecordType.assetMetadata, {
            student_id: student.id,
        });
        const annotation = makeRecord(RecordType.annotation, { session_id: session.id });
        const unrelatedAnnotation = makeRecord(RecordType.annotation, {
            session_id: otherSession.id,
        });
        const unrelatedType = makeRecord(RecordType.aiJob, { session_id: session.id });
        const records = [
            session,
            otherSession,
            deletedSession,
            notes,
            otherNotes,
            student,
            assetForSession,
            assetForStudent,
            annotation,
            unrelatedAnnotation,
            unrelatedType,
        ];
        const scope = { session, records };

        expect(isGuideSourceInScope(session.id, scope)).toBe(true);
        expect(isGuideSourceInScope(student.id, scope)).toBe(true);
        expect(isGuideSourceInScope(annotation.id, scope)).toBe(true);
        expect(isGuideSourceInScope(assetForSession.id, scope)).toBe(true);
        expect(isGuideSourceInScope(assetForStudent.id, scope)).toBe(true);
        expect(isGuideSourceInScope(notes.id, scope)).toBe(true);
        expect(isGuideSourceInScope(otherNotes.id, scope)).toBe(false);
        expect(isGuideSourceInScope(unrelatedAnnotation.id, scope)).toBe(false);
        expect(isGuideSourceInScope(unrelatedType.id, scope)).toBe(false);
        expect(isGuideSourceInScope(crypto.randomUUID(), scope)).toBe(false);
        expect(
            isGuideSourceInScope(notes.id, {
                entry: makeRecord(RecordType.settings, { record_role: "journal-entry" }, entryId),
                records,
            }),
        ).toBe(true);
    });

    it("handles entry-scoped notes and settings records", () => {
        const entryId = crypto.randomUUID();
        const entry = makeRecord(
            RecordType.settings,
            { record_role: "journal-entry", notes_document_id: "" },
            entryId,
        );
        const session = sessionRecord({ entry_id: entryId });
        const entryNote = notesRecord({ entryId, sessionId: "" }, [
            { id: "one", kind: "paragraph", text: "Entry note" },
        ]);
        const entryWithNote = {
            ...entry,
            fields: new Map([...entry.fields, ["notes_document_id", entryNote.id]]),
        };
        const records = [entryWithNote, session, entryNote];

        expect(isGuideSourceInScope(entryNote.id, { entry: entryWithNote, records })).toBe(true);
        expect(
            isGuideSourceInScope(entryNote.id, {
                entry: makeRecord(RecordType.settings, { record_role: "journal-entry" }, entryId),
                records,
            }),
        ).toBe(false);
        expect(isGuideSourceInScope(session.id, { entry: entryWithNote, records })).toBe(true);
        expect(
            isGuideSourceInScope(makeRecord(RecordType.settings, { record_role: "other" }).id, {
                entry: entryWithNote,
                records,
            }),
        ).toBe(false);
        expect(
            isGuideSourceInScope(entryNote.id, {
                entry: makeRecord(RecordType.settings, { record_role: "other" }, entryId),
                records,
            }),
        ).toBe(false);
    });

    it("classifies unlinked sessions, settings, and entry notes by record type", () => {
        const entryId = crypto.randomUUID();
        const session = sessionRecord({ entry_id: entryId });
        const foreignSession = sessionRecord({ entry_id: crypto.randomUUID() });
        const otherSettings = makeRecord(RecordType.settings, { record_role: "other" });
        const entryNote = notesRecord({ entryId, sessionId: "" }, [
            { id: "one", kind: "paragraph", text: "Entry note" },
        ]);
        const entryNoteForOtherEntry = notesRecord(
            { entryId: crypto.randomUUID(), sessionId: "" },
            [{ id: "two", kind: "paragraph", text: "Other note" }],
        );
        const entry = makeRecord(
            RecordType.settings,
            { record_role: "journal-entry", notes_document_id: entryNote.id },
            entryId,
        );
        const records = [
            session,
            foreignSession,
            otherSettings,
            entryNote,
            entryNoteForOtherEntry,
            entry,
        ];

        expect(isGuideSourceInScope(foreignSession.id, { session, records })).toBe(false);
        expect(isGuideSourceInScope(otherSettings.id, { session, records })).toBe(false);
        expect(isGuideSourceInScope(entryNoteForOtherEntry.id, { entry, records })).toBe(false);
        expect(isGuideSourceInScope(entryNote.id, { entry, records })).toBe(true);
    });
});

describe("guide edge cases", () => {
    it("only includes another session's notes when entry evidence is requested", () => {
        const entryId = crypto.randomUUID();
        const session = sessionRecord({ entry_id: entryId, subject: "" });
        const otherSessionId = crypto.randomUUID();
        const otherNotesId = crypto.randomUUID();
        const otherSession = sessionRecord(
            { entry_id: entryId, notes_document_id: otherNotesId },
            otherSessionId,
        );
        const otherNotes = notesRecord(
            { entryId, sessionId: otherSessionId },
            [{ id: "one", kind: "paragraph", text: "Other session note." }],
            {},
            otherNotesId,
        );
        const orphanEntryNotes = notesRecord({ entryId, sessionId: "" }, [
            { id: "two", kind: "paragraph", text: "Unlinked entry note." },
        ]);
        const records = [session, otherSession, otherNotes, orphanEntryNotes];

        const excluded = generateGuideDraftFromSession(session, "general", records, []);
        expect(excluded.sections.map((item) => item.heading)).toEqual([
            "Session overview",
            "Evidence status",
        ]);
        expect(excluded.sections[0]!.blocks[0]!.text).toBe("Session: Fractions");

        const included = generateGuideDraftFromSession(
            session,
            "general",
            records,
            [],
            undefined,
            true,
        );
        expect(included.sections.map((item) => item.heading)).toContain(
            "Session notes · Fractions",
        );
    });

    it("adds tutor profile context for either profile field alone", () => {
        const onlyDifficulties = makeRecord(
            RecordType.student,
            { known_difficulties: "Denominators" },
            crypto.randomUUID(),
        );
        const difficultiesSession = sessionRecord({ student_id: onlyDifficulties.id });
        const difficultiesDraft = generateGuideDraftFromSession(
            difficultiesSession,
            "general",
            [difficultiesSession],
            [onlyDifficulties],
        );
        const difficultiesSection = difficultiesDraft.sections.find(
            (item) => item.heading === "Tutor profile context",
        )!;
        expect(difficultiesSection.blocks[0]!.text).toContain("Known difficulties: Denominators");
        expect(difficultiesSection.blocks[0]!.text).not.toContain("improvements");

        const onlyImprovements = makeRecord(
            RecordType.student,
            { demonstrated_improvements: "Scale factors" },
            crypto.randomUUID(),
        );
        const improvementsSession = sessionRecord({ student_id: onlyImprovements.id });
        const improvementsDraft = generateGuideDraftFromSession(
            improvementsSession,
            "general",
            [improvementsSession],
            [onlyImprovements],
        );
        const improvementsSection = improvementsDraft.sections.find(
            (item) => item.heading === "Tutor profile context",
        )!;
        expect(improvementsSection.blocks[0]!.text).toContain("Previously recorded improvements");
        expect(improvementsSection.blocks[0]!.text).not.toContain("Known difficulties");
    });

    it("saves entry-scoped guides with stale blocks", () => {
        const entry = makeRecord(
            RecordType.settings,
            { record_role: "journal-entry" },
            crypto.randomUUID(),
        );
        const target = draft([section("One", [block("Stale", { stale: true })])], {
            sessionId: "",
        });
        const saved = makeGuideRecord(target, { entry, records: [entry] });
        expect(saved.fields.get("session_id")).toBe("");
        expect(saved.fields.get("entry_id")).toBe(entry.id);
        expect(saved.fields.get("section.0.block.0.stale")).toBe("true");
        expect(saved.fields.get("stale_block_count")).toBe("1");

        expect(() =>
            makeGuideRecord(target, { entry, records: [entry] }, makeRecord(RecordType.session)),
        ).toThrow("Only a study guide can be updated here");
    });

    it("keeps unspecified legacy block fields unchanged", () => {
        const session = sessionRecord();
        const current = makeRecord(RecordType.guide, {
            session_id: session.id,
            title: "Legacy guide",
            section_count: "1",
            "section.0.heading": "One",
            "section.0.block_count": "1",
            "section.0.block.0.kind": "future-kind",
        });
        const target = guideDraftFromRecord(current);
        const saved = makeGuideRecord(target, { session, records: [session] }, current);
        expect(saved.fields.get("section.0.block.0.text")).toBe("");
        expect(saved.fields.get("section.0.block.0.source_ids")).toBe("");
        expect(saved.fields.get("section.0.block.0.origin")).toBe("unknown");
    });

    it("accepts inline sources that are new or already listed", () => {
        const id = crypto.randomUUID();
        const text = `See [[source:${id}]]`;
        const newSource = guideRecord([{ heading: "One", blocks: [{ kind: "paragraph", text }] }]);
        expect(() => validateGuideForExport(newSource)).not.toThrow();
        const listedSource = guideRecord([
            { heading: "One", blocks: [{ kind: "paragraph", text, sourceIds: id }] },
        ]);
        expect(() => validateGuideForExport(listedSource)).not.toThrow();
    });
});
