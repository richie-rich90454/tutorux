import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    canonicalizeProgressUuid,
    classificationLabel,
    decodeStudentProgress,
    encodeStudentProgress,
    isStudentProgressClassification,
    normalizeStudentProgressSkill,
    reviewStudentProgressRecord,
    STUDENT_PROGRESS_CLASSIFICATIONS,
    validateProgressEvidence,
    type StudentProgressItem,
} from "../../../frontend/domain/student-progress";

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

function encodePart(value: string): string {
    return `${new TextEncoder().encode(value).length}:${value}`;
}

function packItem(item: {
    skill: string;
    classification: string;
    note: string;
    reviewedBy: string;
    reviewedAtUs: string;
    sources: readonly string[];
}): string {
    return (
        encodePart(item.skill) +
        encodePart(item.classification) +
        encodePart(item.note) +
        encodePart(item.reviewedBy) +
        encodePart(item.reviewedAtUs) +
        `${item.sources.length};` +
        item.sources.map(encodePart).join("")
    );
}

const baseItem = {
    skill: "Skill",
    classification: "newly-observed",
    note: "",
    reviewedBy: "Tutor",
    reviewedAtUs: "1700000000000000",
    sources: [firstEvidenceId],
};

function pack(items: readonly (typeof baseItem)[]): string {
    return `TP1;${items.length};${items.map(packItem).join("")}`;
}

describe("student progress decoding edge cases", () => {
    it("round-trips canonical UUID sources", () => {
        const encoded = pack([{ ...baseItem, sources: [firstEvidenceId.toUpperCase()] }]);
        expect(decodeStudentProgress(encoded)[0]!.evidenceSourceIds).toEqual([firstEvidenceId]);
    });

    it("rejects malformed headers and counts", () => {
        for (const value of [
            "NOPE;1;",
            "TP1;",
            "TP1;;",
            "TP1;a;",
            "TP1;513;",
            "TP1;99999999999999999999;",
        ]) {
            expect(() => decodeStudentProgress(value)).toThrow("malformed");
        }
    });

    it("rejects malformed string lengths", () => {
        for (const value of [
            "TP1;1;:",
            "TP1;1;x:a",
            "TP1;1;5:abc",
            "TP1;1;257:" + "a".repeat(257),
        ]) {
            expect(() => decodeStudentProgress(value)).toThrow("malformed");
        }
    });

    it("rejects every invalid item field", () => {
        const cases: (typeof baseItem)[] = [
            { ...baseItem, skill: "" },
            { ...baseItem, skill: "a".repeat(257) },
            { ...baseItem, skill: "bad\nskill" },
            { ...baseItem, skill: "bad\tskill" },
            { ...baseItem, skill: "bad\u0001skill" },
            { ...baseItem, classification: "bogus" },
            { ...baseItem, note: "a".repeat(4_097) },
            { ...baseItem, note: "bad\u0001note" },
            { ...baseItem, reviewedBy: "" },
            { ...baseItem, reviewedBy: "a".repeat(129) },
            { ...baseItem, reviewedBy: "bad\u0001name" },
            { ...baseItem, reviewedAtUs: "abc" },
            { ...baseItem, reviewedAtUs: "0" },
            { ...baseItem, reviewedAtUs: "9223372036854775808" },
            { ...baseItem, sources: [] },
            { ...baseItem, sources: ["bad"] },
            { ...baseItem, sources: [firstEvidenceId, firstEvidenceId] },
        ];
        for (const item of cases) {
            expect(() => decodeStudentProgress(pack([item]))).toThrow("malformed");
        }
    });

    it("allows newlines and tabs in notes but rejects trailing bytes", () => {
        const item = { ...baseItem, note: "line\nnext\tcell" };
        expect(decodeStudentProgress(pack([item]))).toHaveLength(1);
        expect(() => decodeStudentProgress(pack([baseItem]) + "x")).toThrow("malformed");
    });

    it("rejects oversized progress payloads", () => {
        expect(() => decodeStudentProgress("a".repeat(4 * 1024 * 1024 + 1))).toThrow("4 MiB");
    });
});

