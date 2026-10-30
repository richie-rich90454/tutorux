import { RecordType, type ArchiveRecord } from "../archive/format";
import { EVIDENCE_RELATIONSHIPS } from "./evidence";

const GRID_COLUMNS = 4;
const CELL_WIDTH = 220;
const CELL_HEIGHT = 120;
const CARD_WIDTH = 176;
const CARD_HEIGHT = 64;
const supportedRelationships = new Set<string>(EVIDENCE_RELATIONSHIPS);

export interface EvidenceGraphNodePosition {
    readonly record: ArchiveRecord;
    readonly x: number;
    readonly y: number;
    readonly centerX: number;
    readonly centerY: number;
}

export interface EvidenceGraphEdgePath {
    readonly record: ArchiveRecord;
    readonly path: string;
    readonly labelX: number;
    readonly labelY: number;
}

export interface EvidenceContradictionPair {
    readonly first: ArchiveRecord;
    readonly second: ArchiveRecord;
}

export interface EvidenceGraphLayout {
    readonly width: number;
    readonly height: number;
    readonly nodes: readonly EvidenceGraphNodePosition[];
    readonly edges: readonly EvidenceGraphEdgePath[];
    readonly contradictions: readonly EvidenceContradictionPair[];
    readonly invalidEdgeCount: number;
}

/** Build a stable session graph and deduplicate explicitly marked contradiction pairs. */
export function createEvidenceGraphLayout(
    records: readonly ArchiveRecord[],
    edges: readonly ArchiveRecord[],
): EvidenceGraphLayout {
    const nodeRecords = new Map<string, ArchiveRecord>();
    for (const record of records) {
        if (
            record.type === RecordType.evidenceNode &&
            record.fields.get("_deleted") !== "true" &&
            !nodeRecords.has(record.id.toLowerCase())
        ) {
            nodeRecords.set(record.id.toLowerCase(), record);
        }
    }

    const columns = Math.min(GRID_COLUMNS, Math.max(1, Math.ceil(Math.sqrt(nodeRecords.size))));
    const rows = Math.max(1, Math.ceil(nodeRecords.size / columns));
    const horizontalOffset = Math.floor((GRID_COLUMNS - columns) / 2) * CELL_WIDTH;
    const positions = new Map<string, EvidenceGraphNodePosition>();
    const nodes: EvidenceGraphNodePosition[] = [];
    for (const [index, [id, record]] of [...nodeRecords.entries()].entries()) {
        const x = 20 + horizontalOffset + (index % columns) * CELL_WIDTH;
        const y = 20 + Math.floor(index / columns) * CELL_HEIGHT;
        const position = {
            record,
            x,
            y,
            centerX: x + CARD_WIDTH / 2,
            centerY: y + CARD_HEIGHT / 2,
        };
        positions.set(id, position);
        nodes.push(position);
    }

    let invalidEdgeCount = 0;
    const validEdges: ArchiveRecord[] = [];
    for (const edge of edges) {
        if (edge.type !== RecordType.evidenceEdge || edge.fields.get("_deleted") === "true")
            continue;
        const from = positions.get(edge.fields.get("from_id")?.toLowerCase() ?? "");
        const to = positions.get(edge.fields.get("to_id")?.toLowerCase() ?? "");
        const relationship = edge.fields.get("relationship")?.toLowerCase() ?? "";
        // Older CLI-created edges omit session_id. Resolve their scope from both
        // endpoints while still rejecting cross-session or conflicting records.
        const declaredSessionId = edge.fields.get("session_id")?.toLowerCase() ?? "";
        const sourceSessionId = from?.record.fields.get("session_id")?.toLowerCase() ?? "";
        const targetSessionId = to?.record.fields.get("session_id")?.toLowerCase() ?? "";
        const sessionId = declaredSessionId || sourceSessionId;
        if (
            !from ||
            !to ||
            from.record.id.toLowerCase() === to.record.id.toLowerCase() ||
            !sessionId ||
            sessionId !== sourceSessionId ||
            sessionId !== targetSessionId ||
            !supportedRelationships.has(relationship)
        ) {
            invalidEdgeCount += 1;
            continue;
        }
        validEdges.push(edge);
    }

    const edgesWithPaths = validEdges.map((record, index) => {
        const from = positions.get(record.fields.get("from_id")!.toLowerCase())!;
        const to = positions.get(record.fields.get("to_id")!.toLowerCase())!;
        return { record, ...curveBetween(from, to, index) };
    });
    const contradictionKeys = new Set<string>();
    const contradictions: EvidenceContradictionPair[] = [];
    for (const edge of validEdges) {
        if (edge.fields.get("relationship")?.toLowerCase() !== "contradicts") continue;
        const fromId = edge.fields.get("from_id")!.toLowerCase();
        const toId = edge.fields.get("to_id")!.toLowerCase();
        const [firstId, secondId] = fromId < toId ? [fromId, toId] : [toId, fromId];
        const key = `${firstId}:${secondId}`;
        if (contradictionKeys.has(key)) continue;
        contradictionKeys.add(key);
        contradictions.push({
            first: positions.get(firstId)!.record,
            second: positions.get(secondId)!.record,
        });
    }
    contradictions.sort(
        (left, right) =>
            left.first.id.localeCompare(right.first.id) ||
            left.second.id.localeCompare(right.second.id),
    );

    return {
        width: GRID_COLUMNS * CELL_WIDTH + 40,
        height: rows * CELL_HEIGHT + 40,
        nodes,
        edges: edgesWithPaths,
        contradictions,
        invalidEdgeCount,
    };
}

function curveBetween(
    from: EvidenceGraphNodePosition,
    to: EvidenceGraphNodePosition,
    index: number,
): Pick<EvidenceGraphEdgePath, "path" | "labelX" | "labelY"> {
    const deltaX = to.centerX - from.centerX;
    const deltaY = to.centerY - from.centerY;
    const length = Math.hypot(deltaX, deltaY) || 1;
    const boundaryScale =
        1 / Math.max(Math.abs(deltaX) / (CARD_WIDTH / 2), Math.abs(deltaY) / (CARD_HEIGHT / 2));
    const startX = from.centerX + deltaX * boundaryScale;
    const startY = from.centerY + deltaY * boundaryScale;
    const endX = to.centerX - deltaX * boundaryScale;
    const endY = to.centerY - deltaY * boundaryScale;
    const bend = (index % 2 === 0 ? 1 : -1) * (16 + Math.floor(index / 2) * 5);
    const controlX = (startX + endX) / 2 - (deltaY / length) * bend;
    const controlY = (startY + endY) / 2 + (deltaX / length) * bend;
    return {
        path: `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`,
        labelX: (startX + 2 * controlX + endX) / 4,
        labelY: (startY + 2 * controlY + endY) / 4,
    };
}
