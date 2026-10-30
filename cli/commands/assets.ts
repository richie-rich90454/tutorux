import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ArchiveFormatError, RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { type ArchiveSnapshot } from "../../frontend/archive/archive";
import { appendCliAssetFile, exportCliAssetAtomically } from "../assets-stream";
import { iterateVerifiedAssetChunks } from "../../frontend/domain/assets";
import { closeSnapshot, mutateArchive, openForCommand, writeSourceAtomically } from "./archive-io";
import {
    ASSET_IMPORT_BATCH_BYTES,
    ASSET_IMPORT_BATCH_FILES,
    CliError,
    emit,
    field,
    parseBoundedOption,
    requiredOption,
    requiredPosition,
    sameFileIdentity,
    timestampNow,
} from "./shared";
import {
    getLiveRecordAtPath,
    getRecordAtPath,
    requireLiveRecord,
    toPlainRecord,
} from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runAssetCommand(
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    const json = args.flags.has("json");
    if (action === "import" || action === "add" || action === "import-folder") {
        const singleImport = action === "import" || action === "add";
        let inputPaths: string[];
        if (singleImport) {
            const inputValue =
                action === "add"
                    ? args.positionals[0]
                    : (args.options.get("input") ?? args.positionals[0]);
            if (!inputValue) {
                throw new CliError(
                    action === "add" ? "Source file is required." : "--input is required.",
                );
            }
            inputPaths = [resolve(inputValue)];
        } else {
            const inputDirectory = resolve(requiredPosition(args, 0, "source directory"));
            const directoryInfo = await stat(inputDirectory);
            if (!directoryInfo.isDirectory()) {
                throw new CliError("Import source must be a directory.");
            }
            const entries = await readdir(inputDirectory, { withFileTypes: true });
            inputPaths = [];
            for (const entry of entries) {
                const entryPath = join(inputDirectory, entry.name);
                const fileInfo = await lstat(entryPath);
                if (fileInfo.isFile() && !fileInfo.isSymbolicLink()) inputPaths.push(entryPath);
                if (inputPaths.length > 10_000) {
                    throw new CliError("Folder import is limited to 10,000 regular files.");
                }
            }
            inputPaths.sort((left, right) => {
                const leftName = basename(left);
                const rightName = basename(right);
                return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
            });
        }
        const sessionId = args.options.get("session") ?? "";
        const captureSource = args.options.get("capture-source");
        if (captureSource !== undefined && captureSource !== "browser-microphone") {
            throw new CliError("Captured assets support the browser-microphone source label.");
        }
        if (captureSource && !args.flags.has("consent")) {
            throw new CliError(
                "Confirm microphone recording consent with --consent before importing a browser capture.",
            );
        }
        if (captureSource && !sessionId) {
            throw new CliError("A browser microphone capture must be associated with a session.");
        }
        let captureConsentAtUs: string | undefined;
        if (args.options.has("capture-consent-at-us")) {
            const rawConsentTime = args.options.get("capture-consent-at-us") ?? "";
            if (!captureSource || !/^\d+$/u.test(rawConsentTime)) {
                throw new CliError(
                    "Capture consent time requires a valid browser microphone source.",
                );
            }
            const parsedConsentTime = BigInt(rawConsentTime);
            if (parsedConsentTime <= 0n || parsedConsentTime > 18_446_744_073_709_551_615n) {
                throw new CliError(
                    "Capture consent time requires a valid browser microphone source.",
                );
            }
            captureConsentAtUs = parsedConsentTime.toString();
        }
        const importedAssets: Array<{
            readonly metadata: ArchiveRecord;
            readonly deduplicated: boolean;
            readonly chunkCount: number;
        }> = [];
        let snapshot: ArchiveSnapshot | undefined;
        let staged: ArchiveSnapshot | undefined;
        let pendingBytes = 0;
        let pendingFiles = 0;
        const flushBatch = async (): Promise<void> => {
            const base = snapshot;
            const current = staged;
            if (!base || !current || current === base) return;
            await writeSourceAtomically(resolve(path), current);
            base.lock();
            current.lock();
            await current.source.close?.();
            snapshot = undefined;
            staged = undefined;
            snapshot = await openForCommand(path);
            staged = snapshot;
            pendingBytes = 0;
            pendingFiles = 0;
        };

        try {
            snapshot = await openForCommand(path);
            staged = snapshot;
            if (sessionId) await requireLiveRecord(snapshot, RecordType.session, sessionId);
            for (const inputPath of inputPaths) {
                const current = staged;
                if (!current) throw new Error("The archive snapshot could not be opened.");
                const imported = await appendCliAssetFile(
                    current,
                    path,
                    inputPath,
                    sessionId,
                    captureSource
                        ? (record) => {
                              const metadataFields = new Map(record.fields);
                              const mimeType = field(record, "mime_type");
                              const browserWebmAudio =
                                  mimeType === "video/webm" &&
                                  inputPath.toLowerCase().endsWith(".webm");
                              if (!mimeType.startsWith("audio/") && !browserWebmAudio) {
                                  throw new CliError(
                                      "A browser microphone capture must contain a recognized audio file.",
                                  );
                              }
                              if (browserWebmAudio) metadataFields.set("mime_type", "audio/webm");
                              metadataFields.set("capture_source", captureSource);
                              metadataFields.set(
                                  "capture_consent_at_us",
                                  captureConsentAtUs ?? timestampNow(),
                              );
                              metadataFields.set("capture_consent_policy", "1");
                              return { ...record, fields: metadataFields };
                          }
                        : undefined,
                );
                const next = imported.snapshot;
                staged = next;
                current.lock();
                const saved = await next.getRecord(RecordType.assetMetadata, imported.metadata.id);
                importedAssets.push({
                    metadata: saved ?? imported.metadata,
                    deduplicated: imported.deduplicated,
                    chunkCount: imported.chunkCount,
                });
                if (!imported.deduplicated)
                    pendingBytes += Number(field(imported.metadata, "byte_size"));
                pendingFiles += 1;
                if (
                    pendingBytes >= ASSET_IMPORT_BATCH_BYTES ||
                    pendingFiles >= ASSET_IMPORT_BATCH_FILES
                )
                    await flushBatch();
            }
            await flushBatch();
        } finally {
            const base = snapshot;
            const current = staged;
            if (base && current && base !== current) {
                base.lock();
                current.lock();
                await current.source.close?.();
            } else if (base) {
                await closeSnapshot(base);
            }
        }
        const rows = importedAssets.map(({ metadata }) => toPlainRecord(metadata));
        emit(
            output,
            rows,
            singleImport
                ? `${field(importedAssets[0]!.metadata, "filename") || "Material"} imported${importedAssets[0]!.deduplicated ? " (content deduplicated)" : ""}.`
                : `Imported ${rows.length} asset${rows.length === 1 ? "" : "s"} into the archive.`,
            json,
        );
        return 0;
    }

    if (action === "list") {
        const snapshot = await openForCommand(path);
        try {
            const records = await snapshot.listRecords(
                RecordType.assetMetadata,
                args.flags.has("include-deleted"),
            );
            const sessionId = args.options.get("session")?.toLowerCase();
            const internalRoles = new Set([
                "audio-track",
                "recording-take",
                "waveform-pyramid",
                "sparse-timestamp-seek-index",
                "asset-blob-manifest",
                "asset-blob-chunk",
            ]);
            const rows = records
                .filter((record) => !internalRoles.has(field(record, "record_role")))
                .filter(
                    (record) =>
                        sessionId === undefined || field(record, "session_id") === sessionId,
                )
                .map(toPlainRecord);
            emit(
                output,
                rows,
                rows.length === 0
                    ? "No materials."
                    : `${rows.length} material${rows.length === 1 ? "" : "s"}.`,
                json,
            );
            return 0;
        } finally {
            await closeSnapshot(snapshot);
        }
    }

    if (action === "show" || action === "preview") {
        const id = requiredPosition(args, 0, "material ID");
        const record = await getLiveRecordAtPath(path, RecordType.assetMetadata, id);
        emit(output, toPlainRecord(record), `Material ${id}.`, json);
        return 0;
    }

    if (action === "restore" && args.flags.has("revision"))
        throw new CliError("--revision requires a history index.");
    if (
        action === "update" ||
        action === "history" ||
        (action === "restore" && args.options.has("revision"))
    ) {
        const id = requiredPosition(args, 0, "material ID").toLowerCase();
        const snapshot = await openForCommand(path);
        const generation = snapshot.commit.generation;
        let changed: ArchiveRecord | undefined;
        let historyRows: ArchiveRecord[] = [];
        let restoredIndex: number | undefined;
        try {
            const current = await requireLiveRecord(snapshot, RecordType.assetMetadata, id);
            if (
                [
                    "audio-track",
                    "recording-take",
                    "waveform-pyramid",
                    "sparse-timestamp-seek-index",
                    "asset-blob-manifest",
                    "asset-blob-chunk",
                ].includes(field(current, "record_role"))
            )
                throw new CliError(
                    "Choose a material, rather than an internal recording or asset record.",
                );
            if (action === "history") {
                historyRows = await snapshot.getRecordHistory(
                    RecordType.assetMetadata,
                    id,
                    parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000),
                );
            } else if (action === "update") {
                if (!args.options.has("filename") && !args.options.has("description"))
                    throw new CliError(
                        "Provide --filename or --description to update material details.",
                    );
                changed = editMaterialMetadata(
                    current,
                    args.options.get("filename") ?? field(current, "filename"),
                    args.options.get("description") ?? field(current, "description"),
                );
            } else {
                restoredIndex = parseBoundedOption(
                    args.options.get("revision"),
                    "revision",
                    0,
                    0,
                    10_000,
                );
                const revision = (
                    await snapshot.getRecordHistory(RecordType.assetMetadata, id, restoredIndex + 1)
                )[restoredIndex];
                if (!revision || field(revision, "_deleted") === "true")
                    throw new CliError("That material revision is unavailable or deleted.");
                changed = editMaterialMetadata(
                    current,
                    field(revision, "filename"),
                    field(revision, "description"),
                );
            }
        } finally {
            await closeSnapshot(snapshot);
        }
        if (action === "history") {
            const rows = historyRows.map((record, index) => ({
                history_index: index,
                ...toPlainRecord(record),
            }));
            emit(
                output,
                rows,
                historyRows
                    .map(
                        (record, index) =>
                            `${index}  revision ${record.revision}  ${field(record, "filename")}`,
                    )
                    .join("\n") || "No material history.",
                json,
            );
            return 0;
        }
        const saved = (await mutateArchive(path, [changed!], generation))[0] ?? changed!;
        emit(
            output,
            toPlainRecord(saved),
            restoredIndex === undefined
                ? "Material details updated."
                : `Material details restored from history index ${restoredIndex}.`,
            json,
        );
        return 0;
    }

    if (action === "remove") {
        const id = requiredPosition(args, 0, "material ID");
        const current = await getLiveRecordAtPath(path, RecordType.assetMetadata, id);
        const fields = new Map(current.fields);
        fields.set("_deleted", "true");
        const [saved] = await mutateArchive(path, [
            { ...current, revision: 0n, previousOffset: 0n, fields },
        ]);
        emit(
            output,
            toPlainRecord(saved ?? { ...current, fields }),
            "Material reference removed; immutable blob remains until archive compaction.",
            json,
        );
        return 0;
    }

    if (action === "restore") {
        const id = requiredPosition(args, 0, "material ID");
        const current = await getRecordAtPath(path, RecordType.assetMetadata, id);
        if (field(current, "_deleted") !== "true") {
            throw new CliError("Material is not in Trash.");
        }
        const fields = new Map(current.fields);
        fields.delete("_deleted");
        fields.set("restored_at_us", timestampNow());
        const [saved] = await mutateArchive(path, [
            { ...current, revision: 0n, previousOffset: 0n, fields },
        ]);
        emit(
            output,
            toPlainRecord(saved ?? { ...current, fields }),
            "Material restored from Trash.",
            json,
        );
        return 0;
    }

    if (action === "verify") {
        const id = requiredPosition(args, 0, "material ID");
        const snapshot = await openForCommand(path);
        try {
            const asset = await snapshot.getRecord(RecordType.assetMetadata, id);
            if (!asset || field(asset, "_deleted") === "true") {
                throw new CliError(`Material ${id} was not found in this archive.`);
            }
            let valid = true;
            try {
                const chunks = iterateVerifiedAssetChunks(snapshot, asset);
                while (!(await chunks.next()).done) {
                    // Consume every verified chunk so the final digest check runs.
                }
            } catch (error) {
                if (
                    !(error instanceof ArchiveFormatError) ||
                    error.code !== "asset_content_integrity_failed"
                ) {
                    throw error;
                }
                valid = false;
            }
            emit(
                output,
                { asset_id: asset.id, valid, sha256: field(asset, "content_hash") },
                valid ? "Asset content hash is valid." : "Asset content hash mismatch.",
                json,
            );
            return valid ? 0 : 2;
        } finally {
            await closeSnapshot(snapshot);
        }
    }

    if (action === "export" || action === "extract") {
        const id = requiredPosition(args, 0, "material ID");
        const outputPath = args.options.get("output");
        if (!outputPath) throw new CliError("--output is required.");
        const archivePath = resolve(path);
        const destination = resolve(outputPath);
        if (await sameFileIdentity(destination, archivePath))
            throw new CliError("Material output cannot replace its source archive.");
        const snapshot = await openForCommand(path);
        try {
            const record = await snapshot.getRecord(RecordType.assetMetadata, id);
            if (!record || record.fields.get("_deleted") === "true") {
                throw new CliError(`Material ${id} was not found in this archive.`);
            }
            const byteCount = await exportCliAssetAtomically(snapshot, record, destination);
            emit(
                output,
                { id: record.id, output: destination, bytes: byteCount },
                `Exported ${field(record, "filename") || id} to ${destination}.`,
                json,
            );
            return 0;
        } finally {
            await closeSnapshot(snapshot);
        }
    }
    if (action === "link" || action === "unlink") {
        const assetId = requiredPosition(args, 0, "material ID");
        const targetName = requiredOption(args, "to").toLowerCase();
        const targetId = requiredOption(args, "target-id");
        const targetType =
            targetName === "annotation"
                ? RecordType.annotation
                : targetName === "transcript"
                  ? RecordType.transcriptSegment
                  : null;
        if (targetType === null) {
            throw new CliError("Assets can currently link to annotations or transcript segments.");
        }

        const asset = await getLiveRecordAtPath(path, RecordType.assetMetadata, assetId);
        const target = await getLiveRecordAtPath(path, targetType, targetId);
        const assetSession = field(asset, "session_id");
        const targetSession = field(target, "session_id");
        if (assetSession && assetSession !== targetSession) {
            throw new CliError("An asset cannot link to a record from a different session.");
        }

        const canonicalAssetId = asset.id.toLowerCase();
        const linkedAssetIds = field(target, "linked_asset_ids")
            .split(",")
            .filter((id) => id.length > 0);
        const existingIndex = linkedAssetIds.indexOf(canonicalAssetId);
        if (action === "link" && existingIndex === -1) linkedAssetIds.push(canonicalAssetId);
        if (action === "unlink" && existingIndex !== -1) linkedAssetIds.splice(existingIndex, 1);

        const fields = new Map(target.fields);
        fields.set("linked_asset_ids", linkedAssetIds.join(","));
        if (targetType === RecordType.transcriptSegment) {
            fields.set("human_edited_at_us", timestampNow());
        }
        const [saved] = await mutateArchive(path, [
            { ...target, revision: 0n, previousOffset: 0n, fields },
        ]);
        const result = saved ?? { ...target, fields };
        emit(
            output,
            toPlainRecord(result),
            action === "link" ? "Asset linked to target." : "Asset unlinked from target.",
            json,
        );
        return 0;
    }
    throw new CliError(`asset ${action} is not implemented in the TypeScript CLI yet.`);
}

export function editMaterialMetadata(
    record: ArchiveRecord,
    filename: string,
    description: string,
): ArchiveRecord {
    const name = filename.trim();
    const invalidControls = (value: string, multiline: boolean) =>
        [...value].some((character) => {
            const code = character.codePointAt(0)!;
            return code === 127 || (code < 32 && !(multiline && (code === 9 || code === 10)));
        });
    const encoder = new TextEncoder();
    if (!name || encoder.encode(name).length > 1024 || invalidControls(name, false))
        throw new CliError("Use a file name of up to 1024 bytes without control characters.");
    if (encoder.encode(description).length > 16_384 || invalidControls(description, true))
        throw new CliError("The description is too long or contains unsupported characters.");
    const fields = new Map(record.fields)
        .set("filename", name)
        .set("description", description)
        .set("updated_at_us", timestampNow());
    return { ...record, fields };
}
