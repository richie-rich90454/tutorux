import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ArchiveFormatError } from "../../frontend/archive/format";
import {
  backfillArchiveSecondaryIndexes,
  compactArchiveSnapshot,
  discardUncommittedTail,
  inspectArchiveRecovery,
  openArchiveSource,
  openArchiveSourceForRecovery,
  rebuildDamagedPrimaryIndex,
  recoverChecksumDamagedArchiveHeader,
  recoverMagicDamagedArchiveHeader,
  recoverUnpublishedCommit,
  repairArchiveSnapshot,
  type ArchiveRecoveryInspection,
  type ArchiveSnapshot,
} from "../../frontend/archive/archive";
import { NodeFileArchiveSource } from "../../frontend/archive/node-source";
import {
  unlockSnapshotForCli,
  writeSourceAtomically,
  writeSourceToNewFileAtomically,
} from "./archive-io";
import { CliError, archiveAccessContext, emit, isNotFound, requiredOption } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";
export async function runArchiveRecoverCommand(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const archivePath = resolve(path);
  const applyRequested = args.flags.has("apply");
  const recoverUnpublished =
    args.flags.has("recover-unpublished") ||
    (applyRequested && !args.flags.has("discard-tail") && !args.flags.has("inspect"));
  const discardTail = args.flags.has("discard-tail");
  const inspectOnly = args.flags.has("inspect") || (!recoverUnpublished && !discardTail);
  if (recoverUnpublished && discardTail) {
    throw new CliError("Choose either --recover-unpublished or --discard-tail, not both.");
  }
  if (args.flags.has("inspect") && (recoverUnpublished || discardTail)) {
    throw new CliError("Choose --inspect or a recovery action, not both.");
  }
  const openedInfo = await stat(archivePath);
  const source = await NodeFileArchiveSource.open(archivePath);
  let snapshot: ArchiveSnapshot | undefined;
  let recovered: ArchiveSnapshot | undefined;
  let truncated: ArchiveSnapshot | undefined;
  try {
    if (BigInt(openedInfo.size) !== source.size) {
      throw new CliError("The archive changed while recovery was starting. Retry the command.");
    }
    const passphrase = archiveAccessContext.getStore()?.passphrase;
    const inspection = await inspectArchiveRecovery(source, passphrase);
    let changed = false;
    let resultingGeneration = inspection.committedGeneration;
    let remainingTrailingBytes = inspection.trailingBytes;
    let message = "";
    let operation = "inspect";
    if (!inspectOnly) {
      if (!inspection.archiveHeaderValid) {
        throw new CliError(
          inspection.headerRepairAvailable
            ? "The original header is damaged. Use 'archive repair FILE --output COPY.tux --confirm-sensitive' to create a fully verified copy first; no in-place recovery was performed."
            : "The archive header is damaged and no safe in-place recovery is available. Restore a known-good header before repair; no archive bytes were changed.",
        );
      }
      operation = recoverUnpublished ? "recover-unpublished" : "discard-tail";
      if (recoverUnpublished && !inspection.recoverable) {
        message = inspection.requiresPassphrase
          ? "A passphrase is required to verify the unpublished generation."
          : "No unpublished generation passed full integrity verification.";
      } else if (discardTail && inspection.trailingBytes === 0n) {
        message = "The archive has no uncommitted trailing bytes to discard.";
      } else if (applyRequested) {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError("The archive changed during recovery review. Retry the command.");
        }
        if (recoverUnpublished) {
          snapshot = await unlockSnapshotForCli(await openArchiveSourceForRecovery(source), true);
          const recovery = await recoverUnpublishedCommit(snapshot);
          recovered = recovery.snapshot;
          await writeSourceAtomically(archivePath, recovered);
        } else {
          snapshot = await unlockSnapshotForCli(await openArchiveSourceForRecovery(source), false);
          const result = await discardUncommittedTail(snapshot);
          truncated = result.snapshot;
          await writeSourceAtomically(archivePath, truncated);
        }
        changed = true;
        resultingGeneration = (recovered ?? truncated ?? snapshot)!.commit.generation;
        remainingTrailingBytes = 0n;
      }
    }
    const inspectJson = recoveryInspectionJson(inspection);
    const result = {
      path: archivePath,
      archive: archivePath,
      action: operation,
      passphrase_supplied: passphrase !== undefined,
      previousGeneration: inspection.committedGeneration.toString(),
      recoveredGeneration: inspection.recoverableGeneration.toString(),
      recoveredGenerations: inspection.recoveredGenerations,
      discardedTrailingBytes: inspection.discardedTrailingBytes.toString(),
      recoverable: inspection.recoverable,
      applied: changed,
      changed,
      inspection: inspectJson,
      resulting_committed_generation: resultingGeneration.toString(),
      remaining_trailing_bytes: remainingTrailingBytes.toString(),
      ...(message ? { message } : {}),
    };
    emit(
      output,
      result,
      recoveryText(operation, inspection, changed, message),
      args.flags.has("json"),
    );
    if (!inspectOnly && (recoverUnpublished ? !inspection.recoverable : false)) return 2;
    return 0;
  } finally {
    truncated?.lock();
    recovered?.lock();
    snapshot?.lock();
    await source.close();
  }
}
function recoveryInspectionJson(inspection: ArchiveRecoveryInspection): Record<string, unknown> {
  return {
    archive_header_valid: inspection.archiveHeaderValid,
    recovery_assessment_complete: inspection.recoveryAssessmentComplete,
    header_repair_candidate: inspection.headerRepairCandidate,
    header_repair_available: inspection.headerRepairAvailable,
    header_repair_generation: inspection.headerRepairGeneration.toString(),
    committed_generation: inspection.committedGeneration.toString(),
    candidate_generation: inspection.candidateGeneration.toString(),
    recoverable_generation: inspection.recoverableGeneration.toString(),
    trailing_bytes: inspection.trailingBytes.toString(),
    has_unpublished_commit: inspection.hasUnpublishedCommit,
    encrypted: inspection.encrypted,
    requires_passphrase: inspection.requiresPassphrase,
    recoverable: inspection.recoverable,
    recovered_generations: inspection.recoveredGenerations,
    discarded_trailing_bytes: inspection.discardedTrailingBytes.toString(),
    issues: inspection.issues,
  };
}

