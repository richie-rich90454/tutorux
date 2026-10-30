import { ArchiveFormatError, RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const INTERNAL_ASSET_ROLES = new Set([
    "audio-track",
    "recording-take",
    "waveform-pyramid",
    "sparse-timestamp-seek-index",
    "asset-blob-manifest",
    "asset-blob-chunk",
]);

export function canChangeAssetSession(record: ArchiveRecord): boolean {
    return (
        record.type === RecordType.assetMetadata &&
        !INTERNAL_ASSET_ROLES.has(record.fields.get("record_role") ?? "")
    );
}

/** Prepare a checked metadata revision that moves a material into a session or general library. */
export async function moveAssetToSession(
    snapshot: ArchiveSnapshot,
    asset: ArchiveRecord,
    sessionId: string,
    updatedAtUs = (BigInt(Date.now()) * 1000n).toString(),
): Promise<ArchiveRecord> {
    if (!canChangeAssetSession(asset)) {
        throw new ArchiveFormatError(
            "asset_session_move_not_supported",
            "This internally managed audio or content record cannot be moved between sessions.",
        );
    }
    const latest = await snapshot.getRecord(RecordType.assetMetadata, asset.id);
    if (!latest || latest.fields.get("_deleted") === "true") {
        throw new ArchiveFormatError(
            "asset_session_move_unavailable",
            "This material is no longer available in the archive.",
        );
    }
    if (!canChangeAssetSession(latest)) {
        throw new ArchiveFormatError(
            "asset_session_move_not_supported",
            "This internally managed audio or content record cannot be moved between sessions.",
        );
    }

    const normalizedSessionId = sessionId.trim().toLowerCase();
    if (normalizedSessionId) {
        if (!UUID_PATTERN.test(normalizedSessionId)) {
            throw new ArchiveFormatError("asset_session_invalid", "Select a valid session.");
        }
        const session = await snapshot.getRecord(RecordType.session, normalizedSessionId);
        if (!session || session.fields.get("_deleted") === "true") {
            throw new ArchiveFormatError(
                "asset_session_unavailable",
                "The selected session is no longer available. Refresh the library and choose again.",
            );
        }
        await ensureSessionReferencesRemainValid(
            snapshot,
            latest.id.toLowerCase(),
            normalizedSessionId,
        );
    }

    const fields = new Map(latest.fields);
    if (normalizedSessionId) fields.set("session_id", normalizedSessionId);
    else fields.delete("session_id");
    fields.set("updated_at_us", updatedAtUs);
    return { ...latest, fields };
}

async function ensureSessionReferencesRemainValid(
    snapshot: ArchiveSnapshot,
    assetId: string,
    targetSessionId: string,
): Promise<void> {
    const referenceTypes = [
        RecordType.annotation,
        RecordType.transcriptSegment,
        RecordType.evidenceNode,
        RecordType.guide,
        RecordType.aiJob,
        RecordType.settings,
    ];
    const groups = await Promise.all(
        referenceTypes.map((type) => snapshot.listRecords(type, true)),
    );
    for (const record of groups.flat()) {
        if (
            record.fields.get("_deleted") === "true" ||
            record.fields.get("session_id")?.toLowerCase() === targetSessionId ||
            !recordReferencesAsset(record, assetId)
        ) {
            continue;
        }
        if (record.fields.get("session_id")) {
            throw new ArchiveFormatError(
                "asset_session_move_breaks_link",
                "This material is linked from another session. Remove those links before moving it into the selected session.",
            );
        }
    }
}

function recordReferencesAsset(record: ArchiveRecord, assetId: string): boolean {
    for (const [key, value] of record.fields) {
        const normalizedKey = key.toLowerCase();
        if (
            normalizedKey === "linked_asset_ids" ||
            normalizedKey === "source_asset_ids" ||
            normalizedKey === "attachment_ids" ||
            normalizedKey === "source_ids" ||
            normalizedKey.endsWith(".source_ids")
        ) {
            if (value.split(/[\s,;]+/u).some((id) => id.toLowerCase() === assetId)) return true;
            continue;
        }
        if (
            (normalizedKey.includes("text") || normalizedKey === "content") &&
            value.toLowerCase().includes(`asset:${assetId}`)
        ) {
            return true;
        }
        if (normalizedKey.includes("assets_manifest") && jsonContainsId(value, assetId))
            return true;
    }
    return false;
}

function jsonContainsId(value: string, assetId: string): boolean {
    try {
        const root: unknown = JSON.parse(value);
        const visit = (candidate: unknown): boolean => {
            if (Array.isArray(candidate)) return candidate.some(visit);
            if (candidate && typeof candidate === "object") {
                return Object.values(candidate).some(visit);
            }
            return typeof candidate === "string" && candidate.toLowerCase() === assetId;
        };
        return visit(root);
    } catch {
        return false;
    }
}
