import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
    verifyArchiveSnapshot,
} from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function record(type: number, id: string, values: Record<string, string>): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(values)),
        blob: new Uint8Array(),
    };
}

async function validArchiveBytes(): Promise<Uint8Array> {
    const empty = await openArchiveBytes(
        await createArchiveBytes("Fuzz workspace", "Fuzz fixture"),
    );
    const sessionId = newUuid();
    const updated = await appendRecords(empty, [
        record(RecordType.session, sessionId, {
            student_id: "anonymous",
            session_state: "completed",
            title: "Fuzz session",
        }),
        record(RecordType.settings, newUuid(), {
            record_role: "journal-entry",
            title: "Fuzz entry",
            session_ids: sessionId,
        }),
    ]);
    const bytes = new Uint8Array(Number(updated.source.size));
    bytes.set(await updated.source.read(0n, bytes.byteLength));
    return bytes;
}

function mutate(bytes: Uint8Array, random: () => number): Uint8Array {
    const output = bytes.slice();
    const kind = Math.floor(random() * 5);
    if (kind === 0) {
        const index = Math.floor(random() * output.length);
        output[index] = (output[index] ?? 0) ^ (1 << Math.floor(random() * 8));
    } else if (kind === 1) {
        const start = Math.floor(random() * output.length);
        const length = Math.min(output.length - start, 1 + Math.floor(random() * 8));
        output.fill(0, start, start + length);
    } else if (kind === 2) {
        return output.slice(0, Math.max(1, Math.floor(random() * output.length)));
    } else if (kind === 3) {
        const extra = new Uint8Array(1 + Math.floor(random() * 16));
        for (const [index] of extra.entries()) extra[index] = Math.floor(random() * 256);
        const combined = new Uint8Array(output.length + extra.length);
        combined.set(output);
        combined.set(extra, output.length);
        return combined;
    } else {
        const start = Math.floor(random() * output.length);
        const length = Math.min(output.length - start, 1 + Math.floor(random() * 32));
        const copy = output.slice(start, start + length);
        const combined = new Uint8Array(output.length + copy.length);
        combined.set(output);
        combined.set(copy, output.length);
        return combined;
    }
    return output;
}

describe("archive parser adversarial robustness", () => {
    it("opens and fully verifies an unmutated fixture", async () => {
        const snapshot = await openArchiveBytes(await validArchiveBytes());
        await expect(verifyArchiveSnapshot(snapshot, { full: true })).resolves.toMatchObject({
            valid: true,
            issues: [],
        });
    });

    it("either rejects or fully verifies every deterministically mutated archive", async () => {
        const original = await validArchiveBytes();
        const random = seededRandom(0xa5c0ffee);
        let rejected = 0;
        let accepted = 0;

        for (let iteration = 0; iteration < 1_000; iteration += 1) {
            const candidate = mutate(original, random);
            try {
                const snapshot = await openArchiveBytes(candidate);
                const result = await verifyArchiveSnapshot(snapshot, { full: true });
                expect(result.valid).toBe(true);
                expect(result.issues).toEqual([]);
                accepted += 1;
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect(String(error)).not.toBe("");
                rejected += 1;
            }
        }

        expect(rejected + accepted).toBe(1_000);
        expect(rejected).toBeGreaterThan(0);
    });

    it("handles arbitrary byte streams as invalid archives without crashing", async () => {
        const random = seededRandom(0x1badb002);
        for (let iteration = 0; iteration < 500; iteration += 1) {
            const length = Math.floor(random() * 1_024);
            const candidate = new Uint8Array(length);
            for (let index = 0; index < length; index += 1)
                candidate[index] = Math.floor(random() * 256);
            try {
                const snapshot = await openArchiveBytes(candidate);
                await verifyArchiveSnapshot(snapshot, { full: true });
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
            }
        }
    });
});