function recoveryText(
  operation: string,
  inspection: ArchiveRecoveryInspection,
  changed: boolean,
  message: string,
): string {
  const lines = [
    `Archive recovery inspection: ${operation}`,
    `Archive header: ${inspection.archiveHeaderValid ? "valid" : "invalid or unreadable"}`,
    `Committed generation: ${inspection.committedGeneration}`,
    `Unpublished candidate generation: ${inspection.hasUnpublishedCommit ? inspection.candidateGeneration : "none"}`,
    `Recoverable generation: ${inspection.recoverable ? inspection.recoverableGeneration : "none"}`,
    `Encrypted: ${inspection.encrypted ? "yes" : "no"}`,
    `Passphrase: ${inspection.requiresPassphrase ? "required" : "not required"}`,
    `Trailing bytes: ${inspection.trailingBytes}`,
    ...inspection.issues.map((issue) => `Issue: ${issue}`),
    operation === "inspect"
      ? "Action: inspection only; archive bytes were not changed."
      : `Action: ${changed ? `${operation} completed.` : `${operation} made no changes.`}`,
  ];
  if (message) lines.push(message);
  return lines.join("\n");
}

export async function runArchiveBackfillIndexesCommand(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const archivePath = resolve(path);
  const openedInfo = await stat(archivePath);
  const source = await NodeFileArchiveSource.open(archivePath);
  let snapshot: ArchiveSnapshot | undefined;
  let migrated: ArchiveSnapshot | undefined;
  try {
    if (BigInt(openedInfo.size) !== source.size) {
      throw new CliError(
        "The archive changed while index migration was starting. Retry the command.",
      );
    }
    snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
    const migration = await backfillArchiveSecondaryIndexes(snapshot);
    migrated = migration.snapshot;
    const applied = args.flags.has("apply");
    if (applied && (migration.addedEntries > 0 || migration.schemaVersionsUpdated)) {
      const currentInfo = await stat(archivePath);
      if (
        currentInfo.size !== openedInfo.size ||
        currentInfo.mtimeMs !== openedInfo.mtimeMs ||
        currentInfo.dev !== openedInfo.dev ||
        currentInfo.ino !== openedInfo.ino
      ) {
        throw new CliError("The archive changed during index migration review. Retry the command.");
      }
      await writeSourceAtomically(archivePath, migrated);
    }
    const result = {
      path: archivePath,
      previousGeneration: snapshot.commit.generation.toString(),
      resultingGeneration: migrated.commit.generation.toString(),
      addedEntries: migration.addedEntries,
      conflictingEntries: migration.conflictingEntries,
      schemaVersionsUpdated: migration.schemaVersionsUpdated,
      applied,
    };
    const summary = `${migration.addedEntries} missing secondary index entries; ${migration.conflictingEntries} existing conflicting aliases preserved; ${migration.schemaVersionsUpdated ? "schema versions updated" : "schema versions unchanged"}.`;
    emit(
      output,
      result,
      applied
        ? `Index migration complete: ${summary}`
        : `Index migration preview: ${summary} Add --apply to publish changes.`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    if (migrated && migrated !== snapshot) migrated.lock();
    snapshot?.lock();
    await source.close();
  }
}

export async function runArchiveCompactCommand(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const archivePath = resolve(path);
  const openedInfo = await stat(archivePath);
  const source = await NodeFileArchiveSource.open(archivePath);
  let snapshot: ArchiveSnapshot | undefined;
  let compacted: ArchiveSnapshot | undefined;
  try {
    if (BigInt(openedInfo.size) !== source.size) {
      throw new CliError("The archive changed while compaction was starting. Retry the command.");
    }
    snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
    const compaction = await compactArchiveSnapshot(snapshot, {
      pruneUnreferencedAssets: args.flags.has("prune-unreferenced-assets"),
    });
    compacted = compaction.snapshot;
    const applied = !args.flags.has("preview");
    if (applied) {
      const currentInfo = await stat(archivePath);
      if (
        currentInfo.size !== openedInfo.size ||
        currentInfo.mtimeMs !== openedInfo.mtimeMs ||
        currentInfo.dev !== openedInfo.dev ||
        currentInfo.ino !== openedInfo.ino
      ) {
        throw new CliError("The archive changed during compaction review. Retry the command.");
      }
      await writeSourceAtomically(archivePath, compaction.snapshot);
    }
    const result = {
      path: archivePath,
      generation: snapshot.commit.generation.toString(),
      compactedGeneration: compaction.snapshot.commit.generation.toString(),
      originalBytes: compaction.originalBytes.toString(),
      compactedBytes: compaction.compactedBytes.toString(),
      bytesSaved: (compaction.originalBytes - compaction.compactedBytes).toString(),
      recordsPreserved: compaction.preservedRecords,
      prunedAssetRecords: compaction.prunedAssetRecords,
      applied,
    };
    emit(
      output,
      result,
      applied
        ? `Compacted ${basename(path)} from ${result.originalBytes} to ${result.compactedBytes} bytes; pruned ${result.prunedAssetRecords} unreferenced asset records.`
        : `Compaction preview: ${basename(path)} would shrink from ${result.originalBytes} to ${result.compactedBytes} bytes and prune ${result.prunedAssetRecords} unreferenced asset records.`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    compacted?.lock();
    snapshot?.lock();
    await source.close();
  }
}

export async function runArchiveRebuildIndexCommand(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (!args.flags.has("confirm-sensitive")) {
    throw new CliError(
      "An index-rebuilt copy contains private archive records. Review the destination and retry with --confirm-sensitive.",
    );
  }
  const archivePath = resolve(path);
  const requestedDestination = resolve(requiredOption(args, "output"));
  if (!requestedDestination.toLowerCase().endsWith(".tux")) {
    throw new CliError("Index-rebuilt archive copies must use the .tux extension.");
  }
  const [sourceCanonicalPath, destinationParentPath] = await Promise.all([
    realpath(archivePath),
    realpath(dirname(requestedDestination)),
  ]);
  const destinationPath = resolve(destinationParentPath, basename(requestedDestination));
  const samePath =
    process.platform === "win32"
      ? sourceCanonicalPath.toLowerCase() === destinationPath.toLowerCase()
      : sourceCanonicalPath === destinationPath;
  if (samePath) throw new CliError("Index rebuild output must be a separate archive copy.");
  if (!(await stat(destinationParentPath)).isDirectory()) {
    throw new CliError("The index rebuild destination directory is unavailable.");
  }
  try {
    await lstat(destinationPath);
    throw new CliError(`Index rebuild output already exists: ${destinationPath}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }
  const openedInfo = await stat(sourceCanonicalPath);
  const source = await NodeFileArchiveSource.open(sourceCanonicalPath);
  let rebuilt: ArchiveSnapshot | undefined;
  try {
    if (BigInt(openedInfo.size) !== source.size) {
      throw new CliError(
        "The archive changed while index rebuild was starting. Retry the command.",
      );
    }
    const result = await rebuildDamagedPrimaryIndex(source);
    rebuilt = result.snapshot;
    const validateBeforePublish = async (): Promise<void> => {
      const currentInfo = await stat(sourceCanonicalPath);
      if (
        currentInfo.size !== openedInfo.size ||
        currentInfo.mtimeMs !== openedInfo.mtimeMs ||
        currentInfo.dev !== openedInfo.dev ||
        currentInfo.ino !== openedInfo.ino
      ) {
        throw new CliError("The archive changed during index rebuild. Retry the command.");
      }
    };
    await writeSourceToNewFileAtomically(
      destinationPath,
      rebuilt,
      validateBeforePublish,
      "Index rebuild",
    );
    emit(
      output,
      {
        path: sourceCanonicalPath,
        output: destinationPath,
        status: "rebuilt-index-copy",
        original_preserved: true,
        source_generation: result.sourceGeneration.toString(),
        recovered_records: result.recoveredRecords,
        recovered_revisions: result.recoveredRevisions,
        limitations:
          "Only complete published unencrypted v1 logs with known record types and intact record headers are supported; secondary aliases are reconstructed from understood schemas.",
      },
      `Index-rebuilt copy created at ${destinationPath}; the original was preserved. Recovered ${result.recoveredRecords} records and ${result.recoveredRevisions} revisions through generation ${result.sourceGeneration}. Recovery requires a complete published unencrypted v1 log with known record types and intact record headers; secondary indexes are rebuilt from understood schemas.`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    rebuilt?.lock();
    await source.close();
  }
}

export async function runArchiveRepairCommand(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (!args.flags.has("confirm-sensitive")) {
    throw new CliError(
      "A repaired copy contains student records, recordings, annotations, and credentials. Review the destination and retry with --confirm-sensitive.",
    );
  }
  const archivePath = resolve(path);
  const destinationPath = resolve(requiredOption(args, "output"));
  if (!destinationPath.toLowerCase().endsWith(".tux")) {
    throw new CliError("Repaired archive copies must use the .tux extension.");
  }
  const [sourceCanonicalPath, destinationParentPath] = await Promise.all([
    realpath(archivePath),
    realpath(dirname(destinationPath)),
  ]);
  const canonicalDestinationPath = resolve(destinationParentPath, basename(destinationPath));
  const samePath =
    process.platform === "win32"
      ? sourceCanonicalPath.toLowerCase() === canonicalDestinationPath.toLowerCase()
      : sourceCanonicalPath === canonicalDestinationPath;
  if (samePath) throw new CliError("Repair output must be a separate archive copy.");
  const destinationDirectory = await stat(destinationParentPath);
  if (!destinationDirectory.isDirectory()) {
    throw new CliError("The repair destination directory is unavailable.");
  }
  try {
    await stat(destinationPath);
    throw new CliError(`Repair output already exists: ${destinationPath}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }

  const openedInfo = await stat(archivePath);
  const source = await NodeFileArchiveSource.open(archivePath);
  let snapshot: ArchiveSnapshot | undefined;
  let recoveredForRepair: ArchiveSnapshot | undefined;
  let repaired: ArchiveSnapshot | undefined;
  let reconstructedHeader = false;
  let recoveredTailBytes = 0n;
  try {
    if (BigInt(openedInfo.size) !== source.size) {
      throw new CliError("The archive changed while repair was starting. Retry the command.");
    }
    try {
      snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
    } catch (error) {
      if (!(error instanceof ArchiveFormatError)) throw error;
      const passphrase = archiveAccessContext.getStore()?.passphrase;
      if (error.code === "archive_header_checksum") {
        snapshot = await recoverChecksumDamagedArchiveHeader(source, passphrase);
        reconstructedHeader = true;
      } else if (error.code === "archive_magic_invalid") {
        snapshot = await recoverMagicDamagedArchiveHeader(source, passphrase);
        reconstructedHeader = true;
      } else throw error;
    }
    if (!snapshot) throw new CliError("The archive could not be opened for repair.");
    let repairSource: ArchiveSnapshot = snapshot;
    if (reconstructedHeader && snapshot.source.size > snapshot.publishedEndOffset) {
      try {
        const recovery = await recoverUnpublishedCommit(snapshot);
        recoveredForRepair = recovery.snapshot;
        recoveredTailBytes = recovery.discardedTrailingBytes;
        repairSource = recoveredForRepair;
      } catch (error) {
        // The legacy repair path keeps the verified published generation when
        // trailing commit frames cannot be authenticated and linked safely.
        if (!(error instanceof ArchiveFormatError)) throw error;
      }
    }
    const repair = await repairArchiveSnapshot(repairSource);
    repaired = repair.snapshot;
    const validateBeforePublish = async (): Promise<void> => {
      const currentInfo = await stat(archivePath);
      if (
        currentInfo.size !== openedInfo.size ||
        currentInfo.mtimeMs !== openedInfo.mtimeMs ||
        currentInfo.dev !== openedInfo.dev ||
        currentInfo.ino !== openedInfo.ino
      ) {
        throw new CliError("The archive changed during repair. Retry the command.");
      }
    };
    await writeSourceToNewFileAtomically(destinationPath, repair.snapshot, validateBeforePublish);
    const result = {
      path: archivePath,
      output: destinationPath,
      status: "repaired-copy",
      original_preserved: true,
      selected_verified_generation: repair.selectedGeneration.toString(),
      discarded_bytes: (repair.discardedTrailingBytes + recoveredTailBytes).toString(),
      discarded_region_start: repair.discardedRegionStart.toString(),
      discarded_region_end: repair.discardedRegionEnd.toString(),
      discarded_record_frames: repair.discardedRecordFrames,
      discarded_record_frame_bytes: repair.discardedRecordFrameBytes.toString(),
      unattributed_bytes: repair.unattributedBytes.toString(),
      original_bytes: snapshot.source.size.toString(),
      compacted_bytes: repair.compactedBytes.toString(),
      records_preserved: repair.preservedRecords,
    };
    emit(
      output,
      result,
      `Validated repair copy created at ${destinationPath}; the original archive was preserved. Selected verified generation ${result.selected_verified_generation}; discarded ${result.discarded_bytes} source bytes.`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    repaired?.lock();
    recoveredForRepair?.lock();
    snapshot?.lock();
    await source.close();
  }
}