describe("student progress encoding edge cases", () => {
    const valid: StudentProgressItem = {
        skill: "Fractions",
        classification: "newly-observed",
        note: "Note",
        reviewedBy: "Tutor",
        reviewedAtUs: "1700000000000000",
        evidenceSourceIds: [firstEvidenceId],
    };

    it("rejects too many items and invalid fields", () => {
        expect(() => encodeStudentProgress(new Array(513).fill(valid))).toThrow("512 progress");

        const cases: StudentProgressItem[] = [
            { ...valid, skill: "a".repeat(257) },
            { ...valid, skill: "\u0001" },
            { ...valid, skill: "   " },
            { ...valid, note: "a".repeat(4_097) },
            { ...valid, note: "\u0001" },
            { ...valid, reviewedBy: "a".repeat(129) },
            { ...valid, reviewedBy: "  " },
            { ...valid, classification: "bogus" as StudentProgressItem["classification"] },
            { ...valid, reviewedAtUs: "abc" },
            { ...valid, reviewedAtUs: "0" },
            { ...valid, reviewedAtUs: "9223372036854775808" },
            { ...valid, evidenceSourceIds: [] },
            {
                ...valid,
                evidenceSourceIds: new Array(65).fill(firstEvidenceId) as string[],
            },
            { ...valid, evidenceSourceIds: ["bad"] },
            { ...valid, evidenceSourceIds: [firstEvidenceId, firstEvidenceId] },
        ];
        for (const item of cases) {
            expect(() => encodeStudentProgress([item])).toThrow();
        }
    });

    it("round-trips notes with newlines and tabs", () => {
        const encoded = encodeStudentProgress([{ ...valid, note: "a\nb\tc" }]);
        expect(decodeStudentProgress(encoded)[0]!.note).toBe("a\nb\tc");
    });
});

