import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
} from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { makeAssetImport } from "../../../frontend/domain/assets";
import { makeCustomGuideTemplateRecord } from "../../../frontend/domain/templates";
import { encodeStudentProgress } from "../../../frontend/domain/student-progress";
import {
    aiPackageText,
    createAiPackageRecord,
    isAiImageAttachmentCandidate,
    parseAiImageAttachmentManifest,
} from "../../../frontend/ai/package";

function record(type: number, id: string, fields: Record<string, string>): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

async function archiveWith(records: readonly ArchiveRecord[]) {
    const initial = await openArchiveBytes(await createArchiveBytes("AI package fixtures"));
    return appendRecords(initial, records);
}

describe("manual AI package preparation", () => {
    it("keeps private tutor notes out and includes only session-linked context", async () => {
        const sessionId = newUuid();
        const studentId = newUuid();
        const transcriptId = newUuid();
        const annotationId = newUuid();
        const evidenceId = newUuid();
        const assetId = newUuid();
        const privateTutorNote = "Private tutor note: ask about home situation.";
        const rawAssetBytes = "raw material bytes stay in the archive";
        const asset = record(RecordType.assetMetadata, assetId, {
            session_id: sessionId,
            filename: "worksheet.pdf",
            mime_type: "application/pdf",
            record_role: "material",
        });
        asset.blob = new TextEncoder().encode(rawAssetBytes);
        const archive = await archiveWith([
            record(RecordType.student, studentId, {
                display_name: "Mina",
                preferred_guide_template: "mathematics",
                known_difficulties: "Equivalent fractions",
                demonstrated_improvements: "Explained the scale factor",
                tutor_notes: privateTutorNote,
            }),
            record(RecordType.session, sessionId, {
                student_id: studentId,
                subject: "Mathematics",
                title: "Equivalent fractions",
                objectives: "Compare unlike denominators",
            }),
            record(RecordType.transcriptSegment, transcriptId, {
                session_id: sessionId,
                text: "The numerator and denominator need the same multiplier.",
            }),
            record(RecordType.annotation, annotationId, {
                session_id: sessionId,
                title: "Good explanation",
                content: "Mina used a visual model.",
            }),
            record(RecordType.evidenceNode, evidenceId, {
                session_id: sessionId,
                student_id: studentId,
                title: "Used a visual model",
                content: "Mina accurately compared two equivalent fractions.",
            }),
            asset,
            record(RecordType.assetMetadata, newUuid(), {
                session_id: sessionId,
                record_role: "asset-blob-chunk",
                blob_id: newUuid(),
            }),
            record(RecordType.transcriptSegment, newUuid(), {
                session_id: newUuid(),
                text: "A different lesson is not included.",
            }),
        ]);

        const prepared = await createAiPackageRecord(archive, sessionId);
        const json = JSON.parse(aiPackageText(prepared.job)) as Record<string, unknown>;
        const student = json["student_progress"] as Record<string, unknown>;

        expect(prepared.guideTemplateId).toBe("mathematics");
        expect(prepared.transcriptCount).toBe(1);
        expect(prepared.annotationCount).toBe(1);
        expect(prepared.evidenceCount).toBe(1);
        expect(prepared.assetCount).toBe(1);
        expect(student["progress_classifications"] as unknown[]).toEqual([]);
        expect(JSON.stringify(json)).not.toContain(privateTutorNote);
        expect(JSON.stringify(json)).not.toContain(rawAssetBytes);
        expect(JSON.stringify(json)).not.toContain("A different lesson");
        expect(JSON.stringify(json)).not.toContain("asset-blob-chunk");
        expect(prepared.job.fields.get("mode")).toBe("manual");
        expect(prepared.job.fields.get("status")).toBe("package-ready");
        expect(prepared.job.fields.get("content_hash")).toMatch(/^[\da-f]{64}$/u);
        expect(prepared.job.fields.get("content_hash")).toBe(
            prepared.job.fields.get("export_hash"),
        );
        const hashInput = new Uint8Array(prepared.job.blob.byteLength);
        hashInput.set(prepared.job.blob);
        const digest = await crypto.subtle.digest("SHA-256", hashInput);
        const actualHash = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
        expect(prepared.job.fields.get("content_hash")).toBe(actualHash);
    });

    it("records explicitly selected image attachments without copying their bytes into the package", async () => {
        const sessionId = newUuid();
        const rawImageBytes = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
        ]);
        const initial = await archiveWith([
            record(RecordType.session, sessionId, { subject: "Science", student_id: "anonymous" }),
        ]);
        const imported = await makeAssetImport(
            initial,
            {
                name: "leaf-cell.png",
                size: rawImageBytes.byteLength,
                readBytes: async () => rawImageBytes.slice(),
            },
            sessionId,
        );
        const archive = await appendRecords(initial, imported.records);
        const prepared = await createAiPackageRecord(archive, sessionId, "auto", [
            imported.metadata.id,
        ]);
        const json = JSON.parse(aiPackageText(prepared.job)) as {
            manifest: { attached_image_ids: string[] };
            attached_images: {
                id: string;
                filename: string;
                mime_type: string;
                byte_size: number;
            }[];
        };

        expect(prepared.attachedImages).toHaveLength(1);
        expect(json.manifest.attached_image_ids).toEqual([imported.metadata.id]);
        expect(json.attached_images).toEqual([
            {
                id: imported.metadata.id,
                filename: "leaf-cell.png",
                mime_type: "image/png",
                content_hash: imported.metadata.fields.get("content_hash"),
                byte_size: rawImageBytes.byteLength,
            },
        ]);
        expect(aiPackageText(prepared.job)).not.toContain("iVBORw");
    });

    it("rejects image selections outside the current session and unsupported file types", async () => {
        const sessionId = newUuid();
        const otherSessionId = newUuid();
        const pdf = record(RecordType.assetMetadata, newUuid(), {
            session_id: sessionId,
            filename: "handout.pdf",
            mime_type: "application/pdf",
            byte_size: "100",
            content_hash: "a".repeat(64),
        });
        const otherImage = record(RecordType.assetMetadata, newUuid(), {
            session_id: otherSessionId,
            filename: "other.png",
            mime_type: "image/png",
            byte_size: "10",
            content_hash: "b".repeat(64),
        });
        const archive = await archiveWith([
            record(RecordType.session, sessionId, { subject: "Science", student_id: "anonymous" }),
            pdf,
            otherImage,
        ]);

        await expect(createAiPackageRecord(archive, sessionId, "auto", [pdf.id])).rejects.toThrow(
            "Choose PNG, JPEG, or WebP images",
        );
        await expect(
            createAiPackageRecord(archive, sessionId, "auto", [otherImage.id]),
        ).rejects.toThrow("no longer available in this session");
    });

    it("keeps reviewed progress citations explicit and adds validated cross-session evidence", async () => {
        const sessionId = newUuid();
        const otherSessionId = newUuid();
        const studentId = newUuid();
        const localEvidenceId = newUuid();
        const previousEvidenceId = newUuid();
        const student = record(RecordType.student, studentId, {
            display_name: "Mina",
            progress_classifications: encodeStudentProgress([
                {
                    skill: "Equivalent fractions",
                    classification: "recurring",
                    note: "Consistent across two lessons.",
                    reviewedBy: "Tutor",
                    reviewedAtUs: "100",
                    evidenceSourceIds: [localEvidenceId, previousEvidenceId],
                },
            ]),
        });
        const archive = await archiveWith([
            student,
            record(RecordType.session, sessionId, { student_id: studentId, subject: "Math" }),
            record(RecordType.session, otherSessionId, { student_id: studentId, subject: "Math" }),
            record(RecordType.evidenceNode, localEvidenceId, {
                session_id: sessionId,
                student_id: studentId,
                title: "Current evidence",
            }),
            record(RecordType.evidenceNode, previousEvidenceId, {
                session_id: otherSessionId,
                student_id: studentId,
                title: "Earlier evidence",
            }),
        ]);

        const prepared = await createAiPackageRecord(archive, sessionId);
        const json = JSON.parse(aiPackageText(prepared.job)) as {
            student_progress: { progress_classifications: Record<string, string>[] };
            evidence: { id: string }[];
        };

        expect(json.student_progress.progress_classifications[0]).toMatchObject({
            source_validation: "passed",
            evidence_session_ids: [sessionId, otherSessionId].sort().join(","),
            claim_label: "Human-reviewed classification",
        });
        expect(json.evidence.map((item) => item.id).sort()).toEqual(
            [localEvidenceId, previousEvidenceId].sort(),
        );
    });

    it("uses custom templates by ID and rejects unknown explicit selections", async () => {
        const sessionId = newUuid();
        const template = makeCustomGuideTemplateRecord({
            name: "Short reflection",
            subject: "Math",
            description: "A concise review.",
            sections: ["Evidence", "Practice"],
            body: "Keep claims source-backed.",
        });
        const archive = await archiveWith([
            template,
            record(RecordType.session, sessionId, { subject: "Math", student_id: "anonymous" }),
        ]);

        const prepared = await createAiPackageRecord(archive, sessionId, template.id);
        expect(prepared.guideTemplateId).toBe(template.id);
        expect(prepared.guideTemplateName).toBe("Short reflection");
        await expect(createAiPackageRecord(archive, sessionId, "missing-template")).rejects.toThrow(
            "Choose a built-in or active custom guide template",
        );
    });

    it("honors a saved built-in template override when resolving the automatic structure", async () => {
        const sessionId = newUuid();
        const override = record(RecordType.settings, newUuid(), {
            record_role: "guide-template",
            builtin_template_id: "mathematics",
            name: "Tutor's mathematics review",
            sections: "Evidence\nPractice",
            body: "Keep every worked solution tied to evidence.",
        });
        const archive = await archiveWith([
            override,
            record(RecordType.session, sessionId, {
                subject: "Mathematics",
                student_id: "anonymous",
            }),
        ]);

        const prepared = await createAiPackageRecord(archive, sessionId, "auto");
        const json = JSON.parse(aiPackageText(prepared.job)) as {
            guide_template: { name: string; section_order: { heading: string }[] };
        };

        expect(prepared.guideTemplateId).toBe("mathematics");
        expect(json.guide_template.name).toBe("Tutor's mathematics review");
        expect(json.guide_template.section_order.map((section) => section.heading)).toEqual([
            "Evidence",
            "Practice",
        ]);
    });

    it("rejects oversized packages before they can be stored or exported", async () => {
        const sessionId = newUuid();
        const archive = await archiveWith([
            record(RecordType.session, sessionId, { subject: "Writing", student_id: "anonymous" }),
            record(RecordType.transcriptSegment, newUuid(), {
                session_id: sessionId,
                text: "x".repeat(8 * 1024 * 1024),
            }),
        ]);

        await expect(createAiPackageRecord(archive, sessionId)).rejects.toThrow(
            "8 MiB AI package limit",
        );
    });

    it("requires an active session", async () => {
        const sessionId = newUuid();
        const archive = await archiveWith([
            record(RecordType.session, sessionId, {
                subject: "Math",
                student_id: "anonymous",
                _deleted: "true",
            }),
        ]);
        await expect(createAiPackageRecord(archive, sessionId)).rejects.toThrow(
            "Choose an active session before preparing an AI package.",
        );
        await expect(createAiPackageRecord(archive, newUuid())).rejects.toThrow(
            "Choose an active session before preparing an AI package.",
        );
    });

    it("rejects more than eight selected images", async () => {
        const sessionId = newUuid();
        const archive = await archiveWith([
            record(RecordType.session, sessionId, { subject: "Math", student_id: "anonymous" }),
        ]);
        await expect(
            createAiPackageRecord(
                archive,
                sessionId,
                "auto",
                Array.from({ length: 9 }, () => newUuid()),
            ),
        ).rejects.toThrow("AI requests can include at most 8 images.");
    });

    it("rejects invalid and duplicate selected image ids", async () => {
        const sessionId = newUuid();
        const archive = await archiveWith([
            record(RecordType.session, sessionId, { subject: "Math", student_id: "anonymous" }),
        ]);
        await expect(
            createAiPackageRecord(archive, sessionId, "auto", ["not-a-uuid"]),
        ).rejects.toThrow("Choose valid, unique image materials for the AI request.");
        const id = newUuid();
        await expect(createAiPackageRecord(archive, sessionId, "auto", [id, id])).rejects.toThrow(
            "Choose valid, unique image materials for the AI request.",
        );
    });

    it("rejects image selections that exceed the total byte budget", async () => {
        const sessionId = newUuid();
        const image = () =>
            record(RecordType.assetMetadata, newUuid(), {
                session_id: sessionId,
                filename: "page.png",
                mime_type: "image/png",
                byte_size: String(2 * 1024 * 1024),
                content_hash: "a".repeat(64),
                blob_id: newUuid(),
            });
        const images = [image(), image(), image()];
        const archive = await archiveWith([
            record(RecordType.session, sessionId, { subject: "Math", student_id: "anonymous" }),
            ...images,
        ]);
        await expect(
            createAiPackageRecord(
                archive,
                sessionId,
                "auto",
                images.map((image) => image.id),
            ),
        ).rejects.toThrow("AI image attachments cannot exceed 4 MiB total.");
    });

    it("rejects non-JSON AI job exports", () => {
        expect(() =>
            aiPackageText(record(RecordType.guide, newUuid(), { format: "json" })),
        ).toThrow("Select a JSON AI package job.");
        expect(() =>
            aiPackageText(record(RecordType.aiJob, newUuid(), { format: "markdown" })),
        ).toThrow("Select a JSON AI package job.");
    });

    it("resolves templates by name and tolerates empty built-in overrides", async () => {
        const sessionId = newUuid();
        const template = makeCustomGuideTemplateRecord({
            name: "Short reflection",
            subject: "Math",
            description: "A concise review.",
            sections: ["Evidence"],
            body: "Keep claims source-backed.",
        });
        const override = record(RecordType.settings, newUuid(), {
            record_role: "guide-template",
            builtin_template_id: "mathematics",
        });
        const archive = await archiveWith([
            template,
            override,
            record(RecordType.session, sessionId, {
                subject: "Mathematics",
                student_id: "anonymous",
            }),
        ]);

        const byName = await createAiPackageRecord(archive, sessionId, "Short reflection");
        expect(byName.guideTemplateId).toBe(template.id);

        const prepared = await createAiPackageRecord(archive, sessionId, "auto");
        const json = JSON.parse(aiPackageText(prepared.job)) as {
            guide_template: {
                name: string;
                subject: string;
                description: string;
                section_order: { heading: string }[];
                editorial_guidance: string;
            };
        };
        expect(json.guide_template.name).toBe("Mathematics");
        expect(json.guide_template.section_order.length).toBeGreaterThan(0);
        expect(json.guide_template.editorial_guidance.length).toBeGreaterThan(0);
    });

    it("marks unverified and invalid progress classifications", async () => {
        const sessionId = newUuid();
        const studentId = newUuid();
        const student = record(RecordType.student, studentId, {
            display_name: "Mina",
            progress_classifications: encodeStudentProgress([
                {
                    skill: "Fractions",
                    classification: "unverified-improvement",
                    note: "Tutor impression.",
                    reviewedBy: "Tutor",
                    reviewedAtUs: "1",
                    evidenceSourceIds: [newUuid()],
                },
                {
                    skill: "Decimals",
                    classification: "recurring",
                    note: "Cited missing evidence.",
                    reviewedBy: "Tutor",
                    reviewedAtUs: "2",
                    evidenceSourceIds: [newUuid()],
                },
            ]),
        });
        const archive = await archiveWith([
            student,
            record(RecordType.session, sessionId, { student_id: studentId, subject: "Math" }),
        ]);

        const prepared = await createAiPackageRecord(archive, sessionId);
        const json = JSON.parse(aiPackageText(prepared.job)) as {
            student_progress: {
                progress_classifications: {
                    claim_label: string;
                    source_validation: string;
                }[];
                associated: boolean;
            };
        };
        expect(json.student_progress.associated).toBe(true);
        expect(json.student_progress.progress_classifications[0]).toMatchObject({
            claim_label: "UNVERIFIED CLAIM: improvement is not established",
            source_validation: "failed",
        });
        expect(json.student_progress.progress_classifications[1]).toMatchObject({
            claim_label: "UNVERIFIED CLAIM: improvement is not established",
            source_validation: "failed",
        });
    });

    it("ignores a linked student record that was moved to Trash", async () => {
        const sessionId = newUuid();
        const studentId = newUuid();
        const archive = await archiveWith([
            record(RecordType.student, studentId, {
                _deleted: "true",
                display_name: "Mina",
                preferred_guide_template: "science",
            }),
            record(RecordType.session, sessionId, {
                subject: "Mathematics",
                student_id: studentId,
            }),
        ]);

        const prepared = await createAiPackageRecord(archive, sessionId);
        const json = JSON.parse(aiPackageText(prepared.job)) as {
            student_progress: { associated: boolean; progress_classifications: unknown[] };
        };

        expect(prepared.guideTemplateId).toBe("mathematics");
        expect(json.student_progress).toEqual({
            associated: false,
            progress_classifications: [],
        });
    });
});

