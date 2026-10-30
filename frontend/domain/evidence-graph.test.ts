import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../archive/format";
import { createEvidenceGraphLayout } from "./evidence-graph";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function node(id: string, title: string, deleted = false): ArchiveRecord {
    return {
        type: RecordType.evidenceNode,
        id,
        revision: 1n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map([
            ["session_id", sessionId],
            ["title", title],
            ["type", "learning-outcome"],
            ["content", title],
            ["verification_state", "human-verified"],
            ...(deleted ? ([["_deleted", "true"]] as const) : []),
        ]),
    };
}

function edge(id: string, fromId: string, toId: string, relationship: string): ArchiveRecord {
    return {
        type: RecordType.evidenceEdge,
        id,
        revision: 1n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map([
            ["session_id", sessionId],
            ["from_id", fromId],
            ["to_id", toId],
            ["relationship", relationship],
        ]),
    };
}

describe("evidence graph layout", () => {
    it("lays out active session items deterministically and ignores invalid edges", () => {
        const first = node("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "First statement");
        const second = node("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Second statement");
        const hidden = node("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Deleted statement", true);
        const graph = createEvidenceGraphLayout(
            [first, second, hidden],
            [
                edge("11111111-1111-4111-8111-111111111111", first.id, second.id, "supports"),
                edge("22222222-2222-4222-8222-222222222222", first.id, second.id, "contradicts"),
                edge("33333333-3333-4333-8333-333333333333", second.id, first.id, "contradicts"),
                edge("44444444-4444-4444-8444-444444444444", first.id, hidden.id, "supports"),
                edge("55555555-5555-4555-8555-555555555555", first.id, second.id, "unknown"),
                edge("66666666-6666-4666-8666-666666666666", first.id, first.id, "supports"),
                edge(
                    "77777777-7777-4777-8777-777777777777",
                    "88888888-8888-4888-8888-888888888888",
                    second.id,
                    "supports",
                ),
            ],
        );

        expect(graph.nodes.map((position) => position.record.id)).toEqual([first.id, second.id]);
        expect(new Set(graph.nodes.map((position) => `${position.x}:${position.y}`)).size).toBe(2);
        expect(graph.width).toBeGreaterThan(0);
        expect(graph.height).toBeGreaterThan(0);
        expect(graph.edges).toHaveLength(3);
        expect(graph.edges.every((item) => item.path.startsWith("M "))).toBe(true);
        expect(graph.invalidEdgeCount).toBe(4);
        expect(graph.contradictions).toEqual([{ first, second }]);

        const repeated = createEvidenceGraphLayout(
            [first, second],
            [edge("1", first.id, second.id, "supports")],
        );
        expect(repeated.nodes.map(({ x, y }) => [x, y])).toEqual(
            graph.nodes.map(({ x, y }) => [x, y]),
        );
    });
});