describe("student progress validation and helpers", () => {
    it("enforces evidence selection limits", () => {
        expect(() => validateProgressEvidence(studentId, [], sessions(), evidence())).toThrow(
            "at least one",
        );
        expect(() =>
            validateProgressEvidence(
                studentId,
                new Array(65).fill(firstEvidenceId) as string[],
                sessions(),
                evidence(),
            ),
        ).toThrow("at most 64");
    });

    it("rejects invalid student and evidence identities", () => {
        expect(() =>
            validateProgressEvidence("bad", [firstEvidenceId], sessions(), evidence()),
        ).toThrow("Student ID is not a valid UUID");
        expect(() => validateProgressEvidence(studentId, ["bad"], sessions(), evidence())).toThrow(
            "invalid ID",
        );
        expect(() =>
            validateProgressEvidence(
                studentId,
                ["55555555-5555-4555-8555-555555555555"],
                sessions(),
                evidence(),
            ),
        ).toThrow("Every cited evidence item must be active");
    });

    it("rejects evidence whose session cannot be resolved", () => {
        const noSessionId = record(RecordType.evidenceNode, firstEvidenceId, {
            student_id: studentId,
        });
        expect(() =>
            validateProgressEvidence(studentId, [firstEvidenceId], sessions(), [noSessionId]),
        ).toThrow("valid session");

        const missingSession = record(RecordType.evidenceNode, firstEvidenceId, {
            session_id: "99999999-9999-4999-8999-999999999999",
            student_id: studentId,
        });
        expect(() =>
            validateProgressEvidence(studentId, [firstEvidenceId], sessions(), [missingSession]),
        ).toThrow("belonging to this student");
    });

    it("rejects evidence assigned to another student and ignores deleted records", () => {
        const otherStudent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const otherEvidence = record(RecordType.evidenceNode, firstEvidenceId, {
            session_id: firstSessionId,
            student_id: otherStudent,
        });
        expect(() =>
            validateProgressEvidence(studentId, [firstEvidenceId], sessions(), [otherEvidence]),
        ).toThrow("different student");

        const noStudent = record(RecordType.evidenceNode, firstEvidenceId, {
            session_id: firstSessionId,
        });
        expect(
            validateProgressEvidence(studentId, [firstEvidenceId], sessions(), [noStudent]),
        ).toHaveLength(1);

        const deletedEvidence = record(RecordType.evidenceNode, firstEvidenceId, {
            session_id: firstSessionId,
            student_id: studentId,
            _deleted: "true",
        });
        expect(() =>
            validateProgressEvidence(studentId, [firstEvidenceId], sessions(), [deletedEvidence]),
        ).toThrow("must be active");

        const deletedSession = record(RecordType.session, firstSessionId, {
            student_id: studentId,
            _deleted: "true",
        });
        expect(() =>
            validateProgressEvidence(studentId, [firstEvidenceId], [deletedSession], evidence()),
        ).toThrow("belonging to this student");
    });

    it("requires two sessions for partial improvement alone", () => {
        expect(() =>
            validateProgressEvidence(
                studentId,
                [firstEvidenceId],
                sessions(),
                evidence(),
                "partial-improvement",
            ),
        ).toThrow("Partial improvement requires evidence from at least two sessions");
        expect(
            validateProgressEvidence(
                studentId,
                [firstEvidenceId, secondEvidenceId],
                sessions(),
                evidence(),
                "partial-improvement",
            ),
        ).toHaveLength(2);
    });

    it("accepts demonstrated mastery from two verified sessions", () => {
        expect(
            validateProgressEvidence(
                studentId,
                [firstEvidenceId, secondEvidenceId],
                sessions(),
                evidence(),
                "demonstrated-mastery",
            ),
        ).toHaveLength(2);
    });

    it("validates the student record before reviewing", () => {
        const input = {
            skill: "Skill",
            classification: "newly-observed" as const,
            note: "",
            reviewedBy: "Tutor",
            evidenceSourceIds: [firstEvidenceId],
        };
        expect(() =>
            reviewStudentProgressRecord(
                record(RecordType.session, studentId, {}),
                input,
                sessions(),
                evidence(),
            ),
        ).toThrow("active student");
        expect(() =>
            reviewStudentProgressRecord(
                record(RecordType.student, studentId, { _deleted: "true" }),
                input,
                sessions(),
                evidence(),
            ),
        ).toThrow("active student");
        expect(() =>
            reviewStudentProgressRecord(
                student(),
                { ...input, skill: "  " },
                sessions(),
                evidence(),
            ),
        ).toThrow("Skill is required");
        expect(() =>
            reviewStudentProgressRecord(
                student(),
                { ...input, reviewedBy: "  " },
                sessions(),
                evidence(),
            ),
        ).toThrow("Reviewer is required");
        expect(() =>
            reviewStudentProgressRecord(
                student(),
                { ...input, note: "\u0001" },
                sessions(),
                evidence(),
            ),
        ).toThrow("unsupported control");
    });

    it("labels classifications and normalizes skills", () => {
        for (const classification of STUDENT_PROGRESS_CLASSIFICATIONS) {
            expect(classificationLabel(classification)).toBeTruthy();
            expect(isStudentProgressClassification(classification)).toBe(true);
        }
        expect(isStudentProgressClassification("bogus")).toBe(false);
        expect(normalizeStudentProgressSkill("  FRACTION Skills\t")).toBe("fraction skills");
        expect(canonicalizeProgressUuid(firstEvidenceId.toUpperCase().replace(/-/gu, ""))).toBe(
            firstEvidenceId,
        );
        expect(canonicalizeProgressUuid("bad")).toBeUndefined();
    });
});

describe("student progress decoding and evidence edge cases", () => {
    it("rejects a length that splits a multibyte character", () => {
        const splitCharacter = `TP1;1;1:é`;
        expect(() => decodeStudentProgress(splitCharacter)).toThrow("malformed");
    });

    it("rejects a cited session without a student assignment", () => {
        const sessionWithoutStudent = record(RecordType.session, firstSessionId, {});
        const evidenceWithoutStudent = record(RecordType.evidenceNode, firstEvidenceId, {
            session_id: firstSessionId,
        });
        expect(() =>
            validateProgressEvidence(
                studentId,
                [firstEvidenceId],
                [sessionWithoutStudent],
                [evidenceWithoutStudent],
            ),
        ).toThrow(/belonging to this student/u);
    });
});
