import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  openArchiveSource,
  verifyArchiveFull,
  verifyArchiveHistory,
  verifyArchiveSnapshot,
  type ArchiveSnapshot,
} from "../../frontend/archive/archive";
import {
  ArchiveFormatError,
  RecordType,
  inspectArchiveVersion,
  uuidFromBytes,
} from "../../frontend/archive/format";
import { NodeFileArchiveSource } from "../../frontend/archive/node-source";
import { unlockSnapshotForCli } from "./archive-io";
import { emit } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";

export async function runArchiveInfoCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const archivePath = resolve(path);
  const source = await NodeFileArchiveSource.open(archivePath);
  let snapshot: ArchiveSnapshot | undefined;
  try {
    try {
      snapshot = await unlockSnapshotForCli(await openArchiveSource(source), action === "verify");
    } catch (error) {
      if (
        action !== "verify" &&
        error instanceof ArchiveFormatError &&
        (error.code === "archive_version_unsupported" ||
          error.code === "archive_capability_unsupported")
      ) {
        const metadata = await headerOnlyMetadata(source, archivePath, error.code);
        emit(output, metadata, metadataText(metadata), args.flags.has("json"));
        return 0;
      }
      if (action === "verify") {
        if (error instanceof ArchiveFormatError && error.code === "archive_passphrase_invalid") {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const result = {
          path: archivePath,
          name: basename(archivePath, extname(archivePath)),
          description: "",
          id: "",
          archiveId: "",
          archive_id: "",
          generation: "0",
          size: source.size.toString(),
          size_bytes: source.size.toString(),
          student_count: "0",
          session_count: "0",
          created_at_us: "0",
          format_major: "0",
          format_minor: "0",
          formatMajor: 0,
          formatMinor: 0,
          writable: await isWritable(archivePath),
          health: "invalid",
          recoveryNeeded: true,
          metadataOnly: false,
          metadata_only: false,
          encrypted: false,
          locked: false,
          verified: false,
          valid: false,
          records: 0,
          recordsVerified: 0,
          records_checked: 0,
          index_pages_checked: 0,
          deletedRecords: 0,
          issues: [message],
          historicalRevisionsVerified: null,
          commitsVerified: null,
          verificationScope: "failed",
        };
        if (args.flags.has("json")) {
          emit(output, result, "", true);
        } else {
          output.stderr(`Verification failed: ${message}`);
        }
        return 2;
      }
      throw error;
    }

    const fullRequested = action === "verify" && args.flags.has("full");
    let history: Awaited<ReturnType<typeof verifyArchiveHistory>> | null = null;
    let full: Awaited<ReturnType<typeof verifyArchiveFull>> | null = null;
    let verification: {
      currentRecords: number;
      liveRecords: number;
      deletedRecords: number;
    } | null = null;
    let verificationError: ArchiveFormatError | null = null;
    if (!snapshot.locked && (action === "info" || action === "open" || action === "verify")) {
      try {
        if (action === "verify" && args.flags.has("history")) {
          history = await verifyArchiveHistory(snapshot);
        } else if (action === "verify" && fullRequested) {
          full = await verifyArchiveFull(snapshot);
        } else {
          verification = await verifyArchiveSnapshot(snapshot);
        }
      } catch (error) {
        verificationError =
          error instanceof ArchiveFormatError
            ? error
            : new ArchiveFormatError(
                "archive_verification_failed",
                error instanceof Error ? error.message : String(error),
              );
      }
    }
    if (history) verification = history;
    if (full) verification = full;
    if (fullRequested && snapshot.locked) {
      verificationError = new ArchiveFormatError(
        "archive_locked",
        "Unlock this archive before running full verification.",
      );
    }
    const header = snapshot.header;
    const manifest = await snapshot.getManifest().catch(() => ({
      displayName: basename(archivePath, extname(archivePath)),
      description: "",
      createdAtUs: header.createdAtUs.toString(),
    }));
    const manifestRecord = await snapshot
      .getRecord(RecordType.settings, header.id)
      .catch(() => null);
    const studentCount = parseCounter(manifestRecord?.fields.get("student_count"));
    const sessionCount = parseCounter(manifestRecord?.fields.get("session_count"));
    const writable = await isWritable(archivePath);
    const recoveryNeeded = snapshot.source.size > snapshot.publishedEndOffset;
    const health = snapshot.locked
      ? "locked"
      : recoveryNeeded
        ? "recovery-required"
        : verificationError || (full && !full.valid)
          ? "invalid"
          : "healthy";
    const issues =
      full?.issues ?? (verificationError ? splitIssues(verificationError.message) : []);
    const valid =
      fullRequested || verificationError !== null
        ? verificationError === null && (full === null || full.valid)
        : verification !== null;
    const recordsChecked = full?.recordsChecked ?? verification?.currentRecords ?? 0;
    const indexPagesChecked = full?.indexPagesChecked ?? 0;
    const result = {
      path: archivePath,
      name: manifest.displayName,
      description: manifest.description,
      id: snapshot.header.id,
      archiveId: snapshot.header.id,
      archive_id: snapshot.header.id,
      generation: snapshot.commit.generation.toString(),
      size: snapshot.source.size.toString(),
      size_bytes: snapshot.source.size.toString(),
      student_count: studentCount,
      session_count: sessionCount,
      created_at_us: snapshot.header.createdAtUs.toString(),
      format_major: snapshot.header.majorVersion.toString(),
      format_minor: snapshot.header.minorVersion.toString(),
      formatMajor: snapshot.header.majorVersion,
      formatMinor: snapshot.header.minorVersion,
      writable,
      health,
      recoveryNeeded,
      metadataOnly: false,
      metadata_only: false,
      encrypted: snapshot.encrypted,
      locked: snapshot.locked,
      verified: valid,
      valid,
      records: verification?.liveRecords ?? 0,
      recordsVerified: verification?.currentRecords ?? 0,
      records_checked: recordsChecked,
      index_pages_checked: indexPagesChecked,
      deletedRecords: verification?.deletedRecords ?? 0,
      issues,
      historicalRevisionsVerified: history?.historicalRevisions ?? null,
      commitsVerified: history?.verifiedCommits ?? null,
      verificationScope: verificationError
        ? "failed"
        : fullRequested
          ? "full-semantic"
          : history
            ? "reachable-revisions-and-committed-generations"
            : verification
              ? "all-current-primary-records-and-index"
              : "header-and-index",
    };
    emit(
      output,
      result,
      snapshot.locked
        ? `${result.name}: generation ${result.generation}, encrypted records are locked.`
        : fullRequested || verificationError
          ? valid
            ? `${result.name}: full verification passed at generation ${result.generation} (${recordsChecked} record revisions, ${indexPagesChecked} index pages).`
            : `${result.name}: verification failed at generation ${result.generation}.\n${issues.join("\n")}`
          : `${result.name}: generation ${result.generation}, ${result.records} live records verified (${result.deletedRecords} in Trash).`,
      args.flags.has("json"),
    );
    return fullRequested && !valid ? 2 : verificationError ? 2 : 0;
  } finally {
    snapshot?.lock();
    await source.close();
  }
}