describe("AI image attachment manifests", () => {
    const image = (overrides: Record<string, unknown> = {}) => ({
        id: newUuid(),
        filename: "photo.png",
        mime_type: "image/png",
        content_hash: "a".repeat(64),
        byte_size: 10,
        ...overrides,
    });

    it("parses valid manifests and treats a missing list as empty", () => {
        expect(parseAiImageAttachmentManifest({})).toEqual([]);
        expect(parseAiImageAttachmentManifest({ attached_images: [image()] })).toHaveLength(1);
    });

    it("rejects invalid manifest containers and entries", () => {
        for (const value of [null, [], 5, "x"]) {
            expect(() => parseAiImageAttachmentManifest(value)).toThrow(
                "The AI image attachment manifest is invalid.",
            );
        }
        expect(() => parseAiImageAttachmentManifest({ attached_images: "x" })).toThrow(
            "The AI image attachment manifest is invalid.",
        );
        expect(() =>
            parseAiImageAttachmentManifest({
                attached_images: Array.from({ length: 9 }, () => image()),
            }),
        ).toThrow("AI requests can include at most 8 images.");
        expect(() => parseAiImageAttachmentManifest({ attached_images: [5] })).toThrow(
            "The AI image attachment manifest is invalid.",
        );

        const invalidEntries = [
            image({ id: "bad" }),
            image({ filename: "" }),
            image({ filename: 5 }),
            image({ mime_type: "text/plain" }),
            image({ mime_type: 5 }),
            image({ content_hash: "short" }),
            image({ content_hash: 5 }),
            image({ byte_size: "10" }),
            image({ byte_size: 1.5 }),
            image({ byte_size: 0 }),
            image({ byte_size: 2 * 1024 * 1024 + 1 }),
        ];
        for (const entry of invalidEntries) {
            expect(() => parseAiImageAttachmentManifest({ attached_images: [entry] })).toThrow(
                "The AI image attachment manifest is invalid.",
            );
        }
    });

    it("rejects duplicate images and totals above four MiB", () => {
        const id = newUuid();
        expect(() =>
            parseAiImageAttachmentManifest({ attached_images: [image({ id }), image({ id })] }),
        ).toThrow("The AI image attachment manifest contains duplicate files.");

        const large = () => image({ byte_size: 2 * 1024 * 1024 });
        expect(() =>
            parseAiImageAttachmentManifest({ attached_images: [large(), large(), large()] }),
        ).toThrow("AI image attachments exceed the 4 MiB total limit.");
    });

    it("classifies image attachment candidates", () => {
        const candidate = (
            fields: Record<string, string>,
            type: number = RecordType.assetMetadata,
        ) => record(type, newUuid(), fields);
        const valid = {
            filename: "photo.png",
            mime_type: "image/png",
            byte_size: "10",
            content_hash: "a".repeat(64),
            blob_id: newUuid(),
        };
        expect(isAiImageAttachmentCandidate(candidate(valid))).toBe(true);
        expect(isAiImageAttachmentCandidate(candidate(valid, RecordType.guide))).toBe(false);
        expect(isAiImageAttachmentCandidate(candidate({ ...valid, _deleted: "true" }))).toBe(false);
        expect(
            isAiImageAttachmentCandidate(candidate({ ...valid, record_role: "waveform-pyramid" })),
        ).toBe(false);
        expect(isAiImageAttachmentCandidate(candidate({ ...valid, mime_type: "text/plain" }))).toBe(
            false,
        );
        expect(isAiImageAttachmentCandidate(candidate({ ...valid, byte_size: "0" }))).toBe(false);
        expect(isAiImageAttachmentCandidate(candidate({ ...valid, filename: "  " }))).toBe(false);
        expect(isAiImageAttachmentCandidate(candidate({ ...valid, content_hash: "short" }))).toBe(
            false,
        );
        expect(isAiImageAttachmentCandidate(candidate({ ...valid, blob_id: "" }))).toBe(false);
        expect(isAiImageAttachmentCandidate(candidate({ filename: "photo.png" }))).toBe(false);
    });
});
