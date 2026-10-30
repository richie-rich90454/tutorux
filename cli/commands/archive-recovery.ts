import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ArchiveFormatError } from "../../frontend/archive/format";
import {
  backfillArchiveSecondaryIndexes,
  compactArchiveSnapshot,
  openArchiveSource,
  rebuildDamagedPrimaryIndex,
  recoverChecksumDamagedArchiveHeader,
  recoverMagicDamagedArchiveHeader,
  recoverUnpublishedCommit,
  repairArchiveSnapshot,
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
  const openedInfo = await stat(archivePath);
  const source = await NodeFileArchiveSource.open(archivePath);
  let snapshot: ArchiveSnapshot | undefined;
  let recovered: ArchiveSnapshot | undefined;
  try {
    if (BigInt(openedInfo.size) !== source.size) {
      throw new CliError("The archive changed while recovery was starting. Retry the command.");
    }
    snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
    const recovery = await recoverUnpublishedCommit(snapshot);
    recovered = recovery.snapshot;
    const applied = args.flags.has("apply");
    if (applied) {
      const currentInfo = await stat(archivePath);
      if (
        currentInfo.size !== openedInfo.size ||
        currentInfo.mtimeMs !== openedInfo.mtimeMs ||
        currentInfo.dev !== openedInfo.dev ||
        currentInfo.ino !== openedInfo.ino
      ) {
        throw new CliError("The archive changed during recovery review. Retry the command.");
      }
      await writeSourceAtomically(archivePath, recovery.snapshot);
    }
    const result = {
      path: archivePath,
      previousGeneration: snapshot.commit.generation.toString(),
      recoveredGeneration: recovery.recoveredGeneration.toString(),
      recoveredGenerations: recovery.recoveredGenerations,
      discardedTrailingBytes: recovery.discardedTrailingBytes.toString(),
      recoverable: true,
      applied,
    };
    emit(
      output,
      result,
      applied
        ? `Recovered ${result.recoveredGenerations} generation(s) in ${basename(path)} through generation ${result.recoveredGeneration}; discarded ${result.discardedTrailingBytes} trailing bytes.`
        : `${result.recoveredGenerations} generation(s) through ${result.recoveredGeneration} are recoverable. Add --apply to publish them.`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    recovered?.lock();
    snapshot?.lock();
    await source.close();
  }
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
    const applied = args.flags.has("apply");
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
        : `Compaction would reduce ${basename(path)} from ${result.originalBytes} to ${result.compactedBytes} bytes and prune ${result.prunedAssetRecords} unreferenced asset records. Add --apply to replace it.`,
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