async function headerOnlyMetadata(
  source: NodeFileArchiveSource,
  archivePath: string,
  errorCode: string,
): Promise<Record<string, unknown>> {
  const bytes = await source.read(0n, 64);
  const version = inspectArchiveVersion(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    path: archivePath,
    name: basename(archivePath, extname(archivePath)),
    description: "",
    id: uuidFromBytes(bytes.subarray(16, 32)),
    archiveId: uuidFromBytes(bytes.subarray(16, 32)),
    archive_id: uuidFromBytes(bytes.subarray(16, 32)),
    generation: "0",
    size: source.size.toString(),
    size_bytes: source.size.toString(),
    student_count: "0",
    session_count: "0",
    created_at_us: view.getBigUint64(32, true).toString(),
    format_major: version.major.toString(),
    format_minor: version.minor.toString(),
    formatMajor: version.major,
    formatMinor: version.minor,
    writable: await isWritable(archivePath),
    health:
      errorCode === "archive_capability_unsupported"
        ? "unsupported-capability"
        : "unsupported-version",
    recoveryNeeded: false,
    metadataOnly: true,
    metadata_only: true,
    encrypted: false,
    locked: false,
    verified: false,
    valid: false,
    records: 0,
    recordsVerified: 0,
    records_checked: 0,
    index_pages_checked: 0,
    deletedRecords: 0,
    issues: [],
    historicalRevisionsVerified: null,
    commitsVerified: null,
    verificationScope: "header-metadata-only",
  };
}

function metadataText(metadata: Record<string, unknown>): string {
  return `${basename(String(metadata["path"]))}\n  Format: ${metadata["format_major"]}.${metadata["format_minor"]}\n  Size: ${metadata["size_bytes"]} bytes\n  Access: ${metadata["writable"] === true ? "Read/Write" : "Read-only"}\n  Health: ${metadata["health"]} (header metadata only)\n  This application cannot safely read records in this archive.`;
}

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function splitIssues(message: string): string[] {
  return message
    .split(";")
    .map((issue) => issue.trim())
    .filter(Boolean);
}

function parseCounter(value: string | undefined): string {
  if (!value || !/^\d+$/u.test(value)) return "0";
  return BigInt(value).toString();
}
