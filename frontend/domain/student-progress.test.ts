import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../archive/format";
import {
    decodeStudentProgress,
    encodeStudentProgress,
    reviewStudentProgressRecord,
    validateProgressEvidence,
    type StudentProgressItem,
} from "./student-progress";

const studentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstSessionId = "11111111-1111-4111-8111-111111111111";
const secondSessionId = "22222222-2222-4222-8222-222222222222";
const firstEvidenceId = "33333333-3333-4333-8333-333333333333";
const secondEvidenceId = "44444444-4444-4444-8444-444444444444";

function record(type: number, id: string, values: Record<string, string>): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map(Object.entries(values)),
    };
}

const student = (): ArchiveRecord => record(RecordType.student, studentId, {});
const sessions = (): ArchiveRecord[] => [
    record(RecordType.session, firstSessionId, {
        student_id: studentId,
        title: "Fractions: visual models",
    }),
    record(RecordType.session, secondSessionId, {
        student_id: studentId,
        title: "Fractions: independent practice",
    }),
];
const evidence = (secondVerification = "human-verified"): ArchiveRecord[] => [
    record(RecordType.evidenceNode, firstEvidenceId, {
        session_id: firstSessionId,
        student_id: studentId,
        title: "Builds an equivalent fraction with a model",
        content: "The learner labels matching shaded regions.",
        verification_state: "human-verified",
    }),
    record(RecordType.evidenceNode, secondEvidenceId, {
        session_id: secondSessionId,
        student_id: studentId,
        title: "Finds an equivalent fraction independently",
        content: "The learner explains the scale factor without a prompt.",
        verification_state: secondVerification,
    }),
];

describe("student progress archive compatibility", () => {
    it("encodes and decodes the C++ TP1 byte-length format with multibyte text", () => {
        const items: StudentProgressItem[] = [
            {
                skill: "Fractions 🧮",
                classification: "partial-improvement",
                note: "Half-step: ½",
                reviewedBy: "Tutor",
                reviewedAtUs: "1700000000000000",
                evidenceSourceIds: [firstEvidenceId],
            },
        ];

        const encoded = encodeStudentProgress(items);

        expect(encoded).toBe(
            `TP1;1;14:Fractions 🧮19:partial-improvement13:Half-step: ½5:Tutor16:17000000000000001;36:${firstEvidenceId}`,
        );
        expect(decodeStudentProgress(encoded)).toEqual(items);
    });

    it("treats an empty legacy field as no reviewed progress", () => {
        expect(decodeStudentProgress("")).toEqual([]);
    });

    it("rejects malformed lengths, unsupported classifications, and duplicate sources", () => {
        expect(() => decodeStudentProgress("TP1;1;999:short")).toThrow("malformed");
        const duplicateSource = `TP1;1;5:Skill14:newly-observed0:5:Tutor16:17000000000000002;2;36:${firstEvidenceId}36:${firstEvidenceId}`;
        expect(() => decodeStudentProgress(duplicateSource)).toThrow("malformed");
    });
});

describe("student progress evidence rules", () => {
    it("requires evidence from two distinct sessions for recurring progress", () => {
        expect(() =>
            validateProgressEvidence(
                studentId,
                [firstEvidenceId],
                sessions(),
                evidence(),
                "recurring",
            ),
        ).toThrow("at least two sessions");
        expect(
            validateProgressEvidence(
                studentId,
                [firstEvidenceId, secondEvidenceId],
                sessions(),
                evidence(),
                "recurring",
            ),
        ).toHaveLength(2);
    });

    it("requires every mastery source to be tutor verified", () => {
        expect(() =>
            validateProgressEvidence(
                studentId,
                [firstEvidenceId, secondEvidenceId],
                sessions(),
                evidence("needs-review"),
                "demonstrated-mastery",
            ),
        ).toThrow("human-verified");
    });

    it("rejects evidence from another student and duplicate evidence IDs", () => {
        const otherStudent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        expect(() =>
            validateProgressEvidence(
                studentId,
                [firstEvidenceId],
                [record(RecordType.session, firstSessionId, { student_id: otherStudent })],
                evidence(),
            ),
        ).toThrow("belonging to this student");
        expect(() =>
            validateProgressEvidence(
                studentId,
                [firstEvidenceId, firstEvidenceId],
                sessions(),
                evidence(),
            ),
        ).toThrow("more than once");
    });

    it("updates the matching skill while retaining one current classification", () => {
        const first = reviewStudentProgressRecord(
            student(),
            {
                skill: "Equivalent fractions",
                classification: "newly-observed",
                evidenceSourceIds: [firstEvidenceId],
                reviewedBy: "Tutor",
                note: "Uses a visual model.",
            },
            sessions(),
            evidence(),
        );
        const second = reviewStudentProgressRecord(
            first,
            {
                skill: "equivalent fractions",
                classification: "partial-improvement",
                evidenceSourceIds: [firstEvidenceId, secondEvidenceId],
                reviewedBy: "Tutor",
                note: "Now explains the scale factor.",
            },
            sessions(),
            evidence(),
        );

        const items = decodeStudentProgress(second.fields.get("progress_classifications") ?? "");
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            skill: "equivalent fractions",
            classification: "partial-improvement",
            note: "Now explains the scale factor.",
            evidenceSourceIds: [firstEvidenceId, secondEvidenceId],
        });
    });
});
